#!/usr/bin/env node
// One-time testnet setup, paid by the payer account you created on portal.hedera.com:
//   1. a merchant account for the ground station (the x402 payTo), with its own ECDSA key
//   2. an HCS topic the merchant writes one message to per settled payment (audit log)
// Writes HEDERA_MERCHANT_ACCOUNT_ID, HEDERA_MERCHANT_PRIVATE_KEY and HEDERA_AUDIT_TOPIC_ID
// into ../.env. Keys are never printed.
//
//   node --env-file=../.env setup.mjs
import fs from "node:fs"
import path from "node:path"
import { parseKey } from "./keys.mjs"
import { AccountCreateTransaction, AccountId, Client, Hbar, PrivateKey, TopicCreateTransaction } from "@hiero-ledger/sdk"

const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env")
const PAYER = process.env.HEDERA_PAYER_ACCOUNT_ID
if (!PAYER || !process.env.HEDERA_PRIVATE_KEY) throw new Error("set HEDERA_PAYER_ACCOUNT_ID and HEDERA_PRIVATE_KEY in .env first")

function setEnv(key, value) {
  let t = fs.readFileSync(envPath, "utf8")
  const re = new RegExp(`^${key}=.*$`, "m")
  t = re.test(t) ? t.replace(re, `${key}=${value}`) : t + `\n${key}=${value}\n`
  fs.writeFileSync(envPath, t, { mode: 0o600 })
}

const payer = Client.forTestnet().setOperator(AccountId.fromString(PAYER), parseKey(process.env.HEDERA_PRIVATE_KEY))
// AccountBalanceQuery is deprecated in SDK 2.90 and always fails: read the mirror node instead.
const acct = await (await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${PAYER}`)).json()
console.log(`payer ${PAYER}: ${acct.balance.balance / 1e8} HBAR${acct.key ? "" : " (hollow account: this setup's first transaction completes it)"}`)

let merchant = process.env.HEDERA_MERCHANT_ACCOUNT_ID
if (!merchant) {
  const key = PrivateKey.generateECDSA()
  const r = await new AccountCreateTransaction().setKeyWithoutAlias(key.publicKey).setInitialBalance(new Hbar(5)).execute(payer)
  merchant = (await r.getReceipt(payer)).accountId.toString()
  setEnv("HEDERA_MERCHANT_ACCOUNT_ID", merchant)
  setEnv("HEDERA_MERCHANT_PRIVATE_KEY", key.toStringRaw())
  console.log(`merchant account created: ${merchant} (5 HBAR from the payer)  tx ${r.transactionId}`)
} else console.log(`merchant account already set: ${merchant}`)

if (!process.env.HEDERA_AUDIT_TOPIC_ID) {
  const mkey = PrivateKey.fromStringECDSA(process.env.HEDERA_MERCHANT_PRIVATE_KEY || fs.readFileSync(envPath, "utf8").match(/^HEDERA_MERCHANT_PRIVATE_KEY=(.*)$/m)[1])
  const m = Client.forTestnet().setOperator(AccountId.fromString(merchant), mkey)
  const r = await new TopicCreateTransaction().setTopicMemo("HAB ground station: x402 payments for flight data")
    .setSubmitKey(mkey.publicKey).execute(m)
  const topic = (await r.getReceipt(m)).topicId.toString()
  setEnv("HEDERA_AUDIT_TOPIC_ID", topic)
  console.log(`audit topic created: ${topic}  https://hashscan.io/testnet/topic/${topic}`)
}
process.exit(0)
