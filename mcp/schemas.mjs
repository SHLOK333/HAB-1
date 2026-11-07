// The Arkiv entity types the MCP server reads. Copies of ../arkiv/schema.mjs (Packet, Sig, Run)
// and ../mission/schema.mjs (Wind, Prediction, Insight), so this folder installs and runs on its
// own. Change them together.
import { bytes, dec, defineSchema, i32, str, u64 } from "@arkiv-network/sdk/schema"

export const FLIGHT = "hab1-2026-10-31"
export const DATASET = "mission-v1"

// One frame one receiver heard, with that receiver's verdict and the 28 raw bytes.
export const Packet = defineSchema("boscon.hab.packet", {
  flight: str().indexed(), run: str().indexed(), beaconKey: str().indexed(), seq: u64().indexed(),
  flightS: i32().indexed(), lat: dec().indexed(), lon: dec().indexed(), altM: i32().indexed(),
  verdict: str().indexed(), receiver: str(), rssi: dec(), snr: dec(), frame: bytes(),
  livePa: dec().optional(), liveC: dec().optional(),
})

// One SIG frame one receiver heard: the beacon's signature over 6 data frames, 100 raw bytes.
export const Sig = defineSchema("boscon.hab.sig", {
  flight: str().indexed(), run: str().indexed(), beaconKey: str().indexed(), firstSeq: u64().indexed(),
  boot: i32().indexed(), valid: str().indexed(), receiver: str(), rssi: dec(), snr: dec(), frame: bytes(),
})

// One session (a replay of the flight through the radios).
export const Run = defineSchema("boscon.hab.run", {
  flight: str().indexed(), run: str().indexed(), beaconKey: str().indexed(), startedAt: u64().indexed(),
  receiver: str(), note: str(),
})

export const Wind = defineSchema("boscon.hab.wind", {
  flight: str().indexed(), dataset: str().indexed(), source: str().indexed(), phase: str().indexed(),
  altM: i32().indexed(), altBandKm: i32().indexed(), flightS: i32().indexed(), speedMs: dec().indexed(),
  towardDeg: dec().indexed(), lat: dec().indexed(), lon: dec().indexed(),
})

export const Prediction = defineSchema("boscon.hab.prediction", {
  flight: str().indexed(), dataset: str().indexed(), kind: str().indexed(), model: str(),
  fromFlightS: i32().indexed(), fromAltM: i32().indexed(), landLat: dec().indexed(), landLon: dec().indexed(),
  errorKm: dec().indexed(), windBands: i32().indexed(), track: bytes(),
})

export const Insight = defineSchema("boscon.hab.insight", {
  flight: str().indexed(), dataset: str().indexed(), topic: str().indexed(), model: str().indexed(),
  teeAttested: str().indexed(), requestId: str(), createdAt: u64().indexed(), headline: str(),
  query: bytes(), body: bytes(), guardModel: str().indexed(), guardVerdict: str().indexed(), guardRequestId: str(),
})
