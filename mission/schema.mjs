// Mission-level Arkiv schemas: what the flight measured, what the models predicted,
// what the AI concluded, and the public balloons flying at the same time.
// Shared by publish.mjs, analytics.mjs and the site. The live packet/run schemas stay
// in ../arkiv/schema.mjs.
import { bytes, dec, defineSchema, i32, str, u64 } from "@arkiv-network/sdk/schema"

export const FLIGHT = "hab1-2026-10-31"
export const DATASET = "mission-v1"          // bump to publish a fresh, separately queryable set

// One wind measurement: the balloon's drift between two fixes (source "measured"),
// or one GFS pressure level over the pad at release (source "gfs").
export const Wind = defineSchema("boscon.hab.wind", {
  flight:    str().indexed(),
  dataset:   str().indexed(),
  source:    str().indexed(),   // measured | gfs
  phase:     str().indexed(),   // ascent | descent | model
  altM:      i32().indexed(),
  altBandKm: i32().indexed(),
  flightS:   i32().indexed(),   // seconds after release; -1 for model levels
  speedMs:   dec().indexed(),
  towardDeg: dec().indexed(),   // direction the air moves toward
  lat:       dec().indexed(),
  lon:       dec().indexed(),
})

// One landing prediction. kind: hindcast | inflight | forecast.
export const Prediction = defineSchema("boscon.hab.prediction", {
  flight:      str().indexed(),
  dataset:     str().indexed(),
  kind:        str().indexed(),
  model:       str(),           // <= 128 bytes
  fromFlightS: i32().indexed(), // when in the flight this prediction was made
  fromAltM:    i32().indexed(),
  landLat:     dec().indexed(),
  landLon:     dec().indexed(),
  errorKm:     dec().indexed(), // distance from the real landing (-1 when unknown, e.g. a forecast)
  windBands:   i32().indexed(), // measured 500 m bands used instead of GFS
  track:       bytes(),         // JSON [[lat, lon, alt], ...]
})

// One AI analysis of Arkiv data, done by a 0G model.
export const Insight = defineSchema("boscon.hab.insight", {
  flight:     str().indexed(),
  dataset:    str().indexed(),
  topic:      str().indexed(),  // e.g. jet-stream, burst, landing-error
  model:      str().indexed(),
  teeAttested: str().indexed(), // "true" | "false": did 0G list the model as TEE-attested
  requestId:  str(),            // 0G response id
  createdAt:  u64().indexed(),
  headline:   str(),            // <= 128 bytes
  query:      bytes(),          // the Arkiv filter the analysis read, as text
  body:       bytes(),          // full answer + inputs digest, JSON
  guardModel: str().indexed(),  // the 0G decision model that checked the claims (vela-2.0-9b)
  guardVerdict: str().indexed(), // "supported" | "flagged": did it mark claims the Arkiv data does not support
  guardRequestId: str(),        // its 0G request id
})

// A public balloon seen on SondeHub (radiosonde or amateur), one entity per position snapshot.
export const PublicFix = defineSchema("boscon.hab.public", {
  dataset:   str().indexed(),
  kind:      str().indexed(),   // radiosonde | amateur
  callsign:  str().indexed(),
  t:         u64().indexed(),   // unix seconds
  lat:       dec().indexed(),
  lon:       dec().indexed(),
  altM:      i32().indexed(),
  vzMs:      dec(),
})

export const DAYS = 30
