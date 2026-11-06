#!/bin/bash
# Talk to the payload Pi on the hotspot.
#   tools/pi.sh <command...>     run a command on the Pi
#   tools/pi.sh sync             copy pi/ to ~/ethglobal/pi on the Pi
PI_HOST=${PI_HOST:-172.20.10.4}
SSH=(ssh -i "$HOME/.ssh/hab1_pi" -o UserKnownHostsFile="$HOME/.ssh/known_hosts_hab1" -o ConnectTimeout=8)
if [ "${1:-}" = sync ]; then
  exec rsync -a --exclude __pycache__ -e "${SSH[*]}" "$(dirname "$0")/../pi/" "hab@$PI_HOST:ethglobal/pi/"
fi
exec "${SSH[@]}" "hab@$PI_HOST" "$@"
