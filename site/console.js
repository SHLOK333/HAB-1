// HAB-1 ground station console.
// Live: served by station/server.mjs on the laptop with the ground board; streams the hardware.
// Archive: static anywhere; replays the 31 Oct flight log and any session recorded on Arkiv.
const $ = id => document.getElementById(id)
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches
const store = { get: k => { try { return localStorage.getItem(k) } catch { return null } }, set: (k, v) => { try { localStorage.setItem(k, v) } catch {} } }

const [F, P, X] = await Promise.all(["data/flight-hab1.json", "data/predictions.json", "data/facts.json"].map(u => fetch(u).then(r => r.json())))
const SAMPLES = F.samples, T0 = SAMPLES[0].flightS, T1 = SAMPLES.at(-1).flightS, BURST_T = F.burst.flightS, LAND_T = F.landing.flightS
const RELEASE = Date.parse(F.release), FLIGHT = "hab1-2026-10-31", DATASET = X.arkiv.dataset, OWNER = X.arkiv.owner   // only entities written by this deployment's ground-station wallet

// ---------------------------------------------------------------- format
const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
const tPlus = t => { const s = Math.abs(Math.round(t)), m = Math.floor(s / 60); return `T${t < 0 ? "−" : "+"}${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` }
const hms = ms => new Date(ms).toISOString().slice(11, 19)
const dm = (v, p, n, w) => { const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60; return `${String(d).padStart(w, "0")}°${m.toFixed(2).padStart(5, "0")}′${v >= 0 ? p : n}` }
const pos = (lat, lon) => `${dm(lat, "N", "S", 2)} ${dm(lon, "E", "W", 3)}`
const short = k => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : "—")
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
const hsTx = id => `https://hashscan.io/testnet/transaction/${id.replace("@", "-").replace(/\.(\d+)$/, "-$1")}`
const hsAcct = id => `https://hashscan.io/testnet/account/${id}`
const R = 6371008.8, rad = d => d * Math.PI / 180
const dist = (a, b) => { const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)) }
const bearing = (a, b) => { const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat)), x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon)); return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 }
const VERDICT_CLASS = v => (v === "VERIFIED" ? "ok" : /REJECTED/.test(v ?? "") ? "bad" : "warn")
const ARKIV_VERDICT = { unsigned: "UNSIGNED signature not heard", verified: "VERIFIED", fake: "FAKE REJECTED", bad_signature: "REJECTED bad signature", unverified: "ACCEPTED unverified", replay: "REPLAY REJECTED", conflict: "CONFLICT REJECTED" }

// ---------------------------------------------------------------- state
const S = {
  mode: "archive", session: "flight", frames: new Map(), sigs: [], predictions: [], arkivBatches: [], arkivRun: null, sales: [],
  pi: { status: null, checkpoints: [] }, health: null, t: T1, playing: false, follow: true, selected: null, busy: null, lastFrame: null,
  layers: { archive: true, received: true, prediction: true, hindcast: false, landings: false, wind: true, forecast: false }, forecast: null,
}
const flightState = t => {
  t = Math.max(T0, Math.min(T1, t)); let i = 0; while (i < SAMPLES.length - 2 && SAMPLES[i + 1].flightS <= t) i++
  const a = SAMPLES[i], b = SAMPLES[i + 1], f = (t - a.flightS) / (b.flightS - a.flightS || 1)
  return { t, lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), alt: a.altM + f * (b.altM - a.altM), vz: a.vzMs, wind: a.wind, phase: a.phase, press: a.pressHpa, temp: a.tempC }
}
const archivePred = t => { let p = null; for (const x of P.inflight) { if (x.fromFlightS <= t) p = x; else break } return p }
const verifiedFixes = () => [...S.frames.values()].filter(f => f.verdict === "VERIFIED").sort((a, b) => a.flightS - b.flightS)
function liveWinds() {
  const v = verifiedFixes(), out = []
  for (let i = 1; i < v.length; i++) { const a = v[i - 1], b = v[i], dt = b.flightS - a.flightS; if (dt > 0 && dt <= 900) out.push({ lat: a.lat, lon: a.lon, alt: (a.altM + b.altM) / 2, speed: dist(a, b) / dt, toward: bearing(a, b), seq: b.seq }) }
  return out
}

// ---------------------------------------------------------------- theme + colours
let C = {}
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
const rgb = h => { const x = h.replace("#", ""); return [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16)) }
function readColours() { for (const k of ["bg", "s1", "text", "text-2", "text-3", "accent", "nominal", "caution", "alarm", "predicted", "measured", "track"]) C[k] = rgb(css(`--${k}`)) }
const theme = store.get("hab1-theme") ?? "dark"
document.documentElement.dataset.theme = theme
readColours()

// ---------------------------------------------------------------- map
let positron = null
try { positron = await (await fetch("https://tiles.openfreemap.org/styles/positron")).json() } catch {}
function mapStyle(themeName) {
  if (!positron) return { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": css("--bg") } }] }
  const st = structuredClone(positron), dark = themeName === "dark"
  st.sources.dem = { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, maxzoom: 12, attribution: "AWS Terrain Tiles" }
  st.layers = st.layers.filter(l => l.source !== "ne2_shaded")
  const P_ = dark ? { bg: "#111418", water: "#0d1a26", waterLine: "#1b3346", urban: "#181c21", green: "#121814", road: "#2a3038", roadMajor: "#3a424b", rail: "#2d333b", bound: "#3a424c", text: "#8a939d", halo: "#0c0e11" }
    : { bg: "#eef0ec", water: "#c9dbe6", waterLine: "#9fbdd0", urban: "#e3e5e3", green: "#dfe7d9", road: "#ffffff", roadMajor: "#f6e7c8", rail: "#b9bec4", bound: "#9aa3ad", text: "#4f5862", halo: "#ffffff" }
  for (const l of st.layers) {
    const id = l.id, p = (l.paint ??= {}), lay = (l.layout ??= {})
    if (l.type === "background") p["background-color"] = P_.bg
    else if (id === "water") { p["fill-color"] = P_.water; delete p["fill-outline-color"] }
    else if (id === "waterway") p["line-color"] = P_.waterLine
    else if (id === "park" || id.startsWith("landcover_wood")) { p["fill-color"] = P_.green; p["fill-opacity"] = 0.8 }
    else if (id === "landuse_residential") { p["fill-color"] = P_.urban; p["fill-opacity"] = 0.9 }
    else if (id === "building") lay.visibility = "none"
    else if (/^(highway|tunnel|road|aeroway)/.test(id) && l.type === "line") p["line-color"] = id.includes("casing") ? "rgba(0,0,0,0)" : /motorway|major|runway/.test(id) ? P_.roadMajor : P_.road
    else if (id.startsWith("railway") && l.type === "line") p["line-color"] = P_.rail
    else if (id.startsWith("boundary")) p["line-color"] = P_.bound
    if (l.type === "symbol") { if (/shield/.test(id)) lay.visibility = "none"; p["text-color"] = P_.text; p["text-halo-color"] = P_.halo; p["text-halo-width"] = 1.2 }
  }
  st.layers.splice(st.layers.findIndex(l => l.id === "water"), 0, { id: "hillshade", type: "hillshade", source: "dem",
    paint: dark ? { "hillshade-shadow-color": "#000000", "hillshade-highlight-color": "#2b3138", "hillshade-accent-color": "#0b0d10", "hillshade-exaggeration": 0.4 }
      : { "hillshade-shadow-color": "#8a917f", "hillshade-highlight-color": "#ffffff", "hillshade-exaggeration": 0.35 } })
  return st
}
const lons = SAMPLES.map(s => s.lon), lats = SAMPLES.map(s => s.lat)
const BOUNDS = [[Math.min(...lons) - 0.08, Math.min(...lats) - 0.08], [Math.max(...lons) + 0.08, Math.max(...lats) + 0.08]]
const map = new maplibregl.Map({ container: "map", style: mapStyle(theme), center: [76.0, 17.95], zoom: 9, pitch: 55, bearing: -20, maxPitch: 80, attributionControl: { compact: true } })
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right")
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right")
await new Promise(r => (map.isStyleLoaded() ? r() : map.once("style.load", r)))
function fit(duration = 0) { const cam = map.cameraForBounds(BOUNDS, { padding: 40, bearing: -20 }); (duration ? map.easeTo : map.jumpTo).call(map, { ...cam, zoom: cam.zoom + 0.3, pitch: S.pitched ? 55 : 0, bearing: S.pitched ? -20 : 0, duration }) }
S.pitched = true; fit()

const DASH = deck.PathStyleExtension ? [new deck.PathStyleExtension({ dash: true })] : []
const ARROW = { url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M32 4 L46 26 H36 V60 H28 V26 H18 Z" fill="#000"/></svg>'), width: 64, height: 64, anchorY: 32, mask: true }
const TRIP = [{ path: SAMPLES.map(s => [s.lon, s.lat, s.altM]), ts: SAMPLES.map(s => s.flightS) }]
const LABEL = () => ({ fontFamily: "system-ui, -apple-system, sans-serif", fontWeight: 600, characterSet: "auto", getSize: 12, background: true, getBackgroundColor: [...C.s1, 235],
  backgroundPadding: [6, 3], getBorderColor: [...C["text-3"], 160], getBorderWidth: 1, getColor: C.text, getTextAnchor: "start", getAlignmentBaseline: "center", getPixelOffset: [12, 0] })
const overlay = new deck.MapboxOverlay({ interleaved: false, layers: [], getTooltip: ({ object, layer }) => {
  if (!object) return null
  if (layer.id === "rx-points") return `seq ${object.seq} · ${object.verdict ?? "pending"} · ${fmt(object.altM)} m · RSSI ${object.rssi} dBm`
  if (layer.id === "rx-bad") return `seq ${object.seq} · ${object.verdict} · claimed ${fmt(object.altM)} m`
  if (layer.id === "winds") return `${(object.speed ?? object.wind?.speedMs).toFixed(1)} m/s toward ${Math.round(object.toward ?? object.wind?.towardDeg)}°`
  return null } })
map.addControl(overlay)

function layers() {
  const L = [], live = S.mode === "live", t = S.t, lb = LABEL()
  const ghost = live || S.session !== "flight"
  const custom = S.flightNow && !S.flightNow.builtin
  if (custom && S.flightNow.track?.length) L.push(new deck.PathLayer({ id: "flight-plan", data: [S.flightNow.track], getPath: d => d.map(p => [p[0], p[1], 0]), getColor: [...C.track, 90], widthUnits: "pixels", getWidth: 1.5,
    getDashArray: [4, 4], dashJustified: true, extensions: [new deck.PathStyleExtension({ dash: true })] }))
  if (S.layers.archive && !custom) {
    L.push(new deck.TripsLayer({ id: "archive", data: TRIP, getPath: d => d.path, getTimestamps: d => d.ts, currentTime: ghost ? T1 : t, trailLength: 1e7, fadeTrail: false,
      getColor: ghost ? [...C["text-3"], 150] : C.track, widthUnits: "pixels", getWidth: ghost ? 1.5 : 2.6, capRounded: true, jointRounded: true }))
    if (!ghost) L.push(new deck.LineLayer({ id: "curtain", data: SAMPLES.filter((s, i) => s.flightS <= t && i % 4 === 0), getSourcePosition: d => [d.lon, d.lat, 0], getTargetPosition: d => [d.lon, d.lat, d.altM], getColor: [...C["text-3"], 70], getWidth: 1 }))
  }
  // received frames (live, or a recorded Arkiv session)
  const frames = [...S.frames.values()], ver = verifiedFixes(), bad = frames.filter(f => /REJECTED/.test(f.verdict ?? ""))
  if (S.layers.received && frames.length) {
    L.push(new deck.PathLayer({ id: "rx-path", data: [ver], getPath: d => d.map(f => [f.lon, f.lat, f.altM]), getColor: C.track, widthUnits: "pixels", getWidth: 2.6, jointRounded: true }))
    L.push(new deck.LineLayer({ id: "rx-curtain", data: ver, getSourcePosition: d => [d.lon, d.lat, 0], getTargetPosition: d => [d.lon, d.lat, d.altM], getColor: [...C.track, 55], getWidth: 1 }))
    L.push(new deck.ScatterplotLayer({ id: "rx-points", data: frames.filter(f => !/REJECTED/.test(f.verdict ?? "")), pickable: true, getPosition: d => [d.lon, d.lat, d.altM], radiusUnits: "pixels",
      getRadius: d => (d.seq === S.selected ? 6 : 3.5), filled: true, getFillColor: d => (d.verdict === "VERIFIED" ? C.track : [...C.s1, 255]), stroked: true, lineWidthUnits: "pixels", getLineWidth: 1.5,
      getLineColor: d => (d.verdict === "VERIFIED" ? (d.seq === S.selected ? C.accent : C.track) : C.caution), updateTriggers: { getRadius: [S.selected], getLineColor: [S.selected] } }))
    L.push(new deck.ScatterplotLayer({ id: "rx-bad", data: bad, pickable: true, getPosition: d => [d.lon, d.lat, d.altM ?? 0], radiusUnits: "pixels", getRadius: 6, getFillColor: [...C.alarm, 220], stroked: true, getLineColor: C.s1, lineWidthUnits: "pixels", getLineWidth: 1.5 }))
    L.push(new deck.TextLayer({ id: "rx-bad-label", data: bad, getPosition: d => [d.lon, d.lat, d.altM ?? 0], getText: d => `${d.verdict} · seq ${d.seq}`, ...lb, getColor: C.alarm, getBorderColor: C.alarm }))
  }
  // predicted course
  const pr = live ? S.predictions.at(-1) : archivePred(t)
  if (S.layers.prediction && pr && (live || t < LAND_T)) {
    const path = live ? pr.track : pr.track.map(q => [q.lon, q.lat, q.alt])
    L.push(new deck.PathLayer({ id: "pred", data: [path], getPath: d => d, getColor: C.predicted, widthUnits: "pixels", getWidth: 2.2, getDashArray: [5, 4], extensions: DASH }))
    const end = path.at(-1)
    L.push(new deck.ScatterplotLayer({ id: "pred-land", data: [end], getPosition: d => [d[0], d[1], 0], radiusUnits: "pixels", getRadius: 7, filled: false, stroked: true, lineWidthUnits: "pixels", getLineWidth: 2, getLineColor: C.predicted }))
    L.push(new deck.TextLayer({ id: "pred-label", data: [end], getPosition: d => [d[0], d[1], 0], getText: () => `Predicted landing · ${(live ? pr.missKm : pr.errorKm).toFixed(2)} km from actual`, ...lb, getColor: C.predicted, getBorderColor: [...C.predicted, 160], getPixelOffset: [12, 14] }))
  }
  if (S.layers.hindcast) L.push(new deck.PathLayer({ id: "hind", data: [P.hindcast.track], getPath: d => d.map(q => [q.lon, q.lat, q.alt]), getColor: [...C.predicted, 120], widthUnits: "pixels", getWidth: 1.6, getDashArray: [2, 4], extensions: DASH }))
  if (S.layers.landings) {
    const pts = live ? S.predictions.map(p => [p.landing.lon, p.landing.lat]) : P.inflight.filter(x => x.fromFlightS <= t).map(x => [x.landing.lon, x.landing.lat])
    L.push(new deck.ScatterplotLayer({ id: "landings", data: pts, getPosition: d => [d[0], d[1], 0], radiusUnits: "pixels", getRadius: 3, filled: false, stroked: true, lineWidthUnits: "pixels", getLineWidth: 1.2, getLineColor: [...C.predicted, 150] }))
  }
  if (S.layers.forecast && S.forecast) L.push(new deck.PathLayer({ id: "forecast", data: [S.forecast.track], getPath: d => d, getColor: [...C.measured, 200], widthUnits: "pixels", getWidth: 1.8, getDashArray: [6, 3], extensions: DASH }))
  if (S.layers.wind) {
    const w = frames.length ? liveWinds() : SAMPLES.filter((s, i) => s.wind && s.flightS <= t && i % 3 === 0).map(s => ({ lat: s.lat, lon: s.lon, alt: s.wind.atAltM, speed: s.wind.speedMs, toward: s.wind.towardDeg }))
    L.push(new deck.IconLayer({ id: "winds", data: w, pickable: true, billboard: false, getIcon: () => ARROW, getPosition: d => [d.lon, d.lat, d.alt], getAngle: d => -d.toward,
      sizeUnits: "pixels", getSize: d => 14 + Math.min(d.speed, 40) * 0.5, getColor: [...C.measured, 190] }))
  }
  // fixed marks
  const ft = custom ? S.flightNow.track : null
  const marks = ft?.length ? [{ p: [ft[0][0], ft[0][1], 0], text: `Launch · ${S.flightNow.name}`, c: C.text }, { p: [ft.at(-1)[0], ft.at(-1)[1], 0], text: "Lands", c: C.text }]
    : [{ p: [F.pad.lon, F.pad.lat, 0], text: `Pad · ${pos(F.pad.lat, F.pad.lon)}`, c: C.text }, { p: [F.landing.lon, F.landing.lat, 0], text: `Landed ${hms(RELEASE + LAND_T * 1000)} UTC`, c: C.text }]
  L.push(new deck.ScatterplotLayer({ id: "marks", data: marks, getPosition: d => d.p, radiusUnits: "pixels", getRadius: 5, getFillColor: C.s1, stroked: true, getLineColor: C.text, lineWidthUnits: "pixels", getLineWidth: 2 }))
  L.push(new deck.TextLayer({ id: "marks-label", data: marks, getPosition: d => d.p, getText: d => d.text, ...lb, getTextAnchor: "end", getPixelOffset: [-12, 0] }))
  // the balloon now
  const head = live || frames.length ? S.lastFrame : (t > T0 && t < T1 ? flightState(t) : null)
  if (head) {
    const p = [head.lon, head.lat, head.altM ?? head.alt]
    L.push(new deck.ScatterplotLayer({ id: "head", data: [p], getPosition: d => d, radiusUnits: "pixels", getRadius: 7, getFillColor: C.s1, stroked: true, getLineColor: C.accent, lineWidthUnits: "pixels", getLineWidth: 2.5 }))
    L.push(new deck.TextLayer({ id: "head-label", data: [p], getPosition: d => d, getText: d => `${fmt(d[2])} m`, ...lb, getColor: C.accent, getBorderColor: [...C.accent, 160] }))
  }
  return L.concat(fxLayers())
}
// ---------------------------------------------------------------- event effects (each one is a real event)
// A frame heard: a radio pulse from the balloon down to the ground station, and a ring on the balloon.
// A batch verified: a wave of green rings. A forged frame: a red shockwave. A new flight: the route draws in.
S.fx = []
let fxRaf = 0
function fxAdd(e, at) {
  if (reduceMotion || (at && Date.now() - at > 15000)) return          // not for the backlog replayed on connect
  S.fx.push({ ...e, t0: performance.now() + (e.delay ?? 0) }); if (S.fx.length > 80) S.fx.splice(0, S.fx.length - 80)
  if (!fxRaf) fxRaf = requestAnimationFrame(fxStep)
}
function fxStep() {
  const now = performance.now(); S.fx = S.fx.filter(e => now - e.t0 < e.dur)
  overlay.setProps({ layers: layers() }); fxRaf = S.fx.length ? requestAnimationFrame(fxStep) : 0
}
function groundPos() { const t = S.flightNow && !S.flightNow.builtin && S.flightNow.track; return t?.length ? [t[0][0], t[0][1], 0] : [F.pad.lon, F.pad.lat, 0] }
const ease = x => 1 - (1 - x) ** 3
function fxLayers() {
  if (!S.fx.length) return []
  const now = performance.now(), g = groundPos(), on = S.fx.filter(e => now >= e.t0), out = []
  const k = e => Math.min(1, (now - e.t0) / e.dur)
  const tx = on.filter(e => e.k === "tx")
  if (tx.length) out.push(new deck.TripsLayer({ id: "fx-beam", data: tx, currentTime: now, trailLength: 420, fadeTrail: true, capRounded: true, jointRounded: true,
    getPath: e => Array.from({ length: 24 }, (_, i) => { const f = i / 23; return [e.from[0] + (g[0] - e.from[0]) * f, e.from[1] + (g[1] - e.from[1]) * f, e.from[2] * (1 - f)] }),
    getTimestamps: e => Array.from({ length: 24 }, (_, i) => e.t0 + (i / 23) * e.dur * 0.7), getColor: C.measured, widthUnits: "pixels", getWidth: 4, updateTriggers: { getTimestamps: tx.map(e => e.t0).join() } }))
  const rings = []
  for (const e of on) {
    const x = ease(k(e)), a = Math.round(255 * (1 - k(e)))
    if (e.k === "tx") rings.push({ p: e.from, r: 6 + 54 * x, c: [...C.measured, a], w: 2 })
    if (e.k === "sig") rings.push({ p: e.at, r: 8 + 110 * x, c: [...C.accent, a], w: 3 }, { p: e.at, r: 4 + 60 * x, c: [...C.accent, a], w: 1.5 })
    if (e.k === "ok") rings.push({ p: e.at, r: 3 + 30 * x, c: [...C.nominal, a], w: 2.5 })
    if (e.k === "bad") for (const d of [0, 0.18, 0.36]) { const y = Math.max(0, Math.min(1, (k(e) - d) / (1 - d))); if (y > 0) rings.push({ p: e.at, r: 6 + 170 * ease(y), c: [...C.alarm, Math.round(255 * (1 - y))], w: 3.5 }) }
  }
  if (rings.length) out.push(new deck.ScatterplotLayer({ id: "fx-rings", data: rings, getPosition: d => d.p, getRadius: d => d.r, radiusUnits: "pixels", stroked: true, filled: false,
    getLineColor: d => d.c, getLineWidth: d => d.w, lineWidthUnits: "pixels", updateTriggers: { getRadius: now, getLineColor: now } }))
  const bad = on.filter(e => e.k === "bad" && k(e) < 0.5)
  if (bad.length) out.push(new deck.ScatterplotLayer({ id: "fx-flash", data: bad, getPosition: e => e.at, getRadius: e => 10 + 20 * k(e), radiusUnits: "pixels", getFillColor: e => [...C.alarm, Math.round(200 * (1 - 2 * k(e)))], updateTriggers: { getRadius: now, getFillColor: now } }))
  const route = on.find(e => e.k === "route" && S.flightNow?.track?.length)
  if (route) { const tr = S.flightNow.track; out.push(new deck.TripsLayer({ id: "fx-route", data: [tr], getPath: d => d.map(p => [p[0], p[1], 0]), getTimestamps: d => d.map((_, i) => route.t0 + (i / (d.length - 1)) * route.dur * 0.85), currentTime: now, trailLength: 1e9, fadeTrail: false, getColor: C.track, widthUnits: "pixels", getWidth: 4 })) }
  return out
}

let raf = 0
const draw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; overlay.setProps({ layers: layers() }); renderConductor() }) }

