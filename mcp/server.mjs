#!/usr/bin/env node
// HAB-1 flight data over MCP: read from Arkiv, checked on your own machine.
//
// This server holds no keys and calls no server of ours. It reads the public Arkiv chain
// (Rabdi testnet, chain 7794095) directly, and redoes the ground station's signature check
// from the raw radio bytes stored there (verify.mjs). So you do not trust us, or any receiver:
// you trust the beacon's public key. Pass your own copy as beacon_key (the beacon prints it
// with its "pubkey" command), or set HAB1_BEACON_KEY; the default is the key pinned in this
// repo (ground/beacon_pubkey.hex).
//
// Flight frames are checked. Mission data (winds, landing predictions, 0G analyses) are our
// analyses: nothing signs them in flight, so they are read from the HAB-1 ground-station
// wallet by default, and say so.
//
//   claude mcp add hab1 -- node /path/to/HAB-1/mcp/server.mjs
//   ARKIV_ACCESS_KEY=<your own free key, hub.arkiv.network>  raises Arkiv's public rate limit (optional)
//
// stdout carries the MCP protocol, so anything a library logs goes to stderr.
console.log = console.info = console.warn = console.error

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createPublicClient } from "@arkiv-network/sdk"
import { rabdi } from "@arkiv-network/sdk/chains"
import { and, asc, desc, eq, gte, lte } from "@arkiv-network/sdk/query"
import { dec, i32 } from "@arkiv-network/sdk/schema"
import { http } from "viem"
import { z } from "zod"
import { DATASET, FLIGHT, Insight, Packet, Prediction, Run, Sig, Wind } from "./schemas.mjs"
import { check, decodeData, decodeSig, edKey, hexBuf, signatureValid } from "./verify.mjs"

const PINNED_KEY = process.env.HAB1_BEACON_KEY ?? "f7bf12e3c6b832c7daec9d7b21474d129183b2c7d1e0aafc1c223395c2d6d4e3"
const GROUND = "0x532cCE61F117A394D595E9fb7069f4D6CE3Bb047"   // the HAB-1 ground station's Arkiv wallet
const client = createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }), transport: http() })

// ---------------------------------------------------------------- Arkiv reads
const plain = x => (x && typeof x === "object" && "value" in x ? x.value : x)
const num = x => (x == null ? null : Number(plain(x)))
const row = e => Object.fromEntries(Object.entries(e).map(([k, x]) => [k === "$owner" ? "owner" : k === "$key" ? "key" : k, plain(x)]))
async function all(build, cap = 3000) {
  const out = []
  for (let o = 0; o < cap; o += 100) {
    const p = await build().limit(100).offset(o).fetch()
    out.push(...p.entities.map(row))
    if (p.entities.length < 100) break
  }
  return out
}
const owned = (q, owner) => (owner && owner !== "any" ? q.ownedBy(owner) : q)

async function sessions(limit = 10, receiver) {
  const r = await owned(client.select({ run: true, startedAt: true, beaconKey: true, receiver: true, note: true, $owner: true, $key: true })
    .from(Run).where(eq("flight", FLIGHT)), receiver).orderBy(desc("startedAt")).limit(limit).fetch()
  return r.entities.map(row).map(s => ({ ...s, startedAt: new Date(Number(s.startedAt) * 1000).toISOString() }))
}
async function resolveRun(run, receiver) {
  if (run) return run
  const [newest] = await sessions(1, receiver)
  if (!newest) throw new Error("no sessions on Arkiv")
  return newest.run
}

async function checkRun(run, keyHex, receiver) {
  const where = and(eq("flight", FLIGHT), eq("run", run))
  const [packets, sigs] = await Promise.all([
    all(() => owned(client.select({ seq: true, verdict: true, frame: true, rssi: true, snr: true, $owner: true, $key: true }).from(Packet).where(where), receiver).orderBy(asc("seq"))),
    all(() => owned(client.select({ frame: true, valid: true, $owner: true, $key: true }).from(Sig).where(where), receiver).orderBy(asc("firstSeq"))),
  ])
  if (!packets.length) throw new Error(`no frames on Arkiv for session ${run}${receiver ? ` from ${receiver}` : ""} (frames expire 7 days after they are written)`)
  const r = check(packets, sigs, keyHex)
  // time order: (boot, seq) for frames the signature places; the rest keep their seq order
  r.frames.sort((a, b) => ((a.boot ?? -1) - (b.boot ?? -1)) || (num(a.seq) - num(b.seq)))
  return { run, ...r }
}

