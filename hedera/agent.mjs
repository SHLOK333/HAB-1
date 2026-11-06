#!/usr/bin/env node
// An agent that buys flight data from the ground station over x402, paying in HBAR on
// Hedera testnet with no human approving each payment.
//
// Spending controls:
//   - per payment: at most MAX_PER_PAYMENT tinybar (x402 spendControls, enforced before signing)
//   - total budget: stops paying once BUDGET tinybar is spent, and says so
//   - merchant allowlist: pays only the ground station's account (x402 policy)
//
//   node --env-file=../.env agent.mjs [alt_m ...]
import { x402Client, x402HTTPClient } from "@x402/core/client"
import { createClientHederaSigner } from "@x402/hedera"
import { ExactHederaScheme } from "@x402/hedera/exact/client"
import { parseKey } from "./keys.mjs"

const BASE = process.env.X402_URL ?? "http://localhost:4402"
const PAYER = process.env.HEDERA_PAYER_ACCOUNT_ID
const MERCHANT = process.env.HEDERA_MERCHANT_ACCOUNT_ID
const MAX_PER_PAYMENT = 2_000_000             // 0.02 HBAR
const BUDGET = Number(process.env.AGENT_BUDGET_TINYBAR ?? 5_000_000)   // 0.05 HBAR
if (!PAYER || !process.env.HEDERA_PRIVATE_KEY) throw new Error("set HEDERA_PAYER_ACCOUNT_ID and HEDERA_PRIVATE_KEY in .env")

const signer = createClientHederaSigner(PAYER, parseKey(process.env.HEDERA_PRIVATE_KEY), { network: "hedera:testnet" })
const core = x402Client.fromConfig({
  schemes: [{ network: "hedera:testnet", client: new ExactHederaScheme(signer) }],
  spendControls: { allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment: String(MAX_PER_PAYMENT) }] },
  policies: [(v, reqs) => reqs.filter(r => r.payTo === MERCHANT)],
})
const client = new x402HTTPClient(core)
let spent = 0

async function buy(path) {
  const url = BASE + path
  const first = await fetch(url)
  if (first.status !== 402) return { status: first.status, body: await first.json() }
  const required = client.getPaymentRequiredResponse(n => first.headers.get(n), await first.json())
  const price = Number(required.accepts?.[0]?.amount ?? 0)
  if (spent + price > BUDGET) {
    return { status: "skipped", body: { reason: `budget: ${spent} of ${BUDGET} tinybar spent, ${price} more would exceed it` } }
  }
  const payload = await client.createPaymentPayload(required)          // spend controls and policies apply here
  const paid = await fetch(url, { headers: client.encodePaymentSignatureHeader(payload) })
  const body = await paid.json()
  if (paid.ok) {
    spent += price
    const s = client.getPaymentSettleResponse(n => paid.headers.get(n))
    body._settlement = s
  }
  return { status: paid.status, body }
}

const alts = process.argv.slice(2).map(Number).filter(Boolean)
for (const alt of alts.length ? alts : [5000, 10000, 15000, 18000, 19000, 3000, 8000]) {
  const t0 = Date.now()
  const r = await buy(`/v1/wind?alt_m=${alt}`)
  const b = r.body
  if (r.status === 200) {
    const tx = b.payment?.tx
    console.log(`wind at ${alt} m: ${b.wind_speed_ms} m/s from ${b.wind_from_deg} deg (band ${b.band_alt_m} m)  paid ${b.payment.amount_tinybar} tinybar`
      + `  tx ${tx}  https://hashscan.io/testnet/transaction/${tx}  ${Date.now() - t0} ms`
      + (b.payment.hcs_audit ? `  hcs #${b.payment.hcs_audit.sequence}` : ""))
    if (process.env.AGENT_SAVE_DIR) {          // keep what was bought, so check_proof.mjs can verify it
      const fs = await import("node:fs")
      fs.mkdirSync(process.env.AGENT_SAVE_DIR, { recursive: true })
      fs.writeFileSync(`${process.env.AGENT_SAVE_DIR}/wind-${alt}.json`, JSON.stringify(b, null, 2))
    }
  } else {
    console.log(`wind at ${alt} m: ${r.status} ${JSON.stringify(b).slice(0, 200)}`)
  }
}
console.log(`spent ${spent} of ${BUDGET} tinybar budget (${spent / 1e8} HBAR)`)
