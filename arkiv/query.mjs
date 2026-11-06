#!/usr/bin/env node
// Read back what is on Arkiv, with no key and no backend: the same query the map runs.
//
//   node query.mjs                 # list runs, then the packets of the newest one
//   node query.mjs <run>           # packets of one run
import { createPublicClient } from "@arkiv-network/sdk"
import { rabdi } from "@arkiv-network/sdk/chains"
import { asc, desc, eq } from "@arkiv-network/sdk/query"
import { http } from "viem"
import { FLIGHT, Packet, Run } from "./schema.mjs"

const client = createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }), transport: http() })
// Only this deployment's receivers: the ground station and the two simulated receivers.
import { privateKeyToAccount } from "viem/accounts"
const OWNERS = ["ARKIV_GROUND_PRIVATE_KEY", "ARKIV_SIM_RX1_PRIVATE_KEY", "ARKIV_SIM_RX2_PRIVATE_KEY"].filter(k => process.env[k]).map(k => privateKeyToAccount(process.env[k]).address.toLowerCase())
const mine = e => !OWNERS.length || OWNERS.includes(String(e.$owner).toLowerCase())

const runsAll = await client.select({ $key: true, $owner: true, run: true, startedAt: true, receiver: true })
  .from(Run).where(eq("flight", FLIGHT)).orderBy(desc("startedAt")).limit(50).fetch()
const runs = { entities: runsAll.entities.filter(mine) }
console.log(`runs of ${FLIGHT}: ${runs.entities.length}`)
for (const r of runs.entities) console.log(`  ${r.run.value}  started ${new Date(Number(r.startedAt.value) * 1000).toISOString()}  by ${r.receiver.value} ${r.$owner}`)

const run = process.argv[2] ?? runs.entities[0]?.run.value
if (!run) process.exit(0)
const rows = []
for (let off = 0; ; off += 100) {
  const page = await client.select({ $key: true, $owner: true, seq: true, flightS: true, altM: true, lat: true, lon: true, verdict: true, rssi: true })
    .from(Packet).where(eq("run", run)).orderBy(asc("seq")).limit(100).offset(off).fetch()
  rows.push(...page.entities.filter(mine))
  if (page.entities.length < 100) break
}
console.log(`packets in ${run}: ${rows.length}`)
for (const p of rows) console.log(`  seq ${String(p.seq.value).padStart(4)}  T${(p.flightS.value / 60).toFixed(1).padStart(6)} min  ${String(p.altM.value).padStart(5)} m  ${p.lat.value},${p.lon.value}  ${p.verdict.value.padEnd(13)}  rssi ${p.rssi.value}  ${p.$key}`)
