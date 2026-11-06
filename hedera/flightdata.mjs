// What the ground station sells: the newest batch the verifier accepted, with the
// beacon's raw frames and its signature, so a buyer can check it without trusting us,
// plus the wind derived from consecutive verified positions.
import fs from "node:fs"
import path from "node:path"

const here = path.dirname(new URL(import.meta.url).pathname)
const LOG_DIR = path.join(here, "..", "ground", "log")
const PUBKEY = fs.readFileSync(path.join(here, "..", "ground", "beacon_pubkey.hex"), "utf8").trim()

function newestLog() {
  const f = fs.readdirSync(LOG_DIR).filter(n => n.startsWith("verifier-")).sort().at(-1)
  return f ? path.join(LOG_DIR, f) : null
}

// Verified frames and the signature frames that cover them, from the newest verifier log.
export function load() {
  const file = newestLog()
  if (!file) return { frames: [], sigs: new Map(), file: null }
  let frames = [], sigs = new Map(), lastSeq = -1
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let e; try { e = JSON.parse(line) } catch { continue }
    // seq going backwards means the beacon rebooted: keep only its newest boot
    if ((e.ev === "data" || e.ev === "sig") && (e.seq ?? e.first) < lastSeq - 6) { frames = []; sigs = new Map() }
    if (e.ev === "data") lastSeq = e.seq
    if (e.ev === "verdict" && e.verdict === "VERIFIED") frames.push(e)
    if (e.ev === "sig" && e.valid && !e.replay && e.hex) sigs.set(e.first, e.hex)
  }
  return { frames, sigs, file }
}

const R = 6371000
const MAX_BAND_GAP_M = 1500
const rad = d => d * Math.PI / 180
function move(a, b) {                       // metres and bearing from a to b
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  const dist = 2 * R * Math.asin(Math.sqrt(h))
  const y = Math.sin(dLon) * Math.cos(rad(b.lat))
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon)
  return { dist, bearing: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 }
}

// Each frame with the signature frame of the batch that covers it (batch k covers seqs k..k+5).
function proof(frames, sigs) {
  return {
    beacon_pubkey: PUBKEY,
    frames: frames.map(f => {
      const k = [...sigs.keys()].find(s => s <= f.seq && f.seq < s + 6)
      return { seq: f.seq, frame: f.hex, sig_frame: k !== undefined ? sigs.get(k) : null }
    }),
    how_to_check: "Ed25519-verify sig_frame bytes 36..99 over bytes 0..35 with beacon_pubkey; then the first 4 bytes of "
      + "SHA-256(salt + frame), salt = sig_frame bytes 8..11, must equal sig_frame bytes 12+4i..15+4i, where "
      + "i = seq - (first_seq in sig_frame bytes 1..4). Bytes 6..7 are the beacon's boot number: a batch older than one "
      + "you have seen is a replay. (A 94-byte sig_frame is the format used before 4 Nov 2026: signature at 30..93 over "
      + "0..29, unsalted hashes at 6+4i.)",
  }
}

// Wind at the altitude band nearest alt_m: the balloon drifts with the wind, so the
// horizontal speed between two consecutive verified fixes is the wind there (computed).
export function wind(altM) {
  const { frames, sigs } = load()
  const pairs = []
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i]
    if (b.seq !== a.seq + 1 || b.flight_s <= a.flight_s) continue
    const m = move(a, b), dt = b.flight_s - a.flight_s
    pairs.push({ a, b, alt_m: Math.round((a.alt_m + b.alt_m) / 2), speed_ms: m.dist / dt, toward_deg: m.bearing, dt })
  }
  if (!pairs.length) return null
  const best = pairs.reduce((p, q) => Math.abs(q.alt_m - altM) < Math.abs(p.alt_m - altM) ? q : p)
  // Do not sell wind from a different height: with nothing verified within MAX_BAND_GAP_M
  // of the request, return nothing, and the server answers before any payment settles.
  if (Math.abs(best.alt_m - altM) > MAX_BAND_GAP_M) return null
  const p = proof([best.a, best.b], sigs)
  return {
    asked_alt_m: altM, band_alt_m: best.alt_m,
    wind_speed_ms: Number(best.speed_ms.toFixed(1)),
    wind_toward_deg: Math.round(best.toward_deg),
    wind_from_deg: Math.round((best.toward_deg + 180) % 360),
    from_flight_s: [best.a.flight_s, best.b.flight_s], seqs: [best.a.seq, best.b.seq],
    method: "computed: great-circle distance between two consecutive verified GPS fixes divided by the time between them",
    source: "replay of the HAB-1 flight of 31 Oct 2026, sent over the flight radios and verified on the ground",
    proof: p,
  }
}

export function latest() {
  const { frames, sigs } = load()
  const f = frames.at(-1)
  if (!f) return null
  const p = proof([f], sigs)
  return { seq: f.seq, flight_s: f.flight_s, lat: f.lat, lon: f.lon, alt_m: f.alt_m, rssi: f.rssi, snr: f.snr,
           source: "replay of the HAB-1 flight of 31 Oct 2026, verified on the ground", proof: p }
}
