// The Hedera transfer a radio node signs, encoded by hand exactly as the firmware does
// (firmware/hab_node/hab_node.ino, hederaBody). Both sides build it from the same few
// fields, so only those fields and the signature cross the radio, and the ground can
// rebuild the signed transaction byte for byte.
//
// TransactionBody { 1 transactionID { 1 validStart { 1 s, 2 ns }, 2 payer }, 2 node,
//   3 fee, 4 validDuration { 1 s }, 6 memo, 14 cryptoTransfer { 1 transfers { 1 amounts } } }

export const NODE = 3                          // 0.0.3, a testnet consensus node
export const FEE = 100_000_000                 // the most the fee payer will pay: 1 HBAR
export const VALID_S = 120

const varint = (n) => { n = BigInt(n); const out = []; do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b) } while (n); return out }
const zigzag = (n) => { n = BigInt(n); return n >= 0n ? n << 1n : ((-n) << 1n) - 1n }
const field = (num, bytes) => [...varint((num << 3) | 2), ...varint(bytes.length), ...bytes]
const vfield = (num, v) => (BigInt(v) === 0n ? [] : [...varint(num << 3), ...varint(v)])
const account = (num) => vfield(3, num)       // shard 0 and realm 0 are left out, as proto3 does

export const memoFor = (challenge) => `x402 radio ${challenge.toString(16).padStart(8, "0")}`

export function transferBody({ feePayer, validS, validNs, payer, payTo, amount, challenge }) {
  const amountEntry = (acct, amt) => field(1, [...field(1, account(acct)), ...varint(2 << 3), ...varint(zigzag(amt))])
  const body = [
    ...field(1, [...field(1, [...vfield(1, validS), ...vfield(2, validNs)]), ...field(2, account(feePayer))]),
    ...field(2, account(NODE)),
    ...vfield(3, FEE),
    ...field(4, vfield(1, VALID_S)),
    ...field(6, [...Buffer.from(memoFor(challenge))]),
    ...field(14, field(1, [...amountEntry(payer, -BigInt(amount)), ...amountEntry(payTo, BigInt(amount))])),
  ]
  return Buffer.from(body)
}

// TransactionList { 1 Transaction { 5 signedTransactionBytes: SignedTransaction {
//   1 bodyBytes, 2 sigMap { 1 sigPair { 1 pubKeyPrefix, 3 ed25519 } } } } }
export function signedTransaction(body, pubkey, sig) {
  const signed = [...field(1, [...body]), ...field(2, field(1, [...field(1, [...pubkey]), ...field(3, [...sig])]))]
  return Buffer.from(field(1, field(5, signed)))
}
