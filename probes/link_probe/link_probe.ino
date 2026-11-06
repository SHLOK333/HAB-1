// link_probe: bench probe for the two-way link and on-board signing.
//
// One sketch, two roles, chosen at compile time:
//   -DROLE=1  beacon: sends a 28-byte frame every 12 s, then opens a receive window
//   -DROLE=2  ground: hears the frame, waits REPLY_DELAY_MS, sends a 32-byte uplink
//
// What it measures (every line is a measurement, not an estimate):
//   - Ed25519 keygen / sign / verify time on the ESP32-S3 (beacon, at boot)
//   - time on air of both frames, and the duty cycle each node uses
//   - whether the uplink lands inside the beacon's window, its RSSI and SNR,
//     and the delay from the end of the beacon frame to the uplink arriving
//   - the beacon's real period, so we see if the window ever delays it
//
// How to break it on purpose (the probe must report the failure):
//   type  d1500  into the ground's serial monitor: the reply now arrives after
//   the 1000 ms window closes, and the beacon must print "up NONE".
//   type  d50    to restore. type  x  to stop replies, x again to resume.
//
// Radio settings copy hab1_tx (866.1 MHz, SF9, BW125, CR 4/5, sync 0x34,
// preamble 8, TCXO 1.8 V). Power is fixed low for a 10 m bench, not the
// flight APC: at 10 m free-space loss is about 51 dB (computed), so 0 dBm with
// two 3 dBi ducks lands near -45 dBm.

#include <RadioLib.h>
#include <SPI.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Ed25519.h>
#include <esp_random.h>

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
#define SEND_EVERY_MS   12000
#define WINDOW_MS       1000
#define DUTY_LIMIT_PCT  2.50f       // G.S.R. 853(E) Table II

#define BEACON_LEN      28
#define UPLINK_LEN      32
#define MAGIC_BEACON    0xB1
#define MAGIC_UPLINK    0xD1

// Heltec V3 on-board OLED, wired as in hab1_tx
#define OLED_SDA 17
#define OLED_SCL 18
#define OLED_RST 21
#define VEXT     36             // LOW powers the OLED

SPIClass    spiLoRa(HSPI);
SPISettings spiCfg(2000000, MSBFIRST, SPI_MODE0);
SX1262 radio = new Module(8, 14, 12, 13, spiLoRa, spiCfg);

volatile bool rxFlag = false;
void IRAM_ATTR onRx() { rxFlag = true; }

uint32_t airtimeUs  = 0;          // this node's total time on air since boot
uint32_t bootMs     = 0;
uint32_t firstTxMs  = 0;          // start of this node's first transmission

// Airtime over the whole 12 s cycles since the first transmission (the cycle in
// progress counts as a full cycle), so the figure is right from the first frame
// instead of being inflated by boot time.
float dutyPct() {
  if (!firstTxMs) return 0;
  uint32_t cycles = (millis() - firstTxMs) / SEND_EVERY_MS + 1;
  return 100.0f * (airtimeUs / 1000.0f) / (cycles * (float)SEND_EVERY_MS);
}

Adafruit_SSD1306 display(128, 64, &Wire, OLED_RST);
bool oledOk = false;

void oledUp() {
  pinMode(VEXT, OUTPUT); digitalWrite(VEXT, LOW); delay(50);
  Wire.begin(OLED_SDA, OLED_SCL);
  pinMode(OLED_RST, OUTPUT);
  digitalWrite(OLED_RST, LOW); delay(20); digitalWrite(OLED_RST, HIGH); delay(20);
  oledOk = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!oledOk) { Serial.println("oled init failed"); return; }
  display.setTextColor(SSD1306_WHITE); display.setTextSize(1);
}

// Up to seven lines of at most 21 characters each (longer lines wrap and push the rest down).
void screen(const String &a, const String &b, const String &c = "", const String &d = "",
            const String &e = "", const String &f = "", const String &g = "") {
  if (!oledOk) return;
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println(a); display.println(b); display.println(c); display.println(d);
  display.println(e); display.println(f); display.println(g);
  display.display();
}

String linkLine(float rssi, float snr) {   // "rssi -49 snr 11.0 dB", 20 characters
  return "rssi " + String(rssi, 0) + " snr " + String(snr, 1) + " dB";
}

int sendTimed(uint8_t *buf, size_t len, uint32_t *txUs) {
  if (!firstTxMs) firstTxMs = millis();
  uint32_t t0 = micros();
  int st = radio.transmit(buf, len);
  *txUs = micros() - t0;
  if (st == RADIOLIB_ERR_NONE) airtimeUs += radio.getTimeOnAir(len);
  return st;
}

