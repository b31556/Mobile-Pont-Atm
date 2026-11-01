// Copy this file to config.h and fill it in. config.h is not committed, so your WiFi password stays private.
#pragma once

// The WiFi the reader joins (2.4 GHz only: the ESP32 does not do 5 GHz).
#define WIFI_SSID     "your-wifi-name"
#define WIFI_PASSWORD "your-wifi-password"

// The Pont server, with no trailing slash.
//  - https://your-host  (use this for a server on the internet): the reader checks the server's certificate against
//    the Let's Encrypt root in root_ca.h, and sets its clock from the internet first (it needs the date to check it).
//    The certificate must be a Let's Encrypt one with an RSA key.
//  - http://192.168.x.x:3000  only for a server on a network you trust: nothing is encrypted. Give that server a
//    fixed address in your router (a DHCP reservation) so this keeps working after a reboot.
#define SERVER_URL    "https://pont-atm.example.com"

// Pins (the defaults match the wiring in README.md). Change them only if you wire it differently.
// #define PIN_RFID_SS   5    // MFRC522 SDA / SS
// #define PIN_RFID_RST  22   // MFRC522 RST
// #define PIN_DISPLAY_CLK 16 // TM1637 CLK
// #define PIN_DISPLAY_DIO 17 // TM1637 DIO
// (SCK = 18, MISO = 19, MOSI = 23 are the ESP32's fixed SPI pins.)
