#!/bin/bash
# One-shot install of everything the HAB-1 project needs on a Mac. Run from this folder:
#   bash install_mac.sh
set -e
cd "$(dirname "$0")"

if ! command -v brew >/dev/null; then
  echo "Homebrew is missing. Install it from https://brew.sh first, then re-run this script."; exit 1
fi

echo "== system tools =="
brew install python@3.12 node arduino-cli git || true

echo "== python venv + npm packages (arkiv, hedera, zg) =="
PYTHON=$(command -v python3.12 || command -v python3) bash -c '$PYTHON -m venv .venv && .venv/bin/pip install -q pynacl pyserial'
for p in arkiv hedera zg; do (cd $p && npm install --silent); done

echo "== ESP32 board support + Arduino libraries (exact versions) =="
arduino-cli config init 2>/dev/null || true
arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32@3.3.11
arduino-cli lib install "RadioLib@7.7.1" "Crypto@0.4.0" "Adafruit SSD1306@2.5.17" "Adafruit GFX Library@1.12.6" \
  "Adafruit BMP280 Library@3.0.0" "Adafruit Unified Sensor@1.1.15" "Adafruit BusIO@1.17.4"

echo "== config files =="
[ -f .env ] || { cp .env.example .env; chmod 600 .env; echo "created .env: fill in your testnet keys"; }
[ -f firmware/hab_node/wifi_secrets.h ] || cat > firmware/hab_node/wifi_secrets.h <<'H'
#define STA_SSID "your-hotspot-name"
#define STA_PASS "your-hotspot-password"
#define AP_PASS  "choose-an-update-password"
H

echo; echo "Done. Next: edit .env and firmware/hab_node/wifi_secrets.h, then run ./demo.sh check"
