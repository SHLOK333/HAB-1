# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Hackathon judges at ETHGlobal Mumbai (Nov 2026), including partner judges from Arkiv, 0G and Hedera. They see HAB-1 two ways, equally: live on a projector during a ~4-minute pitch driven by the team, and later on their own laptops from a public link with no one explaining it. The team is also an operator: during the live demo they run the ground station from a laptop with the ground LoRa board on USB and trigger demo actions (inject a fake frame, buy wind over x402, run analysis) in front of judges. Secondary: other balloon/CubeSat teams and recovery crews who would use verified telemetry.

## Product Purpose
HAB-1 is a verified telemetry and payment layer for things that fly beyond normal connectivity. The website shows a real flight (HAB-1, 31 Oct 2026, India) end to end: what the balloon measured, where models predicted it would land versus where it landed, what an AI concluded from the data, and that every piece is checkable on public infrastructure. Success: a judge understands in under a minute what is real, what is predicted, and what is proven, and can verify a claim themselves.

## Positioning
The data is not a demo dataset: it is a real flight's telemetry, signed on board, verified on the ground, stored on Arkiv with queryable attributes, and analysed by 0G models. Predictions use the Cambridge University Spaceflight (CUSF) Tawhiri flight model, then improve in flight by replacing forecast winds with winds the balloon itself measured.

## Operating Context
- Data comes from Arkiv (Rabdi testnet, chain 7794095) read in the browser, plus static JSON exported by `mission/`.
- Public balloons come from SondeHub (radiosondes and amateur flights) and are mirrored to Arkiv.
- Payments for data happen on Hedera testnet over x402; receipts are on HashScan and an HCS topic.
- Must be fully static so it can be hosted at a public URL and also served locally during the demo.

- Live mode: `station/server.mjs` on the laptop tails the verifier (frames heard, batch signatures, verdicts), the Arkiv publisher, the Hedera x402 endpoint and the Pi agent over SSH, re-predicts the landing with the Tawhiri model on every verified fix, and streams all of it to the console; operator actions run the project's own commands. Archive mode: the same console, statically hosted, replays the 31 Oct flight and any session recorded on Arkiv.
- Hardware in the live path: beacon Heltec (signs and transmits replayed flight frames over LoRa 866.1 MHz, carries the Pi's live barometer), ground Heltec (USB modem, signs vouchers and Hedera transactions with its on-chip key), Raspberry Pi 5 (sensors, wind computation, 0G checkpoints, tap line to the beacon).

## Capabilities and Constraints
- Flight: 127 fixes at 60 s, release 2026-10-31 07:07:06Z, burst 19,557 m at T+70 min, landing T+125 min, 62.69 km from the pad.
- Prediction: hindcast with GFS only lands 3.84 km from the real landing; re-predicted at burst with measured winds 1.58 km; uses the flown ascent rate and burst altitude (isolates wind-forecast error, must be labelled so).
- Arkiv entities (dataset mission-v1): 144 wind, 128 prediction, 33 public balloon snapshots; plus live packet/run entities from the ground station.
- 0G: as of 2026-11-06 the router lists no TEE-attested models and the API key has insufficient balance. Insights must never be shown as TEE-verified unless 0G attested the model; no insight may be fabricated.
- The 1 Hz flight log (51 GB card) is not available; only the 60 s track.

- Visual reference class (user brief, 2026-11-06): mature professional telemetry and operations software such as Foxglove Studio, NASA Open MCT and the SondeHub tracker; the earlier poster-like chart look was rejected as amateur.

## Brand Commitments
Name: HAB-1. Arkiv schema prefix `boscon.hab.*` (BosconSpace). Voice: precise, measured, factual; every number traceable to its source.

## Evidence on Hand
- `mission/data/flight-hab1.json`, `mission/data/predictions.json`, Arkiv entity keys in `mission/data/arkiv-published.jsonl`.
- README measurements (51.2 GB recorded vs 29.4 kB received; fake-frame rejection; Hedera transactions).
- No customers, testimonials or market data exist; do not invent any.

## Product Principles
1. Show the evidence, not the claim: every figure links to the record that proves it.
2. Real, predicted and inferred are always visually distinct and labelled.
3. Honest about what is not proven (TEE status, self-reported inputs, flown-profile hindcast).
4. The flight is the story: one continuous timeline from pad to landing ties every panel together.
