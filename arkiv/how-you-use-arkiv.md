# How we use Arkiv

## Filters, owners and expiry, and why each fits

| Feature | How we use it | What users see |
|---|---|---|
| Indexed `run` | The map pulls one session's packets in one query | Pick a session from the list, see its track |
| Indexed `startedAt`, sorted descending | The map finds the newest session without any server telling it | The page opens on the live session |
| Indexed `verdict` | Anyone can ask for only the fakes, or only verified frames | Red dots for rejected fakes, green track for verified |
| Indexed `lat`, `lon` (range filters with `gte`, `lte`, `and`) | Click anywhere on the map: one query for every packet within about 5 km, across every session and receiver | "75 packets near 17.864, 75.929: 10 sessions" in about 0.5 s, straight from Arkiv: what a recovery crew asks |
| Indexed `altM`, `flightS` | Queries by height or flight time | Not in the map UI; used from code (`arkiv/query.mjs` can be extended) |
| Indexed `beaconKey` | Follow one beacon across sessions | The key is shown under the map |
| Owner = receiver wallet | Each receiver writes only its own rows | One point per frame; its popup lists every receiver that heard it and each one's wallet and entity. The sidebar counts receiver wallets. Session `three-receivers-20261104`: 27 frames from 3 wallets (two of them labelled simulated) |
| Expiry 7 days (packets), 30 days (sessions) | Live data ages out; the session list lasts longer | Old sessions stay listed after their points are gone |
| `executeBatch` | One transaction per signed batch of 6 frames | The map updates in steps of about 6 points |

## Measured on the testnet (2 Nov 2026)

| Item | Value |
|---|---|
| Transactions, session `demo-20261102-a` | 4 to start: 1 session entity, then batches of 1, 7 and 6 packets, all status success (receipts fetched from the RPC) |
| Gas | 205,815 (session entity); 223,976 (1 packet); 1,413,625 (7 packets); 1,213,181 (6 packets), about 200,000 per packet |
| Time to confirm a batch | 4.5 to 10.5 s from send to receipt |
| Cost | 0.0218 tGLM over the first 19 transactions (wallet went from 3.0 to 2.978196431 tGLM) |
| Read back with no key | 1 session and 14 packets, the rejected fake included |
