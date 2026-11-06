# Changing it: contracts, the Pi, the boards, and a new laptop

How to change any part of the project after a judge's comment, redeploy it, and get the
change onto the Pi and the boards, from any Mac or Linux laptop. For running the demo itself
see [DEMO.md](DEMO.md); for how everything works see [README.md](README.md).

## Contents

1. [What lives where](#1-what-lives-where)
2. [Setting up another laptop](#2-setting-up-another-laptop)
3. [Changing the contract and redeploying it](#3-changing-the-contract-and-redeploying-it)
4. [Putting changes on the Pi](#4-putting-changes-on-the-pi)
5. [Changing the firmware on the boards](#5-changing-the-firmware-on-the-boards)
6. [Changing the Hedera side](#6-changing-the-hedera-side)
7. [Changing what goes on Arkiv and the map](#7-changing-what-goes-on-arkiv-and-the-map)
8. [Things judges may ask for, and where to change them](#8-things-judges-may-ask-for-and-where-to-change-them)
9. [When something goes wrong](#9-when-something-goes-wrong)

---

## 1. What lives where

| Part | Runs on | Change it in | Gets there by |
|---|---|---|---|
| EpisodeRegistry contract | 0G Galileo testnet (chain 16602) | `zg/EpisodeRegistry.sol` | `zg/deploy.mjs` (new address goes into `.env`) |
| Episode upload (0G Storage, then the contract) | the laptop (or the Pi, section 4) | `zg/upload.mjs` | runs where you start it |
| Decision loop, sensors, 0G calls | the Pi | `pi/agent.py`, `pi/zg.py`, `pi/sensors.py` | `tools/pi.sh sync`, then restart the agent |
| 0G key on the Pi | the Pi, `~/ethglobal/.env` | `.env` on the laptop | `./demo.sh pi-key` |
| Beacon and ground firmware | the two Heltecs | `firmware/hab_node/*` | compile, then USB or over Wi-Fi |
| Verifier, commands to the boards | the laptop | `ground/*.py` | runs where you start it |
| x402 endpoint, agent, radio settlement | the laptop | `hedera/*.mjs` | runs where you start it |
| Arkiv publisher | the laptop | `arkiv/*.mjs` | runs where you start it |
| Public map | any browser (reads Arkiv itself) | `web/index.html` | serve the folder, or host it anywhere |
| Settings the boards keep in flash | the Heltecs | commands (`buyer`, `payto`, `price`, `feepayer`, `station`, `x402policy`) | `ground/cmd.py`, `ground/state/ground_cmds`, the `radio-*setup` commands |

**The Pi does not call the contract.** It signs every decision; the laptop puts the signed
log on 0G Storage and records the root in the contract. If judges want the payload itself to
write on chain, section 4 shows how to run the same upload on the Pi.

---

## 2. Setting up another laptop

Mac or Linux. Windows is not tested: use a Linux machine or a Mac if you can. (On Windows,
WSL2 does not see USB serial ports without extra tools, and the scripts are bash.)

### 2.1 Software

| Software | Version used | Why | Install (Mac, with Homebrew) | Install (Ubuntu or Debian) |
|---|---|---|---|---|
| Homebrew | any | installs the rest on a Mac | see brew.sh | not needed |
| git | any | get the code | `brew install git` | `sudo apt install git` |
| Python | 3.12 (3.10 or later works) | verifier, board commands | `brew install python@3.12` | `sudo apt install python3 python3-venv` |
| Node.js | 25.2.1 (22.10 or later) | Hedera, Arkiv, 0G scripts | `brew install node` | from nodejs.org or `nvm install 22` |
| arduino-cli | 1.5.1 | build and flash the Heltecs | `brew install arduino-cli` | `curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \| sh` |
| ESP32 Arduino core | **3.3.11** (exactly) | the Heltec V3 board support | below | below |
| Arduino libraries | RadioLib 7.7.1, Crypto 0.4.0, Adafruit SSD1306 2.5.17, Adafruit GFX 1.12.6, Adafruit BMP280 3.0.0, Adafruit Unified Sensor 1.1.15, Adafruit BusIO 1.17.4 | radio, Ed25519, screen, barometer | below | below |
| rsync, ssh | built in | reach the Pi | built in on Mac | `sudo apt install rsync openssh-client` |
| USB driver for the Heltec (CP2102) | built in | serial port | built into macOS | built into Linux; add yourself to `dialout`: `sudo usermod -aG dialout $USER`, then log out and in |

Not needed: Hardhat, Foundry, Remix, a Solidity compiler install. The contract is compiled by
`solc` from npm inside `zg/`.

The board support and libraries, the same on Mac and Linux:

```bash
arduino-cli config init
arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32@3.3.11
arduino-cli lib install "RadioLib@7.7.1" "Crypto@0.4.0" "Adafruit SSD1306@2.5.17" "Adafruit GFX Library@1.12.6" "Adafruit BMP280 Library@3.0.0" "Adafruit Unified Sensor@1.1.15" "Adafruit BusIO@1.17.4"
```

### 2.2 The code

Once the repository exists, clone it. Until then, copy the whole project folder (without
`node_modules` and `.venv`, which are rebuilt).

```bash
git clone <repo url> ethglobal && cd ethglobal
./demo.sh setup          # Python venv and the npm packages of arkiv/, hedera/ and zg/
```

### 2.3 Files that are not in the repository

These are secret or made on this laptop. Copy them over by USB stick or AirDrop. **Never by
chat or email.**

| File | Needed for | If you lose it |
|---|---|---|
| `.env` | every key and account: 0G, Hedera, Arkiv, ground station key | testnet only: make new wallets, redo the setup scripts, redeploy |
| `firmware/hab_node/wifi_secrets.h` | building firmware (hotspot name and password, update password) | write it again: `STA_SSID`, `STA_PASS`, `AP_PASS` |
| `~/.ssh/hab1_pi` and `~/.ssh/known_hosts_hab1` | reaching the Pi | log in with the Pi's password and add a new key (`ssh-copy-id`) |
| `ground/beacon_pubkey.hex` | the verifier trusts this beacon key (also in the repo) | `ground/cmd.py beacon pubkey --pin` |
| `hedera/state/radio_settled.jsonl` | which radio vouchers were already paid | without it the settler could try to charge an old voucher twice (Hedera would still stop it at the allowance) |
| `ground/log/` | evidence: every frame and verdict heard | optional; only for showing old runs |

Keys made on the boards (the beacon's key, the buyer board's key) live on the boards and go
wherever the boards go. Nothing to copy.

After copying, set the file permissions and check everything:

```bash
chmod 600 .env ~/.ssh/hab1_pi
./demo.sh check
```

### 2.4 Network

- The new laptop joins the **same iPhone hotspot**. It holds 3 devices: laptop, Pi, beacon.
  The ground Heltec is on USB, so it needs no Wi-Fi.
- If the Pi's address is not `172.20.10.4`, find it and pass it on:
  `arp -a | grep 172.20.10` then `export PI_HOST=172.20.10.x` (or put it in front of every
  command: `PI_HOST=172.20.10.x ./demo.sh check`).
- **If you use a different hotspot** (new name or password): put it in
  `wifi_secrets.h`, flash both boards over USB (section 5), and on the Pi run
  `tools/pi.sh 'sudo nmcli dev wifi connect "<name>" password "<password>"'` while it is still
  on the old network.

### 2.5 The first time on a new Mac

- The ground Heltec shows up as `/dev/cu.usbserial-0001`; on Linux as `/dev/ttyUSB0`.
  `demo.sh` finds either.
- macOS asks to allow incoming connections for Python the first time the map server starts:
  allow it.
- The over-the-air update tool lives inside the ESP32 core:
  - Mac: `~/Library/Arduino15/packages/esp32/hardware/esp32/3.3.11/tools/espota.py`
  - Linux: `~/.arduino15/packages/esp32/hardware/esp32/3.3.11/tools/espota.py`

---

## 3. Changing the contract and redeploying it

### 3.1 The usual change

```bash
# 1. edit zg/EpisodeRegistry.sol
# 2. the Pi's public key (the contract stores it); it is printed when the agent starts:
tools/pi.sh 'grep -m1 "pi key" ~/ethglobal/agent-*.log'
#    or: tools/pi.sh 'cd ~/ethglobal && .venv/bin/python -c "import sys; sys.path.insert(0,\"pi\"); import agent; print(agent.signing_key().verify_key.encode().hex())"'
# 3. deploy (compiles, deploys, writes ZG_REGISTRY_ADDRESS into .env and the ABI file)
cd zg && node --env-file=../.env deploy.mjs <pi public key>
# 4. check it with one upload
node --env-file=../.env upload.mjs <run name>
```

- `deploy.mjs` writes the new address into `.env` (`ZG_REGISTRY_ADDRESS`) and the new ABI into
  `zg/EpisodeRegistry.abi.json`. `upload.mjs` reads both, so nothing else needs editing
  unless you changed the `record` function.
- The old contract stays on chain with its entries. Say which address is current in the
  README's 0G table, and keep the old one listed.
- A deploy cost 393,461 gas. The wallet had 0.495 0G; the faucet gives 0.1 a day. Check:
  `cd zg && node --env-file=../.env -e 'const {ethers}=require("ethers");new ethers.JsonRpcProvider(process.env.ZG_EVM_RPC).getBalance(new ethers.Wallet(process.env.ZG_PRIVATE_KEY).address).then(b=>console.log(ethers.formatEther(b)))'`

### 3.2 What else to edit, by kind of change

| You changed | Also change |
|---|---|
| Only the inside of a function, or added a view function | nothing |
| The constructor's arguments | the `factory.deploy(...)` line in `zg/deploy.mjs` |
| `record(...)`'s arguments | the `reg.record(...)` line in `zg/upload.mjs` |
| The `Episode` struct | `upload.mjs` if it is filled from there; the README 0G section |
| Who may record | the `require(msg.sender == recorder)` line; whoever records needs `ZG_PRIVATE_KEY` of that address |
| The network (e.g. 0G mainnet) | `ZG_EVM_RPC` and `ZG_INDEXER_RPC` in `.env`, and the explorer links printed by both scripts |

### 3.3 Examples judges might ask for

**"Put the 0G request IDs on chain, not just the file root."** Add a field and pass it:

```solidity
struct Episode { bytes32 root; uint32 decisions; uint32 safeStops; uint64 recordedAt; bytes32 requestIdsHash; }
function record(string calldata run, bytes32 root, uint32 decisions, uint32 safeStops, bytes32 requestIdsHash) external { ... }
```

In `upload.mjs`, before `reg.record`:
`const idsHash = ethers.keccak256(ethers.toUtf8Bytes(recs.map(r => r.request_id ?? "").join(",")))`
and pass it as the last argument.

**"Let the contract check the Pi's signature."** On-chain Ed25519 checking is expensive and
not built into the EVM. Keep the check off chain (anyone can run it with the stored
`payloadKey`) and say so; or store each record's hash so a challenger can point at a bad one.

**"Anyone should be able to record, not only you."** Remove the `require` in `record` and add
`address recordedBy` to the struct (`msg.sender`), so readers see who wrote each entry.

---

## 4. Putting changes on the Pi

### 4.1 Code

```bash
tools/pi.sh sync                     # copies pi/ to ~/ethglobal/pi on the Pi
```

Then restart the agent. With the boot service installed:

```bash
tools/pi.sh 'sudo systemctl restart hab-agent && journalctl -u hab-agent -n 5 -o cat'
```

Without it (stop the old one, start the new one so it outlives the ssh session):

```bash
tools/pi.sh 'pkill -f "[p]i/agent.py"'
tools/pi.sh 'cd ~/ethglobal && setsid nohup .venv/bin/python -u pi/agent.py --run <run name> --vision-s 90 > agent-<run name>.log 2>&1 < /dev/null &'
tools/pi.sh 'tail -3 ~/ethglobal/agent-<run name>.log'
```

(If the second command does not return, press Ctrl+C: the agent keeps running.)

Install the boot service once, so the agent starts by itself and `demo.sh start` can
restart it (it asks for the Pi's sudo password):

```bash
tools/pi.sh 'sudo cp ~/ethglobal/pi/hab-agent.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now hab-agent && systemctl is-active hab-agent'
```

### 4.2 The 0G key, or another model

- Key: put `ZG_PC_API_KEY` (and `ZG_PC_BASE_URL`) in the laptop's `.env`, then
  `./demo.sh pi-key`. It copies only those two lines to the Pi and restarts the service.
- Model: `DECISION_MODEL` and `VISION_MODEL` at the top of `pi/zg.py`, then sync and restart.

### 4.3 The Pi writing to the contract itself

If judges want the payload, not the laptop, to put its log on 0G Storage and record it:

```bash
# once: Node on the Pi (needs 20.6 or later for --env-file: check the version it prints)
tools/pi.sh 'sudo apt install -y nodejs npm && node --version'
rsync -a --exclude node_modules --exclude episodes -e "ssh -i $HOME/.ssh/hab1_pi -o UserKnownHostsFile=$HOME/.ssh/known_hosts_hab1" zg/ hab@${PI_HOST:-172.20.10.4}:ethglobal/zg/
tools/pi.sh 'cd ~/ethglobal/zg && npm install --silent'
# the wallet and the contract address go to the Pi's .env (testnet keys only)
grep -E "^ZG_(PRIVATE_KEY|EVM_RPC|INDEXER_RPC|REGISTRY_ADDRESS)=" .env | tools/pi.sh 'umask 077; cat >> ~/ethglobal/.env'
# then, on the Pi:
tools/pi.sh 'cd ~/ethglobal/zg && ZG_EPISODE_DIR=~/ethglobal/episodes node --env-file=../.env upload.mjs <run name>'
```

The Pi then holds a key that pays for storage. Keep that wallet's balance small.

---

## 5. Changing the firmware on the boards

**Always compile first, each role in its own build folder, and upload only if the compile
succeeded.** `arduino-cli upload` flashes whatever was built last, not the current source.

```bash
cd firmware
rm -rf /tmp/hab_node_role1 /tmp/hab_node_role2
arduino-cli compile --fqbn esp32:esp32:heltec_wifi_lora_32_V3 --build-property "compiler.cpp.extra_flags=-DROLE=1" --build-path /tmp/hab_node_role1 hab_node
arduino-cli compile --fqbn esp32:esp32:heltec_wifi_lora_32_V3 --build-property "compiler.cpp.extra_flags=-DROLE=2" --build-path /tmp/hab_node_role2 hab_node
```

| Board | How to flash |
|---|---|
| Ground (role 2), on USB | `./demo.sh stop` first (the verifier holds the port), then `arduino-cli upload -p /dev/cu.usbserial-0001 --fqbn esp32:esp32:heltec_wifi_lora_32_V3 --input-dir /tmp/hab_node_role2 hab_node` |
| Beacon (role 1), on Wi-Fi | `python3 <espota.py> -i 172.20.10.10 -a <AP_PASS> -t 90 -f /tmp/hab_node_role1/hab_node.ino.bin`. It often fails with "Broken pipe" on a weak hotspot: try again after 20 s. It worked when `ground/cmd.py beacon status` shows a seq below 10 (it rebooted) |
| Beacon, on USB (sure way) | plug it into the laptop, then the same `arduino-cli upload` with `/tmp/hab_node_role1` |

- **Keys and settings survive flashing.** The beacon keeps its key, the buyer settings,
  the price and the last nonce; the ground board keeps its key, nonce and x402 limits.
  If you ever erase the flash, the beacon makes a new key: pin it again
  (`ground/cmd.py beacon pubkey --pin`), and redo `./demo.sh radio-setup` and
  `./demo.sh radio-x402-setup`.
- **After a reboot the beacon waits** about 5 to 8 minutes before it will sell anything
  over the radio (airtime has to build up first). Plan flashing well before a demo.
- **Changing a frame layout** means changing these together: `firmware/hab_node/frames.h`,
  `ground/verifier.py`, `hedera/flightdata.mjs` and `hedera/check_proof.mjs` (DATA and SIG),
  `hedera/radio_settle.mjs` (BUY and DELIVERY), `hedera/radio_x402.mjs` (x402 frames),
  `pi/agent.py` (DATA over the tap line).
- **Changing the Hedera transfer the board signs** means changing both encoders together:
  `firmware/hab_node/hedera_body.h` and `hedera/hedera_body.mjs`. Check they still match
  (it should print two identical lines):

```bash
c++ -std=c++17 -x c++ - -o /tmp/hb -I firmware/hab_node <<'EOF'
#include "hedera_body.h"
int main(){ uint8_t b[128]; size_t n=hederaBody(b,9185802,1793706000,12345,11292562,11289454,1000000,0xdeadbeef); for(size_t i=0;i<n;i++) printf("%02x",b[i]); printf("\n"); }
EOF
/tmp/hb; (cd hedera && node --input-type=module -e 'import {transferBody} from "./hedera_body.mjs"; console.log(transferBody({feePayer:9185802,validS:1793706000,validNs:12345,payer:11292562,payTo:11289454,amount:1000000,challenge:0xdeadbeef}).toString("hex"))')
```

---

## 6. Changing the Hedera side

| Change | Where | Then |
|---|---|---|
| HTTP prices | `PRICES` in `hedera/server.mjs` (tinybar) | restart: `./demo.sh stop && ./demo.sh start` |
| Agent's limits | `MAX_PER_PAYMENT` in `hedera/agent.mjs`; budget via `AGENT_BUDGET_TINYBAR` | nothing |
| Facilitator | `X402_FACILITATOR_URL` in `.env` (x402.org and Blocky402 both tested) | restart, **and** `./demo.sh radio-x402-setup` so the beacon's 402 names the new fee payer |
| Radio price | `.venv/bin/python ground/cmd.py beacon price <tinybar>` | the buyer board's cap may need raising: edit `x402policy` in `hedera/radio_x402.mjs` |
| Radio buyer's allowance | `./demo.sh radio-setup <HBAR>` with the verifier stopped | it signs a new allowance on the board |
| New merchant or topic | clear `HEDERA_MERCHANT_*` and `HEDERA_AUDIT_TOPIC_ID` in `.env`, run `(cd hedera && node --env-file=../.env setup.mjs)` | redo `./demo.sh radio-setup` (the beacon's `payto`) |

Balances are on the mirror node, for example
`https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.11326830`.

---

## 7. Changing what goes on Arkiv and the map

- The schema is in **two places that must match**: `arkiv/schema.mjs` (the publisher) and the
  copy at the top of the script in `web/index.html` (the map).
- New fields: add them as `.optional()`, so older packets still read.
- An incompatible change: give it a new schema name (for example `boscon.hab.packet.v2`) and
  update both files. Old sessions stay readable under the old name.
- Restart the publisher (`./demo.sh stop && ./demo.sh start`); hard-reload the map
  (Cmd+Shift+R).
- To host the map anywhere: it is one static file that reads Arkiv directly. Upload
  `web/index.html` to any static host. Nothing else is needed.

---

## 8. Things judges may ask for, and where to change them

| They ask | Change | Push |
|---|---|---|
| "Use a different 0G model" | `pi/zg.py` | section 4.1 |
| "Store more on chain" | `zg/EpisodeRegistry.sol`, `zg/upload.mjs` | section 3 |
| "Make the Pi write on chain itself" | nothing in code | section 4.3 |
| "Show request IDs" | needs the 0G key: `./demo.sh pi-key` | section 4.2 |
| "Price it differently" | `hedera/server.mjs`, `beacon price` | section 6 |
| "Use another facilitator" | `.env` | section 6 |
| "Sign every frame, not every six" | `BATCH` in `frames.h` (airtime goes up: check the duty line the beacon prints at boot) | section 5 |
| "More receivers on Arkiv" | run the publisher with `--receiver sim1` / `sim2` on a copy of a log (label them simulated) | none |
| "Change the checkpoints" | `check_burst` / `check_thermal` / `check_vision` in `pi/agent.py` | section 4.1 |
| "Change the radio settings" | `FREQ_MHZ`, `LORA_SF` and so on at the top of `hab_node.ino`, the same on both boards | section 5, both boards |

After any change, run the part it touches once and note the result (transaction, root, or
log line) in the README's results, as the other results are noted.

---

## 9. When something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| `demo.sh check`: no ground Heltec | not plugged in, or a charge-only cable | another cable; Linux: the `dialout` group |
| Beacon not found on the hotspot | hotspot full (3 devices), or the beacon is off | `ground/cmd.py beacon status`; free a hotspot slot |
| Pi not reachable | its address changed, or it is off the hotspot | `arp -a`, then `PI_HOST=...` |
| Over-the-air update: "Broken pipe" | weak Wi-Fi | retry after 20 s, or flash over USB |
| Verifier shows nothing | the port belongs to another program | `./demo.sh stop`, close the Arduino serial monitor |
| Radio sale refused: "not enough airtime yet" | the beacon rebooted recently | wait 5 to 8 minutes |
| x402 radio: "no delivery within 150 s" | the board's PAY or SETTLED was refused by its duty guard, or the beacon refused | read `.demo/verifier.log` and the beacon log (`nc 172.20.10.10 2323`) |
| `deploy.mjs`: insufficient funds | 0G wallet empty | faucet.0g.ai, or ask the 0G booth |
| Every checkpoint says SAFE STOP | no 0G key on the Pi | `./demo.sh pi-key` |
| A command never ends | something waits on the network | Ctrl+C; check the hotspot first |
