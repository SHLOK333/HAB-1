#!/usr/bin/env python3
"""Ground verifier: every frame the ground Heltec hears, checked against the
beacon's pinned Ed25519 key.

A data frame is PENDING until the SIG frame for its batch arrives. The SIG frame
lists the first 4 bytes of SHA-256(salt + frame) for each of the 6 data frames,
with the batch's salt and the beacon's boot number, signed by the beacon. A data
frame is VERIFIED only if the signature is valid and its hash is in the list at its
seq. Anything else claiming that seq is REJECTED as fake; if two frames for one seq
both match, both are rejected (CONFLICT). A batch no newer than one already accepted
(by boot, then first seq) is a REPLAY and nothing in it is accepted; the newest
accepted batch is kept in ground/state, so restarting the verifier does not forget it.

Radio sales: the ground Heltec is also a buyer node. Its vouchers (BUY frames) and the
beacon's signed answers (DELIVERY frames) are checked and logged here too, for
hedera/radio_settle.mjs to settle. Commands written to ground/state/ground_cmds, one
per line, are passed to the ground Heltec (that is how ./demo.sh radio-buy asks it).

usage:
  ground/verifier.py                 # find hab-ground on the hotspot
  ground/verifier.py --serial /dev/cu.usbserial-0001
  ground/verifier.py --no-verify     # what the ground sees without signatures
"""
import argparse, hashlib, json, os, struct, sys, time
from nacl.signing import VerifyKey
from nacl.exceptions import BadSignatureError

sys.path.insert(0, os.path.dirname(__file__))
import nodes

HERE = os.path.dirname(os.path.abspath(__file__))
MAGIC_DATA, MAGIC_SIG, BATCH, HASH_LEN, SIGNED_LEN, SIG_LEN, SIG_HASHES = 0xB2, 0xB3, 6, 4, 36, 100, 12
MAGIC_DELIVERY, DELIVERY_LEN, DELIVERY_SIGNED, DELIVERY_TAG = 0xB4, 88, 24, b"hab-delivery-v1"
MAGIC_OFFER, OFFER_LEN = 0xB5, 20
BOARD_EVENTS = ("voucher", "buy", "x402req", "x402pay", "x402refused", "x402policy", "sent", "clock")


def decode_delivery(b):
    (nonce, status, seq_a, seq_b, cms, d10, alt) = struct.unpack("<IBIIHHH", b[1:20])
    return {"nonce": nonce, "status": status, "seq_a": seq_a, "seq_b": seq_b, "speed_ms": cms / 100,
            "toward_deg": d10 / 10, "alt_m": alt, "voucher_hash": b[20:24].hex()}


def decode_data(b):
    (magic, seq, flight_s, lat7, lon7, alt, press, temp, live_p, live_t, flags, k0, k1) = \
        struct.unpack("<BIhiiHHhHhBBB", b)
    return {"seq": seq, "flight_s": flight_s, "lat": lat7 / 1e7, "lon": lon7 / 1e7, "alt_m": alt,
            "press_hpa": press / 10, "temp_c": temp / 100,
            "live_hpa": live_p / 10 if flags & 2 else None, "live_c": live_t / 100 if flags & 2 else None,
            "live_src": ("pi" if flags & 4 else "beacon") if flags & 2 else None,
            "replay": bool(flags & 1), "key_id": bytes([k0, k1]).hex()}


