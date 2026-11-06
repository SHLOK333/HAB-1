#!/usr/bin/env node
// What a buyer runs to check data bought from the endpoint without trusting the seller:
// the beacon's Ed25519 signature over its batch, and each frame's hash in that batch.
//
//   node check_proof.mjs <response.json>     (or pipe the JSON on stdin)
import crypto from "node:crypto"
import fs from "node:fs"

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

export function checkProof(proof) {
  const pub = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(proof.beacon_pubkey, "hex")]), format: "der", type: "spki" })
  return proof.frames.map(({ seq, frame, sig_frame }) => {
    if (!sig_frame) return { seq, ok: false, why: "no signature frame" }
    const s = Buffer.from(sig_frame, "hex"), f = Buffer.from(frame, "hex")
    // 100 bytes: boot number and a per-batch salt (frames.h). 94 bytes: the format before 4 Nov 2026.
    const legacy = s.length === 94
    const signed = legacy ? 30 : 36, hashesAt = legacy ? 6 : 12
    const salt = legacy ? Buffer.alloc(0) : s.subarray(8, 12)
    const sigOk = crypto.verify(null, s.subarray(0, signed), pub, s.subarray(signed, signed + 64))
    const first = s.readUInt32LE(1), i = seq - first
    const inBatch = i >= 0 && i < s[5]
    const hashOk = inBatch && crypto.createHash("sha256").update(salt).update(f).digest().subarray(0, 4).equals(s.subarray(hashesAt + 4 * i, hashesAt + 4 + 4 * i))
    const seqOk = f.readUInt32LE(1) === seq
    return { seq, ok: sigOk && hashOk && seqOk, signature: sigOk, hash_in_batch: hashOk, seq_matches: seqOk,
             ...(legacy ? { format: "before 4 Nov 2026: unsalted 4-byte hashes, no boot number" } : { boot: s.readUInt16LE(6) }) }
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = process.argv[2] ? fs.readFileSync(process.argv[2], "utf8") : fs.readFileSync(0, "utf8")
  const body = JSON.parse(text)
  for (const r of checkProof(body.proof)) console.log(JSON.stringify(r))
}
