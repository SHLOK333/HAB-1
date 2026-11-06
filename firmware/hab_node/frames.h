// Radio frames shared by the beacon (ROLE 1), the ground modem (ROLE 2) and
// ground/verifier.py. Little-endian, packed. Change all three together.
//
// DATA frame, 28 bytes, one per 12 s slot:
//   0      magic 0xB2
//   1..4   seq            uint32, counts data frames only
//   5..6   flight_s       int16, seconds since release (replayed)
//   7..10  lat            int32, degrees x 1e7 (replayed GPS)
//   11..14 lon            int32, degrees x 1e7 (replayed GPS)
//   15..16 alt_m          uint16, GPS altitude in m (replayed)
//   17..18 press_dhpa     uint16, outside pressure in 0.1 hPa (replayed)
//   19..20 temp_cc        int16, outside temperature in 0.01 C (replayed)
//   21..22 live_dhpa      uint16, live outside pressure in 0.1 hPa, 0 if none (live)
//   23..24 live_cc        int16, live outside temperature in 0.01 C (live)
//                         from the Pi's MS5611 over the tap line ("BARO <Pa> <C>", at most
//                         15 s old), else the beacon's own BMP280 if one is fitted
//   25     flags          bit0 replayed data, bit1 live barometer ok, bit2 live reading is the Pi's
//   26..27 key_id         first two bytes of the beacon's public key
//
// SIG frame, 100 bytes, every 7th slot, covers the 6 data frames before it:
//   0      magic 0xB3
//   1..4   first_seq      uint32
//   5      count          6
//   6..7   boot           uint16, counts the beacon's boots (kept in flash): seqs restart at
//                         0 on every boot, so (boot, first_seq) is what must only go up.
//                         A verifier refuses a batch older than one it already accepted:
//                         recorded frames cannot be replayed after a reboot.
//   8..11  salt           4 random bytes, new for every batch, sent only here
//   12..35 hashes         6 x first 4 bytes of SHA-256(salt + data frame), in seq order
//   36..99 signature      Ed25519 over bytes 0..35
//   Why the salt: with a plain 4-byte hash, someone who hears a frame can search for a fake
//   with the same 4 bytes (about 4 billion tries, about a second on a GPU). With the salt
//   kept secret until the SIG frame, the fake has to be sent before the salt exists, so it
//   can only guess: 1 in 4 billion per fake frame sent. Frames heard after their SIG frame
//   are never verified. (Before 4 Nov 2026 the SIG frame was 94 bytes, with no boot or salt.)
//
// UPLINK frame, 32 bytes, ground to beacon inside the 1 s window after a data frame:
//   0      magic 0xD1
//   1..4   seq of the data frame it answers
//   5..31  payload, 27 bytes, zero padded
//   Payloads: 0x5A ... a 0G decision for the Pi (zg/radio_packet.mjs; the beacon passes it on)
//             0xA7 + target seq uint32: the demo attacker, armed from the ground station
//             (the beacon sends one forged frame with that seq; repeats are ignored)
//
// Radio sales: a buyer node pays for a data product with no internet, and the payment
// settles on Hedera later, when the frames reach a ground station.
//
// BUY frame, 86 bytes, buyer to beacon in place of the UPLINK, in the same window:
//   0      magic 0xD2
//   1..4   seq of the data frame it answers (not signed: the voucher fits any window)
//   5..8   nonce          uint32, the buyer's voucher counter, strictly increasing
//   9      product        1 = wind at the balloon now, computed on board by the Pi
//   10..13 price          uint32, tinybar
//   14..17 buyer          uint32, Hedera account 0.0.N whose key is the buyer node's key
//   18..21 seller         uint32, Hedera account 0.0.N to pay (the beacon's payTo)
//   22..85 signature      Ed25519 by the buyer node over "hab-voucher-v1" + bytes 5..21
//
// DELIVERY frame, 88 bytes, beacon to buyer straight after a BUY it accepted:
//   0      magic 0xB4
//   1..4   nonce of the voucher it answers
//   5      status         0 delivered, 1 no fresh wind on board (do not settle)
//   6..9   seq_a          uint32 \ the two consecutive data frames the Pi computed
//   10..13 seq_b          uint32 /  the wind from, so anyone can recompute it
//   14..15 speed_cms      uint16, wind speed in cm/s
//   16..17 toward_d10     uint16, direction the wind blows toward, degrees x 10
//   18..19 alt_m          uint16, mean altitude of the two frames
//   20..23 voucher_hash   first 4 bytes of SHA-256 of the whole 86-byte BUY frame
//   24..87 signature      Ed25519 by the beacon over "hab-delivery-v1" + bytes 0..23
//   (status 2: delivered, paid over x402, below; then bytes 1..4 are the challenge and
//    bytes 20..23 hash the PAY frame)
//
// x402 over the radio: the x402 exchange (request, 402 Payment Required, payment,
// settlement, resource) between two radio nodes. The payment is a real Hedera transfer
// built and signed on the buyer's board; an x402 facilitator settles it once a ground
// station hears it, and only then does the beacon release the data.
//
// REQ frame, 10 bytes, buyer to beacon in the uplink window:
//   0      magic 0xD3
//   1..4   seq of the data frame it answers
//   5      product        1 = wind
//   6..9   buyer          uint32, Hedera account 0.0.N
//
// OFFER frame ("402 Payment Required"), 20 bytes, beacon to buyer straight after a REQ:
//   0      magic 0xB5
//   1..4   challenge      uint32, random, goes into the payment's memo
//   5      product
//   6..9   amount         uint32, tinybar
//   10..13 pay_to         uint32, Hedera account 0.0.N
//   14..17 fee_payer      uint32, the facilitator's Hedera account, payer of the network fee
//   18..19 max_timeout_s  uint16
//
// PAY frame, 81 bytes, buyer to beacon in the next uplink window:
//   0      magic 0xD4
//   1..4   seq of the data frame it answers
//   5..8   challenge
//   9..12  valid_start_s  uint32, the transaction's valid start, unix seconds
//   13..16 valid_start_ns uint32
//   17..80 signature      Ed25519 by the buyer over the Hedera TransactionBody. Both sides
//                         build the body from the offer and these fields (hederaBody in
//                         hab_node.ino, hedera/hedera_body.mjs), so it never crosses the radio.
//
// SETTLED frame, 74 bytes, ground station to beacon in an uplink window:
//   0      magic 0xD5
//   1..4   seq of the data frame it answers
//   5..8   challenge
//   9      result         0 settled on Hedera
//   10..73 signature      Ed25519 by the ground station's key over "hab-settled-v1" + bytes 5..9
#pragma once
#include <stdint.h>

