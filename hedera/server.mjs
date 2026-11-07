#!/usr/bin/env node
// The ground station's x402 endpoint on Hedera testnet: flight data, paid per request in HBAR.
//
//   GET /v1/wind?alt_m=15000   0.01 HBAR   wind at that height, with the beacon-signed frames behind it
//   GET /v1/flight/latest      0.005 HBAR  newest verified position, with its signed frame
//   GET /.well-known/x402      free        what is on sale and the prices (also at /), so an agent can find it
//
// The facilitator (Blocky402 by default) verifies the payer's signed transfer, pays the
// network fee and submits it; data is returned only after settlement succeeds. Each
// settlement is also written to an HCS topic as a tamper-evident audit log, if one is set.
//
//   node --env-file=../.env server.mjs
import http from "node:http"
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server"
import { x402HTTPResourceServer } from "@x402/core/http"
import { ExactHederaScheme } from "@x402/hedera/exact/server"
import { AccountId, Client, PrivateKey, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk"
import { latest, wind } from "./flightdata.mjs"

const PORT = Number(process.env.X402_PORT ?? 4402)
const NETWORK = "hedera:testnet"
const PAY_TO = process.env.HEDERA_MERCHANT_ACCOUNT_ID
const FACILITATOR = process.env.X402_FACILITATOR_URL || "https://api.testnet.blocky402.com"
if (!PAY_TO) throw new Error("set HEDERA_MERCHANT_ACCOUNT_ID in .env (run setup.mjs)")

const HBAR = "0.0.0"                         // tinybars: 1 HBAR = 100,000,000
const PRICES = { wind: 1_000_000, latest: 500_000 }

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR })
const resourceServer = new x402ResourceServer(facilitator).register("hedera:*", new ExactHederaScheme())
const routes = {
  "GET /v1/wind": {
    accepts: { scheme: "exact", network: NETWORK, payTo: PAY_TO, price: { amount: String(PRICES.wind), asset: HBAR } },
    description: "Wind at a height over Maharashtra, from a high-altitude balloon's signed track",
    mimeType: "application/json",
  },
  "GET /v1/flight/latest": {
    accepts: { scheme: "exact", network: NETWORK, payTo: PAY_TO, price: { amount: String(PRICES.latest), asset: HBAR } },
    description: "Newest verified position of the balloon, with its signed radio frame",
    mimeType: "application/json",
  },
}
const httpServer = new x402HTTPResourceServer(resourceServer, routes)

// Optional HCS audit log: one message per settled payment.
let hcs = null
if (process.env.HEDERA_AUDIT_TOPIC_ID && process.env.HEDERA_MERCHANT_PRIVATE_KEY) {
  const client = Client.forTestnet().setOperator(AccountId.fromString(PAY_TO), PrivateKey.fromStringECDSA(process.env.HEDERA_MERCHANT_PRIVATE_KEY))
  hcs = { client, topic: process.env.HEDERA_AUDIT_TOPIC_ID }
}
async function audit(entry) {
  if (!hcs) return null
  try {
    const r = await new TopicMessageSubmitTransaction().setTopicId(hcs.topic).setMessage(JSON.stringify(entry)).execute(hcs.client)
    const rec = await r.getReceipt(hcs.client)
    return { topic: hcs.topic, sequence: Number(rec.topicSequenceNumber), tx: r.transactionId.toString() }
  } catch (e) { console.log("hcs audit failed:", e.message); return null }
}

function adapter(req, url) {
  return {
    getHeader: n => { const v = req.headers[n.toLowerCase()]; return Array.isArray(v) ? v[0] : v },
    getMethod: () => req.method, getPath: () => url.pathname, getUrl: () => url.href,
    getAcceptHeader: () => req.headers.accept ?? "", getUserAgent: () => req.headers["user-agent"] ?? "",
    getQueryParams: () => Object.fromEntries(url.searchParams), getQueryParam: n => url.searchParams.get(n) ?? undefined,
  }
}

function send(res, status, headers, body) {
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(typeof body === "string" ? body : JSON.stringify(body, null, 2))
}

function produce(url) {
  if (url.pathname === "/v1/wind") return wind(Number(url.searchParams.get("alt_m") ?? 15000))
  if (url.pathname === "/v1/flight/latest") return latest()
  return null
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  try {
    if (url.pathname === "/" || url.pathname === "/.well-known/x402") {
      return send(res, 200, {}, { network: NETWORK, payTo: PAY_TO, facilitator: FACILITATOR, asset: "HBAR (0.0.0), amounts in tinybars",
        routes: Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, { price_tinybar: v.accepts.price.amount, description: v.description, mimeType: v.mimeType }])) })
    }
    const ctx = { adapter: adapter(req, url), path: url.pathname, method: req.method,
                  paymentHeader: req.headers["payment-signature"] ?? req.headers["x-payment"] }
    const r = await httpServer.processHTTPRequest(ctx)
    if (r.type === "payment-error") return send(res, r.response.status, r.response.headers, r.response.body ?? {})
    if (r.type === "no-payment-required") return send(res, 404, {}, { error: "not for sale here" })

    const data = produce(url)
    if (!data) return send(res, 404, {}, {                                             // nothing settled, payer not charged
      error: url.pathname === "/v1/wind" ? "no verified wind data within 1500 m of that height yet" : "no verified flight data yet",
      charged: false })
    const settle = await httpServer.processSettlement(r.paymentPayload, r.paymentRequirements, r.declaredExtensions)
    if (!settle.success) {
      console.log(`settle FAILED ${url.pathname}: ${settle.errorReason} ${settle.errorMessage ?? ""}`)
      return send(res, settle.response.status, settle.headers, settle.response.body ?? { error: settle.errorReason })
    }
    const entry = { resource: url.pathname + url.search, payer: settle.payer, amount_tinybar: r.paymentRequirements.amount,
                    tx: settle.transaction, network: settle.network, at: new Date().toISOString() }
    const log = await audit(entry)
    console.log(`PAID ${entry.resource} ${entry.amount_tinybar} tinybar by ${entry.payer} tx ${entry.tx}${log ? ` | hcs ${log.topic} #${log.sequence}` : ""}`)
    return send(res, 200, settle.headers, { ...data, payment: { ...entry, hcs_audit: log } })
  } catch (e) {
    console.log("error:", e)
    return send(res, 500, {}, { error: String(e.message ?? e) })
  }
}).listen(PORT, async () => {
  await resourceServer.initialize()
  console.log(`x402 flight data on http://localhost:${PORT}  payTo ${PAY_TO}  facilitator ${FACILITATOR}${hcs ? `  audit topic ${hcs.topic}` : ""}`)
})
