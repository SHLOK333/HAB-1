#!/usr/bin/env node
// x402 over the radio, the ground station's part. Two nodes run the x402 exchange over
// LoRa (frames.h): the buyer asks (REQ), the beacon answers "402 Payment Required" (OFFER),
// the buyer's board builds and signs a real Hedera transfer for it (PAY). This script
// takes that payment from the verifier log, rebuilds the signed transaction byte for byte,
// has an x402 facilitator verify and settle it on Hedera, and only then tells the beacon
// (SETTLED, signed with the ground station's key), which releases the wind it sold.
//
//   node --env-file=../.env radio_x402.mjs --setup   once: ground station key, fee payer, beacon config
//   node --env-file=../.env radio_x402.mjs           one purchase, start to finish (verifier running)
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { HTTPFacilitatorClient } from "@x402/core/server"
import { AccountId, Client, PrivateKey, Transaction, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk"
import { signedTransaction, transferBody } from "./hedera_body.mjs"

const here = path.dirname(new URL(import.meta.url).pathname)
const root = path.join(here, "..")
const envPath = path.join(root, ".env")
const CMDS = path.join(root, "ground", "state", "ground_cmds")
const LOG_DIR = path.join(root, "ground", "log")
const FACILITATOR = process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator"
const MERCHANT = process.env.HEDERA_MERCHANT_ACCOUNT_ID
const BUYER = process.env.HEDERA_SATB_ACCOUNT_ID
const num = (id) => Number(id.split(".")[2])
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex")

function setEnv(key, value) {
  let t = fs.readFileSync(envPath, "utf8")
  const re = new RegExp(`^${key}=.*$`, "m")
  t = re.test(t) ? t.replace(re, `${key}=${value}`) : t + `\n${key}=${value}\n`
  fs.writeFileSync(envPath, t, { mode: 0o600 })
}
const stationKey = (seedHex) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" })
const rawPub = (key) => crypto.createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32)
const beacon = (cmd) => execFileSync(path.join(root, ".venv", "bin", "python"), [path.join(root, "ground", "cmd.py"), "beacon", ...cmd.split(" ")], { encoding: "utf8" }).trim()
const toGround = (...lines) => fs.appendFileSync(CMDS, lines.map(l => l + "\n").join(""))
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR })

async function feePayer() {
  const s = await facilitator.getSupported()
  const k = s.kinds.find(k => k.network === "hedera:testnet" && k.scheme === "exact")
  if (!k?.extra?.feePayer) throw new Error(`${FACILITATOR} does not offer exact on hedera:testnet`)
  return k.extra.feePayer
}

if (process.argv.includes("--setup")) {
  let seed = process.env.GROUND_STATION_ED25519_SEED
  if (!seed) { seed = crypto.randomBytes(32).toString("hex"); setEnv("GROUND_STATION_ED25519_SEED", seed); console.log("ground station key: new, saved in .env") }
  const pub = rawPub(stationKey(seed)).toString("hex")
  const fp = await feePayer()
  console.log(`facilitator ${FACILITATOR}, fee payer ${fp}`)
  console.log(beacon(`station ${pub}`))
  console.log(beacon(`feepayer ${num(fp)}`))
  process.exit(0)
}

