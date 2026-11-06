#!/bin/bash
# Run the whole ground side of the demo from any Mac or Linux laptop, no AI needed.
#
#   ./demo.sh setup              install Python and Node dependencies (once per laptop)
#   ./demo.sh check              is everything in place? (files, boards, Pi, network)
#   ./demo.sh start [name]       start verifier, Arkiv publisher, x402 endpoint and map
#   ./demo.sh status             what is running, and the last lines of each log
#   ./demo.sh stop               stop everything this script started
#
# Demo moments, once started:
#   ./demo.sh attack             the beacon sends one fake frame (same as pressing PRG)
#   ./demo.sh buy [alt_m ...]    an agent buys wind data over x402 and checks the proof
#   ./demo.sh noverify           30 s with checking off: what HAB-1 would have accepted
#   ./demo.sh upload             put the Pi's episode log on 0G Storage and 0G Chain
#   ./demo.sh pi-log             follow the Pi agent's decisions
#   ./demo.sh pi-key             copy the 0G Private Computer key from .env to the Pi
#   ./demo.sh logs <verifier|publisher|x402|map>   follow one log
#
# Radio sales (a buyer node pays the payload over LoRa, settled on Hedera later):
#   ./demo.sh radio-setup        once: buyer account with the board's key, allowance (verifier stopped)
#   ./demo.sh radio-buy          the ground Heltec signs a voucher and sends it in the next window
#   ./demo.sh radio-settle       check every voucher and delivery heard, settle on Hedera
#   ./demo.sh sales              the beacon's sales and the wind the Pi computed
#   ./demo.sh radio-x402         x402 over LoRa: 402 from the beacon, payment signed on the board,
#                                settled by the facilitator, then the data (radio-x402-setup once)
set -u
cd "$(dirname "$0")"
ROOT=$(pwd)
D="$ROOT/.demo"                      # pid files, logs and the session name live here
mkdir -p "$D"
PI_HOST=${PI_HOST:-172.20.10.4}
MAP_PORT=${MAP_PORT:-8097}
export PI_HOST

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; FAILED=1; }

# The ground Heltec: on USB by default. GROUND_HOST=hab-ground (or its IP) uses it over
# Wi-Fi instead: build its firmware with -DGROUND_WIFI first (README, Running without USB).
GROUND_HOST=${GROUND_HOST:-}
ground_args() {                       # the verifier's arguments to reach the ground Heltec
  if [ -n "$GROUND_HOST" ]; then echo "--ground $GROUND_HOST"; else local p; p=$(ground_port); [ -n "$p" ] && echo "--serial $p"; fi
}

# The first USB serial port (CP210x on the Heltec V3).
ground_port() {
  for p in /dev/cu.usbserial-* /dev/ttyUSB* /dev/ttyACM*; do [ -e "$p" ] && { echo "$p"; return; }; done
}

running() { [ -f "$D/$1.pid" ] && kill -0 "$(cat "$D/$1.pid")" 2>/dev/null; }

launch() {                            # launch <name> <dir> <command...>
  local name=$1 dir=$2; shift 2
  if running "$name"; then say "$name already running (pid $(cat "$D/$name.pid"))"; return; fi
  # exec, so the pid file holds the program itself (stop then really stops it) and no
  # shell is left holding this script's output open.
  (cd "$dir" && exec nohup "$@" >"$D/$name.log" 2>&1 </dev/null) & echo $! >"$D/$name.pid"
  sleep 1
  running "$name" && say "started $name (pid $(cat "$D/$name.pid")), log .demo/$name.log" || { say "$name FAILED to start:"; tail -5 "$D/$name.log"; }
}

halt() {
  if running "$1"; then kill "$(cat "$D/$1.pid")" 2>/dev/null; say "stopped $1"; fi
  rm -f "$D/$1.pid"
}

cmd_setup() {
  say "Python environment (.venv)"
  python3 -m venv .venv && .venv/bin/pip install -q pynacl pyserial || exit 1
  for p in arkiv hedera zg; do say "npm install in $p/"; (cd $p && npm install --silent) || exit 1; done
  say "done. Next: ./demo.sh check"
}

