#!/usr/bin/env python3
"""Payload decision loop: the Pi decides with 0G at checkpoints, acts on the payload,
and keeps a signed episode log. When 0G cannot be reached it holds a safe state and
says so; it never makes the decision up.

Checkpoints (each one changes something on the payload):
  burst    altitude has dropped 300 m below its peak    start_recovery | hold        vela-2.0-9b
  thermal  SoC at or above --thermal-c, or every 5 min  continue | pause_camera  vela-2.0-9b
  vision   every --vision-s while the camera runs        keep | drop (the frame)  qwen3-vl-plus,
           and a frame is deleted only if laya agrees from the description that it is empty

Vela and Laya are 0G decision models: they answer with calibrated probabilities, so the
payload takes the consequential action only above a threshold (GATE) and otherwise the
safe one, and both probabilities go into the signed log.

Flight state comes from the beacon over the tap line (UART, "TAP <seq> <hex>" at
38400 baud, Heltec GPIO 6 to Pi pin 10). Decisions go back to the beacon as
"PI <text>" lines (Pi pin 8 to Heltec GPIO 7) for its screen. Live sensors: MS5611
outside, BMP280 inside, SoC temperature, C270 camera.

On-board processing: the wind at the balloon is computed here from each pair of
consecutive frames and sent to the beacon ("WIND ..."), which sells it over the radio.
Only the result goes down, and anyone can recompute it from the two signed frames.

usage: pi/agent.py [--run NAME] [--thermal-c 70] [--vision-s 60] [--tap /dev/ttyAMA0]
"""
import argparse, collections, json, math, os, struct, sys, time

from nacl.signing import SigningKey

sys.path.insert(0, os.path.dirname(__file__))
import sensors
from zg import CHAT_FALLBACK, GUARD_MODEL, TEXT_CHECK_MODEL, VISION_MODEL, Zg, ZgUnavailable

# Probability a decision model must give the consequential action before the payload takes it.
GATE = {"burst": 0.8, "thermal": 0.8, "delete_frame": 0.7}

HOME = os.path.expanduser("~/ethglobal")
SYSTEM = ("You are the decision module of a high-altitude balloon payload. "
          "Choose exactly one action from the list you are given. "
          'Reply with JSON only: {"action": "<action>", "reason": "<under 20 words>"}')


def load_env(path):
    if os.path.exists(path):
        for line in open(path):
            k, _, v = line.strip().partition("=")
            if k and not k.startswith("#") and k not in os.environ:
                os.environ[k] = v


def signing_key():
    path = os.path.join(HOME, "pi_ed25519.key")
    if not os.path.exists(path):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o600)
        os.write(fd, bytes(SigningKey.generate())); os.close(fd)
    return SigningKey(open(path, "rb").read())


def decode_frame(b):
    (_, seq, fs, lat7, lon7, alt, p, t, *_rest) = struct.unpack("<BIhiiHHhHhBBB", b)
    return {"seq": seq, "flight_s": fs, "lat": lat7 / 1e7, "lon": lon7 / 1e7, "alt_m": alt,
            "press_hpa": p / 10, "temp_c": t / 100}


def wind_between(a, b):
    """The balloon drifts with the wind: horizontal speed and bearing between two fixes.
    Same method as the ground's hedera/flightdata.mjs (haversine, initial bearing)."""
    r, la1, la2 = 6371000, math.radians(a["lat"]), math.radians(b["lat"])
    dla, dlo = la2 - la1, math.radians(b["lon"] - a["lon"])
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    dist = 2 * r * math.asin(math.sqrt(h))
    y = math.sin(dlo) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dlo)
    return dist / (b["flight_s"] - a["flight_s"]), (math.degrees(math.atan2(y, x)) + 360) % 360


