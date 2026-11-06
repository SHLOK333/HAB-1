#!/usr/bin/env node
// Put one payload episode log on 0G Storage and record its root in EpisodeRegistry on 0G Chain.
//
// The log is copied from the Pi (~/ethglobal/episodes/<run>.jsonl). Each line is one
// decision: checkpoint, inputs, 0G model, request id, action taken, and the Pi's Ed25519
// signature. Uploads are snapshots: run it again later and a new root is recorded.
//
//   node --env-file=../.env upload.mjs <run>
//   ZG_EPISODE_DIR=~/ethglobal/episodes node --env-file=.env upload.mjs <run>
//        on the Pi itself: read the log from that folder instead of fetching it over ssh
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Indexer, ZgFile } from "@0gfoundation/0g-storage-ts-sdk"
import { ethers } from "ethers"

const here = path.dirname(new URL(import.meta.url).pathname)
const run = process.argv[2]
if (!run) throw new Error("usage: upload.mjs <run>")
const RPC = process.env.ZG_EVM_RPC || "https://evmrpc-testnet.0g.ai"
const INDEXER = process.env.ZG_INDEXER_RPC || "https://indexer-storage-testnet-turbo.0g.ai"

// 1. the episode log: from ZG_EPISODE_DIR when running on the Pi, else fetched from the Pi
let local
if (process.env.ZG_EPISODE_DIR) {
  local = path.join(process.env.ZG_EPISODE_DIR.replace(/^~/, process.env.HOME), `${run}.jsonl`)
} else {
  local = path.join(here, "episodes", `${run}.jsonl`)
  fs.mkdirSync(path.dirname(local), { recursive: true })
  execFileSync(path.join(here, "..", "tools", "pi.sh"), [`cat ~/ethglobal/episodes/${run}.jsonl`], { stdio: ["ignore", fs.openSync(local, "w"), "inherit"] })
}
// The file is uploaded byte for byte as the Pi wrote it. A power cut can leave a run of zero
// bytes where unsynced records were (seen 6 Nov 2026); those records are lost, the rest are
// each signed on their own, so they are counted around the gap and the gap is reported.
const text = fs.readFileSync(local, "utf8"), zeros = (text.match(/\0/g) || []).length
const recs = text.replace(/\0+/g, "\n").split("\n").filter(l => l.trim()).map(l => JSON.parse(l))
if (zeros) console.log(`episode ${run}: ${zeros} zero bytes from a power cut (records lost there), kept as written`)
const safeStops = recs.filter(r => r.safe_stop).length
const withId = recs.filter(r => r.request_id || r.response_id).length
console.log(`episode ${run}: ${recs.length} decisions, ${safeStops} safe stops, ${withId} with a 0G request id, ${fs.statSync(local).size} bytes`)

// 2. upload to 0G Storage
const provider = new ethers.JsonRpcProvider(RPC)
const signer = new ethers.Wallet(process.env.ZG_PRIVATE_KEY, provider)
const file = await ZgFile.fromFilePath(local)
const [tree, treeErr] = await file.merkleTree()
if (treeErr) throw treeErr
const root = tree.rootHash()
const t0 = Date.now()
const [tx, upErr] = await new Indexer(INDEXER).upload(file, RPC, signer)
await file.close()
if (upErr) throw upErr
console.log(`0G Storage: root ${root}  tx ${tx.txHash ?? tx.txHashes}  ${Date.now() - t0} ms`)

// 3. record the root on chain
const abi = JSON.parse(fs.readFileSync(path.join(here, "EpisodeRegistry.abi.json"), "utf8"))
const reg = new ethers.Contract(process.env.ZG_REGISTRY_ADDRESS, abi, signer)
const rc = await (await reg.record(run, root, recs.length, safeStops)).wait()
const n = await reg.count(run)
console.log(`EpisodeRegistry ${process.env.ZG_REGISTRY_ADDRESS}: recorded #${n - 1n} for ${run}  tx ${rc.hash}  block ${rc.blockNumber}`)
console.log(`https://chainscan-galileo.0g.ai/tx/${rc.hash}`)
console.log(`https://storagescan-galileo.0g.ai/  (search the root hash)`)

fs.appendFileSync(path.join(here, "uploads.jsonl"), JSON.stringify({ run, root, storage_tx: tx.txHash ?? tx.txHashes, registry_tx: rc.hash,
  decisions: recs.length, safe_stops: safeStops, at: new Date().toISOString() }) + "\n")
