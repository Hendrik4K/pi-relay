# Pi Relay <a href="README.en.md"><img align="right" src="docs/screenshots/flag-gb.svg" height="22" alt="English" title="English"></a><a href="README.md"><img align="right" src="docs/screenshots/flag-de.svg" height="22" alt="Deutsch" title="Deutsch"></a><img align="right" src="docs/screenshots/sprache.svg" height="22" alt="Sprache" title="Sprache wählen">

**Gebaut für den Headless-Zugriff auf deinen Raspberry Pi: Du steuerst ihn vom Windows-Desktop aus, in einem kleinen Viewer-Fenster, ohne offene VNC-Ports und mit eingebauten Updates.**

Die Anleitung passt auf einen Bierdeckel: herunterladen, SSH-Schlüssel angeben (gern auch deinen YubiKey, der Pi steht auf Hardware), einmal bestätigen. Ab dann klopft Pi Relay bei Bedarf per SSH-Tunnel an und du arbeitest auf dem Pi, als stünde er neben dir. Mit eingebauter FPS-Anzeige, falls du deinem Pi beim Schwitzen zusehen willst.

<p align="center"><img src="docs/screenshots/taskleiste.png" width="420" alt="Pi Relay im Windows-Infobereich"></p>

<p align="center"><img src="docs/screenshots/fenster-ablauf.gif" width="820" alt="Pi-Bildschirm schließen und über das Himbeer-Symbol in der Taskleiste wieder öffnen"></p>

<p align="center"><img src="docs/screenshots/tray-ablauf.gif" width="820" alt="Pi Relay: Klick auf das Himbeer-Symbol in der Taskleiste, Menü und Managementzentrale"></p>

<p align="center"><img src="docs/screenshots/menues.gif" width="460" alt="Pi Relay: Managementzentrale, Pi-Bildschirm und Einstellungen"></p>

<details>
<summary><b>💡 Was es kann</b></summary>

Pi Relay ist eine unkomplizierte Brücke zu deinem Raspberry Pi ohne Monitor. Du kannst zu 100 % auf HDMI-Kabel verzichten und hast trotzdem einen smarten, flüssigen Zugriff auf deinen Pi.

- **Der Pi-Bildschirm im eigenen Fenster.** Dafür gibt es ein extra Fenster, in dem du den Pi siehst und bedienst wie einen zweiten Bildschirm. Wir haben uns für VNC entschieden (mit eingebautem noVNC), weil das solide und bewährt ist. Alles läuft durch deine SSH-Verbindung, im Heimnetz ist kein VNC-Port offen. Den Viewer aktualisierst du selbst mit einem Klick, damit du nicht auf alten Sicherheitslücken sitzen bleibst.
- **Bildschirm und Terminal mit einem Klick.** In der Pi-Relay-Managementzentrale findest du neben deinem Zugang zwei Knöpfe: Das Bildschirm-Symbol öffnet den Pi-Desktop, der Terminal-Knopf rechts daneben (`>_`) öffnet ein echtes Terminal, in dem du per SSH direkt auf deinem Pi schreibst.
- **Deine KI-Agenten direkt auf dem Pi.** Codex (ChatGPT) oder Claude bekommen einen leichten SSH-Zugang, damit du von Windows aus mit KI-Agenten auf dem Pi arbeiten kannst. Du gibst pro Agent einen Projektordner frei. Lesen geht, Dateien ändern und Befehle ausführen bleiben aus, bis du sie einzeln anknipst.
- **Schlüssel im Griff.** Den Speicherort deiner SSH-Schlüssel verwaltest du direkt in der App, YubiKey & Co. funktionieren.
- **Eigene Bilder.** Fahr mit der Maus über den Pi, Codex oder Claude und bleib etwa 5 Sekunden dort: Es bildet sich ein Kreis, dann klickst du auf „PNG ändern“ und setzt dein eigenes Bild ein.
- **Alles dezent und Plug & Play.** Pi Relay wartet unauffällig unten in der Taskleiste und ist mit einem Klick da.

Warum es das gibt: Ich hatte genau dieses Problem und keine fertige Lösung dafür gefunden. Also habe ich sie gebaut und stelle sie jetzt allen zur Verfügung.

</details>

<details>
<summary><b>🧰 Voraussetzungen</b></summary>

Pi Relay läuft mit der folgenden Software. Hier siehst du, was du wo brauchst. Standardmäßig ist alles Nötige schon dabei, du kannst aber auch einen anderen VNC-Server oder -Viewer nehmen.

**Auf Windows:** Windows 10 oder 11 (64 Bit). WebView2 und der SSH-Client sind bei aktuellen Windows-Versionen schon dabei. Den Viewer (noVNC) bringt Pi Relay selbst mit.

