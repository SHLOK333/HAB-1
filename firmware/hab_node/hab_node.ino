// hab_node: the demo's two radio nodes, one sketch, role chosen at compile time.
//
//   -DROLE=1  BEACON  replays the 31 Oct flight (replay_data.h) one data frame per
//                     12 s slot, adds its own live barometer, signs every 6 data
//                     frames with Ed25519 (a SIG frame in the 7th slot), and listens
//                     1 s after each data frame for an uplink. PRG sends one fake
//                     frame (the demo attacker).
//   -DROLE=2  GROUND  a radio modem for the laptop: every packet it hears goes out
//                     as one JSON line on USB serial and TCP 2323; it answers each
//                     data frame with an uplink (an ack, or a queued "up" command).
//                     It does not verify anything: ground/verifier.py does.
//                     It is also the demo's buyer node ("Sat B"): it holds its own
//                     Ed25519 key, which is its Hedera account key, signs vouchers and
//                     sends them as BUY frames; the beacon answers with a signed DELIVERY.
//
// Frame layouts are in frames.h. Radio settings copy hab1_tx (866.1 MHz, SF9,
// BW125, CR 4/5, sync 0x34, preamble 8, TCXO 1.8 V) at a fixed 0 dBm for the bench.
//
// Commands (USB serial or TCP 2323), one per line:
//   both    status | show <text>
//   beacon  attack | badsig | stride <n> | goto <i> | pubkey
//           buyer <pubkey hex> <account> | payto <account> | price <tinybar>
//           feepayer <account> | station <pubkey hex>        (x402 over the radio)
//   ground  up <hex, up to 27 bytes> | ack on | ack off | pubkey
//           buy <price> <buyer account> <seller account> | hsign <hex> (USB only)
//           clock <unix s> | x402policy <max per payment> <budget> <pay-to account>
//           x402req <buyer account> | send <hex>             (x402 over the radio)

#include <RadioLib.h>
#include <SPI.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Ed25519.h>
#include <SHA256.h>
#include <Preferences.h>
#include <esp_random.h>
#include <Adafruit_BMP280.h>
#include "frames.h"
#include "hedera_body.h"
#include "net.h"
#include "replay_data.h"   // included for both roles: the Arduino builder puts function
                           // prototypes above any #if, so the beacon's types must be visible

#ifndef ROLE
#error "compile with -DROLE=1 (beacon) or -DROLE=2 (ground)"
#endif

#define FREQ_MHZ        866.1
#define LORA_SF         9
#define LORA_BW         125.0
#define LORA_CR         5
#define LORA_SYNC       0x34
#define LORA_PREAMBLE   8
#define TCXO_V          1.8f
#define TX_DBM          0
#define SLOT_MS         12000
#define WINDOW_MS       1000
#define REPLY_DELAY_MS  50
#define DUTY_LIMIT_PCT  2.50f       // G.S.R. 853(E) Table II
#define DUTY_GUARD_PCT  2.40f       // refuse a transmission that would take us above this

#define OLED_SDA 17
#define OLED_SCL 18
#define OLED_RST 21
#define VEXT     36                 // LOW powers the OLED
#define PRG_PIN  0

SPIClass    spiLoRa(HSPI);
SPISettings spiCfg(2000000, MSBFIRST, SPI_MODE0);
SX1262 radio = new Module(8, 14, 12, 13, spiLoRa, spiCfg);
Adafruit_SSD1306 display(128, 64, &Wire, OLED_RST);

volatile bool rxFlag = false;
void IRAM_ATTR onRx() { rxFlag = true; }

bool oledOk = false;
String showText = "";               // a line the laptop can put on the screen
uint32_t airtimeUs = 0, firstTxMs = 0;

// ------------------------------------------------------------- helpers ----
float dutyPct(uint32_t extraUs = 0) {
  if (!firstTxMs && !extraUs) return 0;
  uint32_t since = firstTxMs ? millis() - firstTxMs : 0;
  uint32_t cycles = since / SLOT_MS + 1;
  return 100.0f * ((airtimeUs + extraUs) / 1000.0f) / (cycles * (float)SLOT_MS);
}

// Transmit only if it keeps this node under the duty guard. Returns RadioLib status,
// or 1 when the guard refused.
int sendGuarded(const uint8_t *buf, size_t len, uint32_t *txUs) {
  uint32_t toa = radio.getTimeOnAir(len);
  if (dutyPct(toa) > DUTY_GUARD_PCT) {
    logf("duty guard: %u-byte frame refused, would reach %.2f%% (guard %.2f%%, limit %.2f%%)\n",
         (unsigned)len, dutyPct(toa), DUTY_GUARD_PCT, DUTY_LIMIT_PCT);
    return 1;
  }
  if (!firstTxMs) firstTxMs = millis();
  uint32_t t0 = micros();
  int st = radio.transmit((uint8_t *)buf, len);
  *txUs = micros() - t0;
  if (st == RADIOLIB_ERR_NONE) airtimeUs += toa;
  return st;
}

String hex(const uint8_t *b, size_t n) {
  static const char *d = "0123456789abcdef";
  String s; s.reserve(n * 2);
  for (size_t i = 0; i < n; i++) { s += d[b[i] >> 4]; s += d[b[i] & 15]; }
  return s;
}

size_t unhex(const String &s, uint8_t *out, size_t max) {
  size_t n = 0;
  for (size_t i = 0; i + 1 < s.length() && n < max; i += 2)
    out[n++] = (uint8_t)strtoul(s.substring(i, i + 2).c_str(), nullptr, 16);
  return n;
}

void put16(uint8_t *p, uint16_t v) { memcpy(p, &v, 2); }
void put32(uint8_t *p, uint32_t v) { memcpy(p, &v, 4); }
uint32_t get32(const uint8_t *p) { uint32_t v; memcpy(&v, p, 4); return v; }
uint16_t get16(const uint8_t *p) { uint16_t v; memcpy(&v, p, 2); return v; }

// Each node's Ed25519 key is made on the board and never leaves it.
Preferences prefs;
uint8_t priv[32], pub[32];

void loadKey() {
  prefs.begin("habnode", false);
  if (prefs.getBytes("priv", priv, 32) != 32) {
    esp_fill_random(priv, 32);
    prefs.putBytes("priv", priv, 32);
    logf("key: new Ed25519 key generated and stored in flash\n");
  }
  Ed25519::derivePublicKey(pub, priv);
  logf("pubkey %s\n", hex(pub, 32).c_str());
}

// Vouchers and deliveries are signed with a tag in front, so neither signature can
// stand for anything else this key signs (the buyer's key is also a Hedera account key).
size_t tagged(uint8_t *out, const char *tag, const uint8_t *b, size_t n) {
  size_t t = strlen(tag);
  memcpy(out, tag, t); memcpy(out + t, b, n);
  return t + n;
}

void sha4(const uint8_t *b, size_t n, uint8_t *out) {
  SHA256 sha; uint8_t h[32];
  sha.reset(); sha.update(b, n); sha.finalize(h, 32);
  memcpy(out, h, 4);
}