// ---------------------------------------------------------------- map tools
const tool = (id, on) => { $(id).classList.toggle("on", on); $(id).setAttribute("aria-pressed", on) }
$("t-3d").onclick = () => { S.pitched = !S.pitched; tool("t-3d", S.pitched); map.easeTo({ pitch: S.pitched ? 55 : 0, bearing: S.pitched ? -20 : 0, duration: reduceMotion ? 0 : 600 }) }
$("t-follow").onclick = () => { S.follow = !S.follow; tool("t-follow", S.follow) }
$("t-fit").onclick = () => fit(reduceMotion ? 0 : 700)
$("t-layers").onclick = () => { const p = $("layers"); p.hidden = !p.hidden; $("t-layers").setAttribute("aria-expanded", !p.hidden) }
for (const cb of $("layers").querySelectorAll("input")) {
  cb.checked = S.layers[cb.dataset.l]
  cb.onchange = async () => { S.layers[cb.dataset.l] = cb.checked; if (cb.dataset.l === "forecast" && cb.checked && !S.forecast) await loadForecast(); draw() }
}
document.addEventListener("click", e => { if (!e.target.closest(".maptools")) { $("layers").hidden = true; $("t-layers").setAttribute("aria-expanded", "false") } })
function followTo(lat, lon) { if (S.follow && !reduceMotion) map.easeTo({ center: [lon, lat], duration: S.mode === "live" ? 900 : 0 }) }

// ---------------------------------------------------------------- theme toggle
$("theme").onclick = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark"
  document.documentElement.dataset.theme = next; store.set("hab1-theme", next); readColours()
  $("theme").setAttribute("aria-label", `Switch to ${next === "dark" ? "light" : "dark"} theme`)
  map.setStyle(mapStyle(next)); draw(); renderPlots(); renderInspector()
}

// ---------------------------------------------------------------- clock
setInterval(() => { $("clock").textContent = `${hms(Date.now())} UTC` }, 1000)

