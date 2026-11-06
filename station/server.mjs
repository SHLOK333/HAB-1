#!/usr/bin/env node
// HAB-1 ground station bridge. Runs on the laptop that holds the ground Heltec on USB.
// Serves the console (../site) and streams every live source to it over Server-Sent Events:
//   radio      the verifier's events: frames heard, batch signatures, verdicts, x402 over LoRa
//   prediction a CUSF-Tawhiri re-prediction from every verified fix (mission/tawhiri.mjs)
//   arkiv      each batch the publisher writes to Arkiv, with its transaction
//   hedera     x402 sales settled by the HTTP endpoint (hedera/server.mjs)
//   pi         the payload Pi's agent: status, sensors, 0G checkpoints (over SSH)
//   health     which parts of the system are up
//   cmd        output of operator actions started from the console
// Operator actions (POST /api/cmd/<name>) run the project's own commands. Bound to 127.0.0.1.
//
//   node station/server.mjs            then open http://localhost:8090
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import os from "node:os"
import net from "node:net"
import { loadGfs, measuredFromFixes, simulate, km } from "../mission/tawhiri.mjs"

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const SITE = path.join(ROOT, "site"), DEMO = path.join(ROOT, ".demo"), GLOG = path.join(ROOT, "ground", "log")
const PORT = Number(process.env.STATION_PORT ?? 8090)
const FLIGHT = JSON.parse(fs.readFileSync(path.join(ROOT, "mission", "data", "flight-hab1.json"), "utf8"))
const PRED = JSON.parse(fs.readFileSync(path.join(ROOT, "mission", "data", "predictions.json"), "utf8"))
const PROFILE = PRED.balloonProfile
const RELEASE = Date.parse(FLIGHT.release)
const gfs = await loadGfs()

// ---------------------------------------------------------------- event bus
const clients = new Set(), history = []
let evId = 0
function send(type, data) {
  const e = { id: ++evId, type, at: Date.now(), data }
  if (type !== "health") { history.push(e); if (history.length > 1500) history.shift() }
  const chunk = `id: ${e.id}\nevent: ${type}\ndata: ${JSON.stringify(e)}\n\n`
  for (const res of clients) res.write(chunk)
}

// ---------------------------------------------------------------- tail helper
function tail(file, onLine, fromStart) {
  let off = fromStart ? 0 : (fs.existsSync(file) ? fs.statSync(file).size : 0), part = "", stopped = false
  const tick = () => {
    if (stopped) return
    try {
      const size = fs.statSync(file).size
      if (size < off) off = 0
      if (size > off) {
        const fd = fs.openSync(file, "r"), buf = Buffer.alloc(size - off)
        fs.readSync(fd, buf, 0, buf.length, off); fs.closeSync(fd); off = size
        const lines = (part + buf.toString()).split("\n"); part = lines.pop()
        for (const l of lines) if (l.trim()) onLine(l)
      }
    } catch {}
    setTimeout(tick, 250)
  }
  setTimeout(tick, 0)
  return () => { stopped = true }
}

// ---------------------------------------------------------------- radio: the verifier log
const state = { session: null, logFile: null, fixes: [], counts: {}, lastFrameAt: 0, lastFrame: null, prediction: null, arkiv: { batches: 0, entities: 0, last: null },
  hedera: { sales: 0, last: null }, pi: { lastAt: 0, status: null }, beaconKey: null }
