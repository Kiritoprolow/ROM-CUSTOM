// ESP32-CAM (AI Thinker) firmware
// Streams JPEG frames over secure WebSocket (wss://) to the surveillance
// server with x-api-key authentication. WiFi auto-reconnects on drop.

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include "esp_camera.h"

// ================== USER CONFIG ==================
const char *WIFI_SSID = "YOUR_WIFI_SSID";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Hugging Face Space host (no scheme), e.g. "username-spacename.hf.space"
const char *WS_HOST = "your-space.hf.space";
const uint16_t WS_PORT = 443;
const char *WS_PATH = "/esp32stream";
const char *API_KEY = "YOUR_API_KEY";

const unsigned long FRAME_INTERVAL_MS = 100; // ~10 FPS
// =================================================

// AI Thinker ESP32-CAM pin map
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

WebSocketsClient webSocket;
bool wsConnected = false;
unsigned long lastFrameAt = 0;
unsigned long lastWifiCheckAt = 0;

void onWebSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      wsConnected = true;
      Serial.println("[WS] Connected");
      break;
    case WStype_DISCONNECTED:
      wsConnected = false;
      Serial.println("[WS] Disconnected");
      break;
    case WStype_ERROR:
      wsConnected = false;
      Serial.println("[WS] Error");
      break;
    default:
      break;
  }
}

bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA; // 640x480
    config.jpeg_quality = 12;
    config.fb_count = 2;
    config.grab_mode = CAMERA_GRAB_LATEST;
  } else {
    config.frame_size = FRAMESIZE_QVGA; // 320x240
    config.jpeg_quality = 15;
    config.fb_count = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAM] Init failed: 0x%x\n", err);
    return false;
  }
  Serial.println("[CAM] Initialized");
  return true;
}

void connectWiFi() {
  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WiFi] Connected, IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("[WiFi] Connect timeout, will keep retrying");
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n=== ESP32-CAM Surveillance Firmware ===");

  if (!initCamera()) {
    Serial.println("[CAM] Restarting in 5s...");
    delay(5000);
    ESP.restart();
  }

  connectWiFi();

  // Secure WebSocket with SSL (wss://) + API key header
  String headers = String("x-api-key: ") + API_KEY;
  webSocket.beginSSL(WS_HOST, WS_PORT, WS_PATH);
  webSocket.setExtraHeaders(headers.c_str());
  webSocket.onEvent(onWebSocketEvent);
  webSocket.setReconnectInterval(3000);
  webSocket.enableHeartbeat(15000, 3000, 2);
}

void loop() {
  // WiFi watchdog: force reconnect if dropped
  if (millis() - lastWifiCheckAt > 5000) {
    lastWifiCheckAt = millis();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[WiFi] Lost connection, reconnecting...");
      WiFi.disconnect();
      WiFi.reconnect();
    }
  }

  webSocket.loop();

  if (wsConnected && WiFi.status() == WL_CONNECTED &&
      millis() - lastFrameAt >= FRAME_INTERVAL_MS) {
    lastFrameAt = millis();
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("[CAM] Capture failed");
      return;
    }
    if (fb->format == PIXFORMAT_JPEG && fb->len > 0) {
      webSocket.sendBIN(fb->buf, fb->len);
    }
    esp_camera_fb_return(fb);
  }
}