void radioUp() {
  spiLoRa.begin(9, 11, 10, 8);
  int st = radio.begin(FREQ_MHZ, LORA_BW, LORA_SF, LORA_CR, LORA_SYNC, TX_DBM, LORA_PREAMBLE, TCXO_V);
  if (st != RADIOLIB_ERR_NONE) {
    Serial.printf("radio.begin failed: %d\n", st);
    while (true) delay(1000);
  }
  radio.setCRC(true);
  radio.setPacketReceivedAction(onRx);
  Serial.printf("radio ok: %.1f MHz SF%d BW%.0f CR4/%d %d dBm\n",
                FREQ_MHZ, LORA_SF, LORA_BW, LORA_CR, TX_DBM);
  Serial.printf("time on air: beacon %u bytes %.1f ms, uplink %u bytes %.1f ms\n",
                BEACON_LEN, radio.getTimeOnAir(BEACON_LEN) / 1000.0f,
                UPLINK_LEN, radio.getTimeOnAir(UPLINK_LEN) / 1000.0f);
}

// ---------------------------------------------------------------- beacon ----
#if ROLE == 1

uint8_t priv[32], pub[32];
float signMs = 0;                 // measured at boot, shown on the OLED
bool  sigChecksOk = false;        // 10/10 valid and the tampered batch rejected

void benchSigning() {
  esp_fill_random(priv, sizeof(priv));
  uint32_t t0 = micros();
  Ed25519::derivePublicKey(pub, priv);
  uint32_t keyUs = micros() - t0;

  uint8_t msg[6 * BEACON_LEN], sig[64];   // one signature over a batch of 6 frames
  esp_fill_random(msg, sizeof(msg));
  uint32_t signMin = UINT32_MAX, signMax = 0, verMin = UINT32_MAX, verMax = 0;
  bool allOk = true;
  for (int i = 0; i < 10; i++) {
    t0 = micros(); Ed25519::sign(sig, priv, pub, msg, sizeof(msg)); uint32_t s = micros() - t0;
    t0 = micros(); bool ok = Ed25519::verify(sig, pub, msg, sizeof(msg)); uint32_t v = micros() - t0;
    allOk &= ok;
    signMin = min(signMin, s); signMax = max(signMax, s);
    verMin  = min(verMin, v);  verMax  = max(verMax, v);
  }
  msg[0] ^= 0x01;                         // a flipped bit must fail verification
  bool tamperCaught = !Ed25519::verify(sig, pub, msg, sizeof(msg));
  Serial.printf("ed25519 %u-byte batch: pubkey %.1f ms, sign %.1f to %.1f ms, verify %.1f to %.1f ms, "
                "10/10 valid %s, tampered rejected %s\n",
                (unsigned)sizeof(msg), keyUs / 1000.0f, signMin / 1000.0f, signMax / 1000.0f,
                verMin / 1000.0f, verMax / 1000.0f, allOk ? "yes" : "NO", tamperCaught ? "yes" : "NO");
  signMs = signMax / 1000.0f;
  sigChecksOk = allOk && tamperCaught;
}

uint32_t seq = 0, lastTxStart = 0, upOk = 0, upNone = 0, upBad = 0;

void showBeacon(uint32_t period, float txMs, const String &upLine, const String &rfLine) {
  screen("PROBE TX  seq " + String(seq),
         "tx " + String(txMs, 0) + "ms per " + String(period) + "ms",
         upLine,
         rfLine,
         "ok " + String(upOk) + " none " + String(upNone) + " bad " + String(upBad),
         "duty " + String(dutyPct(), 2) + "% of " + String(DUTY_LIMIT_PCT, 2) + "%",
         "sign " + String(signMs, 1) + "ms " + (sigChecksOk ? "checks ok" : "CHECK FAIL"));
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  bootMs = millis();
  Serial.println("\nlink_probe BEACON");
  oledUp();
  screen("PROBE TX", "signing benchmark...");
  benchSigning();
  radioUp();
  screen("PROBE TX", "866.1 SF9 BW125", String(TX_DBM) + " dBm",
         "sign " + String(signMs, 1) + "ms " + (sigChecksOk ? "checks ok" : "CHECK FAIL"),
         "first frame now");
}

