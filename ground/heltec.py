#!/usr/bin/env python3
"""One command to the ground Heltec over USB, for setup while the verifier is stopped
(the verifier holds the port while it runs).

  ground/heltec.py pubkey             the buyer node's Ed25519 public key
  ground/heltec.py hsign <hex>        its signature over a Hedera transaction body
"""
import glob, json, sys, time
import serial

WANT = {"pubkey": "pubkey", "hsign": "hsign"}


def port():
    p = sorted(glob.glob("/dev/cu.usbserial-*") + glob.glob("/dev/ttyUSB*"))
    if not p:
        raise SystemExit("no ground Heltec on USB")
    return p[0]


def ask(cmd, timeout=15):
    want = WANT[cmd.split()[0]]
    with serial.Serial(port(), 115200, timeout=1) as s:
        time.sleep(0.3)
        s.reset_input_buffer()
        s.write((cmd + "\n").encode())
        end = time.time() + timeout
        while time.time() < end:
            try:
                m = json.loads(s.readline().decode(errors="replace"))
            except ValueError:
                continue
            if m.get("ev") == want:
                return m
    raise SystemExit(f"no answer to {cmd.split()[0]} from the ground Heltec (is the verifier still running?)")


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in WANT:
        raise SystemExit(__doc__)
    m = ask(" ".join(sys.argv[1:]))
    if m.get("refused"):
        raise SystemExit("refused by the board")
    print(m.get("key") or m.get("sig"))
