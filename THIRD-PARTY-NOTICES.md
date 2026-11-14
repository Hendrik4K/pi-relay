# Fremdsoftware in Pi Relay

## noVNC 1.7.0 (integrierter Pi-Bildschirm)

- Zweck: VNC/RFB-Client des integrierten Viewers. Läuft ausschließlich lokal im Pi-Relay-Bildschirmfenster (WebView2). Die Dateien werden mit Pi Relay ausgeliefert; es gibt keinen CDN-Abruf zur Laufzeit.
- Herkunft: npm-Paket `@novnc/novnc` 1.7.0, Projekt https://github.com/novnc/noVNC
- Lizenz: Mozilla Public License 2.0 (`licenses/noVNC-LICENSE.txt`, `licenses/MPL-2.0.txt`). Pi Relay verwendet die noVNC-Kerndateien unverändert; der Quellcode dieser Version ist im genannten Projekt und im npm-Paket öffentlich verfügbar.
- Enthält pako (zlib-Portierung), MIT-Lizenz, Copyright (C) 2014-2016 Vitaly Puzrin and Andrei Tuputcyn (`licenses/pako-LICENSE.txt`).

## Weitere Oberflächen-Bibliotheken

React und React DOM (MIT), xterm.js mit Fit-Addon (MIT) und Phosphor Icons für React (MIT) sind in der Oberfläche gebündelt.

## Externe Viewer

RealVNC Viewer und TigerVNC Viewer sind **nicht** Bestandteil von Pi Relay. Sie bleiben optionale, ausdrücklich gewählte Rückfall-Anwendungen mit eigenen Lizenzen und eigener Updateverwaltung. Der integrierte Viewer wird ausschließlich mit Pi Relay aktualisiert.

## Bilder und Marken / Pictures and trademarks

Die Figuren, das Gehäusebild, die Beere und die App-Icons (`public/assets`, `native/Assets`) fallen **nicht** unter die MIT-Lizenz des Quellcodes. Sie dienen nur der Darstellung in dieser privaten, nicht kommerziellen App. Raspberry Pi, Argon, Claude/Anthropic, Codex/OpenAI, RealVNC und TigerVNC sind Marken ihrer jeweiligen Inhaber; Pi Relay ist mit keinem dieser Unternehmen verbunden und wird von ihnen weder unterstützt noch geprüft. Rechteinhaber, die eine Entfernung wünschen, erreichen das Projekt über die Issues des Repositorys. Über „Icon ändern“ lässt sich jedes Bild durch ein eigenes ersetzen.

The companion figures, case picture, berry and app icons are **not** covered by the MIT license of the source code. Raspberry Pi, Argon, Claude/Anthropic, Codex/OpenAI, RealVNC and TigerVNC are trademarks of their respective owners; Pi Relay is not affiliated with, endorsed or reviewed by any of them. Rights holders who want a picture removed can open an issue.