String rf(float rssi, float snr) { return "rssi " + String(rssi, 0) + " snr " + String(snr, 1) + " dB"; }

void oledUp() {
  pinMode(VEXT, OUTPUT); digitalWrite(VEXT, LOW); delay(50);
  Wire.begin(OLED_SDA, OLED_SCL);
  pinMode(OLED_RST, OUTPUT);
  digitalWrite(OLED_RST, LOW); delay(20); digitalWrite(OLED_RST, HIGH); delay(20);
  oledOk = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (oledOk) { display.setTextColor(SSD1306_WHITE); display.setTextSize(1); }
}

// Up to 8 lines of at most 21 characters (longer lines wrap and push the rest down).
void screen(std::initializer_list<String> lines) {
  if (!oledOk) return;
  display.clearDisplay();
  display.setCursor(0, 0);
  for (const String &l : lines) display.println(l);
  display.display();
}

void radioUp() {
  spiLoRa.begin(9, 11, 10, 8);
  int st = radio.begin(FREQ_MHZ, LORA_BW, LORA_SF, LORA_CR, LORA_SYNC, TX_DBM, LORA_PREAMBLE, TCXO_V);
  if (st != RADIOLIB_ERR_NONE) {
    logf("radio.begin failed: %d\n", st);
    screen({"RADIO FAIL", String(st)});
    while (true) delay(1000);
  }
  radio.setCRC(true);
  radio.setPacketReceivedAction(onRx);
  logf("radio ok: %.1f MHz SF%d BW%.0f CR4/%d %d dBm; time on air data %.1f ms, sig %.1f ms, uplink %.1f ms\n",
       FREQ_MHZ, LORA_SF, LORA_BW, LORA_CR, TX_DBM,
       radio.getTimeOnAir(DATA_LEN) / 1000.0f, radio.getTimeOnAir(SIG_LEN) / 1000.0f,
       radio.getTimeOnAir(UPLINK_LEN) / 1000.0f);
}

// Wait up to ms for a packet, keeping Wi-Fi, OTA and commands alive meanwhile.
bool handleCommand(const String &cmd);
bool waitPacket(uint32_t ms) {
  uint32_t t0 = millis();
  String cmd;
  while (millis() - t0 < ms) {
    if (rxFlag) return true;
    if (netLoop(cmd)) handleCommand(cmd);
  }
  return false;
}

bool cmdFromUsb = false;             // hsign is taken from the USB cable only, never Wi-Fi
void pollCommands() {
  String cmd;
  if (netLoop(cmd)) handleCommand(cmd);
  if (Serial.available()) {
    cmd = Serial.readStringUntil('\n'); cmd.trim();
    cmdFromUsb = true; if (cmd.length()) handleCommand(cmd); cmdFromUsb = false;
  }
}

// ---------------------------------------------------------------- beacon ----
#if ROLE == 1

#define BMP_SDA 41
#define BMP_SCL 42
// Tap line to the payload Pi, as wired on HAB-1: Heltec GPIO 6 (TX) to Pi pin 10,
// plus Pi pin 8 to Heltec GPIO 7 (RX) for the Pi's messages. 38400 baud, 3.3 V both sides.
#define TAP_TX  6
#define TAP_RX  7

Adafruit_BMP280 bmp(&Wire1);
HardwareSerial tap(2);
String tapLine;
uint32_t tapRxBytes = 0;            // every byte seen on GPIO 7, to tell a wiring fault from a framing one
float piPa = 0, piC = 0;            // the Pi's MS5611, from "BARO <Pa> <C>" on the tap line
uint32_t piBaroMs = 0;              // when it arrived; older than PI_BARO_MAX_AGE_MS is not used
#define PI_BARO_MAX_AGE_MS 15000
String tapRaw;                      // the last 24 bytes as hex
bool bmpOk = false;
float signMs = 0;

uint32_t seq = 0, slot = 0, lastSlotMs = 0, upOk = 0, upNone = 0;
int replayIdx = 0, stride = 5;      // 5 samples of 60 s per frame: 5 min of flight every 12 s
uint8_t batchFrames[BATCH][DATA_LEN];
int batchCount = 0;
uint32_t batchFirstSeq = 0;
uint16_t bootCount = 0;             // this boot's number, kept in flash, signed into every SIG
uint8_t batchSalt[4];               // secret until the batch's SIG frame (frames.h)
bool attackPending = false, badSigPending = false;
String lastUp = "UP --", lastRf = "rssi -- snr --", lastNote = "";
uint8_t lastData[DATA_LEN];

// Radio sales (BUY / DELIVERY in frames.h). Who may buy, who gets paid and the price are
// set before flight ("buyer", "payto", "price") and kept in flash with the last nonce used.
uint8_t buyerPub[32];
bool haveBuyer = false;
uint32_t buyerAcct = 0, payTo = 0, priceTb = 1000000, lastNonce = 0, lastSaleMs = 0, sales = 0;
// One delivery (515 ms on air) per 5 min at most: 12 an hour is 6.2 s, inside the 9 s an
// hour the 2.25% beacon schedule leaves under the 2.5% limit.
#define SALE_GAP_MS 300000
// The Pi's wind, computed on board from two consecutive frames:
// "WIND <seq_a> <seq_b> <speed cm/s> <toward deg x10> <alt m>" on the tap line.
uint32_t windA = 0, windB = 0, windMs = 0;
uint16_t windCms = 0, windDir10 = 0, windAlt = 0;
#define WIND_MAX_AGE_MS 30000

// x402 over the radio: one offer at a time. The facilitator's fee payer and the ground
// station's key (it signs SETTLED) are set before flight.
uint32_t feePayerAcct = 0;
uint8_t stationPub[32];
bool haveStation = false;
uint32_t offerChallenge = 0, offerMs = 0, payVs = 0, payVns = 0;
bool offerPaid = false;
uint8_t payHash[4];

void loadSales() {
  haveBuyer = prefs.getBytes("buyerPub", buyerPub, 32) == 32;
  buyerAcct = prefs.getUInt("buyerAcct", 0);
  payTo = prefs.getUInt("payTo", 0);
  priceTb = prefs.getUInt("price", 1000000);
  lastNonce = prefs.getUInt("nonce", 0);
  feePayerAcct = prefs.getUInt("feePayer", 0);
  haveStation = prefs.getBytes("stationPub", stationPub, 32) == 32;
  logf("sales: buyer %s 0.0.%lu, pay to 0.0.%lu, price %lu tinybar, last nonce %lu\n",
       haveBuyer ? hex(buyerPub, 4).c_str() : "none", buyerAcct, payTo, priceTb, lastNonce);
}

void hash4(const uint8_t *frame, uint8_t *out) {
  SHA256 sha; uint8_t h[32];
  sha.reset(); sha.update(batchSalt, 4); sha.update(frame, DATA_LEN); sha.finalize(h, 32);
  memcpy(out, h, HASH_LEN);
}

