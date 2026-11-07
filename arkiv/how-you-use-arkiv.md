# How we use Arkiv

## Do the filters, owners and expiry fit what the app does?

| Arkiv feature | How we use it | What users see |
|---|---|---|
| Indexed `startedAt`, sorted descending | The site finds the newest session with no server telling it which | [hab-1.vercel.app](https://hab-1.vercel.app) opens on the newest session, "Live · Arkiv", when it is under 12 hours old |
| Indexed `run` + `seq` (`gte`) | Live from Arkiv polls every 20 s for `run = <newest> and seq >= <last seen + 1>` | New frames appear on the map with the radio animation, about a minute behind the radio, with our laptop out of the loop |
| Indexed `run` | One query returns one session's frames, paged 100 at a time | Pick any recorded session from the list and it plays back |
| Indexed `verdict` | The "Forged frames" preset; the 0G "verification" analysis counts frames per verdict | Red points for rejected fakes; the 0G page's analysis "Verifier caught all 13 attacks" |
| Indexed `altM`, `source`, `speedMs` (range filters with `gte`, `lte`, `and`) | Wind presets on the Arkiv page; the 0G jet-stream analysis reads `source = measured and altM >= 8000` | "Jet stream ≥ 20 m/s" and "10–15 km" in one click; the 0G analysis of the jet stream |
| Indexed `kind`, `errorKm` | The "Miss ≤ 1 km" preset; the 0G landing-error analysis reads `kind = inflight and errorKm <= 2` | Which predictions landed within a kilometre, and when in the flight they started to |
| Indexed `guardVerdict`, `createdAt` on 0G insights | The 0G page lists the newest analyses; `guardVerdict = supported` is one filter away | Each analysis with its model, 0G request ID and claim-check result |
| `boscon.hab.sig` with the raw 100-byte signature frame | The MCP server re-checks the beacon's signatures from Arkiv alone | `verify_session` shows what you can prove yourself, and any receiver whose verdict does not hold up |
| Owner = receiver wallet | Each receiver writes and can only change its own rows; the site and the MCP show the owner | Every frame says which wallet vouched for it; the MCP compares every receiver against its own check |
| Expiry: 7 days for frames and signature frames, 30 days for sessions, wind, predictions and analyses | A live position matters during the flight and the recovery; the session list and the analysis are useful for weeks | Old sessions stay listed after their points expire; the analyses stay for flight planning |
| `executeBatch` | One transaction per signed batch of 6 frames (plus its signature frame) | The live map advances in steps of about 6 points |

**Who can edit what:** only the wallet that wrote an entity can update or delete it. Packets, signature frames and sessions belong to the receiver that heard them. Wind, predictions, public balloons and 0G analyses belong to the ground-station wallet. When an analysis turned out wrong (7 Nov 2026: it said "no active attacks" when the data had 13 caught forgeries), the owner deleted it and wrote a corrected one. Nobody else could have done either.

## Measured on the testnet

| Item | Value |
|---|---|
| Writing a session (`retest-1106`, 6 Nov 2026) | 1 session entity, then a batch every 70 to 80 s (usually 6 packets), confirmed 5 to 12 s after sending |
| Gas | 205,815 for a session entity; 223,976 for 1 packet; 1,213,181 for 6 packets (about 200,000 per packet) |
| Time to confirm a batch | 4.5 to 10.5 s from send to receipt |
| Cost | 0.0218 tGLM over the first 19 transactions |
| Reading, no key | 12 newest 0G analyses in 0.46 to 0.58 s (Node, 7 Nov 2026); a whole session's frames and signature frames, checked by the MCP, in a few seconds |
| On Arkiv now (ground wallet, 7 Nov 2026) | 11 sessions, 2,160 frames, 372 signature frames, 144 winds, 128 predictions, 33 public positions, 22 analyses |
