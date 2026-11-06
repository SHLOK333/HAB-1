#!/usr/bin/env node
// Publish the verifier's verdicts to Arkiv as Packet entities, owned by this receiver.
//
//   node --env-file=../.env publish.mjs                 # follow the newest verifier log
//   node --env-file=../.env publish.mjs --receiver sim1 --log <file> --from-start
//
// Each receiver signs its writes with its own wallet (ARKIV_GROUND_PRIVATE_KEY,
// ARKIV_SIM_RX1_PRIVATE_KEY, ...), so the map can show who heard what.
import fs from "node:fs"
import path from "node:path"
import { createWalletClient, ExpirationTime } from "@arkiv-network/sdk"
import { rabdi } from "@arkiv-network/sdk/chains"
import { bytes, dec, i32, str, u64 } from "@arkiv-network/sdk/schema"
import { http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { FLIGHT, Packet, PACKET_DAYS, Run, RUN_DAYS, VERDICTS } from "./schema.mjs"

const here = path.dirname(new URL(import.meta.url).pathname)
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def }
const receiver = arg("--receiver", "ground")
const keyVar = { ground: "ARKIV_GROUND_PRIVATE_KEY", sim1: "ARKIV_SIM_RX1_PRIVATE_KEY", sim2: "ARKIV_SIM_RX2_PRIVATE_KEY" }[receiver]
if (!keyVar || !process.env[keyVar]) throw new Error(`no private key for receiver ${receiver} in .env`)
const logDir = path.join(here, "..", "ground", "log")
const logFile = arg("--log") ?? path.join(logDir, fs.readdirSync(logDir).filter(f => f.startsWith("verifier-")).sort().at(-1))
const fromStart = process.argv.includes("--from-start")
const runName = arg("--run", "demo-" + new Date().toISOString().slice(0, 16).replace(/[-:]/g, ""))

const account = privateKeyToAccount(process.env[keyVar])
const chain = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" })
const wallet = createWalletClient({ chain, transport: http(), account })
const outLog = path.join(here, "state", "published.jsonl")
fs.mkdirSync(path.dirname(outLog), { recursive: true })

console.log(`receiver ${receiver} ${account.address}\nrun ${runName}\nfollowing ${logFile}${fromStart ? " from the start" : ""}`)

let runCreated = false
async function ensureRun(beaconKey) {
  if (runCreated) return
  const { entityKey, txHash } = await wallet.createEntity(Run, {
    flight: FLIGHT, run: runName, beaconKey, startedAt: u64(Math.floor(Date.now() / 1000)),
    receiver, note: receiver.startsWith("sim")
      ? "SIMULATED receiver: the ground station's verified frames, republished under its own wallet"   // str holds at most 128 bytes
      : "Replay of the HAB-1 flight of 31 Oct 2026 through the flight radios, verified on the ground",
  }, { expiration: ExpirationTime.fromDays(RUN_DAYS) })
  runCreated = true
  console.log(`run entity ${entityKey}  tx ${txHash}`)
}

function toCreate(e) {
  return {
    schema: Packet,
    values: {
      flight: FLIGHT, run: runName, beaconKey: e.beacon_key, seq: u64(e.seq), flightS: i32(e.flight_s),
      lat: dec(e.lat.toFixed(7)), lon: dec(e.lon.toFixed(7)), altM: i32(e.alt_m),
      verdict: VERDICTS[e.verdict] ?? e.verdict, receiver,
      rssi: dec(e.rssi.toFixed(1)), snr: dec(e.snr.toFixed(1)), frame: bytes(Buffer.from(e.hex, "hex")),
      ...(e.live_hpa ? { livePa: dec((e.live_hpa * 100).toFixed(0)), liveC: dec(e.live_c.toFixed(2)) } : {}),
    },
    expiration: ExpirationTime.fromDays(PACKET_DAYS),
  }
}

let queue = [], offset = fromStart ? 0 : fs.statSync(logFile).size, partial = ""
function readNew() {
  const size = fs.statSync(logFile).size
  if (size <= offset) return
  const fd = fs.openSync(logFile, "r"), buf = Buffer.alloc(size - offset)
  fs.readSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd)
  offset = size
  const lines = (partial + buf.toString()).split("\n")
  partial = lines.pop()
  for (const l of lines) {
    try { const e = JSON.parse(l); if (e.ev === "verdict") queue.push(e) } catch {}
  }
}

let busy = false
async function flush() {
  if (busy || queue.length === 0) return
  busy = true
  const batch = queue.splice(0, 20)
  try {
    await ensureRun(batch[0].beacon_key)
    const t0 = Date.now()
    const { txHash, createdEntities } = await wallet.executeBatch({ creates: batch.map(toCreate) })
    const keys = createdEntities ?? []
    batch.forEach((e, i) => {
      const rec = { seq: e.seq, verdict: VERDICTS[e.verdict] ?? e.verdict, entityKey: keys[i], txHash, receiver, run: runName }
      fs.appendFileSync(outLog, JSON.stringify(rec) + "\n")
    })
    console.log(`published ${batch.length}: ${batch.map(e => `${e.seq}:${VERDICTS[e.verdict] ?? e.verdict}`).join(" ")}  tx ${txHash}  ${Date.now() - t0} ms`)
  } catch (err) {
    queue.unshift(...batch)
    console.log(`publish failed, will retry: ${err.shortMessage ?? err.message}`)
  } finally { busy = false }
}

setInterval(readNew, 1000)
setInterval(flush, 4000)