void buildData(uint8_t *f, const ReplaySample &s, int32_t lat7, int32_t lon7, uint16_t altM) {
  memset(f, 0, DATA_LEN);
  f[0] = MAGIC_DATA;
  put32(f + 1, seq);
  put16(f + 5, (uint16_t)s.flightS);
  put32(f + 7, (uint32_t)lat7);
  put32(f + 11, (uint32_t)lon7);
  put16(f + 15, altM);
  put16(f + 17, s.pressDhPa);
  put16(f + 19, (uint16_t)s.tempCc);
  uint8_t flags = FLAG_REPLAY;
  bool piFresh = piBaroMs && millis() - piBaroMs < PI_BARO_MAX_AGE_MS;
  if (piFresh) {
    put16(f + 21, (uint16_t)lroundf(piPa / 10.0f));
    put16(f + 23, (uint16_t)(int16_t)lroundf(piC * 100.0f));
    flags |= FLAG_LIVEBARO | FLAG_PIBARO;
  } else if (bmpOk) {
    put16(f + 21, (uint16_t)lroundf(bmp.readPressure() / 10.0f));
    put16(f + 23, (uint16_t)(int16_t)lroundf(bmp.readTemperature() * 100.0f));
    flags |= FLAG_LIVEBARO;
  }
  f[25] = flags;
  f[26] = pub[0]; f[27] = pub[1];
}

void showBeacon() {
  const ReplaySample &s = REPLAY[replayIdx];
  screen({"BEACON seq " + String(seq) + " " + String(batchCount) + "/" + String(BATCH),
          "T" + String(s.flightS >= 0 ? "+" : "") + String(s.flightS / 60.0f, 1) + "min " + String(s.altM) + "m",
          lastUp, lastRf,
          "duty " + String(dutyPct(), 2) + "% of " + String(DUTY_LIMIT_PCT, 2) + "%",
          "wifi " + netIp(),
          lastNote.length() ? lastNote : String("key ") + hex(pub, 2) + " sign " + String(signMs, 0) + "ms",
          showText});
}

void sendSig() {
  uint8_t f[SIG_LEN];
  f[0] = MAGIC_SIG;
  put32(f + 1, batchFirstSeq);
  put16(f + 6, bootCount);
  memcpy(f + 8, batchSalt, 4);
  f[5] = BATCH;
  for (int i = 0; i < BATCH; i++) hash4(batchFrames[i], f + SIG_HASHES + i * HASH_LEN);
  uint32_t t0 = micros();
  Ed25519::sign(f + SIGNED_LEN, priv, pub, f, SIGNED_LEN);
  signMs = (micros() - t0) / 1000.0f;
  if (badSigPending) { f[SIGNED_LEN] ^= 0x01; badSigPending = false; lastNote = "TEST: bad signature"; }
  uint32_t txUs;
  int st = sendGuarded(f, SIG_LEN, &txUs);
  logf("sig  boot %u seqs %lu..%lu signed in %.1f ms, tx %.1f ms %s | duty %.2f%%\n",
       bootCount, batchFirstSeq, batchFirstSeq + BATCH - 1, signMs, txUs / 1000.0f,
       st == RADIOLIB_ERR_NONE ? "ok" : "NOT SENT", dutyPct());
  batchCount = 0;
}

// Would the rest of this batch and its signature still fit under the duty guard after a
// sale? Measured: right after a reboot a 515 ms delivery left too little, the guard
// refused the batch's SIG frame and its 6 frames could never be verified. A sale must
// never cost a signature, so it waits until the airtime is there.
bool saleFits(uint32_t saleUs) {
  int rem = BATCH - batchCount;                     // data frames before this batch's SIG
  uint32_t since = firstTxMs ? millis() - firstTxMs : 0;
  uint32_t cycles = since / SLOT_MS + 1 + rem + 1;  // slots counted when the SIG goes out
  uint32_t air = airtimeUs + saleUs + rem * radio.getTimeOnAir(DATA_LEN) + radio.getTimeOnAir(SIG_LEN);
  return 100.0f * (air / 1000.0f) / (cycles * (float)SLOT_MS) <= DUTY_GUARD_PCT;
}

// A BUY arrived in the uplink window. Check the voucher, then answer with the wind the Pi
// computed, signed. A refused voucher gets no reply: replying would let anyone spend the
// beacon's airtime.
void handleBuy(const uint8_t *b) {
  uint32_t nonce = get32(b + 5), price = get32(b + 10), buyer = get32(b + 14), seller = get32(b + 18);
  uint8_t msg[48];
  size_t m = tagged(msg, VOUCHER_TAG, b + VOUCHER_FROM, VOUCHER_SIGNED);
  const char *why = nullptr;
  if (!haveBuyer || buyer != buyerAcct)                   why = "unknown buyer";
  else if (!Ed25519::verify(b + 22, buyerPub, msg, m))    why = "bad voucher signature";
  else if (seller != payTo)                               why = "voucher pays another account";
  else if (price < priceTb)                               why = "price below ours";
  else if (b[9] != PRODUCT_WIND)                          why = "unknown product";
  else if (nonce <= lastNonce)                            why = "voucher already used";
  else if (lastSaleMs && millis() - lastSaleMs < SALE_GAP_MS) why = "too soon after the last sale (airtime)";
  else if (!saleFits(radio.getTimeOnAir(DELIVERY_LEN)))  why = "not enough airtime yet: the batch signature comes first";
  if (why) {
    logf("buy nonce %lu from 0.0.%lu REFUSED: %s, no reply\n", nonce, buyer, why);
    lastNote = "BUY refused"; return;
  }
  lastNonce = nonce; prefs.putUInt("nonce", nonce);

  bool fresh = windMs && millis() - windMs < WIND_MAX_AGE_MS;
  uint8_t d[DELIVERY_LEN] = {0};
  d[0] = MAGIC_DELIVERY;
  put32(d + 1, nonce);
  d[5] = fresh ? 0 : 1;
  if (fresh) { put32(d + 6, windA); put32(d + 10, windB); put16(d + 14, windCms); put16(d + 16, windDir10); put16(d + 18, windAlt); }
  sha4(b, BUY_LEN, d + 20);
  m = tagged(msg, DELIVERY_TAG, d, DELIVERY_SIGNED);
  Ed25519::sign(d + DELIVERY_SIGNED, priv, pub, msg, m);
  // The buyer has just transmitted; give it time to get back into receive.
  uint32_t t0 = millis();
  while (millis() - t0 < 150) { String c; if (netLoop(c)) handleCommand(c); }
  uint32_t txUs;
  int st = sendGuarded(d, DELIVERY_LEN, &txUs);
  if (st == RADIOLIB_ERR_NONE) { lastSaleMs = millis(); if (fresh) sales++; }
  lastNote = st != RADIOLIB_ERR_NONE ? "SALE not sent" : fresh ? "SOLD wind " + String(windCms / 100.0f, 1) + "m/s" : "BUY: no wind yet";
  logf("buy nonce %lu from 0.0.%lu for %lu tinybar: %s, delivery %s (tx %.1f ms) | duty %.2f%%\n",
       nonce, buyer, price, fresh ? ("wind " + String(windCms / 100.0f, 2) + " m/s toward " + String(windDir10 / 10.0f, 1) +
       " deg at " + String(windAlt) + " m, frames " + String(windA) + "," + String(windB)).c_str() : "no fresh wind from the Pi",
       st == RADIOLIB_ERR_NONE ? "sent" : "NOT SENT", txUs / 1000.0f, dutyPct());
}

