#!/usr/bin/env node
// Landing prediction for HAB-1, three ways:
//   hindcast   CUSF Tawhiri's flight model run on the GFS winds archived for 31 Oct 2026
//              (the public Tawhiri only holds the current forecast, so we run the same
//              physics locally: constant ascent, burst, drag descent v = c/sqrt(rho(h)),
//              RK4 with 60 s steps, NASA standard-atmosphere density)
//   inflight   re-predicted from every fix in flight, replacing GFS with the wind the
//              balloon itself measured in the layers it has flown through
//   forecast   the real CUSF Tawhiri API (SondeHub), "if we launched from the pad now"
//
//   node predict.mjs          writes data/predictions.json
import fs from "node:fs"
import path from "node:path"
import { haversine } from "./geo.mjs"

const here = path.dirname(new URL(import.meta.url).pathname)
const flight = JSON.parse(fs.readFileSync(path.join(here, "data", "flight-hab1.json"), "utf8"))
const OUT = path.join(here, "data", "predictions.json")
const DT = 60

// ---------------------------------------------------------------- Tawhiri physics
function density(alt) {                          // tawhiri/models.py _get_density
  let temp, pressure
  if (alt > 25000) { temp = -131.21 + 0.00299 * alt; pressure = 2.488 * ((temp + 273.1) / 216.6) ** -11.388 }
  else if (alt > 11000) { temp = -56.46; pressure = 22.65 * Math.exp(1.73 - 0.000157 * alt) }
  else { temp = 15.04 - 0.00649 * alt; pressure = 101.29 * ((temp + 273.1) / 288.08) ** 5.256 }
  return pressure / (0.2869 * (temp + 273.1))
}
const dragDescent = slRate => { const c = slRate * 1.1045; return alt => -c / Math.sqrt(density(alt)) }

// ---------------------------------------------------------------- GFS winds (archived)
const LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30]
const LATS = [17.25, 17.75, 18.25, 18.75], LONS = [75.25, 75.75, 76.25, 76.75]
async function fetchGfs() {
  const pts = LATS.flatMap(la => LONS.map(lo => [la, lo]))
  const vars = LEVELS.flatMap(l => [`wind_speed_${l}hPa`, `wind_direction_${l}hPa`, `geopotential_height_${l}hPa`])
  const url = "https://historical-forecast-api.open-meteo.com/v1/forecast?" + new URLSearchParams({
    latitude: pts.map(p => p[0]).join(","), longitude: pts.map(p => p[1]).join(","),
    start_date: "2026-10-31", end_date: "2026-10-31", hourly: vars.join(","), models: "gfs_seamless",
    wind_speed_unit: "ms", timezone: "GMT" })
  const r = await fetch(url); if (!r.ok) throw new Error(`open-meteo ${r.status}: ${await r.text()}`)
  const arr = await r.json()
  const times = arr[0].hourly.time.map(t => Date.parse(t + "Z"))
  // grid[i][j][hour] = sorted profile [{h, u, v}]
  const grid = LATS.map((_, i) => LONS.map((_, j) => {
    const H = arr[i * LONS.length + j].hourly
    return times.map((_, k) => LEVELS.map(l => {
      const s = H[`wind_speed_${l}hPa`][k], d = H[`wind_direction_${l}hPa`][k], h = H[`geopotential_height_${l}hPa`][k]
      if (s == null || d == null || h == null) return null
      return { h, u: -s * Math.sin(d * Math.PI / 180), v: -s * Math.cos(d * Math.PI / 180) }
    }).filter(Boolean).sort((a, b) => a.h - b.h))
  }))
  return { times, grid }
}
function profileAt(prof, alt) {
  if (alt <= prof[0].h) return prof[0]
  if (alt >= prof.at(-1).h) return prof.at(-1)
  let i = 1; while (prof[i].h < alt) i++
  const a = prof[i - 1], b = prof[i], f = (alt - a.h) / (b.h - a.h)
  return { u: a.u + f * (b.u - a.u), v: a.v + f * (b.v - a.v) }
}
function gfsWind(g, t, lat, lon, alt) {
  const fi = (lat - LATS[0]) / (LATS[1] - LATS[0]), fj = (lon - LONS[0]) / (LONS[1] - LONS[0])
  const i = Math.max(0, Math.min(LATS.length - 2, Math.floor(fi))), j = Math.max(0, Math.min(LONS.length - 2, Math.floor(fj)))
  const a = Math.max(0, Math.min(1, fi - i)), b = Math.max(0, Math.min(1, fj - j))
  const ft = (t - g.times[0]) / 3600e3, k = Math.max(0, Math.min(g.times.length - 2, Math.floor(ft))), c = Math.max(0, Math.min(1, ft - k))
  let u = 0, v = 0
  for (const [di, wi] of [[0, 1 - a], [1, a]]) for (const [dj, wj] of [[0, 1 - b], [1, b]]) for (const [dk, wk] of [[0, 1 - c], [1, c]]) {
    const w = profileAt(g.grid[i + di][j + dj][k + dk], alt); u += wi * wj * wk * w.u; v += wi * wj * wk * w.v
  }
  return { u, v }
}