**Auf dem Pi:** SSH und Python 3 (beides ist bei Raspberry Pi OS an Bord).

**Die Verbindung zum Pi** richtest du einmal in deiner SSH-Konfiguration ein (`~/.ssh/config` auf Windows), zum Beispiel:

```
Host MeinPi
  HostName 192.168.1.50
  User pi
```

Pi Relay zeigt jeden solchen Eintrag als Zugang an. Es liest nur deine öffentlichen Schlüssel, private Schlüssel fasst es nicht an und es erzeugt auch keine neuen.

**Für den Pi-Bildschirm** braucht der Pi ein Programm, das seinen Desktop zeigt (einen VNC-Server). Wichtig: Der darf **nur auf dem Pi selbst** lauschen (`127.0.0.1:5900`), nicht im ganzen Heimnetz. Pi Relay holt das Bild dann sicher durch die SSH-Leitung. Drei bewährte Varianten:

**TigerVNC** (unsere Empfehlung, auf dem Pi 5 rund 45 statt 5 Bilder pro Sekunde wie bei x11vnc). Paket `tigervnc-scraping-server`, in den Autostart deines Benutzers:

```bash
X0tigervnc -display :0 -rfbport 5900 -localhost -SecurityTypes None -AlwaysShared -AcceptSetDesktopSize=0
```

**x11vnc** (X11-Desktop, z. B. Cinnamon), ebenfalls im Autostart:

```bash
x11vnc -localhost -rfbport 5900 -forever -shared -nopw -quiet -noxdamage
```

**WayVNC** (Wayland, z. B. labwc), in `/etc/wayvnc/config`:

```ini
use_relative_paths=true
address=127.0.0.1
enable_auth=false
```

**Kurz erklärt:** `-localhost` bzw. `address=127.0.0.1` heißt „nur auf dem Pi selbst erreichbar“. Das ist Pflicht, weil hier kein VNC-Passwort gesetzt ist. Im Bildschirmfenster ist Qualität 7 der Sweetspot (der grüne Punkt am Regler).

<details>
<summary>🆘 <b>Notfalltipps:</b> Passwort, Firewall-Regel und was nach einem Pi-Neustart passiert</summary>

Aus dem Netzwerk kommt niemand an den VNC-Server, nur Windows über deine SSH-Verbindung. Programme oder andere Benutzer **auf dem Pi selbst** kämen aber dran. Nutzt du den Pi allein, ist das okay. Sonst setz ein VNC-Passwort (WayVNC `enable_auth=true`, x11vnc `-rfbauth`): Pi Relay fragt es im Fenster ab und merkt es sich nur, solange die App läuft. Außerdem verbindet Pi Relay nur, wenn Port 5900 deinem eigenen Benutzer oder root gehört. Ein fremdes Programm, das sich vordrängelt, bekommt also weder Tastatur noch Zwischenablage.

Statt Passwort geht auch eine Firewall-Regel (nftables), die den Port nur für deinen Desktop-Benutzer öffnet. `1000` durch dessen Benutzernummer (UID) ersetzen, laden mit `sudo nft -f vnc-schutz.nft`, dauerhaft über `/etc/nftables.conf`:

```
table inet vnc_schutz {
  chain ausgang {
    type filter hook output priority 0; policy accept;
    oifname "lo" tcp dport 5900 meta skuid != { 1000, 0 } reject with tcp reset
  }
}
```

Startet der Pi gerade neu, wartet Pi Relay geduldig: Klickst du auf „Verbinden“, verbindet es genau einmal, sobald der Pi wieder antwortet (bis zu 3 Minuten). Braucht der VNC-Server nach dem Hochfahren noch etwas, probiert es der Viewer bis zu 2 Minuten weiter. Nach deinem Sicherheitsschlüssel fragt es dabei nie ungefragt.

Ein zweiter Zugang namens `Ersatzzugang` (z. B. mit einem Ersatzschlüssel) wird als einklappbarer Ersatz unter dem ersten angezeigt.

</details>

</details>

<details>
<summary><b>🚀 Schnellstart</b></summary>

1. Den Installer unter **Releases** (rechts) herunterladen und starten. Er installiert nur für dich, ohne Adminrechte. Meldet Windows SmartScreen „Der Computer wurde durch Windows geschützt“: **Weitere Informationen → Trotzdem ausführen** (der Installer ist nicht code-signiert).
2. Deinen Pi wie unter **Voraussetzungen** in die SSH-Konfiguration eintragen.
3. Auf die Himbeere unten rechts in der Taskleiste klicken, deinen Zugang anklicken und den Sicherheitsschlüssel bestätigen.
4. Bildschirm-Symbol für den Pi-Desktop, `>_` für das Terminal. Fertig.

