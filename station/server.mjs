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
    state.lastFrameAt = Date.now(); state.lastFrame = e
    // an armed attack goes out with the batch's last data frame, so the SIG frame catches it 12 s later
    if (attackArmed && e.seq % 6 === 4) fireAttack(e.seq)
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
  attack: () => [".venv/bin/python", ["ground/cmd.py", "beacon", "attack"]],
  buy: b => ["./demo.sh", ["buy", String(Math.max(1000, Math.min(19000, Number(b?.alt) || 15000)))]],
  radio: () => ["./demo.sh", ["radio-x402"]],
  analyze: () => ["node", ["--env-file=../.env", "analytics.mjs"], path.join(ROOT, "mission")],
}
let running = null
// Forged frame, timed for a live audience. The beacon sends the fake right after its next
// data frame, and the fake is only judged when that batch's SIG frame arrives. Armed while
// the batch's 5th frame (seq % 6 == 4) is the latest, the fake rides with the 6th and the
// SIG follows one slot (12 s) later: caught about 24 s after the click, not up to 84 s.
let attackArmed = null
function fireAttack(seq) {
  attackArmed = null
  send("cmd", { id: "attack-timing", name: "attack", line: `arming the beacon now: the fake goes out with seq ${seq + 1}, the last frame of batch ${seq - 4}–${seq + 1}; its SIG frame follows about 12 s later` })
  runAction("attack", {}, true)
}
function armAttack() {
  const e = state.lastFrame, age = (Date.now() - state.lastFrameAt) / 1000
  if (e && e.seq % 6 === 4 && age < 9) { fireAttack(e.seq); return { ok: true, id: "attack-now" } }
  attackArmed = { at: Date.now() }
  const k = e ? e.seq % 6 : 0, wait = e ? Math.max(0, Math.round((k === 5 ? 6 : k === 4 ? 7 : 4 - k) * 12 - age)) : null
  send("cmd", { id: "attack-timing", name: "attack", line: `forged frame armed: waiting for the 5th frame of the batch${wait != null ? ` (about ${wait} s)` : ""}, so the signature frame catches it right after` })
  return { ok: true, id: "attack-armed" }
}

function runAction(name, body, timed) {
  if (name === "attack" && !timed) return armAttack()
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
    return res.end(JSON.stringify({ station: true, session: state.session, counts: state.counts, fixes: state.fixes, prediction: state.prediction, profile: PROFILE }))
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