// ---------------------------------------------------------------- measured winds
// From the fixes flown so far: one (alt, u, v) per segment, averaged into 500 m bands.
function measuredProfile(upToFlightS) {
  const bands = new Map()
  for (const s of flight.samples) {
    if (!s.wind || s.flightS + 60 > upToFlightS) continue
    const b = Math.floor(s.wind.atAltM / 500), r = s.wind.towardDeg * Math.PI / 180
    const e = bands.get(b) ?? { n: 0, u: 0, v: 0 }
    e.n++; e.u += s.wind.speedMs * Math.sin(r); e.v += s.wind.speedMs * Math.cos(r); bands.set(b, e)
  }
  return [...bands.entries()].map(([b, e]) => ({ h: b * 500 + 250, u: e.u / e.n, v: e.v / e.n })).sort((a, b) => a.h - b.h)
}
function windAt(g, measured, t, lat, lon, alt) {
  if (measured.length) {
    const lo = measured[0].h - 400, hi = measured.at(-1).h + 400
    if (alt >= lo && alt <= hi) return profileAt(measured, alt)
  }
  return gfsWind(g, t, lat, lon, alt)
}

// ---------------------------------------------------------------- integrator (RK4)
function simulate(g, start, prof, measured = []) {
  // start: {t, lat, lon, alt, ascending}; prof: {ascentMs, burstM, slDescentMs, groundM}
  const descend = dragDescent(prof.slDescentMs)
  let { t, lat, lon, alt, ascending } = start
  const track = [{ t, lat, lon, alt }]
  const deriv = (tt, la, lo, al, asc) => {
    const w = windAt(g, measured, tt, la, lo, al), R = 6371009 + al
    return [ (w.v / R) * 180 / Math.PI, (w.u / (R * Math.cos(la * Math.PI / 180))) * 180 / Math.PI, asc ? prof.ascentMs : descend(al) ]
  }
  for (let n = 0; n < 20000; n++) {
    if (ascending && alt >= prof.burstM) { ascending = false; track.push({ t, lat, lon, alt, burst: true }) }
    if (!ascending && alt <= prof.groundM) break
    const k1 = deriv(t, lat, lon, alt, ascending)
    const k2 = deriv(t + DT / 2, lat + k1[0] * DT / 2, lon + k1[1] * DT / 2, alt + k1[2] * DT / 2, ascending)
    const k3 = deriv(t + DT / 2, lat + k2[0] * DT / 2, lon + k2[1] * DT / 2, alt + k2[2] * DT / 2, ascending)
    const k4 = deriv(t + DT, lat + k3[0] * DT, lon + k3[1] * DT, alt + k3[2] * DT, ascending)
    lat += DT / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]); lon += DT / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])
    alt += DT / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]); t += DT * 1000
    track.push({ t, lat, lon, alt: Math.max(alt, prof.groundM) })
  }
  return track
}
const km = (a, b) => +(haversine(a, b) / 1000).toFixed(2)
const slim = tr => tr.filter((p, i) => i % 2 === 0 || p.burst || i === tr.length - 1)
  .map(p => ({ t: new Date(p.t).toISOString(), lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), alt: Math.round(p.alt), ...(p.burst ? { burst: true } : {}) }))

// ---------------------------------------------------------------- run
const g = await fetchGfs()
const desc = flight.samples.filter(s => s.phase === "descent" && s.altM < 15000)
const c = desc.reduce((sum, s) => sum + Math.abs(s.vzMs) * Math.sqrt(density(s.altM)), 0) / desc.length
const prof = { ascentMs: flight.meanAscentMs, burstM: flight.burst.altM, slDescentMs: +(c / 1.1045).toFixed(2), groundM: flight.landing.altM }
const actual = flight.landing, release = Date.parse(flight.release)