// Build and send a DELIVERY of the Pi's wind. status: 0 sold for a voucher, 2 paid over
// x402 (1 when the Pi has no fresh wind). Returns whether the Pi's wind was fresh.
bool sendDelivery(uint32_t id, uint8_t paidStatus, const uint8_t *paidHash4, int *stOut, uint32_t *txUs) {
  bool fresh = windMs && millis() - windMs < WIND_MAX_AGE_MS;
  uint8_t d[DELIVERY_LEN] = {0}, msg[48];
  d[0] = MAGIC_DELIVERY;
  put32(d + 1, id);
  d[5] = fresh ? paidStatus : 1;
  if (fresh) { put32(d + 6, windA); put32(d + 10, windB); put16(d + 14, windCms); put16(d + 16, windDir10); put16(d + 18, windAlt); }
  memcpy(d + 20, paidHash4, 4);
  size_t m = tagged(msg, DELIVERY_TAG, d, DELIVERY_SIGNED);
  Ed25519::sign(d + DELIVERY_SIGNED, priv, pub, msg, m);
  uint32_t t0 = millis();
  while (millis() - t0 < 150) { String c; if (netLoop(c)) handleCommand(c); }
  *stOut = sendGuarded(d, DELIVERY_LEN, txUs);
  return fresh;
}

// x402 step 1: a REQ. Answer "402 Payment Required" with a fresh challenge. Only the
// pinned buyer gets an answer, and only when the offer and the delivery both fit the airtime.
void handleReq(const uint8_t *b) {
  uint32_t buyer = get32(b + 6);
  const char *why = nullptr;
  if (!haveBuyer || buyer != buyerAcct)                       why = "unknown buyer";
  else if (!haveStation || !feePayerAcct || !payTo)           why = "x402 not set up (station, feepayer, payto)";
  else if (b[5] != PRODUCT_WIND)                              why = "unknown product";
  else if (lastSaleMs && millis() - lastSaleMs < SALE_GAP_MS) why = "too soon after the last sale (airtime)";
  else if (!saleFits(radio.getTimeOnAir(OFFER_LEN) + radio.getTimeOnAir(DELIVERY_LEN))) why = "not enough airtime yet: the batch signature comes first";
  if (why) { logf("x402 request from 0.0.%lu REFUSED: %s, no reply\n", buyer, why); lastNote = "402 refused"; return; }
  offerChallenge = esp_random(); offerMs = millis(); offerPaid = false;
  uint8_t o[OFFER_LEN] = {0};
  o[0] = MAGIC_OFFER;
  put32(o + 1, offerChallenge); o[5] = PRODUCT_WIND; put32(o + 6, priceTb);
  put32(o + 10, payTo); put32(o + 14, feePayerAcct); put16(o + 18, X402_TIMEOUT_S);
  uint32_t t0 = millis();
  while (millis() - t0 < 150) { String c; if (netLoop(c)) handleCommand(c); }
  uint32_t txUs;
  int st = sendGuarded(o, OFFER_LEN, &txUs);
  lastNote = st == RADIOLIB_ERR_NONE ? "402: " + String(priceTb) + " tb" : "402 not sent";
  logf("x402 request from 0.0.%lu: 402 Payment Required, %lu tinybar to 0.0.%lu, fee payer 0.0.%lu, challenge %08lx %s | duty %.2f%%\n",
       buyer, priceTb, payTo, feePayerAcct, offerChallenge, st == RADIOLIB_ERR_NONE ? "sent" : "NOT SENT", dutyPct());
}

// x402 step 2: a PAY. Rebuild the Hedera transfer the offer asked for and check the buyer
// signed exactly that. Nothing is sent: the data waits for settlement.
void handlePay(const uint8_t *b) {
  uint32_t ch = get32(b + 5), vs = get32(b + 9), vns = get32(b + 13);
  uint8_t body[128];
  size_t n = hederaBody(body, feePayerAcct, vs, vns, buyerAcct, payTo, priceTb, ch);
  const char *why = nullptr;
  if (!offerChallenge || ch != offerChallenge)                   why = "no open offer with that challenge";
  else if (millis() - offerMs > X402_TIMEOUT_S * 1000UL)         why = "offer expired";
  else if (!Ed25519::verify(b + 17, buyerPub, body, n))          why = "signature is not over the transfer we asked for";
  if (why) { logf("x402 payment REFUSED: %s\n", why); lastNote = "PAY refused"; return; }
  offerPaid = true; payVs = vs; payVns = vns; sha4(b, PAY_LEN, payHash);
  lastNote = "PAID? settling...";
  logf("x402 payment for challenge %08lx: signed Hedera transfer checks (%u-byte body, tx 0.0.%lu@%lu.%09lu); waiting for settlement\n",
       ch, (unsigned)n, feePayerAcct, vs, vns);
}

// x402 step 3: SETTLED from the ground station: the facilitator has settled the payment on
// Hedera. Only now is the wind released.
void handleSettled(const uint8_t *b) {
  uint32_t ch = get32(b + 5);
  uint8_t msg[32];
  size_t m = tagged(msg, SETTLED_TAG, b + 5, 5);
  const char *why = nullptr;
  if (!offerPaid || ch != offerChallenge)                  why = "no verified payment with that challenge";
  else if (!Ed25519::verify(b + 10, stationPub, msg, m))   why = "not signed by our ground station";
  else if (b[9] != 0)                                      why = "ground station says settlement failed";
  if (why) { logf("x402 settlement REFUSED: %s\n", why); return; }
  offerChallenge = 0; offerPaid = false;
  int st; uint32_t txUs;
  bool fresh = sendDelivery(ch, 2, payHash, &st, &txUs);
  if (st == RADIOLIB_ERR_NONE) { lastSaleMs = millis(); if (fresh) sales++; }
  lastNote = st != RADIOLIB_ERR_NONE ? "x402 data not sent" : "x402 SOLD " + String(windCms / 100.0f, 1) + "m/s";
  logf("x402 settled (tx 0.0.%lu@%lu.%09lu): delivery of %s %s (tx %.1f ms) | duty %.2f%%\n", feePayerAcct, payVs, payVns,
       fresh ? ("wind " + String(windCms / 100.0f, 2) + " m/s toward " + String(windDir10 / 10.0f, 1) + " deg at " + String(windAlt) + " m").c_str()
             : "no fresh wind", st == RADIOLIB_ERR_NONE ? "sent" : "NOT SENT", txUs / 1000.0f, dutyPct());
}

