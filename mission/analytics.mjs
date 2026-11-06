#!/usr/bin/env node
// AI analytics over Arkiv: query mission data with attribute filters, hand a compact
// digest to a 0G model, and store the answer back on Arkiv as a boscon.hab.insight,
// with the 0G request id and whether 0G listed the model as TEE-attested.
// Nothing is written when 0G does not answer: no insight is ever made up.
//
//   node --env-file=../.env analytics.mjs [jet-stream] [landing-error] [verification]
import fs from "node:fs"
import path from "node:path"
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk"
import { rabdi } from "@arkiv-network/sdk/chains"
import { and, asc, eq } from "@arkiv-network/sdk/query"
import { bytes, u64 } from "@arkiv-network/sdk/schema"
import { http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { DATASET, DAYS, FLIGHT, Insight, Prediction, Wind } from "./schema.mjs"
import { Packet } from "../arkiv/schema.mjs"

const here = path.dirname(new URL(import.meta.url).pathname)
const chain = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" })
const reader = createPublicClient({ chain, transport: http() })
const account = privateKeyToAccount(process.env.ARKIV_GROUND_PRIVATE_KEY)
const wallet = createWalletClient({ chain, transport: http(), account })
const ZG = process.env.ZG_PC_BASE_URL, KEY = process.env.ZG_PC_API_KEY
// TEE-attested models first; the last ones are plain fallbacks, recorded as teeAttested=false
const PREFERRED = (process.env.ZG_ANALYTICS_MODELS ?? "0gm-1.0-35b-a3b,deepseek-v4-pro,glm-5.1,qwen3.6-plus,deepseek-v4-flash").split(",")
const base = and(eq("flight", FLIGHT), eq("dataset", DATASET))

async function all(q) { const out = []; for (let o = 0; ; o += 100) { const p = await q().limit(100).offset(o).fetch(); out.push(...p.entities); if (p.entities.length < 100) return out } }
const v = e => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith("$")).map(([k, x]) => [k, x?.value ?? x]))

// ---------------------------------------------------------------- Arkiv digests
const TOPICS = {
  "jet-stream": async () => {
    const q = "Wind where flight=hab1-2026-10-31 and dataset=mission-v1, all sources, ordered by altM"
    const rows = (await all(() => reader.select({ source: true, phase: true, altM: true, speedMs: true, towardDeg: true }).from(Wind).where(base).ownedBy(account.address).orderBy(asc("altM")))).map(v)
    const bands = {}
    for (const r of rows) { const b = Math.floor(r.altM / 2000) * 2; const k = `${b}-${b + 2}km ${r.source}`; (bands[k] ??= []).push(+r.speedMs) }
    const digest = Object.entries(bands).map(([k, a]) => `${k}: n=${a.length} mean=${(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1)} max=${Math.max(...a).toFixed(1)} m/s`)
    return { q, n: rows.length, digest, ask: "Compare the winds the balloon measured with the GFS model winds by altitude band. Where is the jet stream, how strong, and where did the model differ most from what was measured?" }
  },
  "landing-error": async () => {
    const q = "Prediction where flight=hab1-2026-10-31 and dataset=mission-v1, ordered by fromFlightS"
    const rows = (await all(() => reader.select({ kind: true, fromFlightS: true, fromAltM: true, errorKm: true, windBands: true }).from(Prediction).where(base).ownedBy(account.address).orderBy(asc("fromFlightS")))).map(v)
    const digest = rows.filter(r => r.kind !== "inflight" || r.fromFlightS % 600 === 0)
      .map(r => `${r.kind} T+${Math.round(r.fromFlightS / 60)}min alt=${r.fromAltM}m measuredBands=${r.windBands} error=${r.errorKm}km`)
    return { q, n: rows.length, digest, ask: "How did the landing-prediction error change through the flight as measured winds replaced the forecast? When was it good enough for a recovery team to drive to the site?" }
  },
  verification: async () => {
    const q = "count(Packet) where flight=hab1-2026-10-31 and verdict=<each>, owned by this ground station"
    const digest = []
    for (const verdict of ["verified", "fake", "bad_signature", "unverified", "replay", "conflict"])
      digest.push(`${verdict}: ${await reader.count().from(Packet).where(and(eq("flight", FLIGHT), eq("verdict", verdict))).ownedBy(account.address).fetch()}`)
    return { q, n: digest.length, digest, ask: "These are counts of received telemetry frames by verification verdict. What do they say about the link and about attacks on it?" }
  },
}