const hind = simulate(g, { t: release, lat: flight.pad.lat, lon: flight.pad.lon, alt: flight.pad.altM, ascending: true }, prof)
const hindLand = hind.at(-1)

const inflight = []
for (const s of flight.samples) {
  if (s.phase === "pad" || s.phase === "landed") continue
  const measured = measuredProfile(s.flightS)
  const tr = simulate(g, { t: release + s.flightS * 1000, lat: s.lat, lon: s.lon, alt: s.altM, ascending: s.phase === "ascent" }, prof, measured)
  const L = tr.at(-1)
  inflight.push({ fromFlightS: s.flightS, fromAltM: s.altM, phase: s.phase, measuredBands: measured.length,
    landing: { lat: +L.lat.toFixed(5), lon: +L.lon.toFixed(5) }, errorKm: km(L, actual), track: slim(tr).filter((_, i) => i % 3 === 0) })
}

// live CUSF Tawhiri forecast from the pad, next full hour, same balloon profile
const when = new Date(Math.ceil(Date.now() / 3600e3) * 3600e3).toISOString()
let forecast = null
try {
  const q = new URLSearchParams({ profile: "standard_profile", launch_latitude: flight.pad.lat, launch_longitude: flight.pad.lon,
    launch_altitude: flight.pad.altM, launch_datetime: when, ascent_rate: prof.ascentMs, burst_altitude: prof.burstM, descent_rate: prof.slDescentMs })
  const r = await (await fetch("https://api.v2.sondehub.org/tawhiri?" + q)).json()
  if (r.error) throw new Error(r.error.description)
  const pts = r.prediction.flatMap(st => st.trajectory)
  const L = pts.at(-1)
  forecast = { model: "CUSF Tawhiri (api.v2.sondehub.org)", launch: when, dataset: r.request?.dataset ?? null,
    landing: { lat: +L.latitude.toFixed(5), lon: +(((L.longitude + 540) % 360) - 180).toFixed(5) },
    track: pts.map(p => ({ t: p.datetime, lat: +p.latitude.toFixed(5), lon: +(((p.longitude + 540) % 360) - 180).toFixed(5), alt: Math.round(p.altitude) })) }
} catch (e) { forecast = { error: String(e.message ?? e) } }

const gfsAtPad = g.grid[1][1][7].map(p => ({ h: Math.round(p.h), speedMs: +Math.hypot(p.u, p.v).toFixed(2),
  towardDeg: +(((Math.atan2(p.u, p.v) * 180 / Math.PI) + 360) % 360).toFixed(1) }))
const out = {
  flight: flight.flight, generated: new Date().toISOString(),
  model: "CUSF Tawhiri flight model (RK4, 60 s, drag descent, NASA density), reimplemented; winds GFS archived via Open-Meteo",
  balloonProfile: prof, actualLanding: actual,
  hindcast: { landing: { lat: +hindLand.lat.toFixed(5), lon: +hindLand.lon.toFixed(5) }, errorKm: km(hindLand, actual), track: slim(hind) },
  inflight, forecast, gfsProfileAtPad0700Z: gfsAtPad,
}
fs.writeFileSync(OUT, JSON.stringify(out))
const best = inflight.reduce((a, b) => (b.errorKm < a.errorKm ? b : a))
const atBurst = inflight.find(x => x.phase === "descent")
console.log(`profile: ascent ${prof.ascentMs} m/s, burst ${prof.burstM} m, sea-level descent ${prof.slDescentMs} m/s`)
console.log(`hindcast (GFS only, from the pad): lands ${out.hindcast.errorKm} km from the real landing`)
console.log(`in-flight: at T+0 ${inflight[0].errorKm} km, at burst ${atBurst?.errorKm} km, at T+${Math.round(inflight.at(-1).fromFlightS / 60)} min ${inflight.at(-1).errorKm} km (${inflight.length} re-predictions)`)
console.log(`forecast (live CUSF Tawhiri, launch ${when}): ${forecast.error ? "ERROR " + forecast.error : `lands ${forecast.landing.lat},${forecast.landing.lon}, ${forecast.track.length} points`}`)
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`)
