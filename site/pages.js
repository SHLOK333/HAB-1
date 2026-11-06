// HAB-1 console: the section pages (Flights, 0G, Hedera, Arkiv). Mission and Protocol live in
// console.js. Every number here is read from a public source the reader can check: the 0G
// chain and the signed episode log, the Hedera mirror node, Arkiv, SondeHub.
import { pyCanon } from "./lib/pycanon.js"

const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1"
const SONDEHUB = "https://api.v2.sondehub.org"
const CHAINSCAN = "https://chainscan-galileo.0g.ai"
const ARKIV_EXPLORER = "https://rabdi.explorer.arkiv.network"
const INDIA = { lat: 21, lon: 78.5, radiusM: 2_500_000 }             // centre of India, 2,500 km
const REGION = { minLat: 0, maxLat: 40, minLon: 55, maxLon: 100 }     // what the Flights map shows

export function initPages(c) {
  const { S, X, P, F, $, esc, fmt, short, pos, hsTx, hsAcct, dist, timeout } = c
  const started = new Set()
  const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago` }
  const utc = ms => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC"
  const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`
  const kpis = (id, rows) => { $(id).innerHTML = rows.map(([k, v, cls, small]) => `<div><dt>${k}</dt><dd class="${cls ?? ""}">${v}${small ? `<small>${small}</small>` : ""}</dd></div>`).join("") }
  const getJSON = async (url, ms = 20000) => { const r = await timeout(fetch(url), ms); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }
  const rgb = name => { const h = c.css(name).replace("#", ""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) }

  // ------------------------------------------------------------------------------------- 0G
  const ZG = { records: null, lines: null, key: null, verified: null }
  const EP = (X.zeroG.episodes ?? []).at(-1)
  function zgStatic() {
    const reg = X.zeroG.registry
    $("zg-links").innerHTML = [link(`${CHAINSCAN}/address/${reg.address}`, "EpisodeRegistry"), EP && link(`${CHAINSCAN}/tx/${EP.registryTx}`, `Registry entry #${EP.index}`),
      EP && link(`${CHAINSCAN}/tx/${EP.storageTx}`, "0G Storage upload"), link("https://pc.0g.ai/models/vela-2.0-9b", "Vela 2.0 9B"), link("https://pc.0g.ai/models/laya", "Laya")].filter(Boolean).join("")
    const m = (name, tee = true) => `<span class="mono">${esc(name)}</span>${tee ? ' <span class="chip ok">TEE · TDX</span>' : ""}`
    $("zg-models").innerHTML = `<thead><tr><th>Checkpoint</th><th>0G model</th><th>Question</th><th>Acts only if</th><th>Otherwise (safe)</th></tr></thead><tbody>
      <tr><td>burst</td><td>${m("vela-2.0-9b")}</td><td class="wrap">Has the balloon burst? (altitude history, vertical speed)</td><td class="ok">P(start_recovery) ≥ 0.8</td><td>hold, ask again in 30 s</td></tr>
      <tr><td>thermal</td><td>${m("vela-2.0-9b")}</td><td class="wrap">Should the camera keep running? (SoC temperature, limit)</td><td class="ok">P(continue) ≥ 0.8</td><td>pause the camera</td></tr>
      <tr><td>vision</td><td>${m("qwen3-vl-plus", false)} then ${m("laya")}</td><td class="wrap">Is this frame worth the radio? Then Laya reads the vision model's own words: does it say the image shows nothing?</td><td class="ok">drop and P(empty) ≥ 0.7</td><td>keep the frame on disk</td></tr>
      <tr><td>analysis</td><td>${m("0gm-1.0-35b-a3b")} then ${m("vela-2.0-9b")}</td><td class="wrap">An insight from Arkiv data, then Vela marks any claim the data does not support (span question)</td><td class="ok">stored with guardVerdict</td><td>nothing stored if 0G does not answer</td></tr>
      <tr><td>any</td><td colspan="2" class="wrap">0G unreachable, no key, timeout, or an answer that is not one of the allowed actions</td><td class="warn">safe stop</td><td>change nothing, delete nothing, log it, alert the beacon</td></tr></tbody>`
  }
  async function zgLoadLog() {
    if (ZG.records || !EP?.file) return
    const text = await (await fetch(EP.file)).text()
    ZG.lines = text.replace(/\0+/g, "\n").split("\n").filter(l => l.trim())
    ZG.records = ZG.lines.map(l => JSON.parse(l))
  }
  const answerOf = r => {
    if (r.safe_stop) return `<span class="warn">SAFE STOP</span> <span class="mono">${esc(String(r.error ?? "").split(":")[0])}</span>`
    const d = r.decision ?? {}, p = d.probabilities?.[d.action]
    return `<b>${esc(d.action)}</b>${p != null ? ` <span class="mono">P ${p.toFixed(3)}</span>` : ""}${d.check?.p_empty != null ? ` <span class="mono">· laya P(empty) ${d.check.p_empty.toFixed(2)}</span>` : ""}`
  }
  function zgRender() {
    const recs = ZG.records ?? [], withId = recs.filter(r => r.request_id).length, stops = recs.filter(r => r.safe_stop).length
    const live = S.pi.checkpoints ?? [], liveStops = live.filter(x => x.safeStop).length
    kpis("zg-kpis", [
      ["Signed decisions on 0G Storage", fmt(EP?.decisions ?? recs.length), "", `entry #${EP?.index ?? 0}`],
      ["With a 0G request ID", fmt(EP?.withRequestId ?? withId), "ok"],
      ["Safe stops", fmt(EP?.safeStops ?? stops), "warn", "0G unreachable"],
      ["Burst decision", EP?.burst ? `${EP.burst.action}` : "—", "ok", EP?.burst?.p ? `P ${EP.burst.p} · Vela` : ""],
      S.mode === "live" ? ["This session, live", fmt(live.length), "", `${live.length - liveStops} answered · ${liveStops} safe stops`] : ["Signatures valid", ZG.verified ? `${ZG.verified.ok}/${ZG.verified.n}` : "—", ZG.verified ? "ok" : "", ZG.verified ? "checked here" : "press Verify"]])
    const rows = recs.slice().reverse().slice(0, 40)
    $("zg-dec-note").textContent = recs.length ? `the signed log in registry entry #${EP.index}, newest first${S.mode === "live" ? " · live lines in Mission → Event log" : ""}` : "loading the signed log…"
    $("zg-decisions").innerHTML = `<thead><tr><th>Time (UTC)</th><th>Checkpoint</th><th>Model</th><th>0G answer</th><th>Action on the payload</th><th>0G request ID</th><th>Signature</th></tr></thead><tbody>${rows.map(r => {
      const i = recs.indexOf(r), v = ZG.verified?.ok != null ? ZG.verified.each[i] : null
      return `<tr><td>${new Date(r.ts * 1000).toISOString().slice(11, 19)}</td><td>${esc(r.checkpoint)}</td><td>${esc(r.model ?? "—")}${r.decision?.check ? " + laya" : ""}</td><td>${answerOf(r)}</td><td class="wrap">${esc(r.action_taken)}</td><td title="${esc(r.request_id)}">${esc(short(r.request_id ?? "") || "—")}</td><td class="${v === true ? "ok" : v === false ? "bad" : ""}">${v === true ? "✓ valid" : v === false ? "✕ invalid" : "not checked"}</td></tr>` }).join("")}</tbody>`
  }
  async function ethCall(to, data) {
    const r = await getJSON0G({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] })
    if (r.error) throw new Error(r.error.message); return r.result.slice(2)
  }
  async function getJSON0G(body) { const r = await timeout(fetch(X.zeroG.registry.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), 20000); return r.json() }
  const abiString = s => { const b = new TextEncoder().encode(s), hex = Array.from(b, x => x.toString(16).padStart(2, "0")).join(""); return "0".repeat(62) + "20" + b.length.toString(16).padStart(64, "0") + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0") }
  async function zgVerify() {
    const btn = $("zg-verify"), steps = $("zg-steps"), reg = X.zeroG.registry
    const step = (cls, html) => { const li = document.createElement("li"); li.className = cls; li.innerHTML = `<span>${html}</span>`; steps.append(li); return li }
    btn.disabled = true; steps.innerHTML = ""
    try {
      let s = step("run", `Reading <b>payloadKey()</b> from EpisodeRegistry ${short(reg.address)} on 0G Galileo (chain 16602)…`)
      const key = await ethCall(reg.address, reg.selectors.payloadKey)
      const same = key.toLowerCase() === X.keys.pi.toLowerCase()
      s.className = same ? "ok" : "bad"; s.firstChild.innerHTML = `Pi public key in the contract: <b>${key.slice(0, 16)}…</b> ${same ? "(the Pi's key)" : "(does not match this site's Pi key)"}`
      s = step("run", `Reading <b>latest("${esc(EP.run)}")</b> and <b>count</b>…`)
      const lat = await ethCall(reg.address, reg.selectors.latest + abiString(EP.run)), n = parseInt(await ethCall(reg.address, reg.selectors.count + abiString(EP.run)), 16)
      const root = "0x" + lat.slice(0, 64), dec = parseInt(lat.slice(64, 128), 16), stops = parseInt(lat.slice(128, 192), 16), at = parseInt(lat.slice(192, 256), 16)
      await zgLoadLog()
      const rootOk = root.toLowerCase() === EP.root.toLowerCase(), countOk = dec === ZG.records.length
      s.className = rootOk && countOk ? "ok" : "bad"
      s.firstChild.innerHTML = `${n} entries for ${esc(EP.run)}; the latest, recorded ${utc(at * 1000)}: root <b>${short(root)}</b> ${rootOk ? "= this log's 0G Storage root" : "≠ the root this site expects"}, ${dec} decisions ${countOk ? `= ${ZG.records.length} records in this file` : `≠ ${ZG.records.length} in this file`}, ${stops} safe stops`
      s = step("run", `Checking the Ed25519 signature of every record with that key…`)
      let pub
      try { pub = await crypto.subtle.importKey("raw", Uint8Array.from(key.match(/../g), h => parseInt(h, 16)), { name: "Ed25519" }, false, ["verify"]) }
      catch { s.className = "bad"; s.firstChild.innerHTML = "This browser has no Ed25519 in WebCrypto (Chrome 137+, Firefox 129+, Safari 17+ have it)."; btn.disabled = false; return }
      const each = []
      for (let i = 0; i < ZG.lines.length; i++) {
        const sig = Uint8Array.from(ZG.records[i].pi_sig.match(/../g), h => parseInt(h, 16))
        each.push(await crypto.subtle.verify({ name: "Ed25519" }, pub, sig, new TextEncoder().encode(pyCanon(ZG.lines[i], "pi_sig"))))
      }
      const ok = each.filter(Boolean).length
      ZG.verified = { ok, n: each.length, each }
      s.className = ok === each.length ? "ok" : "bad"; s.firstChild.innerHTML = `<b>${ok} of ${each.length}</b> signatures valid against the key read from 0G Chain`
      const t = structuredClone(ZG.records.findLast(r => r.decision?.action) ?? ZG.records[0]); const tl = ZG.lines[ZG.records.indexOf(ZG.records.findLast(r => r.decision?.action) ?? ZG.records[0])]
      const forged = tl.replace(/"action": "[a-z_]+"/, m => m.includes("hold") ? '"action": "start_recovery"' : '"action": "hold"')
      const fOk = await crypto.subtle.verify({ name: "Ed25519" }, pub, Uint8Array.from(t.pi_sig.match(/../g), h => parseInt(h, 16)), new TextEncoder().encode(pyCanon(forged, "pi_sig")))
      step(fOk ? "bad" : "ok", `A copy of the last decision with its action changed: ${fOk ? "accepted (this should not happen)" : "rejected"}`)
      step("ok", `The file's bytes are the ones uploaded to 0G Storage under that root; ${link(`${CHAINSCAN}/tx/${EP.storageTx}`, "storage transaction")}. Downloading it again with the root and comparing (zg/upload.mjs did) gives the same SHA-256.`)
    } catch (e) { step("bad", `Stopped: ${esc(e.message)}`) }
    btn.disabled = false; zgRender()
  }
  $("zg-verify").onclick = zgVerify

  // ------------------------------------------------------------------------------------- Hedera
  const HB = { msgs: [], timer: null, balances: {} }
  const ACCOUNTS = [["Paying agent (x402 over HTTP)", X.hedera.payer, "ECDSA key on the laptop"], ["Seller · payTo", X.hedera.merchant, "receives every sale; settles radio vouchers"],
    ["Buyer board (ground Heltec)", X.hedera.buyerBoard, "Ed25519 key made on the ESP32; it never leaves the board"], ["Facilitator fee payer (x402.org)", X.hedera.facilitatorFeePayer, "pays the network fee of x402 settlements"]]
  function hbStatic() {
    const t = X.hedera.auditTopic
    $("hb-links").innerHTML = [link(`https://hashscan.io/testnet/topic/${t}`, `HCS topic ${t}`), link(hsAcct(X.hedera.merchant), "Seller account"), link(hsAcct(X.hedera.buyerBoard), "Buyer board"), link("https://x402.org", "x402")].join("")
    $("hb-topic").textContent = `HCS topic ${t} · every sale, newest first · mirror node`
    const way = (title, steps, ex, exLabel, op) => `<div class="way"><h3>${title}</h3><ol>${steps.map(x => `<li>${x}</li>`).join("")}</ol>
      <div class="row">${link(hsTx(ex), exLabel)}${op && S.mode === "live" ? `<button class="btn" type="button" data-op="${op}">Run it now</button>` : ""}</div></div>`
    $("hb-ways").innerHTML = [
      way("x402 over HTTP", ["An agent asks for wind at an altitude", "The endpoint answers <b>402 Payment Required</b> with the price", "The agent signs a Hedera transfer; a facilitator settles it", "The data comes back with a proof for each frame"], "0.0.9185802@1793917447.840408407", "Example sale ↗", "op-buy"),
      way("Radio voucher, no internet", ["The buyer board signs a voucher and sends it over LoRa", "The beacon delivers wind computed on the Pi, signed", "On the ground the settler checks both signatures and recomputes the wind from signed frames", "It takes the price from the allowance the board signed"], "0.0.11327348@1793941589.246649214", "Example settlement ↗"),
      way("x402 over LoRa", ["REQ from the buyer board over LoRa", "<b>402</b> from the beacon: price, payTo, fee payer", "PAY: a Hedera transfer signed on the board; only 81 bytes cross the radio", "A facilitator settles it once a ground station hears it; then the beacon releases the data"], "0.0.9185802@1793919359.131480516", "Example, 30.6 s end to end ↗", "op-radio")].join("")
    for (const b of $("hb-ways").querySelectorAll("[data-op]")) b.onclick = () => { c.op(b.dataset.op); location.hash = "#/mission" }
  }
  const describe = j => j.kind === "radio-voucher" ? ["Radio voucher", `wind ${j.wind?.speed_ms} m/s at ${fmt(j.wind?.alt_m)} m · voucher ${j.nonce}`, j.buyer, j.price_tinybar]
    : j.kind === "x402-radio" ? ["x402 over LoRa", `challenge ${j.challenge} · signed on the ${j.signed_on ?? "board"}`, j.payer, j.amount_tinybar]
    : ["x402 over HTTP", esc(j.resource ?? ""), j.payer, j.amount_tinybar]
  async function hbLoad() {
    try {
      const r = await getJSON(`${MIRROR}/topics/${X.hedera.auditTopic}/messages?order=desc&limit=100`)
      HB.msgs = r.messages.map(m => { let j = {}; try { j = JSON.parse(atob(m.message)) } catch {} return { seq: m.sequence_number, at: Number(m.consensus_timestamp) * 1000, j } })
      await Promise.all(ACCOUNTS.map(async ([, id]) => { try { HB.balances[id] = (await getJSON(`${MIRROR}/accounts/${id}`)).balance.balance } catch {} }))
      HB.err = null
    } catch (e) { HB.err = e.message }
    hbRender()
  }
  function hbRender() {
    const sales = HB.msgs, total = sales.reduce((s, m) => s + Number(describe(m.j)[3] ?? 0), 0)
    kpis("hb-kpis", [["Sales on the audit topic", fmt(sales.length), "ok"], ["Paid for wind", `${(total / 1e8).toFixed(2)}`, "", "HBAR"],
      ["Kinds of payment", `${new Set(sales.map(m => describe(m.j)[0])).size}`, "", "HTTP · voucher · LoRa"], ["Last sale", sales[0] ? ago(sales[0].at) : "—", "", sales[0] ? utc(sales[0].at) : ""]])
    $("hb-audit").innerHTML = HB.err ? `<tbody><tr><td>Mirror node did not answer: ${esc(HB.err)}</td></tr></tbody>` : `<thead><tr><th>#</th><th>Consensus (UTC)</th><th>Kind</th><th>What</th><th>Payer</th><th>Amount</th><th>Transaction</th></tr></thead><tbody>${sales.map(m => {
      const [kind, what, payer, amt] = describe(m.j)
      return `<tr><td>${m.seq}</td><td>${utc(m.at).slice(0, 16)}</td><td>${kind}</td><td class="wrap">${what}</td><td>${payer ? link(hsAcct(payer), esc(payer)) : "—"}</td><td>${amt != null ? `${(Number(amt) / 1e8).toFixed(2)} ℏ` : "—"}</td><td>${m.j.tx ? link(hsTx(m.j.tx), esc(m.j.tx)) : "—"}</td></tr>` }).join("")}</tbody>`
    $("hb-accounts").innerHTML = `<thead><tr><th>Role</th><th>Account</th><th>Key</th><th>Balance</th></tr></thead><tbody>${ACCOUNTS.map(([role, id, key]) =>
      `<tr><td>${role}</td><td>${link(hsAcct(id), id)}</td><td class="wrap">${key}</td><td>${HB.balances[id] != null ? `${(HB.balances[id] / 1e8).toFixed(4)} ℏ` : "—"}</td></tr>`).join("")}
      <tr><td>Audit topic</td><td>${link(`https://hashscan.io/testnet/topic/${X.hedera.auditTopic}`, X.hedera.auditTopic)}</td><td class="wrap">HCS; one message per sale, written by the seller</td><td>—</td></tr></tbody>`
  }

  // ------------------------------------------------------------------------------------- Arkiv
  const TYPES = [["Packet", "boscon.hab.packet", "flight, run, beaconKey, seq, flightS, lat, lon, altM, verdict", "one per frame heard, with its verdict"],
    ["Run", "boscon.hab.run", "flight, run, beaconKey, startedAt", "one per ground-station session"],
    ["Wind", "boscon.hab.wind", "flight, dataset, source, phase, altM, altBandKm, flightS, speedMs, towardDeg, lat, lon", "measured on the balloon, or GFS"],
    ["Prediction", "boscon.hab.prediction", "flight, dataset, kind, fromFlightS, fromAltM, landLat, landLon, errorKm, windBands", "every Tawhiri landing prediction"],
    ["PublicFix", "boscon.hab.public", "dataset, kind, callsign, t, lat, lon, altM", "public balloons seen on SondeHub"],
    ["Insight", "boscon.hab.insight", "flight, dataset, topic, model, teeAttested, createdAt, guardModel, guardVerdict", "0G analyses, checked by Vela"]]
  function akStatic() {
    $("ak-links").innerHTML = [link(`${ARKIV_EXPLORER}/address/${X.arkiv.owner}`, "Ground-station wallet"), link("https://arkiv.network", "Arkiv")].join("")
    $("ak-types").innerHTML = `<div class="types">${TYPES.map(([n, t, idx, what]) => `<div><b>${n}</b><small>${what}</small><code>${t}</code><code>indexed: ${idx}</code></div>`).join("")}</div>`
  }
  function akRender() {
    const b = S.arkivBatches ?? []
    $("ak-sess-note").textContent = S.mode === "live" ? `${b.length} batches this session` : "archive mode"
    $("ak-session").innerHTML = S.mode !== "live" ? `<p class="status">On the ground station, every batch of verified frames appears here as it is confirmed.</p>`
      : b.length ? `<ul class="list">${b.slice(-10).reverse().map(x => `<li><span>${x.count} frames · seq ${x.seqs[0]}–${x.seqs.at(-1)} · ${x.ms} ms</span><span class="mono">${link(`${ARKIV_EXPLORER}/tx/${x.tx}`, x.tx)}</span></li>`).join("")}</ul>`
      : `<p class="status">No batch published yet this session.</p>`
  }

  // ------------------------------------------------------------------------------------- Flights
  const FL = { map: null, overlay: null, flights: [], sel: "hab1", loaded: false }
  const pathLen = pts => pts.reduce((s, p, i) => i ? s + dist({ lat: pts[i - 1][1], lon: pts[i - 1][0] }, { lat: p[1], lon: p[0] }) : 0, 0)
  const inRegion = ([lon, lat]) => lat >= REGION.minLat && lat <= REGION.maxLat && lon >= REGION.minLon && lon <= REGION.maxLon
  function addFlight(f) {
    const pts = f.pts.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    if (pts.length < 2) return
    Object.assign(f, { pts, maxAlt: Math.max(...pts.map(p => p[2] ?? 0)), len: pathLen(pts), first: pts[0], last: pts.at(-1) })
    FL.flights = FL.flights.filter(x => x.id !== f.id).concat(f); flRender()
  }
  async function flInit() {
    FL.map = new maplibregl.Map({ container: "fl-map", style: c.mapStyle(c.getTheme()), center: [79, 21], zoom: 3.6, attributionControl: { compact: true } })
    FL.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right")
    FL.overlay = new deck.MapboxOverlay({ interleaved: false, layers: [], getTooltip: ({ object }) => object?.name && { text: `${object.name}\n${object.sub}` } })
    FL.map.addControl(FL.overlay)
    // HAB-1, measured
    addFlight({ id: "hab1", group: "ours", kind: "track", name: "HAB-1 · 31 Oct 2026", sub: "measured, 1 Hz GPS log", startMs: Date.parse(F.release),
      pts: F.samples.map(s => [s.lon, s.lat, s.altM]), note: `burst ${fmt(F.burst.altM)} m · landed ${pos(F.landing.lat, F.landing.lon)}` })
    // the model's simulation of the same flight, made with the GFS forecast before launch
    if (P.hindcast?.track) addFlight({ id: "hind", group: "sim", kind: "pred", name: "Simulated · HAB-1's launch", sub: "Tawhiri on the GFS forecast for 31 Oct", startMs: Date.parse(P.hindcast.track[0].t),
      pts: P.hindcast.track.map(p => [p.lon, p.lat, p.alt]), note: `landing ${P.hindcast.errorKm.toFixed(2)} km from where HAB-1 really landed` })
    flSimulate(); flPublic()
    FL.map.on("load", flDraw)
  }
  // Tawhiri (SondeHub): the same balloon launched again from the same pad at the same time of day.
  async function flSimulate() {
    const rel = new Date(F.release), day = 86400e3
    let t = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), rel.getUTCHours(), rel.getUTCMinutes())
    if (t < Date.now() + 3600e3) t += day
    await Promise.all([0, 1, 2].map(async k => {
      const when = new Date(t + k * day).toISOString()
      const q = new URLSearchParams({ profile: "standard_profile", launch_latitude: F.pad.lat, launch_longitude: F.pad.lon, launch_altitude: F.pad.altM, launch_datetime: when,
        ascent_rate: P.balloonProfile.ascentMs, burst_altitude: P.balloonProfile.burstM, descent_rate: P.balloonProfile.slDescentMs })
      try {
        const r = await getJSON(`${SONDEHUB}/tawhiri?${q}`, 30000); if (r.error) throw new Error(r.error.description)
        const pts = r.prediction.flatMap(x => x.trajectory).map(p => [((p.longitude + 540) % 360) - 180, p.latitude, p.altitude]), e = pts.at(-1)
        const miss = dist({ lat: e[1], lon: e[0] }, F.landing) / 1000
        addFlight({ id: `sim${k}`, group: "sim", kind: "pred", name: `Simulated · launch ${when.slice(5, 10)} ${when.slice(11, 16)} UTC`, sub: `Tawhiri on today's GFS (${r.request?.dataset?.slice(0, 13) ?? "latest"})`,
          startMs: Date.parse(when), pts, note: `would land ${(miss).toFixed(1)} km from HAB-1's landing` })
      } catch (e) { FL.simErr = e.message; flRender() }
    }))
  }
  // Public balloons within 2,500 km of India this week: radiosondes and amateur balloons (SondeHub).
  async function flPublic() {
    try {
      const [sondes, amateur] = await Promise.all([getJSON(`${SONDEHUB}/sondes?lat=${INDIA.lat}&lon=${INDIA.lon}&distance=${INDIA.radiusM}`, 30000),
        getJSON(`${SONDEHUB}/amateur?lat=${INDIA.lat}&lon=${INDIA.lon}&distance=${INDIA.radiusM}&last=604800`, 30000)])
      const list = [...Object.entries(sondes).map(([id, v]) => ({ id, v, type: "sonde" })), ...Object.entries(amateur).map(([id, v]) => ({ id, v: v.lat != null ? v : Object.values(v).at(-1), type: "amateur" }))]
      FL.publicCount = list.length; flRender()
      for (const { id, v, type } of list) {
        try {
          let pts, sub
          if (type === "sonde") {
            const t = await getJSON(`${SONDEHUB}/sonde/${encodeURIComponent(id)}`, 30000)
            pts = t.filter((_, i) => i % 5 === 0).map(p => [p.lon, p.lat, p.alt])
            sub = `radiosonde ${v.type ?? ""} · heard by ${v.uploader_callsign ?? "?"}`
          } else {
            const t = await getJSON(`${SONDEHUB}/amateur/telemetry?payload_callsign=${encodeURIComponent(id)}&duration=7d`, 30000)
            const fixes = Object.values(t[id] ?? {}).sort((a, b) => a.datetime < b.datetime ? -1 : 1)
            pts = fixes.map(p => [p.lon, p.lat, p.alt]).filter(inRegion)
            sub = `amateur balloon · ${v.modulation ?? v.type ?? ""} · heard by ${v.uploader_callsign ?? "?"}`
          }
          addFlight({ id: `pub-${id}`, group: "public", kind: "pub", name: id, sub, startMs: Date.parse(v.datetime), pts,
            note: type === "sonde" ? `last fix ${pos(v.lat, v.lon)}` : `over the region until ${String(v.datetime).slice(0, 16).replace("T", " ")} UTC` })
        } catch {}
      }
    } catch (e) { FL.pubErr = e.message; flRender() }
  }
  function flDraw() {
    if (!FL.overlay) return
    const col = { track: rgb("--track"), pred: rgb("--predicted"), pub: rgb("--measured") }
    const data = FL.flights.slice().sort((a, b) => (a.id === FL.sel) - (b.id === FL.sel))
    FL.overlay.setProps({ layers: [
      new deck.PathLayer({ id: "fl-paths", data, getPath: f => f.pts.map(p => [p[0], p[1]]), getColor: f => [...col[f.kind], f.id === FL.sel ? 255 : f.kind === "pub" ? 120 : 190],
        getWidth: f => (f.id === FL.sel ? 3.5 : f.kind === "track" ? 2.5 : 1.5), widthUnits: "pixels", pickable: true, onClick: ({ object }) => object && flSelect(object.id),
        getDashArray: f => (f.kind === "pred" ? [6, 4] : [0, 0]), dashJustified: true, extensions: [new deck.PathStyleExtension({ dash: true })], updateTriggers: { getColor: FL.sel, getWidth: FL.sel } }),
      new deck.ScatterplotLayer({ id: "fl-ends", data, getPosition: f => [f.last[0], f.last[1]], getFillColor: f => [...col[f.kind], 230], getRadius: f => (f.id === FL.sel ? 5 : 3), radiusUnits: "pixels", updateTriggers: { getRadius: FL.sel } })] })
  }
  function flSelect(id, fly = true) {
    FL.sel = id; flRender(); const f = FL.flights.find(x => x.id === id)
    if (f && fly && FL.map) { const lons = f.pts.map(p => p[0]), lats = f.pts.map(p => p[1]); FL.map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 60, maxZoom: 9, duration: 700 }) }
  }
  function flRender() {
    const groups = [["ours", "Our flight"], ["sim", "Simulated (CUSF Tawhiri)"], ["public", "Around India this week (SondeHub, live)"]]
    const sorted = g => FL.flights.filter(f => f.group === g).sort((a, b) => (g === "public" ? b.startMs - a.startMs : a.startMs - b.startMs))
    $("fl-count").textContent = `${FL.flights.length} flights`
    $("fl-aside").innerHTML = [link("https://tawhiri.v2.sondehub.org", "CUSF Tawhiri"), link("https://sondehub.org", "SondeHub tracker"), link("https://amateur.sondehub.org", "Amateur tracker")].join("")
    $("fl-groups").innerHTML = groups.map(([g, title]) => { const fs = sorted(g)
      const empty = g === "sim" && !fs.some(f => f.id.startsWith("sim")) ? `<p class="status" style="padding:0 12px">${FL.simErr ? `SondeHub Tawhiri did not answer (${esc(FL.simErr)})` : "Running Tawhiri for the next three launches…"}</p>` : ""
        + (g === "public" && !fs.length ? `<p class="status" style="padding:0 12px">${FL.pubErr ? `SondeHub did not answer (${esc(FL.pubErr)})` : FL.publicCount === 0 ? "No public balloon within 2,500 km this week." : "Loading tracks from SondeHub…"}</p>` : "")
      return `<div class="fl-group"><h3>${title}</h3>${fs.map(f => `<div class="fl-row${f.id === FL.sel ? " sel" : ""}" data-id="${f.id}"><i class="${f.kind}"></i><div><b>${esc(f.name)}</b><small>${esc(f.sub)}</small></div><span class="mono">${fmt(f.maxAlt / 1000, 1)} km</span></div>`).join("")}${empty}</div>` }).join("")
    for (const r of $("fl-groups").querySelectorAll(".fl-row")) r.onclick = () => flSelect(r.dataset.id)
    const hab = FL.flights.find(f => f.id === "hab1")
    $("fl-table").innerHTML = `<thead><tr><th>Flight</th><th>Kind</th><th>Start (UTC)</th><th>Max altitude</th><th>Track length</th><th>Compared with HAB-1</th></tr></thead><tbody>${groups.flatMap(([g]) => sorted(g)).map(f =>
      `<tr class="${f.id === FL.sel ? "sel" : ""}" data-id="${f.id}"><td>${esc(f.name)}</td><td class="${f.kind === "track" ? "" : f.kind === "pred" ? "pred" : "meas"}">${f.kind === "track" ? "measured" : f.kind === "pred" ? "simulated" : "public"}</td><td>${Number.isFinite(f.startMs) ? utc(f.startMs).slice(0, 16) : "—"}</td><td>${fmt(f.maxAlt)} m</td><td>${fmt(f.len / 1000, 1)} km</td><td class="wrap">${esc(f.note ?? "")}${hab && f !== hab && f.kind === "pub" ? ` · peak ${f.maxAlt > hab.maxAlt ? "above" : "below"} HAB-1's ${fmt(hab.maxAlt)} m` : ""}</td></tr>`).join("")}</tbody>`
    for (const r of $("fl-table").querySelectorAll("tr[data-id]")) r.onclick = () => flSelect(r.dataset.id)
    flDraw()
  }

  // ------------------------------------------------------------------------------------- show / refresh
  return {
    show(page) {
      if (!started.has(page)) {
        started.add(page)
        if (page === "zerog") { zgStatic(); zgLoadLog().then(zgRender); c.loadInsights() }
        if (page === "hedera") { hbStatic(); hbLoad() }
        if (page === "arkiv") { akStatic(); c.arkivInit() }
        if (page === "flights") flInit()
      }
      clearInterval(HB.timer)
      if (page === "hedera") HB.timer = setInterval(hbLoad, 15000)
      if (page === "flights") requestAnimationFrame(() => FL.map?.resize())
      this.refresh()
    },
    refresh() {
      if (S.page === "zerog" && started.has("zerog")) zgRender()
      if (S.page === "arkiv" && started.has("arkiv")) akRender()
    },
  }
}