const count = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {})
const point = f => ({ seq: num(f.seq), boot: f.boot, flightS: f.decoded?.flightS, lat: f.decoded?.lat, lon: f.decoded?.lon, altM: f.decoded?.altM,
  yourCheck: f.check, receiverSaid: f.verdict, receiver: f.owner, entity: f.key })

function summary(r, keyHex) {
  const frames = r.frames, receivers = [...new Set(frames.map(f => f.owner))]
  const vouchedWrongly = frames.filter(f => f.verdict === "verified" && f.check !== "verified")
  const rejectedWrongly = frames.filter(f => ["fake", "conflict", "bad_signature"].includes(f.verdict) && f.check === "verified")
  return {
    session: r.run,
    trustedKey: keyHex,
    receivers: receivers.map(a => (a === GROUND ? `${a} (HAB-1 ground station)` : a)),
    signatureFrames: { onArkiv: r.batches.length, validUnderYourKey: r.batches.filter(b => b.valid).length,
      invalid: r.batches.filter(b => !b.valid).length, boots: [...new Set(r.batches.filter(b => b.valid).map(b => b.boot))].sort((x, y) => x - y) },
    frames: { onArkiv: frames.length, ...count(frames, f => f.check) },
    receiverVerdicts: count(frames, f => f.verdict),
    disagreements: {
      vouchedForButNotSigned: vouchedWrongly.map(point),
      rejectedButSigned: rejectedWrongly.map(point),
      note: "Empty lists mean every receiver's published verdict holds up under your own check.",
    },
    keyIdMismatches: frames.filter(f => f.decoded && !f.keyIdMatches).length,
  }
}

// ---------------------------------------------------------------- MCP
const server = new McpServer({ name: "hab1-arkiv", version: "1.0.0" }, {
  instructions: "HAB-1 is a high-altitude balloon whose beacon signs its telemetry. These tools read the flight from the public Arkiv chain and re-check the beacon's Ed25519 signatures locally, so answers do not depend on trusting the HAB-1 team or any receiver. Prefer yourCheck over receiverSaid. Positions come from the signed raw bytes, not from the receiver's index attributes.",
})
const json = o => ({ content: [{ type: "text", text: JSON.stringify(o, (_, x) => (typeof x === "bigint" ? String(x) : x), 1) }] })
const tool = (name, meta, fn) => server.registerTool(name, { ...meta, annotations: { readOnlyHint: true, openWorldHint: true } }, async args => {
  try { return json(await fn(args)) } catch (e) { return { isError: true, content: [{ type: "text", text: `${name} failed: ${e.shortMessage ?? e.message}` }] } }
})
const keyArg = z.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe("The beacon's Ed25519 public key (64 hex characters) to check signatures with. Default: the key pinned in the HAB-1 repo.")
const runArg = z.string().optional().describe("Session name, e.g. live-11062318. Default: the newest session.")
const receiverArg = z.string().optional().describe("Only data written by this receiver wallet (0x...). Default: every receiver.")

tool("list_sessions", {
  title: "List flight sessions",
  description: "Sessions (replays of the HAB-1 flight through the radios) recorded on Arkiv, newest first, with who recorded them.",
  inputSchema: { limit: z.number().int().min(1).max(50).optional(), receiver: receiverArg },
}, async ({ limit = 10, receiver }) => ({ flight: FLIGHT, sessions: await sessions(limit, receiver) }))

