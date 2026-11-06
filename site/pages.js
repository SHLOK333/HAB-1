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
      <tr><td>vision</td><td>${m("qwen3-vl-plus", false)} then ${m("laya")}</td><td class="wrap">Is this frame worth sending? Laya confirms before anything is deleted</td><td class="ok">drop and P(empty) ≥ 0.7</td><td>keep the frame on disk</td></tr>
      <tr><td>analysis</td><td>${m("0gm-1.0-35b-a3b")} then ${m("vela-2.0-9b")}</td><td class="wrap">An insight from Arkiv data; Vela flags claims the data does not support</td><td class="ok">stored with guardVerdict</td><td>nothing stored if 0G does not answer</td></tr>
      <tr><td>decision models down</td><td>${m("glm-5.3")} then ${m("0gm-1.0-35b-a3b")} then ${m("qwen3.6-plus", false)}</td><td class="wrap">the same question to a 0G chat model, marked <b>fallback</b> in the signed log</td><td class="warn">its answer (no probability)</td><td>—</td></tr>
      <tr><td>any</td><td colspan="2" class="wrap">every 0G model unreachable, no key, timeout, or an answer that is not one of the allowed actions</td><td class="warn">safe stop</td><td>change nothing, delete nothing, log it, alert the beacon</td></tr></tbody>`
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
      return `<tr><td>${new Date(r.ts * 1000).toISOString().slice(11, 19)}</td><td>${esc(r.checkpoint)}</td><td>${esc(r.model ?? "—")}${r.decision?.check ? " + laya" : ""}${r.decision?.fallback ? ' <span class="chip warn">fallback</span>' : ""}</td><td>${answerOf(r)}</td><td class="wrap">${esc(r.action_taken)}</td><td title="${esc(r.request_id)}">${esc(short(r.request_id ?? "") || "—")}</td><td class="${v === true ? "ok" : v === false ? "bad" : ""}">${v === true ? "✓ valid" : v === false ? "✕ invalid" : "not checked"}</td></tr>` }).join("")}</tbody>`
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

  // ---- proofs: TEE signature of each decision, signer registered on 0G mainnet (zg/prove.mjs)
  const PROOF = { data: null, at: 0 }
  const MAINNET_RPC = "https://evmrpc.0g.ai", MAINNET_SCAN = "https://chainscan.0g.ai"
  async function zgLoadProofs() {
    const files = [S.mode === "live" && S.health?.session && `data/proofs-${S.health.session}.json`, X.zeroG.proofs].filter(Boolean)
    for (const f of files) { try { const r = await fetch(`${f}?t=${Date.now()}`); if (r.ok) { PROOF.data = await r.json(); PROOF.at = Date.now(); break } } catch {} }
    zgRenderProofs()
  }
  function zgRenderProofs() {
    const d = PROOF.data
    if (!d) { $("zg-proofs").innerHTML = `<tbody><tr><td>No proofs collected yet${S.mode === "live" ? ": the station collects them every 2 minutes while a session runs" : ""}.</td></tr></tbody>`; return }
    const proven = d.items.filter(i => i.ok), rest = d.items.filter(i => !i.ok && i.checkpoint !== "vision")
    $("zg-proof-check").disabled = !proven.length
    const row = i => `<tr><td>${new Date(i.ts * 1000).toISOString().slice(11, 19)}</td><td>${esc(i.checkpoint)}</td><td>${esc(i.model)}</td><td><b>${esc(i.action ?? "—")}</b></td>
      <td class="${i.ok ? "ok" : "warn"}">${i.ok ? "✓ signed in the enclave" : esc(i.status)}</td>
      <td>${i.teeSigner ? link(`${MAINNET_SCAN}/address/${i.teeSigner}`, short(i.teeSigner)) : "—"}</td><td title="${esc(i.image ?? "")}">${i.image ? esc(i.image.split("@")[1]?.slice(0, 19) ?? "") + "…" : "—"}</td><td>${i.sdk === true ? '<span class="ok">true</span>' : esc(String(i.sdk ?? "—"))}</td></tr>`
    $("zg-proofs").innerHTML = `<thead><tr><th>Time (UTC)</th><th>Checkpoint</th><th>Model</th><th>Decision</th><th>Proof</th><th>Enclave signer (0G mainnet)</th><th>Enclave image</th><th>0G SDK check</th></tr></thead><tbody>${[...proven].reverse().map(row).join("")}${rest.slice(-6).reverse().map(row).join("")}</tbody>
      <tfoot><tr><td colspan="8" class="wrap">${d.proven} of ${d.items.length} 0G decisions in run ${esc(d.run)} proven (checked ${esc(d.checkedAt.slice(0, 16).replace("T", " "))} UTC). Vision answers come from a standard-tier provider and carry no enclave signature; decisions from a provider that is down cannot be fetched until it is back.</td></tr></tfoot>`
  }
  async function zgProofCheck() {
    const it = [...(PROOF.data?.items ?? [])].reverse().find(i => i.ok); if (!it) return
    const btn = $("zg-proof-check"), steps = $("zg-proof-steps"); btn.disabled = true; steps.innerHTML = ""
    const step = (cls, html) => { const li = document.createElement("li"); li.className = cls; li.innerHTML = `<span>${html}</span>`; steps.append(li); return li }
    try {
      const { ethers } = await import("https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm")
      let s = step("run", `Reading the provider ${short(it.provider)} from the InferenceServing contract on 0G mainnet…`)
      const abi = ["function getService(address provider) view returns ((address provider, string serviceType, string url, uint256 inputPrice, uint256 outputPrice, uint256 updatedAt, string model, string verifiability, string additionalInfo, address teeSignerAddress, bool teeSignerAcknowledged) service)"]
      const svc = await new ethers.Contract(PROOF.data.servingContract, abi, new ethers.JsonRpcProvider(MAINNET_RPC)).getService(it.provider)
      let info = {}; try { info = JSON.parse(svc.additionalInfo) } catch {}
      s.className = svc.verifiability === "TeeML" ? "ok" : "bad"
      s.firstChild.innerHTML = `On chain: model <b>${esc(svc.model)}</b>, ${esc(svc.verifiability)}, enclave signer <b>${short(svc.teeSignerAddress)}</b>, image ${esc((info.ImageDigest ?? "").slice(0, 19))}…, verifier ${esc(info.TEEVerifier ?? "?")}`
      s = step("run", `Fetching the enclave's signature for the ${esc(it.checkpoint)} decision (${esc(it.action)}) from the provider…`)
      let sig = null
      try { sig = await (await fetch(`${svc.url}/v1/proxy/signature/${it.chatID}?model=${encodeURIComponent(svc.model)}`)).json() } catch {}
      const live = !!sig?.signature; if (!live) sig = { text: it.signedText, signature: it.signature }
      s.className = "ok"; s.firstChild.innerHTML = live ? `Provider returned the signature of response ${esc(it.chatID.slice(0, 8))}…: ${esc(sig.text.slice(0, 40))}…` : `The provider no longer holds it (kept about 20 minutes); using the copy the ground station fetched at ${esc(PROOF.data.checkedAt.slice(11, 16))} UTC`
      const rec = ethers.verifyMessage(sig.text, sig.signature), ok = rec.toLowerCase() === svc.teeSignerAddress.toLowerCase()
      step(ok ? "ok" : "bad", `Recovered signer <b>${short(rec)}</b> ${ok ? "= the enclave signer registered on 0G mainnet: this decision came from that model in that enclave" : "≠ the registered signer"}`)
      step("ok", `The Pi also signed the decision with its own key, and the log is on 0G Storage under the EpisodeRegistry root (see "Check the episode log yourself").`)
    } catch (e) { step("bad", `Stopped: ${esc(e.message)}`) }
    btn.disabled = false
  }
  $("zg-proof-check").onclick = zgProofCheck

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
    if ($("hb-ways")) $("hb-ways").innerHTML = [
      way("x402 over HTTP", ["An agent asks for wind at an altitude", "The endpoint answers <b>402 Payment Required</b> with the price", "The agent signs a Hedera transfer; a facilitator settles it", "The data comes back with a proof for each frame"], "0.0.9185802@1793917447.840408407", "Example sale ↗", "op-buy"),
      way("Radio voucher, no internet", ["The buyer board signs a voucher and sends it over LoRa", "The beacon delivers wind computed on the Pi, signed", "On the ground the settler checks both signatures and recomputes the wind from signed frames", "It takes the price from the allowance the board signed"], "0.0.11327348@1793941589.246649214", "Example settlement ↗"),
      way("x402 over LoRa", ["REQ from the buyer board over LoRa", "<b>402</b> from the beacon: price, payTo, fee payer", "PAY: a Hedera transfer signed on the board; only 81 bytes cross the radio", "A facilitator settles it once a ground station hears it; then the beacon releases the data"], "0.0.9185802@1793919359.131480516", "Example, 30.6 s end to end ↗", "op-radio")].join("")
    for (const b of $("hb-ways")?.querySelectorAll("[data-op]") ?? []) b.onclick = () => { c.op(b.dataset.op); location.hash = "#/mission" }
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
    loadCatalog(); sfInit(); meshInit()
    FL.map.on("load", flDraw)
  }
  // The flights anyone can pick, here or on the main map: HAB-1, Tawhiri simulations, SondeHub balloons.
  function loadCatalog() {
    if (FL.catalog) return; FL.catalog = true
    // HAB-1, measured
    addFlight({ id: "hab1", group: "ours", kind: "track", name: "HAB-1 · 31 Oct 2026", sub: "measured, 1 Hz GPS log", startMs: Date.parse(F.release),
      pts: F.samples.map(s => [s.lon, s.lat, s.altM, Date.parse(s.t)]), note: `burst ${fmt(F.burst.altM)} m · landed ${pos(F.landing.lat, F.landing.lon)}` })
    // the model's simulation of the same flight, made with the GFS forecast before launch
    if (P.hindcast?.track) addFlight({ id: "hind", group: "sim", kind: "pred", name: "Simulated · HAB-1's launch", sub: "Tawhiri on the GFS forecast for 31 Oct", startMs: Date.parse(P.hindcast.track[0].t),
      pts: P.hindcast.track.map(p => [p.lon, p.lat, p.alt, Date.parse(p.t)]), note: `landing ${P.hindcast.errorKm.toFixed(2)} km from where HAB-1 really landed` })
    flSimulate(); flPublic()
  }
  // Send a flight to the real beacon (station: /api/flight); it then transmits it over LoRa, signed.
  async function flyOnHardware(id) {
    const f = FL.flights.find(x => x.id === id); if (!f) return { ok: false, error: "unknown flight" }
    if (S.mode !== "live") return { ok: false, error: "only on the ground station (live mode)" }
    const timed = f.pts.filter(p => Number.isFinite(p[3]))
    const body = f.id === "hab1" ? { builtin: true } : { name: f.name.replace(/^Simulated · /, "Sim ").slice(0, 40), points: timed.map(p => [p[3], p[1], p[0], p[2] ?? 0]) }
    if (!body.builtin && timed.length < 2) return { ok: false, error: "this flight has no times to fly" }
    c.log("ops", `sending <b>${esc(f.name)}</b> to the beacon${body.points ? ` (${body.points.length} points, resampled to at most 180)` : ""}…`)
    const r = await fetch("/api/flight", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
    if (r.ok) c.toast("ok", "The beacon is flying a new flight", `${f.name} · signed and sent over LoRa like HAB-1's`)
    else c.toast("bad", "The beacon did not switch", r.error)
    c.log("ops", r.ok ? `<span class="ok">beacon now flying</span> ${esc(r.flight.name)}${r.flight.samples ? ` · ${r.flight.samples} samples, one every ${r.flight.stepS} s of flight` : ""}` : `<span class="bad">${esc(r.error)}</span>`)
    return r
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
        const pts = r.prediction.flatMap(x => x.trajectory).map(p => [((p.longitude + 540) % 360) - 180, p.latitude, p.altitude, Date.parse(p.datetime)]), e = pts.at(-1)
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
            pts = t.filter((_, i) => i % 5 === 0).map(p => [p.lon, p.lat, p.alt, Date.parse(p.datetime)])
            sub = `radiosonde ${v.type ?? ""} · heard by ${v.uploader_callsign ?? "?"}`
          } else {
            const t = await getJSON(`${SONDEHUB}/amateur/telemetry?payload_callsign=${encodeURIComponent(id)}&duration=7d`, 30000)
            const fixes = Object.values(t[id] ?? {}).sort((a, b) => a.datetime < b.datetime ? -1 : 1)
            pts = fixes.map(p => [p.lon, p.lat, p.alt, Date.parse(p.datetime)]).filter(inRegion)
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
      new deck.PathLayer({ id: "fl-paths", data, getPath: f => f.pts.map(p => [p[0], p[1]]), getColor: f => [...col[f.kind], M.on && !f.user ? 45 : f.id === FL.sel ? 255 : f.kind === "pub" ? 120 : 190],
        getWidth: f => (f.id === FL.sel ? 3.5 : f.kind === "track" ? 2.5 : 1.5), widthUnits: "pixels", pickable: true, onClick: ({ object }) => object && flSelect(object.id),
        getDashArray: f => (f.kind === "pred" ? [6, 4] : [0, 0]), dashJustified: true, extensions: [new deck.PathStyleExtension({ dash: true })], updateTriggers: { getColor: [FL.sel, M.on], getWidth: FL.sel } }),
      new deck.ScatterplotLayer({ id: "fl-ends", data, getPosition: f => [f.last[0], f.last[1]], getFillColor: f => [...col[f.kind], 230], getRadius: f => (f.id === FL.sel ? 5 : 3), radiusUnits: "pixels", updateTriggers: { getRadius: FL.sel } }),
      ...meshLayers()] })
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
      return `<div class="fl-group"><h3>${title}</h3>${fs.map(f => `<div class="fl-row${f.id === FL.sel ? " sel" : ""}" data-id="${f.id}"><i class="${f.kind}"></i><div><b>${esc(f.name)}</b><small>${esc(f.sub)}</small></div><span class="mono">${fmt(f.maxAlt / 1000, 1)} km${S.mode === "live" && f.pts.some(p => Number.isFinite(p[3])) ? ` <button class="fly" type="button" data-fly="${f.id}" title="The real beacon transmits this flight over LoRa">Fly</button>` : ""}</span></div>`).join("")}${empty}</div>` }).join("")
    for (const r of $("fl-groups").querySelectorAll(".fl-row")) r.onclick = e => { if (e.target.dataset.fly) return; flSelect(r.dataset.id) }
    for (const b of $("fl-groups").querySelectorAll("[data-fly]")) b.onclick = async e => { e.stopPropagation(); b.disabled = true; b.textContent = "…"; await flyOnHardware(b.dataset.fly); b.disabled = false; b.textContent = "Fly" }
    const hab = FL.flights.find(f => f.id === "hab1")
    $("fl-table").innerHTML = `<thead><tr><th>Flight</th><th>Kind</th><th>Start (UTC)</th><th>Max altitude</th><th>Track length</th><th>Compared with HAB-1</th></tr></thead><tbody>${groups.flatMap(([g]) => sorted(g)).map(f =>
      `<tr class="${f.id === FL.sel ? "sel" : ""}" data-id="${f.id}"><td>${esc(f.name)}</td><td class="${f.kind === "track" ? "" : f.kind === "pred" ? "pred" : "meas"}">${f.kind === "track" ? "measured" : f.kind === "pred" ? "simulated" : "public"}</td><td>${Number.isFinite(f.startMs) ? utc(f.startMs).slice(0, 16) : "—"}</td><td>${fmt(f.maxAlt)} m</td><td>${fmt(f.len / 1000, 1)} km</td><td class="wrap">${esc(f.note ?? "")}${hab && f !== hab && f.kind === "pub" ? ` · peak ${f.maxAlt > hab.maxAlt ? "above" : "below"} HAB-1's ${fmt(hab.maxAlt)} m` : ""}</td></tr>`).join("")}</tbody>`
    for (const r of $("fl-table").querySelectorAll("tr[data-id]")) r.onclick = () => flSelect(r.dataset.id)
    flDraw()
  }

  // ------------------------------------------------------------------------------------- simulate a flight
  // Real places in the region; the fleet launches five balloons at the same moment so the mesh has
  // something to connect. Altitudes are the sites' ground heights (approximate, m).
  const SITES = [["HAB-1 pad (Solapur district)", F.pad.lat, F.pad.lon, F.pad.altM], ["Pune", 18.5204, 73.8567, 560], ["Aurangabad", 19.8762, 75.3433, 568],
    ["Hyderabad", 17.385, 78.4867, 542], ["Kolhapur", 16.705, 74.2433, 549], ["Nagpur", 21.1458, 79.0882, 310], ["Mumbai", 19.076, 72.8777, 14], ["Bengaluru", 12.9716, 77.5946, 920],
    ["Ahmednagar", 19.0948, 74.748, 649], ["Pandharpur", 17.6746, 75.3237, 460], ["Vijayapura", 16.8302, 75.71, 606], ["Latur", 18.4088, 76.5604, 631], ["Kalaburagi", 17.3297, 76.8343, 454]]
  // six towns 55 to 230 km from our ground station: the far ones can only reach it through the near ones
  const FLEET = [1, 8, 9, 10, 11, 12]
  const SIM = { n: 0, picking: false }
  function nextLaunch() { const r = new Date(F.release); let t = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), r.getUTCHours(), r.getUTCMinutes()); if (t < Date.now() + 3600e3) t += 86400e3; return t }
  function sfInit() {
    $("sf-site").innerHTML = SITES.map(([n], i) => `<option value="${i}">${esc(n)}</option>`).join("") + `<option value="map">Point picked on the map</option>`
    const setSite = i => { const s = SITES[i]; $("sf-lat").value = s[1].toFixed(4); $("sf-lon").value = s[2].toFixed(4); SIM.alt = s[3] }
    setSite(0); $("sf-site").onchange = () => { if ($("sf-site").value !== "map") setSite(+$("sf-site").value) }
    $("sf-time").value = new Date(nextLaunch()).toISOString().slice(0, 16)
    $("sf-asc").value = P.balloonProfile.ascentMs; $("sf-burst").value = P.balloonProfile.burstM; $("sf-desc").value = P.balloonProfile.slDescentMs
    $("sf-pick").onclick = () => { SIM.picking = !SIM.picking; $("sf-pick").setAttribute("aria-pressed", SIM.picking); $("sf-status").textContent = SIM.picking ? "Click the map where the balloon launches." : "" }
    FL.map.on("click", e => { if (!SIM.picking) return; SIM.picking = false; $("sf-pick").setAttribute("aria-pressed", "false")
      $("sf-lat").value = e.lngLat.lat.toFixed(4); $("sf-lon").value = e.lngLat.lng.toFixed(4); $("sf-site").value = "map"; SIM.alt = 0; $("sf-status").textContent = `Launch point set to ${pos(e.lngLat.lat, e.lngLat.lng)}.` })
    $("sf-run").onclick = async () => {
      const lat = +$("sf-lat").value, lon = +$("sf-lon").value, when = new Date($("sf-time").value + "Z").toISOString()
      const name = $("sf-site").value === "map" ? pos(lat, lon) : SITES[+$("sf-site").value][0]
      $("sf-run").disabled = true; $("sf-status").textContent = "Running Tawhiri…"
      const f = await tawhiri({ name, lat, lon, alt: SIM.alt ?? 0, when, asc: +$("sf-asc").value, burst: +$("sf-burst").value, desc: +$("sf-desc").value })
      $("sf-run").disabled = false
      $("sf-status").textContent = f.error ? `Tawhiri did not answer: ${f.error}` : `${f.name}: lands ${pos(f.last[1], f.last[0])}, ${fmt(dist({ lat, lon }, { lat: f.last[1], lon: f.last[0] }) / 1000, 1)} km from launch, after ${fmt((f.ts.at(-1) - f.ts[0]) / 60000)} min.`
      if (!f.error) { flSelect(f.id); meshSetup() }
    }
    $("sf-fleet").onclick = async () => {
      const when = new Date($("sf-time").value + "Z").toISOString(); $("sf-fleet").disabled = true; $("sf-status").textContent = `Running Tawhiri for ${FLEET.length} launch sites…`
      const asc = +$("sf-asc").value, burst = +$("sf-burst").value, desc = +$("sf-desc").value
      for (const f of FL.flights.filter(f => f.user)) FL.flights.splice(FL.flights.indexOf(f), 1)     // a new fleet replaces the last one
      const res = await Promise.all(FLEET.map(i => tawhiri({ name: SITES[i][0], lat: SITES[i][1], lon: SITES[i][2], alt: SITES[i][3], when, asc, burst, desc, fleet: true })))
      $("sf-fleet").disabled = false
      const bad = res.filter(r => r.error)
      $("sf-status").textContent = bad.length ? `${res.length - bad.length} of ${FLEET.length} simulated; Tawhiri did not answer for ${bad.length}.` : `${FLEET.length} balloons launched ${when.slice(0, 16).replace("T", " ")} UTC from ${FLEET.map(i => SITES[i][0]).join(", ")}. Press Play in the mesh panel.`
      meshSetup(); flFitSim()
    }
  }
  async function tawhiri(o) {
    const q = new URLSearchParams({ profile: "standard_profile", launch_latitude: o.lat, launch_longitude: ((o.lon % 360) + 360) % 360, launch_altitude: o.alt, launch_datetime: o.when,
      ascent_rate: o.asc, burst_altitude: o.burst, descent_rate: o.desc })
    try {
      const r = await getJSON(`${SONDEHUB}/tawhiri?${q}`, 40000); if (r.error) throw new Error(r.error.description)
      const tr = r.prediction.flatMap(x => x.trajectory)
      const id = `user${++SIM.n}`
      addFlight({ id, group: "sim", kind: "pred", user: true, fleet: !!o.fleet, site: [o.lon, o.lat, o.alt], name: `Simulated · ${o.name}`, sub: `launch ${o.when.slice(5, 16).replace("T", " ")} UTC · ${o.asc} m/s · burst ${fmt(o.burst)} m`,
        startMs: Date.parse(o.when), pts: tr.map(p => [((p.longitude + 540) % 360) - 180, p.latitude, p.altitude, Date.parse(p.datetime)]), ts: tr.map(p => Date.parse(p.datetime)),
        note: `Tawhiri on GFS ${r.request?.dataset?.slice(0, 13) ?? ""}` })
      return FL.flights.find(f => f.id === id)
    } catch (e) { return { error: e.message } }
  }
  function flFitSim() {
    const fs = FL.flights.filter(f => f.user); if (!fs.length) return
    const all = fs.flatMap(f => f.pts), lons = all.map(p => p[0]), lats = all.map(p => p[1])
    FL.map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 70, maxZoom: 8, duration: 700 })
  }

  // ------------------------------------------------------------------------------------- mesh (simulated)
  // Radio model (computed, not measured): SX1262 at 14 dBm, 2.15 dBi antennas both ends, SF9 / 125 kHz
  // sensitivity -129 dBm (datasheet), 10 dB fade margin, free-space loss at 866.1 MHz; capped by the
  // radio horizon with a 4/3 Earth. That gives about 200 km: conservative next to the 702 to 832 km
  // balloon records, which used high-gain gateways and slower data rates.
  const RADIO = { txDbm: 14, antDbi: 2.15, marginDb: 10, fMHz: 866.1, sens: { 9: -129, 12: -137 } }   // SX1262 datasheet, 125 kHz
  const budgetKm = sf => 10 ** ((RADIO.txDbm + 2 * RADIO.antDbi - RADIO.sens[sf] - RADIO.marginDb - 32.45 - 20 * Math.log10(RADIO.fMHz)) / 20)
  let BUDGET_KM = budgetKm(9)
  const horizonKm = (h1, h2) => 4.12 * (Math.sqrt(Math.max(h1, 0)) + Math.sqrt(Math.max(h2, 0)))
  const FRAME_S = 60          // each balloon sends one telemetry frame per simulated minute
  const RELAY_FEE_HBAR = 0.001 // illustrative x402 price per relayed frame per hop
  const M = { on: false, playing: false, t: 0, t0: 0, t1: 0, last: 0, nextFrame: new Map(), packets: [], queue: new Map(), stats: null, raf: 0, log: [] }
  const km2 = (a, b) => dist({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] }) / 1000
  function meshFlights() { return FL.flights.filter(f => f.user && f.ts) }
  function meshSetup() {
    const fs = meshFlights(); if (!fs.length) return
    M.t0 = Math.min(...fs.map(f => f.ts[0])); M.t1 = Math.max(...fs.map(f => f.ts.at(-1))); M.t = M.t0
    M.nextFrame = new Map(); M.packets = []; M.queue = new Map(); M.log = []; M.routes = new Map()
    M.stats = { direct: 0, relayed: 0, buffered: 0, hops: 0, paySigned: 0, paySettled: 0, hbar: 0 }
    M.on = true; $("ms-play").disabled = false; $("ms-t").disabled = false; $("lg-mesh").hidden = false
    BUDGET_KM = budgetKm(+$("ms-sf").value)
    $("ms-note").innerHTML = `Simulated, not flown. Links use a computed radio model: SX1262 at 14 dBm, SF${$("ms-sf").value} / 125 kHz (sensitivity ${RADIO.sens[+$("ms-sf").value]} dBm), 2 dBi antennas, 10 dB margin, free space at 866 MHz, so about <b>${fmt(BUDGET_KM)} km</b>, capped by the radio horizon. SF12 reaches further but takes about 6 times the airtime of SF9, which is why the beacon uses SF9. Measured balloon LoRa records reach 702–832 km with high-gain ground antennas. Each relayed frame is paid with x402 over LoRa (REQ, 402, PAY, data, as in our two-board test, 30.6 s per purchase), at an illustrative ${RELAY_FEE_HBAR} HBAR per hop; the payment is signed on the paying balloon and settles on Hedera when it reaches a ground station. With no route to the ground, frames and payments wait on board.`
    meshStep(0); meshRender()
  }
  function nodesAt(t) {
    const balloons = meshFlights().filter(f => t >= f.ts[0] && t <= f.ts.at(-1)).map(f => {
      let i = f.ts.findIndex(x => x > t); if (i < 1) i = f.ts.length - 1
      const a = f.pts[i - 1], b = f.pts[i], k = Math.min(1, Math.max(0, (t - f.ts[i - 1]) / ((f.ts[i] - f.ts[i - 1]) || 1)))
      return { id: f.id, label: f.name.replace("Simulated · ", ""), kind: "balloon", p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k] } })
    const sites = $("ms-allgs").checked ? meshFlights().map(f => f.site) : [[F.pad.lon, F.pad.lat, F.pad.altM]]
    const ground = sites.filter((s, i, a) => a.findIndex(x => x[0] === s[0] && x[1] === s[1]) === i).map((s, i) => ({ id: `gs${i}`, label: i === 0 && !$("ms-allgs").checked ? "HAB-1 ground station" : "ground station", kind: "ground", p: [s[0], s[1], s[2] + 10] }))
    return { balloons, ground }
  }
  function graph(t) {
    const { balloons, ground } = nodesAt(t), all = [...balloons, ...ground], edges = []
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j]; if (a.kind === "ground" && b.kind === "ground") continue
      const d = km2(a.p, b.p); if (d <= Math.min(BUDGET_KM, horizonKm(a.p[2], b.p[2]))) edges.push({ a, b, d })
    }
    // breadth-first from every ground station: hops to the ground and the next hop on the way
    const adj = new Map(all.map(n => [n.id, []])); for (const e of edges) { adj.get(e.a.id).push(e.b); adj.get(e.b.id).push(e.a) }
    const hops = new Map(ground.map(g => [g.id, 0])), next = new Map(), q = [...ground]
    while (q.length) { const n = q.shift(); for (const m of adj.get(n.id)) if (!hops.has(m.id)) { hops.set(m.id, hops.get(n.id) + 1); next.set(m.id, n); q.push(m) } }
    return { balloons, ground, edges, hops, next }
  }
  const short2 = s => s.split(" (")[0]
  function mlog(cls, text) { M.log.unshift({ t: M.t, cls, text }); if (M.log.length > 60) M.log.pop() }
  function deliver(from, g, seq, buffered, quiet) {
    const path = [from]; let n = from; while (g.next.has(n.id)) { n = g.next.get(n.id); path.push(n) }
    const relays = path.slice(1, -1)
    if (!quiet) M.packets.push({ path, born: performance.now(), pay: relays.length > 0 })
    if (relays.length) {
      M.stats.relayed++; M.stats.hops += relays.length; M.stats.paySigned += relays.length; M.stats.paySettled += relays.length; M.stats.hbar += relays.length * RELAY_FEE_HBAR
      const route = `${relays.map(r => short2(r.label)).join(" → ")}`
      if (!quiet && (M.routes.get(from.id) !== route || seq % 15 === 0)) mlog("pay", `${short2(from.label)} frame ${seq} → ${route} → ground · pays ${relays.length} relay${relays.length > 1 ? "s" : ""} ${relays.length * RELAY_FEE_HBAR} HBAR over x402, settled when it lands at the ground station`)
      M.routes.set(from.id, route)
    } else { M.stats.direct++; if (M.routes.get(from.id) !== "") mlog("ok", `${short2(from.label)} in direct range of the ground station`); M.routes.set(from.id, "") }
  }
  function meshStep(dtSim) {
    const g = graph(M.t)
    for (const b of g.balloons) {
      const due = M.nextFrame.get(b.id) ?? M.t; if (M.t < due) continue
      M.nextFrame.set(b.id, due + FRAME_S * 1000)
      const seq = Math.round((M.t - M.t0) / (FRAME_S * 1000))
      if (g.hops.has(b.id)) {
        const waiting = M.queue.get(b.id) ?? []
        if (waiting.length) { mlog("ok", `${short2(b.label)} found a route: ${waiting.length} buffered frame${waiting.length > 1 ? "s" : ""} and their payments go down now`); waiting.forEach((s, i) => deliver(b, g, s, true, i > 0)); M.stats.buffered -= waiting.length; M.queue.set(b.id, []) }
        deliver(b, g, seq, false)
      } else {
        const w = M.queue.get(b.id) ?? []; w.push(seq); M.queue.set(b.id, w); M.stats.buffered++
        if (w.length === 1) mlog("warn", `${short2(b.label)} has no route to a ground station: frames wait on board`)
      }
    }
    M.g = g
  }
  function meshRender() {
    if (!M.on || !M.g) return
    const g = M.g, s = M.stats, direct = g.balloons.filter(b => g.hops.get(b.id) === 1).length, relay = g.balloons.filter(b => g.hops.get(b.id) > 1).length, iso = g.balloons.length - direct - relay
    $("ms-clock").textContent = `${new Date(M.t).toISOString().slice(11, 16)} UTC · T+${fmt((M.t - M.t0) / 60000)} min`
    $("ms-t").value = Math.round(((M.t - M.t0) / ((M.t1 - M.t0) || 1)) * 1000)
    kpis("ms-kpis", [["In the air", g.balloons.length, ""], ["Linked to the ground", direct, "ok", "direct"], ["Through other balloons", relay, "", "relay"], ["No route", iso, iso ? "warn" : ""],
      ["Frames relayed", fmt(s.relayed), "", `${fmt(s.direct)} direct`], ["x402 relay payments", fmt(s.paySettled), "ok", `${s.hbar.toFixed(3)} ℏ settled`], ["Waiting on board", fmt(s.buffered), s.buffered ? "warn" : ""]])
    $("ms-log").innerHTML = M.log.slice(0, 40).map(l => `<li><b>${new Date(l.t).toISOString().slice(11, 16)}</b><span class="${l.cls}">${esc(l.text)}</span></li>`).join("")
    flDraw()
  }
  function meshLayers() {
    if (!M.on || !M.g) return []
    const g = M.g, col = { ok: rgb("--nominal"), acc: rgb("--accent"), warn: rgb("--caution"), text: rgb("--text"), bg: rgb("--bg") }
    const now = performance.now(), HOP_MS = 450
    M.packets = M.packets.filter(p => now - p.born < (p.path.length - 1) * HOP_MS + 50)
    const pk = M.packets.map(p => { const k = Math.min((now - p.born) / HOP_MS, p.path.length - 1.0001), i = Math.floor(k), f = k - i, a = p.path[i].p, b = p.path[i + 1].p
      return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], pay: p.pay } })
    const st = b => (g.hops.get(b.id) === 1 ? col.ok : g.hops.has(b.id) ? col.acc : col.warn)
    return [
      new deck.LineLayer({ id: "ms-links", data: g.edges, getSourcePosition: e => [e.a.p[0], e.a.p[1]], getTargetPosition: e => [e.b.p[0], e.b.p[1]],
        getColor: e => (e.a.kind === "ground" || e.b.kind === "ground" ? [...col.ok, 170] : [...col.acc, 150]), getWidth: 1.5, widthUnits: "pixels" }),
      new deck.ScatterplotLayer({ id: "ms-ground", data: g.ground, getPosition: n => [n.p[0], n.p[1]], getFillColor: [...col.bg, 255], getLineColor: [...col.ok, 255], stroked: true, lineWidthMinPixels: 2, getRadius: 6, radiusUnits: "pixels" }),
      new deck.ScatterplotLayer({ id: "ms-balloons", data: g.balloons, getPosition: n => [n.p[0], n.p[1]], getFillColor: n => [...st(n), 255], getRadius: 6, radiusUnits: "pixels", stroked: true, getLineColor: [...col.bg, 255], lineWidthMinPixels: 1.5,
        pickable: true, updateTriggers: { getFillColor: M.t } }),
      new deck.TextLayer({ id: "ms-labels", data: g.balloons, getPosition: n => [n.p[0], n.p[1]], getText: n => `${short2(n.label)} · ${(n.p[2] / 1000).toFixed(1)} km`, getSize: 11, getColor: [...col.text, 230],
        getPixelOffset: [9, -9], getTextAnchor: "start", fontFamily: "Red Hat Mono, monospace", characterSet: "auto", updateTriggers: { getText: M.t } }),
      new deck.ScatterplotLayer({ id: "ms-packets", data: pk, getPosition: d => d.p, getFillColor: d => (d.pay ? [...col.acc, 255] : [...col.ok, 255]), getRadius: 3.5, radiusUnits: "pixels" })]
  }
  function meshTick(ts) {
    if (!M.playing || S.page !== "flights") { M.raf = 0; return }
    const dt = M.last ? Math.min(ts - M.last, 100) : 16; M.last = ts
    M.t = Math.min(M.t1, M.t + dt * +$("ms-speed").value)
    meshStep(); meshRender()
    if (M.t >= M.t1) { M.playing = false; $("ms-play").textContent = "Replay"; mlog("ok", "all balloons have landed"); meshRender(); M.raf = 0; return }
    M.raf = requestAnimationFrame(meshTick)
  }
  function meshInit() {
    $("ms-play").onclick = () => {
      if (!M.on) return
      if (M.t >= M.t1) meshSetup()
      M.playing = !M.playing; $("ms-play").textContent = M.playing ? "Pause" : "Play"; M.last = 0
      if (M.playing && !M.raf) M.raf = requestAnimationFrame(meshTick)
    }
    $("ms-t").oninput = () => { if (!M.on) return; M.t = M.t0 + ((M.t1 - M.t0) * $("ms-t").value) / 1000; M.nextFrame = new Map(); meshStep(); meshRender() }
    $("ms-allgs").onchange = () => { if (M.on) { meshStep(); meshRender() } }
    $("ms-sf").onchange = () => { if (M.on) { const t = M.t; meshSetup(); M.t = t; meshStep(); meshRender() } }
    $("ms-note").textContent = "Simulate a flight or a 5-balloon fleet; the mesh runs over every flight you simulate here."
    kpis("ms-kpis", [["In the air", "—"], ["Linked to the ground", "—"], ["Through other balloons", "—"], ["x402 relay payments", "—"]])
  }

  // ------------------------------------------------------------------------------------- show / refresh
  return {
    catalog: () => FL.flights,
    loadCatalog,
    fly: flyOnHardware,
    show(page) {
      if (!started.has(page)) {
        started.add(page)
        if (page === "zerog") { zgStatic(); zgLoadLog().then(zgRender); c.loadInsights(); zgLoadProofs() }
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
      if (S.page === "zerog" && started.has("zerog")) { zgRender(); if (Date.now() - PROOF.at > 60000) { PROOF.at = Date.now(); zgLoadProofs() } }
      if (S.page === "arkiv" && started.has("arkiv")) akRender()
    },
  }
}