void sendData() {
  const ReplaySample &s = REPLAY[replayIdx];
  uint8_t f[DATA_LEN];
  buildData(f, s, s.lat7, s.lon7, s.altM);
  if (batchCount == 0) { batchFirstSeq = seq; esp_fill_random(batchSalt, 4); }
  uint32_t txUs;
  int st = sendGuarded(f, DATA_LEN, &txUs);
  if (st != RADIOLIB_ERR_NONE) { logf("data seq %lu NOT SENT (%d)\n", seq, st); return; }
  memcpy(batchFrames[batchCount++], f, DATA_LEN);
  memcpy(lastData, f, DATA_LEN);
  tap.printf("TAP %lu %s\n", seq, hex(f, DATA_LEN).c_str());   // the Pi gets every frame the beacon sends
  uint32_t txEnd = millis();

  rxFlag = false;
  radio.startReceive();
  bool got = waitPacket(WINDOW_MS);
  uint32_t dt = millis() - txEnd;
  if (got) {
    uint8_t up[128];
    size_t n = radio.getPacketLength();
    int rst = radio.readData(up, min(n, sizeof(up)));
    uint32_t echo; memcpy(&echo, up + 1, 4);
    float rssi = radio.getRSSI(), snr = radio.getSNR();
    if (rst == RADIOLIB_ERR_NONE && n == UPLINK_LEN && up[0] == MAGIC_UPLINK && echo == seq) {
      upOk++;
      lastUp = "UP OK in " + String(dt) + "ms"; lastRf = rf(rssi, snr);
      bool any = false; for (int i = 5; i < UPLINK_LEN; i++) any |= up[i] != 0;
      logf("data seq %lu T%+d s %u m | up ok %lu ms rssi %.1f snr %.1f%s%s | duty %.2f%%\n",
           seq, s.flightS, s.altM, dt, rssi, snr, any ? " payload " : "", any ? hex(up + 5, UPLINK_LEN - 5).c_str() : "", dutyPct());
    } else if (rst == RADIOLIB_ERR_NONE && echo == seq &&
               ((n == REQ_LEN && up[0] == MAGIC_REQ) || (n == PAY_LEN && up[0] == MAGIC_PAY) || (n == SETTLED_LEN && up[0] == MAGIC_SETTLED))) {
      upOk++;                       // each of these is also the ack for this frame
      const char *what = up[0] == MAGIC_REQ ? "x402 request" : up[0] == MAGIC_PAY ? "x402 payment" : "x402 settled";
      lastUp = String(what).substring(5) + " " + String(dt) + "ms"; lastRf = rf(rssi, snr);
      logf("data seq %lu T%+d s %u m | %s %lu ms rssi %.1f snr %.1f\n", seq, s.flightS, s.altM, what, dt, rssi, snr);
      if (up[0] == MAGIC_REQ) handleReq(up); else if (up[0] == MAGIC_PAY) handlePay(up); else handleSettled(up);
    } else if (rst == RADIOLIB_ERR_NONE && n == BUY_LEN && up[0] == MAGIC_BUY && echo == seq) {
      upOk++;                       // a BUY is also the ack for this frame
      lastUp = "BUY in " + String(dt) + "ms"; lastRf = rf(rssi, snr);
      logf("data seq %lu T%+d s %u m | buy %lu ms rssi %.1f snr %.1f\n", seq, s.flightS, s.altM, dt, rssi, snr);
      handleBuy(up);
    } else {
      lastUp = "UP BAD len " + String((unsigned)n); lastRf = rf(rssi, snr);
      logf("data seq %lu | uplink bad (st %d len %u)\n", seq, rst, (unsigned)n);
    }
  } else {
    upNone++;
    lastUp = "UP NONE"; lastRf = "rssi -- snr --";
    logf("data seq %lu T%+d s %u m | up none | duty %.2f%%\n", seq, s.flightS, s.altM, dutyPct());
  }
  radio.standby();

  // The demo attacker: a second frame claiming the same seq, saying the balloon
  // has landed 30 km away. It is never added to the signed batch.
  if (attackPending) {
    attackPending = false;
    // Wait until the ground has finished its uplink and is listening again: sent
    // straight after the uplink arrives, the fake started before the ground was back
    // in receive and was never heard (measured: no fake reached the verifier).
    while (millis() - txEnd < WINDOW_MS + 200) { String c; if (netLoop(c)) handleCommand(c); }
    uint8_t fake[DATA_LEN];
    buildData(fake, s, s.lat7 + 2700000, s.lon7 - 1500000, 0);
    int ast = sendGuarded(fake, DATA_LEN, &txUs);
    lastNote = ast == RADIOLIB_ERR_NONE ? "ATTACK sent seq " + String(seq) : "attack refused";
    logf("ATTACK fake frame for seq %lu %s\n", seq, ast == RADIOLIB_ERR_NONE ? "sent" : "NOT SENT");
  }
  seq++;
  replayIdx += stride;
  if (replayIdx >= REPLAY_COUNT) { replayIdx = 0; logf("replay: end of flight, starting again\n"); }
}