// ------------------------------------------------------------------ one purchase
if (!process.env.GROUND_STATION_ED25519_SEED) throw new Error("run with --setup first")
const key = stationKey(process.env.GROUND_STATION_ED25519_SEED)
const log = path.join(LOG_DIR, fs.readdirSync(LOG_DIR).filter(n => n.startsWith("verifier-")).sort().at(-1))
let offset = fs.statSync(log).size
const t0 = Date.now()
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`

toGround(`clock ${Math.floor(Date.now() / 1000)}`, `x402policy 2000000 5000000 ${num(MERCHANT)}`, `x402req ${num(BUYER)}`)
console.log(`asked the buyer board for wind: REQ goes out in the next uplink window (log ${path.basename(log)})`)

function* newEvents() {
  const size = fs.statSync(log).size
  if (size <= offset) return
  const fd = fs.openSync(log, "r"), buf = Buffer.alloc(size - offset)
  fs.readSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd)
  const text = buf.toString(), last = text.lastIndexOf("\n")
  offset += Buffer.byteLength(text.slice(0, last + 1))
  for (const l of text.slice(0, last + 1).split("\n")) { try { yield JSON.parse(l) } catch {} }
}

async function settle(p) {
  const challenge = parseInt(p.challenge, 16)
  const body = transferBody({ feePayer: p.fee_payer, validS: p.valid_s, validNs: p.valid_ns, payer: p.payer, payTo: p.pay_to, amount: p.amount, challenge })
  if (body.toString("hex") !== p.body) throw new Error("the board's transaction body differs from ours")
  const txBytes = signedTransaction(body, Buffer.from(p.pubkey, "hex"), Buffer.from(p.sig, "hex"))
  const tx = Transaction.fromBytes(txBytes)
  const requirements = { scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount: String(p.amount),
                         payTo: `0.0.${p.pay_to}`, maxTimeoutSeconds: p.timeout, extra: { feePayer: `0.0.${p.fee_payer}` } }
  const payload = { x402Version: 2, accepted: requirements, payload: { transaction: txBytes.toString("base64") } }
  console.log(`${elapsed()}  PAY heard on the air: ${p.amount} tinybar 0.0.${p.payer} -> 0.0.${p.pay_to}, tx ${tx.transactionId}, memo "${tx.transactionMemo}"`)
  const v = await facilitator.verify(payload, requirements)
  console.log(`${elapsed()}  facilitator verify: ${v.isValid ? "valid" : `INVALID ${v.invalidReason} ${v.invalidMessage ?? ""}`}`)
  if (!v.isValid) return null
  const s = await facilitator.settle(payload, requirements)
  console.log(`${elapsed()}  facilitator settle: ${s.success ? `SETTLED tx ${s.transaction}` : `FAILED ${s.errorReason} ${s.errorMessage ?? ""}`}`)
  if (!s.success) return null
  // SETTLED: magic, seq (the board fills it), challenge, result 0, signature over tag + bytes 5..9
  const f = Buffer.alloc(74); f[0] = 0xd5; f.writeUInt32LE(challenge, 5); f[9] = 0
  crypto.sign(null, Buffer.concat([Buffer.from("hab-settled-v1"), f.subarray(5, 10)]), key).copy(f, 10)
  toGround(`send ${f.toString("hex")}`)
  console.log(`${elapsed()}  SETTLED queued for the beacon, signed by the ground station`)
  if (process.env.HEDERA_AUDIT_TOPIC_ID) {
    const m = Client.forTestnet().setOperator(AccountId.fromString(MERCHANT), PrivateKey.fromStringECDSA(process.env.HEDERA_MERCHANT_PRIVATE_KEY))
    const r = await new TopicMessageSubmitTransaction().setTopicId(process.env.HEDERA_AUDIT_TOPIC_ID).setMessage(JSON.stringify({
      kind: "x402-radio", challenge: p.challenge, payer: `0.0.${p.payer}`, payTo: `0.0.${p.pay_to}`, amount_tinybar: p.amount,
      facilitator: FACILITATOR, tx: s.transaction, signed_on: "buyer board (ESP32)", at: new Date().toISOString() })).execute(m)
    console.log(`${elapsed()}  HCS audit #${Number((await r.getReceipt(m)).topicSequenceNumber)}`)
  }
  return { challenge, tx: s.transaction }
}

// Settle only once the PAY has gone out over the radio (a ground station acts on what it
// hears). Measured: settling as soon as the board signed it queued SETTLED over the PAY
// that was still waiting for a window; the beacon never got the payment and, rightly,
// released nothing, although the buyer had paid.
let done = null, pending = null
const deadline = Date.now() + 150_000
while (Date.now() < deadline) {
  for (const e of newEvents()) {
    if (e.ev === "x402req") console.log(`${elapsed()}  board: request open for 0.0.${e.buyer}`)
    if (e.ev === "sent") console.log(`${elapsed()}  board ${e.ok ? "sent" : "could not send (duty guard; next window)"} ${e.kind.toUpperCase()} after seq ${e.seq}`)
    if (e.ev === "sent" && e.ok && e.kind === "pay" && pending)
      done = await settle(pending).catch(err => { console.log(`settlement error: ${err.message}`); process.exit(1) })
    if (e.ev === "offer") console.log(`${elapsed()}  beacon: 402 Payment Required, ${e.amount} tinybar to 0.0.${e.pay_to}, challenge ${e.challenge}`)
    if (e.ev === "x402refused") { console.log(`${elapsed()}  board REFUSED to pay: ${e.why}`); process.exit(1) }
    if (e.ev === "x402pay") { pending = e; console.log(`${elapsed()}  board signed a PAY for challenge ${e.challenge}; settling once it is on the air`) }
    if (e.ev === "delivery" && done && e.nonce === done.challenge) {
      console.log(`${elapsed()}  DELIVERY from the beacon: wind ${e.speed_ms} m/s toward ${e.toward_deg} deg at ${e.alt_m} m, `
        + `signature ${e.valid ? "VALID" : "INVALID"} (status ${e.status}: ${e.status === 2 ? "paid over x402" : "no fresh wind"})`)
      console.log(`https://hashscan.io/testnet/transaction/${done.tx}`)
      process.exit(0)
    }
  }
  await new Promise(r => setTimeout(r, 500))
}
console.log("no delivery within 150 s"); process.exit(1)