let stopRadio = null
function watchVerifier() {
  let newest = null
  try { newest = fs.readdirSync(GLOG).filter(f => f.startsWith("verifier-")).sort().at(-1) } catch {}
  if (newest && newest !== state.logFile) {
    stopRadio?.(); state.logFile = newest; state.fixes = []; state.counts = {}; state.prediction = null
    try { state.session = fs.readFileSync(path.join(DEMO, "run"), "utf8").trim() } catch { state.session = newest }
    send("session", { session: state.session, log: newest })
    stopRadio = tail(path.join(GLOG, newest), onRadio, true)
  }
  setTimeout(watchVerifier, 1000)
}
function onRadio(line) {
  let e; try { e = JSON.parse(line) } catch { return }
  if (e.ev === "data") {
    // a second frame with the same seq is a forged one (the beacon's demo attacker)
    if (state.lastFrame?.seq === e.seq) onForged(e)
    else { state.lastFrameAt = Date.now(); state.lastFrame = e; onAttackFrame(e) }
  }
  if (e.ev === "verdict") {
    state.counts[e.verdict] = (state.counts[e.verdict] ?? 0) + 1
    if (e.beacon_key) state.beaconKey = e.beacon_key
    if (e.verdict === "VERIFIED") { addFix(e) }
  }
  send("radio", e)
}
function addFix(e) {
  if (state.fixes.some(f => f.seq === e.seq)) return
  // the beacon loops the flight replay: a fix far earlier in flight time starts a new pass
  if (state.lastFixS != null && e.flight_s < state.lastFixS - 600) { state.fixes = []; send("radio", { ev: "loop", flight_s: e.flight_s, seq: e.seq }) }
  state.lastFixS = e.flight_s
  state.fixes.push({ seq: e.seq, flightS: e.flight_s, lat: e.lat, lon: e.lon, altM: e.alt_m })
  state.fixes.sort((a, b) => a.flightS - b.flightS)
  predictFrom(state.fixes.at(-1))
}
function predictFrom(fix) {
  if (!state.flight.builtin) return   // our cached GFS is for HAB-1's day and pad only
  const i = state.fixes.indexOf(fix), prev = state.fixes[i - 1]
  if (!prev || fix.flightS - prev.flightS > 900) return  // direction unknown: no fix, or a gap (lost batch) that may span burst
  const ascending = fix.altM >= prev.altM
  const landed = prev && Math.abs(fix.altM - prev.altM) < 15 && fix.altM < FLIGHT.pad.altM + 400
  if (landed) return
  const measured = measuredFromFixes(state.fixes.slice(0, i + 1))
  const t0 = performance.now()
  const tr = simulate(gfs, { t: RELEASE + fix.flightS * 1000, lat: fix.lat, lon: fix.lon, alt: fix.altM, ascending }, PROFILE, measured)
  const L = tr.at(-1)
  state.prediction = { fromSeq: fix.seq, fromFlightS: fix.flightS, fromAltM: fix.altM, ascending, measuredBands: measured.length,
    landing: { lat: +L.lat.toFixed(5), lon: +L.lon.toFixed(5) }, missKm: km(L, FLIGHT.landing), ms: +(performance.now() - t0).toFixed(1),
    track: tr.filter((_, k) => k % 3 === 0 || k === tr.length - 1).map(p => [+p.lon.toFixed(5), +p.lat.toFixed(5), Math.round(p.alt)]) }
  send("prediction", state.prediction)
}