tool("verify_session", {
  title: "Verify a session yourself",
  description: "Re-checks every frame of a session from the raw radio bytes on Arkiv: each signature frame's Ed25519 signature with the beacon's key, then each data frame's salted hash. Reports what you can prove, and any receiver whose published verdict does not hold up.",
  inputSchema: { run: runArg, beacon_key: keyArg, receiver: receiverArg },
}, async ({ run, beacon_key = PINNED_KEY, receiver }) => {
  const r = await checkRun(await resolveRun(run, receiver), beacon_key, receiver)
  return {
    ...summary(r, beacon_key),
    signatureFrameList: r.batches.map(b => ({ boot: b.boot, frames: `${b.firstSeq}..${b.firstSeq + b.count - 1}`, signature: b.valid ? "valid" : "INVALID", receiverSaid: b.receiverSaid })),
    forgedOrUnprovable: r.frames.filter(f => f.check !== "verified").map(point),
    howToRead: "verified: a signature from the beacon's key covers this exact frame. not in the signed batch: a signature covers this seq but not these bytes: a forged frame, or, when the receiver said unsigned, a frame from an earlier boot whose own signature frame was never heard. no signature frame on Arkiv: nothing to check it against.",
  }
})

tool("get_track", {
  title: "Get the flight track",
  description: "The flight path of a session, in time order, using only frames you verified yourself (positions decoded from the signed bytes).",
  inputSchema: { run: runArg, beacon_key: keyArg, receiver: receiverArg, include_unverified: z.boolean().optional(), max_points: z.number().int().min(10).max(2000).optional() },
}, async ({ run, beacon_key = PINNED_KEY, receiver, include_unverified = false, max_points = 300 }) => {
  const r = await checkRun(await resolveRun(run, receiver), beacon_key, receiver)
  let pts = r.frames.filter(f => include_unverified ? f.decoded : f.check === "verified")
  // one point per (boot, seq): several receivers may have heard the same frame
  const seen = new Set(); pts = pts.filter(f => { const k = `${f.boot}:${f.seq}:${f.frame}`; return !seen.has(k) && seen.add(k) })
  if (pts.length > max_points) { const step = pts.length / max_points; pts = Array.from({ length: max_points }, (_, i) => pts[Math.floor(i * step)]).concat(pts.at(-1)) }
  const s = summary(r, beacon_key)
  return { session: r.run, frames: s.frames, signatureFrames: s.signatureFrames, points: pts.map(point) }
})

tool("latest_position", {
  title: "Latest verified position",
  description: "The newest position in a session that a valid beacon signature covers, with a map link.",
  inputSchema: { run: runArg, beacon_key: keyArg, receiver: receiverArg },
}, async ({ run, beacon_key = PINNED_KEY, receiver }) => {
  const r = await checkRun(await resolveRun(run, receiver), beacon_key, receiver)
  const v = r.frames.filter(f => f.check === "verified"), f = v.at(-1)
  if (!f) return { session: r.run, position: null, why: "no frame in this session is covered by a valid signature yet", frames: summary(r, beacon_key).frames }
  const d = f.decoded
  return { session: r.run, position: { lat: d.lat, lon: d.lon, altM: d.altM, flightTime: `T${d.flightS >= 0 ? "+" : ""}${(d.flightS / 60).toFixed(1)} min`, seq: d.seq, boot: f.boot,
    outsidePressureHpa: d.liveHpa ?? d.pressureHpa, outsideTempC: d.liveC ?? d.tempC, map: `https://www.openstreetmap.org/?mlat=${d.lat}&mlon=${d.lon}#map=11/${d.lat}/${d.lon}` },
    proof: `frame seq ${d.seq} (boot ${f.boot}) matches a hash in a signature frame that verifies under ${beacon_key.slice(0, 8)}…`, verifiedFrames: v.length }
})

