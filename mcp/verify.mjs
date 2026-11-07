// The ground station's check, redone from the raw radio bytes (frame layouts in
// ../firmware/hab_node/frames.h). Node's own crypto, nothing else.
//
// A SIG frame covers 6 data frames: Ed25519 over its bytes 0..35 (magic, first seq, count,
// boot, salt, 6 hashes), with the beacon's key. A data frame is genuine when the first 4 bytes
// of SHA-256(salt + frame) equal its hash in a SIG frame whose signature checks.
import crypto from "node:crypto"

export const hexBuf = h => Buffer.from(String(h ?? "").replace(/^0x/, ""), "hex")

export function decodeData(b) {
  if (b.length !== 28 || b[0] !== 0xb2) return null
  const liveDhpa = b.readUInt16LE(21)
  return {
    seq: b.readUInt32LE(1), flightS: b.readInt16LE(5), lat: b.readInt32LE(7) / 1e7, lon: b.readInt32LE(11) / 1e7,
    altM: b.readUInt16LE(15), pressureHpa: b.readUInt16LE(17) / 10, tempC: b.readInt16LE(19) / 100,
    liveHpa: liveDhpa ? liveDhpa / 10 : null, liveC: liveDhpa ? b.readInt16LE(23) / 100 : null,
    replayed: !!(b[25] & 1), liveBarometer: !!(b[25] & 2), liveFromPi: !!(b[25] & 4), keyId: b.subarray(26, 28).toString("hex"),
  }
}

export function decodeSig(b) {
  if (b.length !== 100 || b[0] !== 0xb3) return null
  const count = b[5]
  if (count < 1 || count > 6) return null
  return {
    firstSeq: b.readUInt32LE(1), count, boot: b.readUInt16LE(6), salt: b.subarray(8, 12),
    hashes: Array.from({ length: count }, (_, i) => b.subarray(12 + 4 * i, 16 + 4 * i)),
    signed: b.subarray(0, 36), signature: b.subarray(36, 100),
  }
}

export function edKey(hex) {
  const raw = hexBuf(hex)
  if (raw.length !== 32) throw new Error("beacon_key must be 32 bytes of hex (64 characters)")
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" })
}

export const signatureValid = (sig, key) => crypto.verify(null, sig.signed, key, sig.signature)
export const frameHash = (salt, frame) => crypto.createHash("sha256").update(Buffer.concat([salt, frame])).digest().subarray(0, 4)

// packets: [{ frame (hex), verdict, owner, key, ... }], sigs: [{ frame (hex), valid, owner, key }]
// Returns every packet with your own check, and every distinct SIG frame with its signature check.
export function check(packets, sigs, keyHex) {
  const key = edKey(keyHex), keyId = hexBuf(keyHex).subarray(0, 2).toString("hex")
  const batches = new Map()
  for (const s of sigs) {
    const b = hexBuf(s.frame), d = decodeSig(b)
    if (!d) continue
    const id = b.toString("hex")
    if (batches.has(id)) { batches.get(id).receivers.add(s.owner); continue }   // the same SIG frame heard by another receiver
    batches.set(id, { ...d, valid: signatureValid(d, key), receiverSaid: s.valid, receivers: new Set([s.owner]), entity: s.key })
  }
  const valid = [...batches.values()].filter(b => b.valid)
  const frames = packets.map(p => {
    const raw = hexBuf(p.frame), d = decodeData(raw)
    if (!d) return { ...p, check: "malformed frame" }
    const covering = valid.filter(b => d.seq >= b.firstSeq && d.seq < b.firstSeq + b.count)
    const match = covering.find(b => frameHash(b.salt, raw).equals(b.hashes[d.seq - b.firstSeq]))
    const check = match ? "verified" : covering.length ? "not in the signed batch" : "no signature frame on Arkiv"
    return { ...p, decoded: d, boot: match?.boot ?? null, check, keyIdMatches: d.keyId === keyId }
  })
  return { batches: [...batches.values()], frames }
}

// What the receiver published, in the words of the check above
export const AGREES = {
  verified: v => v === "verified",
  fake: v => v === "not in the signed batch",
  conflict: v => v === "not in the signed batch",
  unsigned: v => v === "no signature frame on Arkiv" || v === "verified",   // a receiver may publish a frame before another receiver's SIG appears
}
