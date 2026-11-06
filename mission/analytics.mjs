#!/usr/bin/env node
// AI analytics over Arkiv: query mission data with attribute filters, hand a compact
// digest to a 0G model, and store the answer back on Arkiv as a boscon.hab.insight,
// with the 0G request id and whether 0G listed the model as TEE-attested.
// Before it is written, a second 0G model (Vela 2.0 9B, a TEE-attested decision model)
// marks any claim in the answer that the Arkiv data does not support ("span" question);
// the verdict is stored as indexed attributes, so "guardVerdict=supported" is a filter.
// Nothing is written when 0G does not answer: no insight is ever made up or left unchecked.
//
//   node --env-file=../.env analytics.mjs [jet-stream] [landing-error] [verification]
import fs from "node:fs"
import path from "node:path"
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk"
import { rabdi } from "@arkiv-network/sdk/chains"
import { and, asc, eq, gte, lte } from "@arkiv-network/sdk/query"
import { bytes, dec, i32, u64 } from "@arkiv-network/sdk/schema"
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
const PREFERRED = (process.env.ZG_ANALYTICS_MODELS ?? "0gm-1.0-35b-a3b,glm-5.3,deepseek-v4-pro,qwen3.6-plus,deepseek-v4-flash").split(",")
// glm-5.3 is asked in private trust mode (sealed TeeML providers only) and reasons first, so it needs room
const OPTS = { "glm-5.3": { max_tokens: 2000, headers: { "X-0G-Provider-Trust-Mode": "private" } } }
const GUARD = process.env.ZG_GUARD_MODEL ?? "vela-2.0-9b"
const base = and(eq("flight", FLIGHT), eq("dataset", DATASET))

async function all(q) { const out = []; for (let o = 0; ; o += 100) { const p = await q().limit(100).offset(o).fetch(); out.push(...p.entities); if (p.entities.length < 100) return out } }
const v = e => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith("$")).map(([k, x]) => [k, x?.value ?? x]))

// ---------------------------------------------------------------- Arkiv digests
const TOPICS = {
  "jet-stream": async () => {
    // attribute filters: source, and altitude 8 km and up (where the jet stream is)
    const q = "Wind where flight=hab1-2026-10-31 and dataset=mission-v1 and altM >= 8000 and source = measured | gfs, ordered by altM"
    const rows = []
    for (const source of ["measured", "gfs"]) rows.push(...(await all(() => reader.select({ source: true, phase: true, altM: true, speedMs: true, towardDeg: true }).from(Wind)
      .where(and(base, eq("source", source), gte("altM", i32(8000)))).ownedBy(account.address).orderBy(asc("altM")))).map(v))
    const bands = {}
    for (const r of rows) { const b = Math.floor(r.altM / 2000) * 2; const k = `${b}-${b + 2}km ${r.source}`; (bands[k] ??= []).push(+r.speedMs) }
    const digest = Object.entries(bands).map(([k, a]) => `${k}: n=${a.length} mean=${(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1)} max=${Math.max(...a).toFixed(1)} m/s`)
    return { q, n: rows.length, digest, ask: "Compare the winds the balloon measured with the GFS model winds by altitude band, from 8 km up. Where is the jet stream, how strong, and where did the model differ most from what was measured?" }
  },
  "landing-error": async () => {
    // attribute filters: in-flight predictions only, and those that landed within 2 km
    const q = "Prediction where flight=hab1-2026-10-31 and dataset=mission-v1 and kind=inflight (all, and errorKm <= 2), ordered by fromFlightS"
    const sel = () => reader.select({ kind: true, fromFlightS: true, fromAltM: true, errorKm: true, windBands: true }).from(Prediction)
    const rows = (await all(() => sel().where(and(base, eq("kind", "inflight"))).ownedBy(account.address).orderBy(asc("fromFlightS")))).map(v)
    const good = (await all(() => sel().where(and(base, eq("kind", "inflight"), lte("errorKm", dec("2")), gte("errorKm", dec("0")))).ownedBy(account.address).orderBy(asc("fromFlightS")))).map(v)
    const digest = rows.filter(r => r.fromFlightS % 600 === 0).map(r => `T+${Math.round(r.fromFlightS / 60)}min alt=${r.fromAltM}m measuredBands=${r.windBands} error=${r.errorKm}km`)
    digest.push(`predictions within 2 km of the real landing: ${good.length} of ${rows.length}; the first from T+${good.length ? Math.round(good[0].fromFlightS / 60) : "?"} min`)
    return { q, n: rows.length, digest, ask: "How did the landing-prediction error change through the flight as measured winds replaced the forecast? When was it good enough for a recovery team to drive to the site?" }
  },
  verification: async () => {
    const q = "count(Packet) where flight=hab1-2026-10-31 and verdict=<each>, owned by this ground station"
    const digest = []
    for (const verdict of ["verified", "fake", "bad_signature", "unverified", "replay", "conflict", "unsigned"])   // attribute filter: verdict
      digest.push(`${verdict}: ${await reader.count().from(Packet).where(and(eq("flight", FLIGHT), eq("verdict", verdict))).ownedBy(account.address).fetch()}`)
    return { q, n: digest.length, digest, ask: "These are counts of received telemetry frames by verification verdict. What do they say about the link and about attacks on it?" }
  },
}