void loop() {
  if (lastTxStart && millis() - lastTxStart < SEND_EVERY_MS) return;

  uint8_t frame[BEACON_LEN] = {0};
  frame[0] = MAGIC_BEACON;
  memcpy(frame + 1, &seq, 4);
  uint32_t start = millis();
  uint32_t period = lastTxStart ? start - lastTxStart : 0;
  lastTxStart = start;

  uint32_t txUs;
  int st = sendTimed(frame, sizeof(frame), &txUs);
  uint32_t txEnd = millis();
  if (st != RADIOLIB_ERR_NONE) { Serial.printf("seq %lu tx failed %d\n", seq, st); seq++; return; }

  rxFlag = false;
  radio.startReceive();
  bool got = false;
  while (millis() - txEnd < WINDOW_MS) { if (rxFlag) { got = true; break; } }
  uint32_t dt = millis() - txEnd;

  if (got) {
    uint8_t up[64];
    size_t n = radio.getPacketLength();
    int rst = radio.readData(up, min(n, sizeof(up)));
    uint32_t echo; memcpy(&echo, up + 1, 4);
    if (rst == RADIOLIB_ERR_NONE && n == UPLINK_LEN && up[0] == MAGIC_UPLINK && echo == seq) {
      upOk++;
      float rssi = radio.getRSSI(), snr = radio.getSNR();
      Serial.printf("seq %lu period %lu ms tx %.1f ms | up OK after %lu ms rssi %.1f snr %.1f | ok %lu none %lu bad %lu | duty %.2f%% of %.2f%%\n",
                    seq, period, txUs / 1000.0f, dt, rssi, snr,
                    upOk, upNone, upBad, dutyPct(), DUTY_LIMIT_PCT);
      showBeacon(period, txUs / 1000.0f, "UP OK in " + String(dt) + "ms", linkLine(rssi, snr));
    } else {
      upBad++;
      Serial.printf("seq %lu | up BAD (st %d, len %u, magic 0x%02X, echo %lu) | ok %lu none %lu bad %lu\n",
                    seq, rst, (unsigned)n, up[0], echo, upOk, upNone, upBad);
      showBeacon(period, txUs / 1000.0f, "UP BAD len " + String((unsigned)n),
                 linkLine(radio.getRSSI(), radio.getSNR()));
    }
  } else {
    upNone++;
    Serial.printf("seq %lu period %lu ms tx %.1f ms | up NONE in %d ms | ok %lu none %lu bad %lu | duty %.2f%% of %.2f%%\n",
                  seq, period, txUs / 1000.0f, WINDOW_MS, upOk, upNone, upBad, dutyPct(), DUTY_LIMIT_PCT);
    showBeacon(period, txUs / 1000.0f, "UP NONE in " + String(WINDOW_MS) + "ms", "rssi -- snr --");
  }
  radio.standby();
  seq++;
}

// ---------------------------------------------------------------- ground ----
#elif ROLE == 2

uint32_t replyDelayMs = 50;
bool replies = true;
uint32_t heard = 0, sent = 0;

void setup() {
  Serial.begin(115200);
  delay(1500);
  bootMs = millis();
  Serial.println("\nlink_probe GROUND  (commands: d<ms> reply delay, x toggle replies)");
  oledUp();
  radioUp();
  screen("PROBE RX", "866.1 SF9 BW125", String(TX_DBM) + " dBm", "waiting for beacon");
  rxFlag = false;
  radio.startReceive();
}

void pollSerial() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n'); cmd.trim();
  if (cmd.startsWith("d")) { replyDelayMs = cmd.substring(1).toInt(); Serial.printf("reply delay now %lu ms\n", replyDelayMs); }
  else if (cmd == "x")     { replies = !replies; Serial.printf("replies %s\n", replies ? "ON" : "OFF"); }
}

void loop() {
  pollSerial();
  if (!rxFlag) return;
  rxFlag = false;
  uint32_t heardAt = millis();

  uint8_t buf[64];
  size_t n = radio.getPacketLength();
  int st = radio.readData(buf, min(n, sizeof(buf)));
  float rssi = radio.getRSSI(), snr = radio.getSNR();
  if (st != RADIOLIB_ERR_NONE || n != BEACON_LEN || buf[0] != MAGIC_BEACON) {
    Serial.printf("ignored packet: st %d len %u magic 0x%02X\n", st, (unsigned)n, buf[0]);
    radio.startReceive();
    return;
  }
  uint32_t seq; memcpy(&seq, buf + 1, 4);
  heard++;

  if (replies) {
    while (millis() - heardAt < replyDelayMs) pollSerial();
    uint8_t up[UPLINK_LEN] = {0};
    up[0] = MAGIC_UPLINK;
    memcpy(up + 1, &seq, 4);
    uint32_t txUs;
    int tst = sendTimed(up, sizeof(up), &txUs);
    if (tst == RADIOLIB_ERR_NONE) sent++;
    Serial.printf("heard seq %lu rssi %.1f snr %.1f | reply after %lu ms, tx %.1f ms %s | heard %lu sent %lu | duty %.2f%% of %.2f%%\n",
                  seq, rssi, snr, replyDelayMs, txUs / 1000.0f, tst == RADIOLIB_ERR_NONE ? "ok" : "FAILED",
                  heard, sent, dutyPct(), DUTY_LIMIT_PCT);
    screen("PROBE RX  seq " + String(seq), linkLine(rssi, snr),
           "heard " + String(heard) + " sent " + String(sent),
           "reply after " + String(replyDelayMs) + "ms " + (tst == RADIOLIB_ERR_NONE ? "ok" : "FAIL"),
           "duty " + String(dutyPct(), 2) + "% of " + String(DUTY_LIMIT_PCT, 2) + "%");
  } else {
    Serial.printf("heard seq %lu rssi %.1f snr %.1f | replies OFF | heard %lu\n", seq, rssi, snr, heard);
    screen("PROBE RX  seq " + String(seq), linkLine(rssi, snr),
           "heard " + String(heard), "replies OFF");
  }
  rxFlag = false;
  radio.startReceive();
}

#else
#error "ROLE must be 1 or 2"
#endif