cmd_check() {
  FAILED=0
  say "files"
  for f in .env ground/beacon_pubkey.hex; do [ -s "$f" ] && ok "$f" || bad "$f missing (copy it from the build laptop)"; done
  for k in ARKIV_ACCESS_KEY ARKIV_GROUND_PRIVATE_KEY HEDERA_PAYER_ACCOUNT_ID HEDERA_PRIVATE_KEY HEDERA_MERCHANT_ACCOUNT_ID ZG_PRIVATE_KEY ZG_REGISTRY_ADDRESS; do
    grep -qE "^$k=.+" .env 2>/dev/null && ok "$k set" || bad "$k empty in .env"
  done
  grep -qE "^ZG_PC_API_KEY=.+" .env 2>/dev/null && ok "ZG_PC_API_KEY set (0G decisions on)" || say "  note  ZG_PC_API_KEY empty: the Pi will safe-stop at every checkpoint"
  say "software"
  [ -x .venv/bin/python ] && ok "python venv" || bad "no .venv: run ./demo.sh setup"
  command -v node >/dev/null && ok "node $(node --version)" || bad "node not installed (22.10 or later)"
  for p in arkiv hedera zg; do [ -d $p/node_modules ] && ok "$p/node_modules" || bad "$p/node_modules missing: run ./demo.sh setup"; done
  say "hardware and network"
  if [ -n "$GROUND_HOST" ]; then
    local g; g=$(.venv/bin/python -c "import sys; sys.path.insert(0,'ground'); import nodes; print(nodes.find('$GROUND_HOST') or '')" 2>/dev/null)
    [ -n "$g" ] && ok "ground Heltec on Wi-Fi at $g" || bad "ground Heltec ($GROUND_HOST) not found on the hotspot"
  else
    local port; port=$(ground_port)
    [ -n "$port" ] && ok "ground Heltec on $port" || bad "no ground Heltec on USB (or set GROUND_HOST=hab-ground for Wi-Fi)"
  fi
  local b; b=$(.venv/bin/python -c "import sys; sys.path.insert(0,'ground'); import nodes; print(nodes.find('hab-beacon') or '')" 2>/dev/null)
  [ -n "$b" ] && ok "beacon on Wi-Fi at $b" || bad "beacon not found on the hotspot (attack needs it; PRG still works)"
  [ -f "$HOME/.ssh/hab1_pi" ] && ok "Pi ssh key" || bad "~/.ssh/hab1_pi missing (needed for upload and pi-log)"
  tools/pi.sh true 2>/dev/null && ok "Pi reachable at $PI_HOST" || bad "Pi not reachable at $PI_HOST (set PI_HOST=... if its address changed)"
  curl -s -m 8 -o /dev/null https://rpc.rabdi.db-chain.testnet.arkiv.network && ok "internet (Arkiv RPC)" || bad "no internet"
  [ $FAILED = 0 ] && say "all good: ./demo.sh start" || say "fix the FAIL lines first"
}

cmd_start() {
  local run=${1:-demo-$(date +%Y%m%d-%H%M)} gargs; gargs=$(ground_args)
  [ -n "$gargs" ] || { say "no ground Heltec on USB (or set GROUND_HOST=hab-ground for Wi-Fi)"; exit 1; }
  echo "$run" >"$D/run"
  local before; before=$(ls ground/log 2>/dev/null | sort | tail -1)
  launch verifier "$ROOT" .venv/bin/python -u ground/verifier.py $gargs
  local log=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    log=$(ls ground/log 2>/dev/null | sort | tail -1); [ -n "$log" ] && [ "$log" != "$before" ] && break; sleep 1
  done
  [ -n "$log" ] && [ "$log" != "$before" ] || { say "verifier did not create a log"; tail -5 "$D/verifier.log"; exit 1; }
  launch publisher "$ROOT/arkiv" node --env-file=../.env publish.mjs --log "../ground/log/$log" --from-start --run "$run"
  launch x402 "$ROOT/hedera" node --env-file=../.env server.mjs
  launch map "$ROOT/web" python3 -m http.server "$MAP_PORT" --bind 127.0.0.1
  # The Pi runs its agent as a service; tell it the session name so its episode log matches.
  if tools/pi.sh "echo $run > ~/ethglobal/run && sudo systemctl restart hab-agent" 2>/dev/null; then
    say "Pi agent restarted for session $run"
  else
    say "could not restart hab-agent on the Pi (not reachable, or the service is not installed: see DEMO.md)"
  fi
  say ""
  say "session $run"
  say "map:   http://localhost:$MAP_PORT/?run=$run   (hard reload with Cmd+Shift+R after changes)"
  say "x402:  http://localhost:4402/"
  say "Pi:    its agent runs on the Pi itself (service hab-agent); ./demo.sh pi-log to watch it"
}