// ---------------------------------------------------------------- arkiv + hedera logs
function watchLog(name, onLine) {
  const file = path.join(DEMO, `${name}.log`)
  let stop = null, ino = null
  const check = () => {
    try { const st = fs.statSync(file); if (st.ino !== ino) { stop?.(); ino = st.ino; stop = tail(file, onLine, true) } } catch {}
    setTimeout(check, 2000)
  }
  check()
}
// 0G over LoRa (zg/radio_brain.mjs): decisions the ground station got from 0G and sent up
watchLog("brain", l => {
  const m = l.match(/^\S+ (.*)/); if (!m) return
  send("pi", { kind: "checkpoint", name: "burst", text: `0G over LoRa · ${m[1]}`, safeStop: /did not answer/.test(m[1]) })
})
watchLog("publisher", l => {
  let m
  if ((m = l.match(/^published (\d+): (.*?)\s+tx (0x[0-9a-f]+)\s+(\d+) ms/))) {
    state.arkiv.batches++; state.arkiv.entities += +m[1]
    state.arkiv.last = { count: +m[1], seqs: m[2].split(" ").map(s => s.split(":")[0]), tx: m[3], ms: +m[4] }
    send("arkiv", { kind: "batch", ...state.arkiv.last })
    trackArkivTx(state.arkiv.last)
  } else if ((m = l.match(/^run entity (0x[0-9a-f]+)\s+tx (0x[0-9a-f]+)/))) send("arkiv", { kind: "run", entity: m[1], tx: m[2] })
  else if (/publish failed/.test(l)) send("arkiv", { kind: "error", text: l.replace(/^publish failed, will retry: /, "") })
})
watchLog("x402", l => {
  let m
  if ((m = l.match(/^PAID (\S+) (\d+) tinybar by (\S+) tx (\S+)(?: \| hcs (\S+) #(\d+))?/))) {
    state.hedera.sales++; state.hedera.last = { resource: m[1], amount: +m[2], payer: m[3], tx: m[4], topic: m[5], seq: m[6] && +m[6] }
    send("hedera", { kind: "sale", ...state.hedera.last })
    trackHederaTx({ txId: m[4], kind: "x402 settle · HTTP", summary: `${+m[2] / 1e8} HBAR for ${m[1]} · payer ${m[3]}`, amount: +m[2] })
    if (m[5]) trackHcs({ topic: m[5], seq: +m[6], summary: `audit record of sale ${m[4]}` })
  } else if (/settle FAILED|error:|hcs audit failed/.test(l)) send("hedera", { kind: "error", text: l })
})

// ---------------------------------------------------------------- transactions: confirm on chain
// Every on-chain write is streamed as a "tx" event twice: when it is submitted and when the
// chain confirms it (Arkiv receipt: block, gas; Hedera mirror node: consensus time, fee, result).
const ENV = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n").filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
const ARKIV_RPC = `https://rpc.rabdi.db-chain.testnet.arkiv.network/${ENV.ARKIV_ACCESS_KEY ?? ""}`
const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1"
const txs = new Map()
function tx(update) { const t = { ...(txs.get(update.id) ?? {}), ...update }; txs.set(t.id, t); send("tx", t) }
const wait = ms => new Promise(r => setTimeout(r, ms))
async function trackArkivTx(b) {
  const id = b.tx, at = Date.now()
  tx({ id, chain: "arkiv", kind: "publish frames", status: "submitted", hash: b.tx, summary: `${b.count} verified frames · seq ${b.seqs[0]}–${b.seqs.at(-1)}`, seqs: b.seqs,
    entities: b.count, submittedAt: at - b.ms, latencyMs: b.ms, explorer: `https://rabdi.explorer.arkiv.network/tx/${b.tx}` })
  for (let i = 0; i < 8; i++) {
    try {
      const r = await (await fetch(ARKIV_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [b.tx] }) })).json()
      if (r.result) { const x = r.result; return tx({ id, status: x.status === "0x1" ? "confirmed" : "failed", block: parseInt(x.blockNumber, 16), gas: parseInt(x.gasUsed, 16), logs: x.logs?.length ?? 0, confirmedAt: Date.now() }) }
    } catch {}
    await wait(1500)
  }
}
async function trackHederaTx({ txId, kind, summary, amount }) {
  const id = txId, mid = txId.replace("@", "-").replace(/\.(\d+)$/, "-$1")
  tx({ id, chain: "hedera", kind, status: "submitted", hash: txId, summary, amount, submittedAt: Date.now(), explorer: `https://hashscan.io/testnet/transaction/${mid}` })
  for (let i = 0; i < 12; i++) {
    try {
      const r = await (await fetch(`${MIRROR}/transactions/${mid}`)).json(), x = r.transactions?.[0]
      if (x) {
        const valid = Number(txId.split("@")[1]) * 1000, cons = Number(x.consensus_timestamp) * 1000
        return tx({ id, status: x.result === "SUCCESS" ? "confirmed" : "failed", result: x.result, consensusAt: cons, latencyMs: Math.round(cons - valid), fee: x.charged_tx_fee, node: x.node, name: x.name, confirmedAt: Date.now(),
          transfers: (x.transfers ?? []).filter(t => Math.abs(t.amount) >= 100000).map(t => ({ account: t.account, amount: t.amount })) })
      }
    } catch {}
    await wait(2000)
  }
}
async function trackHcs({ topic, seq, summary }) {
  const id = `${topic}#${seq}`
  tx({ id, chain: "hcs", kind: "HCS audit message", status: "submitted", hash: id, summary, submittedAt: Date.now(), explorer: `https://hashscan.io/testnet/topic/${topic}` })
  for (let i = 0; i < 12; i++) {
    try {
      const r = await (await fetch(`${MIRROR}/topics/${topic}/messages/${seq}`)).json()
      if (r.consensus_timestamp) { let body = null; try { body = JSON.parse(Buffer.from(r.message, "base64").toString()) } catch {}
        return tx({ id, status: "confirmed", consensusAt: Number(r.consensus_timestamp) * 1000, runningHash: r.running_hash?.slice(0, 24), body, confirmedAt: Date.now() }) }
    } catch {}
    await wait(2000)
  }
}

