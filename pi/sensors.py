"""Live sensors on the payload Pi: outside barometer, inside barometer, SoC
temperature, and the C270 camera.

MS5611 (GY-63) on /dev/i2c-1 at 0x77, outside air.
BMP280 (GY-BMP280) on /dev/i2c-3 at 0x76, inside the box.
Formulas are from the MS5611-01BA03 and BMP280 datasheets.
"""
import glob, os, time

from smbus2 import SMBus


class MS5611:
    def __init__(self, bus=1, addr=0x77):
        self.bus, self.addr = SMBus(bus), addr
        self.bus.write_byte(addr, 0x1E)                       # reset
        time.sleep(0.005)
        self.prom = [int.from_bytes(bytes(self.bus.read_i2c_block_data(addr, 0xA0 + 2 * i, 2)), "big")
                     for i in range(8)]
        self.crc_ok = self._crc4() == (self.prom[7] & 0xF)

    def _crc4(self):                                          # application note AN520
        n = list(self.prom); n[7] &= 0xFF00
        rem = 0
        for cnt in range(16):
            rem ^= (n[cnt >> 1] & 0xFF) if cnt % 2 else (n[cnt >> 1] >> 8)
            for _ in range(8):
                rem = ((rem << 1) ^ 0x3000) if rem & 0x8000 else (rem << 1)
        return (rem >> 12) & 0xF

    def _adc(self, cmd):
        self.bus.write_byte(self.addr, cmd)
        time.sleep(0.010)                                     # OSR 4096 converts in 9.04 ms max
        return int.from_bytes(bytes(self.bus.read_i2c_block_data(self.addr, 0x00, 3)), "big")

    def read(self):
        c = self.prom
        d1, d2 = self._adc(0x48), self._adc(0x58)
        dt = d2 - c[5] * 256
        temp = 2000 + dt * c[6] / 2**23
        off = c[2] * 2**16 + c[4] * dt / 2**7
        sens = c[1] * 2**15 + c[3] * dt / 2**8
        if temp < 2000:                                       # second-order compensation
            t2 = dt * dt / 2**31
            off2 = 5 * (temp - 2000) ** 2 / 2
            sens2 = 5 * (temp - 2000) ** 2 / 4
            if temp < -1500:
                off2 += 7 * (temp + 1500) ** 2
                sens2 += 11 * (temp + 1500) ** 2 / 2
            temp, off, sens = temp - t2, off - off2, sens - sens2
        pa = (d1 * sens / 2**21 - off) / 2**15
        return {"pa": round(pa, 1), "c": round(temp / 100, 2)}


class BMP280:
    def __init__(self, bus=3, addr=0x76):
        self.bus, self.addr = SMBus(bus), addr
        if self.bus.read_byte_data(addr, 0xD0) != 0x58:
            raise OSError("BMP280 chip id mismatch")
        cal = bytes(self.bus.read_i2c_block_data(addr, 0x88, 24))
        u = lambda i: int.from_bytes(cal[i:i + 2], "little")
        s = lambda i: int.from_bytes(cal[i:i + 2], "little", signed=True)
        self.t = (u(0), s(2), s(4))
        self.p = (u(6),) + tuple(s(i) for i in range(8, 24, 2))
        self.bus.write_byte_data(addr, 0xF5, 0x28)            # standby 62.5 ms, filter x4
        self.bus.write_byte_data(addr, 0xF4, 0x57)            # temp x2, pressure x16, normal mode
        time.sleep(0.1)

    def read(self):
        d = self.bus.read_i2c_block_data(self.addr, 0xF7, 6)
        adc_p = (d[0] << 12) | (d[1] << 4) | (d[2] >> 4)
        adc_t = (d[3] << 12) | (d[4] << 4) | (d[5] >> 4)
        t1, t2, t3 = self.t
        v1 = (adc_t / 16384 - t1 / 1024) * t2
        v2 = ((adc_t / 131072 - t1 / 8192) ** 2) * t3
        tf = v1 + v2
        p1, p2, p3, p4, p5, p6, p7, p8, p9 = self.p
        v1 = tf / 2 - 64000
        v2 = v1 * v1 * p6 / 32768 + v1 * p5 * 2
        v2 = v2 / 4 + p4 * 65536
        v1 = (p3 * v1 * v1 / 524288 + p2 * v1) / 524288
        v1 = (1 + v1 / 32768) * p1
        if v1 == 0:
            return {"pa": None, "c": round(tf / 5120, 2)}
        p = (1048576 - adc_p - v2 / 4096) * 6250 / v1
        p += (p9 * p * p / 2147483648 + p * p8 / 32768 + p7) / 16
        return {"pa": round(p, 1), "c": round(tf / 5120, 2)}


def soc_c():
    with open("/sys/class/thermal/thermal_zone0/temp") as f:
        return int(f.read()) / 1000


def find_camera(name="C270"):
    """Index of the first /dev/video* whose V4L2 name contains `name`, or None."""
    for dev in sorted(glob.glob("/sys/class/video4linux/video*")):
        try:
            if name.lower() in open(os.path.join(dev, "name")).read().lower():
                idx = int(dev.rsplit("video", 1)[1])
                # a USB camera exposes two nodes; the capture one has index 0 in "index"
                if open(os.path.join(dev, "index")).read().strip() == "0":
                    return idx
        except (OSError, ValueError):
            pass
    return None


class Camera:
    def __init__(self, name="C270", width=640, height=480):
        import cv2
        self.cv2, self.idx = cv2, find_camera(name)
        if self.idx is None:
            raise OSError(f"no {name} camera found")
        self.cap = cv2.VideoCapture(self.idx, cv2.CAP_V4L2)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)

    def jpeg(self, quality=80):
        for _ in range(3):                                     # drop stale buffered frames
            self.cap.grab()
        ok, frame = self.cap.read()
        if not ok:
            raise OSError("camera read failed")
        ok, buf = self.cv2.imencode(".jpg", frame, [self.cv2.IMWRITE_JPEG_QUALITY, quality])
        return buf.tobytes()


if __name__ == "__main__":                                     # quick bench check
    for label, make in (("outside MS5611", MS5611), ("inside BMP280", BMP280)):
        try:
            s = make(); r = s.read()
            extra = f", PROM CRC {'ok' if s.crc_ok else 'BAD'}" if isinstance(s, MS5611) else ""
            print(f"{label}: {r['pa']} Pa, {r['c']} C{extra}")
        except OSError as e:
            print(f"{label}: not available ({e})")
    print(f"SoC: {soc_c():.1f} C")
    try:
        cam = Camera(); jpg = cam.jpeg()
        print(f"camera /dev/video{cam.idx}: {len(jpg)} byte JPEG")
    except OSError as e:
        print(f"camera: {e}")