tool("query_packets", {
  title: "Query frames by attribute",
  description: "Arkiv attribute query over received frames (altitude, area, verdict, receiver). Returns the raw frame bytes too. Attributes are the receiver's index, not proof: run verify_session to check the bytes.",
  inputSchema: {
    run: z.string().optional().describe("Session name; default: all sessions"), verdict: z.enum(["verified", "fake", "bad_signature", "unverified", "replay", "conflict", "unsigned"]).optional(),
    min_alt_m: z.number().int().optional(), max_alt_m: z.number().int().optional(),
    lat_min: z.number().optional(), lat_max: z.number().optional(), lon_min: z.number().optional(), lon_max: z.number().optional(),
    receiver: receiverArg, limit: z.number().int().min(1).max(500).optional(),
  },
}, async a => {
  const f = [eq("flight", FLIGHT)], q = [`flight = ${FLIGHT}`]
  const add = (cond, text) => { f.push(cond); q.push(text) }
  if (a.run) add(eq("run", a.run), `run = ${a.run}`)
  if (a.verdict) add(eq("verdict", a.verdict), `verdict = ${a.verdict}`)
  if (a.min_alt_m != null) add(gte("altM", i32(a.min_alt_m)), `altM >= ${a.min_alt_m}`)
  if (a.max_alt_m != null) add(lte("altM", i32(a.max_alt_m)), `altM <= ${a.max_alt_m}`)
  if (a.lat_min != null) add(gte("lat", dec(String(a.lat_min))), `lat >= ${a.lat_min}`)
  if (a.lat_max != null) add(lte("lat", dec(String(a.lat_max))), `lat <= ${a.lat_max}`)
  if (a.lon_min != null) add(gte("lon", dec(String(a.lon_min))), `lon >= ${a.lon_min}`)
  if (a.lon_max != null) add(lte("lon", dec(String(a.lon_max))), `lon <= ${a.lon_max}`)
  const limit = a.limit ?? 50
  const rows = await all(() => owned(client.select({ run: true, seq: true, flightS: true, lat: true, lon: true, altM: true, verdict: true, receiver: true, frame: true, $owner: true, $key: true })
    .from(Packet).where(and(...f)), a.receiver).orderBy(desc("altM")), limit)
  return { arkivQuery: `Packet where ${q.join(" and ")}${a.receiver ? ` owned by ${a.receiver}` : ""}`, returned: Math.min(rows.length, limit),
    rows: rows.slice(0, limit).map(r => ({ run: r.run, seq: num(r.seq), flightS: num(r.flightS), lat: num(r.lat), lon: num(r.lon), altM: num(r.altM), receiverSaid: r.verdict, receiver: r.owner, frame: r.frame, entity: r.key })) }
})

tool("get_winds", {
  title: "Winds by altitude",
  description: "Winds the balloon measured (its drift between fixes) and the GFS model's winds, by altitude. Our analysis, read from the HAB-1 ground-station wallet unless you name another owner.",
  inputSchema: { source: z.enum(["measured", "gfs"]).optional(), min_alt_m: z.number().int().optional(), max_alt_m: z.number().int().optional(), owner: z.string().optional().describe("Owner wallet, or \"any\". Default: the HAB-1 ground station.") },
}, async ({ source, min_alt_m, max_alt_m, owner = GROUND }) => {
  const f = [eq("flight", FLIGHT), eq("dataset", DATASET)]
  if (source) f.push(eq("source", source))
  if (min_alt_m != null) f.push(gte("altM", i32(min_alt_m)))
  if (max_alt_m != null) f.push(lte("altM", i32(max_alt_m)))
  const rows = await all(() => owned(client.select({ source: true, phase: true, altM: true, flightS: true, speedMs: true, towardDeg: true }).from(Wind).where(and(...f)), owner).orderBy(asc("altM")))
  return { owner, winds: rows.map(r => ({ source: r.source, phase: r.phase, altM: num(r.altM), flightS: num(r.flightS), speedMs: num(r.speedMs), towardDeg: num(r.towardDeg) })) }
})