**Selbst bauen (für Bastler):** Du brauchst das .NET 10 SDK, Node.js 22 oder neuer und für den Installer Inno Setup 6. Dann im Projektordner:

```bash
npm ci
powershell -ExecutionPolicy Bypass -File build-windows.ps1
powershell -ExecutionPolicy Bypass -File scripts/run-checks.ps1
powershell -ExecutionPolicy Bypass -File build-installer.ps1
```

</details>

<details>
<summary><b>🔒 Sicherheit in Kürze</b></summary>

- Kein Netzwerkdienst auf dem Pi: Der Worker (`native/remote_worker.py`) läuft nur für die Dauer der SSH-Sitzung.
- Der VNC-Tunnel kennt genau ein festes Ziel (`127.0.0.1:5900`), keine frei wählbare Adresse.
- Agenten-Dateizugriffe sind auf den freigegebenen Ordner begrenzt; `/` ist als Projektordner gesperrt, der Home-Ordner (und jeder Ordner darüber) nur zum Lesen, und auch dann bleiben die versteckten Ordner darin zu. Versteckte Ordner wie `~/.config` (Autostart!) gibt es mit Schreibrecht nur zusammen mit Befehlen. Ohne Befehlsrecht sind versteckte Dateien und Ordner (z. B. `.git/`, `.bashrc`) sowie ausführbare und mehrfach verlinkte Dateien gesperrt. Schlüssel, Zugangsdaten und Verläufe (`~/.ssh`, `~/.gnupg`, `~/.codex`, `~/.claude`, `.git-credentials`, Shell-Verläufe, Browser-Profile) sind für Agenten nie lesbar. Schreibrechte bleiben trotzdem mächtig, etwa für Build-Skripte im Ordner. Freigegebene **Shell-Befehle** haben die Rechte des Linux-Benutzers; für echte Trennung einen eigenen eingeschränkten Pi-Benutzer verwenden.
- Der MCP-Server ist eine lokale Named Pipe nur für den aktuellen Windows-Benutzer; eine gleichnamige Pipe eines anderen Kontos wird abgelehnt.
- Der lokale Port für einen externen Viewer (RealVNC/TigerVNC) bedient nur den Viewer, den Pi Relay selbst gestartet hat, und nur unter dem eigenen Windows-Konto.
- Die SSH-Verbindung von Pi Relay übernimmt keine Weiterleitungen aus der ssh-config (Agent, X11, Ports, LocalCommand).
- „Zwischenablage teilen“ wirkt in beide Richtungen nur, solange das Bildschirmfenster vorne ist; ein Neuverbinden im Hintergrund überträgt nichts. Windows-Text geht beim Wechsel ins Fenster an den Pi (bis 1 MiB), außer Inhalten, die Passwortmanager als vertraulich markieren (die nur über „An Pi“). Text vom Pi kommt ohne Steuer- und Richtungszeichen und ohne abschließenden Zeilenumbruch an, damit nichts beim Einfügen in eine Konsole von selbst ausgeführt wird. Beide Richtungen lassen sich in den Einstellungen abschalten.
- Ein Neustart oder eine Aktivierung bei offenen SSH-Verbindungen fragt vorher nach.
- Die Oberfläche läuft mit strikter Content-Security-Policy, Downloads und Berechtigungen (außer dem Mikrofon im Bildschirmfenster) sind gesperrt. Der Installer installiert nur innerhalb des Benutzerprofils.
- noVNC-Updates übernimmt Pi Relay frühestens 14 Tage nach Veröffentlichung, ohne Installationsskripte und mit npm-Signaturprüfung.
- Übergroße oder unerwartete Antworten des Pi beenden nur die einzelne Anfrage, nicht die Verbindung oder die App.

</details>

<details>
<summary><b>🖼️ Bilder und Marken</b></summary>

Die beiden Tierchen für Codex und Claude sind in dieser Version eigens nachgezeichnete Stellvertreter. Wenn du lieber andere Bilder willst, tauschst du sie in der App über „PNG ändern“ gegen deine eigenen aus.

Der Quellcode steht unter der [MIT-Lizenz](LICENSE). Die Figuren, das Gehäusebild und die Icons gehören **nicht** dazu. Raspberry Pi, Claude/Anthropic, Codex/OpenAI, RealVNC und weitere Namen sind Marken ihrer Inhaber. Pi Relay ist ein privates Hobbyprojekt und mit keinem dieser Unternehmen verbunden. Details und Fremdsoftware (noVNC, MPL-2.0) siehe [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

</details>
