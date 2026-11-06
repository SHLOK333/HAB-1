#!/usr/bin/env node
// Settle radio sales on Hedera once their frames are on the ground. For each voucher the
// buyer node sent (BUY) and the beacon answered (DELIVERY), from the verifier logs:
//   - the voucher's Ed25519 signature must check against the buyer account's key, read
//     from the mirror node, so only the account's own key can have agreed to pay
//   - the delivery must be signed by the pinned beacon key, answer that exact voucher
//     (hash), and carry wind (status 0)
//   - the wind must match a recomputation from the two data frames it names, both
//     VERIFIED: the Pi's on-board arithmetic is checked against the signed track
// Then the merchant takes the price from the buyer's allowance (an approved transfer)
// and writes the voucher, the delivery and the transaction to the HCS audit topic.
//
//   node --env-file=../.env radio_settle.mjs            settle what is waiting, then exit
//   node --env-file=../.env radio_settle.mjs --follow   keep settling as frames arrive
//   node --env-file=../.env radio_settle.mjs --check-only [--logs <dir>]
//        run every check and say what would happen, settle nothing (for anyone auditing a log)
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { AccountId, Client, Hbar, PrivateKey, TopicMessageSubmitTransaction, TransferTransaction } from "@hiero-ledger/sdk"

const here = path.dirname(new URL(import.meta.url).pathname)
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def }
const LOG_DIR = arg("--logs", path.join(here, "..", "ground", "log"))
const CHECK_ONLY = process.argv.includes("--check-only")
const STATE = path.join(here, "state", "radio_settled.jsonl")
const BEACON = fs.readFileSync(path.join(here, "..", "ground", "beacon_pubkey.hex"), "utf8").trim()
const MERCHANT = process.env.HEDERA_MERCHANT_ACCOUNT_ID
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
const edKey = hex => crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, "hex")]), format: "der", type: "spki" })
const merchant = Client.forTestnet().setOperator(AccountId.fromString(MERCHANT), PrivateKey.fromStringECDSA(process.env.HEDERA_MERCHANT_PRIVATE_KEY))
fs.mkdirSync(path.dirname(STATE), { recursive: true })

const settled = new Map()
if (fs.existsSync(STATE)) for (const l of fs.readFileSync(STATE, "utf8").split("\n")) { try { const e = JSON.parse(l); settled.set(`${e.buyer}:${e.nonce}`, e) } catch {} }
const reported = new Set()
const say = (key, text) => { if (!reported.has(key + text)) { reported.add(key + text); console.log(text) } }

// The same wind maths as pi/agent.py and flightdata.mjs.
const rad = d => d * Math.PI / 180
function wind(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  const dist = 2 * 6371000 * Math.asin(Math.sqrt(h))
  const y = Math.sin(dLon) * Math.cos(rad(b.lat))
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon)
  return { speed_ms: dist / (b.flight_s - a.flight_s), toward_deg: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 }
}