// ---------------------------------------------------------------- the payload Pi (SSH)
function watchPi() {
  const p = spawn(path.join(ROOT, "tools", "pi.sh"), ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=10", "journalctl -u hab-agent -f -n 30 -o cat"], { cwd: ROOT })
  let part = ""
  p.stdout.on("data", b => {
    const lines = (part + b).split("\n"); part = lines.pop()
    for (const l of lines) if (l.trim()) onPi(l.trim())
  })
  p.on("exit", () => setTimeout(watchPi, 5000))
}
function onPi(l) {
  state.pi.lastAt = Date.now()
  let m
  if ((m = l.match(/^status: (.*)/))) {
    const s = m[1], f = {}
    f.phase = s.match(/phase (\w+)/)?.[1]; f.baroHpa = +s.match(/baro to beacon ([\d.]+) hPa/)?.[1] || null
    f.socC = +s.match(/SoC ([\d.]+) C/)?.[1] || null; f.mode = s.match(/, (SAFE|normal)$/)?.[1] ?? null
    const w = s.match(/wind ([\d.]+) m\/s toward (\d+) deg at (\d+) m/); if (w) f.wind = { speedMs: +w[1], towardDeg: +w[2], altM: +w[3] }
    f.camera = /camera on/.test(s); f.tap = !/no tap data/.test(s)
    state.pi.status = f
    send("pi", { kind: "status", text: s, ...f })
  } else if ((m = l.match(/^\[(\w+)\]\s+(.*)/))) send("pi", { kind: "checkpoint", name: m[1], text: m[2], safeStop: /SAFE STOP/.test(m[2]) })
  else if ((m = l.match(/^run (\S+); pi key (\w+)/))) send("pi", { kind: "boot", run: m[1], key: m[2] })
  else if (/^0G:|^sensors:/.test(l)) send("pi", { kind: "info", text: l })
}

// ---------------------------------------------------------------- health
// Why the radio or the payload is down, in words an operator can act on.
function diagnose() {
  const onHotspot = Object.values(os.networkInterfaces()).flat().some(i => i?.family === "IPv4" && i.address.startsWith("172.20.10."))
  let verifierError = null
  if (!alive("verifier")) {
    try {
      const t = fs.readFileSync(path.join(DEMO, "verifier.log"), "utf8").slice(-3000).trim().split("\n")
      const err = t.filter(l => /Error|error:|Traceback/.test(l)).at(-1)
      if (err) verifierError = /termios|Invalid argument|could not open port|Errno 16|busy/i.test(err) ? "the ground board's USB port would not open: unplug the ground Heltec and plug it back in" : err.trim().slice(0, 160)
    } catch {}
  }
  return { onHotspot, verifierError }
}
const alive = name => { try { process.kill(Number(fs.readFileSync(path.join(DEMO, `${name}.pid`), "utf8")), 0); return true } catch { return false } }
function health() {
  const now = Date.now(), usb = fs.readdirSync("/dev").some(f => f.startsWith("cu.usbserial") || f.startsWith("ttyUSB"))
  send("health", {
    ground: { usb, verifier: alive("verifier") }, beacon: { lastFrameAgeS: state.lastFrameAt ? Math.round((now - state.lastFrameAt) / 1000) : null, key: state.beaconKey },
    pi: { lastAgeS: state.pi.lastAt ? Math.round((now - state.pi.lastAt) / 1000) : null }, arkiv: { publisher: alive("publisher"), ...state.arkiv },
    hedera: { endpoint: alive("x402"), ...state.hedera }, session: state.session, counts: state.counts, busy: running?.name ?? null, diag: diagnose() })
  setTimeout(health, 2000)
}

// ---------------------------------------------------------------- operator actions
const ACTIONS = {
  start: () => ["./demo.sh", ["start", `live-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "")}`]],
  stop: () => ["./demo.sh", ["stop"]],
  buy: b => ["./demo.sh", ["buy", String(Math.max(1000, Math.min(19000, Number(b?.alt) || 15000)))]],
  radio: () => ["./demo.sh", ["radio-x402"]],
  analyze: () => ["node", ["--env-file=../.env", "analytics.mjs"], path.join(ROOT, "mission")],
}
let running = null
// ---------------------------------------------------------------- what the beacon flies
// Any flight (a Tawhiri simulation, a public balloon from SondeHub) can be uploaded to the beacon
// over Wi-Fi; it then transmits it exactly like the built-in HAB-1 replay: signed, batched,
// verified on the ground. Up to 180 samples of 16 bytes ("flight new/add/go" in the firmware).
state.flight = { name: "HAB-1 31 Oct 2026", builtin: true }
const CUSTOM_MAX = 180
function isa(h) {                                  // standard atmosphere: pressure (0.1 hPa), temperature (0.01 C)
  const t = h < 11000 ? 15 - 0.0065 * h : h < 20000 ? -56.5 : -56.5 + 0.001 * (h - 20000)
  const p = h < 11000 ? 1013.25 * (1 - 2.25577e-5 * h) ** 5.25588 : 226.32 * Math.exp(-(h - 11000) / 6341.6)
  return { pDhPa: Math.max(0, Math.round(p * 10)), tCc: Math.round(t * 100) }
}
function resample(points) {
  const pts = points.filter(p => [p[0], p[1], p[2], p[3]].every(Number.isFinite)).sort((a, b) => a[0] - b[0])
  if (pts.length < 2) throw new Error("the flight needs at least two timed points")
  const t0 = pts[0][0], dur = (pts.at(-1)[0] - t0) / 1000
  const step = Math.min(Math.max(60, Math.ceil(dur / (CUSTOM_MAX - 2))), Math.floor(32000 / (CUSTOM_MAX - 1)))
  const n = Math.min(CUSTOM_MAX - 1, Math.floor(dur / step) + 1), out = []
  const at = t => { let i = pts.findIndex(p => p[0] >= t); if (i <= 0) return pts[Math.max(i, 0)]; const a = pts[i - 1], b = pts[i], k = (t - a[0]) / ((b[0] - a[0]) || 1); return [t, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k] }
  out.push({ flightS: -60, ...pick(pts[0]) })     // on the pad first, as HAB-1's replay does: receivers reset at a new launch
  for (let i = 0; i < n; i++) out.push({ flightS: i * step, ...pick(at(t0 + i * step * 1000)) })
  return { samples: out, step }
  function pick(p) { return { lat: p[1], lon: p[2], alt: Math.max(0, Math.round(p[3])) } }
}
function packSample(s) {
  const b = Buffer.alloc(16), a = isa(s.alt)
  b.writeInt16LE(s.flightS, 0); b.writeInt32LE(Math.round(s.lat * 1e7), 2); b.writeInt32LE(Math.round(s.lon * 1e7), 6)
  b.writeUInt16LE(Math.min(65535, s.alt), 10); b.writeUInt16LE(a.pDhPa, 12); b.writeInt16LE(a.tCc, 14)
  return b.toString("hex")
}
async function sendToBeacon(lines) {
  const ip = await beaconOnWifi(); if (!ip) throw new Error(diagnose().onHotspot ? "the beacon is not on Wi-Fi (open the iPhone's Personal Hotspot screen)" : "this Mac is not on the iPhone hotspot, so it cannot reach the beacon (switch the Mac's Wi-Fi to the hotspot)")
  return new Promise((resolve, reject) => {
    let out = ""; const sock = net.connect({ host: ip, port: 2323 }, async () => {
      for (const l of lines) { sock.write(l + "\n"); await new Promise(r => setTimeout(r, 150)) }
      setTimeout(() => { sock.end(); resolve(out) }, 2500)
    })
    sock.on("data", d => (out += d)); sock.on("error", reject); sock.setTimeout(30000, () => { sock.destroy(); reject(new Error("beacon timed out")) })
  })
}
async function flyFlight(body) {
  if (body.builtin) {
    const out = await sendToBeacon(["flight builtin"])
    if (!/back to the built-in/.test(out)) throw new Error("the beacon did not confirm")
    state.flight = { name: "HAB-1 31 Oct 2026", builtin: true }
  } else {
    const { samples, step } = resample(body.points ?? [])
    const name = String(body.name ?? "uploaded flight").replace(/[^\x20-\x7e]/g, "").slice(0, 40)
    const lines = [`flight new ${samples.length} ${name}`]
    for (let i = 0; i < samples.length; i += 5) lines.push(`flight add ${i} ${samples.slice(i, i + 5).map(packSample).join("")}`)
    lines.push("flight go")
    const out = await sendToBeacon(lines)
    if (!/now flying/.test(out)) throw new Error(`the beacon did not switch (${(out.match(/flight: [^\n]*/g) ?? []).at(-1) ?? "no answer"})`)
    const peak = samples.reduce((m, s) => Math.max(m, s.alt), 0)
    state.flight = { name, builtin: false, samples: samples.length, stepS: step, peakM: peak, landing: { lat: samples.at(-1).lat, lon: samples.at(-1).lon },
      track: samples.map(s => [+s.lon.toFixed(5), +s.lat.toFixed(5), s.alt]) }
  }
  state.fixes = []; state.prediction = null; state.lastFixS = null
  send("flight", state.flight)
  return state.flight
}

// Forged frame, sent over LoRa. The station puts an attack command, [0xA7, target seq], in the
// ground board's next uplink (ground/state/ground_cmds -> the verifier -> the ground Heltec),
// and the beacon sends one fake frame with that seq. The button needs no network path to the
// beacon, so it works whatever Wi-Fi the laptop is on, or with none. The fake is judged when
// its batch's SIG frame arrives: "now" forges the next data frame (caught within about 84 s);
// "end" forges the batch's last data frame (seq % 6 == 5), so the SIG catches it 12 s later.
// A LoRa uplink can be lost and the beacon does not acknowledge it, so the command goes up once
// more: before the target frame when there is time ("end"), otherwise when the target frame came
// with no fake behind it (the beacon then forges the next frame). A repeat of a target the beacon
// already used is ignored.
let attack = null
const queueUp = hex => fs.appendFileSync(path.join(ROOT, "ground", "state", "ground_cmds"), `up ${hex}\n`)
const atkLine = (line, extra = {}) => send("cmd", { id: "attack-lora", name: "attack", line, ...extra })
// 12 s slots: a batch is 6 data frames, then its SIG frame
const slotsBetween = (a, b) => { let n = 0; for (let q = a + 1; q <= b; q++) n += q % 6 === 0 ? 2 : 1; return n }
function attackOverLora(when) {
  const e = state.lastFrame, ageMs = Date.now() - state.lastFrameAt
  if (!e || ageMs > 60000) return { ok: false, error: "No data frames heard in the last minute: the command rides on the ground's answer to a data frame, so start a session first." }
  if (attack) return { ok: false, error: `A forged frame is already on its way (seq ${attack.target}).` }
  // the first data frame the command can still ride on (after a batch's 6th frame, the SIG slot comes first)
  const nextDueMs = state.lastFrameAt + (e.seq % 6 === 5 ? 24000 : 12000)
  const carrier = e.seq + 1 + (Date.now() > nextDueMs - 2000 ? 1 : 0)
  const target = when === "end" ? carrier + ((5 - carrier % 6) + 6) % 6 : carrier
  const b = Buffer.alloc(27); b[0] = 0xa7; b.writeUInt32LE(target, 1)
  attack = { target, carrier, hex: b.toString("hex"), repeated: false }
  queueUp(attack.hex)
  const ageS = ageMs / 1000, fakeS = Math.max(1, Math.round(slotsBetween(e.seq, target) * 12 - ageS + 1))
  const sigS = Math.round((slotsBetween(e.seq, target - target % 6 + 5) + 1) * 12 - ageS)
  send("cmd", { id: "attack-lora", name: "attack", start: true, command: `LoRa uplink: up ${attack.hex.slice(0, 10)}… (target seq ${target})` })
  atkLine(`forged-frame command sent up over LoRa (no Wi-Fi needed): the beacon sends a fake seq ${target} in about ${fakeS} s, and that batch's signature frame catches it in about ${sigS} s`)
  return { ok: true, id: "attack-lora" }
}
function onAttackFrame(e) {
  if (!attack) return
  const a = attack
  if (!a.repeated && e.seq >= a.carrier && e.seq < a.target) { a.repeated = true; queueUp(a.hex) }   // a second copy, still in time
  else if (!a.repeated && e.seq >= a.target)
    setTimeout(() => { if (attack === a && !a.repeated) { a.repeated = true; queueUp(a.hex); atkLine(`no fake heard with seq ${a.target}: the uplink was lost, so the command goes up once more and the beacon forges the next frame`) } }, 4000)
  if (e.seq > attack.target + 3) {
    atkLine("No forged frame was heard: the beacon did not get the command (lost twice, or the beacon runs firmware from before 7 Nov). Press the PRG button on the beacon instead.")
    send("cmd", { id: "attack-lora", name: "attack", done: true, code: 1 }); attack = null
  }
}
function onForged(e) {
  if (!attack) return
  atkLine(`the beacon sent the forged frame: seq ${e.seq} heard twice, the fake claiming ${e.alt_m} m at ${e.lat.toFixed(3)}, ${e.lon.toFixed(3)}; the verifier rejects it when the batch's signature frame arrives`)
  send("cmd", { id: "attack-lora", name: "attack", done: true, code: 0 }); attack = null
}
// Is the beacon on the hotspot? Its log/command port (2323) answers if it is.
function beaconOnWifi() {
  const tryIp = ip => new Promise(res => { const s = net.connect({ host: ip, port: 2323, timeout: 600 }, () => { s.destroy(); res(ip) }); s.on("error", () => res(null)); s.on("timeout", () => { s.destroy(); res(null) }) })
  return Promise.all(Array.from({ length: 13 }, (_, i) => tryIp(`172.20.10.${i + 2}`))).then(r => r.find(Boolean) ?? null)
}
function runAction(name, body) {
  if (name === "attack") return attackOverLora(body?.when)
  if (running && name !== "stop") return { ok: false, error: `busy: ${running.name} is still running` }
  const [cmd, args, cwd] = ACTIONS[name](body), id = `${name}-${Date.now()}`
  const p = spawn(cmd, args, { cwd: cwd ?? ROOT, env: process.env })
  running = { name, id }
  send("cmd", { id, name, start: true, command: [cmd, ...args].join(" ") })
  let part = ""
  const out = b => { const lines = (part + b).split("\n"); part = lines.pop(); for (const l of lines) if (l.trim() && !/localstorage|trace-warnings|ExperimentalWarning/.test(l)) {
    send("cmd", { id, name, line: l })
    let m
    if (name === "radio" && (m = l.match(/facilitator settle: SETTLED tx (\S+)/))) trackHederaTx({ txId: m[1], kind: "x402 settle · LoRa", summary: "wind bought over the radio, payment signed on the ground board" })
    if (name === "radio" && (m = l.match(/HCS audit #(\d+)/))) trackHcs({ topic: ENV.HEDERA_AUDIT_TOPIC_ID, seq: +m[1], summary: "audit record of the LoRa sale" })
  } }
  p.stdout.on("data", out); p.stderr.on("data", out)
  p.on("exit", code => { if (part.trim()) send("cmd", { id, name, line: part }); send("cmd", { id, name, done: true, code }); if (running?.id === id) running = null })
  return { ok: true, id }
}

// ---------------------------------------------------------------- http
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" }
http.createServer((req, res) => {
  const url = new URL(req.url, "http://x")
  if (url.pathname === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    res.write("retry: 2000\n\n")
    for (const e of history) res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    clients.add(res); req.on("close", () => clients.delete(res)); return
  }
  if (url.pathname === "/api/state") {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({ station: true, session: state.session, counts: state.counts, fixes: state.fixes, prediction: state.prediction, profile: PROFILE, flight: state.flight }))
  }
  if (url.pathname === "/api/flight" && req.method === "POST") {
    let body = ""; req.on("data", c => (body += c)); req.on("end", async () => {
      let b = {}; try { b = JSON.parse(body || "{}") } catch {}
      try { const f = await flyFlight(b); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, flight: { ...f, track: undefined } })) }
      catch (e) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })) }
    }); return
  }
  if (url.pathname.startsWith("/api/cmd/") && req.method === "POST") {
    const name = url.pathname.slice(9)
    if (!ACTIONS[name]) { res.writeHead(404); return res.end() }
    let body = ""; req.on("data", c => (body += c)); req.on("end", () => {
      let b = {}; try { b = JSON.parse(body || "{}") } catch {}
      const r = runAction(name, b); res.writeHead(r.ok ? 202 : 409, { "content-type": "application/json" }); res.end(JSON.stringify(r))
    }); return
  }
  const file = path.join(SITE, path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ""))
  const target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, "index.html") : file
  if (!target.startsWith(SITE) || !fs.existsSync(target)) { res.writeHead(404); return res.end("not found") }
  res.writeHead(200, { "content-type": TYPES[path.extname(target)] ?? "application/octet-stream", "cache-control": "no-cache" })
  fs.createReadStream(target).pipe(res)
}).listen(PORT, "127.0.0.1", () => console.log(`HAB-1 ground station console on http://localhost:${PORT}`))

// ---------------------------------------------------------------- 0G proofs
// A provider keeps the TEE signature of a response for about 20 minutes, so while a session
// runs, zg/prove.mjs collects the proof of each new 0G decision every 2 minutes.
let proving = false
function prove() {
  const run = state.session
  if (proving || !run || !alive("verifier")) return
  proving = true
  const p = spawn("node", ["--env-file=../.env", "prove.mjs", run], { cwd: path.join(ROOT, "zg") })
  let out = ""; p.stdout.on("data", b => (out += b)); p.stderr.on("data", () => {})
  p.on("exit", code => {
    proving = false
    const m = out.match(/(\d+) of (\d+) 0G decisions proven/)
    if (m) send("proofs", { run, proven: +m[1], decisions: +m[2], file: `data/proofs-${run}.json` })
  })
}
setInterval(prove, 120000)

watchVerifier(); watchPi(); health()
