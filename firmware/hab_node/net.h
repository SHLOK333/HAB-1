// Wi-Fi for the bench: join the phone hotspot, accept firmware over the air
// (ArduinoOTA), and mirror the log to one TCP client on port 2323, which can
// also send commands. The radio never waits on Wi-Fi: if the hotspot is gone,
// the node keeps beaconing or receiving and retries in the background.
#pragma once
#include <WiFi.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include "wifi_secrets.h"         // STA_SSID, STA_PASS, AP_PASS (git-ignored)

#define NET_PORT 2323

WiFiServer netServer(NET_PORT);
WiFiClient netClient;
bool netUp = false;
volatile bool otaBusy = false;
String netLine;

void logf(const char *fmt, ...) {
  char buf[1024];                     // the x402 payment line is about 600 characters
  va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof(buf), fmt, ap); va_end(ap);
  Serial.print(buf);
  if (netClient && netClient.connected()) netClient.print(buf);
}

String netIp() { return netUp ? WiFi.localIP().toString() : String("--"); }

// Why the last join attempt failed, logged at most every 5 s (the driver retries fast).
void onWifiEvent(arduino_event_id_t event, arduino_event_info_t info) {
  static uint32_t lastMs = 0;
  if (event != ARDUINO_EVENT_WIFI_STA_DISCONNECTED || millis() - lastMs < 5000) return;
  lastMs = millis();
  uint8_t r = info.wifi_sta_disconnected.reason;
  logf("wifi: join failed, reason %u (%s)\n", r, WiFi.disconnectReasonName((wifi_err_reason_t)r));
}

void netBegin(const char *host) {
  esp_log_level_set("wifi", ESP_LOG_NONE);   // the driver prints "Set status to INIT" on every retry
  WiFi.setHostname(host);                    // must come before mode() on core 3.x
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.onEvent(onWifiEvent);
  int n = WiFi.scanNetworks();               // about 2 s, once at boot: is the hotspot visible at all?
  int ch = -1, rssi = 0;
  for (int i = 0; i < n; i++) if (WiFi.SSID(i) == STA_SSID) { ch = WiFi.channel(i); rssi = WiFi.RSSI(i); }
  if (ch > 0) logf("wifi: hotspot seen, channel %d, %d dBm\n", ch, rssi);
  else        logf("wifi: hotspot NOT seen among %d networks (2.4 GHz only: is Maximize Compatibility on?)\n", n);
  WiFi.scanDelete();
  WiFi.begin(STA_SSID, STA_PASS);
  ArduinoOTA.setHostname(host);
  ArduinoOTA.setPassword(AP_PASS);
  ArduinoOTA.onStart([]() { otaBusy = true; logf("ota: update starting, radio paused\n"); });
  ArduinoOTA.onError([](ota_error_t e) { otaBusy = false; logf("ota: error %u\n", e); });
}

// Call often. Returns true and fills cmd when a full command line arrived over TCP.
bool netLoop(String &cmd) {
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !netUp) {
    netUp = true;
    ArduinoOTA.begin();
    MDNS.addService("hab", "tcp", NET_PORT);
    netServer.begin();
    logf("wifi: %s, ota and tcp %d ready\n", WiFi.localIP().toString().c_str(), NET_PORT);
  } else if (!connected && netUp) {
    netUp = false;
    logf("wifi: lost, retrying\n");
  }
  if (!netUp) return false;
  ArduinoOTA.handle();
  if (netServer.hasClient()) {
    if (netClient) netClient.stop();
    netClient = netServer.accept();
    netClient.printf("connected to %s\n", WiFi.getHostname());
  }
  while (netClient && netClient.available()) {
    char c = netClient.read();
    if (c == '\n') { cmd = netLine; cmd.trim(); netLine = ""; return true; }
    if (c != '\r' && netLine.length() < 200) netLine += c;
  }
  return false;
}
