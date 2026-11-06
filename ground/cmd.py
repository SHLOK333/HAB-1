#!/usr/bin/env python3
"""Send one command to a node over Wi-Fi and print its reply.

  ground/cmd.py beacon attack
  ground/cmd.py beacon pubkey --pin     # save the key the verifier will trust
  ground/cmd.py ground status
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
import nodes

# The reply line each command produces, by node: the beacon answers "beacon seq ...",
# the ground a JSON line with "ev":"status".
WAIT = {("beacon", "pubkey"): "pubkey ", ("beacon", "status"): "beacon seq", ("ground", "status"): '"status"',
        ("beacon", "buyer"): "buyer set", ("beacon", "payto"): "pay to", ("beacon", "price"): "price ",
        ("beacon", "sales"): "sales "}

if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    who, cmd, pin = sys.argv[1], [w for w in sys.argv[2:] if w != "--pin"], "--pin" in sys.argv
    cmd = " ".join(cmd)
    reply = nodes.command("hab-" + who, cmd, WAIT.get((who, cmd.split()[0]), ""))
    print(reply or "(sent)")
    if pin and reply and reply.startswith("pubkey "):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "beacon_pubkey.hex")
        open(path, "w").write(reply.split()[1] + "\n")
        print(f"pinned in {path}")
