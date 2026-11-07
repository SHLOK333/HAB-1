// Arkiv schemas, shared by the publisher, the query tool and the public map.
//
// Packet: one frame one receiver heard, with the verifier's verdict. Owned by the
// receiver's wallet, so every receiver vouches only for what it heard itself.
// Sig: one SIG frame one receiver heard: the beacon's Ed25519 signature over 6 data frames.
// With the Packet frames it lets anyone redo the verifier's check without trusting us
// (mcp/server.mjs does): the signature over bytes 0..35 with the beacon's key, then each
// data frame's SHA-256(salt + frame) against the hashes the signature covers.
// Run: one replay session, so the map can list sessions and pick the latest.
import { bytes, defineSchema, dec, i32, str, u64 } from "@arkiv-network/sdk/schema"

export const FLIGHT = "hab1-2026-10-31"

export const Packet = defineSchema("boscon.hab.packet", {
  flight:    str().indexed(),   // which flight the data comes from
  run:       str().indexed(),   // which replay session
  beaconKey: str().indexed(),   // the beacon's Ed25519 public key, hex
  seq:       u64().indexed(),
  flightS:   i32().indexed(),   // seconds since release
  lat:       dec().indexed(),   // indexed so anyone can query a box on the map
  lon:       dec().indexed(),
  altM:      i32().indexed(),
  verdict:   str().indexed(),   // verified | fake | bad_signature | unverified | replay | conflict | unsigned
  receiver:  str(),             // receiver name, the owner wallet is $owner
  rssi:      dec(),
  snr:       dec(),
  frame:     bytes(),           // the 28 raw bytes as heard, so anyone can re-check them
  livePa:    dec().optional(),  // live outside pressure (the payload Pi's MS5611), Pa; absent if none
  liveC:     dec().optional(),  // live outside temperature, C
})

export const Sig = defineSchema("boscon.hab.sig", {
  flight:    str().indexed(),
  run:       str().indexed(),
  beaconKey: str().indexed(),   // the key the receiver checked it with; re-check with your own copy
  firstSeq:  u64().indexed(),   // the first data frame it covers
  boot:      i32().indexed(),   // the beacon's boot counter: (boot, firstSeq) only goes up
  valid:     str().indexed(),   // "true" | "false": the receiver's own check of the signature
  receiver:  str(),
  rssi:      dec(),
  snr:       dec(),
  frame:     bytes(),           // the 100 raw bytes as heard
})

export const Run = defineSchema("boscon.hab.run", {
  flight:    str().indexed(),
  run:       str().indexed(),
  beaconKey: str().indexed(),
  startedAt: u64().indexed(),   // unix seconds
  receiver:  str(),
  note:      str(),
})

export const VERDICTS = {
  "VERIFIED": "verified",
  "FAKE REJECTED": "fake",
  "REJECTED bad signature": "bad_signature",
  "ACCEPTED unverified": "unverified",
  "UNSIGNED signature not heard": "unsigned",
  "UNSIGNED beacon restarted": "unsigned",
  "REPLAY REJECTED": "replay",
  "CONFLICT REJECTED": "conflict",
}

// How long entities live. A live position is only useful during and just after a
// flight; the run record lasts longer so the map can still list the session.
export const PACKET_DAYS = 7
export const RUN_DAYS = 30