#define MAGIC_DATA    0xB2
#define MAGIC_SIG     0xB3
#define MAGIC_UPLINK  0xD1
#define UP_ATTACK     0xA7        // first payload byte of an attack command (above)
#define DATA_LEN      28
#define SIG_LEN       100
#define UPLINK_LEN    32
#define BATCH         6
#define HASH_LEN      4
#define SIGNED_LEN    36          // bytes 0..35 of the SIG frame
#define SIG_HASHES    12          // where the hashes start
#define FLAG_REPLAY   0x01
#define FLAG_LIVEBARO 0x02
#define FLAG_PIBARO   0x04

#define MAGIC_BUY       0xD2
#define MAGIC_DELIVERY  0xB4
#define BUY_LEN         86
#define DELIVERY_LEN    88
#define VOUCHER_FROM    5           // signed part of a BUY: bytes 5..21
#define VOUCHER_SIGNED  17
#define DELIVERY_SIGNED 24          // bytes 0..23 of a DELIVERY
#define VOUCHER_TAG     "hab-voucher-v1"
#define DELIVERY_TAG    "hab-delivery-v1"
#define PRODUCT_WIND    1

#define MAGIC_REQ       0xD3
#define MAGIC_OFFER     0xB5
#define MAGIC_PAY       0xD4
#define MAGIC_SETTLED   0xD5
#define REQ_LEN         10
#define OFFER_LEN       20
#define PAY_LEN         81
#define SETTLED_LEN     74
#define SETTLED_TAG     "hab-settled-v1"
#define X402_TIMEOUT_S  120