// ---------------------------------------------------------------- 0G
async function pickModel() {
  const r = await fetch(`${ZG}/models`, { headers: { Authorization: `Bearer ${KEY}` } })
  const list = (await r.json()).data ?? []
  for (const id of PREFERRED) { const m = list.find(x => x.id === id); if (m) return { id, tee: m.tee_attested === true } }
  throw new Error("none of the preferred models is offered by 0G right now")
}
async function ask0G(model, topic, d) {
  const body = { model, temperature: 0, max_tokens: 500, chat_template_kwargs: { enable_thinking: false }, messages: [
    { role: "system", content: "You analyse high-altitude balloon telemetry for a recovery team. Answer only from the data given. Reply as JSON: {\"headline\": \"<= 100 characters\", \"findings\": [\"...\"], \"anomalies\": [\"...\"]}" },
    { role: "user", content: `Topic: ${topic}\nData read from Arkiv (${d.q}), ${d.n} entities:\n${d.digest.join("\n")}\n\nQuestion: ${d.ask}` }] }
  const r = await fetch(`${ZG}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(`0G ${r.status} ${j.error?.code ?? ""}: ${j.error?.message ?? JSON.stringify(j).slice(0, 120)} (request ${j.request_id ?? r.headers.get("x-request-id")})`)
  const text = j.choices[0].message.content
  let parsed; try { parsed = JSON.parse(text.replace(/^```(json)?|```$/g, "").trim()) } catch { parsed = { headline: text.slice(0, 100), findings: [text], anomalies: [] } }
  return { id: j.id, e2ee: r.headers.get("x-0g-e2ee"), parsed, usage: j.usage }
}

// ---------------------------------------------------------------- run
const topics = process.argv.slice(2).filter(t => TOPICS[t]); if (!topics.length) topics.push(...Object.keys(TOPICS))
const pending = path.join(here, "data", "analytics-pending.json"), saved = path.join(here, "data", "insights.json")
const results = fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, "utf8")) : []
let model; try { model = await pickModel() } catch (e) { console.log(`0G: ${e.message}`) }
for (const topic of topics) {
  const d = await TOPICS[topic]()
  console.log(`\n[${topic}] Arkiv: ${d.q} -> ${d.n} entities`)
  if (!model) { fs.writeFileSync(pending, JSON.stringify({ topic, ...d }, null, 1)); console.log("  0G unavailable, digest kept in data/analytics-pending.json, nothing written"); continue }
  try {
    const a = await ask0G(model.id, topic, d)
    const headline = String(a.parsed.headline ?? "").slice(0, 100)
    const rec = { topic, model: model.id, teeAttested: model.tee, requestId: a.id, e2ee: a.e2ee, headline, ...a.parsed, arkivQuery: d.q, inputs: d.digest, at: new Date().toISOString() }
    const { entityKey, txHash } = await wallet.createEntity(Insight, { flight: FLIGHT, dataset: DATASET, topic, model: model.id, teeAttested: String(model.tee),
      requestId: String(a.id).slice(0, 128), createdAt: u64(Math.floor(Date.now() / 1000)), headline: Buffer.from(headline).subarray(0, 128).toString(),
      query: bytes(Buffer.from(d.q)), body: bytes(Buffer.from(JSON.stringify(rec))) }, { expiration: ExpirationTime.fromDays(DAYS) })
    results.push({ ...rec, entityKey, txHash }); fs.writeFileSync(saved, JSON.stringify(results, null, 1))
    console.log(`  0G ${model.id} (TEE-attested: ${model.tee}) request ${a.id}\n  ${headline}\n  Arkiv insight ${entityKey}`)
  } catch (e) { console.log(`  ${e.message}\n  nothing written to Arkiv`) }
}
