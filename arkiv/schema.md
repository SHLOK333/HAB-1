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

## Writer wallets

| Receiver | Address |
|---|---|
| ground (the real ground station) | `0xfD07D94E26c518B26FcD5Ddb0fdb66E481Ac7b30` |
| sim1 (**simulated** receiver) | `0x6F9b0B20b13730Fe2c85d521D468240Bc035Be2a` |
| sim2 (**simulated** receiver) | `0xE060E504F61f344cAA0ce366409B032dFb8AF0E6` |

The simulated receivers republish the ground station's verified frames under their own
wallets (session `three-receivers-20261104`, 4 Nov 2026), to show ownership per receiver.
They heard nothing themselves: we have one ground radio. Their session note says so, and the
map marks them "(simulated)".

## A query you can run

```bash
cd arkiv && npm install && node query.mjs demo-20261102-a
```

It lists the sessions of `hab1-2026-10-31`, then every packet of one session, with
no access key and no backend.

A box query, as the map runs it when you click (indexed `lat` and `lon`):

```js
client.select({ run: true, seq: true, verdict: true, receiver: true, $owner: true }).from(Packet)
  .where(and(eq("flight", "hab1-2026-10-31"), gte("lat", dec("17.95")), lte("lat", dec("18.00")),
             gte("lon", dec("76.00")), lte("lon", dec("76.10")))).limit(100).fetch()
``` In code:

```js
client.select({ seq: true, lat: true, lon: true, verdict: true })
  .from(Packet).where(eq("run", "demo-20261102-a")).orderBy(asc("seq")).fetch()
```
