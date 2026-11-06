// Read a Hedera private key whatever its type. DER-encoded keys say their own type;
// a raw hex key needs HEDERA_KEY_TYPE (ECDSA, the default, or ED25519).
import { PrivateKey } from "@hiero-ledger/sdk"

export function parseKey(text, type = process.env.HEDERA_KEY_TYPE ?? "ECDSA") {
  const s = text.trim().replace(/^0x/, "")
  if (s.startsWith("30")) return PrivateKey.fromStringDer(s)           // DER: type is in the encoding
  return type.toUpperCase() === "ED25519" ? PrivateKey.fromStringED25519(s) : PrivateKey.fromStringECDSA(s)
}