// ---------------------------------------------------------------- 0G
function lastJson(text) {
  const objs = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue
    let depth = 0, inStr = false
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (inStr) { if (ch === "\\") j++; else if (ch === '"') inStr = false; continue }
      if (ch === '"') inStr = true; else if (ch === "{") depth++; else if (ch === "}" && --depth === 0) { try { objs.push(JSON.parse(text.slice(i, j + 1))) } catch {} i = j; break }
    }
  }
  return objs.at(-1) ?? null
}
async function pickModel() {
  const r = await fetch(`${ZG}/models`, { headers: { Authorization: `Bearer ${KEY}` } })
  const list = (await r.json()).data ?? []
  const offered = PREFERRED.map(id => list.find(x => x.id === id)).filter(Boolean).map(m => ({ id: m.id, tee: m.tee_attested === true }))
  if (!offered.length) throw new Error("none of the preferred models is offered by 0G right now")
  return offered       // in order of preference; a model 0G lists can still be down, so each is tried in turn
}
async function ask0G(model, topic, d) {
  const body = { model, temperature: 0, max_tokens: OPTS[model]?.max_tokens ?? 500, chat_template_kwargs: { enable_thinking: false }, messages: [
    { role: "system", content: "You analyse high-altitude balloon telemetry for a recovery team. Answer only from the data given. Reply as JSON: {\"headline\": \"<= 100 characters\", \"findings\": [\"...\"], \"anomalies\": [\"...\"]}" },
    { role: "user", content: `Topic: ${topic}\nData read from Arkiv (${d.q}), ${d.n} entities:\n${d.digest.join("\n")}\n\nQuestion: ${d.ask}` }] }
  const r = await fetch(`${ZG}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json", ...OPTS[model]?.headers }, body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(`0G ${r.status} ${j.error?.code ?? ""}: ${j.error?.message ?? JSON.stringify(j).slice(0, 120)} (request ${j.request_id ?? r.headers.get("x-request-id")})`)
  const text = j.choices[0].message.content
  // some models reason in the answer before the JSON: take the last complete JSON object
  const parsed = lastJson(text)
  if (!parsed?.headline) throw new Error(`${model} gave no JSON answer: ${text.slice(0, 80)}`)
  return { id: j.id, e2ee: r.headers.get("x-0g-e2ee"), parsed, usage: j.usage }
}

// Vela marks claims in the insight that the source data does not support. Spans are
// character offsets into the state; only those inside the INSIGHT part count.
async function guard(d, parsed) {
  const claims = [parsed.headline, ...(parsed.findings ?? []), ...(parsed.anomalies ?? [])].filter(Boolean).join("\n")
  const head = `SOURCE DATA (read from Arkiv: ${d.q}):\n${d.digest.join("\n")}\n\nINSIGHT:\n`, state = head + claims
  const r = await fetch(`${ZG}/decisions`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: GUARD, state, verify_tee: true, questions: { unsupported: { type: "span",
      instructions: "Mark claims in the INSIGHT that the SOURCE DATA does not support.",
      criteria: { unsupported_claim: "a claim in the insight that the source data does not support" } } } }) })
  const j = await r.json()
  const requestId = j.x_0g_trace?.request_id ?? r.headers.get("x-request-id")
  if (!r.ok) {
    // Vela down (seen 6 Nov 2026): a 0G chat model lists the unsupported claims instead; recorded under its own name
    for (const m of ["glm-5.3", "0gm-1.0-35b-a3b", "qwen3.6-plus"]) {
      try {
        const c = await fetch(`${ZG}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json", ...OPTS[m]?.headers }, body: JSON.stringify({ model: m, temperature: 0, max_tokens: OPTS[m]?.max_tokens ?? 300,
          chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "system", content: 'You check claims against data. Reply with JSON only: {"unsupported": ["<exact phrase from the INSIGHT that the SOURCE DATA does not support>", ...]} (an empty list if all are supported).' },
          { role: "user", content: state }] }) })
        const cj = await c.json(); if (!c.ok) continue
        const out = lastJson(cj.choices[0].message.content ?? ""); if (!out) continue
        const flagged = (out.unsupported ?? []).filter(x => typeof x === "string" && x.trim()).map(text => ({ text, p: null }))
        return { model: m, requestId: cj.id ?? c.headers.get("x-request-id"), teeVerified: c.headers.get("x-0g-e2ee") === "sealed", e2ee: c.headers.get("x-0g-e2ee"), verdict: flagged.length ? "flagged" : "supported", flagged, fallbackFrom: `${GUARD} (${r.status})` }
      } catch {}
    }
    throw new Error(`0G guard ${r.status}: ${j.error?.message ?? JSON.stringify(j).slice(0, 120)} (request ${requestId})`)
  }
  const flagged = (j.spans?.unsupported ?? []).filter(x => x.start >= head.length).map(x => ({ text: x.text, p: Math.round(x.probability * 1000) / 1000 }))
  return { model: GUARD, requestId, teeVerified: j.x_0g_trace?.tee_verified ?? null, verdict: flagged.length ? "flagged" : "supported", flagged,
           threshold: j.thresholds?.unsupported ?? null, costUsdMicro: j.x_0g_trace?.billing?.total_cost_usd_micro ?? null }
}

