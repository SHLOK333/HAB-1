#!/usr/bin/env node
// One-time setup for radio sales, before flight, with the verifier stopped (this script
// talks to the ground Heltec over USB):
//   1. a Hedera account for the buyer node ("Sat B") whose key IS the ground Heltec's
//      Ed25519 key, made on the board; the payer funds it
//   2. an HBAR allowance from that account to the merchant (the beacon's payTo). The board
//      signs the approval itself (hsign over USB): its private key never leaves it
//   3. the beacon is told who may buy, whom to pay and the price (over Wi-Fi)
// Writes HEDERA_SATB_ACCOUNT_ID into ../.env.
//
//   node --env-file=../.env radio_setup.mjs [allowance HBAR, default 1]
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { AccountAllowanceApproveTransaction, AccountCreateTransaction, AccountId, Client, Hbar, PublicKey } from "@hiero-ledger/sdk"
import { parseKey } from "./keys.mjs"

const here = path.dirname(new URL(import.meta.url).pathname)
const root = path.join(here, "..")
const envPath = path.join(root, ".env")
const py = path.join(root, ".venv", "bin", "python")
const PRICE = 1_000_000                       // tinybar, the same as the x402 wind price
const ALLOWANCE = Number(process.argv[2] ?? 1)
const MERCHANT = process.env.HEDERA_MERCHANT_ACCOUNT_ID
if (!MERCHANT) throw new Error("run setup.mjs first (no merchant account)")

function setEnv(key, value) {
  let t = fs.readFileSync(envPath, "utf8")
  const re = new RegExp(`^${key}=.*$`, "m")
  t = re.test(t) ? t.replace(re, `${key}=${value}`) : t + `\n${key}=${value}\n`
  fs.writeFileSync(envPath, t, { mode: 0o600 })
}
const heltec = (...args) => execFileSync(py, [path.join(root, "ground", "heltec.py"), ...args], { encoding: "utf8" }).trim()
const beacon = (cmd) => execFileSync(py, [path.join(root, "ground", "cmd.py"), "beacon", ...cmd.split(" ")], { encoding: "utf8" }).trim()
const mirror = async (p) => (await fetch(`https://testnet.mirrornode.hedera.com/api/v1/${p}`)).json()

const pubHex = heltec("pubkey")
const pub = PublicKey.fromBytesED25519(Buffer.from(pubHex, "hex"))
console.log(`buyer node key (made on the ground Heltec): ${pubHex}`)

const payer = Client.forTestnet().setOperator(AccountId.fromString(process.env.HEDERA_PAYER_ACCOUNT_ID), parseKey(process.env.HEDERA_PRIVATE_KEY))
let satB = process.env.HEDERA_SATB_ACCOUNT_ID
if (satB) {
  const a = await mirror(`accounts/${satB}`)
  if (a.key?.key !== pubHex) throw new Error(`${satB} has key ${a.key?.key}, not the board's key: clear HEDERA_SATB_ACCOUNT_ID to make a new account`)
  console.log(`buyer account already set: ${satB} (key matches the board)`)
} else {
  const r = await new AccountCreateTransaction().setKeyWithoutAlias(pub).setInitialBalance(new Hbar(ALLOWANCE + 1)).execute(payer)
  satB = (await r.getReceipt(payer)).accountId.toString()
  setEnv("HEDERA_SATB_ACCOUNT_ID", satB)
  console.log(`buyer account created: ${satB}, ${ALLOWANCE + 1} HBAR from the payer  tx ${r.transactionId}`)
}

// The approval must be signed by the owner, Sat B: the board signs the body bytes.
const tx = new AccountAllowanceApproveTransaction().approveHbarAllowance(satB, MERCHANT, new Hbar(ALLOWANCE))
  .setNodeAccountIds([AccountId.fromString("0.0.3")]).freezeWith(payer)
await tx.signWith(pub, async (body) => Buffer.from(heltec("hsign", Buffer.from(body).toString("hex")), "hex"))
const r = await tx.execute(payer)
await r.getReceipt(payer)
console.log(`allowance: ${satB} lets ${MERCHANT} take up to ${ALLOWANCE} HBAR, signed by the board  tx ${r.transactionId}`)

console.log(beacon(`buyer ${pubHex} ${satB.split(".")[2]}`))
console.log(beacon(`payto ${MERCHANT.split(".")[2]}`))
console.log(beacon(`price ${PRICE}`))
console.log(`https://hashscan.io/testnet/account/${satB}`)
process.exit(0)
