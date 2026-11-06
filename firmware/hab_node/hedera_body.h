// The Hedera transfer a node signs for x402 over the radio, encoded by hand (protobuf).
// hedera/hedera_body.mjs builds the same bytes; both sides build it from the offer and the
// PAY frame's fields, so the 84-byte body never crosses the radio. Zero fields are left
// out, as proto3 does. A header, not the sketch: the Arduino builder would put function
// prototypes above the Pb struct.
//
// TransactionBody { 1 transactionID { 1 validStart { 1 s, 2 ns }, 2 payer }, 2 node,
//   3 fee, 4 validDuration { 1 s }, 6 memo, 14 cryptoTransfer { 1 transfers { 1 amounts } } }
#pragma once
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define HEDERA_NODE    3              // 0.0.3, a testnet consensus node
#define HEDERA_FEE     100000000ULL   // the most the fee payer will pay: 1 HBAR
#define HEDERA_VALID_S 120

struct Pb { uint8_t *p; size_t n; };
static inline void pbVarint(Pb &b, uint64_t v) { do { uint8_t c = v & 0x7f; v >>= 7; if (v) c |= 0x80; b.p[b.n++] = c; } while (v); }
static inline void pbKeyV(Pb &b, int f, uint64_t v) { if (v) { pbVarint(b, f << 3); pbVarint(b, v); } }
static inline void pbKeyL(Pb &b, int f, const uint8_t *d, size_t len) { pbVarint(b, (f << 3) | 2); pbVarint(b, len); memcpy(b.p + b.n, d, len); b.n += len; }
static inline size_t pbAccount(uint8_t *out, uint32_t num) { Pb b{out, 0}; pbKeyV(b, 3, num); return b.n; }
static inline size_t pbAmount(uint8_t *out, uint32_t acct, int64_t amt) {
  uint8_t a[8]; Pb b{out, 0};
  pbKeyL(b, 1, a, pbAccount(a, acct));
  pbVarint(b, 2 << 3); pbVarint(b, ((uint64_t)amt << 1) ^ (uint64_t)(amt >> 63));   // sint64: zigzag
  return b.n;
}

static inline size_t hederaBody(uint8_t *out, uint32_t feePayer, uint32_t vs, uint32_t vns, uint32_t payer,
                                uint32_t payToAcct, uint32_t amount, uint32_t challenge) {
  uint8_t t1[24], t2[40], t3[8], a1[24], a2[24], list[64], xfer[72], acct[8];
  Pb b{out, 0};
  Pb ts{t1, 0}; pbKeyV(ts, 1, vs); pbKeyV(ts, 2, vns);
  size_t al = pbAccount(acct, feePayer);
  Pb id{t2, 0}; pbKeyL(id, 1, t1, ts.n); pbKeyL(id, 2, acct, al);
  pbKeyL(b, 1, t2, id.n);
  al = pbAccount(acct, HEDERA_NODE); pbKeyL(b, 2, acct, al);
  pbKeyV(b, 3, HEDERA_FEE);
  Pb dur{t3, 0}; pbKeyV(dur, 1, HEDERA_VALID_S); pbKeyL(b, 4, t3, dur.n);
  char memo[24]; snprintf(memo, sizeof(memo), "x402 radio %08lx", (unsigned long)challenge);
  pbKeyL(b, 6, (const uint8_t *)memo, strlen(memo));
  size_t l1 = pbAmount(a1, payer, -(int64_t)amount), l2 = pbAmount(a2, payToAcct, (int64_t)amount);
  Pb tl{list, 0}; pbKeyL(tl, 1, a1, l1); pbKeyL(tl, 1, a2, l2);
  Pb ct{xfer, 0}; pbKeyL(ct, 1, list, tl.n);
  pbKeyL(b, 14, xfer, ct.n);
  return b.n;
}