bool handleCommand(const String &c) {
  if (c == "attack")             { attackPending = true; logf("attack armed: next data slot\n"); }
  else if (c == "badsig")        { badSigPending = true; logf("next signature will be corrupted (test)\n"); }
  else if (c.startsWith("stride ")) { stride = max(1, (int)c.substring(7).toInt()); logf("stride %d\n", stride); }
  else if (c.startsWith("goto "))   { replayIdx = constrain((int)c.substring(5).toInt(), 0, REPLAY_COUNT - 1); logf("replay index %d\n", replayIdx); }
  else if (c == "pubkey")        logf("pubkey %s\n", hex(pub, 32).c_str());
  else if (c.startsWith("buyer ")) {
    int sp = c.indexOf(' ', 6);
    if (sp < 0 || unhex(c.substring(6, sp), buyerPub, 32) != 32) { logf("usage: buyer <64 hex pubkey> <account number>\n"); return false; }
    buyerAcct = c.substring(sp + 1).toInt();
    prefs.putBytes("buyerPub", buyerPub, 32); prefs.putUInt("buyerAcct", buyerAcct); haveBuyer = true;
    logf("buyer set: key %s account 0.0.%lu\n", hex(buyerPub, 32).c_str(), buyerAcct);
  }
  else if (c.startsWith("payto "))  { payTo = c.substring(6).toInt(); prefs.putUInt("payTo", payTo); logf("pay to 0.0.%lu\n", payTo); }
  else if (c.startsWith("price "))  { priceTb = c.substring(6).toInt(); prefs.putUInt("price", priceTb); logf("price %lu tinybar\n", priceTb); }
  else if (c.startsWith("feepayer ")) { feePayerAcct = c.substring(9).toInt(); prefs.putUInt("feePayer", feePayerAcct); logf("fee payer 0.0.%lu\n", feePayerAcct); }
  else if (c.startsWith("station ")) {
    if (unhex(c.substring(8), stationPub, 32) != 32) { logf("usage: station <64 hex pubkey>\n"); return false; }
    prefs.putBytes("stationPub", stationPub, 32); haveStation = true;
    logf("station key %s\n", hex(stationPub, 32).c_str());
  }
  else if (c == "sales")         logf("sales %lu, last nonce %lu, buyer 0.0.%lu, pay to 0.0.%lu, price %lu, wind %s\n", sales, lastNonce, buyerAcct, payTo, priceTb,
                                      windMs ? (String(windCms / 100.0f, 2) + " m/s toward " + String(windDir10 / 10.0f, 1) + " deg at " + String(windAlt) + " m, " +
                                                String((millis() - windMs) / 1000) + " s old").c_str() : "none");
  else if (c == "i2cscan") {
    // Which I2C devices answer? Wire1 is the barometer bus (GPIO 41/42); Wire is the
    // OLED's (17/18). Then try the BMP280 again, in case one was wired after boot.
    String out = "i2cscan: baro bus (41/42):";
    int found = 0;
    for (uint8_t a = 1; a < 127; a++) { Wire1.beginTransmission(a); if (Wire1.endTransmission() == 0) { out += " 0x" + String(a, HEX); found++; } }
    if (!found) out += " none";
    out += " | oled bus (17/18):";
    found = 0;
    for (uint8_t a = 1; a < 127; a++) { Wire.beginTransmission(a); if (Wire.endTransmission() == 0) { out += " 0x" + String(a, HEX); found++; } }
    if (!found) out += " none";
    bmpOk = bmp.begin(0x76) || bmp.begin(0x77);
    out += bmpOk ? " | BMP280 ok: " + String(bmp.readPressure(), 1) + " Pa " + String(bmp.readTemperature(), 2) + " C" : " | BMP280 not found";
    logf("%s\n", out.c_str());
  }
  else if (c == "pinscan") {
    // Which header pin does the Pi's TX wire land on? Watch every free header pin
    // for 3 s while the Pi transmits; the one that toggles is the wire. 37 (battery
    // gate output) and 6 (our TX) are left alone.
    const int pins[] = {1, 2, 3, 4, 5, 7, 38, 39, 40, 41, 42, 45, 46};
    const int n = sizeof(pins) / sizeof(pins[0]);
    uint32_t edges[n] = {0}; int last[n], high[n] = {0};
    tap.end();
    for (int i = 0; i < n; i++) { pinMode(pins[i], INPUT_PULLDOWN); last[i] = digitalRead(pins[i]); }
    uint32_t t0 = millis(), samples = 0;
    while (millis() - t0 < 3000) {
      for (int i = 0; i < n; i++) { int v = digitalRead(pins[i]); if (v != last[i]) { edges[i]++; last[i] = v; } high[i] += v; }
      samples++;
    }
    String out = "pinscan:";
    for (int i = 0; i < n; i++)
      out += " " + String(pins[i]) + "=" + String(edges[i]) + (high[i] > (int)samples / 2 ? "H" : "L");
    logf("%s\n", out.c_str());
    tap.begin(38400, SERIAL_8N1, TAP_RX, TAP_TX);
    Wire1.begin(BMP_SDA, BMP_SCL, 400000);
  }
  else if (c.startsWith("show "))   showText = c.substring(5);
  else if (c == "status")        logf("beacon seq %lu idx %d stride %d batch %d/%d up ok %lu none %lu duty %.2f%% wifi %s tap rx %lu bytes, last %s, pi baro %s\n",
                                      seq, replayIdx, stride, batchCount, BATCH, upOk, upNone, dutyPct(), netIp().c_str(),
                                      tapRxBytes, tapRaw.length() ? tapRaw.c_str() : "-",
                                      piBaroMs ? (String(piPa, 1) + " Pa " + String(piC, 2) + " C, " + String((millis() - piBaroMs) / 1000) + " s old").c_str() : "none");
  else { logf("unknown command: %s\n", c.c_str()); return false; }
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  pinMode(PRG_PIN, INPUT_PULLUP);
  oledUp();
  screen({"BEACON", "starting..."});
  logf("\nhab_node BEACON\n");
  loadKey();
  bootCount = prefs.getUShort("boot", 0) + 1;
  prefs.putUShort("boot", bootCount);
  logf("boot %u\n", bootCount);
  loadSales();
  Wire1.begin(BMP_SDA, BMP_SCL, 400000);
  bmpOk = bmp.begin(0x76) || bmp.begin(0x77);
  logf("live barometer: %s\n", bmpOk ? "ok" : "not found (frames carry 0)");
  tap.begin(38400, SERIAL_8N1, TAP_RX, TAP_TX);
  netBegin("hab-beacon");
  radioUp();
  float cycle = 100.0f * (BATCH * radio.getTimeOnAir(DATA_LEN) + radio.getTimeOnAir(SIG_LEN)) / 1000.0f / ((BATCH + 1) * (float)SLOT_MS);
  logf("planned duty: %d data + 1 sig per %d slots = %.2f%% of %.2f%%\n", BATCH, BATCH + 1, cycle, DUTY_LIMIT_PCT);
}

void pollTap() {                    // "PI <text>" from the Pi goes on the bottom line of the screen
  while (tap.available()) {
    char c = tap.read();
    tapRxBytes++;
    tapRaw += hex((uint8_t *)&c, 1);
    if (tapRaw.length() > 48) tapRaw = tapRaw.substring(tapRaw.length() - 48);
    if (c == '\n') {
      tapLine.trim();
      if (tapLine.startsWith("PI ")) { showText = tapLine.substring(3); logf("pi: %s\n", showText.c_str()); showBeacon(); }
      else if (tapLine.startsWith("BARO ")) {
        float pa = 0, c = 0;
        if (sscanf(tapLine.c_str() + 5, "%f %f", &pa, &c) == 2 && pa > 100 && pa < 120000) {   // sane range only
          piPa = pa; piC = c; piBaroMs = millis();
        }
      }
      else if (tapLine.startsWith("WIND ")) {
        unsigned long a, b, sp, dir, alt;
        if (sscanf(tapLine.c_str() + 5, "%lu %lu %lu %lu %lu", &a, &b, &sp, &dir, &alt) == 5 && b == a + 1 && sp < 30000 && dir < 3600) {
          windA = a; windB = b; windCms = sp; windDir10 = dir; windAlt = alt; windMs = millis();
        }
      }
      tapLine = "";
    } else if (c != '\r' && tapLine.length() < 64) tapLine += c;
  }
}

void loop() {
  pollCommands();
  pollTap();
  static uint32_t prgDown = 0;
  if (digitalRead(PRG_PIN) == LOW) { if (!prgDown) prgDown = millis(); }
  else if (prgDown) { if (millis() - prgDown > 50) { attackPending = true; logf("PRG: attack armed\n"); } prgDown = 0; }

  if (otaBusy) return;
  if (lastSlotMs && millis() - lastSlotMs < SLOT_MS) return;
  lastSlotMs = millis();
  if (batchCount == BATCH) sendSig(); else sendData();
  slot++;
  showBeacon();
}

// ---------------------------------------------------------------- ground ----
#elif ROLE == 2

