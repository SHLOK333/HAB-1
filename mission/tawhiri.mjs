// CUSF Tawhiri flight model, reimplemented (tawhiri/models.py): constant ascent, burst,
// drag descent v = c/sqrt(rho(h)) with the NASA standard-atmosphere density, RK4 with
// 60 s steps. Winds: GFS archived for 31 Oct 2026 (Open-Meteo), cached on disk so the
// live ground station never needs the internet for them; measured winds override GFS
// in the layers the balloon has already flown through.
import fs from "node:fs"
import path from "node:path"
import { haversine } from "./geo.mjs"

const here = path.dirname(new URL(import.meta.url).pathname)
const CACHE = path.join(here, "data", "gfs-2026-10-31.json")
const DT = 60
export const LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30]
export const LATS = [17.25, 17.75, 18.25, 18.75], LONS = [75.25, 75.75, 76.25, 76.75]

export function density(alt) {
  let temp, pressure
  if (alt > 25000) { temp = -131.21 + 0.00299 * alt; pressure = 2.488 * ((temp + 273.1) / 216.6) ** -11.388 }
  else if (alt > 11000) { temp = -56.46; pressure = 22.65 * Math.exp(1.73 - 0.000157 * alt) }
  else { temp = 15.04 - 0.00649 * alt; pressure = 101.29 * ((temp + 273.1) / 288.08) ** 5.256 }
  return pressure / (0.2869 * (temp + 273.1))
}
const dragDescent = slRate => { const c = slRate * 1.1045; return alt => -c / Math.sqrt(density(alt)) }

export async function loadGfs() {
  let raw
  if (fs.existsSync(CACHE)) raw = JSON.parse(fs.readFileSync(CACHE, "utf8"))
  else {
    const pts = LATS.flatMap(la => LONS.map(lo => [la, lo]))
    const vars = LEVELS.flatMap(l => [`wind_speed_${l}hPa`, `wind_direction_${l}hPa`, `geopotential_height_${l}hPa`])
    const url = "https://historical-forecast-api.open-meteo.com/v1/forecast?" + new URLSearchParams({
      latitude: pts.map(p => p[0]).join(","), longitude: pts.map(p => p[1]).join(","), start_date: "2026-10-31", end_date: "2026-10-31",
      hourly: vars.join(","), models: "gfs_seamless", wind_speed_unit: "ms", timezone: "GMT" })
    const r = await fetch(url); if (!r.ok) throw new Error(`open-meteo ${r.status}`)
    raw = await r.json(); fs.writeFileSync(CACHE, JSON.stringify(raw))
  }
  const times = raw[0].hourly.time.map(t => Date.parse(t + "Z"))
  const grid = LATS.map((_, i) => LONS.map((_, j) => {
    const H = raw[i * LONS.length + j].hourly
    return times.map((_, k) => LEVELS.map(l => {
      const s = H[`wind_speed_${l}hPa`][k], d = H[`wind_direction_${l}hPa`][k], h = H[`geopotential_height_${l}hPa`][k]
      if (s == null || d == null || h == null) return null
      return { h, u: -s * Math.sin(d * Math.PI / 180), v: -s * Math.cos(d * Math.PI / 180) }
    }).filter(Boolean).sort((a, b) => a.h - b.h))
  }))
  return { times, grid }
}
export function profileAt(prof, alt) {
  if (alt <= prof[0].h) return prof[0]
  if (alt >= prof.at(-1).h) return prof.at(-1)
  let i = 1; while (prof[i].h < alt) i++
  const a = prof[i - 1], b = prof[i], f = (alt - a.h) / (b.h - a.h)
  return { u: a.u + f * (b.u - a.u), v: a.v + f * (b.v - a.v) }
}
export function gfsWind(g, t, lat, lon, alt) {
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
// fixes: [{flightS, lat, lon, altM}] in time order -> measured profile in 500 m bands
export function measuredFromFixes(fixes) {
  const bands = new Map(), R = 6371008.8
  for (let n = 1; n < fixes.length; n++) {
    const a = fixes[n - 1], b = fixes[n], dt = b.flightS - a.flightS
    if (dt <= 0 || dt > 900) continue
    const dn = (b.lat - a.lat) * Math.PI / 180 * R, de = (b.lon - a.lon) * Math.PI / 180 * R * Math.cos(a.lat * Math.PI / 180)
    const key = Math.floor((a.altM + b.altM) / 2 / 500), e = bands.get(key) ?? { n: 0, u: 0, v: 0 }
    e.n++; e.u += de / dt; e.v += dn / dt; bands.set(key, e)
  }
  return [...bands.entries()].map(([k, e]) => ({ h: k * 500 + 250, u: e.u / e.n, v: e.v / e.n })).sort((a, b) => a.h - b.h)
}
function windAt(g, measured, t, lat, lon, alt) {
  if (measured.length && alt >= measured[0].h - 400 && alt <= measured.at(-1).h + 400) return profileAt(measured, alt)
  return gfsWind(g, t, lat, lon, alt)
}
// start {t (ms), lat, lon, alt, ascending}; prof {ascentMs, burstM, slDescentMs, groundM}
export function simulate(g, start, prof, measured = []) {
  const descend = dragDescent(prof.slDescentMs)
  let { t, lat, lon, alt, ascending } = start
  const track = [{ t, lat, lon, alt }]
  const deriv = (tt, la, lo, al, asc) => {
    const w = windAt(g, measured, tt, la, lo, al), R = 6371009 + al
    return [(w.v / R) * 180 / Math.PI, (w.u / (R * Math.cos(la * Math.PI / 180))) * 180 / Math.PI, asc ? prof.ascentMs : descend(al)]
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
export const km = (a, b) => +(haversine(a, b) / 1000).toFixed(2)
