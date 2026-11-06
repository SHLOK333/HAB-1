#!/usr/bin/env node
// Put the mission data on Arkiv, owned by the ground station's wallet:
//   wind         measured drift winds (one per fix) + the GFS profile over the pad
//   predictions  hindcast, every in-flight re-prediction, the live CUSF Tawhiri forecast
//   public       the public balloons on SondeHub right now (radiosondes + amateur)
//
//   node --env-file=../.env publish.mjs [wind] [predictions] [public]     (default: all)
// Skips a set that is already on Arkiv for this DATASET (count query), so reruns are safe.
import fs from "node:fs"
import path from "node:path"
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk"
import { privateKeyToAccount } from "viem/accounts"
import { rabdi } from "@arkiv-network/sdk/chains"
import { and, eq } from "@arkiv-network/sdk/query"
import { bytes, dec, i32, u64 } from "@arkiv-network/sdk/schema"
import { http } from "viem"
import { DATASET, DAYS, FLIGHT, Prediction, PublicFix, Wind } from "./schema.mjs"

const here = path.dirname(new URL(import.meta.url).pathname)
const want = process.argv.slice(2).filter(a => !a.startsWith("-"))
const doIt = k => want.length === 0 || want.includes(k)
const chain = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" })
const account = privateKeyToAccount(process.env.ARKIV_GROUND_PRIVATE_KEY)
const wallet = createWalletClient({ chain, transport: http(), account })
const reader = createPublicClient({ chain, transport: http() })
const LOG = path.join(here, "data", "arkiv-published.jsonl")
const d = (x, n) => dec(Number(x).toFixed(n))
const exp = ExpirationTime.fromDays(DAYS)

async function already(schema, where) {
  return Number(await reader.count().from(schema).where(where).ownedBy(account.address).fetch())
}
async function writeAll(label, schema, rows) {
  let done = 0
  for (let i = 0; i < rows.length; i += 15) {
    const batch = rows.slice(i, i + 15)
    for (let attempt = 1; ; attempt++) {
      try {
        const { txHash, createdEntities } = await wallet.executeBatch({ creates: batch.map(values => ({ schema, values, expiration: exp })) })
        for (const k of createdEntities ?? []) fs.appendFileSync(LOG, JSON.stringify({ label, dataset: DATASET, key: k, txHash }) + "\n")
        done += batch.length
        console.log(`  ${label}: ${done}/${rows.length}  tx ${txHash}`)
        break
      } catch (e) {
        if (attempt >= 4) throw e
        console.log(`  ${label}: batch failed (${(e.shortMessage ?? e.message).slice(0, 80)}), retry ${attempt}`)
        await new Promise(r => setTimeout(r, 2500 * attempt))
      }
    }
  }
}

console.log(`Arkiv ${chain.name} (${chain.id}) as ${account.address}, dataset ${DATASET}`)

if (doIt("wind")) {
  const n = await already(Wind, and(eq("flight", FLIGHT), eq("dataset", DATASET)))
  if (n) console.log(`wind: ${n} already on Arkiv, skipped`)
  else {
    const f = JSON.parse(fs.readFileSync(path.join(here, "data", "flight-hab1.json"), "utf8"))
    const p = JSON.parse(fs.readFileSync(path.join(here, "data", "predictions.json"), "utf8"))
    const rows = f.samples.filter(s => s.wind).map(s => ({
      flight: FLIGHT, dataset: DATASET, source: "measured", phase: s.phase, altM: i32(s.wind.atAltM),
      altBandKm: i32(Math.floor(s.wind.atAltM / 1000)), flightS: i32(s.flightS), speedMs: d(s.wind.speedMs, 2),
      towardDeg: d(s.wind.towardDeg, 1), lat: d(s.lat, 6), lon: d(s.lon, 6) }))
    for (const l of p.gfsProfileAtPad0700Z) rows.push({
      flight: FLIGHT, dataset: DATASET, source: "gfs", phase: "model", altM: i32(l.h), altBandKm: i32(Math.floor(l.h / 1000)),
      flightS: i32(-1), speedMs: d(l.speedMs, 2), towardDeg: d(l.towardDeg, 1), lat: d(f.pad.lat, 6), lon: d(f.pad.lon, 6) })
    await writeAll("wind", Wind, rows)
  }
}

if (doIt("predictions")) {
  const n = await already(Prediction, and(eq("flight", FLIGHT), eq("dataset", DATASET)))
  if (n) console.log(`predictions: ${n} already on Arkiv, skipped`)
  else {
    const p = JSON.parse(fs.readFileSync(path.join(here, "data", "predictions.json"), "utf8"))
    const enc = tr => bytes(Buffer.from(JSON.stringify(tr.map(q => [q.lat, q.lon, q.alt]))))
    const rows = [{ flight: FLIGHT, dataset: DATASET, kind: "hindcast", model: "Tawhiri model, GFS 2026-10-31 (Open-Meteo archive)",
      fromFlightS: i32(0), fromAltM: i32(p.actualLanding.altM), landLat: d(p.hindcast.landing.lat, 5), landLon: d(p.hindcast.landing.lon, 5),
      errorKm: d(p.hindcast.errorKm, 2), windBands: i32(0), track: enc(p.hindcast.track) }]
    for (const x of p.inflight) rows.push({ flight: FLIGHT, dataset: DATASET, kind: "inflight",
      model: "Tawhiri model, GFS + winds measured in flight", fromFlightS: i32(x.fromFlightS), fromAltM: i32(x.fromAltM),
      landLat: d(x.landing.lat, 5), landLon: d(x.landing.lon, 5), errorKm: d(x.errorKm, 2), windBands: i32(x.measuredBands), track: enc(x.track) })
    if (p.forecast?.track) rows.push({ flight: FLIGHT, dataset: DATASET, kind: "forecast", model: `CUSF Tawhiri live, launch ${p.forecast.launch}`.slice(0, 128),
      fromFlightS: i32(0), fromAltM: i32(0), landLat: d(p.forecast.landing.lat, 5), landLon: d(p.forecast.landing.lon, 5),
      errorKm: d(-1, 2), windBands: i32(0), track: enc(p.forecast.track) })
    await writeAll("predictions", Prediction, rows)
  }
}

if (doIt("public")) {
  const now = Math.floor(Date.now() / 1000)
  const rows = []
  for (const [kind, url] of [["radiosonde", "https://api.v2.sondehub.org/sondes/telemetry?duration=1h"],
                             ["amateur", "https://api.v2.sondehub.org/amateur/telemetry?duration=6h"]]) {
    const data = await (await fetch(url, { headers: { "accept-encoding": "gzip" } })).json()
    for (const [call, frames] of Object.entries(data)) {
      const ts = Object.keys(frames).sort(); const fr = frames[ts.at(-1)]
      const lat = fr.lat ?? fr.latitude, lon = fr.lon ?? fr.longitude, alt = fr.alt ?? fr.altitude
      if (lat == null || lon == null || alt == null) continue
      rows.push({ dataset: DATASET, kind, callsign: String(call).slice(0, 40), t: u64(Math.floor(Date.parse(fr.datetime ?? ts.at(-1)) / 1000) || now),
        lat: d(lat, 5), lon: d(lon, 5), altM: i32(Math.round(alt)), vzMs: d(fr.vel_v ?? 0, 2) })
    }
  }
  console.log(`public: ${rows.length} balloons on SondeHub now`)
  await writeAll("public", PublicFix, rows)
}
console.log("done")
