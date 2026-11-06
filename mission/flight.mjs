#!/usr/bin/env node
// Turn the HAB-1 replay table (31 Oct 2026, one fix every 60 s) into JSON with the
// derived fields the predictor, Arkiv and the site use: phase, vertical speed,
// and the wind the balloon drifted with between consecutive fixes.
//
//   node flight.mjs            writes data/flight-hab1.json
import fs from "node:fs"
import path from "node:path"

const here = path.dirname(new URL(import.meta.url).pathname)
const SRC = path.join(here, "..", "firmware", "hab_node", "replay_data.h")
const OUT = path.join(here, "data", "flight-hab1.json")
const RELEASE = Date.parse("2026-10-31T07:07:06Z")   // from tools/make_replay.py

import { haversine, bearing } from "./geo.mjs"

const rows = [...fs.readFileSync(SRC, "utf8").matchAll(/\{\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(\d+),\s*(\d+),\s*(-?\d+)\s*\}/g)]
  .map(m => ({ flightS: +m[1], lat: +m[2] / 1e7, lon: +m[3] / 1e7, altM: +m[4], pressHpa: +m[5] / 10, tempC: +m[6] / 100 }))

const burstIdx = rows.reduce((bi, r, i) => r.altM > rows[bi].altM ? i : bi, 0)
const landIdx = rows.findIndex((r, i) => i > burstIdx && i + 1 < rows.length && Math.abs(rows[i + 1].altM - r.altM) < 3 && r.altM < rows[0].altM + 300)

const samples = rows.map((r, i) => {
  const prev = rows[Math.max(0, i - 1)], next = rows[Math.min(rows.length - 1, i + 1)]
  const dt = next.flightS - prev.flightS || 1
  const vz = (next.altM - prev.altM) / dt
  const phase = r.flightS < 0 ? "pad" : i <= burstIdx ? "ascent" : (landIdx > 0 && i >= landIdx) ? "landed" : "descent"
  let wind = null
  if (i + 1 < rows.length && phase !== "pad" && phase !== "landed") {
    const d = haversine(r, next), t = next.flightS - r.flightS
    // the drift is the wind's direction of travel ("toward"); meteorology quotes "from"
    wind = { speedMs: +(d / t).toFixed(2), towardDeg: +bearing(r, next).toFixed(1),
             fromDeg: +((bearing(r, next) + 180) % 360).toFixed(1), atAltM: Math.round((r.altM + next.altM) / 2) }
  }
  return { ...r, t: new Date(RELEASE + r.flightS * 1000).toISOString(), vzMs: +vz.toFixed(2), phase,
           altBandKm: Math.floor(r.altM / 1000), wind }
})

const pad = rows[1], land = rows[landIdx > 0 ? landIdx : rows.length - 1], burst = rows[burstIdx]
const out = {
  flight: "hab1-2026-10-31", source: "HAB-1 flight log via firmware/hab_node/replay_data.h (60 s samples)",
  release: new Date(RELEASE).toISOString(),
  pad: { lat: pad.lat, lon: pad.lon, altM: pad.altM },
  burst: { lat: burst.lat, lon: burst.lon, altM: burst.altM, flightS: burst.flightS },
  landing: { lat: land.lat, lon: land.lon, altM: land.altM, flightS: land.flightS },
  padToLandingKm: +(haversine(pad, land) / 1000).toFixed(2),
  meanAscentMs: +((burst.altM - pad.altM) / burst.flightS).toFixed(2),
  meanDescentMs: +((burst.altM - land.altM) / (land.flightS - burst.flightS)).toFixed(2),
  samples,
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
console.log(`flight ${out.flight}: ${samples.length} samples, burst ${burst.altM} m at T+${(burst.flightS / 60).toFixed(0)} min, ` +
  `landing T+${(land.flightS / 60).toFixed(0)} min, ${out.padToLandingKm} km from pad, ascent ${out.meanAscentMs} m/s, descent ${out.meanDescentMs} m/s`)
console.log(`wrote ${OUT}`)