uint32_t heard = 0, upSent = 0, lastSeq = 0;
bool ackAll = true;
uint8_t queued[UPLINK_LEN - 5];
bool haveQueued = false;
String lastRf = "rssi -- snr --", lastKind = "";
// The buyer: one voucher at a time, sent as a BUY in the next uplink window.
uint8_t buyFrame[BUY_LEN];
bool buyQueued = false;
uint32_t bought = 0;
// Any other frame for the next uplink window: an x402 REQ or PAY, or a SETTLED the ground
// station composed ("send"). Bytes 1..4 get the seq of the frame it answers.
uint8_t replyFrame[128];
size_t replyLen = 0;
const char *replyKind = "";
// The x402 client on the board: spending controls kept in flash, a clock set over USB (a
// flight would take it from GPS), and at most one request open.
uint32_t x402Max = 0, x402Budget = 0, x402Spent = 0, x402PayTo = 0, x402Buyer = 0;
uint32_t clockBase = 0, clockAtMs = 0;
bool x402Waiting = false;

void queueReply(const uint8_t *f, size_t n, const char *kind) { memcpy(replyFrame, f, n); replyLen = n; replyKind = kind; }

// A "402 Payment Required" from the beacon. Check it against the spending controls, then
// build the Hedera transfer it asks for and sign it here, on the board.
void handleOffer(const uint8_t *o) {
  uint32_t ch = get32(o + 1), amount = get32(o + 6), to = get32(o + 10), fp = get32(o + 14);
  const char *why = nullptr;
  if (!x402Waiting)                          why = "no request open";
  else if (!clockAtMs)                       why = "clock not set";
  else if (to != x402PayTo)                  why = "pay-to account is not on the allowlist";
  else if (amount > x402Max)                 why = "over the per-payment cap";
  else if (x402Spent + amount > x402Budget)  why = "over the budget";
  x402Waiting = false;
  if (why) { logf("{\"ev\":\"x402refused\",\"challenge\":\"%08lx\",\"amount\":%lu,\"why\":\"%s\"}\n", ch, amount, why); return; }
  uint32_t vs = clockBase + (millis() - clockAtMs) / 1000 - 5;   // a little in the past: nodes refuse a future start
  uint32_t vns = esp_random() % 1000000000UL;
  uint8_t body[128], f[PAY_LEN] = {0};
  size_t n = hederaBody(body, fp, vs, vns, x402Buyer, to, amount, ch);
  f[0] = MAGIC_PAY; put32(f + 5, ch); put32(f + 9, vs); put32(f + 13, vns);
  Ed25519::sign(f + 17, priv, pub, body, n);
  x402Spent += amount; prefs.putUInt("x402Spent", x402Spent);
  queueReply(f, PAY_LEN, "pay");
  logf("{\"ev\":\"x402pay\",\"challenge\":\"%08lx\",\"amount\":%lu,\"pay_to\":%lu,\"fee_payer\":%lu,\"payer\":%lu,\"valid_s\":%lu,\"valid_ns\":%lu,"
       "\"timeout\":%u,\"spent\":%lu,\"budget\":%lu,\"body\":\"%s\",\"sig\":\"%s\",\"pubkey\":\"%s\"}\n",
       ch, amount, to, fp, x402Buyer, vs, vns, get16(o + 18), x402Spent, x402Budget, hex(body, n).c_str(), hex(f + 17, 64).c_str(), hex(pub, 32).c_str());
}

void showGround() {
  screen({"GROUND " + lastKind,
          lastRf,
          "heard " + String(heard) + " up " + String(upSent) + " buy " + String(bought),
          "duty " + String(dutyPct(), 2) + "% of " + String(DUTY_LIMIT_PCT, 2) + "%",
          "wifi " + netIp(),
          showText});
}

bool handleCommand(const String &c) {
  if (c.startsWith("up ")) {
    memset(queued, 0, sizeof(queued));
    size_t n = unhex(c.substring(3), queued, sizeof(queued));
    haveQueued = true;
    logf("{\"ev\":\"queued\",\"bytes\":%u}\n", (unsigned)n);
  }
  else if (c.startsWith("buy ")) {
    // buy <price tinybar> <buyer account> <seller account>: sign a voucher with the next nonce
    unsigned long price, buyer, seller;
    if (sscanf(c.c_str() + 4, "%lu %lu %lu", &price, &buyer, &seller) != 3) { logf("{\"ev\":\"error\",\"cmd\":\"buy <price> <buyer> <seller>\"}\n"); return false; }
    uint32_t nonce = prefs.getUInt("nonce", 0) + 1;
    prefs.putUInt("nonce", nonce);           // spent now, so a reboot never signs the same nonce twice
    memset(buyFrame, 0, BUY_LEN);
    buyFrame[0] = MAGIC_BUY;
    put32(buyFrame + 5, nonce);
    buyFrame[9] = PRODUCT_WIND;
    put32(buyFrame + 10, price); put32(buyFrame + 14, buyer); put32(buyFrame + 18, seller);
    uint8_t msg[48];
    size_t m = tagged(msg, VOUCHER_TAG, buyFrame + VOUCHER_FROM, VOUCHER_SIGNED);
    Ed25519::sign(buyFrame + 22, priv, pub, msg, m);
    buyQueued = true;
    logf("{\"ev\":\"voucher\",\"nonce\":%lu,\"price\":%lu,\"buyer\":%lu,\"seller\":%lu}\n", nonce, price, buyer, seller);
  }
  else if (c == "pubkey") logf("{\"ev\":\"pubkey\",\"key\":\"%s\"}\n", hex(pub, 32).c_str());
  else if (c.startsWith("clock ")) { clockBase = strtoul(c.c_str() + 6, nullptr, 10); clockAtMs = millis(); logf("{\"ev\":\"clock\",\"unix\":%lu}\n", clockBase); }
  else if (c.startsWith("x402policy ")) {
    unsigned long mx, bud, to;
    if (sscanf(c.c_str() + 11, "%lu %lu %lu", &mx, &bud, &to) != 3) return false;
    x402Max = mx; x402Budget = bud; x402PayTo = to;
    prefs.putUInt("x402Max", mx); prefs.putUInt("x402Budget", bud); prefs.putUInt("x402PayTo", to);
    logf("{\"ev\":\"x402policy\",\"max\":%lu,\"budget\":%lu,\"spent\":%lu,\"pay_to\":%lu}\n", mx, bud, x402Spent, to);
  }
  else if (c.startsWith("x402req ")) {
    x402Buyer = strtoul(c.c_str() + 8, nullptr, 10);
    uint8_t f[REQ_LEN] = {0};
    f[0] = MAGIC_REQ; f[5] = PRODUCT_WIND; put32(f + 6, x402Buyer);
    queueReply(f, REQ_LEN, "req"); x402Waiting = true;
    logf("{\"ev\":\"x402req\",\"buyer\":%lu}\n", x402Buyer);
  }
  else if (c.startsWith("send ")) {
    uint8_t f[128];
    size_t n = unhex(c.substring(5), f, sizeof(f));
    if (n < 5) return false;
    queueReply(f, n, "send");
    logf("{\"ev\":\"queued\",\"kind\":\"send\",\"bytes\":%u}\n", (unsigned)n);
  }
  else if (c.startsWith("hsign ")) {
    // Sign a Hedera transaction body for this node's own account (setup: the allowance).
    // USB only, and never anything that starts like a voucher.
    static uint8_t body[400];
    size_t n = unhex(c.substring(6), body, sizeof(body));
    if (!cmdFromUsb || n == 0 || (n >= strlen(VOUCHER_TAG) && !memcmp(body, VOUCHER_TAG, strlen(VOUCHER_TAG)))) {
      logf("{\"ev\":\"hsign\",\"refused\":true}\n"); return false;
    }
    uint8_t sig[64];
    Ed25519::sign(sig, priv, pub, body, n);
    logf("{\"ev\":\"hsign\",\"len\":%u,\"sig\":\"%s\"}\n", (unsigned)n, hex(sig, 64).c_str());
  }
  else if (c == "ack on")  { ackAll = true;  logf("{\"ev\":\"ack\",\"on\":true}\n"); }
  else if (c == "ack off") { ackAll = false; logf("{\"ev\":\"ack\",\"on\":false}\n"); }
  else if (c.startsWith("show ")) { showText = c.substring(5); showGround(); }
  else if (c == "status") logf("{\"ev\":\"status\",\"heard\":%lu,\"up\":%lu,\"duty\":%.2f,\"ip\":\"%s\"}\n",
                               heard, upSent, dutyPct(), netIp().c_str());
  else { logf("{\"ev\":\"unknown\",\"cmd\":\"%s\"}\n", c.c_str()); return false; }
  return true;
}

