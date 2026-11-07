# VGN-Pendler – iOS-Widget

Ein Homescreen-Widget für iPhone/iPad, das dir die aktuellen VGN-Verbindungen für deinen Arbeitsweg zeigt:

- **Richtung nach Standort:** Bist du an der Arbeit (Pommernstraße 10, Nürnberg), zeigt es die Fahrten nach Hause.
  Bist du zu Hause (Wildbirnenweg 61, Schwabach), zeigt es die Fahrten zur Arbeit. Ein 📍 vor der Uhrzeit zeigt an,
  dass der Standort entschieden hat.
- **Unterwegs oder ohne Standort:** vormittags (bis 12 Uhr) zur Arbeit, nachmittags nach Hause
- **Echtzeitdaten** aus der Fahrplanauskunft „Bahnland Bayern“, die das gesamte VGN-Gebiet abdeckt
- **Verspätungen** werden hervorgehoben: ab 2 min **orange**, ab 5 min **rot** (Zeile farbig hinterlegt)
- **Ausfälle** erscheinen rot mit „✕ FÄLLT AUS“ und der betroffenen Linie
- Zusammenfassung unten, z. B. „⚠︎ 1× Ausfall · 2× verspätet“
- Ohne Internet wird die zuletzt geladene Auskunft mit „Offline – Stand hh:mm“ angezeigt

Das Widget läuft in der kostenlosen App **[Scriptable](https://apps.apple.com/de/app/scriptable/id1405459188)** – kein Mac, kein Xcode, kein Developer-Account nötig.

## Installation (ca. 3 Minuten)

1. **Scriptable** aus dem App Store installieren und einmal öffnen.
2. In Scriptable oben rechts auf **＋** tippen, um ein neues Skript anzulegen.
3. Den kompletten Inhalt von [`VGN-Pendler.js`](VGN-Pendler.js) hineinkopieren
   (auf GitHub: Datei öffnen → „Raw“ → alles markieren → kopieren).
4. Oben im Skript den Bereich **KONFIGURATION** anpassen:
   ```js
   HOME: "Nürnberg, Plärrer",        // deine Haltestelle oder Adresse zu Hause
   WORK: "Erlangen, Hauptbahnhof",   // deine Haltestelle oder Adresse bei der Arbeit
   ```
   Am besten so schreiben, wie du es auch in der VGN-App suchen würdest („Ort, Haltestelle“ oder „Ort, Straße Hausnummer“).
5. Das Skript oben auf den Titel tippen und z. B. **VGN-Pendler** nennen. Mit ▶︎ einmal testen – es erscheint eine Vorschau.
6. Zum Homescreen wechseln → lange auf eine freie Stelle drücken → **＋** oben links → **Scriptable** wählen
   → Größe **Mittel** (empfohlen) oder **Groß** → „Widget hinzufügen“.
7. Lange auf das neue Widget tippen → **Widget bearbeiten** → bei *Script* **VGN-Pendler** auswählen.

Fertig! Ein Tipp aufs Widget öffnet die VGN-Verbindungssuche.

## Widget-Größen

| Größe  | Inhalt |
|--------|--------|
| Klein  | 3 Verbindungen, kompakt (Zeit, Verspätung, Linie, Ankunft) |
| Mittel | 3 Verbindungen mit „in X min“, Linienkette, Gleis/Steig, Umstiege |
| Groß   | bis zu 8 Verbindungen |

## Weitere Einstellungen

| Einstellung        | Standard | Bedeutung |
|--------------------|----------|-----------|
| `HOME_PLACE` / `WORK_PLACE` | Wildbirnenweg 61 / Pommernstraße 10 | Adressen (mit Koordinaten) für die Standorterkennung |
| `PLACE_RADIUS_M`   | `300`    | Umkreis in Metern, in dem du als „dort“ giltst |
| `USE_LOCATION`     | `true`   | `false` → Richtung nur nach Uhrzeit |
| `SWITCH_HOUR`      | `12`     | Ohne Standort: ab dieser Stunde wird die Rückfahrt angezeigt |
| `DELAY_WARN_MIN`   | `2`      | Ab so vielen Minuten Verspätung: orange |
| `DELAY_ALERT_MIN`  | `5`      | Ab so vielen Minuten Verspätung: rot |
| `OFFSET_MIN`       | `0`      | Verbindungen erst ab „jetzt + X min“ (z. B. Fußweg zur Haltestelle) |
| `REFRESH_MIN`      | `5`      | Gewünschtes Aktualisierungsintervall |

**Richtung fest einstellen:** Unter *Widget bearbeiten → Parameter* `hin` (immer zur Arbeit) oder `rueck`
(immer nach Hause) eintragen. So kannst du z. B. zwei Widgets nebeneinander nutzen.

## Gut zu wissen

- **Standortfreigabe:** Beim ersten Start fragt Scriptable nach dem Standort. Damit es auch im Widget klappt,
  unter *Einstellungen → Datenschutz & Sicherheit → Ortungsdienste → Scriptable* „Beim Verwenden der App oder
  Widgets“ wählen. Ohne Freigabe entscheidet die Uhrzeit. Klappt die Ortung mal nicht, nutzt das Widget eine bis zu
  30 Minuten alte Position.

- **Aktualisierung:** iOS bestimmt, wie oft Widgets tatsächlich neu geladen werden (typischerweise alle 5–15 Minuten).
  Die Uhrzeit oben rechts im Widget zeigt den Stand der Daten.
- **Angezeigte Zeiten:** Links steht die *planmäßige* Abfahrt des ersten Verkehrsmittels, daneben die Verspätung
  (`+3`). „in X min“ und die Ankunftszeit berücksichtigen bereits die Echtzeitdaten.
  `+0` in Grün bedeutet: Echtzeitdaten vorhanden, pünktlich.
- **Haltestellen** werden beim ersten Lauf über die Haltestellensuche aufgelöst und zwischengespeichert.
  Wenn du `HOME`/`WORK` änderst, wird automatisch neu gesucht.
- Datenquelle ist die öffentliche EFA-Schnittstelle von „Bahnland Bayern“ (`bahnland-bayern.de/efa/`).
  Die frühere VGN-Schnittstelle `efa.vgn.de` ist nicht mehr erreichbar. Falls die Meldung
  „Fahrplanauskunft nicht erreichbar“ erscheint, ist meist die Internetverbindung oder der Server gestört.
- **Adressen** werden über ihre Koordinaten gesucht. Am zuverlässigsten sind Haltestellennamen
  („Nürnberg, Plärrer“).

## Entwicklung / Test

Die Logik lässt sich ohne iPhone mit Node.js testen. Der Test simuliert die Scriptable-APIs und
nutzt Beispieldaten (`test/trip-fixture.json`) mit pünktlichen, verspäteten und ausgefallenen Fahrten:

```bash
TZ=Europe/Berlin node vgn-widget/test/run-test.js
```

Mit echten Daten (fragt die Fahrplanauskunft live ab und gibt den Widget-Inhalt als Text aus):

```bash
TZ=Europe/Berlin node vgn-widget/test/live-check.js hin large    # oder: rueck medium
```
