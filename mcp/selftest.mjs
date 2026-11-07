#!/usr/bin/env node
// Self-test, offline first, then over MCP against Arkiv.
//   1. verify.mjs on a real batch from 7 Nov 2026 (testvector.json, as the radio heard it): the
//      six genuine frames verify, the forged seq 12 is caught, a flipped signature byte or the
//      wrong key fails.
//   2. starts server.mjs as an MCP client would, lists the tools and calls a few on Arkiv.
//      Skip with --offline.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { check, decodeData, decodeSig } from "./verify.mjs"

const here = path.dirname(new URL(import.meta.url).pathname)
const v = JSON.parse(fs.readFileSync(path.join(here, "testvector.json"), "utf8"))
const ok = s => console.log(`  ok  ${s}`)

console.log("verify.mjs")
const packets = [...v.genuine.map(g => ({ ...g, verdict: "verified", owner: "rx" })), { ...v.fake, verdict: "fake", owner: "rx" }]
let r = check(packets, [{ frame: v.sig, valid: "true", owner: "rx" }], v.beaconKey)
assert.equal(r.batches.length, 1); assert.equal(r.batches[0].valid, true); assert.equal(r.batches[0].boot, v.boot)
ok(`signature frame for seq ${r.batches[0].firstSeq}..${r.batches[0].firstSeq + 5} (boot ${v.boot}) verifies under the beacon key`)
assert.deepEqual(r.frames.slice(0, 6).map(f => f.check), Array(6).fill("verified")); ok("the 6 genuine frames verify")
assert.equal(r.frames[6].check, "not in the signed batch"); ok(`the forged seq 12 (claims ${decodeData(Buffer.from(v.fake.frame, "hex")).altM} m) is caught`)

const bad = Buffer.from(v.sig, "hex"); bad[50] ^= 1
r = check(packets, [{ frame: bad.toString("hex"), owner: "rx" }], v.beaconKey)
assert.equal(r.batches[0].valid, false); assert.ok(r.frames.every(f => f.check === "no signature frame on Arkiv")); ok("one flipped signature bit: nothing verifies")
r = check(packets, [{ frame: v.sig, owner: "rx" }], "11".repeat(32))
assert.equal(r.batches[0].valid, false); ok("another key: nothing verifies")
const salted = Buffer.from(v.sig, "hex"); salted[9] ^= 1   // the salt is signed too
r = check(packets, [{ frame: salted.toString("hex"), owner: "rx" }], v.beaconKey)
assert.equal(r.batches[0].valid, false); ok("a changed salt breaks the signature")
assert.equal(decodeSig(Buffer.alloc(99)), null); assert.equal(decodeData(Buffer.alloc(27)), null); ok("wrong lengths are refused")

if (process.argv.includes("--offline")) process.exit(0)

console.log("\nserver.mjs over MCP (reads Arkiv)")
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js")
const client = new Client({ name: "hab1-selftest", version: "1.0.0" })
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, "server.mjs")], stderr: "ignore" }))
const tools = (await client.listTools()).tools.map(t => t.name)
assert.ok(tools.includes("verify_session")); ok(`${tools.length} tools: ${tools.join(", ")}`)
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args })
  if (res.isError) throw new Error(res.content[0].text)
  return JSON.parse(res.content[0].text)
}
const s = await call("list_sessions", { limit: 3 }); ok(`list_sessions: newest ${s.sessions[0].run}`)
const run = process.argv.find(a => /^[a-z]+-\d/.test(a)) ?? s.sessions[0].run
const vs = await call("verify_session", { run })
ok(`verify_session ${run}: ${vs.signatureFrames.validUnderYourKey}/${vs.signatureFrames.onArkiv} signature frames valid; frames ${JSON.stringify(vs.frames)}`)
ok(`disagreements: ${vs.disagreements.vouchedForButNotSigned.length} vouched-for-but-not-signed, ${vs.disagreements.rejectedButSigned.length} rejected-but-signed`)
const lp = await call("latest_position", { run }); ok(`latest_position: ${lp.position ? `${lp.position.lat}, ${lp.position.lon} at ${lp.position.altM} m (seq ${lp.position.seq}, boot ${lp.position.boot})` : lp.why}`)
const wrongKey = await call("verify_session", { run, beacon_key: "11".repeat(32) })
assert.equal(wrongKey.frames.verified ?? 0, 0); ok("with a different key nothing verifies")
const ins = await call("get_ai_insights", { limit: 3 }); ok(`get_ai_insights: "${ins.insights[0]?.headline}" (${ins.insights[0]?.model}, claim check ${ins.insights[0]?.claimCheck.verdict})`)
await client.close()
