#!/usr/bin/env node
// Compile EpisodeRegistry.sol with solc-js and deploy it on 0G Galileo testnet (chain 16602).
// Writes ZG_REGISTRY_ADDRESS into ../.env.
//
//   node --env-file=../.env deploy.mjs <payload Pi Ed25519 public key, hex>
import fs from "node:fs"
import path from "node:path"
import solc from "solc"
import { ethers } from "ethers"

const here = path.dirname(new URL(import.meta.url).pathname)
const envPath = path.join(here, "..", ".env")
const piKey = (process.argv[2] ?? "").replace(/^0x/, "")
if (!/^[0-9a-f]{64}$/i.test(piKey)) throw new Error("pass the Pi's Ed25519 public key (64 hex characters)")

const src = fs.readFileSync(path.join(here, "EpisodeRegistry.sol"), "utf8")
const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { "EpisodeRegistry.sol": { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun",
              outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
})))
const errs = (out.errors ?? []).filter(e => e.severity === "error")
if (errs.length) throw new Error(errs.map(e => e.formattedMessage).join("\n"))
const c = out.contracts["EpisodeRegistry.sol"].EpisodeRegistry
fs.writeFileSync(path.join(here, "EpisodeRegistry.abi.json"), JSON.stringify(c.abi, null, 2))

const provider = new ethers.JsonRpcProvider(process.env.ZG_EVM_RPC || "https://evmrpc-testnet.0g.ai")
const wallet = new ethers.Wallet(process.env.ZG_PRIVATE_KEY, provider)
console.log(`deployer ${wallet.address}: ${ethers.formatEther(await provider.getBalance(wallet.address))} 0G`)
const factory = new ethers.ContractFactory(c.abi, c.evm.bytecode.object, wallet)
const contract = await factory.deploy("0x" + piKey)
const rcpt = await contract.deploymentTransaction().wait()
const addr = await contract.getAddress()

let t = fs.readFileSync(envPath, "utf8")
t = /^ZG_REGISTRY_ADDRESS=/m.test(t) ? t.replace(/^ZG_REGISTRY_ADDRESS=.*$/m, `ZG_REGISTRY_ADDRESS=${addr}`) : t + `\nZG_REGISTRY_ADDRESS=${addr}\n`
fs.writeFileSync(envPath, t, { mode: 0o600 })
console.log(`EpisodeRegistry deployed at ${addr}  tx ${rcpt.hash}  block ${rcpt.blockNumber}  gas ${rcpt.gasUsed}`)
console.log(`https://chainscan-galileo.0g.ai/address/${addr}`)
