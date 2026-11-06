# Arkiv schema

Two entity types, defined once in `arkiv/schema.mjs` and used by the publisher
(`arkiv/publish.mjs`), the command-line reader (`arkiv/query.mjs`) and the public
map (`web/index.html`).

## `boscon.hab.packet`: one radio frame, as one receiver heard it

| Field | Type | Indexed | Meaning |
|---|---|---|---|
| `flight` | str | yes | Which flight the data belongs to, `hab1-2026-10-31` |
| `run` | str | yes | Which session (one replay through the radios) |
| `beaconKey` | str | yes | The beacon's Ed25519 public key, hex |
| `seq` | u64 | yes | The beacon's frame counter |
| `flightS` | i32 | yes | Seconds since release |
| `lat`, `lon` | dec | yes | Position, degrees. Indexed so anyone can ask for a box on the map |
| `altM` | i32 | yes | GPS altitude, m |
| `verdict` | str | yes | `verified`, `fake`, `bad_signature`, `unverified`, `replay` (a batch older than one already accepted) `conflict` (two frames for one seq both matched) or `unsigned` (heard, but its batch was never signed: the beacon restarted or the SIG frame was lost; never accepted) |
| `receiver` | str | no | Receiver name, for display |
| `rssi`, `snr` | dec | no | Signal as received, dBm and dB |
| `frame` | bytes | no | The 28 raw bytes as heard, so anyone can re-check the signature |

**Owner:** the wallet of the receiver that heard the frame. A receiver can only
write, edit or delete its own packets, so each one vouches only for what it heard.
**Expiry:** 7 days. A live position is useful during the flight and the recovery;
after that the session record and the raw logs carry the history.

## `boscon.hab.run`: one session

| Field | Type | Indexed | Meaning |
|---|---|---|---|
| `flight` | str | yes | As above |
| `run` | str | yes | Session name |
| `beaconKey` | str | yes | As above |
| `startedAt` | u64 | yes | Unix seconds; the map sorts on it to show the newest session |
| `receiver` | str | no | Who opened the session |
| `note` | str | no | One line describing the session |

**Owner:** the receiver that opened it. **Expiry:** 30 days, so the map can still
list a session after its packets are gone.

## `mission-v1`: the flight as data (`mission/schema.mjs`, written by `mission/publish.mjs` and `mission/analytics.mjs`)

All owned by the ground-station wallet, expire after 30 days (`DAYS`), dataset `mission-v1`.

| Entity | One per | Indexed (filterable) | Why it expires when it does |
|---|---|---|---|
| `boscon.hab.wind` | wind estimate, measured on the balloon (`source=measured`) or GFS (`source=gfs`) | flight, dataset, source, phase, altM, altBandKm, flightS, speedMs, towardDeg, lat, lon | useful for flight planning in the weeks after a flight |
| `boscon.hab.prediction` | Tawhiri landing prediction (`kind` = hindcast, inflight, forecast) | flight, dataset, kind, fromFlightS, fromAltM, landLat, landLon, errorKm, windBands | same |
| `boscon.hab.public` | public balloon position seen on SondeHub | dataset, kind, callsign, t, lat, lon, altM | comparison data, not ours to keep long |
| `boscon.hab.insight` | 0G analysis of the data above | flight, dataset, topic, model, teeAttested, createdAt, guardModel, guardVerdict | each records the Arkiv filter it read, the 0G request IDs of the model that wrote it and the model that checked it; `guardVerdict=supported` is one filter away |

Packet verdicts: `verified`, `fake`, `bad_signature`, `unverified`, `replay`, `conflict`, `unsigned`.
Only the owner wallet can update or delete an entity; nothing here is edited by anyone else.

## Writer wallets (new deployment, 6 Nov 2026)

| Receiver | Address |
|---|---|
| ground (the real ground station), also writes `mission-v1` | `0x532cCE61F117A394D595E9fb7069f4D6CE3Bb047` |
| sim1 (**simulated** receiver) | `0xAE1796225FFdf537eF8122dA92ACDE3D1aE9b363` |
| sim2 (**simulated** receiver) | `0xeeeB58826006087868079C27159838a3B694721e` |

Every read in the console and in `arkiv/query.mjs` is filtered with `.ownedBy()` to these
wallets, so entities written by the old wallets (before 6 Nov 2026) never appear. The simulated
receivers would republish the ground station's verified frames under their own wallets, to
show ownership per receiver; they hear nothing themselves (we have one ground radio), and the
map marks them "(simulated)".

## A query you can run

```bash
cd arkiv && npm install && node query.mjs live-11060722
```

It lists the sessions of `hab1-2026-10-31`, then every packet of one session, with
no access key and no backend.

A box query, as the map runs it when you click (indexed `lat` and `lon`):

```js
client.select({ run: true, seq: true, verdict: true, receiver: true, $owner: true }).from(Packet)
  .where(and(eq("flight", "hab1-2026-10-31"), gte("lat", dec("17.95")), lte("lat", dec("18.00")),
             gte("lon", dec("76.00")), lte("lon", dec("76.10")))).ownedBy("0x532cCE61F117A394D595E9fb7069f4D6CE3Bb047").limit(100).fetch()
``` In code:

```js
client.select({ seq: true, lat: true, lon: true, verdict: true })
  .from(Packet).where(eq("run", "live-11060722")).ownedBy("0x532cCE61F117A394D595E9fb7069f4D6CE3Bb047").orderBy(asc("seq")).fetch()
```
