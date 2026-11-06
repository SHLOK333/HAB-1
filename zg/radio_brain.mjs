#!/usr/bin/env node
// 0G over LoRa: the ground station asks 0G for the payload's decisions and sends each answer
// up to the balloon in 27 bytes, so the payload needs no internet in flight.
//
// The ground station sees the same signed frames the Pi sees (altitude, time), so it can tell
// when the burst checkpoint is reached. It asks 0G exactly what the Pi would ask (Vela 2.0 9B
// with a 0.8 probability gate; if 0G's decision models are down, glm-5.3 sealed, then 0gm-1.0),
// packs the answer, and queues it for the ground Heltec's next uplink window ("up <hex>" via
// ground/state/ground_cmds). The beacon passes uplink payloads to the Pi over the tap wire;
// the Pi checks the tag and freshness and acts. Each decision goes out in 3 consecutive windows
// (the ground board sends a queued payload once, and LoRa loses frames); the Pi ignores repeats.
//
// Uplink payload, 27 bytes (UPLINK frame bytes 5..31):
//   0       0x5A ('Z')
//   1       checkpoint      1 = burst
//   2       action          0 = hold, 1 = start_recovery
//   3       probability     round(P x 254), 255 = none (a chat-model fallback gives no probability)
//   4       model           1 vela-2.0-9b, 2 glm-5.3 (sealed), 3 0gm-1.0-35b-a3b
//   5..8    seq             uint32 LE, the verified frame the decision is based on
//   9..12   unix time       uint32 LE, when 0G answered
//   13..18  request id      first 6 bytes of the 0G response / request ID
//   19..26  tag             HMAC-SHA256(ZG_RADIO_KEY, bytes 0..18), first 8 bytes
// The full record (model, probabilities, reason, IDs) is kept in zg/radio/<run>.jsonl, so the
// decision can be proven later (zg/prove.mjs) and matched to what the Pi logged.
//
//   node --env-file=../.env radio_brain.mjs          (started by ./demo.sh start)
import fs from "node:fs"
import path from "node:path"
import { pack as packPayload } from "./radio_packet.mjs"

const here = path.dirname(new URL(import.meta.url).pathname), ROOT = path.join(here, "..")
const ZG = process.env.ZG_PC_BASE_URL || "https://router-api.0g.ai/v1", KEY = process.env.ZG_PC_API_KEY
const RADIO_KEY = Buffer.from(process.env.ZG_RADIO_KEY ?? "", "hex")
if (RADIO_KEY.length !== 32) throw new Error("ZG_RADIO_KEY (32 bytes hex) missing in .env")
const pack = d => packPayload(d, RADIO_KEY)
const GATE = 0.8, RETRY_S = 30, REPEATS = 3, SLOT_MS = 12500
const MODELS = { "vela-2.0-9b": 1, "glm-5.3": 2, "0gm-1.0-35b-a3b": 3 }
const run = fs.readFileSync(path.join(ROOT, ".demo", "run"), "utf8").trim()
const outFile = path.join(here, "radio", `${run}.jsonl`); fs.mkdirSync(path.dirname(outFile), { recursive: true })
const cmdFile = path.join(ROOT, "ground", "state", "ground_cmds")
const say = s => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`)

// ---------------------------------------------------------------- 0G, as the Pi asks it
const CRIT = { start_recovery: "altitude is falling after the peak: the balloon burst, start descent and recovery",
               hold: "altitude is still rising or the drop is not clear: keep ascent mode" }
async function vela(state) {
  const r = await fetch(`${ZG}/decisions`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "vela-2.0-9b", state, verify_tee: true, questions: { action: { type: "choice", instructions: "Has the balloon burst? Choose what the payload should do.", criteria: CRIT } } }) })
  const j = await r.json(); if (!r.ok) throw new Error(`vela ${r.status}`)
  const probs = j.answers.action.probabilities, p = probs.start_recovery
  return { model: "vela-2.0-9b", action: p >= GATE ? "start_recovery" : "hold", p, probabilities: probs, reason: `vela-2.0-9b: P(start_recovery) = ${p.toFixed(3)}, gate ${GATE}`,
           request_id: j.x_0g_trace?.request_id ?? r.headers.get("x-request-id"), response_id: null, provider: j.x_0g_trace?.provider, tee_verified: j.x_0g_trace?.tee_verified }
}
async function chat(model, state, headers = {}, max_tokens = 300) {
  const r = await fetch(`${ZG}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, temperature: 0, max_tokens, chat_template_kwargs: { enable_thinking: false }, messages: [
      { role: "system", content: 'You are the decision module of a high-altitude balloon payload. Reply with JSON only: {"action": "<action>", "reason": "<under 20 words>"}' },
      { role: "user", content: `${state} Actions: start_recovery (the balloon has burst: switch to descent mode), hold (still rising, or not certain: keep ascent mode).` }] }) })
  const j = await r.json(); if (!r.ok) throw new Error(`${model} ${r.status}`)
  const text = j.choices[0].message.content ?? "", m = [...text.matchAll(/\{[^{}]*\}/g)].map(x => { try { return JSON.parse(x[0]) } catch { return null } }).filter(Boolean).at(-1)
  if (!m || !["start_recovery", "hold"].includes(m.action)) throw new Error(`${model}: no valid action`)
  return { model, action: m.action, p: null, probabilities: null, reason: `${model} (fallback, no probability): ${m.reason ?? ""}`.slice(0, 200),
           request_id: r.headers.get("x-request-id"), response_id: j.id, provider: j.x_0g_trace?.provider ?? r.headers.get("x-provider"), e2ee: r.headers.get("x-0g-e2ee"), fallback: true }
}
async function decide(state) {
  const errors = []
  for (const f of [() => vela(state), () => chat("glm-5.3", state, { "X-0G-Provider-Trust-Mode": "private" }, 1200), () => chat("0gm-1.0-35b-a3b", state)]) {
    try { return await f() } catch (e) { errors.push(e.message) }
  }
  throw new Error(errors.join("; "))
}