cmd_status() {
  say "session $(cat "$D/run" 2>/dev/null || echo '-')"
  for n in verifier publisher x402 map; do
    if running $n; then say "== $n running (pid $(cat "$D/$n.pid"))"; else say "== $n not running"; fi
    [ -f "$D/$n.log" ] && grep -vE "localstorage|trace-warnings" "$D/$n.log" | tail -3 | sed 's/^/   /'
  done
}

cmd_stop() { for n in publisher verifier x402 map; do halt $n; done; }

case "${1:-}" in
  setup)    cmd_setup ;;
  check)    cmd_check ;;
  start)    shift; cmd_start "$@" ;;
  status)   cmd_status ;;
  stop)     cmd_stop ;;
  attack)   .venv/bin/python ground/cmd.py beacon attack ;;
  buy)      shift; mkdir -p "$D/bought"
            (cd hedera && AGENT_SAVE_DIR="$D/bought" node --env-file=../.env agent.mjs "$@" 2>&1 | grep -vE "localstorage|trace-warnings")
            for f in "$D"/bought/*.json; do [ -f "$f" ] && { say "proof $(basename "$f"):"; node hedera/check_proof.mjs "$f" | sed 's/^/   /'; }; done
            rm -f "$D"/bought/*.json ;;
  noverify) gargs=$(ground_args); was=0; running verifier && { was=1; halt verifier; }
            say "30 s with checking OFF; send ./demo.sh attack (or press PRG) now"
            .venv/bin/python -u ground/verifier.py $gargs --no-verify & p=$!; sleep 30; kill $p 2>/dev/null
            [ $was = 1 ] && say "verifier was stopped for this; run ./demo.sh stop && ./demo.sh start to resume" ;;
  upload)   run=$(cat "$D/run" 2>/dev/null); [ -n "$run" ] || { say "no session: ./demo.sh start first"; exit 1; }
            (cd zg && node --env-file=../.env upload.mjs "$run" 2>&1 | grep -E "^episode|^0G Storage|^EpisodeRegistry|chainscan") ;;
  pi-log)   tools/pi.sh 'journalctl -u hab-agent -f -o cat' ;;
  pi-key)   # copy the 0G Private Computer key from .env to the Pi's ~/ethglobal/.env, never printed
            grep -E "^ZG_PC_(API_KEY|BASE_URL)=" .env | tools/pi.sh 'umask 077; cat > ~/ethglobal/.env && sudo systemctl restart hab-agent 2>/dev/null; grep -c "^ZG_PC_API_KEY=." ~/ethglobal/.env | sed "s/^1$/0G key on the Pi: set/; s/^0$/0G key on the Pi: EMPTY/"' ;;
  radio-setup) running verifier && { say "stop the verifier first (./demo.sh stop): setup talks to the ground Heltec over USB"; exit 1; }
            (cd hedera && node --env-file=../.env radio_setup.mjs "${2:-1}" 2>&1 | grep -vE "localstorage|trace-warnings") ;;
  radio-buy) running verifier || { say "the verifier passes the command to the ground Heltec: ./demo.sh start first"; exit 1; }
            buyer=$(sed -n 's/^HEDERA_SATB_ACCOUNT_ID=0\.0\.//p' .env); seller=$(sed -n 's/^HEDERA_MERCHANT_ACCOUNT_ID=0\.0\.//p' .env)
            [ -n "$buyer" ] || { say "no buyer account: ./demo.sh radio-setup"; exit 1; }
            echo "buy ${2:-1000000} $buyer $seller" >> ground/state/ground_cmds
            say "voucher for ${2:-1000000} tinybar from 0.0.$buyer to 0.0.$seller asked for; watch: ./demo.sh logs verifier" ;;
  radio-settle) (cd hedera && node --env-file=../.env radio_settle.mjs "${@:2}" 2>&1 | grep -vE "localstorage|trace-warnings") ;;
  sales)    .venv/bin/python ground/cmd.py beacon sales ;;
  radio-x402-setup) (cd hedera && node --env-file=../.env radio_x402.mjs --setup 2>&1 | grep -vE "localstorage|trace-warnings") ;;
  radio-x402) running verifier || { say "the verifier passes the commands to the ground Heltec: ./demo.sh start first"; exit 1; }
            (cd hedera && node --env-file=../.env radio_x402.mjs 2>&1 | grep -vE "localstorage|trace-warnings") ;;
  logs)     tail -f "$D/${2:?which log: verifier publisher x402 map}.log" ;;
  *)        sed -n '2,/^set -u/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//' ;;
esac
