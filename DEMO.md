# Running the demo on any laptop

Everything runs without an AI session. The boards and the Pi run on their own; the laptop
runs four small services, started and stopped by one script, `demo.sh`. Tested on macOS with
Node 25.2.1 and Python 3.12; any Mac or Linux laptop with Node 22.10 or later and Python 3.12
or later should work.


Changing something, or setting up another laptop: see [CHANGING.md](CHANGING.md).


**Before the next demo (4 Nov 2026): update the beacon's firmware.** The verifier now expects the new
signature frame (salted hashes, boot number). With the old beacon firmware nothing verifies, and
the verifier says so. Build and install it as in [CHANGING.md, section 5](CHANGING.md#5-changing-the-firmware-on-the-boards) (role 1, over Wi-Fi or USB), at
least 10 minutes before the demo.


The exact commands in pitch order, what can go wrong on stage, and running the ground board
without USB: [README, Running the demo](README.md#running-the-demo).

## What runs where

| Where | What | Starts how |
|---|---|---|
| Beacon Heltec | flight replay, signing, attack button | on power-up (firmware already flashed) |
| Ground Heltec | radio modem | on power-up; plugged into the demo laptop's USB |
| Raspberry Pi | decision loop (`hab-agent` service) | at boot, once the service is installed (step 4 below) |
| Demo laptop | verifier, Arkiv publisher, x402 endpoint, map | `./demo.sh start` |

## One-time setup on the demo laptop

1. **Copy this whole folder** to the demo laptop. Leave out `node_modules/` and `.venv/`;
   setup rebuilds them. The folder must include:
   - `.env` (all keys; never commit or share it)
   - `ground/beacon_pubkey.hex` (the beacon's pinned public key)
2. **Copy the Pi's SSH key:** `~/.ssh/hab1_pi` and `~/.ssh/known_hosts_hab1` into `~/.ssh/` on
   the demo laptop, then `chmod 600 ~/.ssh/hab1_pi`.
3. **Install Node 22.10 or later and Python 3.12 or later**, then in the folder:
   ```bash
   ./demo.sh setup
   ```
   On Linux, add yourself to the serial group once: `sudo usermod -aG dialout $USER`, then log
   out and in.
4. **Install the Pi's agent as a boot service** (run once, from the folder):
   ```bash
   tools/pi.sh 'sudo cp ~/ethglobal/pi/hab-agent.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now hab-agent && systemctl is-active hab-agent'
   ```
   It should print `active`. From then on the Pi starts the agent at every boot.
5. **When the 0G Private Computer key arrives:** put `ZG_PC_API_KEY=sk-...` in `.env`, then
   ```bash
   ./demo.sh pi-key
   ```
   It copies the key to the Pi without printing it and restarts the agent.

## Before each demo

1. **Network.** Join the demo laptop to the iPhone hotspot. The hotspot took only **three
   devices** in our tests (a fourth got `ASSOC_TOOMANY`), so it must be: the demo laptop, the
   Pi and the beacon. Take any other laptop or phone off it. Keep the iPhone's Personal Hotspot
   screen open, with **Allow Others to Join** and **Maximize Compatibility** on.
2. **Power** the beacon (its battery, or any USB power) and the Pi. Plug the **ground Heltec**
   into the demo laptop. Antennas on both Heltecs before power.
3. **Check:**
   ```bash
   ./demo.sh check
   ```
   Every line should say `ok`. If the Pi's address changed, run `PI_HOST=172.20.10.x ./demo.sh check`.
4. **Start:**
   ```bash
   ./demo.sh start demo-final
   ```
   Open the map link it prints (`http://localhost:8097/?run=demo-final`).

Radio sales need a one-time setup (already done for the boards we have): with the verifier
stopped, `./demo.sh radio-setup`. It makes the buyer's Hedera account from the ground Heltec's
own key and has the board sign the allowance.

## The demo, step by step

| Pitch moment | Do | Show |
|---|---|---|
| The real flight, replayed | nothing; wait one batch (about 84 s) | map track grows in green; `./demo.sh logs verifier` shows VERIFIED |
| A fake frame | press **PRG** on the beacon, or `./demo.sh attack` | verifier: FAKE REJECTED; a red dot on the map after the next batch |
| What HAB-1 would have done | `./demo.sh noverify`, then press PRG within 30 s | the fake is ACCEPTED. Afterwards `./demo.sh stop && ./demo.sh start demo-final-2` |
| 0G decides | wait for the replay to pass burst (about every 6 min); `./demo.sh pi-log` | `[burst] start_recovery ... vela-2.0-9b: P(start_recovery) = 0.92, threshold 0.8` with a request ID; "0G: recovery" on the beacon screen; `[vision] drop -> deleted (laya P(empty) = 0.9)` when Laya confirms a frame is empty. In the console: Ledger tab, each 0G analysis shows "claims checked by vela-2.0-9b" |
| Offline, LoRa only | turn the iPhone hotspot off for 2 to 3 minutes (the payload has no internet in flight) | the console keeps receiving: every frame still VERIFIED and still carries the Pi's live hPa (`(pi)` in the verifier log). Turn the hotspot back on with its Settings screen open, so the Pi rejoins |
| Safe stop | switch the Pi's internet off (or no 0G key) | `SAFE STOP` in `pi-log`; "SAFE STOP: no 0G" on the beacon; nothing deleted |
| An agent pays | `./demo.sh buy 15000 5000` | wind data, a transaction with its HashScan link, an HCS message number, then each frame's proof `ok:true` |
| Two radios trade, no internet | `./demo.sh radio-buy` (the beacon must have been on for 10 min: a sale waits until the airtime is there, and sells at most every 5 min) | verifier: `voucher nonce N signed`, `BUY nonce N sent`, `DELIVERY nonce N: wind ... signature VALID`; ground screen "WIND x m/s ok"; `./demo.sh sales` on the beacon |
| x402 between two balloons | `./demo.sh radio-x402` (once: `./demo.sh radio-x402-setup`; same airtime rule as above) | REQ, `402 Payment Required`, `PAY heard on the air`, `facilitator settle: SETTLED`, then `DELIVERY ... paid over x402` and a HashScan link, about 30 s |
| It settles on the ground | `./demo.sh radio-settle` (about 2 min after the buy, once both frames are verified) | checks pass, `SETTLED voucher N` with a HashScan link and an HCS message number |
| Episode log on 0G | `./demo.sh upload` | a 0G Storage root and an EpisodeRegistry transaction |
| Our server is not needed to read | `./demo.sh stop`, then reload the map | the map still loads from Arkiv |

After the demo: `./demo.sh stop`.

## If something is wrong

| Symptom | Fix |
|---|---|
| `beacon not found on the hotspot` | power-cycle the beacon; check the hotspot holds only three devices |
| `Pi not reachable` | open the iPhone's Personal Hotspot screen first (the iPhone stops advertising when it is closed, and the Pi will not retry a missed hotspot until it reboots), then power-cycle the Pi and wait about 90 s; check the address with `PI_HOST=...` |
| `no ground Heltec on USB` | replug it; try another cable (some are charge-only) |
| Map shows an old version or no change | hard reload: Cmd+Shift+R (Ctrl+Shift+R on Linux) |
| Map shows nothing | wait for the first signed batch (about 84 s after start); check `./demo.sh status` |
| `buy` answers 404, not charged | nothing verified near that height yet; ask for a height the replay has passed |
| `buy` fails to pay | check the payer's testnet HBAR on hashscan.io/testnet (account `0.0.11326830`) |
| Anything else | `./demo.sh status` shows the last lines of every log |