// ---------------------------------------------------------------- conductor
function renderConductor() {
  const live = S.mode === "live", t = live ? (S.lastFrame?.flightS ?? 0) : S.t
  $("tpos").textContent = tPlus(t); $("livepill").hidden = !live
  $("play").disabled = live; $("speed").disabled = live
  $("head").style.left = `${((t - T0) / (T1 - T0)) * 100}%`
  $("scrub").setAttribute("aria-valuenow", Math.round(t))
}
function drawScrub() {
  const svg = $("scrub-svg"), w = svg.clientWidth || 600, h = svg.clientHeight || 22, x = t => ((t - T0) / (T1 - T0)) * w
  let g = `<rect x="${x(0)}" y="${h - 4}" width="${x(BURST_T) - x(0)}" height="2" fill="${css("--measured")}" opacity=".7"/><rect x="${x(BURST_T)}" y="${h - 4}" width="${x(LAND_T) - x(BURST_T)}" height="2" fill="${css("--predicted")}" opacity=".7"/>`
  for (let t = 0; t <= T1; t += 900) g += `<line x1="${x(t)}" x2="${x(t)}" y1="${h - 9}" y2="${h - 4}" stroke="${css("--text-3")}"/><text x="${x(t) + 3}" y="${h - 9}">${t / 60}</text>`
  g += `<text x="${x(BURST_T) + 3}" y="9" fill="${css("--predicted")}">burst</text>`
  for (const f of S.frames.values()) g += `<line x1="${x(f.flightS)}" x2="${x(f.flightS)}" y1="0" y2="5" stroke="${/REJECTED/.test(f.verdict ?? "") ? css("--alarm") : f.verdict === "VERIFIED" ? css("--nominal") : css("--caution")}"/>`
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`); svg.innerHTML = g
}
let last = 0
function tick(now) {
  if (!S.playing) return
  const dt = Math.min(0.1, (now - last) / 1000); last = now
  S.t = Math.min(T1, S.t + dt * Number($("speed").value))
  const st = flightState(S.t)
  if (S.follow && !reduceMotion) map.jumpTo({ center: [st.lon, st.lat] })
  draw(); renderInspector()
  if (S.t >= T1) setPlaying(false); else requestAnimationFrame(tick)
}
function setPlaying(on) { S.playing = on; last = performance.now(); $("play-ico").setAttribute("d", on ? "M5 4h4v12H5zM11 4h4v12h-4z" : "M6 4l10 6-10 6z"); $("play").setAttribute("aria-label", on ? "Pause" : "Play"); if (on) requestAnimationFrame(tick) }
$("play").onclick = () => { if (S.t >= T1) S.t = T0; setPlaying(!S.playing) }
const scrubTo = cx => { const r = $("scrub").getBoundingClientRect(); S.t = T0 + Math.max(0, Math.min(1, (cx - r.left) / r.width)) * (T1 - T0); draw(); renderInspector() }
$("scrub").addEventListener("pointerdown", e => { if (S.mode === "live") return; setPlaying(false); $("scrub").setPointerCapture(e.pointerId); scrubTo(e.clientX) })
$("scrub").addEventListener("pointermove", e => { if (e.buttons && S.mode !== "live") scrubTo(e.clientX) })
$("scrub").addEventListener("keydown", e => { if (S.mode === "live") return; const d = e.shiftKey ? 600 : 60
  if (e.key === "ArrowRight") S.t = Math.min(T1, S.t + d); else if (e.key === "ArrowLeft") S.t = Math.max(T0, S.t - d); else return; e.preventDefault(); draw(); renderInspector() })

// ---------------------------------------------------------------- event log
const LOG = [], LOG_MAX = 600, filters = new Set(["radio", "payload", "arkiv", "hedera", "model", "ops"])
function log(src, html, o = {}) {
  LOG.unshift({ src, html, at: o.at ?? Date.now(), tlabel: o.tlabel, link: o.link, seq: o.seq })
  if (LOG.length > LOG_MAX) LOG.pop()
  scheduleLog()
}
let logPending = false
function scheduleLog() { if (!logPending) { logPending = true; requestAnimationFrame(() => { logPending = false; renderLog() }) } }
function renderLog() {
  const rows = LOG.filter(e => filters.has(e.src))
  $("log-count").textContent = LOG.length
  $("log").innerHTML = rows.length ? rows.slice(0, 300).map(e => `<li data-seq="${e.seq ?? ""}" class="${e.seq != null && e.seq === S.selected ? "sel" : ""}"><time>${e.tlabel ?? hms(e.at)}</time><span class="tag ${e.src}">${{ radio: "Radio", payload: "Payload", arkiv: "Arkiv", hedera: "Hedera", model: "Model", ops: "Ops" }[e.src]}</span><span class="msg">${e.html}</span>${e.link ? `<a href="${e.link.href}" target="_blank" rel="noopener">${esc(e.link.text)}</a>` : "<span></span>"}</li>`).join("")
    : `<li class="empty">${S.mode === "live" ? "Waiting for the ground station…" : "No events in this view."}</li>`
}
$("log").addEventListener("click", e => { const li = e.target.closest("li[data-seq]"); if (li && li.dataset.seq !== "") select(+li.dataset.seq) })
for (const c of $("log-filters")?.querySelectorAll(".chip") ?? []) c.onclick = () => { c.classList.toggle("on"); c.classList.contains("on") ? filters.add(c.dataset.src) : filters.delete(c.dataset.src); renderLog() }

// ---------------------------------------------------------------- tabs
function tabs(listSel, onShow) {
  const list = document.querySelector(listSel)
  for (const b of list.querySelectorAll('[role="tab"]')) b.onclick = () => {
    for (const o of list.querySelectorAll('[role="tab"]')) { const on = o === b; o.setAttribute("aria-selected", on); $(o.getAttribute("aria-controls")).hidden = !on }
    onShow?.(b.getAttribute("aria-controls"))
  }
}
tabs(".dock .tabs", id => { if (id === "d-plots") renderPlots(); if (id === "d-frames") renderFrames(); if (id === "d-tx") renderTx() })
tabs(".inspector .tabs", () => renderInspector())
const showInspector = id => document.querySelector(`.inspector [aria-controls="${id}"]`).click()

// ---------------------------------------------------------------- selection
function select(seq) { S.selected = seq; const f = S.frames.get(seq); if (f) followTo(f.lat, f.lon); renderLog(); draw(); showInspector("i-fix"); renderInspector() }

// ---------------------------------------------------------------- systems rail
const kvs = rows => `<dl class="kv">${rows.filter(Boolean).map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls ?? ""}">${v}</dd>`).join("")}</dl>`
const node = (name, st, note, rows) => `<div class="node"><div class="node-h"><span class="dot" data-st="${st}"></span><b>${name}</b><small>${note}</small></div>${kvs(rows)}</div>`
function linkStates() {
  const h = S.health, live = S.mode === "live"
  const radio = !live ? "off" : h?.ground.usb && h.ground.verifier && h.beacon.lastFrameAgeS != null && h.beacon.lastFrameAgeS < 45 ? "ok" : h?.ground.usb ? "warn" : "bad"
  const piRadio = S.lastFrame?.liveSrc === "pi" && Date.now() - S.lastFrame.heardAt < 90000
  const payload = !live ? "off" : h?.pi.lastAgeS != null && h.pi.lastAgeS < 60 ? "ok" : piRadio ? "warn" : "bad"
  const arkiv = live ? (h?.arkiv.publisher ? "ok" : "warn") : S.arkivOk ? "ok" : "off"
  const hedera = live ? (h?.hedera.endpoint ? "ok" : "warn") : "off"
  return { radio, payload, arkiv, hedera, zerog: X.zeroG.teeAttestedModelsListed > 0 && X.zeroG.callsWorking ? "ok" : "warn", piRadio }
}
function renderSystems() {
  const st = linkStates(), h = S.health, live = S.mode === "live", lf = S.lastFrame, counts = h?.counts ?? countVerdicts()
  for (const li of $("links").children) li.dataset.st = st[li.dataset.k]
  $("sys-note").textContent = live ? `session ${h?.session ?? "—"}` : "archive"
  const rej = Object.entries(counts).filter(([k]) => /REJECTED/.test(k)).reduce((s, [, n]) => s + n, 0)
  const age = s => (s == null ? "—" : `${s} s ago`)
  $("systems").innerHTML = [
    node("Beacon", st.radio === "off" ? "off" : st.radio, "LoRa 866.1 MHz SF9", [
      ["Key", short(X.keys.beacon)], ["Last frame", live ? age(h?.beacon.lastFrameAgeS) : "—", h?.beacon.lastFrameAgeS < 45 ? "ok" : ""],
      ["RSSI · SNR", lf ? `${lf.rssi} dBm · ${lf.snr} dB` : "—"], ["Flight replay", lf ? `${tPlus(lf.flightS)}` : "—"]]),
    node("Ground receiver", st.radio === "off" ? "off" : h?.ground.usb ? "ok" : "bad", "Heltec V3 · USB", [
      ["USB modem", live ? (h?.ground.usb ? "connected" : "not found") : "—", h?.ground.usb ? "ok" : live ? "bad" : ""],
      ["Verifier", live ? (h?.ground.verifier ? "running" : "stopped") : "—", h?.ground.verifier ? "ok" : live ? "warn" : ""],
      ["Verified", fmt(counts.VERIFIED ?? 0), "ok"], ["Rejected", fmt(rej), rej ? "bad" : ""], ["Buyer key", short(X.keys.ground)]]),
    node("Payload computer", st.payload, "Raspberry Pi 5", [
      ["Outside baro", lf?.livePa ? `${lf.livePa.toFixed(1)} hPa · ${lf.liveC?.toFixed(1)} °C` : "—", lf?.liveSrc === "pi" ? "meas" : ""],
      ["Barometer via", lf?.liveSrc ? `radio frame (${lf.liveSrc})` : "—"],
      ["Agent link", live ? (h?.pi.lastAgeS != null ? `SSH · ${age(h.pi.lastAgeS)}` : "SSH unreachable") : "—", h?.pi.lastAgeS < 60 ? "ok" : live ? "warn" : ""],
      ["Mode", S.pi.status?.mode ?? "—", S.pi.status?.mode === "SAFE" ? "warn" : ""], ["SoC", S.pi.status?.socC ? `${S.pi.status.socC} °C` : "—"], ["Key", short(X.keys.pi)]]),
    node("Arkiv", st.arkiv, `Rabdi · ${X.arkiv.chainId}`, [
      ["Publisher", live ? (h?.arkiv.publisher ? "running" : "stopped") : "—", h?.arkiv.publisher ? "ok" : ""],
      ["Entities this session", fmt(h?.arkiv.entities ?? 0)], ["Last tx", short(S.arkivBatches.at(-1)?.tx)], ["Owner", short(X.arkiv.owner)]]),
    node("Hedera", st.hedera, "testnet · x402", [
      ["x402 endpoint", live ? (h?.hedera.endpoint ? "serving :4402" : "stopped") : "—", h?.hedera.endpoint ? "ok" : ""],
      ["Sales this session", fmt(S.sales.length)], ["Seller", X.hedera.merchant], ["Buyer board", X.hedera.buyerBoard]]),
    node("0G", st.zerog, "Private Computer", [["TEE-attested models", `${X.zeroG.teeAttestedModelsListed} listed`, st.zerog === "ok" ? "ok" : "warn"], ["Checkpoints seen", fmt(S.pi.checkpoints.length)],
      ["Safe stops", fmt(S.pi.checkpoints.filter(c => c.safeStop).length), "warn"]]),
  ].join("")
}
function countVerdicts() { const c = {}; for (const f of S.frames.values()) if (f.verdict) c[f.verdict] = (c[f.verdict] ?? 0) + 1; return c }

// ---------------------------------------------------------------- inspector
function renderInspector() {
  const vis = id => !$(id).hidden
  if (vis("i-fix")) renderFix(); if (vis("i-pred")) renderPred()
}
function renderFix() {
  const f = S.selected != null ? S.frames.get(S.selected) : S.lastFrame
  if (f) {
    const prev = verifiedFixes().filter(x => x.flightS < f.flightS).at(-1), vz = prev ? (f.altM - prev.altM) / (f.flightS - prev.flightS) : null
    const sig = S.sigs.find(s => f.seq >= s.first && f.seq < s.first + s.count), batch = S.arkivBatches.find(b => b.seqs.includes(String(f.seq)))
    $("i-fix").innerHTML = `<div class="verdict"><span class="dot" data-st="${VERDICT_CLASS(f.verdict) === "ok" ? "ok" : VERDICT_CLASS(f.verdict) === "bad" ? "bad" : "warn"}"></span>${esc(f.verdict ?? "PENDING signature")} · seq ${f.seq}${S.selected != null ? ' · <a href="#" id="unsel">follow latest</a>' : ""}</div>
      <div class="readouts"><div class="ro"><span>Altitude</span><b>${fmt(f.altM)}<small>m</small></b></div><div class="ro"><span>Vertical</span><b>${vz == null ? "—" : `${vz >= 0 ? "+" : "−"}${Math.abs(vz).toFixed(1)}`}<small>m/s</small></b></div>
      <div class="ro"><span>Flight time</span><b>${tPlus(f.flightS).slice(1)}</b></div><div class="ro"><span>Link</span><b>${f.rssi}<small>dBm · ${f.snr} dB</small></b></div></div>
      ${kvs([["Position", pos(f.lat, f.lon)], f.press != null && ["Replayed pressure", `${f.press} hPa · ${f.temp} °C`], f.livePa && ["Payload Pi barometer", `${f.livePa.toFixed(1)} hPa · ${f.liveC?.toFixed(2)} °C`, "meas"],
sig && ["Batch signature", `${sig.valid ? "valid" : "INVALID"} · boot ${sig.boot} · seq ${sig.first}–${sig.first + sig.count - 1}`, sig.valid ? "ok" : "bad"],
        sig?.replay && ["Replay check", "older than accepted batch", "bad"], batch && ["On Arkiv", `tx ${short(batch.tx)}`, "ok"], f.heardAt && ["Heard", `${hms(f.heardAt)} UTC`], f.run && ["Arkiv run", esc(f.run)]])}`
    $("unsel")?.addEventListener("click", e => { e.preventDefault(); S.selected = null; renderLog(); draw(); renderFix() })
  } else {
    const s = flightState(S.t)
    $("i-fix").innerHTML = `<div class="verdict"><span class="dot"></span>31 Oct 2026 flight log · ${S.t >= LAND_T ? "landed" : s.phase}</div>
      <div class="readouts"><div class="ro"><span>Altitude</span><b>${fmt(s.alt)}<small>m</small></b></div><div class="ro"><span>Vertical</span><b>${s.phase === "pad" || s.phase === "landed" ? "—" : `${s.vz >= 0 ? "+" : "−"}${Math.abs(s.vz).toFixed(1)}`}<small>m/s</small></b></div>
      <div class="ro"><span>Flight time</span><b>${tPlus(S.t).slice(1)}</b></div><div class="ro"><span>Wind</span><b>${s.wind ? s.wind.speedMs.toFixed(1) : "—"}<small>m/s ${s.wind ? `→ ${Math.round(s.wind.towardDeg)}°` : ""}</small></b></div></div>
      ${kvs([["Position", pos(s.lat, s.lon)], ["Outside pressure", `${s.press} hPa`], ["Outside temp", `${s.temp} °C`], ["UTC", hms(RELEASE + S.t * 1000)], ["Released", `${hms(RELEASE)} UTC`], ["Burst", `${fmt(F.burst.altM)} m · ${tPlus(BURST_T)}`], ["Landed", `${tPlus(LAND_T)} · ${fmt(F.padToLandingKm, 1)} km from pad`]])}
      <p class="caveat">Archive view: the payload's own flight log at 60 s. Run the console on the ground station laptop to see frames arrive over LoRa and be verified live.</p>`
  }
}
function missSvg(series, cur) {
  const W = 330, H = 150, l = 30, r = 6, t = 8, b = 18, maxE = Math.max(4, ...series.map(p => p.e)), xs = x => l + (x / LAND_T) * (W - l - r), ys = e => H - b - (e / maxE) * (H - t - b)
  let g = ""
  for (let e = 0; e <= maxE; e += 1) g += `<line x1="${l}" x2="${W - r}" y1="${ys(e)}" y2="${ys(e)}" stroke="${css("--line")}"/><text x="2" y="${ys(e) + 3}">${e}km</text>`
  for (let m = 0; m <= 120; m += 30) g += `<text x="${xs(m * 60) - 8}" y="${H - 4}">T+${m}</text>`
  g += `<line x1="${xs(BURST_T)}" x2="${xs(BURST_T)}" y1="${t}" y2="${H - b}" stroke="${css("--predicted")}" stroke-dasharray="2 3" opacity=".6"/>`
  if (series.length) g += `<polyline fill="none" stroke="${css("--predicted")}" stroke-width="1.6" points="${series.map(p => `${xs(p.x)},${ys(p.e)}`).join(" ")}"/>`
  if (cur) g += `<circle cx="${xs(cur.x)}" cy="${ys(cur.e)}" r="3.5" fill="${css("--predicted")}"/>`
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${g}</svg>`
}
function renderPred() {
  const live = S.mode === "live", pr = live ? S.predictions.at(-1) : archivePred(S.t)
  const miss = pr ? (live ? pr.missKm : pr.errorKm) : P.hindcast.errorKm
  const series = live ? S.predictions.map(p => ({ x: p.fromFlightS, e: p.missKm })) : P.inflight.filter(x => x.fromFlightS < LAND_T).map(x => ({ x: x.fromFlightS, e: x.errorKm }))
  const land = pr ? (live ? pr.landing : pr.landing) : P.hindcast.landing
  $("i-pred").innerHTML = `<div class="readouts"><div class="ro pred"><span>Predicted miss</span><b>${miss.toFixed(2)}<small>km</small></b></div><div class="ro"><span>Measured wind layers</span><b>${pr ? (live ? pr.measuredBands : pr.measuredBands) : 0}<small>× 500 m</small></b></div></div>
    ${kvs([["Model", "CUSF Tawhiri flight model"], ["Winds", "GFS 31 Oct 2026 + measured in flight"], pr && ["Predicted from", `${live ? `seq ${pr.fromSeq} · ` : ""}${tPlus(pr.fromFlightS)} · ${fmt(pr.fromAltM)} m`], ["Predicted landing", pos(land.lat, land.lon), "pred"], ["Actual landing", pos(F.landing.lat, F.landing.lon)],
      ["Pre-flight forecast miss", `${P.hindcast.errorKm.toFixed(2)} km`, "pred"], live && pr && ["Compute time", `${pr.ms} ms on this laptop`]])}
    <h3 class="sub">Miss distance as the flight progresses</h3><div class="plotbox">${missSvg(series, pr ? { x: pr.fromFlightS, e: miss } : null)}</div>
    <div class="toggles"><label><input type="checkbox" data-l="hindcast" ${S.layers.hindcast ? "checked" : ""}> Show pre-flight forecast course</label><label><input type="checkbox" data-l="landings" ${S.layers.landings ? "checked" : ""}> Show every predicted landing</label><label><input type="checkbox" data-l="forecast" ${S.layers.forecast ? "checked" : ""}> Tonight's live CUSF Tawhiri forecast from the pad</label></div>
    <p class="status" id="fc-status">${S.forecast ? esc(S.forecast.note) : ""}</p>
    <p class="caveat">Both use the ascent rate (${P.balloonProfile.ascentMs} m/s) and burst height (${fmt(P.balloonProfile.burstM)} m) HAB-1 actually flew, so the miss is the wind forecast's error alone. Each new fix replaces forecast wind with wind the balloon measured.</p>`
  for (const cb of $("i-pred").querySelectorAll("input[data-l]")) cb.onchange = async () => {
    S.layers[cb.dataset.l] = cb.checked; const m = $("layers").querySelector(`[data-l="${cb.dataset.l}"]`); if (m) m.checked = cb.checked
    if (cb.dataset.l === "forecast" && cb.checked && !S.forecast) await loadForecast(); draw(); renderPred() }
}
async function loadForecast() {
  const when = new Date(Math.ceil(Date.now() / 3600e3) * 3600e3).toISOString()
  const q = new URLSearchParams({ profile: "standard_profile", launch_latitude: F.pad.lat, launch_longitude: F.pad.lon, launch_altitude: F.pad.altM, launch_datetime: when, ascent_rate: P.balloonProfile.ascentMs, burst_altitude: P.balloonProfile.burstM, descent_rate: P.balloonProfile.slDescentMs })
  try {
    const r = await (await fetch("https://api.v2.sondehub.org/tawhiri?" + q)).json(); if (r.error) throw new Error(r.error.description)
    const pts = r.prediction.flatMap(x => x.trajectory).map(p => [((p.longitude + 540) % 360) - 180, p.latitude, p.altitude]), e = pts.at(-1)
    S.forecast = { track: pts, note: `CUSF Tawhiri (SondeHub), launch ${when.slice(11, 16)} UTC tonight: lands ${pos(e[1], e[0])}.` }
  } catch (err) { S.forecast = P.forecast?.track ? { track: P.forecast.track.map(p => [p.lon, p.lat, p.alt]), note: `SondeHub did not answer (${err.message}); showing the forecast saved ${P.forecast.launch.slice(0, 16)}.` } : null }
  log("model", `Tawhiri forecast for a launch from the pad tonight <span class="mono">${esc(S.forecast?.note ?? "unavailable")}</span>`)
}
async function loadInsights() {
  try {
    const a = await timeout(arkiv(), 15000), { and, eq, desc } = a.q
    const res = await timeout(a.client.select({ topic: true, model: true, teeAttested: true, requestId: true, headline: true, createdAt: true, guardModel: true, guardVerdict: true, guardRequestId: true, $key: true })
      .from(a.Insight).where(and(eq("flight", FLIGHT), eq("dataset", DATASET))).ownedBy(OWNER).orderBy(desc("createdAt")).limit(12).fetch(), 20000)
    const rows = res.entities.map(val)
    S.insightsHtml = rows.length ? `<ul class="list">${rows.map(r => `<li><span><span class="dot" data-st="${r.teeAttested === "true" ? "ok" : "warn"}"></span> <b>${esc(r.headline)}</b></span><span class="mono">${esc(r.topic)} · ${esc(r.model)} · ${r.teeAttested === "true" ? "TEE-attested" : "not attested"}</span><span class="mono">0G ${esc(r.requestId)}</span>${r.guardVerdict ? `<span class="mono ${r.guardVerdict === "supported" ? "ok" : "warn"}">claims checked by ${esc(r.guardModel)}: ${r.guardVerdict === "supported" ? "all supported by the Arkiv data" : "some claims NOT supported"} · 0G ${esc(r.guardRequestId)}</span>` : ""}<span class="mono">Arkiv ${short(r.$key)} · ${new Date(Number(r.createdAt) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC</span></li>`).join("")}</ul>`
      : `<p class="empty">No analysis stored yet. Run 0G analysis in Operations.</p>`
  } catch (e) { S.insightsHtml = `<p class="empty">Arkiv did not answer (${esc(e.message)}).</p>` }
  if ($("zg-ins")) $("zg-ins").innerHTML = S.insightsHtml
}

// ---------------------------------------------------------------- plots + frames
function renderPlots() {
  if ($("d-plots").hidden) return
  const frames = [...S.frames.values()].sort((a, b) => a.flightS - b.flightS)
  const plot = (id, draw_) => { const el = $(id), w = el.clientWidth || 300, h = el.clientHeight || 140; el.setAttribute("viewBox", `0 0 ${w} ${h}`); el.innerHTML = draw_(w, h) }
  plot("pl-alt", (w, h) => {
    const xs = t => 28 + ((t - T0) / (T1 - T0)) * (w - 34), ys = a => h - 14 - (a / 20000) * (h - 22)
    let g = [0, 10000, 20000].map(a => `<line x1="28" x2="${w}" y1="${ys(a)}" y2="${ys(a)}" stroke="${css("--line")}"/><text x="0" y="${ys(a) + 3}">${a / 1000}k</text>`).join("")
    g += `<polyline fill="none" stroke="${css("--text-3")}" stroke-width="1.2" points="${SAMPLES.map(s => `${xs(s.flightS)},${ys(s.altM)}`).join(" ")}"/>`
    g += frames.map(f => `<circle cx="${xs(f.flightS)}" cy="${ys(f.altM)}" r="2.6" fill="${/REJECTED/.test(f.verdict ?? "") ? css("--alarm") : f.verdict === "VERIFIED" ? css("--track") : css("--caution")}"/>`).join("")
    if (!frames.length) g += `<line x1="${xs(S.t)}" x2="${xs(S.t)}" y1="0" y2="${h - 14}" stroke="${css("--accent")}"/>`
    return g + `<text x="28" y="${h - 2}">flight time · grey = 31 Oct log${frames.length ? " · dots = frames received" : ""}</text>`
  })
  plot("pl-link", (w, h) => {
    const arr = [...S.frames.values()].sort((a, b) => (a.heardAt ?? a.seq) - (b.heardAt ?? b.seq)).slice(-80), xs = i => 28 + (i / Math.max(1, arr.length - 1)) * (w - 34)
    const yr = v => 6 + ((-20 - v) / 110) * (h - 22), ysn = v => 6 + ((15 - v) / 30) * (h - 22)
    let g = [-20, -75, -130].map(v => `<line x1="28" x2="${w}" y1="${yr(v)}" y2="${yr(v)}" stroke="${css("--line")}"/><text x="0" y="${yr(v) + 3}">${v}</text>`).join("")
    if (arr.length) { g += `<polyline fill="none" stroke="${css("--measured")}" stroke-width="1.4" points="${arr.map((f, i) => `${xs(i)},${yr(f.rssi)}`).join(" ")}"/>`; g += `<polyline fill="none" stroke="${css("--text-2")}" stroke-width="1" stroke-dasharray="3 2" points="${arr.map((f, i) => `${xs(i)},${ysn(f.snr)}`).join(" ")}"/>` }
    return g + `<text x="28" y="${h - 2}">${arr.length ? `last ${arr.length} frames · solid RSSI · dashed SNR` : "no radio frames in this view"}</text>`
  })
  plot("pl-miss", (w, h) => {
    const series = S.mode === "live" ? S.predictions.map(p => ({ x: p.fromFlightS, e: p.missKm })) : P.inflight.filter(x => x.fromFlightS < LAND_T).map(x => ({ x: x.fromFlightS, e: x.errorKm }))
    const maxE = Math.max(4, ...series.map(s => s.e)), xs = t => 28 + (t / LAND_T) * (w - 34), ys = e => h - 14 - (e / maxE) * (h - 22)
    let g = [0, 2, 4].map(e => `<line x1="28" x2="${w}" y1="${ys(e)}" y2="${ys(e)}" stroke="${css("--line")}"/><text x="0" y="${ys(e) + 3}">${e}</text>`).join("")
    if (series.length) g += `<polyline fill="none" stroke="${css("--predicted")}" stroke-width="1.5" points="${series.map(s => `${xs(s.x)},${ys(s.e)}`).join(" ")}"/>`
    return g + `<text x="28" y="${h - 2}">Tawhiri re-prediction vs actual landing</text>`
  })
}
function renderFrames() {
  if ($("d-frames").hidden) return
  const rows = [...S.frames.values()].sort((a, b) => b.seq - a.seq).slice(0, 120)
  $("frames").innerHTML = rows.length ? rows.map(f => `<tr data-seq="${f.seq}"><td>${f.seq}</td><td>${tPlus(f.flightS)}</td><td>${fmt(f.altM)}</td><td>${f.lat.toFixed(5)}</td><td>${f.lon.toFixed(5)}</td><td>${f.rssi ?? "—"}</td><td>${f.snr ?? "—"}</td><td>${f.livePa ? `${f.livePa.toFixed(1)} / ${f.liveC?.toFixed(1)}` : "—"}</td><td class="${{ ok: "v-ok", bad: "v-bad", warn: "v-warn" }[VERDICT_CLASS(f.verdict)]}">${esc(f.verdict ?? "pending")}</td><td class="hex">${f.hex ?? "—"}</td></tr>`).join("")
    : `<tr><td colspan="10" class="empty">No radio frames in this view. Choose a recorded session from Arkiv in the top bar, or run the console on the ground station.</td></tr>`
}
$("frames").addEventListener("click", e => { const tr = e.target.closest("tr[data-seq]"); if (tr) select(+tr.dataset.seq) })

// ---------------------------------------------------------------- live: ground station stream
function frameFrom(e) { return { seq: e.seq, flightS: e.flight_s, lat: e.lat, lon: e.lon, altM: e.alt_m, rssi: e.rssi, snr: e.snr, press: e.press_hpa, temp: e.temp_c, livePa: e.live_hpa, liveC: e.live_c, liveSrc: e.live_src, hex: e.hex, beaconKey: e.beacon_key } }
let renderQueued = false
function refresh() { if (!renderQueued) { renderQueued = true; setTimeout(() => { renderQueued = false; draw(); drawScrub(); renderSystems(); renderInspector(); renderPlots(); renderFrames(); renderFlow(); renderMetrics(); renderRunbook(); PAGES?.refresh() }, 120) } }
function onRadio(e, at) {
  if (e.ev === "data") {
    const f = { ...(S.frames.get(e.seq) ?? {}), ...frameFrom(e), heardAt: at }
    S.frames.set(e.seq, f); S.lastFrame = f; followTo(f.lat, f.lon); prData(e, at)
    fxAdd({ k: "tx", from: [e.lon, e.lat, e.alt_m], dur: 1500 }, at)
    flowPacket("beacon-ground", "measured", () => flowPacket("ground-station", "measured", () => flash("station", "info"), 700))
    log("radio", `seq ${e.seq} heard · ${tPlus(e.flight_s)} · ${fmt(e.alt_m)} m · <span class="mono">RSSI ${e.rssi} SNR ${e.snr}${e.live_src === "pi" ? ` · Pi baro ${e.live_hpa} hPa` : ""}</span> · <span class="warn">awaiting signature</span>`, { at, seq: e.seq })
  } else if (e.ev === "sig") {
    S.sigs.push(e); if (S.sigs.length > 200) S.sigs.shift(); prSig(e, at)
    if (S.lastFrame) fxAdd({ k: "sig", at: [S.lastFrame.lon, S.lastFrame.lat, S.lastFrame.altM], dur: 1700 }, at)
    log("radio", `batch signature seq ${e.first}–${e.first + e.count - 1} · boot ${e.boot} · ${e.valid ? (e.replay ? '<span class="bad">REPLAY of an older batch</span>' : '<span class="ok">Ed25519 valid</span>') : '<span class="bad">INVALID</span>'}`, { at })
  } else if (e.ev === "verdict") {
    const f = { ...(S.frames.get(e.seq) ?? {}), ...frameFrom(e), verdict: e.verdict, heardAt: S.frames.get(e.seq)?.heardAt ?? at }
    S.frames.set(e.seq, f)
    const bad = /REJECTED/.test(e.verdict)
    flash("station", bad ? "bad" : "ok")
    const now = Date.now(); if (now - (S.okAt ?? 0) > 1500) S.okN = 0; S.okAt = now
    if (bad) fxAdd({ k: "bad", at: [e.lon, e.lat, e.alt_m], dur: 2600 }, at)
    else if (e.verdict === "VERIFIED") fxAdd({ k: "ok", at: [e.lon, e.lat, e.alt_m], dur: 1200, delay: (S.okN++) * 140 }, at)
    if (bad) toast("bad", "Forged frame rejected", `seq ${e.seq} claimed ${fmt(e.alt_m)} m · ${e.verdict} · never published`)
    log("radio", `seq ${e.seq} <span class="${VERDICT_CLASS(e.verdict)}">${esc(e.verdict)}</span>${bad ? " · forged or tampered frame dropped, never published" : ""}`, { at, seq: e.seq })
  } else if (e.ev === "loop") {
    log("radio", `beacon restarted the flight replay at ${tPlus(e.flight_s)} · new pass, prediction reset`, { at })
  } else if (["x402req", "x402pay", "x402refused", "voucher", "offer", "delivery"].includes(e.ev)) {
    const what = { x402req: `x402 request for wind queued on the ground board (buyer 0.0.${e.buyer})`, x402pay: `x402 payment signed on the ground board · ${e.amount} tinybar 0.0.${e.payer} → 0.0.${e.pay_to}`,
      x402refused: `<span class="bad">ground board refused to pay</span> · ${esc(e.why)}`, voucher: `voucher signed on the ground board · nonce ${e.nonce}`, offer: `402 Payment Required from the beacon · ${e.amount} tinybar to 0.0.${e.pay_to}`,
      delivery: `wind delivered over LoRa · signature ${e.valid ? '<span class="ok">valid</span>' : '<span class="bad">invalid</span>'}` }[e.ev]
    log("hedera", what, { at })
  }
}
function connectLive() {
  const es = new EventSource("/api/stream")
  es.addEventListener("session", m => { const { data, at } = JSON.parse(m.data); S.frames.clear(); S.sigs = []; S.predictions = []; S.lastFrame = null; log("ops", `session <b>${esc(data.session)}</b> · following ${esc(data.log)}`, { at }); refresh() })
  es.addEventListener("radio", m => { const { data, at } = JSON.parse(m.data); onRadio(data, at); refresh() })
  es.addEventListener("prediction", m => { const { data, at } = JSON.parse(m.data); if (S.predictions.length && data.fromFlightS < S.predictions.at(-1).fromFlightS - 600) S.predictions = []; S.predictions.push(data); if (S.predictions.length > 300) S.predictions.shift()
    log("model", `Tawhiri re-prediction from seq ${data.fromSeq} (${fmt(data.fromAltM)} m, ${data.measuredBands} measured wind layers) · <span class="pred">lands ${data.missKm.toFixed(2)} km from actual</span> · <span class="mono">${data.ms} ms</span>`, { at, seq: data.fromSeq }); refresh() })
  es.addEventListener("arkiv", m => { const { data, at } = JSON.parse(m.data)
    if (data.kind === "batch") { S.arkivBatches.push(data); prArkiv(data); log("arkiv", `published ${data.count} frames (seq ${data.seqs[0]}–${data.seqs.at(-1)}) · <span class="mono">tx ${short(data.tx)} · ${data.ms} ms</span>`, { at }) }
    else if (data.kind === "run") { S.arkivRun = data.entity; log("arkiv", `session entity created <span class="mono">${short(data.entity)}</span>`, { at }) }
    else log("arkiv", `<span class="warn">publish retry</span> · ${esc(data.text)}`, { at }); refresh() })
  es.addEventListener("hedera", m => { const { data, at } = JSON.parse(m.data)
    if (data.kind === "sale") { S.sales.push({ what: `${data.amount / 1e8} HBAR · ${data.resource} · by ${data.payer}`, tx: data.tx }); log("hedera", `<span class="ok">sale settled</span> · ${data.amount} tinybar for ${esc(data.resource)}${data.topic ? ` · HCS ${data.topic} #${data.seq}` : ""}`, { at, link: { href: hsTx(data.tx), text: "HashScan" } }) }
    else log("hedera", `<span class="bad">${esc(data.text)}</span>`, { at }); refresh() })
  es.addEventListener("pi", m => { const { data, at } = JSON.parse(m.data)
    if (data.kind === "status") { S.pi.status = data; flowPacket("pi-beacon", "measured"); log("payload", `agent · ${esc(data.text)}`, { at }) }
    else if (data.kind === "checkpoint") { S.pi.checkpoints.push(data); flowPacket("pi-zerog", "caution", () => flash("zerog", data.safeStop ? "warn" : "ok")); log("payload", `0G checkpoint [${esc(data.name)}] · ${data.safeStop ? `<span class="warn">${esc(data.text)}</span>` : esc(data.text)}`, { at }) }
    else log("payload", esc(data.text ?? `agent booted · run ${data.run} · key ${short(data.key)}`), { at }); refresh() })
  es.addEventListener("tx", m => { const { data } = JSON.parse(m.data); onTx(data) })
  es.addEventListener("flight", m => { const { data } = JSON.parse(m.data); onFlight(data) })
  es.addEventListener("health", m => { const { data } = JSON.parse(m.data); S.health = data; S.busy = data.busy; S.replaying = false; renderSystems(); renderOps(); renderFlow(); renderMetrics(); renderRunbook() })
  es.addEventListener("cmd", m => { const { data, at } = JSON.parse(m.data)
    if (data.start) log("ops", `▶ ${esc(data.name)} · <span class="mono">${esc(data.command)}</span>`, { at })
    else if (data.done) {
      log("ops", `${esc(data.name)} finished · <span class="${data.code ? "bad" : "ok"}">exit ${data.code}</span>`, { at })
      if (data.name === "analyze") { S.insightsHtml = null; S.insightsLoading = false; loadInsights() }
      if (data.name === "attack" && data.code) log("ops", `<span class="warn">The beacon is not on Wi-Fi, so the command could not reach it.</span> Press the PRG button on the beacon to send the forged frame by hand (same effect), or open the iPhone's Personal Hotspot screen so the beacon rejoins.`, { at })
    }
    else {
      const l = data.line, tx = l.match(/(0\.0\.\d+@\d+\.\d+)/)?.[1]
      if (/SETTLED|paid \d+ tinybar|HCS audit|proof|VALID|wind at/.test(l)) { if (data.name === "radio" && /SETTLED tx/.test(l)) S.sales.push({ what: "LoRa x402 sale settled", tx }); log("hedera", esc(l), { at, link: tx ? { href: hsTx(tx), text: "HashScan" } : undefined }) }
      else log("ops", `<span class="mono">${esc(l)}</span>`, { at })
    }
    refresh() })
  es.onerror = () => { $("mode").textContent = "Reconnecting"; $("mode").dataset.mode = "archive" }
  es.onopen = () => { $("mode").textContent = "Live"; $("mode").dataset.mode = "live" }
}

// ---------------------------------------------------------------- operations
const OPS = { "op-start": "start", "op-stop": "stop", "op-attack": "attack", "op-buy": "buy", "op-radio": "radio", "op-analyze": "analyze" }
function renderOps() {
  const live = S.mode === "live", running = S.health?.ground.verifier
  for (const [id, name] of Object.entries(OPS)) {
    const b = $(id), needsSession = ["attack", "radio"].includes(name)
    b.disabled = !live || (S.busy && name !== "stop") || (needsSession && !running) || (name === "start" && running) || (name === "stop" && !running)
    b.setAttribute("aria-busy", S.busy === name)
  }
  $("op-alt").disabled = !live
  if ($("op-atk-when")) $("op-atk-when").disabled = $("op-attack").disabled
  $("ops-note").textContent = S.busy ? `running ${S.busy}…` : ""
  // Say why a light is red or yellow, and what fixes it.
  const h = S.health, probs = !live || !h ? [] : [
    h.diag?.verifierError && `Radio: ${h.diag.verifierError}, then Start session.`,
    h.diag && !h.diag.onHotspot && "This laptop is not on the iPhone hotspot, so it cannot reach the Pi or the beacon: join the \"iPhone\" network (keep its Personal Hotspot screen open).",
    !h.ground.usb && "No ground Heltec on USB: plug it in (some cables are charge only).",
    h.diag?.onHotspot && h.pi.lastAgeS != null && h.pi.lastAgeS > 120 && "Payload: the Pi has not answered for over 2 minutes. Check its power; it rejoins the hotspot within about a minute of booting."].filter(Boolean)
  $("ops-hint").innerHTML = probs.length ? probs.map(p => `<span class="warn">${esc(p)}</span>`).join("<br>")
    : esc(live ? (running ? "" : "Start a session to bring the radio link up.") : "Operations work on the ground station laptop.")
}
for (const [id, name] of Object.entries(OPS)) $(id).onclick = async () => {
  const r = await fetch(`/api/cmd/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alt: Number($("op-alt").value), when: $("op-atk-when")?.value }) }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
  if (!r.ok) log("ops", `<span class="bad">${esc(r.error)}</span>`)
}

// ---------------------------------------------------------------- Arkiv (shared by archive sessions and the query console)
let arkReady = null
function arkiv() {
  return (arkReady ??= (async () => {
    const [sdk, chains, q, sc, viem] = await Promise.all([import("https://esm.sh/@arkiv-network/sdk@1.0.0"), import("https://esm.sh/@arkiv-network/sdk@1.0.0/chains"),
      import("https://esm.sh/@arkiv-network/sdk@1.0.0/query"), import("https://esm.sh/@arkiv-network/sdk@1.0.0/schema"), import("https://esm.sh/viem@2.57.14")])
    const { str, i32, u64, dec, bytes, defineSchema } = sc
    const Wind = defineSchema("boscon.hab.wind", { flight: str().indexed(), dataset: str().indexed(), source: str().indexed(), phase: str().indexed(), altM: i32().indexed(), altBandKm: i32().indexed(), flightS: i32().indexed(), speedMs: dec().indexed(), towardDeg: dec().indexed(), lat: dec().indexed(), lon: dec().indexed() })
    const Prediction = defineSchema("boscon.hab.prediction", { flight: str().indexed(), dataset: str().indexed(), kind: str().indexed(), model: str(), fromFlightS: i32().indexed(), fromAltM: i32().indexed(), landLat: dec().indexed(), landLon: dec().indexed(), errorKm: dec().indexed(), windBands: i32().indexed(), track: bytes() })
    const Packet = defineSchema("boscon.hab.packet", { flight: str().indexed(), run: str().indexed(), beaconKey: str().indexed(), seq: u64().indexed(), flightS: i32().indexed(), lat: dec().indexed(), lon: dec().indexed(), altM: i32().indexed(), verdict: str().indexed(), receiver: str(), rssi: dec(), snr: dec(), frame: bytes(), livePa: dec().optional(), liveC: dec().optional() })
    const Run = defineSchema("boscon.hab.run", { flight: str().indexed(), run: str().indexed(), beaconKey: str().indexed(), startedAt: u64().indexed(), receiver: str(), note: str() })
    const PublicFix = defineSchema("boscon.hab.public", { dataset: str().indexed(), kind: str().indexed(), callsign: str().indexed(), t: u64().indexed(), lat: dec().indexed(), lon: dec().indexed(), altM: i32().indexed(), vzMs: dec() })
    const Insight = defineSchema("boscon.hab.insight", { flight: str().indexed(), dataset: str().indexed(), topic: str().indexed(), model: str().indexed(), teeAttested: str().indexed(), requestId: str(), createdAt: u64().indexed(), headline: str(), query: bytes(), body: bytes(), guardModel: str().indexed(), guardVerdict: str().indexed(), guardRequestId: str() })
    return { client: sdk.createPublicClient({ chain: chains.rabdi({ accessKey: "" }), transport: viem.http() }), q, sc, Wind, Prediction, Packet, Run, PublicFix, Insight }
  })())
}
const timeout = (p, ms) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error("timed out")), ms))])
const val = e => Object.fromEntries(Object.entries(e).map(([k, x]) => [k, x?.value ?? x]))

async function loadSessions() {
  try {
    const a = await timeout(arkiv(), 15000), { eq, desc } = a.q
    const res = await timeout(a.client.select({ run: true, startedAt: true, receiver: true }).from(a.Run).where(eq("flight", FLIGHT)).ownedBy(OWNER).orderBy(desc("startedAt")).limit(30).fetch(), 20000)
    const seen = new Set(), runs = res.entities.map(val).filter(r => !seen.has(r.run) && seen.add(r.run))
    S.arkivOk = true; S.runs = runs
    $("session").innerHTML = `<option value="arkiv-live">● Live from Arkiv (newest session)</option><option value="flight">31 Oct 2026 flight log</option><optgroup label="Sessions recorded on Arkiv">${runs.map(r => `<option value="${esc(r.run)}">${esc(r.run)} · ${new Date(Number(r.startedAt) * 1000).toISOString().slice(0, 16).replace("T", " ")}</option>`).join("")}</optgroup>`
  } catch (e) { S.arkivOk = false; log("arkiv", `<span class="warn">Arkiv unreachable</span> · ${esc(e.message)} · recorded sessions unavailable`) }
  renderSystems()
}
async function loadRun(run) {
  clearInterval(AL.timer); AL.on = false; $("mode").textContent = "Archive"; $("mode").dataset.mode = "archive"
  if (run === "arkiv-live") return followArkiv()
  S.frames.clear(); S.sigs = []; S.lastFrame = null; S.selected = null; LOG.length = 0
  if (run === "flight") { archiveFlightLog(); refresh(); return }
  log("arkiv", `loading session <b>${esc(run)}</b> from Arkiv…`)
  try {
    const a = await timeout(arkiv(), 15000), { and, eq, asc } = a.q, rows = []
    for (let off = 0; ; off += 100) {
      const p = await timeout(a.client.select({ $key: true, seq: true, flightS: true, lat: true, lon: true, altM: true, verdict: true, rssi: true, snr: true, frame: true, livePa: true, liveC: true, beaconKey: true, receiver: true })
        .from(a.Packet).where(and(eq("flight", FLIGHT), eq("run", run))).ownedBy(OWNER).orderBy(asc("seq")).limit(100).offset(off).fetch(), 20000)
      rows.push(...p.entities.map(val)); if (p.entities.length < 100) break
    }
    for (const r of rows) {
      if (S.frames.has(Number(r.seq)) && r.receiver !== "ground") continue
      const hex = r.frame ? (typeof r.frame === "string" ? r.frame.replace(/^0x/, "") : [...r.frame].map(b => b.toString(16).padStart(2, "0")).join("")) : null
      const f = { seq: Number(r.seq), flightS: Number(r.flightS), lat: Number(r.lat), lon: Number(r.lon), altM: Number(r.altM), rssi: Number(r.rssi), snr: Number(r.snr), verdict: ARKIV_VERDICT[r.verdict] ?? r.verdict,
        livePa: r.livePa != null ? Number(r.livePa) / 100 : null, liveC: r.liveC != null ? Number(r.liveC) : null, liveSrc: r.livePa != null ? "pi" : null, hex, beaconKey: r.beaconKey, run, key: r.$key }
      S.frames.set(f.seq, f)
    }
    const sorted = [...S.frames.values()].sort((x, y) => x.seq - y.seq); S.lastFrame = sorted.at(-1) ?? null
    for (const f of sorted) log("radio", `seq ${f.seq} · ${fmt(f.altM)} m · <span class="${VERDICT_CLASS(f.verdict)}">${esc(f.verdict)}</span> · <span class="mono">RSSI ${f.rssi} · entity ${short(f.key)}</span>`, { tlabel: tPlus(f.flightS), seq: f.seq })
    log("arkiv", `session <b>${esc(run)}</b> · ${rows.length} packet entities read from Arkiv`)
  } catch (e) { log("arkiv", `<span class="bad">could not load ${esc(run)}</span> · ${esc(e.message)}`) }
  refresh()
}
// ---------------------------------------------------------------- live from Arkiv (public site, no station)
// The ground station writes every verified frame to Arkiv within about a minute of hearing it.
// This follows the newest session there: anyone, anywhere, watches the balloon from Arkiv, not
// from our server. New frames play with the same animations as on the ground station.
const AL = { on: false, timer: 0, run: null, lastSeq: -1, keys: new Set(), at: 0 }
function packetToFrame(r, run) {
  const hex = r.frame ? (typeof r.frame === "string" ? r.frame.replace(/^0x/, "") : [...r.frame].map(b => b.toString(16).padStart(2, "0")).join("")) : null
  return { seq: Number(r.seq), flightS: Number(r.flightS), lat: Number(r.lat), lon: Number(r.lon), altM: Number(r.altM), rssi: Number(r.rssi), snr: Number(r.snr), verdict: ARKIV_VERDICT[r.verdict] ?? r.verdict,
    livePa: r.livePa != null ? Number(r.livePa) / 100 : null, liveC: r.liveC != null ? Number(r.liveC) : null, liveSrc: r.livePa != null ? "pi" : null, hex, beaconKey: r.beaconKey, run, key: r.$key, heardAt: Date.now() }
}
async function arkivPackets(a, run, fromSeq) {
  const { and, eq, gte, asc } = a.q, rows = []
  const where = fromSeq >= 0 ? and(eq("flight", FLIGHT), eq("run", run), gte("seq", a.sc.u64(fromSeq))) : and(eq("flight", FLIGHT), eq("run", run))
  for (let off = 0; ; off += 100) {
    const p = await timeout(a.client.select({ $key: true, seq: true, flightS: true, lat: true, lon: true, altM: true, verdict: true, rssi: true, snr: true, frame: true, livePa: true, liveC: true, beaconKey: true, receiver: true })
      .from(a.Packet).where(where).ownedBy(OWNER).orderBy(asc("seq")).limit(100).offset(off).fetch(), 20000)
    rows.push(...p.entities.map(val)); if (p.entities.length < 100) break
  }
  return rows
}
function alStatus() {
  $("mode").textContent = "Live · Arkiv"; $("mode").dataset.mode = "live"
  $("viewbar-note").textContent = `following ${AL.run} on Arkiv · checked ${AL.at ? new Date(AL.at).toISOString().slice(11, 19) : "…"} UTC · frames appear about a minute after the ground hears them`
}
async function followArkiv() {
  clearInterval(AL.timer); AL.on = true; S.frames.clear(); S.sigs = []; S.lastFrame = null; S.selected = null; LOG.length = 0; AL.keys.clear(); AL.lastSeq = -1
  if (!S.runs?.length) { log("arkiv", `<span class="warn">no session found on Arkiv yet</span>`); return }
  AL.run = S.runs[0].run; alStatus()
  log("arkiv", `following the newest session <b>${esc(AL.run)}</b> live from Arkiv`)
  try {
    const a = await timeout(arkiv(), 15000), rows = await arkivPackets(a, AL.run, -1)
    for (const r of rows) { if (AL.keys.has(r.$key)) continue; AL.keys.add(r.$key); const f = packetToFrame(r, AL.run); S.frames.set(f.seq, f); AL.lastSeq = Math.max(AL.lastSeq, f.seq) }
    const sorted = [...S.frames.values()].sort((x, y) => x.seq - y.seq); S.lastFrame = sorted.at(-1) ?? null
    // a flight other than HAB-1's replay: hide HAB-1's track so the map shows what is really flying
    const near = sorted[0] && dist(sorted[0], F.pad) < 8000; S.layers.archive = !!near
    if (S.lastFrame) { followTo(S.lastFrame.lat, S.lastFrame.lon) }
    log("arkiv", `${rows.length} frames of <b>${esc(AL.run)}</b> read from Arkiv; watching for new ones every 20 s`)
  } catch (e) { log("arkiv", `<span class="bad">Arkiv did not answer</span> · ${esc(e.message)}`) }
  AL.at = Date.now(); alStatus(); refresh()
  AL.timer = setInterval(alPoll, 20000)
}
async function alPoll() {
  if (!AL.on) return
  try {
    const a = await timeout(arkiv(), 15000)
    // a newer session started (a new Start session on the ground station): follow it
    const { eq, desc } = a.q
    const top = (await timeout(a.client.select({ run: true, startedAt: true }).from(a.Run).where(eq("flight", FLIGHT)).ownedBy(OWNER).orderBy(desc("startedAt")).limit(1).fetch(), 15000)).entities.map(val)[0]
    if (top && top.run !== AL.run) { S.runs.unshift(top); clearInterval(AL.timer); return followArkiv() }
    const rows = (await arkivPackets(a, AL.run, AL.lastSeq + 1)).filter(r => !AL.keys.has(r.$key))
    rows.forEach((r, i) => {
      AL.keys.add(r.$key)
      setTimeout(() => {                                       // a batch arrives at once on Arkiv; play it out frame by frame
        const f = packetToFrame(r, AL.run); S.frames.set(f.seq, f); S.lastFrame = f; AL.lastSeq = Math.max(AL.lastSeq, f.seq)
        fxAdd({ k: "tx", from: [f.lon, f.lat, f.altM], dur: 1500 })
        if (/REJECTED/.test(f.verdict)) { fxAdd({ k: "bad", at: [f.lon, f.lat, f.altM], dur: 2600 }); toast("bad", "Forged frame rejected", `seq ${f.seq} · read from Arkiv`) }
        else if (f.verdict === "VERIFIED") fxAdd({ k: "ok", at: [f.lon, f.lat, f.altM], dur: 1200, delay: 500 })
        log("radio", `seq ${f.seq} · ${fmt(f.altM)} m · <span class="${VERDICT_CLASS(f.verdict)}">${esc(f.verdict)}</span> · <span class="mono">from Arkiv · entity ${short(f.key)}</span>`, { tlabel: tPlus(f.flightS) })
        followTo(f.lat, f.lon); refresh()
      }, i * 700)
    })
  } catch (e) { /* Arkiv busy: try again on the next tick */ }
  AL.at = Date.now(); alStatus()
}

function archiveFlightLog() {
  const add = (t, src, html) => log(src, html, { tlabel: tPlus(t) })
  add(0, "payload", `released from the pad · ${pos(F.pad.lat, F.pad.lon)} · ${hms(RELEASE)} UTC`)
  for (const s of SAMPLES.filter(s => s.flightS > 0 && s.flightS % 900 === 0)) add(s.flightS, "payload", `${fmt(s.altM)} m · ${s.phase} · ${s.wind ? `drift ${s.wind.speedMs.toFixed(1)} m/s → ${Math.round(s.wind.towardDeg)}°` : ""} · ${s.pressHpa} hPa · ${s.tempC} °C`)
  const jet = SAMPLES.filter(s => s.wind).reduce((a, b) => (b.wind.speedMs > a.wind.speedMs ? b : a))
  add(jet.flightS, "payload", `<span class="meas">strongest wind ${jet.wind.speedMs.toFixed(1)} m/s at ${fmt(jet.wind.atAltM)} m</span> · subtropical jet`)
  add(BURST_T, "payload", `<span class="warn">burst</span> at ${fmt(F.burst.altM)} m`)
  for (const x of P.inflight.filter(x => x.fromFlightS % 1200 === 0)) add(x.fromFlightS, "model", `Tawhiri re-prediction · ${x.measuredBands} measured layers · <span class="pred">${x.errorKm.toFixed(2)} km from actual landing</span>`)
  add(0, "model", `pre-flight Tawhiri forecast on GFS · <span class="pred">${P.hindcast.errorKm.toFixed(2)} km from actual landing</span>`)
  add(LAND_T, "payload", `<span class="ok">landed</span> · ${pos(F.landing.lat, F.landing.lon)} · ${fmt(F.padToLandingKm, 1)} km from the pad`)
  LOG.sort((a, b) => parseT(b.tlabel) - parseT(a.tlabel))
}
const parseT = s => { const m = s?.match(/T([+−])(\d+):(\d+)/); return m ? (m[1] === "−" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0 }
$("session").onchange = () => { S.session = $("session").value; loadRun(S.session) }

// Arkiv query console
let arkInit = false
async function arkivInit() {
  if (arkInit) return; arkInit = true; buildPresets(); syncQ()
  try {
    const t0 = performance.now(), a = await timeout(arkiv(), 15000), { and, eq } = a.q, base = and(eq("flight", FLIGHT), eq("dataset", DATASET))
    const [w, p, pub, pk] = await timeout(Promise.all([a.client.count().from(a.Wind).where(base).ownedBy(OWNER).fetch(), a.client.count().from(a.Prediction).where(base).ownedBy(OWNER).fetch(), a.client.count().from(a.PublicFix).where(eq("dataset", DATASET)).ownedBy(OWNER).fetch(), a.client.count().from(a.Packet).where(eq("flight", FLIGHT)).ownedBy(OWNER).fetch()]), 20000)
    $("ark-counts").innerHTML = [["Frames", pk], ["Wind", w], ["Predictions", p], ["Public", pub]].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")
    $("ark-status").className = "status ok"; $("ark-status").textContent = `Connected to Arkiv Rabdi (${X.arkiv.chainId}) · counted in ${Math.round(performance.now() - t0)} ms`
  } catch (e) { $("ark-status").className = "status warn"; $("ark-status").textContent = `Arkiv did not answer (${e.message})` }
}
const PRESETS = [["Jet stream ≥ 20 m/s", { schema: "wind", source: "measured", speed: 20 }], ["10–15 km", { schema: "wind", source: "measured", altmin: 10000, altmax: 15000 }], ["Descent winds", { schema: "wind", source: "measured", phase: "descent" }],
  ["GFS levels", { schema: "wind", source: "gfs" }], ["Miss ≤ 1 km", { schema: "prediction", kind: "inflight", err: 1 }], ["Forged frames", { schema: "packet", verdict: "fake" }]]
function buildPresets() {
  $("presets").innerHTML = PRESETS.map(([l], i) => `<button type="button" data-i="${i}" aria-pressed="false">${l}</button>`).join("")
  for (const b of $("presets").children) b.onclick = () => {
    for (const o of $("presets").children) o.setAttribute("aria-pressed", o === b)
    const f = PRESETS[+b.dataset.i][1]
    for (const [id, k] of [["q-schema", "schema"], ["q-source", "source"], ["q-phase", "phase"], ["q-speed", "speed"], ["q-altmin", "altmin"], ["q-altmax", "altmax"], ["q-kind", "kind"], ["q-err", "err"], ["q-run", "run"]]) $(id).value = f[k] ?? (id === "q-schema" ? "wind" : "")
    if (f.verdict) $("q-verdict").value = f.verdict
    syncQ(); runQuery()
  }
}
const readQ = () => { const n = id => ($(id).value === "" ? null : Number($(id).value)); return { schema: $("q-schema").value, source: $("q-source").value, phase: $("q-phase").value, speed: n("q-speed"), altmin: n("q-altmin"), altmax: n("q-altmax"), kind: $("q-kind").value, err: n("q-err"), verdict: $("q-verdict").value, run: $("q-run").value.trim() } }
function clauses(f) {
  const c = [["eq", "flight", `"${FLIGHT}"`]]
  if (f.schema !== "packet") c.push(["eq", "dataset", `"${DATASET}"`])
  if (f.schema === "wind") { if (f.source) c.push(["eq", "source", `"${f.source}"`]); if (f.phase) c.push(["eq", "phase", `"${f.phase}"`]); if (f.speed != null) c.push(["gte", "speedMs", `dec("${f.speed}")`]); if (f.altmin != null) c.push(["gte", "altM", `i32(${f.altmin})`]); if (f.altmax != null) c.push(["lte", "altM", `i32(${f.altmax})`]) }
  else if (f.schema === "prediction") { if (f.kind) c.push(["eq", "kind", `"${f.kind}"`]); if (f.err != null) { c.push(["lte", "errorKm", `dec("${f.err}")`]); c.push(["gte", "errorKm", `dec("0")`]) } }
  else { c.push(["eq", "verdict", `"${f.verdict}"`]); if (f.run) c.push(["eq", "run", `"${f.run}"`]) }
  return c
}
const FIELDS = { wind: "altM, speedMs, towardDeg, phase, source, flightS", prediction: "kind, fromFlightS, fromAltM, errorKm, windBands", packet: "run, seq, altM, verdict, rssi" }
const ORDER = { wind: ["altM", "asc"], prediction: ["fromFlightS", "asc"], packet: ["seq", "desc"] }, NAME = { wind: "Wind", prediction: "Prediction", packet: "Packet" }
function syncQ() {
  const s = $("q-schema").value
  for (const [cls, k] of [[".q-wind", "wind"], [".q-pred", "prediction"], [".q-packet", "packet"]]) for (const el of document.querySelectorAll(cls)) el.hidden = s !== k
  const f = readQ(), k = x => `<span class="k">${x}</span>`, [ob, dir] = ORDER[f.schema]
  $("q-code").innerHTML = `client.${k("select")}({ ${FIELDS[f.schema]} })\n  .${k("from")}(${NAME[f.schema]})\n  .${k("where")}(${k("and")}(\n${clauses(f).map(([op, a, v]) => `    ${k(op)}(<span class="s">"${a}"</span>, ${v.startsWith('"') ? `<span class="s">${esc(v)}</span>` : `<span class="n">${esc(v)}</span>`})`).join(",\n")}))\n  .${k("ownedBy")}(<span class="s">"${short(OWNER)}"</span>)\n  .${k("orderBy")}(${k(dir)}(<span class="s">"${ob}"</span>)).${k("limit")}(100).${k("fetch")}()`
}
for (const id of ["q-schema", "q-source", "q-phase", "q-speed", "q-altmin", "q-altmax", "q-kind", "q-err", "q-verdict", "q-run"]) $(id).addEventListener("input", syncQ)
$("q-go").onclick = () => runQuery()
async function runQuery() {
  const f = readQ(), st = $("q-status"); $("q-go").disabled = true; st.className = "status"; st.textContent = "Querying Arkiv…"
  try {
    const a = await timeout(arkiv(), 15000), Q = a.q, sc = a.sc
    const v = x => (x.startsWith('"') ? x.slice(1, -1) : x.startsWith("i32(") ? sc.i32(Number(x.slice(4, -1))) : sc.dec(x.slice(5, -2)))
    const sel = Object.fromEntries(FIELDS[f.schema].split(", ").map(x => [x, true])); sel.$key = true
    const [ob, dir] = ORDER[f.schema], t0 = performance.now()
    const res = await timeout(a.client.select(sel).from(a[NAME[f.schema]]).where(Q.and(...clauses(f).map(([op, att, x]) => Q[op](att, v(x))))).ownedBy(OWNER).orderBy(Q[dir](ob)).limit(100).fetch(), 20000)
    const rows = res.entities.map(val), cols = FIELDS[f.schema].split(", ").slice(0, 4)
    st.className = "status ok"; st.textContent = `${rows.length} entities · ${Math.round(performance.now() - t0)} ms`
    $("q-results").innerHTML = `<thead><tr>${cols.map(c => `<th>${c}</th>`).join("")}<th>entity</th></tr></thead><tbody>${rows.slice(0, 40).map(r => `<tr>${cols.map(c => `<td>${esc(r[c])}</td>`).join("")}<td title="${esc(r.$key)}">${short(r.$key)}</td></tr>`).join("")}</tbody>`
    log("arkiv", `query ${NAME[f.schema]} · ${clauses(f).slice(f.schema === "packet" ? 1 : 2).map(c => `${c[1]} ${c[0]} ${c[2]}`).join(", ") || "all"} → <b>${rows.length}</b> entities`)
  } catch (e) { st.className = "status warn"; st.textContent = `Arkiv did not answer: ${e.message}` }
  $("q-go").disabled = false
}

// ---------------------------------------------------------------- premium: transactions, flow, runbook, toasts, metrics
S.txs = new Map(); S.replaying = true; S.view = "map"; S.flags = {}
const CHAIN = { arkiv: "Arkiv", hedera: "Hedera", hcs: "Hedera HCS" }
const secs = ms => (ms == null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)
function onTx(t) {
  const prev = S.txs.get(t.id); S.txs.set(t.id, { ...t, firstSeen: prev?.firstSeen ?? Date.now(), fresh: !S.replaying })
  if (!prev && t.status === "submitted") { flowPacket(t.chain === "arkiv" ? "station-arkiv" : "station-hedera", t.chain === "arkiv" ? "accent" : "nominal") }
  if (t.status === "confirmed" && prev?.status !== "confirmed") {
    flash(t.chain === "arkiv" ? "arkiv" : "hedera", "ok")
    if (t.chain === "hedera") toast("ok", "Sale settled on Hedera", `${t.summary ?? ""} · consensus in ${secs(t.latencyMs)}`, t.explorer)
    if (t.chain === "arkiv" && !S.flags.firstArkiv) { S.flags.firstArkiv = true; toast("info", "Frames confirmed on Arkiv", `${t.summary} · block ${fmt(t.block)}`, t.explorer) }
  }
  if (t.status === "failed") toast("bad", `${CHAIN[t.chain]} transaction failed`, t.summary ?? t.hash)
  log(t.chain === "arkiv" ? "arkiv" : "hedera", `${t.status === "confirmed" ? '<span class="ok">confirmed</span>' : t.status === "failed" ? '<span class="bad">failed</span>' : '<span class="warn">submitted</span>'} · ${esc(t.kind)} · ${esc(t.summary ?? "")}${t.block ? ` · <span class="mono">block ${fmt(t.block)}</span>` : ""}`, { link: t.explorer ? { href: t.explorer, text: "Explorer" } : undefined })
  renderTx(); renderRunbook(); renderMetrics(); renderFlow()
}
// All-time sales, from the HCS audit topic on the mirror node (every sale writes one message).
async function loadHbarAll() {
  try {
    const r = await (await fetch(`https://testnet.mirrornode.hedera.com/api/v1/topics/${X.hedera.auditTopic}/messages?order=desc&limit=100`)).json()
    let tinybar = 0
    for (const m of r.messages ?? []) { try { const j = JSON.parse(atob(m.message)); tinybar += Number(j.amount_tinybar ?? j.price_tinybar ?? 0) } catch {} }
    S.hbarAll = { tinybar, sales: (r.messages ?? []).length }; renderTx()
  } catch {}
}
loadHbarAll(); setInterval(loadHbarAll, 30000)
function renderTx() {
  const all = [...S.txs.values()].sort((a, b) => (b.submittedAt ?? b.firstSeen) - (a.submittedAt ?? a.firstSeen))
  const conf = all.filter(t => t.status === "confirmed"), pend = all.filter(t => t.status === "submitted")
  const ark = conf.filter(t => t.chain === "arkiv" && t.latencyMs), hbar = conf.filter(t => t.chain === "hedera").reduce((s, t) => s + (t.amount ?? 0) + (t.fee ?? 0), 0)
  $("tx-count").textContent = all.length
  $("tx-sum").innerHTML = `<span>Confirmed<b class="ok">${conf.length}</b></span><span>Pending<b class="${pend.length ? "warn" : ""}">${pend.length}</b></span><span>Arkiv entities<b>${fmt(conf.filter(t => t.chain === "arkiv").reduce((s, t) => s + (t.entities ?? 0), 0))}</b></span><span title="Paid on Hedera since this ground station started">Hedera, this session<b>${(hbar / 1e8).toFixed(4)} ℏ</b></span><span title="Every sale on the HCS audit topic, read from the Hedera mirror node">Hedera, all time<b>${S.hbarAll ? `${(S.hbarAll.tinybar / 1e8).toFixed(2)} ℏ · ${S.hbarAll.sales} sales` : "…"}</b></span>`
  if ($("d-tx").hidden) return
  $("tx-body").innerHTML = all.length ? all.slice(0, 150).map(t => {
    const confirm = t.status !== "confirmed" ? "waiting for chain…" : t.chain === "arkiv" ? `block ${fmt(t.block)} · ${fmt(t.gas)} gas` : t.chain === "hedera" ? `consensus ${secs(t.latencyMs)} · ${t.result}` : `consensus ${hms(t.consensusAt)}`
    const cost = t.chain === "hedera" ? `${((t.fee ?? 0) / 1e8).toFixed(5)} ℏ fee` : t.chain === "arkiv" ? `${secs(t.latencyMs)} write` : "—"
    return `<tr class="${t.fresh ? "new" : ""}"><td>${hms(t.submittedAt ?? t.firstSeen)}</td><td><span class="chain ${t.chain}"><i></i>${CHAIN[t.chain]}</span></td><td>${esc(t.kind)}</td><td class="what" title="${esc(t.summary)}">${esc(t.summary)}</td>
      <td><span class="st ${t.status}">${t.status}</span></td><td>${confirm}</td><td>${cost}</td><td>${t.explorer ? `<a href="${t.explorer}" target="_blank" rel="noopener">${esc(short(t.hash))} ↗</a>` : esc(short(t.hash))}</td></tr>` }).join("")
    : `<tr><td colspan="8" class="empty">${S.mode === "live" ? "No transaction yet this session. Frames are written to Arkiv in batches of six once they verify; sales settle on Hedera when someone buys." : "Transactions stream here live on the ground station. Every Arkiv batch and Hedera sale appears as submitted, then confirmed with its block or consensus time."}</td></tr>`
  for (const t of S.txs.values()) t.fresh = false
}

// toasts
function toast(kind, title, body, href) {
  if (S.replaying) return
  const el = document.createElement("div"); el.className = `toast ${kind}`
  el.innerHTML = `<i></i><b>${esc(title)}</b><span>${esc(body)}${href ? ` · <a href="${href}" target="_blank" rel="noopener">view ↗</a>` : ""}</span>`
  $("toasts").prepend(el); setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 320) }, 6500)
  while ($("toasts").children.length > 4) $("toasts").lastChild.remove()
}

// metrics
function renderMetrics() {
  const frames = [...S.frames.values()], ver = frames.filter(f => f.verdict === "VERIFIED").length, judged = frames.filter(f => f.verdict).length
  const txs = [...S.txs.values()], conf = txs.filter(t => t.status === "confirmed").length, pr = S.mode === "live" ? S.predictions.at(-1) : archivePred(S.t)
  const rej = frames.filter(f => /REJECTED/.test(f.verdict ?? "")).length
  $("metrics").innerHTML = [["Frames", fmt(frames.length)], ["Verified", judged ? `${Math.round((ver / judged) * 100)}%` : "—", ver ? "ok" : ""], ["Rejected", fmt(rej), rej ? "bad" : ""],
    ["On chain", `${conf}/${txs.length}`, conf ? "ok" : ""], ["Pred. miss", pr ? `${(pr.missKm ?? pr.errorKm).toFixed(2)} km` : "—", "pred"]]
    .map(([k, v, c]) => `<div><dt>${k}</dt><dd class="${c ?? ""}">${v}</dd></div>`).join("")
}

// runbook: ticks itself as each demo moment really happens
const RUNBOOK = [
  ["Radio link up", () => { const n = [...S.frames.values()].filter(f => f.verdict === "VERIFIED").length; return [n > 0, `${n} frames verified over LoRa`] }],
  ["Payload sensor on air", () => { const f = [...S.frames.values()].find(f => f.liveSrc === "pi"); return [!!f, f ? `Pi barometer ${f.livePa?.toFixed(1)} hPa in the frame` : "Pi barometer rides in every frame"] }],
  ["Signature verified", () => { const s = S.sigs.filter(x => x.valid && !x.replay).length; return [s > 0, `${s} batch signatures valid`] }],
  ["Forged frame rejected", () => { const n = [...S.frames.values()].filter(f => /REJECTED/.test(f.verdict ?? "")).length; return [n > 0, n ? `${n} forged frames dropped` : "Press PRG on the beacon or Inject forged frame"] }],
  ["Landing re-predicted", () => { const p = S.predictions.at(-1); return [!!p, p ? `${p.missKm.toFixed(2)} km from the real landing` : "CUSF Tawhiri on every verified fix"] }],
  ["Written to Arkiv", () => { const n = [...S.txs.values()].filter(t => t.chain === "arkiv" && t.status === "confirmed").length; return [n > 0, `${n} batches confirmed on Rabdi`] }],
  ["Wind sold on Hedera", () => { const t = [...S.txs.values()].find(t => t.chain === "hedera" && t.status === "confirmed"); return [!!t, t ? `settled in ${secs(t.latencyMs)} · HCS audited` : "Buy wind · x402 in Operations"] }],
  ["0G checkpoint logged", () => { const n = S.pi.checkpoints.length; return [n > 0, n ? `${n} checkpoints · ${n - S.pi.checkpoints.filter(c => c.safeStop).length} answered by 0G · ${S.pi.checkpoints.filter(c => c.safeStop).length} safe stops` : "Pi asks 0G before each decision"] }],
]
function renderRunbook() {
  if (!$("runbook")) return          // the runbook panel was removed from the rail; DEMO.md has the steps
  const r = RUNBOOK.map(([t, f]) => [t, ...f()]), done = r.filter(x => x[1]).length, next = r.findIndex(x => !x[1])
  $("rb-note").textContent = `${done} / ${r.length}`
  $("runbook").innerHTML = r.map(([t, ok, d], i) => `<li class="${ok ? "done" : i === next ? "next" : ""}"><span>${t}</span><small>${esc(d)}</small></li>`).join("")
}

// ---------------------------------------------------------------- system flow
const NODES = {
  pi: { x: 0.17, y: 0.2, name: "Payload computer", sub: "Raspberry Pi 5 · MS5611 · camera" },
  beacon: { x: 0.17, y: 0.78, name: "Beacon", sub: "Heltec V3 · ESP32-S3 + SX1262" },
  ground: { x: 0.5, y: 0.78, name: "Ground receiver", sub: "Heltec V3 · USB to laptop" },
  station: { x: 0.5, y: 0.47, name: "Ground station", sub: "verifier · Tawhiri · publisher" },
  zerog: { x: 0.83, y: 0.2, name: "0G", sub: "Private Computer · TEE" },
  arkiv: { x: 0.83, y: 0.47, name: "Arkiv", sub: `Rabdi · chain ${X.arkiv.chainId}` },
  hedera: { x: 0.83, y: 0.78, name: "Hedera", sub: "testnet · x402 · HCS" },
}
const EDGES = { "pi-beacon": ["pi", "beacon", "UART tap", 0.5], "beacon-ground": ["beacon", "ground", "LoRa 866.1", 0.5], "ground-station": ["ground", "station", "USB", 0.5],
  "station-arkiv": ["station", "arkiv", "JSON-RPC", 0.5], "station-hedera": ["station", "hedera", "x402", 0.7], "pi-zerog": ["pi", "zerog", "HTTPS · TEE", 0.5] }
const GROUPS = [["In the air · payload", ["pi", "beacon"]], ["On the ground · laptop", ["ground", "station"]], ["Public infrastructure", ["zerog", "arkiv", "hedera"]]]
let flowBox = { w: 800, h: 500 }, paths = {}
function nodeMetrics(k) {
  const h = S.health, lf = S.lastFrame, live = S.mode === "live", frames = [...S.frames.values()]
  const st = linkStates(), txs = [...S.txs.values()]
  switch (k) {
    case "pi": return [st.payload, [["Barometer", lf?.livePa ? `${lf.livePa.toFixed(1)} hPa` : "—", "meas"], ["SoC", S.pi.status?.socC ? `${S.pi.status.socC} °C` : "—"], ["Mode", S.pi.status?.mode ?? "—", S.pi.status?.mode === "SAFE" ? "warn" : ""]]]
    case "beacon": return [st.radio, [["Last frame", lf ? `seq ${lf.seq}` : "—"], ["Altitude", lf ? `${fmt(lf.altM)} m` : "—"], ["Key", short(X.keys.beacon)]]]
    case "ground": return [st.radio === "off" ? "off" : h?.ground.usb ? "ok" : live ? "bad" : "off", [["Heard", fmt(frames.length)], ["RSSI · SNR", lf ? `${lf.rssi} · ${lf.snr}` : "—"], ["Pay key", short(X.keys.ground)]]]
    case "station": { const v = frames.filter(f => f.verdict === "VERIFIED").length, r = frames.filter(f => /REJECTED/.test(f.verdict ?? "")).length, p = S.predictions.at(-1)
      return [live ? (h?.ground.verifier ? "ok" : "warn") : "off", [["Verified", fmt(v), "ok"], ["Rejected", fmt(r), r ? "bad" : ""], ["Pred. miss", p ? `${p.missKm.toFixed(2)} km` : "—", "pred"]]] }
    case "arkiv": { const a = txs.filter(t => t.chain === "arkiv" && t.status === "confirmed")
      return [st.arkiv, [["Batches", fmt(a.length)], ["Entities", fmt(a.reduce((s, t) => s + (t.entities ?? 0), 0))], ["Last block", a.length ? fmt(Math.max(...a.map(t => t.block ?? 0))) : "—"]]] }
    case "hedera": { const s = txs.filter(t => t.chain === "hedera" && t.status === "confirmed"), last = s.sort((a, b) => b.consensusAt - a.consensusAt)[0]
      return [st.hedera, [["Sales", fmt(s.length)], ["Consensus", last ? secs(last.latencyMs) : "—"], ["HCS", fmt(txs.filter(t => t.chain === "hcs" && t.status === "confirmed").length)]]] }
    case "zerog": return [st.zerog, [["Attested", `${X.zeroG.teeAttestedModelsListed} models`, st.zerog === "ok" ? "ok" : "warn"], ["Checkpoints", fmt(S.pi.checkpoints.length)], ["Safe stops", fmt(S.pi.checkpoints.filter(c => c.safeStop).length), "warn"]]]
  }
}
function layoutFlow() {
  const wrap = $("flowwrap"); if (!wrap.clientWidth) return
  flowBox = { w: wrap.clientWidth, h: wrap.clientHeight }
  const P_ = k => [NODES[k].x * flowBox.w, NODES[k].y * flowBox.h]
  const svg = $("flow-svg"); svg.setAttribute("viewBox", `0 0 ${flowBox.w} ${flowBox.h}`)
  let g = ""; paths = {}
  const labels = []
  for (const [key, [a, b, label, at]] of Object.entries(EDGES)) {
    const [x1, y1] = P_(a), [x2, y2] = P_(b), vertical = Math.abs(x1 - x2) < 20, horizontal = Math.abs(y1 - y2) < 20
    const d = vertical || horizontal ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`
    paths[key] = d; labels.push([key, label, at, vertical])
    g += `<path id="e-${key}" class="edge ${S.mode === "live" ? "live" : ""}" d="${d}"/>`
  }
  g += `<g id="pkts"></g>`
  svg.innerHTML = g
  for (const [key, label, at, vertical] of labels) {
    const path = document.getElementById(`e-${key}`), p = path.getPointAtLength(path.getTotalLength() * at)
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text")
    t.setAttribute("class", "edge-label"); t.setAttribute("x", vertical ? p.x + 8 : p.x); t.setAttribute("y", vertical ? p.y + 4 : p.y - 7); t.setAttribute("text-anchor", vertical ? "start" : "middle"); t.textContent = label
    svg.insertBefore(t, document.getElementById("pkts"))
  }
  const narrow = flowBox.w < 900, cw = flowBox.w < 640 ? 142 : narrow ? 158 : 196, compact = flowBox.w < 640 || flowBox.h < 520
  $("flow-nodes").innerHTML = GROUPS.map(([label, ks]) => {
    const xs = ks.map(k => NODES[k].x * flowBox.w), ys = ks.map(k => NODES[k].y * flowBox.h), pad = cw / 2 + 12, vp = compact ? 50 : 72
    return `<div class="fgroup" style="left:${Math.min(...xs) - pad}px;top:${Math.min(...ys) - vp}px;width:${Math.max(...xs) - Math.min(...xs) + pad * 2}px;height:${Math.max(...ys) - Math.min(...ys) + vp * 2}px"><span>${label}</span></div>`
  }).join("") + Object.entries(NODES).map(([k, n]) => `<div class="fnode${compact ? " compact" : ""}" id="fn-${k}" style="left:${n.x * flowBox.w}px;top:${n.y * flowBox.h}px;width:${cw}px"></div>`).join("")
  renderFlow()
}
function renderFlow() {
  if (!$("flow-nodes").children.length) return
  for (const [k, n] of Object.entries(NODES)) {
    const el = $(`fn-${k}`); if (!el) continue
    const [st, rows] = nodeMetrics(k)
    el.innerHTML = `<div class="fnode-h"><span class="dot" data-st="${st}"></span><b>${n.name}</b></div><div class="fnode-sub">${n.sub}</div><dl>${rows.map(([a, b, c]) => `<div style="display:contents"><dt>${a}</dt><dd class="${c ?? ""}">${b}</dd></div>`).join("")}</dl>`
  }
}
function flash(k, kind) { if (S.replaying) return; const el = $(`fn-${k}`); if (!el) return; el.classList.remove("flash-ok", "flash-bad", "flash-info", "flash-warn"); void el.offsetWidth; el.classList.add(`flash-${kind}`); setTimeout(() => el.classList.remove(`flash-${kind}`), 1400) }
function flowPacket(edge, colourVar, then, dur = 950) {
  if (S.replaying || S.view === "map" || reduceMotion) { then?.(); return }
  const path = document.getElementById(`e-${edge}`), layer = document.getElementById("pkts"); if (!path || !layer) { then?.(); return }
  const len = path.getTotalLength(), c = document.createElementNS("http://www.w3.org/2000/svg", "circle"), colour = css(`--${colourVar}`)
  c.setAttribute("r", 4.5); c.setAttribute("fill", colour); c.setAttribute("class", "pkt"); c.style.color = colour; layer.appendChild(c)
  const t0 = performance.now()
  const step = now => { const k = Math.min(1, (now - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2, p = path.getPointAtLength(e * len)
    c.setAttribute("cx", p.x); c.setAttribute("cy", p.y); if (k < 1) requestAnimationFrame(step); else { c.remove(); then?.() } }
  requestAnimationFrame(step)
}
// ---------------------------------------------------------------- protocol view
// Each frame as the ground receiver hears it: across the LoRa link (timed from its real
// airtime), byte by byte, into its batch. When the batch's SIG frame arrives, this browser
// recomputes every frame's salted hash and checks the beacon's Ed25519 signature itself
// (WebCrypto), then the batch moves to the history and picks up its Arkiv transaction.
const PR = { heard: new Map(), batches: [], cur: null, queue: Promise.resolve(), key: undefined, verdicts: new Map() }
const AIR_SCALE = 4                       // animations run 4x slower than the real airtime
const BATCH_N = 6
// LoRa time on air: SF9, 125 kHz, CR 4/5, 8-symbol preamble, explicit header, CRC (Semtech AN1200.13).
const airtimeMs = n => (8 + 4.25 + 8 + Math.max(Math.ceil((8 * n - 4 * 9 + 28 + 16) / 36) * 5, 0)) * (512 / 125)
const unhex = h => Uint8Array.from((h ?? "").match(/../g) ?? [], x => parseInt(x, 16))
const hexOf = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("")
const prWait = ms => new Promise(r => setTimeout(r, ms))
const prReduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches
const DATA_FIELDS = [[0, 1, "magic", "", f => "0xB2 data"], [1, 5, "seq", "", f => f.seq], [5, 7, "flight time", "", f => tPlus(f.t)],
  [7, 11, "latitude", "", f => f.lat.toFixed(5)], [11, 15, "longitude", "", f => f.lon.toFixed(5)], [15, 17, "altitude", "", f => `${fmt(f.alt)} m`],
  [17, 19, "pressure", "", f => `${f.press.toFixed(1)} hPa`], [19, 21, "temperature", "", f => `${f.temp.toFixed(2)} °C`],
  [21, 23, "live pressure", "live", f => f.livePa ? `${f.livePa.toFixed(1)} hPa` : "none"], [23, 25, "live temp", "live", f => f.livePa ? `${f.liveC.toFixed(2)} °C` : "none"],
  [25, 26, "flags", "", f => [f.flags & 1 && "replay", f.flags & 2 && "live baro", f.flags & 4 && "from Pi"].filter(Boolean).join(" · ") || "0"], [26, 28, "key id", "", f => f.key]]
const SIG_FIELDS = [[0, 1, "magic", "", s => "0xB3 signature"], [1, 5, "first seq", "", s => s.first], [5, 6, "count", "", s => s.count], [6, 8, "boot", "", s => s.boot],
  [8, 12, "salt", "salt", s => `${s.salt} · revealed now`], [12, 36, "6 hashes", "hash", s => s.hashes.join(" ")], [36, 100, "Ed25519 signature", "sig", s => `${s.sig.slice(0, 16)}…`]]
function decodeData(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { seq: v.getUint32(1, true), t: v.getInt16(5, true), lat: v.getInt32(7, true) / 1e7, lon: v.getInt32(11, true) / 1e7, alt: v.getUint16(15, true),
    press: v.getUint16(17, true) / 10, temp: v.getInt16(19, true) / 100, livePa: v.getUint16(21, true) / 10, liveC: v.getInt16(23, true) / 100, flags: b[25], key: hexOf(b.subarray(26, 28)) }
}
function decodeSig(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { first: v.getUint32(1, true), count: b[5], boot: v.getUint16(6, true), salt: hexOf(b.subarray(8, 12)),
    hashes: Array.from({ length: BATCH_N }, (_, i) => hexOf(b.subarray(12 + 4 * i, 16 + 4 * i))), sig: hexOf(b.subarray(36, 100)) }
}
async function sha4(salt, frame) { const m = new Uint8Array(salt.length + frame.length); m.set(salt); m.set(frame, salt.length); return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", m)).subarray(0, 4)) }
async function edVerify(msg, sig) {
  try {
    if (PR.key === undefined) PR.key = await crypto.subtle.importKey("raw", unhex(X.keys.beacon), { name: "Ed25519" }, false, ["verify"])
    return await crypto.subtle.verify({ name: "Ed25519" }, PR.key, sig, msg)
  } catch { PR.key = null; return null }                  // this browser has no Ed25519 in WebCrypto
}
const prVisible = () => S.page === "protocol" && !document.hidden
const batchOf = seq => seq - (seq % BATCH_N)

function prEnqueue(fn) { PR.queue = PR.queue.then(fn).catch(e => console.error("protocol view", e)); }
// live events animate; the backlog replayed on connect, or a hidden view, is applied at once
const prAnimate = at => prVisible() && !prReduced() && Date.now() - (at ?? 0) < 15000

async function prAir(kind, n, label, animate) {
  const ms = airtimeMs(n)
  $("pr-lane-note").textContent = `${kind === "sig" ? "SIG" : "DATA"} · ${n} B · ${ms.toFixed(1)} ms on air${animate ? ` · shown ${AIR_SCALE}× slower` : ""}`
  if (!animate) return
  const lane = $("pr-lane"), w = lane.clientWidth, dur = ms * AIR_SCALE
  const trail = document.createElement("div"); trail.className = `pr-trail ${kind}`
  const pkt = document.createElement("div"); pkt.className = `pr-pkt mono ${kind}`; pkt.innerHTML = `<i style="width:${Math.round(n / 2)}px"></i>${esc(label)}`
  lane.append(trail, pkt)
  $("pr-tx").classList.remove("ping"); void $("pr-tx").offsetWidth; $("pr-tx").classList.add("ping")
  const end = Math.max(0, w - pkt.offsetWidth), ease = "cubic-bezier(.45, 0, .25, 1)"
  trail.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: dur, easing: ease, fill: "forwards" })
  await pkt.animate([{ transform: "translateX(0)" }, { transform: `translateX(${end}px)` }], { duration: dur, easing: ease, fill: "forwards" }).finished
  $("pr-rx").classList.remove("ping"); void $("pr-rx").offsetWidth; $("pr-rx").classList.add("ping")
  pkt.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: "forwards" }); trail.animate([{ opacity: .8 }, { opacity: 0 }], { duration: 500, fill: "forwards" })
  setTimeout(() => { pkt.remove(); trail.remove() }, 600)
}

function prBytes(bytes, fields, decoded, title, meta, animate) {
  $("pr-ftitle").textContent = title; $("pr-fmeta").textContent = meta
  const step = animate ? Math.min(14, 520 / bytes.length) : 0
  const owner = i => fields.findIndex(([a, b]) => i >= a && i < b)
  $("pr-bytes").innerHTML = Array.from(bytes, (x, i) => { const k = owner(i), f = fields[k]
    return `<span class="pr-b${k % 2 ? " alt" : ""}${f[3] ? " " + f[3] : ""}${animate ? " in" : ""}" data-f="${k}" style="--d:${Math.round(i * step)}ms">${x.toString(16).padStart(2, "0")}</span>` }).join("")
  $("pr-fields").innerHTML = fields.map(([a, b, name, cls, val], k) =>
    `<span class="pr-f${cls ? " " + cls : ""}${animate ? " in" : ""}" data-f="${k}" style="--d:${Math.round(b * step + 60)}ms"><small>${esc(name)}</small><span class="mono">${esc(String(val(decoded)))}</span></span>`).join("")
  return prWait(animate ? bytes.length * step + 300 : 0)
}
$("pr-fields").addEventListener("pointerover", e => { const k = e.target.closest(".pr-f")?.dataset.f; for (const c of $("pr-bytes").children) c.classList.toggle("hl", c.dataset.f === k) })
$("pr-fields").addEventListener("pointerleave", () => { for (const c of $("pr-bytes").children) c.classList.remove("hl") })

function prSlotHtml(seq, slot) {
  const st = slot?.state ?? "empty"
  const label = { empty: "not heard yet", pending: "hash unknown until the salt", ok: "VERIFIED", bad: "REJECTED", missing: "not heard" }[st]
  const f = slot?.real ?? slot?.cands?.[0]
  return `<b>seq ${seq}</b>${f ? `<small>${fmt(f.d.alt)} m · ${tPlus(f.d.t)}</small><small>RSSI ${f.rssi ?? "—"} · SNR ${f.snr ?? "—"}</small>` : "<small>—</small><small>&nbsp;</small>"}
    <span class="h mono">${slot?.hash ? `#${slot.hash}` : "# · · · ·"}</span><span class="pr-st">${label}</span>${slot?.fakes ? `<span class="fakes">${slot.fakes} forged frame${slot.fakes > 1 ? "s" : ""} dropped</span>` : ""}${slot?.unsigned ? `<small>${slot.unsigned} older frame${slot.unsigned > 1 ? "s" : ""} with this seq, from before a beacon restart: unsigned</small>` : ""}`
}
function prRenderBatch() {
  const b = PR.cur
  if (!b) { $("pr-slots").innerHTML = ""; $("pr-btitle").textContent = "Batch"; $("pr-bmeta").textContent = ""; return }
  $("pr-btitle").textContent = `Batch seq ${b.first}–${b.first + BATCH_N - 1}`
  $("pr-bmeta").textContent = b.sig ? `boot ${b.sig.boot} · salt ${b.sig.salt}` : "frames wait here until the batch signature arrives"
  $("pr-slots").innerHTML = Array.from({ length: BATCH_N }, (_, i) => { const seq = b.first + i, s = b.slots.get(seq)
    return `<div class="pr-slot" data-seq="${seq}" data-s="${s?.state ?? "empty"}">${prSlotHtml(seq, s)}</div>` }).join("")
}
function prSlotUpdate(seq, cls) {
  const el = $("pr-slots").querySelector(`[data-seq="${seq}"]`), s = PR.cur?.slots.get(seq); if (!el) return
  el.dataset.s = s?.state ?? "empty"; el.innerHTML = prSlotHtml(seq, s)
  if (cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls) }
}
function prNewBatch(first) { PR.cur = { first, slots: new Map(), sig: null, proof: [] }; $("pr-proof").innerHTML = ""; prRenderBatch() }

function prData(e, at) {
  if (!e.hex || e.hex.length !== 56) return
  const bytes = unhex(e.hex), d = decodeData(bytes), first = batchOf(d.seq)
  prEnqueue(async () => {
    const animate = prAnimate(at)
    // A frame for a batch whose signature was already heard can never be verified: a forger
    // who saw the salt is too late. Check it against that batch's signed hash and count it.
    const signed = PR.batches.slice(0, 3).find(b => b.first === first && b.sig)
    if (signed) {
      await prAir("data", bytes.length, `DATA seq ${d.seq} (late)`, animate)
      await prBytes(bytes, DATA_FIELDS, d, `Data frame · seq ${d.seq} · heard after its batch was signed`, `28 B · RSSI ${e.rssi} dBm`, animate)
      const h = await sha4(unhex(signed.sig.salt), bytes), i = d.seq - first
      if (h !== signed.sig.hashes[i] && !(signed.late ??= new Set()).has(e.hex)) {
        signed.late.add(e.hex); signed.fk = (signed.fk ?? 0) + 1
        $("pr-proof").innerHTML = `<div><span class="bad">seq ${d.seq} heard after the batch signature: hash ${h} ≠ signed ${signed.sig.hashes[i]} · forged frame rejected</span></div>`
        prRenderHist(false)
      }
      return
    }
    if (!PR.cur || PR.cur.first !== first) prNewBatch(first)
    await prAir("data", bytes.length, `DATA seq ${d.seq}`, animate)
    await prBytes(bytes, DATA_FIELDS, d, `Data frame · seq ${d.seq}`, `28 B · ${airtimeMs(28).toFixed(1)} ms on air · RSSI ${e.rssi} dBm · SNR ${e.snr} dB`, animate)
    const s = PR.cur.slots.get(d.seq) ?? { cands: [], state: "pending" }
    if (!s.cands.some(c => c.hex === e.hex)) s.cands.push({ hex: e.hex, bytes, d, rssi: e.rssi, snr: e.snr, at: at ?? Date.now() })
    s.state = s.state === "ok" ? "ok" : "pending"
    PR.cur.slots.set(d.seq, s); prSlotUpdate(d.seq, animate ? "land" : null)
  })
}

function prSig(e, at) {
  if (!e.hex || e.hex.length !== 200) return
  const bytes = unhex(e.hex), g = decodeSig(bytes)
  prEnqueue(async () => {
    const animate = prAnimate(at)
    if (!PR.cur || PR.cur.first !== g.first) prNewBatch(g.first)
    const b = PR.cur; b.sig = g; b.rssi = e.rssi
    await prAir("sig", bytes.length, `SIG seq ${g.first}–${g.first + BATCH_N - 1}`, animate)
    await prBytes(bytes, SIG_FIELDS, g, `Signature frame · seq ${g.first}–${g.first + BATCH_N - 1}`, `100 B · ${airtimeMs(100).toFixed(1)} ms on air · RSSI ${e.rssi} dBm`, animate)
    prRenderBatch()
    const proof = (html, cls = "") => { const el = document.createElement("div"); el.className = cls; el.innerHTML = html; $("pr-proof").append(el) }
    $("pr-proof").innerHTML = ""
    proof(`salt <span class="acc">${g.salt}</span> revealed: until now no one, a forger included, could compute these hashes`)
    const salt = unhex(g.salt)
    for (let i = 0; i < BATCH_N; i++) {
      const seq = g.first + i, s = b.slots.get(seq) ?? { cands: [] }; b.slots.set(seq, s)
      // heard more than 150 s before this SIG: from before a beacon restart, never signed (same rule as ground/verifier.py)
      const sigAt = at ?? Date.now(), stale = s.cands.filter(c => sigAt - (c.at ?? sigAt) > 150000)
      s.unsigned = stale.length; s.cands = s.cands.filter(c => !stale.includes(c))
      let real = null, fakes = 0
      for (const c of s.cands) { const h = await sha4(salt, c.bytes); if (h === g.hashes[i] && !real) { real = c; s.hash = h } else fakes++ }
      s.real = real; s.fakes = fakes; s.state = real ? "ok" : s.cands.length ? "bad" : "missing"; s.hash ??= s.cands.length ? await sha4(salt, s.cands[0].bytes) : null
      prSlotUpdate(seq, animate ? "scan" : null)
      if (animate) await prWait(260)
    }
    const valid = await edVerify(bytes.subarray(0, 36), bytes.subarray(36, 100))
    b.edBrowser = valid; b.edStation = e.valid
    const n = [...b.slots.values()].filter(s => s.state === "ok").length, fk = [...b.slots.values()].reduce((a, s) => a + (s.fakes ?? 0), 0), us = [...b.slots.values()].reduce((a, s) => a + (s.unsigned ?? 0), 0)
    proof(`SHA-256(salt ‖ frame)[0:4] recomputed here for ${b.slots.size} slots: <span class="ok">${n} match the signed list</span>${fk ? ` · <span class="bad">${fk} forged frame${fk > 1 ? "s" : ""} rejected</span>` : ""}`)
    proof(valid === null ? `Ed25519 over bytes 0–35: ${e.valid ? '<span class="ok">valid</span>' : '<span class="bad">INVALID</span>'} (checked by the ground station; this browser has no Ed25519)`
      : `Ed25519 over bytes 0–35 with beacon key ${short(X.keys.beacon)}: ${valid ? '<span class="ok">valid, verified in this browser</span>' : '<span class="bad">INVALID</span>'}${e.replay ? ' · <span class="bad">replay of an older batch</span>' : ""}`)
    if (us) proof(`<span class="acc">${us} older frame${us > 1 ? "s" : ""}</span> with these seqs were heard before the beacon restarted; their batch was never signed, so they are dropped as unsigned, not counted as forged`)
    PR.batches.unshift({ ...b, at: Date.now(), states: Array.from({ length: BATCH_N }, (_, i) => b.slots.get(g.first + i)?.state ?? "missing"), n, fk, us })
    PR.cur = null
    if (PR.batches.length > 40) PR.batches.pop()
    prRenderHist(animate)
  })
}

// Arkiv confirmations can arrive before their batch has been animated: keep them by seq.
PR.arkiv = new Map()
function prArkiv(data) { for (const q of data.seqs ?? []) PR.arkiv.set(Number(q), data); if (PR.arkiv.size > 600) PR.arkiv.delete(PR.arkiv.keys().next().value); prRenderHist(false) }
function prRenderHist(animate) {
  for (const b of PR.batches) if (!b.arkivTx) { const d = Array.from({ length: BATCH_N }, (_, i) => PR.arkiv.get(b.first + i)).find(Boolean); if (d) { b.arkivTx = d.tx; b.arkivMs = d.ms } }
  $("pr-hist").innerHTML = PR.batches.length ? PR.batches.map((b, i) => `<li class="${animate && i === 0 ? "new" : ""}">
      <span class="mono">seq ${b.first}–${b.first + BATCH_N - 1}</span>
      <span class="cells">${b.states.map(s => `<i data-s="${s}"></i>`).join("")}</span>
      <span>${b.n}/${BATCH_N} verified${b.fk ? ` · <span class="bad">${b.fk} forged</span>` : ""}${b.states.filter(s => s === "missing").length ? ` · <span class="dim">${b.states.filter(s => s === "missing").length} not heard</span>` : ""}${b.us ? ` · ${b.us} unsigned (older frames)` : ""} · Ed25519 ${b.edBrowser ? '<span class="ok">valid (browser)</span>' : b.edBrowser === false ? '<span class="bad">invalid</span>' : b.edStation ? '<span class="ok">valid (station)</span>' : '<span class="bad">invalid</span>'}</span>
      <span class="mono">${b.arkivTx ? `Arkiv <a href="https://rabdi.explorer.arkiv.network/tx/${b.arkivTx}" target="_blank" rel="noopener">${short(b.arkivTx)}</a> · ${b.arkivMs} ms` : "publishing to Arkiv…"}</span></li>`).join("")
    : `<li class="pr-empty">${S.mode === "live" ? "No batch signature heard yet: one comes every 7th slot (about 84 s)." : "Archive mode: signed batches appear here live on the ground station."}</li>`
}
// When to press PRG on the beacon so the fake is caught quickly: the fake rides with the next
// data frame and is judged when its batch's SIG frame arrives. Pressed while the batch's 5th
// frame is the latest, it goes with the 6th and the SIG catches it about 12 s later.
function prCue() {
  const el = $("pr-aside"); if (!el) return
  const f = S.lastFrame, live = S.mode === "live" && S.health?.ground?.verifier
  if (!live || !f?.heardAt) { el.innerHTML = ""; return }
  const k = f.seq % BATCH_N, age = (Date.now() - f.heardAt) / 1000
  if (k === 4 && age < 11) el.innerHTML = `<span class="chip ok">Press PRG on the beacon now · caught in about ${Math.max(12, Math.round(24 - age))} s</span>`
  else { const wait = Math.max(0, Math.round((k === 5 ? 6 : k === 4 ? 7 : 4 - k) * 12 - age)); el.innerHTML = `<span class="chip">Best moment to press PRG: in ${wait} s</span> <span class="chip">or Mission → Inject forged frame: "with the next frame" goes anywhere in the batch, "at end of batch" is caught fastest</span>` }
}
setInterval(() => { if (S.page === "protocol") prCue() }, 1000)
function prInit() {
  prRenderHist(false)
  if (S.mode !== "live") {
    $("pr-lane-note").textContent = "archive: live frames appear on the ground station"
    const f = [...S.frames.values()].filter(f => f.hex?.length === 56).at(-1)
    if (f) { const b = unhex(f.hex); prBytes(b, DATA_FIELDS, decodeData(b), `Data frame · seq ${f.seq} (recorded on Arkiv)`, "28 B", false) }
    else $("pr-bytes").innerHTML = `<p class="pr-empty">Frames appear here byte by byte as the ground receiver hears them.</p>`
  } else $("pr-bytes").innerHTML = `<p class="pr-empty">Waiting for the next frame from the beacon…</p>`
}

// ---------------------------------------------------------------- flight chooser (what the real beacon flies)
S.flightNow = { name: "HAB-1 31 Oct 2026", builtin: true }
function flightLabel() {
  $("fs-cur").innerHTML = `Now flying: <b>${esc(S.flightNow.builtin ? "HAB-1 · 31 Oct 2026" : S.flightNow.name)}</b>${S.flightNow.builtin ? "" : ` · ${S.flightNow.samples} points · peak ${fmt(S.flightNow.peakM)} m`}`
}
let fsCount = -1
function renderFlightSelect() {
  const fs = (PAGES?.catalog?.() ?? []).filter(f => f.pts.some(p => Number.isFinite(p[3])))
  if (fs.length === fsCount) return; fsCount = fs.length
  const keep = $("fs-select").value
  const groups = [["ours", "Our flight"], ["sim", "Simulated · CUSF Tawhiri"], ["public", "Public balloons near India · SondeHub"]]
  $("fs-select").innerHTML = groups.map(([g, t]) => { const items = fs.filter(f => f.group === g)
    return items.length ? `<optgroup label="${t}">${items.map(f => `<option value="${f.id}">${esc(f.id === "hab1" ? "HAB-1 · 31 Oct 2026 (built in)" : f.name.replace(/^Simulated · /, ""))} · ${fmt(f.maxAlt / 1000, 1)} km</option>`).join("")}</optgroup>` : "" }).join("")
    || `<option value="hab1">HAB-1 · 31 Oct 2026 (built in)</option>`
  if (keep && [...$("fs-select").options].some(o => o.value === keep)) $("fs-select").value = keep
  $("fs-note").textContent = `${fs.length} flights`
}
function initFlightChooser() {
  const live = S.mode === "live"
  $("fs-go").disabled = !live; $("fs-select").disabled = !live
  if (!live) { $("fs-cur").textContent = "Choosing a flight for the beacon works on the ground station."; return }
  PAGES?.loadCatalog?.(); renderFlightSelect()
  let n = 0; const iv = setInterval(() => { renderFlightSelect(); if (++n > 40) clearInterval(iv) }, 3000)
  $("fs-go").onclick = async () => {
    const id = $("fs-select").value; $("fs-go").disabled = true; $("fs-go").textContent = "Sending…"
    await PAGES.fly(id)
    $("fs-go").disabled = false; $("fs-go").textContent = "Fly it"
  }
}
function onFlight(f) {
  S.flightNow = f; flightLabel()
  S.frames.clear(); S.sigs = []; S.predictions = []; S.lastFrame = null
  if (!f.builtin && f.track?.length) {
    const lons = f.track.map(p => p[0]), lats = f.track.map(p => p[1])
    const cam = map.cameraForBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 90 })
    if (!reduceMotion) map.flyTo({ ...cam, zoom: Math.min(cam.zoom, 9), pitch: 62, bearing: -35, duration: 2600, curve: 1.6, essential: true }); else map.jumpTo({ ...cam })
    fxAdd({ k: "route", dur: 3200 })
  } else fit(800)
  log("ops", f.builtin ? "the beacon is back on the built-in HAB-1 replay" : `the beacon now flies <b>${esc(f.name)}</b>: ${f.samples} samples, one every ${f.stepS} s of flight, peak ${fmt(f.peakM)} m. Landing re-prediction is paused (our cached winds are for HAB-1's day and pad)`)
  refresh()
}

// view switcher
for (const b of document.querySelectorAll(".viewbar [role=tab]")) b.onclick = () => setView(b.dataset.v)
function setView(v) {
  S.view = v; $("center").dataset.view = v
  for (const b of document.querySelectorAll(".viewbar [role=tab]")) b.setAttribute("aria-selected", b.dataset.v === v)
  $("viewbar-note").textContent = ""
  requestAnimationFrame(() => { map.resize(); layoutFlow(); draw() })
}
addEventListener("resize", () => layoutFlow())

// ---------------------------------------------------------------- boot
const qs0 = new URLSearchParams(location.search)
let live = false
let stationState = null
try { const r = await timeout(fetch("/api/state"), 2500); stationState = r.ok ? await r.json() : null; live = stationState?.station === true } catch {}
if (live) {
  S.mode = "live"; $("mode").textContent = "Live"; $("mode").dataset.mode = "live"; $("session").disabled = true; $("session").innerHTML = `<option>live ground station</option>`; $("session").hidden = true
  S.layers.archive = true; $("layers").querySelector('[data-l="archive"]').checked = true
  connectLive()
  if (stationState?.flight && !stationState.flight.builtin) { S.flightNow = stationState.flight; flightLabel() }
} else {
  $("mode").textContent = "Archive"; archiveFlightLog()
}
if (!live) S.replaying = false
renderOps(); renderSystems(); renderInspector(); renderLog(); drawScrub(); draw(); renderTx(); renderRunbook(); renderMetrics(); prInit()
if (qs0.get("view") === "protocol" && !location.hash) location.hash = "#/protocol"
setView(["map", "flow", "split"].includes(qs0.get("view")) ? qs0.get("view") : live && innerWidth >= 1500 ? "split" : "map")

// ---------------------------------------------------------------- sections: Mission · Protocol · Flights · 0G · Hedera · Arkiv
// One page at a time, addressed by the URL hash, so a judge can be sent straight to #/zerog or #/hedera.
const SECTIONS = ["mission", "protocol", "flights", "zerog", "hedera", "arkiv"]
var PAGES = null      // var: refresh() may run before this line (live events arrive during boot)
try {
  const m = await import("./pages.js")
  PAGES = m.initPages({ S, X, P, F, $, esc, fmt, short, pos, hsTx, hsAcct, tPlus, hms, dist, timeout, arkiv, val, OWNER, FLIGHT, DATASET, mapStyle, css,
    getTheme: () => document.documentElement.dataset.theme, loadInsights, arkivInit, log, toast, op: id => $(id)?.click() })
} catch (e) { console.error("pages", e) }
function route() {
  const want = location.hash.match(/^#\/(\w+)/)?.[1], page = SECTIONS.includes(want) ? want : "mission"
  S.page = page; document.body.dataset.page = page
  for (const a of document.querySelectorAll(".nav a")) { if (a.dataset.p === page) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current") }
  const navA = document.querySelector(`.nav a[data-p="${page}"]`)
  document.title = page === "mission" ? "HAB-1 Ground Station" : `${navA?.querySelector("b")?.textContent ?? navA?.textContent} · HAB-1`
  const partner = ["zerog", "hedera", "arkiv"].includes(page)
  $("nav-dd-btn").classList.toggle("cur", partner); $("nav-dd-label").textContent = partner ? navA.querySelector("b").textContent : "Partners"
  $("nav-menu").hidden = true; $("nav-dd-btn").setAttribute("aria-expanded", "false")
  if (page === "mission") requestAnimationFrame(() => { map.resize(); layoutFlow(); draw() })
  PAGES?.show(page)
}
addEventListener("hashchange", route)
// Partners menu: opens on click, closes on a choice, an outside click or Escape
$("nav-dd-btn").onclick = e => { e.stopPropagation(); const open = $("nav-menu").hidden; $("nav-menu").hidden = !open; $("nav-dd-btn").setAttribute("aria-expanded", open); if (open) $("nav-menu").querySelector("a")?.focus() }
document.addEventListener("click", e => { if (!e.target.closest(".nav-dd")) { $("nav-menu").hidden = true; $("nav-dd-btn").setAttribute("aria-expanded", "false") } })
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("nav-menu").hidden) { $("nav-menu").hidden = true; $("nav-dd-btn").setAttribute("aria-expanded", "false"); $("nav-dd-btn").focus() } })
initFlightChooser()
for (const li of document.querySelectorAll(".links [data-go]")) li.onclick = () => { location.hash = `#/${li.dataset.go}` }
route()
addEventListener("resize", () => { drawScrub(); renderPlots() })
addEventListener("keydown", e => { if (e.code === "Space" && S.mode !== "live" && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); $("play").click() } })
const qs = new URLSearchParams(location.search)
if (qs.get("t")) { S.t = Number(qs.get("t")); draw(); renderInspector() }
if (!live) loadSessions().then(() => { const recent = S.runs?.[0] && Date.now() / 1000 - Number(S.runs[0].startedAt) < 12 * 3600
  if (!qs.get("session") && recent) { $("session").value = "arkiv-live"; S.session = "arkiv-live" }   // loaded by the line below
  const want = qs.get("session"); if (want && [...$("session").options].some(o => o.value === want)) { $("session").value = want; S.session = want } if (S.session !== "flight") loadRun(S.session) })
if (qs.get("session")) S.session = qs.get("session")
if (qs.get("tab")) showInspector(`i-${qs.get("tab")}`)
if (qs.get("dock")) document.querySelector(`.dock [aria-controls="d-${qs.get("dock")}"]`)?.click()
if (qs.get("play")) $("play").click()