const keys = new Map()
async function accountKey(num) {
  if (!keys.has(num)) {
    const a = await (await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.${num}`)).json()
    keys.set(num, a.key?._type === "ED25519" ? a.key.key : null)
  }
  return keys.get(num)
}

// Vouchers, deliveries and verified frames, per beacon boot: seqs restart when the beacon
// reboots, so frames are only matched within the boot (and log) a delivery came in.
function scan() {
  const out = []
  for (const f of fs.readdirSync(LOG_DIR).filter(n => n.startsWith("verifier-")).sort()) {
    let buys = new Map(), deliveries = [], frames = new Map(), lastVerified = -1, lastSeq = -1
    const close = () => { for (const d of deliveries) out.push({ file: f, d, buyHex: buys.get(d.nonce), frames, lastVerified }) }
    for (const line of fs.readFileSync(path.join(LOG_DIR, f), "utf8").split("\n")) {
      let e; try { e = JSON.parse(line) } catch { continue }
      if (e.ev === "data") {
        if (e.seq < lastSeq - 6) { close(); buys = new Map(); deliveries = []; frames = new Map(); lastVerified = -1 }
        lastSeq = e.seq
      }
      if (e.ev === "buy" && e.ok) buys.set(e.nonce, e.hex)
      if (e.ev === "delivery") deliveries.push(e)
      if (e.ev === "verdict" && e.verdict === "VERIFIED") { frames.set(e.seq, e); lastVerified = Math.max(lastVerified, e.seq) }
    }
    close()
  }
  return out
}

// Everything is read from the signed bytes, never from the log's own fields, which anyone
// holding the log could edit.
function decodeDelivery(del) {
  return { nonce: del.readUInt32LE(1), status: del[5], seq_a: del.readUInt32LE(6), seq_b: del.readUInt32LE(10),
           speed_ms: del.readUInt16LE(14) / 100, toward_deg: del.readUInt16LE(16) / 10, alt_m: del.readUInt16LE(18) }
}

async function check({ d: logged, buyHex, frames, lastVerified }) {
  if (logged.status === 2) return { no: "paid over x402 (radio_x402.mjs), nothing to settle here" }
  if (!buyHex) return { no: "no BUY frame in this log for that nonce" }
  const buy = Buffer.from(buyHex, "hex"), del = Buffer.from(logged.hex, "hex")
  const d = decodeDelivery(del)
  const v = { nonce: buy.readUInt32LE(5), product: buy[9], price: buy.readUInt32LE(10), buyer: buy.readUInt32LE(14), seller: buy.readUInt32LE(18) }
  if (d.nonce !== v.nonce) return { v, no: "delivery answers another nonce" }
  let bkey
  try { bkey = await accountKey(v.buyer) } catch (e) { return { v, wait: `mirror node not reachable (${e.cause?.code ?? e.message})` } }
  if (!bkey) return { v, no: `buyer 0.0.${v.buyer} has no Ed25519 key on Hedera` }
  if (!crypto.verify(null, Buffer.concat([Buffer.from("hab-voucher-v1"), buy.subarray(5, 22)]), edKey(bkey), buy.subarray(22, 86)))
    return { v, no: "voucher signature does not match the buyer account's key" }
  if (`0.0.${v.seller}` !== MERCHANT) return { v, no: `voucher pays 0.0.${v.seller}, not us` }
  if (!crypto.verify(null, Buffer.concat([Buffer.from("hab-delivery-v1"), del.subarray(0, 24)]), edKey(BEACON), del.subarray(24, 88)))
    return { v, no: "delivery not signed by the beacon" }
  if (!crypto.createHash("sha256").update(buy).digest().subarray(0, 4).equals(del.subarray(20, 24)))
    return { v, no: "delivery answers a different voucher" }
  if (d.status !== 0) return { v, no: "beacon had no fresh wind: nothing delivered, nothing to charge" }
  const a = frames.get(d.seq_a), b = frames.get(d.seq_b)
  // Two batches later with them still unverified, their signature frame was never heard.
  if ((!a || !b) && lastVerified > d.seq_b + 12) return { v, no: `frames ${d.seq_a},${d.seq_b} were never verified, so the wind cannot be checked: not charged` }
  if (!a || !b) return { v, wait: `frames ${d.seq_a},${d.seq_b} not verified yet` }
  const w = wind(a, b)
  const dDir = Math.abs(((w.toward_deg - d.toward_deg) + 540) % 360 - 180)
  if (Math.abs(w.speed_ms - d.speed_ms) > 0.02 || dDir > 0.2)
    return { v, no: `wind ${d.speed_ms} m/s ${d.toward_deg} deg does not match the signed frames (${w.speed_ms.toFixed(2)} m/s ${w.toward_deg.toFixed(1)} deg)` }
  return { v, d, ok: true, recomputed: { speed_ms: Number(w.speed_ms.toFixed(2)), toward_deg: Number(w.toward_deg.toFixed(1)) } }
}

async function settle(item, c) {
  const { v, d } = c
  const tx = await new TransferTransaction()
    .addApprovedHbarTransfer(AccountId.fromString(`0.0.${v.buyer}`), Hbar.fromTinybars(-v.price))
    .addHbarTransfer(AccountId.fromString(MERCHANT), Hbar.fromTinybars(v.price))
    .setTransactionMemo(`HAB radio voucher ${v.nonce}`).execute(merchant)
  await tx.getReceipt(merchant)
  const entry = { kind: "radio-voucher", nonce: v.nonce, buyer: `0.0.${v.buyer}`, seller: MERCHANT, price_tinybar: v.price,
                  wind: { speed_ms: d.speed_ms, toward_deg: d.toward_deg, alt_m: d.alt_m, frames: [d.seq_a, d.seq_b] },
                  voucher: item.buyHex, delivery: item.d.hex, tx: tx.transactionId.toString(), at: new Date().toISOString() }
  let hcs = null
  if (process.env.HEDERA_AUDIT_TOPIC_ID) {
    const m = await new TopicMessageSubmitTransaction().setTopicId(process.env.HEDERA_AUDIT_TOPIC_ID).setMessage(JSON.stringify(entry)).execute(merchant)
    hcs = { topic: process.env.HEDERA_AUDIT_TOPIC_ID, sequence: Number((await m.getReceipt(merchant)).topicSequenceNumber) }
  }
  const rec = { buyer: v.buyer, nonce: v.nonce, tx: entry.tx, hcs }
  fs.appendFileSync(STATE, JSON.stringify(rec) + "\n")
  settled.set(`${v.buyer}:${v.nonce}`, rec)
  console.log(`SETTLED voucher ${v.nonce}: ${v.price} tinybar from 0.0.${v.buyer} to ${MERCHANT} (allowance)  tx ${entry.tx}`
    + `${hcs ? `  hcs #${hcs.sequence}` : ""}\n  https://hashscan.io/testnet/transaction/${entry.tx}`)
}

async function pass() {
  for (const item of scan()) {
    const n = item.d.nonce
    const c = await check(item)
    const key = `${c.v?.buyer}:${n}`
    if (CHECK_ONLY) {
      console.log(`voucher ${n} (${item.file}): ${c.ok ? `all checks pass, wind recomputed ${c.recomputed.speed_ms} m/s toward ${c.recomputed.toward_deg} deg`
        : c.wait ? `waiting, ${c.wait}` : `would NOT settle, ${c.no}`}${settled.has(key) ? ` (settled earlier: ${settled.get(key).tx})` : ""}`)
      continue
    }
    if (settled.has(key)) { say(key, `voucher ${n}: already settled, tx ${settled.get(key).tx}`); continue }
    if (c.wait) { say(key, `voucher ${n}: waiting, ${c.wait}`); continue }
    if (c.no) { say(key, `voucher ${n}: NOT settled, ${c.no}`); continue }
    console.log(`voucher ${n}: checks pass (buyer signature, beacon signature, wind recomputed from signed frames ${item.d.seq_a},${item.d.seq_b}: `
      + `${c.recomputed.speed_ms} m/s toward ${c.recomputed.toward_deg} deg)`)
    try { await settle(item, c) } catch (e) { console.log(`voucher ${n}: settlement failed, will retry: ${e.message}`) }
  }
}

await pass()
if (process.argv.includes("--follow")) setInterval(pass, 10000)
else process.exit(0)
