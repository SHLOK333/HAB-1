# HAB-1 Edge Node

A high-altitude balloon payload that **decides on board, proves what it saw, and sells what
it computes**, over a radio link of a few hundred bytes a minute.

Built at ETHGlobal Mumbai by Boscon Space, on the hardware that flew HAB-1 on 31 Oct 2026.
Partner tracks: **0G** (Physical AI), **Hedera** (x402 agents that pay), **Arkiv** (build on Arkiv).

> Every number in this file says where it comes from: **measured** (logged by our own
> hardware or read back from a chain), **computed** (arithmetic on measured values, method
> given), **datasheet**, or **assumed**. Things that are not done are listed in
> [What is not done](#what-is-not-done).

**Live demo: [hab-1.vercel.app](https://hab-1.vercel.app).** When a session is running, the public site follows it **live from Arkiv** ("Live · Arkiv"): it reads the newest session's verified frames from Arkiv every 20 s and plays them with the same animations, about a minute behind the radio, with no connection to our laptop. Otherwise it shows the recorded flight and sessions. The hardware controls (start, fly, inject) run on the ground-station laptop at `localhost:8090`.

### For judges: where to look

**[PARTNERS.md](PARTNERS.md): why we use 0G, Hedera and Arkiv, with a link to every line of code where each one is used.**

The ground-station console has one page per track. Each page reads public sources and lets
you check the claims yourself, in your browser:

| Page | What you can check there |
|---|---|
| **0G** (`#/zerog`) | how each payload decision is made (Vela 2.0 9B, Laya, gates); every signed decision with its 0G request ID; **Verify in this browser** reads the Pi's key and the latest log root from EpisodeRegistry on 0G Chain and checks all the log's Ed25519 signatures |
| **Hedera** (`#/hedera`) | every sale on the HCS audit topic and the account balances, read live from the mirror node |
| **Arkiv** (`#/arkiv`) | attribute-filter queries against Arkiv from your browser, the six entity types and their indexed attributes, and the batches written this session |
| **Protocol** (`#/protocol`) | each LoRa frame as it is received, byte by byte; the browser recomputes the salted hashes and checks the beacon's signature itself |
| **Flights** (`#/flights`) | HAB-1 next to Tawhiri simulations of it, a new forecast for launching again, and the balloons over India this week (SondeHub); **simulate your own flight** (site, time, ascent, burst, descent) or a 5-balloon fleet, and play a **simulated LoRa mesh** over it in which balloons relay each other's frames and pay for each relay with x402 |

Live, the console is served by the ground-station laptop (`./demo.sh start`, then
`http://localhost:8090`). Without the hardware, serve `site/` with any static server and the
same pages open in Archive mode.

### Contracts and on-chain addresses

Everything this deployment wrote or relies on, in one place (all new on 5 to 6 Nov 2026).

**0G Galileo testnet** (chain 16602, [chainscan-galileo.0g.ai](https://chainscan-galileo.0g.ai)): our one smart contract

| What | Address / transaction |
|---|---|
| **EpisodeRegistry** (stores the Pi's public key and each episode log's 0G Storage root) | [`0xF7D35D2cAf0319384E3dfA2c10157f9d0B57b8Be`](https://chainscan-galileo.0g.ai/address/0xF7D35D2cAf0319384E3dfA2c10157f9d0B57b8Be) |
| Deploy transaction | [`0xb653aaa2abf748ac289e454629727cd578c22005ce2c65d2251dade3be9674d6`](https://chainscan-galileo.0g.ai/tx/0xb653aaa2abf748ac289e454629727cd578c22005ce2c65d2251dade3be9674d6), block 64,102,739 |
| Deployer and recorder wallet | `0xb26Bf4A2D754b22Bc73CE447f08A7AA83dd2AEEe` |
| Registry entry #0, run `retest-1106` (38 decisions) | tx [`0x1736318e…73c3`](https://chainscan-galileo.0g.ai/tx/0x1736318e0ce290bb822cbbb3106806cf70a61220b40770c4ebd599115cac73c3) · 0G Storage root `0x169b92e8635511f7584db2a5f1edb612584be24624befb5360effa36d8dd15eb` · storage tx `0x38a55260f0a1ef0f5275371c4798d970fc398325961868b3c326f7f37acd5df4` |
| Registry entry #1, run `retest-1106` (99 decisions, 66 with a 0G request ID) | tx [`0x2b9fe7b2…a810`](https://chainscan-galileo.0g.ai/tx/0x2b9fe7b2955e89a71686ef1e2d5bc97804c8d626ab64d882ef907da065f3a810) · 0G Storage root `0x224acb0973c95f2c78ebda79deec91ae3d810046d2a7e00ea79d19cff9e51563` · storage tx `0x47779295b33a4d398b4404d35c6d1bcb460fd3a0a73ca4f2c84589c72ca835f9` |

**0G mainnet** (chain 16661, [chainscan.0g.ai](https://chainscan.0g.ai)): read, not deployed by us, to prove which model made each decision

| What | Address |
|---|---|
| 0G's InferenceServing contract (provider registry) | [`0x47340d900bdFec2BD393c626E12ea0656F938d84`](https://chainscan.0g.ai/address/0x47340d900bdFec2BD393c626E12ea0656F938d84) |
| glm-5.3 provider (TeeML) | `0xD179F4526064846dE9a9E9D93683AF75CB72E503` |
| Its enclave (TEE) signer, which signed the proven payload decisions | [`0x0766BC72beB6dAe764eE51C781c0A68117E69179`](https://chainscan.0g.ai/address/0x0766BC72beB6dAe764eE51C781c0A68117E69179) |

**Hedera testnet** ([hashscan.io/testnet](https://hashscan.io/testnet)): no smart contracts; native services only (accounts, allowances, HCS)

| What | Account / topic |
|---|---|
| Paying agent (x402 over HTTP) | [`0.0.11326830`](https://hashscan.io/testnet/account/0.0.11326830) |
| Seller, x402 `payTo` | [`0.0.11327348`](https://hashscan.io/testnet/account/0.0.11327348) |
| Buyer board (ground Heltec; Ed25519 key made on the ESP32) | [`0.0.11327397`](https://hashscan.io/testnet/account/0.0.11327397) |
| HCS audit topic (one message per sale) | [`0.0.11327351`](https://hashscan.io/testnet/topic/0.0.11327351) |
| Allowance signed on the board (1 HBAR to the seller) | [`0.0.11326830@1793898902.991873791`](https://hashscan.io/testnet/transaction/0.0.11326830-1793898902-991873791) |
| Facilitators used | x402.org (fee payer `0.0.9185802`), Blocky402 (fee payer `0.0.7162784`) |

**Arkiv Rabdi testnet** (chain 7794095, [rabdi.explorer.arkiv.network](https://rabdi.explorer.arkiv.network)): no contract; entities owned by these wallets

| What | Wallet |
|---|---|
| Ground station (packets, runs, wind, predictions, public balloons, 0G insights) | [`0x532cCE61F117A394D595E9fb7069f4D6CE3Bb047`](https://rabdi.explorer.arkiv.network/address/0x532cCE61F117A394D595E9fb7069f4D6CE3Bb047) |
| Simulated receivers 1 and 2 | `0xAE1796225FFdf537eF8122dA92ACDE3D1aE9b363`, `0xeeeB58826006087868079C27159838a3B694721e` |

**Device keys** (Ed25519 public keys; private keys never leave each device)

| Device | Public key |
|---|---|
| Beacon (signs every batch of radio frames) | `f7bf12e3c6b832c7daec9d7b21474d129183b2c7d1e0aafc1c223395c2d6d4e3` |
| Ground board (signs vouchers and x402 payments; key of Hedera account `0.0.11327397`) | `ca3798af825c97e33026ca6ff67049ec044c7b0cc504b6f304bf12846513b104` |
| Raspberry Pi (signs every decision; stored in EpisodeRegistry) | `82513dff297d1533f27a055b440b9efd384bc0f576a546ddb2cb546a19363c06` |

---

## Contents

1. [Why this exists](#why-this-exists)
1. [Problem statement and pitch](#problem-statement-and-pitch)
2. [What it does, in one picture](#what-it-does-in-one-picture)
3. [Prior work and what was built here](#prior-work-and-what-was-built-here)
4. [Hardware and wiring](#hardware-and-wiring)
5. [The radio protocol](#the-radio-protocol)
6. [Components](#components)
7. [Setup](#setup)
8. [Running the demo](#running-the-demo)
9. [Partner tracks](#partner-tracks): [0G](#0g-physical-ai-agents-with-a-body), [Hedera](#hedera-x402-ai-agents-that-pay), [Arkiv](#arkiv-build-on-arkiv-from-scratch)
10. [Measured results](#measured-results)
11. [Security and keys](#security-and-keys)
12. [What is not done](#what-is-not-done)
13. [Repository layout](#repository-layout)
14. [How AI was used](#how-ai-was-used)

See also **[Contracts and on-chain addresses](#contracts-and-on-chain-addresses)** above.

To change anything after a judge's comment (contracts, the Pi, the boards), or to run it all
from another laptop, see **[CHANGING.md](CHANGING.md)**.

---

## Why this exists

HAB-1 flew on 31 Oct 2026 from near Solapur, Maharashtra: burst at **19,624.8 m** GPS
(measured), landed **62.7 km** from the pad (computed), flight time **124.7 min**
(computed). Its records:

| | Bytes | Source |
|---|---|---|
| Recorded on the payload's SD card | 51,236,717,060 (51.2 GB) | measured, card listing |
| Received on the ground over the radio | 29,400 (1,050 frames of 28 bytes) | computed from the ground station's CSV |

That is about **one byte down for every 1.7 million recorded** (computed). Anything that flies,
balloons now and satellites later, has this problem: the link is tiny, so the machine has to
think up there. HAB-1 already ran a language model on board (411 answers, median
10.4 tokens/s, measured). That leaves three questions this project answers:

1. **Who makes a decision, and can it be audited?** The payload asks **0G** at checkpoints,
   logs every decision with its request ID, signs it, and puts the log on **0G Storage** with
   its root on **0G Chain**. If 0G cannot be reached it holds a safe state; it never invents
   the decision.
2. **How do you prove what the machine saw, when anyone with a radio can fake its signal?**
   The beacon signs its frames with Ed25519. The ground rejects anything the signature does
   not cover. Every receiver writes what it verified to **Arkiv** under its own wallet.
3. **How does it get paid for what it computes?** The ground station sells the balloon's
   data per request over **x402 on Hedera**. An agent pays with no human approving, and gets
   the beacon's signed frames so it can check the data itself.

---

## Problem statement and pitch

### The problem, in one sentence

**A high-altitude balloon, and later a CubeSat, records about 1.7 million bytes for every
byte it can send down, over a radio link that anyone can fake, so it has to decide on board.
Today nobody can check what it decided, prove what it saw, or pay it for what it worked out.**

Concretely, from our own flight and bench:

| Problem | Evidence | What we built |
|---|---|---|
| The link is tiny | HAB-1 recorded 51.2 GB and got 29,400 bytes down (computed, above) | the payload decides and computes on board, and sends results, not raw data |
| Anyone can fake the signal | with checking off, our ground station **accepted** a fake frame saying the balloon had landed about 30 km away. HAB-1's ground station worked this way | Ed25519 signatures from the beacon; the fake is **FAKE REJECTED** |
| On-board decisions cannot be audited | HAB-1's on-board model left no record anyone else can check | every decision is signed, logged with its 0G request ID, stored on 0G Storage, its root on 0G Chain |
| The data cannot be proven to whoever uses it | a recovery team or a wind-data buyer has only the ground station's word | every packet goes to Arkiv under the receiver's own wallet; every sale carries the signed frames |
| A machine cannot be paid while it is out of contact | a spacecraft sees a ground station for minutes a day | a signed voucher over the radio, settled on Hedera when the frames reach the ground |

**Who has this problem:** balloon teams and their recovery crews (a fake landing sends a team
the wrong way), anyone buying upper-air wind or position data, and small-satellite teams with
minutes of downlink per pass.

### Others are already exploring this: J.P. Morgan's SpaceBridge

Payments between satellites are not our idea alone, and saying so makes the pitch stronger.
J.P. Morgan's blockchain unit (Onyx, now Kinexys) has explored the same thing:

- **2021, in orbit.** With GomSpace, a tokenized value transfer between two of GomSpace's
  GOMX-4 satellites in low Earth orbit, reported as a step towards a network where
  satellites do not need to talk to Earth to transact.
- **SpaceBridge, a prototype.** A demo in which an Earth station requests satellite imaging,
  one satellite pays another for it, and the ledger syncs with the ground when the
  satellites come back in range. J.P. Morgan describes it as a concept and a prototype, not a
  product it offers.

**How we relate to it.** We use the same pattern: transact while out of contact, settle when
the frames reach the ground. Our version shows four things on hardware anyone can build:

| | Our version |
|---|---|
| Where it settles | a public testnet (Hedera): anyone can look up the transaction and the HCS audit message |
| What is paid for | data the payload worked out on board; the payment settles only after that data is recomputed from frames the beacon signed |
| Who can spend | the buyer node's Hedera account key is made on the board and never leaves it; an allowance it signed itself caps what the seller can ever take |
| Cost | two hobby LoRa boards and a Raspberry Pi from our balloon, inside a 2.5 % radio duty limit |

**What we must not claim.** Theirs ran between real satellites in orbit; ours runs on a
bench, between two radios, with a balloon flight replayed. We are not affiliated with J.P.
Morgan or GomSpace and should not use their logos.

**Pitch line:** "In 2021 J.P. Morgan and GomSpace moved value between two satellites in
orbit, and J.P. Morgan has a prototype, SpaceBridge, for satellites that pay each other for
services. We built that pattern on a public network, on hardware a student team can afford,
and added one thing: the payment settles only if the data it paid for checks out against the
signed source."

Sources: [J.P. Morgan Kinexys, payments in space](https://www.jpmorgan.com/kinexys/content-hub/payments-in-space),
[J.P. Morgan, blockchain in space](https://www.jpmorgan.com/insights/technology/blockchain-in-space),
[SmallSat News, GOMX-4 test (Feb 2021)](https://smallsatnews.com/2021/02/26/blockchain-transaction-tested-by-gomspace-j-p-morgan-via-the-gomx-4-smallsat-constellation/).

### Tuned to Devcon 8's opening keynote

Vitalik Buterin opened Devcon 8 in Mumbai on 3 Nov 2026 ("Open, secure and verifiable paths
to a brighter future") on one problem: technology asks people to trust too much and lets
them check too little. He asked for hardware, software and AI that can be verified, and named
six areas, among them open silicon and trustworthy AI, warning that AI security is drifting
towards control by a single organization. (From news reports of the keynote; no transcript
was found.)

That is this project's problem, on a balloon:

| Asks you to trust | What we let you check instead |
|---|---|
| the radio signal | every frame is signed by the beacon; the fake landing is rejected |
| the machine's AI decisions | each decision is signed on the Pi, logged with 0G's request ID, and stored on 0G Storage with its root on chain |
| our server | the map reads Arkiv directly; each receiver vouches only for what it heard, under its own wallet |
| the seller of the data | every sale carries the signed frames; radio payments settle only after the data is recomputed from them |
| the ground station | the x402 payment is signed on the buyer's own chip, with a key that never leaves it |

**Opening line:** "Vitalik opened Devcon here two days ago with one problem: we're asked to
trust too much and can check too little. Our balloon is that problem at 20 kilometres. Here
is how we made everything it says checkable."

**Say this before a judge does:** the boards are ordinary closed chips (ESP32-S3), not open
silicon. We check what the hardware says, not what the hardware is: a compromised chip with
its key could still sign false readings. Open silicon is the layer below ours.

Sources: [Crypto Briefing](https://cryptobriefing.com/vitalik-buterin-trustworthy-hardware-devcon-8/),
[Crypto Times](https://www.cryptotimes.io/2026/11/03/vitalik-warns-ai-security-is-tilting-toward-domination-as-deceleration-stalls/),
[Altcoin Buzz](https://www.altcoinbuzz.io/vitalik-opens-devcon-8-mumbai-trustworthy-technology).

### The finalist pitch (4 minutes)

| Time | Say | Show |
|---|---|---|
| 0:00 to 0:30 | "Two days ago Vitalik opened Devcon here: we're asked to trust too much and can check too little. On 31 October our balloon, HAB-1, flew to 19.6 km. It recorded 51 GB and we got 29 kB down: one byte for every 1.7 million. Anything that flies has this problem, so the machine has to think up there. Then three questions: can anyone check what it decided, prove what it saw, and pay it for what it worked out?" | the real payload on the table |
| 0:30 to 1:00 | "This is the same flight hardware, replaying that flight through the real radios. Every frame is signed on the beacon, every decision is made with 0G and signed on the Pi, every packet lands on Arkiv, and the data is sold over Hedera." | the one-picture diagram |
| 1:00 to 1:30 | "Here is the track, read straight from Arkiv: no server of ours. Now I'll be an attacker." Press PRG. "The verifier rejects the fake. HAB-1's ground station would have accepted it." | the map; FAKE REJECTED; then `noverify` showing ACCEPTED |
| 1:30 to 2:10 | "The Pi decides at checkpoints with 0G: has the balloon burst, is it too hot, is this frame worth the radio? Each decision is signed and logged with 0G's request ID, and the log is on 0G Storage with its root on 0G Chain. If 0G is unreachable it does not guess: it holds a safe state and says so." | `pi-log`: a decision with its request ID; the safe stop; the storage root |
| 2:10 to 2:45 | "An AI agent buys wind at 15 km over x402 on Hedera. No human approves it, it has a budget, and it gets the beacon's signed frames, so it checks the data itself instead of trusting us." | `./demo.sh buy 15000`: the transaction, HCS message, `ok:true` proofs |
| 2:45 to 3:25 | "Now the two balloons talk to each other. Balloon B asks balloon A for wind over LoRa. A answers '402 Payment Required', over the radio. B's chip, whose key is its Hedera account, builds and signs the Hedera payment itself. The x402 facilitator settles it, and only then does A send the data. Real x402, between two radios. And when no ground station is in range, B pays with a signed voucher that settles when the frames come down." | `radio-x402`: REQ, 402, PAY, SETTLED, DELIVERY, HashScan link; then `radio-buy` and `radio-settle` |
| 3:25 to 3:50 | "A CubeSat has the same problem, only worse: a few minutes of contact a day. J.P. Morgan and GomSpace already moved value between two satellites in 2021, so this is where the space economy is heading. The same stack fits: decide on board with 0G, sign at the source, publish where everyone owns their own record, and get paid even before contact, only for data that checks out." | one slide: their 2021 test next to our radio sale |
| 3:50 to 4:00 | "The flight is a replay and the range is bench distance, but the radios, keys and payments are real. Every number on screen is on a public testnet." | |

### The pitch for each track

**0G: Physical AI, Agents with a Body.** "A balloon is an agent with a body, and with
hardly any link to the ground. Our Pi makes its checkpoint decisions with 0G (burst, thermal,
which camera frames are worth the radio), and each decision changes the payload. Every
decision is signed with the Pi's key and logged with 0G's request ID. The episode log goes
to 0G Storage and its root to an EpisodeRegistry contract on 0G Chain, so anyone can replay
what the machine decided and why. If 0G is unreachable it never invents a decision: it holds
a safe state, keeps every frame and tells the beacon." Show: a decision with a request ID,
the safe stop, the storage root and registry transaction, and a tampered record failing.
*Remove 0G and the payload cannot make its checkpoint decisions.* The stored log `retest-1106`
(registry entry #1) holds 66 0G decisions, each with its request ID, and 33 safe stops from
while the Pi was offline.

**Hedera: x402, AI Agents That Pay.** "The balloon's data has buyers: wind at height is what
the next launch, a drone or a weather model needs. Our ground station sells it per request
over x402 on Hedera, and an agent with a per-payment cap, a total budget and a merchant
allowlist buys it with no human approving. Every answer carries the beacon's signed frames,
so the agent checks the data instead of trusting the seller, and is not charged when there is
nothing verified at that height. Each settlement is written to an HCS topic. It is standard
x402: we paid through two facilitators, x402.org and Blocky402, by changing one setting.
Then we took x402 off HTTP: two balloons run the x402 exchange over LoRa. The seller answers
'402 Payment Required' over the radio, the buyer's ESP32 builds and signs the Hedera payment
with a key that never leaves it, the x402 facilitator settles it, and only then is the data
released. When no ground station is in range, a signed voucher settles later from an
allowance." Show: `buy`, the HashScan link and HCS message, then `radio-x402`, then
`radio-buy` and `radio-settle`.

**Arkiv: Build on Arkiv.** "The track of a balloon is a public good: recovery crews, other
teams and the public need it, and nobody should have to trust our server for it. Every packet
the ground verifies is written to Arkiv as an entity with typed, indexed fields, owned by the
wallet of the receiver that heard it, with the raw frame so anyone can recheck the signature.
The public map reads Arkiv directly: stop everything of ours and it still loads. Add more
receivers and each one vouches only for what it heard itself." Show: the map with our
processes stopped, an entity's owner, the query script, and the `schema.md` and `friction.md`
files.

### Questions judges will ask

| Question | Answer |
|---|---|
| Is this a real flight? | The hardware and the radios are real; the flight is a replay of HAB-1's 31 Oct flight. The live barometer reading in the frames is real and live. |
| There is no internet up there. How do you prove anything? | The proof travels with the data: the beacon signs frames, the Pi signs decisions and the buyer node signs vouchers. Checking happens on the ground, later. Payments are vouchers settled when the frames come down. |
| Your hashes are only 4 bytes. Can't I forge one? | Not in time: each batch's hashes use a secret salt revealed only in its signature frame, after which no frame for that batch is accepted. A forger can only guess, 1 in 4 billion per fake transmitted. Old frames can't be replayed either: the signature covers a boot number, and the verifier refuses anything older than what it has accepted. |
| Can't the ground station lie? | It can leave frames out, but it cannot change them: the signatures come from the beacon's key. Each receiver writes to Arkiv under its own wallet, so receivers can be compared. |
| What if 0G is down? | The payload holds a safe state, deletes nothing and says so on the beacon. It never makes the decision up. |
| Is the radio payment x402? | There are two modes. **x402 over LoRa**: the 402, the payment payload (a Hedera transfer signed on the chip) and settlement through the x402.org facilitator, data only after settlement, as long as a ground station hears it within 120 s. **Voucher mode** for long gaps: not x402, a signed voucher settled from a Hedera allowance that caps the worst case. |
| Why can't the balloons just talk to each other? | They can, and do: the buyer and the seller here are two radios talking directly. At altitude they have line of sight. Only a relay through a third balloon needs a third board. |
| What does it cost in airtime? | The beacon plans 2.28 % of the 2.5 % limit. A radio sale is 500 ms on air, at most one every 5 minutes, and only if the batch's signature still fits. |
| Hasn't J.P. Morgan already done this? | Yes, the pattern: in 2021 with GomSpace's satellites, and in their SpaceBridge prototype. That is why we think it matters. Ours settles on a public network, pays only for data that checks out against the signed source, and runs on hardware a student team can afford. Theirs went to orbit; ours has not. |
| Range? | Bench distance only so far. |

---

## What it does, in one picture

```
 PAYLOAD (the HAB-1 flight hardware)               GROUND                                  CHAINS
 ┌──────────────────────────────────┐   LoRa    ┌─────────────────────────────┐
 │ Raspberry Pi 5                    │ 866.1 MHz │ Heltec V3 "ground"  (USB)   │
 │  agent.py: decides with 0G        │ ────────▶ │  radio modem, JSON lines    │
 │   burst / thermal / vision        │ ◀──────── │  answers each frame         │
 │  signs every decision (Ed25519)   │  uplink   ├─────────────────────────────┤      ┌─────────────────┐
 │  MS5611 + BMP280 + C270 camera    │           │ Laptop                      │ ───▶ │ Arkiv: packets  │
 │        ▲ tap line   │ PI lines    │           │  verifier.py  signatures    │      │ owned by        │
 │        │ (UART)     ▼             │           │  publish.mjs  to Arkiv      │      │ receiver wallet │
 │ Heltec V3 "beacon"                │           │  server.mjs   x402 endpoint │ ───▶ │ Hedera: x402    │
 │  replays the 31 Oct flight        │           │  agent.mjs    a paying agent│      │ payments + HCS  │
 │  signs 6 frames per signature     │           │  upload.mjs   episode logs  │ ───▶ │ 0G: Storage +   │
 │  1 s receive window per frame     │           │  web/index.html  the map    │      │ EpisodeRegistry │
 └──────────────────────────────────┘           └─────────────────────────────┘      └─────────────────┘
                                                  the map reads Arkiv directly ◀────────────┘
```

**One cycle:** the beacon sends a 28-byte frame every 12 s, and every seventh slot a
94-byte signature frame covering the six before it. The ground Heltec hears each frame,
answers inside the beacon's 1 s window, and passes the bytes to the laptop. The verifier
accepts a frame only when the signature covering it checks out, then the publisher writes it
to Arkiv. Meanwhile the beacon copies every frame to the Pi over the tap line; the Pi's agent
watches for checkpoints (burst, heat, camera frames), asks 0G, acts, and signs a record of
it.

---

## Prior work and what was built here

| Existed before the event | Built at the event (all code in this repository) |
|---|---|
| The HAB-1 hardware: Raspberry Pi 5, two Heltec WiFi LoRa 32 V3 boards, NEO-M9N GPS, MS5611 and BMP280 barometers, C270 and Lenovo cameras, the payload harness | Firmware for both Heltecs (`firmware/hab_node`) and the radio probe (`probes/`) |
| The flight data of 31 Oct 2026 (the Pi's 1 Hz log), used here only as **replay input** | Ground verifier, Arkiv publisher, public map, Hedera x402 endpoint and agent, Pi decision loop and sensor drivers, 0G contract and uploader, tools |
| Flight footage, used only as background in the pitch | |

**Related work, and what is new.** The radio protocol's security idea is not new and we do not
claim it is: one signature covering several messages is signature amortisation (Gennaro and
Rohatgi, "How to sign digital streams", 1997; Wong and Lam, 1999), and revealing a secret
after the messages it protects is the idea of TESLA (Perrig et al., 2000), which Galileo's
OSNMA uses today to authenticate satellite navigation broadcasts. What was designed here is
its form for this link: 28-byte data frames, a 100-byte SIG frame per 6 frames, 4-byte hashes
made safe by revealing the salt only in the SIG frame, a boot counter against replays, all
within 2.28 % of a 2.5 % duty limit; and the payments on top of it. We searched for prior
x402 over LoRa (6 Nov 2026) and found none; the closest was a signed agent payment sent over
868 MHz LoRa between two Heltec boards with another protocol (MCPS), not x402. A search can
miss work, so we say "we found no prior x402 over LoRa", not "first".

No code from the HAB-1 flight software (its firmware, its Pi daemons, the Kapex payload
computer) is used. The Pi's barometer drivers were written again here from the datasheets.
The tap line from the beacon to the Pi reuses the wire HAB-1 flew with; the Pi to beacon wire
was added at the event.

---

## Hardware and wiring

| Part | Role | Notes |
|---|---|---|
| Heltec WiFi LoRa 32 V3 (ESP32-S3 + Semtech SX1262) | **beacon**, in the payload | runs `hab_node` role 1; on Wi-Fi for commands and firmware updates |
| Heltec WiFi LoRa 32 V3 | **ground** receiver | runs `hab_node` role 2; on the laptop's USB; Wi-Fi off |
| Raspberry Pi 5, Debian 13 (trixie), aarch64 | payload computer | Python 3.13 venv in `~/ethglobal/.venv` |
| MS5611 (GY-63) | outside air pressure and temperature | `/dev/i2c-1`, address 0x77 |
| BMP280 (GY-BMP280-3.3) | inside the box | software I2C bus `/dev/i2c-3`, address 0x76 |
| Logitech C270 | camera for the vision checkpoint | `/dev/video0` |
| 3 dBi rubber ducks | antennas on both Heltecs | the 12 dBi Yagi is not used at bench range |
| iPhone personal hotspot | the bench network | took only three devices in our tests (Mac, Pi, one Heltec); a fourth got `ASSOC_TOOMANY` (measured) |

**Tap line, beacon to Pi and back** (both 3.3 V logic, 38,400 baud):

| From | To | Carries |
|---|---|---|
| Heltec GPIO 6 (UART TX) | Pi pin 10 (GPIO 15, RXD) | `TAP <seq> <hex>`: every data frame the beacon sends |
| Pi pin 8 (GPIO 14, TXD) | Heltec GPIO 7 (UART RX) | `PI <text>`: the Pi's decisions, shown on the beacon's OLED |
| GND | GND | shared ground |

Pi header: odd pins on the inner row, even pins on the outer row along the board edge; pin 8
is between GND (pin 6) and pin 10.

---

## The radio protocol

Radio settings (both directions): **866.1 MHz, LoRa SF9, 125 kHz bandwidth, coding rate 4/5,
sync word 0x34, preamble 8, TCXO 1.8 V, 0 dBm** for the bench. Layouts are in
[`firmware/hab_node/frames.h`](firmware/hab_node/frames.h); all fields little-endian.

| Frame | Bytes | Time on air | Contents |
|---|---|---|---|
| DATA `0xB2` | 28 | 226.3 ms (computed by RadioLib) | seq, flight time, lat, lon, GPS altitude, outside pressure and temperature (replayed), live outside pressure and temperature from the Pi's MS5611 (sent over the tap wire; 0 if missing or more than 15 s old), flags, key ID |
| SIG `0xB3` | 100 | 554.0 ms (computed) | first seq, count (6), the beacon's boot number, a per-batch salt, 6 x first 4 bytes of SHA-256(salt + data frame), Ed25519 signature over bytes 0..35 (94 bytes and unsalted before 4 Nov 2026) |
| UPLINK `0xD1` | 32 | 246.8 ms (computed by RadioLib) | the seq it answers, 27 bytes of payload |
| BUY `0xD2` | 86 | sent instead of the UPLINK | a payment voucher: nonce, product, price, buyer and seller Hedera accounts, Ed25519 signature by the buyer node (see Radio sales) |
| DELIVERY `0xB4` | 88 | right after an accepted BUY, or after SETTLED | the wind the Pi computed, the two frames it came from, a hash of the voucher or payment, Ed25519 signature by the beacon |
| REQ `0xD3` | 10 | 205 ms (measured) | x402 over the radio: "I want wind", from the buyer's Hedera account |
| OFFER `0xB5` | 20 | right after a REQ | "402 Payment Required": price, pay-to, the facilitator's fee payer, a one-time challenge |
| PAY `0xD4` | 81 | 533 ms (measured) | the valid-start time and the buyer board's Ed25519 signature over a Hedera transfer both sides rebuild |
| SETTLED `0xD5` | 74 | 493 ms (measured) | "the facilitator settled it", signed by the ground station's key |

**Schedule.** One slot every 12,000 ms. Six data slots, then one signature slot. After each
data frame the beacon listens for 1,000 ms; the ground answers 50 ms after it hears the frame.

**Duty cycle.** The 865 to 868 MHz band is licence-exempt in India under G.S.R. 853(E), with a
duty cycle limit of 2.5 %. Planned duty for the beacon: (6 x 226.3 + 554.0) ms per 7 x 12 s =
**2.28 % of 2.50 %** (computed; 2.25 % before the salt and boot number were added). The firmware refuses any frame that would take it above
2.40 %. Measured on the boards: beacon 1.89 % (data only, probe), ground 1.76 to 2.06 %.
Adaptive Power Control and type approval, also conditions of that exemption, are not met by
this bench setup. This is not legal advice.

**Why one signature per six frames.** An Ed25519 signature is 64 bytes, 2.3 times a whole
28-byte frame (computed). Signing every frame would take too much airtime under the 2.5 %
limit, so the beacon signs a list of short hashes once per batch.

**Why the short hashes cannot be forged, and old frames cannot be replayed.** Two holes in the
first version, found in review on 4 Nov 2026 and closed the same day:

| Hole | How it was attacked | Fix |
|---|---|---|
| A 4-byte hash is short | hear a real frame, then try fake frames until one has the same 4 bytes: about 4 billion tries, about a second on a GPU. The verifier would then have verified both | the hash is SHA-256(salt + frame), with a fresh random salt per batch that is sent only in the SIG frame. A fake must be on the air before its SIG frame (later frames are never verified), when nobody knows the salt yet, so it can only guess: 1 in 4 billion per fake frame sent. And if two different frames for one seq ever both match, both are rejected (CONFLICT) |
| Seqs restart at 0 on every boot | record genuine frames and their SIG frames, and play them back after the beacon reboots | the SIG frame carries a boot number kept in flash. The verifier refuses any batch that is not newer than the newest it accepted (REPLAY), and remembers that across restarts in `ground/state/` |

Making the hashes 8 bytes instead would have cost 656 ms per SIG frame and 2.40 % duty, the
whole guard, leaving no airtime for anything else. The salt costs 20.5 ms. A verifier
starting with no history trusts the first batch it hears (trust on first use).

**Checked:** offline with a throwaway key: genuine frames VERIFIED, a fake FAKE REJECTED, the
same frame heard twice still VERIFIED, a forced hash collision CONFLICT REJECTED on both
frames, a replayed batch REPLAY REJECTED, a new boot accepted, the verifier remembering after
a restart, a bad signature rejected. Live on the boards (4 Nov 2026): the beacon reports
`sig 554.0 ms` and `planned duty 2.28%` at boot; the first batch after the update, boot 2,
seqs 0..5, signature VALID, the frames heard VERIFIED (0..2 were sent before the verifier
started: MISSING). The boot number went from 1 to 2 when the beacon was unplugged from USB,
as it should.

**What a signature proves.** That the frame came from the beacon's key. Not that its sensors
were right.

### Radio sales: a payment between two radios, settled later

A spacecraft sees the ground for minutes a day. Here one radio node pays another for data
with no internet in between, and the payment settles on Hedera when the frames reach a ground
station. In the demo the ground Heltec plays the buyer node ("Sat B") and the beacon is the
seller ("Sat A").

1. **Before flight.** The buyer node makes its own Ed25519 key. A Hedera account is created
   with that key as its account key, and the node itself signs (over USB) an HBAR allowance
   to the seller's account. The allowance caps what the seller can ever take. The beacon is
   told the buyer's key and account, its own `payTo` and the price.
2. **Up there.** The buyer signs a voucher (nonce, product, price, both accounts) and sends it
   as a BUY in the window after a data frame. The beacon checks the signature, the accounts,
   the price and that the nonce is new, then answers with a DELIVERY: the wind the Pi computed
   on board, the two data frames it came from and a hash of the voucher, signed by the beacon.
   A refused voucher gets no reply, so a stranger cannot spend the beacon's airtime.
3. **On the ground** ([`hedera/radio_settle.mjs`](hedera/radio_settle.mjs)). The voucher
   signature is checked against the buyer account's key read from the mirror node, the
   delivery against the pinned beacon key, and the wind is recomputed from the two signed
   frames. Only then does the seller take the price from the allowance (an approved
   transfer) and write the voucher, the delivery and the transaction to the HCS audit topic.

**Processing on board.** The wind is not computed on the ground: the Pi computes it from each
pair of consecutive frames and sends `WIND <seq_a> <seq_b> <cm/s> <toward> <alt>` to the
beacon over the tap wire. Only the result goes down, and anyone can recompute it from the
two signed frames it names.

**Airtime.** A delivery is 88 bytes. The beacon sells at most once every 5 minutes, and only
if the rest of the current batch and its signature frame still fit under the 2.40 % guard. A
sale must never cost a signature: in the first test, just after a reboot, the delivery left
too little airtime, the guard refused the next SIG frame, and those six frames could never be
verified. The settler then refused to charge for that wind, because it could not be checked.

**What it is not.** Not standard x402: x402 settles immediately over HTTP. This is a signed
voucher carried over the radio and settled through Hedera later; the HTTP sale on the ground
is the x402 part. The 866 MHz band is for the ground; a spacecraft would use coordinated space
spectrum.

### x402 over the radio: the real x402 exchange between two balloons

The voucher works for long gaps without contact. When a ground station can hear the radio
within two minutes, the two nodes can do actual x402, settled by an actual x402 facilitator:

1. **REQ.** Balloon B asks balloon A for wind.
2. **402 Payment Required (OFFER).** A answers with the price, its `payTo`, the
   facilitator's fee payer and a one-time challenge, the same fields as x402's
   `PAYMENT-REQUIRED`.
3. **PAY.** B's board checks its own spending controls (per-payment cap, budget, an allowlist of
   accounts it will pay, kept in flash), then **builds the Hedera transfer x402 asks for and
   signs it on the ESP32** with the key that is its Hedera account key. The 86-byte
   transaction body never crosses the radio: both boards build it from the offer, the
   challenge (in the memo) and B's valid-start time, so the PAY frame carries only that time
   and the 64-byte signature. A rebuilds the body and checks that B signed exactly the
   transfer A asked for.
4. **Settlement.** The ground station hears the PAY, rebuilds the signed transaction byte for
   byte ([`hedera/hedera_body.mjs`](hedera/hedera_body.mjs), the same encoder as the
   firmware's [`hedera_body.h`](firmware/hab_node/hedera_body.h)), and hands it to the
   x402.org facilitator as a standard x402 `PaymentPayload` (`exact`, `hedera:testnet`).
   The facilitator verifies it, adds its fee-payer signature and submits it.
5. **SETTLED, then the data.** Only after settlement does the ground station send SETTLED,
   signed with its own key, which the beacon trusts. Only then does A release the wind, as
   x402 requires: no data before payment.

[`hedera/radio_x402.mjs`](hedera/radio_x402.mjs) runs the ground station's part;
`./demo.sh radio-x402` runs one purchase. Limits: a Hedera transaction is valid for 120 s, so
this mode needs a ground station in range within that time (the voucher mode covers longer
gaps). In the demo the buyer balloon and the ground station share one radio board, with
separate keys, because we have only two boards.

### Why balloons can talk to each other

They can, and more easily than to the ground. Two balloons at 20 km have line of sight with
no terrain in between, and LoRa is a broadcast radio: balloon B hears balloon A on the same
channel as a ground station does. Everything above runs balloon to balloon: B buys A's
on-board wind and pays it, with no ground station in the conversation until settlement. What
two boards cannot show is a relay (A to B to the ground), which needs a third radio.

---

## Components

### `firmware/hab_node`: both Heltecs, role chosen at compile time

- **Role 1, beacon.** Replays the 31 Oct flight from
  [`replay_data.h`](firmware/hab_node/replay_data.h) (127 samples, one every 60 s, from 60 s
  before release to 60 s after touchdown), five samples per frame so a whole flight passes in
  about 6 minutes. Generates an Ed25519 key on first boot and keeps it in flash. Signs every
  batch, listens for uplinks, copies each frame to the Pi, shows the Pi's messages on the OLED.
  **PRG button, `attack` command or an attack uplink:** sends one fake frame claiming the same
  seq, saying the balloon has landed about 30 km away; it is never in a signed batch. The
  console's *Inject forged frame* button and `./demo.sh attack` send the attack uplink
  (`[0xA7, target seq]`, [`frames.h`](firmware/hab_node/frames.h)) over LoRa through the ground
  board, so they work whatever network the laptop is on.
- **Role 2, ground.** A radio modem: every packet becomes one JSON line on USB, with RSSI, SNR
  and frequency error; it answers each data frame with an uplink (an ack, or a queued `up`
  command).
- **Both.** Wi-Fi to the hotspot, firmware over the air (password protected), log and commands
  on TCP port 2323, duty-cycle guard. The ground keeps Wi-Fi off unless built with
  `-DGROUND_WIFI`.
- **Commands.** Both: `status`, `show <text>`. Beacon: `attack`, `badsig` (corrupt the next
  signature, for testing), `stride <n>`, `goto <i>`, `pubkey`, `pinscan` (which header pin is
  toggling: a wiring probe). Ground: `up <hex>`, `ack on|off`.

### `probes/link_probe`: the first bench probe

Measured the three unknowns before anything else was built: whether the SX1262 can switch to
receive in time, whether the receive window delays the beacon, and how long Ed25519 takes on
the ESP32-S3. Includes a deliberate break (`d1500`, reply after the window closes) to prove the
check can fail.

### `ground/`: verification on the laptop

- [`verifier.py`](ground/verifier.py) reads the ground Heltec (USB, or Wi-Fi), holds each data
  frame as PENDING until its batch signature arrives, then marks it **VERIFIED**,
  **FAKE REJECTED** (another frame claims that seq and is not in the signed list),
  **REJECTED bad signature** or **MISSING**. It trusts only the pinned key in
  `beacon_pubkey.hex`. `--no-verify` shows what a ground station without signatures would
  accept. Survives a USB cable being pulled and plugged back.
- [`cmd.py`](ground/cmd.py) sends one command to a node over Wi-Fi (`cmd.py beacon attack`).
- [`nodes.py`](ground/nodes.py) finds the nodes on the hotspot (mDNS, then a subnet scan).

### `arkiv/`: the verified track on Arkiv

- [`publish.mjs`](arkiv/publish.mjs) follows the verifier's log and writes each verdict as a
  `boscon.hab.packet` entity, owned by the receiver's wallet, in one transaction per batch.
- It also writes each SIG frame it heard as a `boscon.hab.sig` entity (the 100 raw bytes), so
  anyone can redo the signature check from Arkiv alone.
- [`query.mjs`](arkiv/query.mjs) reads sessions and packets back with no key and no backend.

### `mcp/`: the flight over MCP, checked on your own machine

An MCP server ([`mcp/README.md`](mcp/README.md)) that lets an AI assistant (Claude, Cursor, any
MCP client) track the flight from Arkiv without trusting us. It holds no keys and calls no server
of ours: it reads the public chain and re-checks every frame's Ed25519 signature and salted hash
locally, against a beacon key you can supply yourself. Tools: `list_sessions`, `verify_session`,
`get_track`, `latest_position`, `query_packets`, `get_winds`, `get_landing_predictions`,
`get_ai_insights`, `decode_frame`. For session `live-11062318` (7 Nov 2026) it finds 19 of 19
signature frames valid, 105 frames verified, all 3 forged frames caught, and no receiver verdict
that fails its own check. `cd mcp && npm install && npm test` runs the same check.
- Schema and judging files: [`schema.md`](arkiv/schema.md), [`friction.md`](arkiv/friction.md),
  [`reach.md`](arkiv/reach.md), [`why-arkiv.md`](arkiv/why-arkiv.md),
  [`how-you-use-arkiv.md`](arkiv/how-you-use-arkiv.md).

### `web/index.html`: the public map

A static page that reads Arkiv straight from the browser: the verified track in green,
rejected fakes in red, bad signatures in orange, unchecked frames in grey. Refreshes every
15 s. No server of ours is involved in the reads.

### `station/` and `site/`: the ground station console

- [`station/server.mjs`](station/server.mjs) runs on the ground station laptop (port 8090). It
  follows the verifier, the Arkiv publisher, the x402 endpoint and the Pi's journal, and streams
  every event to the console over Server-Sent Events. It re-predicts the landing with the
  Tawhiri model on each verified fix and confirms each transaction on its chain.
- [`site/`](site/index.html) is the console: map, system flow, transactions ledger, event log,
  plots and an inspector. Without the station it opens in Archive mode, from Arkiv.
- **Protocol view: every frame as it is received.** Each frame crosses the LoRa link, timed
  from its real airtime (data 226.3 ms, SIG 554.0 ms, shown 4× slower). Its bytes then appear
  one by one, grouped into decoded fields (hover a field to see its bytes). Frames wait in their
  batch as "hash unknown until the salt". When the SIG frame arrives, its salt is shown as
  revealed and **the browser recomputes SHA-256(salt ‖ frame)[0:4] for every frame**,
  compares it with the signed list, and checks the beacon's Ed25519 signature with WebCrypto.
  The browser does not take the verifier's word for it. A forged frame turns its slot's note
  red ("forged frame dropped"). Each batch then gets its Arkiv transaction. Checked live
  (6 Nov 2026): 40 batches re-verified in the browser, all signatures valid; a fake frame sent
  with `./demo.sh attack` was shown as rejected next to the real seq 180.

### Flights page: simulator and mesh (simulated, clearly labelled)

- **Simulate a flight**: launch site (a list of real sites, or a point picked on the map),
  launch time, ascent rate, burst altitude and descent rate go to CUSF Tawhiri on the latest
  GFS through SondeHub; the trajectory comes back with a time for every point.
  **5-balloon fleet** launches from the HAB-1 pad, Pune, Aurangabad, Hyderabad and Kolhapur at
  the same moment.
- **Mesh over the simulated flights**: the balloons move through time; a LoRa link exists
  where the distance is within a computed range: SX1262 at 14 dBm, 2.15 dBi antennas, SF9 /
  125 kHz sensitivity −129 dBm (datasheet), 10 dB fade margin, free-space loss at 866.1 MHz,
  so about 200 km, capped by the radio horizon (4/3 Earth). That is conservative: measured
  LoRa balloon records are 702 km and 832 km (The Things Network), with high-gain ground
  antennas. Routing is breadth-first to the nearest ground station (Loon-style, each balloon
  forwards towards the ground). Each balloon sends one frame per simulated minute; a frame
  relayed by other balloons pays each relay with x402 over LoRa (the exchange measured
  between our two boards: REQ, 402, PAY, data), at an illustrative 0.001 HBAR per hop,
  signed on the paying balloon and settled on Hedera when it reaches a ground station.
  With no route, frames and payments wait on board and go down when a route appears.
  Nothing here is flown or measured; it is a model built on the measured single-hop exchange.

### `hedera/`: x402 on Hedera testnet

- [`server.mjs`](hedera/server.mjs) is the ground station's x402 endpoint:
  `GET /v1/wind?alt_m=15000` for **0.01 HBAR** and `GET /v1/flight/latest` for **0.005 HBAR**.
  The facilitator verifies and settles the payer's signed transfer and pays the network fee.
  Data is returned only after settlement; with no verified data, nothing is charged. Each
  settlement is written to an HCS topic.
- [`flightdata.mjs`](hedera/flightdata.mjs) is what is sold: the newest verified data plus the
  beacon's raw frames and the signature frames covering them. Wind is computed from two
  consecutive verified GPS fixes: great-circle distance over time.
- [`agent.mjs`](hedera/agent.mjs) buys data with no human approving, with three spending
  controls: 0.02 HBAR per payment at most (x402 spend controls, before signing), a total
  budget (0.05 HBAR by default), and a merchant allowlist.
- [`check_proof.mjs`](hedera/check_proof.mjs) is what a buyer runs to verify what they bought.
- [`setup.mjs`](hedera/setup.mjs) creates the merchant account and the HCS audit topic.
- [`keys.mjs`](hedera/keys.mjs) reads ECDSA or ED25519 keys.
- [`radio_setup.mjs`](hedera/radio_setup.mjs) makes the buyer node's Hedera account from the
  board's own key, has the board sign the allowance, and configures the beacon.
- [`radio_settle.mjs`](hedera/radio_settle.mjs) checks each voucher and delivery heard over the
  radio and settles it from the allowance (see Radio sales).

### `pi/`: the payload's decision loop

- [`agent.py`](pi/agent.py) runs three checkpoints, each of which changes something on the
  payload:

  | Checkpoint | Trigger | Model on 0G | Actions |
  |---|---|---|---|
  | burst | altitude 300 m below its peak | `vela-2.0-9b` (decision model) | `start_recovery` (switch to descent mode, tell the beacon) only if P >= 0.8, else `hold` |
  | thermal | SoC at or above 70 C, or every 5 min | `vela-2.0-9b` (decision model) | `continue` only if P >= 0.8, else `pause_camera` |
  | vision | every 90 s while the camera runs | `qwen3-vl-plus`, then `laya` | `keep` (queue the frame for downlink) or `drop`; a frame is deleted only if Laya, reading the vision model's description, gives P(empty) >= 0.7 |

  **Why decision models.** Vela 2.0 9B and Laya are 0G "System One" decision models
  (`POST /v1/decisions`): typed questions answered with calibrated probabilities, run in a
  TEE (Intel TDX, `tee_verified: true` in each response). A payload should not act on free
  text: with a probability it takes the consequential action only above a threshold and
  otherwise the safe one, and both numbers go into the signed log. Measured before choosing
  (6 Nov 2026): Vela reads numbers (41.9 C: `continue` 0.999; 74.5 C: `pause_camera` 0.995;
  a clear burst: `start_recovery` 0.98; a clear ascent: `hold` 0.999). Laya, a BERT-style
  classifier, does not (about 0.5 at any temperature), but reads text well ("completely
  black": empty 0.91; "clear view of the horizon": 0.14; "the balloon envelope is visible":
  0.06), so it checks the vision model's words before anything is deleted.

  **Safe stop.** If 0G cannot be reached (no key, no network, timeout, HTTP error, or an answer
  that is not one of the allowed actions), the agent changes nothing, deletes nothing, raises an
  alert to the beacon's screen, and logs a safe stop. It never falls back to a decision of its
  own. After a safe stop or a `hold` it asks again no sooner than 30 s later.
  Every record (inputs, model, request ID, decision, action taken) is signed with the Pi's
  own Ed25519 key.
- [`zg.py`](pi/zg.py) is the 0G Private Computer client (OpenAI-compatible router), recording
  the request and response IDs of each call.
- [`sensors.py`](pi/sensors.py) drives the MS5611 and BMP280 (written from their datasheets),
  the SoC temperature and the C270.
- Every 5 s the agent sends the MS5611 reading to the beacon over the tap wire
  (`BARO <Pa> <C>`). The beacon puts it in each data frame's live fields, with flag bit 2 set,
  only while it is less than 15 s old, so the signed frames carry real outside air from the payload.
- [`uart_blast.py`](pi/uart_blast.py) is a wiring probe for the Pi to beacon wire.

### `zg/`: episode logs on 0G Storage and 0G Chain

- [`EpisodeRegistry.sol`](zg/EpisodeRegistry.sol) records, per run, each episode log's 0G
  Storage root, its number of decisions and of safe stops. It stores the Pi's public key, so
  anyone can check the log's signatures. Only the recorder can add entries.
- [`deploy.mjs`](zg/deploy.mjs) compiles and deploys it on 0G Galileo.
- [`upload.mjs`](zg/upload.mjs) copies an episode log from the Pi, uploads it to 0G Storage,
  and records its root on chain.

### `tools/`

- [`make_replay.py`](tools/make_replay.py) builds `replay_data.h` from the flight log.
- [`pi.sh`](tools/pi.sh) runs a command on the Pi, or `sync` copies `pi/` to it.

---

## Setup

### Prerequisites

Full step-by-step setup for a new laptop, with every install command, is in
[CHANGING.md, section 2](CHANGING.md#2-setting-up-another-laptop).

| On | Needs |
|---|---|
| Mac or Linux laptop | `arduino-cli` with the ESP32 core 3.3.11; Arduino libraries RadioLib 7.7.1, Crypto 0.4.0 (rweather), Adafruit SSD1306, Adafruit GFX, Adafruit BMP280; Node 22.10 or later (tested on 25.2.1); Python 3.12 |
| Raspberry Pi | Debian 13, Python 3.13, I2C on, UART0 on GPIO 14/15 with no serial console, the C270 on USB |

### Secrets

Copy `.env.example` to `.env` and fill it in. It is git-ignored and never printed. Testnet only.

| Variable | What | Where from |
|---|---|---|
| `ZG_PC_API_KEY`, `ZG_PC_BASE_URL` | 0G Private Computer | pc.0g.ai, Dashboard, API Keys; base URL `https://router-api.0g.ai/v1` |
| `ZG_PRIVATE_KEY`, `ZG_EVM_RPC`, `ZG_INDEXER_RPC` | 0G Galileo wallet, RPC, storage indexer | a test wallet; faucet.0g.ai |
| `ZG_REGISTRY_ADDRESS` | the deployed EpisodeRegistry | written by `zg/deploy.mjs` |
| `HEDERA_PAYER_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY` | the paying agent's account | portal.hedera.com, testnet |
| `HEDERA_MERCHANT_ACCOUNT_ID`, `HEDERA_MERCHANT_PRIVATE_KEY`, `HEDERA_AUDIT_TOPIC_ID` | the ground station's account and audit topic | written by `hedera/setup.mjs` |
| `X402_FACILITATOR_URL` | x402 facilitator | Hedera's facilitator list; no API key needed |
| `ARKIV_ACCESS_KEY` | Arkiv RPC key | hub.arkiv.network/access-keys |
| `ARKIV_GROUND_PRIVATE_KEY`, `ARKIV_SIM_RX1_PRIVATE_KEY`, `ARKIV_SIM_RX2_PRIVATE_KEY` | receiver wallets | test wallets; tGLM from hub.arkiv.network/faucet |

`firmware/hab_node/wifi_secrets.h` (git-ignored) holds `STA_SSID`, `STA_PASS` and `AP_PASS`;
`AP_PASS` is also the over-the-air update password.

### Build and flash the Heltecs

`arduino-cli upload` flashes the last build, not the current source, so always compile first,
and use a separate build folder per role:

```bash
cd firmware
arduino-cli compile --fqbn esp32:esp32:heltec_wifi_lora_32_V3 --build-property "compiler.cpp.extra_flags=-DROLE=1" --build-path /tmp/hab_node_role1 hab_node
arduino-cli upload -p /dev/cu.usbserial-0001 --fqbn esp32:esp32:heltec_wifi_lora_32_V3 --input-dir /tmp/hab_node_role1 hab_node
```

Use `-DROLE=2` for the ground. Once the beacon is on Wi-Fi, later updates can go over the air:

```bash
python3 ~/Library/Arduino15/packages/esp32/hardware/esp32/3.3.11/tools/espota.py -i <beacon ip> -a <AP_PASS> -f /tmp/hab_node_role1/hab_node.ino.bin
```

On first boot the beacon prints its public key. Pin it from the USB output, the trusted path:
save it to `ground/beacon_pubkey.hex`.

### Laptop

```bash
python3 -m venv .venv && .venv/bin/pip install pynacl pyserial
(cd arkiv && npm install) && (cd hedera && npm install) && (cd zg && npm install)
```

### Pi

```bash
tools/pi.sh sync
tools/pi.sh 'cd ~/ethglobal && python3 -m venv .venv && .venv/bin/pip install pyserial smbus2 pynacl httpx openai opencv-python-headless numpy'
tools/pi.sh 'cd ~/ethglobal && .venv/bin/python pi/sensors.py'     # bench check
```

### One-time chain setup

```bash
(cd hedera && node --env-file=../.env setup.mjs)              # merchant account + HCS topic
(cd zg && node --env-file=../.env deploy.mjs <pi public key>)  # EpisodeRegistry on 0G Galileo
```

---

## Running the demo

Everything goes through `./demo.sh`, from any Mac or Linux laptop (setting one up:
[CHANGING.md](CHANGING.md#2-setting-up-another-laptop)). The pitch itself is in
[Problem statement and pitch](#problem-statement-and-pitch).

### Before the judges arrive (10 minutes or more ahead)

The beacon must have been on for **at least 10 minutes**: after a reboot it sells nothing
over the radio until airtime has built up (about 5 to 8 minutes). Unplugging it from USB
reboots it.

1. Everything in place (ground Heltec on USB, beacon and Pi on the hotspot):

```bash
./demo.sh check
```

2. Start the ground side: verifier, Arkiv publisher, x402 endpoint, map.

```bash
./demo.sh start demo-final
```

3. The Pi's agent, under the same session name. With the boot service installed, step 2
   already restarted it. Without it, stop any old one, start it, check it:

```bash
tools/pi.sh 'pkill -f "[p]i/agent.py"'
```

```bash
tools/pi.sh 'cd ~/ethglobal && setsid nohup .venv/bin/python -u pi/agent.py --run demo-final --vision-s 90 > agent-demo-final.log 2>&1 < /dev/null &'
```

(If that does not return, press Ctrl+C: the agent keeps running.)

```bash
tools/pi.sh 'tail -3 ~/ethglobal/agent-demo-final.log'
```

4. The map, in a browser: `http://localhost:8097/?run=demo-final`
5. The verifier's verdicts, live, in a second terminal:

```bash
./demo.sh logs verifier
```

### During the pitch, in order

| When | Command | What appears |
|---|---|---|
| 1:00, the attack | `./demo.sh attack` (or press **PRG** on the beacon) | within one batch (up to 84 s): `FAKE REJECTED` in the verifier, a red dot on the map. Then click the map near the track: every receiver that heard it, each under its own wallet |
| (optional) what HAB-1 would have done | `./demo.sh noverify`, then press PRG within 30 s | the fake is `ACCEPTED`. It stops the verifier: afterwards `./demo.sh stop` then `./demo.sh start demo-final-2` |
| 1:30, 0G decides | `./demo.sh pi-log` (boot service) or `tools/pi.sh 'tail -f ~/ethglobal/agent-demo-final.log'` | each checkpoint's decision with 0G's request ID; without a key, `SAFE STOP` |
| 1:30, the log on 0G | `./demo.sh upload` | a 0G Storage root and an EpisodeRegistry transaction |
| 2:10, an agent pays | `./demo.sh buy 15000` | the wind, a HashScan link, an HCS message number, then each frame's proof `ok:true` |
| 2:45, x402 between two balloons | `./demo.sh radio-x402` | REQ, `402 Payment Required`, `PAY heard on the air`, `facilitator settle: SETTLED`, then `DELIVERY ... paid over x402` and a HashScan link, in about 30 s |
| backup: the voucher | `./demo.sh radio-buy`, then about 2 minutes later `./demo.sh radio-settle` | voucher, BUY, DELIVERY; then `SETTLED voucher N` with a HashScan link |
| the end: nothing of ours needed | `./demo.sh stop`, then reload the map | the map still loads everything from Arkiv |

For questions: `./demo.sh sales` (the beacon's sales and its on-board wind) and
`./demo.sh status` (what runs, with the last log lines).

### What can go wrong on stage

| Symptom | Cause | Do |
|---|---|---|
| A radio sale: "not enough airtime yet" or "too soon" | the beacon rebooted under about 8 minutes ago, or sold something in the last 5 minutes | rehearse `radio-x402` at least 5 minutes before going on; show `radio-buy` instead |
| Every checkpoint says `SAFE STOP` | no 0G key on the Pi | `./demo.sh pi-key` with the key in `.env`; otherwise present it as the safe stop and do not claim live 0G decisions |
| `Pi not reachable` | its address changed | `arp -a \| grep 172.20.10`, then put `PI_HOST=172.20.10.x` in front of the commands |
| The verifier prints "94-byte signature frame" | the beacon has firmware from before 4 Nov 2026 | update it ([CHANGING.md](CHANGING.md#5-changing-the-firmware-on-the-boards)) |
| Everything is slow | the laptop is overloaded | close the iOS Simulator and Gradle |

Keep a recorded video of the whole flow as a backup.

### Running without USB

The ground Heltec is a radio for the laptop; by default it talks to the laptop over USB.
It can use Wi-Fi instead: the firmware already supports it, and `demo.sh` follows
`GROUND_HOST`.

1. Once, with the board on USB, build and flash the ground firmware with Wi-Fi on:

```bash
cd firmware && rm -rf /tmp/hab_node_role2 && arduino-cli compile --fqbn esp32:esp32:heltec_wifi_lora_32_V3 --build-property "compiler.cpp.extra_flags=-DROLE=2 -DGROUND_WIFI" --build-path /tmp/hab_node_role2 hab_node && arduino-cli upload -p /dev/cu.usbserial-0001 --fqbn esp32:esp32:heltec_wifi_lora_32_V3 --input-dir /tmp/hab_node_role2 hab_node
```

2. Power it from anything (a power bank) and start the demo with:

```bash
GROUND_HOST=hab-ground ./demo.sh start demo-final
```

(The same `GROUND_HOST=hab-ground` in front of `./demo.sh check` and `./demo.sh noverify`.)

**The catch is the hotspot.** The iPhone hotspot took 3 devices (laptop, Pi, beacon); a 4th
was refused (`ASSOC_TOOMANY`, measured). So without USB, use a hotspot or router that
accepts 4 or more devices (most Android hotspots and venue Wi-Fi do), or the ground loses its
slot. Also, over Wi-Fi the verifier does not reconnect by itself if the link drops (over USB
it does); restart with `./demo.sh stop` and `start`. Setup steps that sign with the
buyer board's key (`./demo.sh radio-setup`) stay USB only, on purpose. Not yet tested on
the boards.

---

## Partner tracks

### 0G: Physical AI, Agents with a Body

| Requirement | How it is met | State |
|---|---|---|
| A 0G call inside the decision loop | `pi/agent.py` asks 0G at the burst, thermal and vision checkpoints; each answer changes the payload | **run live** (6 Nov 2026): at burst Vela 2.0 9B gave `start_recovery` P = 0.924 (gate 0.8) and the Pi switched to descent mode; thermal `continue` 0.999; each `drop` from the vision model was confirmed by Laya (P(empty) 0.82 to 0.96) before the frame was deleted |
| When 0G's decision models are down | measured 6 Nov 2026: every TEE-attested model (Vela, Laya, 0gm-1.0, 0gm-1.0-sia) had no healthy provider for over an hour, while qwen3.6-plus, deepseek-v4 and qwen3-vl-plus answered through the same router | burst and thermal fall back to a 0G chat model: first glm-5.3, the only sealed (TeeML) model with a healthy provider then, asked with `X-0G-Provider-Trust-Mode: private` so the Router can only use an enclave (responses carry `X-0g-E2ee: sealed`), then 0gm-1.0, then qwen3.6-plus; the signed record carries `fallback` with `calibrated: false` and `tee_attested`. Analytics fall back the same way and record the model that wrote and the model that checked each insight. Only if every 0G model fails does the payload safe-stop |
| Decision models with calibrated probabilities | `vela-2.0-9b` and `laya` through `POST /v1/decisions`, every call with `verify_tee` | **verified**: `tee_verified: true` and a request ID on every response; about 10 micro-USD per Vela call, Laya free |
| 0G analyses checked for unsupported claims | `mission/analytics.mjs` reads Arkiv with attribute filters (for example Wind `source = measured`, `altM >= 8000`; Prediction `kind = inflight`, `errorKm <= 2`; Packet `verdict = <each>`), then `0gm-1.0-35b-a3b` writes the insight, then Vela marks any claim the Arkiv data does not support (span question) before it is stored | **verified**: the 3 insights on Arkiv are `guardVerdict=supported`; an insight with an invented claim ("the strongest wind was 25 m/s near the jet stream at 12 km", against a source with only one wind at 17,323 m) had exactly that claim marked (P 0.61 to 0.66) and the supported ones left alone |
| An episode log on 0G Storage, a request ID per decision | each decision record carries the request and response ID; `zg/upload.mjs` uploads the log | **done**: `retest-1106`, 38 signed decisions (5 with a 0G request ID, 33 safe stops while the Pi was offline), on 0G Storage and in the registry (below) |
| A replayable simulation or live hardware | the real flight hardware, replaying the 31 Oct flight; live sensors and camera | **runs** |
| A safe stop if 0G is unreachable, no faked decision | holds a safe state, deletes nothing, alerts the beacon | **verified** |
| Contract deployment address | `EpisodeRegistry` on 0G Galileo | **deployed** |

**On chain (0G Galileo testnet, chain ID 16602):**

| Item | Value |
|---|---|
| EpisodeRegistry | `0xF7D35D2cAf0319384E3dfA2c10157f9d0B57b8Be` ([explorer](https://chainscan-galileo.0g.ai/address/0xF7D35D2cAf0319384E3dfA2c10157f9d0B57b8Be)), deployed 6 Nov 2026 by `0xb26Bf4A2D754b22Bc73CE447f08A7AA83dd2AEEe` |
| Deploy transaction | `0xb653aaa2abf748ac289e454629727cd578c22005ce2c65d2251dade3be9674d6`, block 64,102,739, 393,461 gas |
| Pi public key stored in it | `82513dff297d1533f27a055b440b9efd384bc0f576a546ddb2cb546a19363c06` (the Pi's new key, made 6 Nov 2026) |
| Episode log `retest-1106` (38 decisions, 33 safe stops) | storage root `0x169b92e8635511f7584db2a5f1edb612584be24624befb5360effa36d8dd15eb`, storage transaction `0x38a55260f0a1ef0f5275371c4798d970fc398325961868b3c326f7f37acd5df4` (19.4 s) |
| Its registry entry | #0 for `retest-1106`, transaction [`0x1736318e0ce290bb822cbbb3106806cf70a61220b40770c4ebd599115cac73c3`](https://chainscan-galileo.0g.ai/tx/0x1736318e0ce290bb822cbbb3106806cf70a61220b40770c4ebd599115cac73c3), block 64,117,778, 93,214 gas |
| Cost | deploy, upload and record together: 0.0033 OG (deployer 0.5 to 0.4968 OG) |

**Checked** (6 Nov 2026): the log downloads from 0G Storage with proof checking on and is
byte-identical to what the Pi wrote (same SHA-256); all 38 records verify against the Pi key
stored in the contract; a record with its decision changed is rejected; `latest("retest-1106")`
returns the same root, 38 decisions, 33 safe stops.

What the log shows, in order (Pi clock, IST):

| Time | Checkpoint | Answer | 0G request ID |
|---|---|---|---|
| 10:56:46 | vision | `drop`: frame deleted | `e37c67697c5081a8` |
| 10:56:51 to 11:13:19 | burst, thermal, vision | 33 **safe stops**, `APIConnectionError`: the Pi's Wi-Fi was off (the offline test below, then a power cycle). Nothing changed, nothing deleted, nothing made up | none |
| 11:14:42 | vision | `drop`: "Frame is completely black" | `862f78e5c3768ef9` |
| 11:19:20 | thermal | `continue`: camera keeps running (SoC far below 70 C) | `6b322ab4977b48a6` |
| 11:19:23 | vision | `drop`: "Blurred, obstructed view" | `6201d48b4f41e960` |
| 11:19:42 | burst | **`start_recovery`**: "Altitude decreased significantly, indicating balloon burst"; the Pi switched to descent mode | `170cc01d976c58fe` |

In this uploaded log the burst and thermal model was still `0gm-1.0-35b-a3b` (TEE-attested on
the 0G router), the vision model `qwen3-vl-plus`. That model thinks by default and spent all
200 tokens reasoning, leaving an empty answer (every checkpoint a safe stop) until `pi/zg.py`
turned thinking off. The payload has since moved burst and thermal to the decision model Vela
2.0 9B and added Laya's check before deletions (below).

**Found on the way:** the Pi was power-cycled while the agent was writing, and the last
records before the cut became 1,205 zero bytes (written to the page cache, never to the card).
Those decisions are lost; the rest are signed one by one and unaffected. The log is uploaded
exactly as written, and `upload.mjs` reports the gap. `agent.py` now fsyncs every record.

**What breaks if 0G is removed:** the payload can no longer make its checkpoint decisions; it
holds a safe state until 0G is back.

**Live on the payload after the switch to decision models** (run `retest-1106`, Pi journal):

| Checkpoint | 0G answer | Action on the payload | Request ID |
|---|---|---|---|
| thermal | Vela `continue` P = 0.999 (gate 0.8) | camera running | `0c4cbb83-28ca-4ab5-a0de-0b2a2b81cc01` |
| vision | qwen3-vl-plus `drop` "Frame is completely black"; Laya P(empty) = 0.96 | frame deleted | `7c943d639351c934`; laya `bf48904b-3d0d-4dc2-bc0c-21de72c649ba` |
| burst | Vela `start_recovery` P = 0.924 (gate 0.8) | phase = descent, "0G: recovery" on the beacon | `0302ff40-ecab-46e2-bd4f-0d2725c85264` |

A caution measured on the way: 338 m below the peak at -1.1 m/s, Vela still gave
`start_recovery` 0.89. The checkpoint only fires 300 m below the peak; a real float would need
a longer altitude history in the state or a higher gate.

### Hedera: x402, AI Agents That Pay

| Requirement | How it is met | State |
|---|---|---|
| An x402-protected endpoint settling on Hedera | `hedera/server.mjs`, HBAR on `hedera:testnet`, via the x402.org facilitator | **verified** |
| An agent that finds the endpoint and completes a paid request with no human approving | `hedera/agent.mjs` reads the seller's catalog at `/.well-known/x402`, picks the resource that sells wind, checks its price against its cap and the payee against its allowlist, then pays | **verified, 5 payments** (the last two on 7 Nov 2026, found through the catalog) |
| A settled payment's transaction ID | below | **verified on the mirror node** |
| Extra: spending controls | per-payment cap, total budget, merchant allowlist | **verified: the budget cap refused** |
| Extra: an HCS topic as an audit log | one message per settlement, written by the seller only | **verified, messages 1 to 10** |
| Extra: standard x402, facilitator swapped by one setting | the same endpoint paid through Blocky402 instead of x402.org (6 Nov 2026, new deployment): [`0.0.7162784@1793936250.637071719`](https://hashscan.io/testnet/transaction/0.0.7162784-1793936250-637071719), `SUCCESS`, 0.01 HBAR `0.0.11326830` → `0.0.11327348`, fee 292,001 tinybar paid by Blocky402's `0.0.7162784`, HCS #5; the buyer's proof check passed for frames 709 and 710 | **verified** |
| Extra: x402 itself over LoRa | the 402, the payment and the settlement between two radio boards; the payment built and signed on the ESP32 and settled by the x402.org facilitator before the data is released | **verified, HCS #12** |
| Extra: machine-to-machine payment with no internet | a radio voucher between the two boards, settled from an HBAR allowance signed by the buyer board's own key | **verified, voucher 4, HCS #8** |

**Accounts (Hedera testnet):**

| Account | Role |
|---|---|
| `0.0.11326830` | the paying agent (was a hollow account; its first transaction completed it with an ECDSA key) |
| `0.0.11327348` | the ground station, the x402 `payTo` |
| `0.0.11327351` | the HCS audit topic, written only by the ground station |
| `0.0.9185802` | the facilitator's fee payer (x402.org's account, not ours) |
| `0.0.11327397` | the radio buyer node ("Sat B"): its account key is the ground Heltec's own Ed25519 key (`ca3798af…13b104`), with a 1 HBAR allowance to `0.0.11327348` signed by the board |

**Settled payments** (all `SUCCESS` on the mirror node, each moving 1,000,000 tinybar =
0.01 HBAR from `0.0.11326830` to `0.0.11327348`, network fee paid by `0.0.9185802`):

| Request | Answer (computed from the replayed flight) | Transaction | HCS |
|---|---|---|---|
| wind at 15,000 m | 12.8 m/s from 260 degrees (band 14,566 m) | [`0.0.9185802@1793917447.840408407`](https://hashscan.io/testnet/transaction/0.0.9185802-1793917447-840408407) | #1 |
| wind at 12,000 m | bought from the ground station console | [`0.0.9185802@1793918856.721090269`](https://hashscan.io/testnet/transaction/0.0.9185802-1793918856-721090269) | #2 |
| wind at 15,000 m (7 Nov 2026, endpoint found through `/.well-known/x402`) | 12.8 m/s from 260 degrees (band 14,566 m) | [`0.0.9185802@1794018067.032077285`](https://hashscan.io/testnet/transaction/0.0.9185802-1794018067-032077285) | #9 |
| wind at 10,000 m (same run) | 19.1 m/s from 222 degrees (band 9,547 m) | [`0.0.9185802@1794018078.863138219`](https://hashscan.io/testnet/transaction/0.0.9185802-1794018078-863138219) | #10 |

Each paid request took 3.7 to 8.5 s end to end (measured). With a budget for 1.5 payments the
agent paid once and refused the next two ("1000000 more would exceed it").

**No charge for the wrong data.** In the flow test the agent paid for wind at 12,000 m and got
the 6,139 m band, the nearest one verified so far. The endpoint now answers **404 before
settlement** when nothing verified is within 1,500 m of the requested height. Checked: a
request at 30,000 m got `{"error": "no verified wind data within 1500 m of that height yet",
"charged": false}`, and the payer's balance stayed at 423,201,154 tinybar (mirror node, before
and after).

**Payment flow:** the agent reads the seller's free catalog at `/.well-known/x402` (network,
`payTo`, facilitator, each paid route with its price and description) and picks the route that
sells wind; it refuses a seller whose `payTo` is not on its allowlist or whose price is over its
cap. It then asks for `/v1/wind`; the server answers **402** with the price,
asset (`0.0.0`, HBAR), `payTo` and the facilitator's fee payer; the agent's x402 client checks
its spending controls, signs a transfer, and retries with the `PAYMENT-SIGNATURE` header; the
server asks the facilitator to verify and settle; only after settlement succeeds does it return
the data, the `PAYMENT-RESPONSE` header and the HCS audit receipt.

**The data is verifiable:** each answer carries the beacon's raw frames and signature frames.
`check_proof.mjs` verified them, and failed on a flipped frame byte and on a flipped signature
byte. The beacon signs with rweather's Crypto library on the ESP32; Node's own crypto verifies
it, so it is standard Ed25519.

### Arkiv: Build on Arkiv (from scratch)

| Requirement | Where |
|---|---|
| Writes to the current testnet with `@arkiv-network/sdk` | `arkiv/publish.mjs` (SDK 1.0.0) |
| A feature users see reads from Arkiv | the console (Live from Arkiv), the map `web/index.html`, `arkiv/query.mjs`, and the MCP server [`mcp/`](mcp/README.md), which re-checks every signature from Arkiv data alone |
| Writer wallets and one query | below |
| `/arkiv/schema.md` and `/arkiv/friction.md` | [`arkiv/schema.md`](arkiv/schema.md), [`arkiv/friction.md`](arkiv/friction.md) |
| One file per judging criterion | [`reach.md`](arkiv/reach.md), [`why-arkiv.md`](arkiv/why-arkiv.md), [`how-you-use-arkiv.md`](arkiv/how-you-use-arkiv.md) |

**Writer wallets (this deployment, 6 Nov 2026):** ground receiver `0x532cCE61F117A394D595E9fb7069f4D6CE3Bb047`;
simulated receivers `0xAE1796225FFdf537eF8122dA92ACDE3D1aE9b363` and
`0xeeeB58826006087868079C27159838a3B694721e` (they republish the ground's verified frames
under their own wallets, labelled simulated on the map). The site and the query script filter by
these owners, so entities from earlier wallets are never shown. The MCP server reads every
receiver, and checks each one's frames against the beacon's signatures itself.

**On the map:** click anywhere to list every packet heard within about 5 km, from every
session and receiver (a box query on the indexed `lat` and `lon`, about 0.5 s, no server of
ours). Each frame is one point listing every receiver and wallet that vouched for it.

**One query you can run** (no key, no backend):

```bash
cd arkiv && npm install && node query.mjs retest-1106
```

**On Arkiv now** (ground wallet, read 7 Nov 2026): 11 sessions (`live-1106` to `live-11062318`),
2,160 frames (2,087 verified, 13 forged and rejected), 372 signature frames, 144 winds,
128 predictions, 33 public balloon positions, 22 0G analyses. `retest-1106` held 234
packets when queried during the run, each verified frame heard by the receiver; the first
batch of the session is [`0x4fce71be454304b237dcad20c66998f43a091505cea81be24bcbab1eedca353c`](https://rabdi.explorer.arkiv.network/tx/0x4fce71be454304b237dcad20c66998f43a091505cea81be24bcbab1eedca353c),
and batches of six frames land every 70 to 80 s, 5 to 12 s after they are sent (the console's
Transactions tab shows each one with its block and gas).

---

## Measured results

### Radio link and signing (bench, both boards at 0 dBm, 3 dBi antennas)

| Item | Value | Source |
|---|---|---|
| Ed25519 sign, 168-byte batch, ESP32-S3 | 38.1 ms | measured, 10 runs |
| Ed25519 verify on the ESP32-S3 | 60.4 to 61.4 ms | measured |
| Beacon period with the 1 s receive window | 12,000 ms every cycle | measured |
| Uplink inside the window, then 3 replies sent late on purpose | ok 7, none 19, bad 0 (as predicted) | measured on the beacon |
| RSSI and SNR at bench range | -44 to -61 dBm, 10.2 to 11.8 dB | measured |
| RSSI and SNR with the boards further apart | -74 to -84 dBm, 3.5 to 9.2 dB | measured |

### Verification

| Test | Result |
|---|---|
| Genuine batches | every frame VERIFIED |
| Attack, checking on | the fake FAKE REJECTED, the genuine frame VERIFIED |
| Attack, checking off | both ACCEPTED |
| Corrupted signature | all 6 frames REJECTED |
| Frames sent before the verifier started, or while the USB cable was out | MISSING, never verified |

### Payload sensors (Pi, on the bench)

| Sensor | Reading |
|---|---|
| MS5611, outside | 94,143.9 Pa, 28.22 C, factory calibration checksum ok |
| BMP280, inside | 94,042.2 Pa, 28.29 C (within its own 1 hPa absolute accuracy of the MS5611, datasheet) |
| SoC | 41.4 to 44.1 C |
| C270 | 5 to 6 kB JPEG frames at 640 x 480 |

### Decision loop (no 0G key, run `tap-burst-test-2`, about 6.5 min)

| Item | Result |
|---|---|
| Burst checkpoint | first fired when the replay fell from 19,288 m (T+69 min) to 17,239 m (T+74 min); asked again every 30 s while descending (6 times) |
| Safe stops reaching the beacon | 8 lines, 160 bytes, received intact |
| Frames deleted without a decision | none |

### Live MS5611 reading in the radio frames (run `baro-test`)

| Check | Result |
|---|---|
| Pi sending | `baro to beacon 939.23 hPa` in the agent's status |
| On the ground | seq 727 to 731: `live 939.2 to 939.3 hPa, 28.93 to 29.02 C (pi)`, all VERIFIED: the signature covers the live reading |
| Agent stopped | from the next frames (seq 733 on), no live reading; frames still VERIFIED |

### Fly any flight on the real hardware (7 Nov 2026)

On the main map, **Flight ▾** (or **Fly** on the Flights page) lists HAB-1, Tawhiri simulations
and public balloons near India (SondeHub). Picking one sends it to the beacon over Wi-Fi; the
beacon then transmits it exactly as it does HAB-1's replay: signed batches, verified on the
ground, published to Arkiv, with the Pi's live barometer in every frame. The station
(`/api/flight` in `station/server.mjs`) resamples the flight to at most 180 points (one per
minute where it fits), adds standard-atmosphere pressure and temperature, starts it on the pad
(-60 s) so every receiver resets, and sends `flight new / add / go` to the beacon (firmware: a
second sample table in RAM; `flight builtin` or a reboot returns to HAB-1). Landing
re-prediction is paused for uploaded flights, because the cached winds are for HAB-1's day and pad.

Measured: a Tawhiri flight from Pune (126 samples, peak 19,372 m) switched in 7.5 s; the next
batch, seq 12 to 17 at 18.50 N 73.8 E climbing from 4,374 to 9,822 m, had a valid signature and
all 6 frames VERIFIED.

### 0G over LoRa: a 0G decision reaches the payload with no internet on board (run `lora-1106`, 6 Nov 2026)

In flight the payload has no internet, so 0G is reached through the radio. The ground station
(`zg/radio_brain.mjs`) follows the verified frames, and at the burst checkpoint asks 0G exactly
what the Pi would ask (Vela 2.0 9B, gate 0.8; if 0G's decision models are down, glm-5.3 sealed,
then 0gm-1.0). It packs the answer into the 27-byte payload of the ground board's uplink
(`up <hex>`): checkpoint, action, probability, model, the frame it is based on, the time, the
first 6 bytes of the 0G request ID, and an 8-byte HMAC-SHA256 tag with a key shared before
flight (`ZG_RADIO_KEY`). Each decision goes out in 3 consecutive uplink windows. The beacon
(one firmware line, updated over the air) passes uplink payloads to the Pi on the tap wire as
`UP <seq> <hex>`; the Pi checks the tag, the time (5 min) and the frame (recent), ignores
repeats, acts, and signs the record like any other decision. The full answer (probabilities,
request IDs, provider) stays in `zg/radio/<run>.jsonl` on the ground, matched by request ID.

Measured, with the Pi's internet blocked from 22:10:09 IST (it kept its Wi-Fi only for us to watch):

| Step | Result |
|---|---|
| Pi's own burst checks | 2 safe stops (`Connection refused`): nothing changed, nothing made up |
| Ground station | burst checkpoint at verified seq 15 (17,239 m, 2,049 m below the peak); Vela 2.0 9B `start_recovery` P = 0.924, request `6ed50d3e-8dea-4e5c-929c-70d117a48d52`, 4 s; payload `5a0101eb010f0000004a03ee6a6ed50d3e8deada739e528b99856f`, queued for 3 uplink windows |
| Pi | `[burst] start_recovery -> phase=descent (0G decision received over LoRa)`, request `lora:6ed50d3e8dea`, P 0.925 (one byte of resolution), signed into the episode log |
| Checked before (bench) | a copy with one byte changed is rejected (bad tag); the same decision again is ignored |

Limits: the decision arrives once the batch it is based on is verified (up to 84 s after the
frame), which is fine for burst (the descent lasts about 55 min); only checkpoints the ground can
see from the frames (burst) go this way; thermal stays on the Pi (safe stop when offline). The
8-byte tag uses a key shared before flight, not the ground station's Ed25519 key, because a 64-byte
signature does not fit in the 27-byte uplink.

### Offline: LoRa only, the Pi with no internet (run `retest-1106`, 6 Nov 2026)

What a payload has in flight: no Wi-Fi, no internet. The Pi's Wi-Fi was switched off for
3 minutes (10:56:50 to 10:59:48 IST) while everything else kept running.

| Part | What it did offline |
|---|---|
| Pi to beacon (tap wire) | kept sending `BARO` every 5 s: all 13 frames sent in the window (seq 114 to 126) carry the Pi's live reading, 1016.2 hPa, source `pi` |
| Beacon to ground (LoRa) | kept beaconing and signing: 13 data frames, 2 SIG frames, both signatures VALID, rssi -49 to -50 dBm |
| Ground verifier (laptop) | 12 frames VERIFIED inside the window, the 13th after its SIG; verification needs no network |
| Arkiv, Hedera | written by the ground station, which has its own internet; nothing on board needs it |
| Pi decisions (0G) | every checkpoint in the window was a signed **safe stop** (`APIConnectionError`): nothing changed, nothing deleted, no decision made up. These records are in the episode log on 0G Storage (see 0G above); real 0G answers resumed when Wi-Fi returned, including `start_recovery` at burst |

The beacon and the ground board never use Wi-Fi for the radio link: on both, Wi-Fi only
mirrors the log and takes commands on the bench (port 2323). The radio sale above (voucher,
delivery, refusals) ran over LoRa alone; only the settlement, on the ground, used the internet.

### Verifier: frames left over from before a beacon restart (found 6 Nov 2026)

The payload box was power-cycled in the middle of a batch (beacon boot 11, seqs 192 to 195
heard, their SIG frame never sent). After the restart the beacon counted up again from 0
(boot 12), and when boot 12 reached seq 192 its SIG frame did not match the four old frames,
so the verifier logged them **FAKE REJECTED** and 4 Packet entities went to Arkiv as
`verdict=fake`. Nothing unsigned was accepted, but the label was wrong: they were genuine,
unsigned frames. A batch spans 7 slots (84 s), so the verifier now drops any pending frame
heard more than 150 s before a valid SIG frame as **UNSIGNED** (`verdict=unsigned` on Arkiv),
and the Protocol page does the same. A forger cannot use this: a fake must be sent now, so it
is never that old, and a replayed recording of a real frame is also heard now. Replaying the
logged bytes of that batch through the new verifier: 6 VERIFIED, 4 UNSIGNED, and a freshly
forged frame for seq 194 FAKE REJECTED.

### Radio sale between the two boards (run `retest-1106`, 6 Nov 2026)

| Step | Result |
|---|---|
| Buyer account from the board's key | [`0.0.11327397`](https://hashscan.io/testnet/account/0.0.11327397), key `ca3798af...13b104` (ED25519, mirror node), made on the ground Heltec (6 Nov 2026) |
| Allowance signed by the board itself (`hsign` over USB) | 1 HBAR to `0.0.11327348`, accepted by Hedera, tx [`0.0.11326830@1793898902.991873791`](https://hashscan.io/testnet/transaction/0.0.11326830-1793898902-991873791), `SUCCESS` |
| Voucher 1, beacon just after a reboot | sold, but the ground Heltec dropped off USB, so frames 713 and 714 were never verified. The settler refused to charge for wind it could not check: **not charged** |
| Fix | the beacon sells only if the batch's remaining frames and its SIG still fit under the guard |
| Voucher 2 | BUY sent in the window after data seq 24; DELIVERY: wind **3.31 m/s toward 6.5 deg at 3,356 m** from frames 22 and 23, signature VALID on the ground (rssi -42, snr 10.5) |
| Settlement | checks passed (buyer signature, beacon signature, wind recomputed from signed frames 22 and 23); 1,000,000 tinybar taken from the board's allowance: [`0.0.11327348@1793941589.246649214`](https://hashscan.io/testnet/transaction/0.0.11327348@1793941589.246649214), `SUCCESS`, memo "HAB radio voucher 2", HCS #6. The merchant paid the network fee (146,174 tinybar) |
| Run again | "already settled": no second charge |

**Refused on the beacon, live** (beacon log over Wi-Fi, port 2323; each one: no reply sent, nothing to settle):

| Voucher | What was wrong | Beacon's answer |
|---|---|---|
| 7 | pays `0.0.11326830` instead of the beacon's `payTo` `0.0.11327348` | `REFUSED: voucher pays another account` |
| 8 | claims to come from account `0.0.11326830`, not the beacon's buyer | `REFUSED: unknown buyer` |
| 9 | 1,000 tinybar, below the price | `REFUSED: price below ours` |

(Vouchers 3 to 6 were the same two bad vouchers sent before the beacon log was being captured:
no delivery was heard for any of them, and the settler has nothing to charge.)

**Refused by the settler** (`radio_settle.mjs --check-only --logs <dir>` on copies of voucher
2's log, one bit flipped each time; rerun 6 Nov 2026 on the new deployment):

| Change | Result |
|---|---|
| none | all checks pass, wind recomputed 3.31 m/s toward 6.5 deg |
| wind speed byte in the delivery | would NOT settle: delivery not signed by the beacon |
| delivery signature | would NOT settle: delivery not signed by the beacon |
| price byte in the voucher | would NOT settle: voucher signature does not match the buyer account's key |
| voucher signature | would NOT settle: voucher signature does not match the buyer account's key |
| the wind written in the log's text, not the frame (set to 99.9 m/s) | ignored: all checks still pass on 3.31 m/s, because the settler reads only the signed bytes (it used to read the text field; this test found that, and it was fixed) |

### x402 over the radio (session `live-1106`, 6 Nov 2026)

| Step | Result |
|---|---|
| The encoder | the firmware's C and the laptop's JS build the identical 84-byte body for the same fields; the Hedera SDK decodes it as a TransferTransaction (fee payer, node 0.0.3, memo, both transfers) and the signature verifies |
| Purchase, start to finish | 30.6 s (measured, 6 Nov 2026, new deployment, started from the ground station console): REQ after seq 638; 402 for 1,000,000 tinybar to `0.0.11327348`, challenge `846a9094`; PAY signed on the ground board and sent after seq 639; facilitator **verify: valid** at 22.1 s, **settle: settled** at 23.9 s; HCS audit #4; DELIVERY from the beacon at 30.6 s: wind 2.43 m/s toward 157.2 deg at 18,264 m, signature VALID |
| On Hedera | [`0.0.9185802@1793919359.131480516`](https://hashscan.io/testnet/transaction/0.0.9185802-1793919359-131480516), `SUCCESS`, memo "x402 radio 846a9094", 1,000,000 tinybar from `0.0.11327397` (the board) to `0.0.11327348`, network fee 293,541 tinybar paid by the facilitator `0.0.9185802` |
| Beacon airtime | duty 2.27 to 2.29 % through the purchase; every SIG frame sent |
| Found on the way | (1) a firmware log line was cut at 320 characters, so the payment record never reached the laptop: buffer raised to 1,024. (2) The ground station settled as soon as the board signed, and its SETTLED took the PAY's place in the queue: the beacon never got the payment and released nothing, although [`0.0.9185802@1793711208.142802767`](https://hashscan.io/testnet/transaction/0.0.9185802@1793711208.142802767) (HCS #11) had moved 0.01 HBAR. Now it settles only after the PAY is on the air |
| Not rerun after this firmware | the attack test (FAKE REJECTED) |

---

## Security and keys

- All keys are testnet only and live in `.env` (mode 600) or `wifi_secrets.h`, both
  git-ignored.
- The beacon's Ed25519 key is generated on the board and never leaves it; only the public key
  is shared, pinned from the USB output.
- The Pi's Ed25519 key is generated on the Pi (`~/ethglobal/pi_ed25519.key`, mode 600).
- Some testnet keys were pasted into a chat during development. Rotate them before any real use.
- The map uses Arkiv's public endpoint with no key, so no key is ever exposed in a page.
- The buyer node's key is generated on the ground Heltec and is also its Hedera account key.
  It signs Hedera transactions only through `hsign`, which is taken from the USB cable only
  and refuses anything that starts like a voucher. What the seller can take is capped by the
  allowance.

---

## What is not done

| Item | State |
|---|---|
| Range | tested at bench distance only; no uplink to a balloon at altitude has been measured |
| Flight use | signing, the uplink and the tap-line messages are not in HAB-1's flight firmware; a next flight needs that firmware work and an airtime check |
| Uplink payload | the uplink carries acks, radio-sale vouchers and x402 frames, 0G decisions for the Pi (27 bytes with an HMAC tag) and the demo's forged-frame command; x402 requests over HTTP are answered from verified data on the ground |
| 0G Compute Network directly | needs about 4 testnet 0G (3 for the ledger, 1 per provider); the deployer wallet has 0.497 |
| More than two radios | the radio sales run between the two boards we have; a relay through a third balloon needs a third LoRa board |
| x402 over the radio, far away | needs a ground station in range within 120 s (a Hedera transaction's valid window); the voucher mode covers longer gaps |
| Simulated Arkiv receivers | funded, not used |
| The site on storage we do not control (Swarm) | not done; the site is on Vercel ([hab-1.vercel.app](https://hab-1.vercel.app)) and reads Arkiv directly |
| Public live demo link | [hab-1.vercel.app](https://hab-1.vercel.app), deployed 7 Nov 2026 |
| Demo video | not done |
| Licence | MIT, [`LICENSE`](LICENSE) |
| Team names and contacts (Telegram, X) | to add |
| Git history | on GitHub: https://github.com/SHLOK333/HAB-1 |

---

## Repository layout

```
firmware/hab_node/   beacon and ground firmware (frames.h, hedera_body.h, net.h, replay_data.h, hab_node.ino)
probes/link_probe/   the first radio and signing probe
ground/              verifier.py, cmd.py, nodes.py, heltec.py, beacon_pubkey.hex
arkiv/               publish.mjs, query.mjs, schema.mjs and the Arkiv judging files
web/                 index.html, the first public map
site/                the console: index.html, console.js, pages.js, dock.js (static; hab-1.vercel.app)
station/             server.mjs, the ground-station bridge behind the live console (localhost:8090)
mission/             the flight as data: predictions, winds, analytics.mjs (0G over Arkiv)
mcp/                 the MCP server: the flight from Arkiv, signatures re-checked locally
hedera/              server.mjs, agent.mjs, flightdata.mjs, check_proof.mjs, setup.mjs, keys.mjs,
                     radio_setup.mjs, radio_settle.mjs, radio_x402.mjs, hedera_body.mjs
pi/                  agent.py, zg.py, sensors.py, uart_blast.py
zg/                  EpisodeRegistry.sol, deploy.mjs, upload.mjs, prove.mjs, radio_brain.mjs (0G over LoRa)
tools/               make_replay.py, pi.sh
CHANGING.md          how to change, redeploy and run from another laptop
DEMO.md              running the demo
.env.example         every variable the project reads
LICENSE              MIT
```

---

## How AI was used

The code, probes and documents in this repository were written with Claude Code (Anthropic)
working alongside the team: it proposed designs, wrote code, ran the tests on our hardware
through the command line, and read the partner SDKs. Every hardware result and on-chain
transaction quoted here was measured on our boards or read back from the chain during the
event, not taken from the AI's own claims.