tool("get_landing_predictions", {
  title: "Landing predictions",
  description: "Where the models said the balloon would land: hindcast, in-flight (re-run as measured winds came in) or forecast, with the error from the real landing. Our analysis, read from the HAB-1 ground-station wallet unless you name another owner.",
  inputSchema: { kind: z.enum(["hindcast", "inflight", "forecast"]).optional(), max_error_km: z.number().optional(), owner: z.string().optional() },
}, async ({ kind, max_error_km, owner = GROUND }) => {
  const f = [eq("flight", FLIGHT), eq("dataset", DATASET)]
  if (kind) f.push(eq("kind", kind))
  if (max_error_km != null) f.push(lte("errorKm", dec(String(max_error_km))), gte("errorKm", dec("0")))
  const rows = await all(() => owned(client.select({ kind: true, model: true, fromFlightS: true, fromAltM: true, landLat: true, landLon: true, errorKm: true, windBands: true }).from(Prediction).where(and(...f)), owner).orderBy(asc("fromFlightS")))
  return { owner, predictions: rows.map(r => ({ kind: r.kind, model: r.model, madeAtFlightS: num(r.fromFlightS), madeAtAltM: num(r.fromAltM), landLat: num(r.landLat), landLon: num(r.landLon), errorKm: num(r.errorKm), measuredWindBands: num(r.windBands) })) }
})

tool("get_ai_insights", {
  title: "0G AI analyses",
  description: "Analyses a 0G model wrote from Arkiv data, with the Arkiv query it read, the model, whether 0G lists it as TEE-attested, the 0G request id, and the verdict of a second 0G model (Vela) that marks unsupported claims.",
  inputSchema: { topic: z.string().optional().describe("e.g. jet-stream, landing-error, verification"), guard_verdict: z.enum(["supported", "flagged"]).optional(), limit: z.number().int().min(1).max(50).optional(), owner: z.string().optional() },
}, async ({ topic, guard_verdict, limit = 10, owner = GROUND }) => {
  const f = [eq("flight", FLIGHT), eq("dataset", DATASET)]
  if (topic) f.push(eq("topic", topic))
  if (guard_verdict) f.push(eq("guardVerdict", guard_verdict))
  const r = await owned(client.select({ topic: true, model: true, teeAttested: true, requestId: true, createdAt: true, headline: true, query: true, body: true, guardModel: true, guardVerdict: true, guardRequestId: true, $key: true })
    .from(Insight).where(and(...f)), owner).orderBy(desc("createdAt")).limit(limit).fetch()
  return { owner, insights: r.entities.map(row).map(i => {
    let body = {}; try { body = JSON.parse(hexBuf(i.body).toString()) } catch {}
    return { topic: i.topic, headline: i.headline, findings: body.findings ?? [], anomalies: body.anomalies ?? [], model: i.model, teeAttested: i.teeAttested === "true", zeroGRequestId: i.requestId,
      claimCheck: { model: i.guardModel, verdict: i.guardVerdict, requestId: i.guardRequestId, flagged: body.guard?.flagged ?? [] },
      readFromArkiv: hexBuf(i.query).toString(), inputs: body.inputs ?? [], createdAt: new Date(Number(i.createdAt) * 1000).toISOString(), entity: i.key }
  }) }
})

tool("decode_frame", {
  title: "Decode a radio frame",
  description: "Decodes a HAB-1 data frame (28 bytes) or signature frame (100 bytes) from hex, and checks a signature frame's signature with the beacon's key.",
  inputSchema: { hex: z.string().describe("Frame bytes as hex, with or without 0x"), beacon_key: keyArg },
}, async ({ hex, beacon_key = PINNED_KEY }) => {
  const b = hexBuf(hex), d = decodeData(b)
  if (d) return { type: "data", bytes: b.length, ...d }
  const s = decodeSig(b)
  if (s) return { type: "signature", bytes: b.length, firstSeq: s.firstSeq, covers: `${s.firstSeq}..${s.firstSeq + s.count - 1}`, boot: s.boot, salt: s.salt.toString("hex"),
    hashes: s.hashes.map(h => h.toString("hex")), signature: s.signature.toString("hex"), validUnder: beacon_key, valid: signatureValid(s, edKey(beacon_key)) }
  throw new Error(`not a HAB-1 frame: ${b.length} bytes, first byte 0x${b[0]?.toString(16) ?? "??"} (data frames are 28 bytes starting b2, signature frames 100 bytes starting b3)`)
})

await server.connect(new StdioServerTransport())