// ---------------------------------------------------------------- run
const topics = process.argv.slice(2).filter(t => TOPICS[t]); if (!topics.length) topics.push(...Object.keys(TOPICS))
const pending = path.join(here, "data", "analytics-pending.json"), saved = path.join(here, "data", "insights.json")
const results = fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, "utf8")) : []
let models; try { models = await pickModel() } catch (e) { console.log(`0G: ${e.message}`) }
for (const topic of topics) {
  const d = await TOPICS[topic]()
  console.log(`\n[${topic}] Arkiv: ${d.q} -> ${d.n} entities`)
  if (!models) { fs.writeFileSync(pending, JSON.stringify({ topic, ...d }, null, 1)); console.log("  0G unavailable, digest kept in data/analytics-pending.json, nothing written"); continue }
  let a, model, tried = []
  for (const m of models) { try { a = await ask0G(m.id, topic, d); model = m; break } catch (e) { tried.push(`${m.id}: ${e.message.slice(0, 90)}`) } }
  if (!a) { console.log(`  0G did not answer (${tried.join(" | ")})\n  nothing written to Arkiv`); continue }
  if (tried.length) console.log(`  fell back past ${tried.map(t => t.split(":")[0]).join(", ")} (down)`)
  try {
    const headline = String(a.parsed.headline ?? "").slice(0, 100)
    const g = await guard(d, a.parsed)
    const rec = { topic, model: model.id, teeAttested: model.tee, requestId: a.id, e2ee: a.e2ee, headline, ...a.parsed, guard: g, arkivQuery: d.q, inputs: d.digest, at: new Date().toISOString() }
    const { entityKey, txHash } = await wallet.createEntity(Insight, { flight: FLIGHT, dataset: DATASET, topic, model: model.id, teeAttested: String(model.tee),
      requestId: String(a.id).slice(0, 128), createdAt: u64(Math.floor(Date.now() / 1000)), headline: Buffer.from(headline).subarray(0, 128).toString(),
      query: bytes(Buffer.from(d.q)), body: bytes(Buffer.from(JSON.stringify(rec))),
      guardModel: g.model, guardVerdict: g.verdict, guardRequestId: String(g.requestId).slice(0, 128) }, { expiration: ExpirationTime.fromDays(DAYS) })
    results.push({ ...rec, entityKey, txHash }); fs.writeFileSync(saved, JSON.stringify(results, null, 1))
    console.log(`  0G ${model.id} (TEE-attested: ${model.tee}) request ${a.id}\n  ${headline}`)
    console.log(`  guard ${g.model} (TEE verified: ${g.teeVerified}) request ${g.requestId}: ${g.verdict}${g.flagged.length ? " " + JSON.stringify(g.flagged) : ""}`)
    console.log(`  Arkiv insight ${entityKey}  tx ${txHash}`)
  } catch (e) { console.log(`  ${e.message}\n  nothing written to Arkiv`) }
}