class Agent:
    def __init__(self, a):
        self.a = a
        self.zg = Zg()
        self.key = signing_key()
        self.run = a.run
        os.makedirs(os.path.join(HOME, "episodes"), exist_ok=True)
        os.makedirs(os.path.join(HOME, "frames", "keep"), exist_ok=True)
        self.log_path = os.path.join(HOME, "episodes", f"{self.run}.jsonl")
        self.state, self.peak, self.phase = None, 0, "ascent"
        self.hist = collections.deque(maxlen=8)        # (flight_s, alt_m) of the last frames
        self.camera_paused, self.safe = False, False
        self.retry_at = {}
        self.next_baro, self.last_baro = 0, None
        self.last_wind = None
        self.next_thermal = time.time() + 30
        self.next_vision = time.time() + 20
        self.outside = self._try(sensors.MS5611)
        self.inside = self._try(sensors.BMP280)
        self.cam = self._try(sensors.Camera)
        self.tap = None
        try:
            import serial
            self.tap = serial.Serial(a.tap, 38400, timeout=0)
        except Exception as e:
            print(f"tap line {a.tap}: not available ({e})")
        self.buf = b""
        print(f"run {self.run}; pi key {self.key.verify_key.encode().hex()}")
        print(f"0G: {'key present, ' + self.zg.base if self.zg.client else 'NO KEY: every checkpoint will safe-stop'}")
        print(f"sensors: outside {'ok' if self.outside else 'none'}, inside {'ok' if self.inside else 'none'}, "
              f"camera {'/dev/video%d' % self.cam.idx if self.cam else 'none'}, tap {'ok' if self.tap else 'none'}")

    @staticmethod
    def _try(make):
        try:
            return make()
        except Exception as e:
            print(f"{make.__name__}: {e}")
            return None

    def live(self):
        out = {"soc_c": round(sensors.soc_c(), 1)}
        for name, s in (("outside", self.outside), ("inside", self.inside)):
            if s:
                try: out[name] = s.read()
                except OSError: out[name] = None
        return out

    def to_beacon(self, text):
        if self.tap:
            try: self.tap.write(f"PI {text[:21]}\n".encode())
            except Exception: pass

    BARO_S = 5          # send the outside barometer to the beacon this often

    def send_baro(self):
        """Live MS5611 reading to the beacon over the tap wire, as "BARO <Pa> <C>".
        The beacon puts it in the live fields of every frame it sends."""
        if not (self.tap and self.outside) or time.time() < self.next_baro:
            return
        self.next_baro = time.time() + self.BARO_S
        try:
            r = self.outside.read()
            self.tap.write(f"BARO {r['pa']:.1f} {r['c']:.2f}\n".encode())
            self.last_baro = r
        except Exception as e:
            print(f"baro to beacon: {e}")

    def send_wind(self, a, b):
        """Wind from two consecutive frames to the beacon, as
        "WIND <seq_a> <seq_b> <speed cm/s> <toward deg x10> <alt m>"."""
        if not self.tap or b["seq"] != a["seq"] + 1 or b["flight_s"] <= a["flight_s"]:
            return
        speed, toward = wind_between(a, b)
        alt = round((a["alt_m"] + b["alt_m"]) / 2)
        try:
            self.tap.write(f"WIND {a['seq']} {b['seq']} {round(speed * 100)} {round(toward * 10) % 3600} {alt}\n".encode())
            self.last_wind = {"speed_ms": speed, "toward": toward, "alt_m": alt}
        except Exception as e:
            print(f"wind to beacon: {e}")

    def record(self, checkpoint, inputs, decision, meta, action_taken, error=None):
        rec = {"ts": round(time.time(), 3), "run": self.run, "checkpoint": checkpoint, "inputs": inputs,
               "model": (meta or {}).get("model"), "request_id": (meta or {}).get("request_id"),
               "response_id": (meta or {}).get("response_id"), "latency_ms": (meta or {}).get("latency_ms"),
               "decision": decision, "action_taken": action_taken, "safe_stop": error is not None, "error": error}
        body = json.dumps(rec, sort_keys=True, separators=(",", ":"))
        rec["pi_sig"] = self.key.sign(body.encode()).signature.hex()
        # fsync each record: a power cut on 6 Nov 2026 left 1,200 zero bytes where the last
        # unsynced records were, so a decision is only "logged" once it is on the card.
        with open(self.log_path, "a") as f:
            f.write(json.dumps(rec) + "\n"); f.flush(); os.fsync(f.fileno())
        tag = "SAFE STOP" if error else f"0G {rec['request_id'] or rec['response_id']}"
        print(f"[{checkpoint}] {decision['action'] if decision else '-'} -> {action_taken}  ({tag})"
              + (f"  {error}" if error else f"  {decision.get('reason', '')}"))

    RETRY_S = 30        # after a safe stop or a "hold", ask again no sooner than this

    def due(self, checkpoint):
        return time.time() >= self.retry_at.get(checkpoint, 0)

    def ask(self, checkpoint, call):
        self.retry_at[checkpoint] = time.time() + self.RETRY_S
        try:
            decision, meta = call()
            self.safe = False
            return decision, meta, None
        except ZgUnavailable as e:
            self.safe = True
            return None, None, str(e)

    def gated(self, state, instructions, crit, act, gate, chat_user):
        """Vela with its probability gate; if 0G's decision models are down, a 0G chat model
        (labelled: no calibrated probability, TEE-attested or not). Raises ZgUnavailable if
        every 0G model fails, so the checkpoint holds its safe state."""
        try:
            return self.zg.choose(GUARD_MODEL, state, instructions, crit, act, gate)
        except ZgUnavailable as first:
            for model, tee in CHAT_FALLBACK:
                try:
                    d, meta = self.zg.decide(model, SYSTEM, chat_user, list(crit))
                except ZgUnavailable:
                    continue
                d["fallback"] = {"from": GUARD_MODEL, "why": str(first)[:120], "calibrated": False, "tee_attested": tee}
                d["reason"] = f"{model} (fallback, {'TEE-attested' if tee else 'not TEE-attested'}, no probability): {d.get('reason', '')}"[:200]
                return d, meta
            raise first

    # ------------------------------------------------------------ checkpoints
    def check_burst(self):
        s = self.state
        if not s or self.phase != "ascent" or self.peak < 1000 or s["alt_m"] > self.peak - 300 or not self.due("burst"):
            return
        h = list(self.hist)
        vs = (h[-1][1] - h[-2][1]) / (h[-1][0] - h[-2][0]) if len(h) >= 2 and h[-1][0] > h[-2][0] else None
        inputs = {"flight": s, "peak_m": self.peak, "altitudes_m": [a for _, a in h], "vertical_ms": vs and round(vs, 2), "live": self.live()}
        state = (f"High-altitude balloon telemetry. Altitude readings, oldest first: {', '.join(f'{a} m' for _, a in h)}. "
                 f"Peak so far {self.peak} m; the latest reading is {self.peak - s['alt_m']} m below the peak"
                 + (f", vertical speed {vs:+.1f} m/s." if vs is not None else "."))
        crit = {"start_recovery": "altitude is falling after the peak: the balloon burst, start descent and recovery",
                "hold": "altitude is still rising or the drop is not clear: keep ascent mode"}
        chat_user = (f"{state} Actions: start_recovery (the balloon has burst: switch to descent mode and send the recovery team), "
                     "hold (still rising, or not certain: keep ascent mode).")
        d, meta, err = self.ask("burst", lambda: self.gated(state, "Has the balloon burst? Choose what the payload should do.",
                                                            crit, "start_recovery", GATE["burst"], chat_user))
        if err:
            self.record("burst", inputs, None, None, "held ascent mode, alert raised", err)
            self.to_beacon("SAFE STOP: no 0G"); return
        if d["action"] == "start_recovery":
            self.phase = "descent"
            self.to_beacon("0G: recovery")
        self.record("burst", inputs, d, meta, f"phase={self.phase}")

    def check_thermal(self):
        now, soc = time.time(), sensors.soc_c()
        if soc < self.a.thermal_c and now < self.next_thermal:
            return
        self.next_thermal = now + 300
        inputs = {"soc_c": round(soc, 1), "limit_c": self.a.thermal_c, "camera_paused": self.camera_paused,
                  "live": self.live()}
        state = (f"Payload computer temperature: {soc:.1f} C. Limit: {self.a.thermal_c} C. "
                 f"Camera is {'paused' if self.camera_paused else 'running'}.")
        crit = {"continue": "the computer is below its temperature limit: keep the camera running",
                "pause_camera": "the computer is at or above its temperature limit: pause the camera to cool down"}
        # The camera runs only if Vela is sure it is safe; otherwise it pauses (and resumes later).
        chat_user = f"{state} Actions: continue (keep the camera running), pause_camera (pause it to cool down)."
        d, meta, err = self.ask("thermal", lambda: self.gated(state, "Should the payload camera keep running?",
                                                              crit, "continue", GATE["thermal"], chat_user))
        if err:
            # Safe state: change nothing (the camera keeps its current setting).
            self.record("thermal", inputs, None, None, "no change, alert raised", err)
            self.to_beacon("SAFE STOP: no 0G"); return
        self.camera_paused = d["action"] == "pause_camera"
        self.record("thermal", inputs, d, meta, f"camera {'paused' if self.camera_paused else 'running'}")

    def check_vision(self):
        if not self.cam or self.camera_paused or time.time() < self.next_vision:
            return
        self.next_vision = time.time() + self.a.vision_s
        try:
            jpg = self.cam.jpeg()
        except OSError as e:
            print(f"camera: {e}"); return
        name = time.strftime("%Y%m%dT%H%M%S") + ".jpg"
        path = os.path.join(HOME, "frames", name)
        open(path, "wb").write(jpg)
        inputs = {"frame": name, "bytes": len(jpg), "flight": self.state}
        user = ("This is one frame from the payload camera. Only frames worth sending to the ground over a "
                "very small radio link should be kept: Earth, horizon, sky, clouds, the balloon or anything "
                "unusual. Blank, black, blurred or near-duplicate frames should be dropped. Actions: keep, drop.")
        d, meta, err = self.ask("vision", lambda: self.zg.decide(VISION_MODEL, SYSTEM, user, ["keep", "drop"], jpg))
        if err:
            # Safe state: never delete a frame without a decision; it stays in frames/.
            self.record("vision", inputs, None, None, "frame kept on disk, not queued", err); return
        if d["action"] == "keep":
            os.replace(path, os.path.join(HOME, "frames", "keep", name))
            taken = "queued for downlink"
        else:
            # Deleting cannot be undone: Laya must agree from the vision model's own words.
            try:
                ans, lmeta = self.zg.ask_decisions(TEXT_CHECK_MODEL, "Description of a camera image: " + d.get("reason", ""),
                                                   {"empty": {"type": "noul", "instructions": "Does the description say the image shows nothing useful?"}})
                p_empty = float(ans["empty"]["noul"])
            except (ZgUnavailable, KeyError, TypeError, ValueError) as e:
                p_empty, lmeta = None, {"error": str(e)[:160]}
            d["check"] = {"model": TEXT_CHECK_MODEL, "p_empty": p_empty and round(p_empty, 4), "threshold": GATE["delete_frame"],
                          "request_id": lmeta.get("request_id"), "tee_verified": lmeta.get("tee_verified")}
            if lmeta.get("request_id"):
                meta["request_id"] = f"{meta.get('request_id')}; {TEXT_CHECK_MODEL} {lmeta['request_id']}"
            if p_empty is not None and p_empty >= GATE["delete_frame"]:
                os.remove(path)
                taken = f"deleted (laya P(empty) = {p_empty:.2f})"
            else:
                taken = "kept on disk: laya did not confirm it is empty" + (f" (P = {p_empty:.2f})" if p_empty is not None else "")
        self.record("vision", inputs, d, meta, taken)

    # ------------------------------------------------------------------ loop
    def read_tap(self):
        if not self.tap:
            return
        try:
            self.buf += self.tap.read(512)
        except Exception:
            return
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            parts = line.decode(errors="replace").strip().split()
            if len(parts) == 3 and parts[0] == "TAP" and len(parts[2]) == 56:
                prev, self.state = self.state, decode_frame(bytes.fromhex(parts[2]))
                if prev:
                    self.send_wind(prev, self.state)
                self.peak = max(self.peak, self.state["alt_m"])
                if self.state["flight_s"] < 0:                 # the replay started over
                    self.phase, self.peak = "ascent", self.state["alt_m"]
                    self.hist.clear()
                self.hist.append((self.state["flight_s"], self.state["alt_m"]))

    def loop(self):
        last_status = 0
        while True:
            self.read_tap()
            self.send_baro()
            self.check_burst()
            self.check_thermal()
            self.check_vision()
            if time.time() - last_status > 30:
                last_status = time.time()
                s = self.state
                print(f"status: phase {self.phase}, "
                      + (f"seq {s['seq']} T+{s['flight_s'] / 60:.1f} min {s['alt_m']} m, " if s else "no tap data, ")
                      + f"camera {'paused' if self.camera_paused else 'on' if self.cam else 'none'}, "
                      + (f"baro to beacon {self.last_baro['pa'] / 100:.2f} hPa, " if self.last_baro else "")
                      + (f"wind {self.last_wind['speed_ms']:.1f} m/s toward {self.last_wind['toward']:.0f} deg at {self.last_wind['alt_m']} m, "
                         if self.last_wind else "")
                      + f"SoC {sensors.soc_c():.1f} C, {'SAFE' if self.safe else 'normal'}", flush=True)
            time.sleep(0.2)


if __name__ == "__main__":
    load_env(os.path.join(HOME, ".env"))
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="pi-" + time.strftime("%Y%m%dT%H%M%S"))
    ap.add_argument("--thermal-c", type=float, default=70.0)
    ap.add_argument("--vision-s", type=float, default=60.0)
    ap.add_argument("--tap", default="/dev/ttyAMA0")
    Agent(ap.parse_args()).loop()