// ---------------------------------------------------------------- follow the verified frames
let phase = "ascent", peak = 0, hist = [], lastSeq = -1, nextAsk = 0, busy = false
async function onVerified(e) {
  if (e.seq < lastSeq - 6 || e.flight_s < 0) { phase = "ascent"; peak = 0; hist = [] }      // beacon restarted, or the replay began again
  lastSeq = e.seq; peak = Math.max(peak, e.alt_m); hist.push([e.flight_s, e.alt_m]); hist = hist.slice(-8)
  if (phase !== "ascent" || peak < 1000 || e.alt_m > peak - 300 || busy || Date.now() < nextAsk) return
  busy = true; nextAsk = Date.now() + RETRY_S * 1000
  const [a, b] = hist.slice(-2), vs = a && b && b[0] > a[0] ? (b[1] - a[1]) / (b[0] - a[0]) : null
  const state = `High-altitude balloon telemetry. Altitude readings, oldest first: ${hist.map(h => `${h[1]} m`).join(", ")}. Peak so far ${peak} m; the latest reading is ${peak - e.alt_m} m below the peak${vs != null ? `, vertical speed ${vs >= 0 ? "+" : ""}${vs.toFixed(1)} m/s` : ""}.`
  say(`burst checkpoint at seq ${e.seq} (${e.alt_m} m, ${peak - e.alt_m} m below the peak): asking 0G`)
  try {
    const d = await decide(state), t = Math.floor(Date.now() / 1000)
    const payload = pack({ checkpoint: 1, action: d.action === "start_recovery" ? 1 : 0, p: d.p, model: MODELS[d.model] ?? 0, seq: e.seq, t, rid: (d.response_id ?? d.request_id ?? "").replace(/^chatcmpl-/, "") })
    const rec = { ts: t, run, checkpoint: "burst", via: "lora-uplink", seq: e.seq, inputs: { altitudes_m: hist.map(h => h[1]), peak_m: peak, state },
      model: d.model, request_id: d.request_id, response_id: d.response_id, provider: d.provider, tee_verified: d.tee_verified ?? null, e2ee: d.e2ee ?? null,
      decision: { action: d.action, reason: d.reason, probabilities: d.probabilities, fallback: d.fallback ?? false }, payload: payload.toString("hex") }
    fs.appendFileSync(outFile, JSON.stringify(rec) + "\n")
    if (d.action === "start_recovery") phase = "descent"
    say(`0G ${d.model}: ${d.action}${d.p != null ? ` P=${d.p.toFixed(3)}` : " (no probability)"} · request ${d.response_id ?? d.request_id} · sending up over LoRa ×${REPEATS}: ${payload.toString("hex")}`)
    for (let i = 0; i < REPEATS; i++) setTimeout(() => { fs.appendFileSync(cmdFile, `up ${payload.toString("hex")}\n`); say(`queued for uplink window ${i + 1}/${REPEATS}`) }, i * SLOT_MS)
  } catch (err) {
    say(`0G did not answer (${err.message}): nothing sent; the payload holds its safe state`)
  }
  busy = false
}

// tail the newest verifier log
const logDir = path.join(ROOT, "ground", "log")
const newest = () => fs.readdirSync(logDir).filter(n => n.startsWith("verifier-")).sort().at(-1)
let file = newest(), pos = fs.statSync(path.join(logDir, file)).size, part = ""
say(`0G over LoRa for session ${run}: following ${file}, records in zg/radio/${run}.jsonl`)
setInterval(() => {
  const n = newest(); if (n !== file) { file = n; pos = 0; part = "" }
  const f = path.join(logDir, file), size = fs.statSync(f).size; if (size <= pos) return
  const fd = fs.openSync(f, "r"), buf = Buffer.alloc(size - pos); fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd); pos = size
  const lines = (part + buf.toString()).split("\n"); part = lines.pop()
  for (const l of lines) { let e; try { e = JSON.parse(l) } catch { continue } if (e.ev === "verdict" && e.verdict === "VERIFIED") onVerified(e) }
}, 1000)