class Verifier:
    def __init__(self, pubkey_hex, verify, out, send):
        self.vk = VerifyKey(bytes.fromhex(pubkey_hex))
        self.pubkey_hex = pubkey_hex
        self.key_id = pubkey_hex[:4]
        self.verify = verify
        self.out = out
        self.send = send                       # send(command) to the ground modem
        self.pending = {}                      # seq -> list of (frame bytes, decoded, rssi, snr)
        self.track = []                        # positions the ground accepted, in order
        # the newest batch accepted from this beacon, (boot, first seq): anything not newer is a replay
        self.high_path = os.path.join(HERE, "state", f"highwater-{pubkey_hex[:16]}.json")
        self.high = tuple(json.load(open(self.high_path))) if os.path.exists(self.high_path) else (0, -1)

    def log(self, _ev, **kw):              # _ev: event fields may themselves be called "kind"
        kw.update(ev=_ev, t=round(time.time(), 3))
        self.out.write(json.dumps(kw) + "\n"); self.out.flush()

    def accept(self, d, how):
        self.track.append({k: d[k] for k in ("seq", "flight_s", "lat", "lon", "alt_m")} | {"how": how})
        with open(os.path.join(HERE, "state", "track.json"), "w") as f:
            json.dump(self.track, f)

    def on_data(self, b, rssi, snr):
        d = decode_data(b)
        cands = self.pending.setdefault(d["seq"], [])
        cands.append((b, d, rssi, snr))
        mins = d["flight_s"] / 60
        line = (f"seq {d['seq']:4d}  T{mins:+6.1f} min  {d['alt_m']:5d} m  {d['lat']:.5f} {d['lon']:.5f}"
                f"  rssi {rssi:.0f} snr {snr:.1f}"
                + (f"  live {d['live_hpa']:.1f} hPa {d['live_c']:.2f} C ({d['live_src']})" if d["live_hpa"] else ""))
        if d["key_id"] != self.key_id:
            print(f"{line}  key id {d['key_id']} is not the pinned key {self.key_id}")
        if not self.verify:
            print(f"{line}  ACCEPTED (no verification)")
            self.accept(d, "unverified")
            self.send(f"show seq {d['seq']} accepted")
            self.log("verdict", seq=d["seq"], verdict="ACCEPTED unverified", hex=b.hex(), rssi=rssi, snr=snr,
                     flight_s=d["flight_s"], lat=d["lat"], lon=d["lon"], alt_m=d["alt_m"], beacon_key=self.pubkey_hex,
                     live_hpa=d["live_hpa"], live_c=d["live_c"], live_src=d["live_src"])
        else:
            print(f"{line}  PENDING" + (f" ({len(cands)} frames claim this seq)" if len(cands) > 1 else ""))
        self.log("data", hex=b.hex(), rssi=rssi, snr=snr, **d)

    def on_sig(self, b, rssi, snr):
        first, count, boot = struct.unpack("<IBH", b[1:8])
        salt = b[8:12]
        hashes = [b[SIG_HASHES + i * HASH_LEN: SIG_HASHES + (i + 1) * HASH_LEN] for i in range(count)]
        try:
            self.vk.verify(b[:SIGNED_LEN], b[SIGNED_LEN:])
            sig_ok = True
        except BadSignatureError:
            sig_ok = False
        replay = sig_ok and (boot, first) <= self.high
        print(f"sig  boot {boot} seq {first}..{first + count - 1}  signature {'VALID' if sig_ok else 'INVALID'}"
              + (f"  REPLAY: not newer than boot {self.high[0]} seq {self.high[1]}" if replay else "") + f"  rssi {rssi:.0f} snr {snr:.1f}")
        if sig_ok and not replay:
            self.high = (boot, first)
            json.dump(list(self.high), open(self.high_path, "w"))
        results = []
        for i, h in enumerate(hashes):
            seq = first + i
            cands = self.pending.pop(seq, [])
            if not cands:
                results.append((seq, "MISSING")); continue
            # distinct frames that match: the same frame heard twice is not a conflict
            matching = len({fb for fb, *_ in cands if hashlib.sha256(salt + fb).digest()[:HASH_LEN] == h})
            for fb, d, frssi, fsnr in cands:
                match = hashlib.sha256(salt + fb).digest()[:HASH_LEN] == h
                if not sig_ok:          verdict = "REJECTED bad signature"
                elif replay:            verdict = "REPLAY REJECTED"
                elif match and matching > 1: verdict = "CONFLICT REJECTED"
                elif match:             verdict = "VERIFIED"
                else:                   verdict = "FAKE REJECTED"
                genuine = verdict == "VERIFIED"
                results.append((seq, verdict))
                if genuine and self.verify:
                    self.accept(d, "verified")
                self.log("verdict", seq=seq, verdict=verdict, hex=fb.hex(), rssi=frssi, snr=fsnr,
                         flight_s=d["flight_s"], lat=d["lat"], lon=d["lon"], alt_m=d["alt_m"], beacon_key=self.pubkey_hex,
                     live_hpa=d["live_hpa"], live_c=d["live_c"], live_src=d["live_src"])
        for seq, v in results:
            print(f"     seq {seq:4d}  {v}")
        fakes = [s for s, v in results if v in ("FAKE REJECTED", "CONFLICT REJECTED")]
        if not sig_ok:
            self.send(f"show seq {first}-{first + count - 1} BAD SIG")
        elif replay:
            self.send(f"show REPLAY seq {first} REJECTED")
        elif fakes:
            self.send(f"show FAKE seq {fakes[0]} REJECTED")
        else:
            ok = sum(1 for _, v in results if v == "VERIFIED")
            self.send(f"show seq {first}-{first + count - 1} {ok}/{count} ok")
        self.log("sig", first=first, count=count, boot=boot, valid=sig_ok, replay=replay, rssi=rssi, snr=snr, hex=b.hex())

    def on_buy(self, m):
        # The ground Heltec's own lines: vouchers and BUYs, and its x402 client's steps.
        if m["ev"] == "x402req":
            print(f"x402 REQ for wind from 0.0.{m['buyer']} queued on the board")
        elif m["ev"] == "x402pay":
            print(f"x402 PAY signed on the board: {m['amount']} tinybar 0.0.{m['payer']} -> 0.0.{m['pay_to']}, "
                  f"fee payer 0.0.{m['fee_payer']}, challenge {m['challenge']} (spent {m['spent']} of {m['budget']})")
        elif m["ev"] == "x402refused":
            print(f"x402: the board REFUSED to pay {m['amount']} tinybar: {m['why']}")
        elif m["ev"] == "sent":
            print(f"{m['kind'].upper():5s} sent in the window after seq {m['seq']}" + ("" if m.get("ok") else " (NOT sent: duty guard)"))
        elif m["ev"] in ("clock", "x402policy"):
            pass
        elif m["ev"] == "voucher":
            print(f"voucher nonce {m['nonce']} signed on the ground Heltec: {m['price']} tinybar from 0.0.{m['buyer']} to 0.0.{m['seller']}")
        elif m.get("ok"):
            print(f"BUY  nonce {m['nonce']} sent in the window after seq {m['seq']}")
        else:
            print(f"BUY  nonce {m['nonce']} not sent (duty guard); it goes with the next frame")
        self.log(m["ev"], **{k: v for k, v in m.items() if k != "ev"})

    def on_delivery(self, b, rssi, snr):
        d = decode_delivery(b)
        try:
            self.vk.verify(DELIVERY_TAG + b[:DELIVERY_SIGNED], b[DELIVERY_SIGNED:])
            ok = True
        except BadSignatureError:
            ok = False
        what = (f"wind {d['speed_ms']:.2f} m/s toward {d['toward_deg']:.1f} deg at {d['alt_m']} m, from frames {d['seq_a']},{d['seq_b']}"
                + (", paid over x402" if d["status"] == 2 else "")
                if d["status"] in (0, 2) else "no fresh wind on board (not to be settled)")
        print(f"DELIVERY {'challenge %08x' % d['nonce'] if d['status'] == 2 else 'nonce %d' % d['nonce']}: {what}  signature {'VALID' if ok else 'INVALID'}  rssi {rssi:.0f} snr {snr:.1f}")
        self.send(f"show WIND {d['speed_ms']:.1f}m/s {'ok' if ok else 'BAD SIG'}")
        self.log("delivery", hex=b.hex(), valid=ok, rssi=rssi, snr=snr, **d)

    def on_line(self, line):
        try:
            m = json.loads(line)
        except ValueError:
            return
        if m.get("ev") in BOARD_EVENTS:
            return self.on_buy(m)
        if m.get("ev") != "rx" or m.get("st") != 0 or not m.get("hex"):
            return
        b = bytes.fromhex(m["hex"])
        if b[0] == MAGIC_DATA and len(b) == 28:
            self.on_data(b, m["rssi"], m["snr"])
        elif b[0] == MAGIC_SIG and len(b) == SIG_LEN:
            self.on_sig(b, m["rssi"], m["snr"])
        elif b[0] == MAGIC_SIG and len(b) == 94 and not getattr(self, "said_old", False):
            # The format before 4 Nov 2026 (unsalted hashes, no boot number) is not trusted any more.
            self.said_old = True
            print("sig  94-byte signature frame: the beacon runs firmware from before 4 Nov 2026. "
                  "Nothing can verify until it is updated (CHANGING.md, section 5).", flush=True)
        elif b[0] == MAGIC_DELIVERY and len(b) == DELIVERY_LEN:
            self.on_delivery(b, m["rssi"], m["snr"])
        elif b[0] == MAGIC_OFFER and len(b) == OFFER_LEN:
            (ch, product, amount, pay_to, fee_payer, timeout) = struct.unpack("<IBIIIH", b[1:20])
            print(f"402  Payment Required from the beacon: {amount} tinybar to 0.0.{pay_to}, fee payer 0.0.{fee_payer}, "
                  f"challenge {ch:08x}, {timeout} s  rssi {m['rssi']:.0f}")
            self.log("offer", hex=b.hex(), challenge=f"{ch:08x}", amount=amount, pay_to=pay_to, fee_payer=fee_payer, timeout=timeout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ground", default="hab-ground", help="hostname or IP of the ground Heltec")
    ap.add_argument("--serial", help="read the ground Heltec over USB instead of Wi-Fi")
    ap.add_argument("--pubkey", default=os.path.join(HERE, "beacon_pubkey.hex"))
    ap.add_argument("--no-verify", action="store_true", help="accept every frame, as HAB-1 did")
    a = ap.parse_args()

    os.makedirs(os.path.join(HERE, "state"), exist_ok=True)
    os.makedirs(os.path.join(HERE, "log"), exist_ok=True)
    out = open(os.path.join(HERE, "log", time.strftime("verifier-%Y%m%dT%H%M%S.jsonl")), "w")
    pub = open(a.pubkey).read().strip()

    if a.serial:
        import serial
        port = None

        def serial_lines():
            # A bumped cable must not end the ground station: reopen and carry on.
            nonlocal port
            waiting_said = False
            while True:
                try:
                    if port is None:
                        port = serial.Serial(a.serial, 115200, timeout=1)
                        print(f"ground on {a.serial}", flush=True)
                    yield port.readline().decode(errors="replace")
                except (serial.SerialException, OSError) as e:
                    if port is not None:
                        print(f"ground USB lost ({e}); waiting for it to come back", flush=True)
                    elif not waiting_said:
                        print(f"no ground Heltec on {a.serial} yet ({e}); waiting for it", flush=True)
                    waiting_said = True
                    port = None
                    time.sleep(2)

        def send(c):
            try:
                if port: port.write((c + "\n").encode())
            except (serial.SerialException, OSError):
                pass
        lines = serial_lines()
    else:
        s, ip = nodes.connect(a.ground)
        f = s.makefile("rw", encoding="utf-8", errors="replace", newline="\n")
        lines = f
        send = lambda c: (f.write(c + "\n"), f.flush())
        print(f"ground at {ip}:{nodes.PORT}")
    v = Verifier(pub, not a.no_verify, out, send)
    print(f"pinned beacon key {pub[:16]}..., verification {'ON' if v.verify else 'OFF'}")
    cmd_file = os.path.join(HERE, "state", "ground_cmds")

    def take_commands():
        try:
            os.rename(cmd_file, cmd_file + ".taken")
        except FileNotFoundError:
            return
        for c in open(cmd_file + ".taken"):
            if c.strip():
                print(f"to ground: {c.strip()}", flush=True)
                send(c.strip())
        os.remove(cmd_file + ".taken")

    for line in lines:
        v.on_line(line.strip())
        take_commands()


if __name__ == "__main__":
    main()