void setup() {
  Serial.setRxBufferSize(1024);       // an hsign line is up to 806 characters
  Serial.begin(115200);
  delay(1000);
  oledUp();
  screen({"GROUND", "starting..."});
  logf("\nhab_node GROUND\n");
  loadKey();
  x402Max = prefs.getUInt("x402Max", 0); x402Budget = prefs.getUInt("x402Budget", 0);
  x402Spent = prefs.getUInt("x402Spent", 0); x402PayTo = prefs.getUInt("x402PayTo", 0);
  // The ground sits on USB next to the laptop. The iPhone hotspot accepted only three
  // devices (Mac, Pi, one Heltec; a fourth got ASSOC_TOOMANY), so the Wi-Fi slot is kept
  // for the beacon. Build with -DGROUND_WIFI to put the ground on Wi-Fi as well.
#ifdef GROUND_WIFI
  netBegin("hab-ground");
#else
  logf("wifi: off (USB is the ground link; build with -DGROUND_WIFI to enable)\n");
#endif
  radioUp();
  rxFlag = false;
  radio.startReceive();
  showGround();
}

void loop() {
  pollCommands();
  if (otaBusy || !rxFlag) return;
  rxFlag = false;
  uint32_t heardAt = millis();
  uint8_t buf[128];
  size_t n = radio.getPacketLength();
  int st = radio.readData(buf, min(n, sizeof(buf)));
  float rssi = radio.getRSSI(), snr = radio.getSNR(), fe = radio.getFrequencyError();
  heard++;
  lastRf = rf(rssi, snr);
  if (st == RADIOLIB_ERR_NONE && n >= 5) {
    memcpy(&lastSeq, buf + 1, 4);
    lastKind = buf[0] == MAGIC_DATA ? "data " + String(lastSeq) : buf[0] == MAGIC_SIG ? "sig " + String(lastSeq)
             : buf[0] == MAGIC_DELIVERY ? "WIND nonce " + String(lastSeq) : buf[0] == MAGIC_OFFER ? "402 offer" : "other";
  }
  logf("{\"ev\":\"rx\",\"ms\":%lu,\"st\":%d,\"len\":%u,\"rssi\":%.1f,\"snr\":%.1f,\"fe\":%.0f,\"hex\":\"%s\"}\n",
       heardAt, st, (unsigned)n, rssi, snr, fe, st == RADIOLIB_ERR_NONE ? hex(buf, min(n, sizeof(buf))).c_str() : "");

  if (st == RADIOLIB_ERR_NONE && n == OFFER_LEN && buf[0] == MAGIC_OFFER) handleOffer(buf);

  if (st == RADIOLIB_ERR_NONE && n == DATA_LEN && buf[0] == MAGIC_DATA && !buyQueued && replyLen) {
    // An x402 frame (or one the laptop composed) waiting: send it as this window's reply.
    while (millis() - heardAt < REPLY_DELAY_MS) pollCommands();
    memcpy(replyFrame + 1, buf + 1, 4);
    uint32_t txUs;
    int rst2 = sendGuarded(replyFrame, replyLen, &txUs);
    if (rst2 == RADIOLIB_ERR_NONE) upSent++;
    logf("{\"ev\":\"sent\",\"kind\":\"%s\",\"seq\":%lu,\"ok\":%s,\"hex\":\"%s\",\"duty\":%.2f}\n",
         replyKind, lastSeq, rst2 == RADIOLIB_ERR_NONE ? "true" : "false", hex(replyFrame, replyLen).c_str(), dutyPct());
    if (rst2 == RADIOLIB_ERR_NONE) replyLen = 0;
  }
  else if (st == RADIOLIB_ERR_NONE && n == DATA_LEN && buf[0] == MAGIC_DATA && buyQueued) {
    // A voucher waiting: send it as this window's BUY (it is also the ack).
    while (millis() - heardAt < REPLY_DELAY_MS) pollCommands();
    memcpy(buyFrame + 1, buf + 1, 4);
    uint32_t txUs;
    int bst = sendGuarded(buyFrame, BUY_LEN, &txUs);
    if (bst == RADIOLIB_ERR_NONE) { buyQueued = false; bought++; upSent++; }
    logf("{\"ev\":\"buy\",\"seq\":%lu,\"nonce\":%lu,\"ok\":%s,\"hex\":\"%s\",\"duty\":%.2f}\n",
         lastSeq, get32(buyFrame + 5), bst == RADIOLIB_ERR_NONE ? "true" : "false", hex(buyFrame, BUY_LEN).c_str(), dutyPct());
  }
  else if (st == RADIOLIB_ERR_NONE && n == DATA_LEN && buf[0] == MAGIC_DATA && (ackAll || haveQueued)) {
    while (millis() - heardAt < REPLY_DELAY_MS) pollCommands();
    uint8_t up[UPLINK_LEN] = {0};
    up[0] = MAGIC_UPLINK;
    memcpy(up + 1, buf + 1, 4);
    if (haveQueued) { memcpy(up + 5, queued, sizeof(queued)); haveQueued = false; }
    uint32_t txUs;
    int ust = sendGuarded(up, UPLINK_LEN, &txUs);
    if (ust == RADIOLIB_ERR_NONE) upSent++;
    logf("{\"ev\":\"up\",\"seq\":%lu,\"ok\":%s,\"payload\":\"%s\",\"duty\":%.2f}\n",
         lastSeq, ust == RADIOLIB_ERR_NONE ? "true" : "false", hex(up + 5, UPLINK_LEN - 5).c_str(), dutyPct());
  }
  showGround();
  rxFlag = false;
  radio.startReceive();
}

#else
#error "ROLE must be 1 or 2"
#endif
