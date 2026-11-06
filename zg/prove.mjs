#!/usr/bin/env node
// Proof of which model made each payload decision.
//
// For every decision in a Pi episode log that a 0G model answered, this does the independent
// check 0G documents ("Verifiable Execution", without trusting the Router):
//   1. read the provider's service record from the InferenceServing contract on 0G mainnet:
//      its model, verifiability (TeeML), TEE signer address, enclave image and verifier;
//   2. GET {url}/v1/proxy/signature/{chatID}?model=...  -> { text, signature }
//   3. recover the EIP-191 signer and compare it with the TEE signer on chain;
//   4. ask 0G's own SDK (processResponse) for the same verdict.
// The result goes to zg/proofs/<run>.json and site/data/proofs-<run>.json, so the console can
// show it and a browser can redo steps 1 to 3 itself.
//
//   node --env-file=../.env prove.mjs <run> [episode.jsonl]
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { ethers } from "ethers"
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk"

const here = path.dirname(new URL(import.meta.url).pathname)
const run = process.argv[2]; if (!run) throw new Error("usage: prove.mjs <run> [episode.jsonl]")
const MAINNET_RPC = "https://evmrpc.0g.ai", SERVING = "0x47340d900bdFec2BD393c626E12ea0656F938d84"   // InferenceServing, 0G mainnet (chain 16661)
const SERVICE_ABI = ["function getService(address provider) view returns ((address provider, string serviceType, string url, uint256 inputPrice, uint256 outputPrice, uint256 updatedAt, string model, string verifiability, string additionalInfo, address teeSignerAddress, bool teeSignerAcknowledged) service)"]
const ROUTER = process.env.ZG_PC_BASE_URL || "https://router-api.0g.ai/v1"

// the log: given, or fetched from the Pi
let file = process.argv[3]
if (!file) {
  file = path.join(here, "episodes", `${run}.jsonl`); fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync(path.join(here, "..", "tools", "pi.sh"), [`cat ~/ethglobal/episodes/${run}.jsonl`], { stdio: ["ignore", fs.openSync(file, "w"), "inherit"] })
}
const recs = fs.readFileSync(file, "utf8").replace(/\0+/g, "\n").split("\n").filter(l => l.trim()).map(l => JSON.parse(l))

const rpc = new ethers.JsonRpcProvider(MAINNET_RPC)
const serving = new ethers.Contract(SERVING, SERVICE_ABI, rpc)
const broker = await createZGComputeNetworkBroker(ethers.Wallet.createRandom().connect(rpc))
const services = new Map(), providersByModel = new Map()
async function providerFor(r) {
  if (r.provider) return r.provider
  if (!providersByModel.has(r.model)) {
    const j = await (await fetch(`${ROUTER}/providers?model=${encodeURIComponent(r.model)}`, { headers: { Authorization: `Bearer ${process.env.ZG_PC_API_KEY}` } })).json()
    providersByModel.set(r.model, (j.data ?? []).map(p => p.address))
  }
  return providersByModel.get(r.model)[0] ?? null
}
async function service(addr) {
  if (!services.has(addr)) {
    let s
    try { s = await serving.getService(addr) }
    catch { services.set(addr, { verifiability: "standard (not a registered 0G TEE service)" }); return services.get(addr) }
    let info = {}; try { info = JSON.parse(s.additionalInfo) } catch {}
    services.set(addr, { url: s.url, model: s.model, verifiability: s.verifiability, teeSigner: s.teeSignerAddress, acknowledged: s.teeSignerAcknowledged,
      image: info.ImageName ? `${info.ImageName}@${info.ImageDigest}` : null, verifier: info.TEEVerifier ?? null, verifierUrl: info.VerifierURL ?? null })
  }
  return services.get(addr)
}

const items = []
for (const r of recs) {
  if (!r.response_id || r.safe_stop) continue
  const chatID = String(r.response_id).replace(/^chatcmpl-/, "")
  const base = { ts: r.ts, checkpoint: r.checkpoint, model: r.model, action: r.decision?.action, chatID, fallback: !!r.decision?.fallback }
  try {
    const provider = await providerFor(r)
    if (!provider) { items.push({ ...base, status: "no provider listed for this model now" }); continue }
    const svc = await service(provider)
    if (svc.verifiability !== "TeeML") { items.push({ ...base, provider, verifiability: svc.verifiability || "standard", status: "no TEE signature for this tier" }); continue }
    const sig = await (await fetch(`${svc.url}/v1/proxy/signature/${chatID}?model=${encodeURIComponent(svc.model)}`)).json()
    if (!sig.signature) { items.push({ ...base, provider, ...svc, status: `provider returned no signature (${JSON.stringify(sig).slice(0, 80)})` }); continue }
    const recovered = ethers.verifyMessage(sig.text, sig.signature)
    let sdk = null; try { sdk = await broker.inference.processResponse(provider, chatID) } catch (e) { sdk = `error: ${e.message.slice(0, 60)}` }
    const ok = recovered.toLowerCase() === svc.teeSigner.toLowerCase()
    items.push({ ...base, provider, ...svc, signedText: sig.text, signature: sig.signature, recovered, ok, sdk, status: ok ? "signed in the enclave" : "signer does not match the chain" })
  } catch (e) { items.push({ ...base, status: `error: ${e.message.slice(0, 100)}` }) }
  const it = items.at(-1)
  if (!it.ok && !process.env.VERBOSE && it.checkpoint === "vision") continue
  console.log(`${new Date(r.ts * 1000).toISOString().slice(11, 19)} ${r.checkpoint.padEnd(8)} ${String(r.model).padEnd(16)} ${String(it.action).padEnd(15)} ${it.ok ? "PROVEN" : "      "} ${it.status}${it.sdk != null ? `  (0G SDK: ${it.sdk})` : ""}`)
}
const byStatus = {}; for (const i of items) byStatus[`${i.model}: ${i.status}`] = (byStatus[`${i.model}: ${i.status}`] ?? 0) + 1
console.log(Object.entries(byStatus).map(([k, n]) => `  ${n} × ${k}`).join("\n"))
const out = { run, chain: "0G mainnet (16661)", servingContract: SERVING, checkedAt: new Date().toISOString(), proven: items.filter(i => i.ok).length, items }
fs.mkdirSync(path.join(here, "proofs"), { recursive: true })
fs.writeFileSync(path.join(here, "proofs", `${run}.json`), JSON.stringify(out, null, 1))
fs.writeFileSync(path.join(here, "..", "site", "data", `proofs-${run}.json`), JSON.stringify(out, null, 1))
console.log(`\n${out.proven} of ${items.length} 0G decisions proven to come from a TEE whose signer is registered on 0G mainnet; written to zg/proofs/${run}.json`)
