# How HAB-1 uses 0G, Hedera and Arkiv

Each partner does one job that HAB-1 can't do without, and no two of them overlap. The links
below go to the exact lines, pinned to commit [`9df506d`](https://github.com/SHLOK333/HAB-1/tree/9df506d19e34a19d77fe25cb96c302181f94f47f),
so they keep pointing at the same code.

| Partner | Its one job | Without it |
|---|---|---|
| **0G** | Decides on the payload, and proves the decision | The payload can make no decision, only hold its safe state |
| **Hedera** | Gets the balloon's data paid for, machine to machine | No payment without a human, and no payment from a balloon with no internet |
| **Arkiv** | Publishes the track so anyone can check it | Everyone has to trust our server, and the track disappears when the server does |

## 0G: decides on the payload, and proves it

**Why 0G:**
- **The payload must decide on its own.** Has the balloon burst? Is the computer overheating? Is this camera frame worth the radio?
- **Calibrated decision models.** 0G's Vela 2.0 9B and Laya return probabilities, not just text, so the Pi acts only when the model is sure. For example, it switches to recovery mode only at P ≥ 0.8.
- **Checkable answers.** Every answer has a request ID that can be checked against an enclave signature registered on 0G mainnet.
- **A log nobody can quietly edit.** The signed log goes to 0G Storage, and its root to our contract on 0G Chain.
- **No faked fallback.** When 0G can't be reached, the payload holds a safe state and never makes a decision up.
- **No internet on board.** In flight, the ground station asks 0G and sends the answer up over LoRa in 27 bytes.

| What | Where |
|---|---|
| The models: vision (qwen3-vl-plus), Vela 2.0 9B, Laya, and the 0G fallback chain | [`zg.py:11`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/zg.py#L11), [`zg.py:17`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/zg.py#L17), [`zg.py:18`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/zg.py#L18), [`zg.py:24`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/zg.py#L24) |
| **The 0G call:** `POST /v1/decisions` | [`zg.py:50`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/zg.py#L50) |
| Acting only above a probability gate | [`zg.py:68`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/zg.py#L68) |
| The vision call | [`zg.py:91`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/zg.py#L91) |
| The gates: 0.8 burst, 0.8 thermal, 0.7 before deleting a frame | [`agent.py:36`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L36) |
| Vela first, then the 0G fallback chain if its providers are down | [`agent.py:196`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L196), [`agent.py:198`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L198) |
| **The burst decision changes the payload:** recovery mode | [`agent.py:248`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L248), [`agent.py:268`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L268) |
| **Safe stop when 0G is unreachable:** nothing changes, nothing is made up | [`agent.py:265`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L265), [`agent.py:289`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L289) |
| Camera frames: the vision model decides, Laya must confirm before any delete | [`agent.py:309`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L309), [`agent.py:319`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L319), [`agent.py:328`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L328) |
| The episode log record, with its safe-stop flag, synced to disk | [`agent.py:161`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L161), [`agent.py:165`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L165), [`agent.py:171`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L171) |
| 0G over LoRa: the ground asks Vela, packs 27 bytes, queues the uplink | [`radio_brain.mjs:47`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/zg/radio_brain.mjs#L47), [`radio_brain.mjs:85`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/zg/radio_brain.mjs#L85), [`radio_brain.mjs:92`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/zg/radio_brain.mjs#L92) |
| The HMAC tag on the uplinked decision | [`radio_packet.mjs:9`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/zg/radio_packet.mjs#L9) |
| The Pi checks the tag and acts on the decision | [`agent.py:218`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L218), [`agent.py:241`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/pi/agent.py#L241) |
| **Upload to 0G Storage**, then record the root on 0G Chain | [`upload.mjs:50`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/zg/upload.mjs#L50), [`upload.mjs:58`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/zg/upload.mjs#L58) |
| The registry contract: record and read back | [`EpisodeRegistry.sol:28`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/zg/EpisodeRegistry.sol#L28), [`EpisodeRegistry.sol:38`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/zg/EpisodeRegistry.sol#L38) |
| TEE proof: the provider's record on 0G mainnet, its signature, the signer check | [`prove.mjs:50`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/zg/prove.mjs#L50), [`prove.mjs:69`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/zg/prove.mjs#L69), [`prove.mjs:71`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/zg/prove.mjs#L71) |
| AI analysis of the Arkiv data, then a second 0G model checks its claims | [`analytics.mjs:102`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mission/analytics.mjs#L102), [`analytics.mjs:118`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mission/analytics.mjs#L118) |

## Hedera: the data gets paid for

**Why Hedera:**
- **The board signs its own payments.** Hedera accounts use Ed25519, the same key type our radio boards already sign with. A $5 ESP32 can sign a real Hedera transfer with a key that never leaves the chip.
- **Fees are fixed at about $0.0001.** Paying per piece of data makes sense.
- **Allowances.** A payment signed with no internet can settle later, with a hard cap on the worst case.
- **HCS.** A cheap, ordered, public log: our tamper-evident audit trail of every sale.
- **Standard x402.** Listed facilitators exist (x402.org, Blocky402), and swapping between them is one setting.

| What | Where |
|---|---|
| The x402 facilitator (x402.org, or Blocky402 by one setting) | [`server.mjs:29`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/server.mjs#L29) |
| The x402 server with Hedera's payment scheme | [`server.mjs:30`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/server.mjs#L30) |
| The paid endpoints: price in HBAR, the account that gets paid | [`server.mjs:31`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/server.mjs#L31) |
| Answers `402 Payment Required`, checks the payment header | [`server.mjs:89`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/server.mjs#L89) |
| **Settles the payment on Hedera**, before any data is returned | [`server.mjs:97`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/server.mjs#L97) |
| Writes each sale to the HCS audit topic | [`server.mjs:54`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/server.mjs#L54), [`server.mjs:104`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/server.mjs#L104) |
| The agent's Hedera signer | [`agent.mjs:26`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/agent.mjs#L26) |
| Spending controls: the per-payment cap and the seller allowlist | [`agent.mjs:29`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/agent.mjs#L29), [`agent.mjs:30`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/agent.mjs#L30) |
| The agent finds the endpoint, signs the payment, pays (no human approving) | [`agent.mjs:56`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/agent.mjs#L56), [`agent.mjs:44`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/agent.mjs#L44), [`agent.mjs:45`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/agent.mjs#L45) |
| **The ESP32 builds and signs a Hedera transfer itself** (x402 over LoRa) | [`hab_node.ino:772`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/firmware/hab_node/hab_node.ino#L772), [`hab_node.ino:774`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/firmware/hab_node/hab_node.ino#L774); transaction body: [`hedera_body.h:30`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/firmware/hab_node/hedera_body.h#L30) |
| The radio payment is verified and settled by the facilitator | [`radio_x402.mjs:91`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/radio_x402.mjs#L91), [`radio_x402.mjs:94`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/radio_x402.mjs#L94) |
| An offline voucher settles later from the allowance | [`radio_settle.mjs:119`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/radio_settle.mjs#L119), [`radio_settle.mjs:120`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/radio_settle.mjs#L120) |
| The allowance that caps the board's spending | [`radio_setup.mjs:55`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/radio_setup.mjs#L55) |
| The HCS topic is created | [`setup.mjs:43`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/hedera/setup.mjs#L43) |

## Arkiv: the track, public and checkable

**Why Arkiv:**
- **The track is a public good.** Recovery crews, other teams and the public need it, and nobody should have to trust our server for it.
- **Queryable on chain.** Arkiv stores each frame as an entity with fields you can query (altitude, position, verdict), which file storage can't do.
- **Owned by the receiver.** Each entity belongs to the wallet of the receiver that heard it, so a receiver can only vouch for what it heard itself.
- **Expiry.** Live positions expire after 7 days, which fits data that matters during a flight and its recovery.
- **No backend.** The website and the MCP server read the chain directly. The raw radio bytes are stored too, so anyone can re-check the beacon's signatures.

| What | Where |
|---|---|
| Entity types: radio frame, signature frame, session | [`schema.mjs:14`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/arkiv/schema.mjs#L14), [`schema.mjs:32`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/arkiv/schema.mjs#L32), [`schema.mjs:45`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/arkiv/schema.mjs#L45) |
| Entity types: wind, landing prediction, 0G insight, public balloon | [`schema.mjs:12`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mission/schema.mjs#L12), [`schema.mjs:27`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mission/schema.mjs#L27), [`schema.mjs:42`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mission/schema.mjs#L42), [`schema.mjs:59`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mission/schema.mjs#L59) |
| The receiver's own wallet; each session is written as an entity | [`publish.mjs:33`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/arkiv/publish.mjs#L33), [`publish.mjs:42`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/arkiv/publish.mjs#L42) |
| Expiry: 7 days for frames and signature frames | [`publish.mjs:59`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/arkiv/publish.mjs#L59), [`publish.mjs:70`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/arkiv/publish.mjs#L70) |
| **One transaction per signed batch of frames** | [`publish.mjs:97`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/arkiv/publish.mjs#L97) |
| Winds and predictions written in batches | [`publish.mjs:39`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mission/publish.mjs#L39) |
| The website connects to Arkiv with no key and no backend | [`console.js:564`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/site/console.js#L564) |
| The website lists sessions, newest first | [`console.js:573`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/site/console.js#L573) |
| The website plays a session's frames | [`console.js:590`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/site/console.js#L590) |
| **Live from Arkiv:** polls `seq >= last + 1` every 20 s | [`console.js:618`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/site/console.js#L618), [`console.js:645`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/site/console.js#L645) |
| The website shows the 0G insights | [`console.js:407`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/site/console.js#L407) |
| The Arkiv page counts entities in the browser | [`console.js:692`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/site/console.js#L692) |
| 0G analytics reads with attribute filters: `altM >= 8000`, `errorKm <= 2`, count by `verdict` | [`analytics.mjs:45`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mission/analytics.mjs#L45), [`analytics.mjs:56`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mission/analytics.mjs#L56), [`analytics.mjs:72`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mission/analytics.mjs#L72) |
| 0G analytics writes its insight back to Arkiv | [`analytics.mjs:160`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mission/analytics.mjs#L160) |
| The MCP server reads frames and signature frames from any receiver | [`server.mjs:66`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mcp/server.mjs#L66), [`server.mjs:67`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mcp/server.mjs#L67) |
| The MCP server re-checks the beacon's signature on your own machine | [`verify.mjs:39`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mcp/verify.mjs#L39), [`verify.mjs:40`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mcp/verify.mjs#L40), [`verify.mjs:44`](https://github.com/SHLOK333/HAB-1/blob/9df506d19e34a19d77fe25cb96c302181f94f47f/mcp/verify.mjs#L44) |
