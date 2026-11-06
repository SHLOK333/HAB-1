// 0G over LoRa: the 27-byte uplink payload (layout in radio_brain.mjs).
import crypto from "node:crypto"

export function pack({ checkpoint, action, p, model, seq, t, rid }, key) {
  const b = Buffer.alloc(27)
  b[0] = 0x5a; b[1] = checkpoint; b[2] = action; b[3] = p == null ? 255 : Math.round(p * 254); b[4] = model
  b.writeUInt32LE(seq >>> 0, 5); b.writeUInt32LE(t >>> 0, 9)
  Buffer.from(String(rid).replace(/[^0-9a-f]/gi, "").padEnd(12, "0").slice(0, 12), "hex").copy(b, 13)
  crypto.createHmac("sha256", key).update(b.subarray(0, 19)).digest().copy(b, 19, 0, 8)
  return b
}
