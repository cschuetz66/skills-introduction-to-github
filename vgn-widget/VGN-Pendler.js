// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-green; icon-glyph: subway;

/*
 * VGN-Pendler – iOS-Homescreen-Widget für Scriptable
 * ---------------------------------------------------
 * Zeigt vormittags die nächsten VGN-Verbindungen von zu Hause zur Arbeit
 * und nachmittags von der Arbeit nach Hause – inkl. Echtzeitdaten.
 * Verspätungen werden orange/rot, Ausfälle rot hervorgehoben.
 *
 * Datenquelle: Fahrplanauskunft „Bahnland Bayern“ (EFA, https://bahnland-bayern.de),
 * die das gesamte VGN-Gebiet inkl. Echtzeitdaten abdeckt. (Die frühere
 * Schnittstelle efa.vgn.de ist nicht mehr erreichbar.)
 *
 * Widget-Parameter (optional, lange auf das Widget tippen → „Widget bearbeiten“):
 *   hin    → immer Zuhause → Arbeit
 *   rueck  → immer Arbeit → Zuhause
 *   (leer) → automatisch nach Standort, sonst nach Uhrzeit (siehe unten)
 *
 * Automatische Richtung:
 *   - Du bist an der Arbeit (WORK_PLACE)   → Fahrten nach Hause
 *   - Du bist zu Hause (HOME_PLACE)        → Fahrten zur Arbeit
 *   - weder noch / Standort unbekannt      → nach Uhrzeit (SWITCH_HOUR)
 */

// ============================ KONFIGURATION ============================
const CONFIG = {
  // Haltestelle oder Adresse – so, wie du sie in der VGN-App eingeben würdest.
  HOME: "Schwabach, Wildbirnenweg",
  WORK: "Nürnberg, Eibach",

  // Standorte für die automatische Richtungswahl (Adresse + Koordinaten).
  HOME_PLACE: { name: "Wildbirnenweg 61, Schwabach", lat: 49.323407, lon: 11.007515 },
  WORK_PLACE: { name: "Pommernstraße 10, Nürnberg", lat: 49.411839, lon: 11.044185 },
  // Innerhalb dieses Umkreises (Meter) gilt man als „dort“.
  PLACE_RADIUS_M: 300,
  // Standort verwenden? (false → nur Uhrzeit)
  USE_LOCATION: true,

  // Fallback ohne Standort: bis zu dieser Stunde (exklusive) Zuhause → Arbeit,
  // ab dieser Stunde Arbeit → Zuhause.
  SWITCH_HOUR: 12,

  // Ab wie vielen Minuten Verspätung gilt eine Verbindung als verspätet?
  DELAY_WARN_MIN: 2, // orange
  DELAY_ALERT_MIN: 5, // rot

  // Vorlaufzeit: Verbindungen erst ab „jetzt + X Minuten“ suchen
  // (z. B. Fußweg zur Haltestelle).
  OFFSET_MIN: 0,

  // Wie oft iOS das Widget neu laden soll (Minuten; iOS entscheidet final).
  REFRESH_MIN: 5,

  EFA_BASE: "https://bahnland-bayern.de/efa/",
};
// =======================================================================

const COLORS = {
  bg: Color.dynamic(new Color("#ffffff"), new Color("#1c1c1e")),
  text: Color.dynamic(new Color("#1c1c1e"), new Color("#f2f2f7")),
  sub: Color.dynamic(new Color("#6e6e73"), new Color("#a1a1a6")),
  ok: Color.dynamic(new Color("#1f8a3b"), new Color("#30d158")),
  warn: Color.dynamic(new Color("#c75c00"), new Color("#ff9f0a")),
  alert: Color.dynamic(new Color("#d70015"), new Color("#ff453a")),
  alertBg: Color.dynamic(new Color("#ffe5e7"), new Color("#3a1416")),
  warnBg: Color.dynamic(new Color("#fff1e0"), new Color("#33240f")),
  accent: new Color("#00845a"),
};

// ------------------------------- Helfer --------------------------------

function pad(n) {
  return String(n).padStart(2, "0");
}

function hhmm(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function efaDate(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function efaTime(d) {
  return `${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function query(params) {
  return Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
}

async function fetchJSON(endpoint, params) {
  const req = new Request(`${CONFIG.EFA_BASE}${endpoint}?${query(params)}`);
  req.timeoutInterval = 15;
  req.headers = { Accept: "application/json" };
  let json;
  try {
    json = await req.loadJSON();
  } catch (e) {
    throw new Error(`Fahrplanauskunft nicht erreichbar (${e && e.message ? e.message : e})`);
  }
  return json;
}

// Die EFA liefert z. B. „multiple matches“ als Fehler, obwohl Ergebnisse
// dabei sind – Fehlermeldungen daher nur verwenden, wenn Daten fehlen.
function efaErrorText(json) {
  const err = (json.systemMessages || []).find((m) => m.type === "error");
  return err ? ` (EFA ${err.code}${err.text ? `: ${err.text}` : ""})` : "";
}

// -------------------------- Richtung bestimmen -------------------------

// Entfernung zweier Koordinaten in Metern (Haversine).
function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Aktuellen Standort ermitteln (max. 10 s). Klappt das nicht, wird eine
// höchstens 30 Minuten alte, zuletzt bekannte Position verwendet.
async function currentPosition(now) {
  if (!CONFIG.USE_LOCATION || typeof Location === "undefined") return null;
  try {
    Location.setAccuracyToHundredMeters();
    const pos = await Promise.race([
      Location.current(),
      new Promise((_, reject) => Timer.schedule(10000, false, () => reject(new Error("Timeout")))),
    ]);
    const result = { lat: pos.latitude, lon: pos.longitude, ts: now.toISOString() };
    writeCache("position", result);
    return result;
  } catch (e) {
    const last = readCache("position");
    if (last && now - new Date(last.ts) < 30 * 60000) return last;
    return null;
  }
}

// Gibt "work" / "home" zurück, wenn man an einem der Orte ist, sonst null.
function placeAt(pos) {
  if (!pos) return null;
  const dWork = distanceM(pos.lat, pos.lon, CONFIG.WORK_PLACE.lat, CONFIG.WORK_PLACE.lon);
  const dHome = distanceM(pos.lat, pos.lon, CONFIG.HOME_PLACE.lat, CONFIG.HOME_PLACE.lon);
  if (dWork <= CONFIG.PLACE_RADIUS_M && dWork <= dHome) return "work";
  if (dHome <= CONFIG.PLACE_RADIUS_M) return "home";
  return null;
}

function chooseDirection(now, param, pos) {
  const p = (param || "").trim().toLowerCase();
  let toWork;
  let reason;
  const place = placeAt(pos);
  if (["hin", "arbeit", "work"].includes(p)) {
    toWork = true;
    reason = "param";
  } else if (["rueck", "rück", "zurueck", "zurück", "heim", "home"].includes(p)) {
    toWork = false;
    reason = "param";
  } else if (place === "work") {
    toWork = false; // an der Arbeit → nach Hause
    reason = "location";
  } else if (place === "home") {
    toWork = true; // zu Hause → zur Arbeit
    reason = "location";
  } else {
    toWork = now.getHours() < CONFIG.SWITCH_HOUR;
    reason = "time";
  }

  return toWork
    ? { from: CONFIG.HOME, to: CONFIG.WORK, title: "Zur Arbeit", icon: "briefcase.fill", reason }
    : { from: CONFIG.WORK, to: CONFIG.HOME, title: "Nach Hause", icon: "house.fill", reason };
}

// ------------------------ Haltestellen auflösen ------------------------

const fm = (() => {
  try {
    return FileManager.local();
  } catch (e) {
    return null;
  }
})();

function cachePath(name) {
  return fm.joinPath(fm.cacheDirectory(), `vgn-pendler-${name}.json`);
}

function readCache(name) {
  try {
    const p = cachePath(name);
    if (fm.fileExists(p)) return JSON.parse(fm.readString(p));
  } catch (e) {}
  return null;
}

function writeCache(name, data) {
  try {
    fm.writeString(cachePath(name), JSON.stringify(data));
  } catch (e) {}
}

function pickBestLocation(locations) {
  if (!Array.isArray(locations) || locations.length === 0) return null;
  const best = locations.find((l) => l.isBest);
  if (best) return best;
  return [...locations].sort((a, b) => (b.matchQuality || 0) - (a.matchQuality || 0))[0];
}

async function resolveLocation(name) {
  const cache = readCache("locations-v2") || {};
  if (cache[name]) return cache[name];

  const json = await fetchJSON("XML_STOPFINDER_REQUEST", {
    outputFormat: "rapidJSON",
    type_sf: "any",
    name_sf: name,
    locationServerActive: 1,
    coordOutputFormat: "WGS84[dd.ddddd]",
  });
  const loc = pickBestLocation(json.locations);
  if (!loc) throw new Error(`Ort nicht gefunden: „${name}“${efaErrorText(json)}`);

  const result = {
    id: loc.id,
    type: loc.type,
    coord: loc.coord, // [lat, lon]
    name: loc.name || loc.disassembledName || name,
  };
  cache[name] = result;
  writeCache("locations-v2", cache);
  return result;
}

// ------------------------- Verbindungen laden --------------------------

// EFA-Produktklassen für Fußwege / „sitzen bleiben“ – keine echten Fahrten.
const NON_TRANSIT_CLASSES = [97, 98, 99, 100, 105, 106, 107];

function isTransitLeg(leg) {
  const cls = leg && leg.transportation && leg.transportation.product
    ? Number(leg.transportation.product.class)
    : NaN;
  if (NON_TRANSIT_CLASSES.includes(cls)) return false;
  return !!(leg && leg.transportation && (leg.transportation.number || leg.transportation.disassembledName || leg.transportation.name));
}

function isLegCancelled(leg) {
  const status = []
    .concat(leg.realtimeStatus || [])
    .concat((leg.origin && leg.origin.realtimeStatus) || [])
    .concat((leg.destination && leg.destination.realtimeStatus) || [])
    .map((s) => String(s).toUpperCase());
  if (status.some((s) => s.includes("CANCEL"))) return true;
  if (leg.isCancelled === true) return true;
  if (leg.transportation && leg.transportation.isCancelled === true) return true;
  return false;
}

function minutesDiff(planned, estimated) {
  if (!planned || !estimated) return null;
  return Math.round((new Date(estimated) - new Date(planned)) / 60000);
}

function lineLabel(leg) {
  const t = leg.transportation || {};
  const label = t.disassembledName || t.number || (t.name || "").replace(/^(Bus|Tram|U-Bahn|S-Bahn)\s*/i, "") || "?";
  // Lange Namen (z. B. Rufbus „A666 Lotti Schwabach“) auf den ersten Teil kürzen.
  return label.length > 8 && label.includes(" ") ? label.split(" ")[0] : label;
}

function parseJourney(journey) {
  const legs = journey.legs || [];
  if (legs.length === 0) return null;
  const transit = legs.filter(isTransitLeg);
  const firstLeg = legs[0];
  const lastLeg = legs[legs.length - 1];
  const firstTransit = transit[0] || firstLeg;
  const lastTransit = transit[transit.length - 1] || lastLeg;

  // Angezeigt wird die Abfahrt/Ankunft des ersten/letzten Verkehrsmittels
  // (Fußwege davor/danach zählen nicht), passend zur Verspätungsangabe.
  const depPlanned = firstTransit.origin.departureTimePlanned;
  const depEstimated = firstTransit.origin.departureTimeEstimated;
  const arrPlanned = lastTransit.destination.arrivalTimePlanned;
  const arrEstimated = lastTransit.destination.arrivalTimeEstimated;

  // Verspätung bezieht sich auf das erste/letzte echte Verkehrsmittel.
  const depDelay = minutesDiff(
    firstTransit.origin.departureTimePlanned,
    firstTransit.origin.departureTimeEstimated
  );
  const arrDelay = minutesDiff(
    lastTransit.destination.arrivalTimePlanned,
    lastTransit.destination.arrivalTimeEstimated
  );

  const cancelledLegs = transit.filter(isLegCancelled);
  const platform =
    (firstTransit.origin.properties && (firstTransit.origin.properties.platform || firstTransit.origin.properties.platformName)) ||
    null;

  return {
    depPlanned: new Date(depPlanned),
    depActual: new Date(depEstimated || depPlanned),
    arrPlanned: new Date(arrPlanned),
    arrActual: new Date(arrEstimated || arrPlanned),
    depDelay,
    arrDelay,
    realtime: transit.some((l) => l.isRealtimeControlled || (l.realtimeStatus || []).includes("MONITORED")),
    cancelled: cancelledLegs.length > 0,
    cancelledLines: cancelledLegs.map(lineLabel),
    lines: transit.map(lineLabel),
    firstStop: firstTransit.origin.disassembledName || firstTransit.origin.name || "",
    direction: (firstTransit.transportation && firstTransit.transportation.destination && firstTransit.transportation.destination.name) || "",
    platform,
    changes: Math.max(0, transit.length - 1),
  };
}

// Haltestellen per ID, alles andere (Adresse, POI) per Koordinate –
// sonst meldet die EFA bei mehrdeutigen IDs „multiple matches“.
function locationParams(loc, prefix) {
  if (loc.type === "stop" || !Array.isArray(loc.coord)) {
    return { [`type_${prefix}`]: "stop", [`name_${prefix}`]: loc.id };
  }
  const [lat, lon] = loc.coord;
  return { [`type_${prefix}`]: "coord", [`name_${prefix}`]: `${lon}:${lat}:WGS84[dd.ddddd]` };
}

async function loadTrips(from, to, now) {
  const start = new Date(now.getTime() + CONFIG.OFFSET_MIN * 60000);
  const json = await fetchJSON("XML_TRIP_REQUEST2", {
    outputFormat: "rapidJSON",
    ...locationParams(from, "origin"),
    ...locationParams(to, "destination"),
    itdDate: efaDate(start),
    itdTime: efaTime(start),
    itdTripDateTimeDepArr: "dep",
    calcNumberOfTrips: 6,
    useRealtime: 1,
    locationServerActive: 1,
    coordOutputFormat: "WGS84[dd.ddddd]",
  });
  if (!Array.isArray(json.journeys)) {
    const msg = efaErrorText(json);
    if (msg) throw new Error(`Keine Verbindung berechnet${msg}`);
  }
  const journeys = (json.journeys || []).map(parseJourney).filter(Boolean);
  // Bereits abgefahrene (tatsächliche Abfahrt in der Vergangenheit) ausblenden.
  return journeys
    .filter((j) => j.depActual.getTime() >= now.getTime() - 60000)
    .sort((a, b) => a.depPlanned - b.depPlanned);
}

// ------------------------------ Darstellung -----------------------------

function severity(j) {
  if (j.cancelled) return "cancelled";
  const d = Math.max(j.depDelay || 0, j.arrDelay || 0);
  if (d >= CONFIG.DELAY_ALERT_MIN) return "alert";
  if (d >= CONFIG.DELAY_WARN_MIN) return "warn";
  return "ok";
}

function delayColor(min) {
  if (min == null) return COLORS.sub;
  if (min >= CONFIG.DELAY_ALERT_MIN) return COLORS.alert;
  if (min >= CONFIG.DELAY_WARN_MIN) return COLORS.warn;
  return COLORS.ok;
}

function addText(stack, text, font, color, opts = {}) {
  const t = stack.addText(text);
  t.font = font;
  t.textColor = color;
  t.lineLimit = 1;
  if (opts.minScale) t.minimumScaleFactor = opts.minScale;
  return t;
}

function addRow(widget, j, compact, now) {
  const sev = severity(j);
  const row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  row.setPadding(3, 6, 3, 6);
  row.cornerRadius = 6;
  if (sev === "cancelled" || sev === "alert") row.backgroundColor = COLORS.alertBg;
  else if (sev === "warn") row.backgroundColor = COLORS.warnBg;

  // Statusbalken links
  const bar = row.addStack();
  bar.size = new Size(3, compact ? 26 : 30);
  bar.cornerRadius = 1.5;
  bar.backgroundColor =
    sev === "cancelled" || sev === "alert" ? COLORS.alert : sev === "warn" ? COLORS.warn : j.realtime ? COLORS.ok : COLORS.sub;
  row.addSpacer(6);

  // Zeitspalte
  const timeCol = row.addStack();
  timeCol.layoutVertically();
  const depLine = timeCol.addStack();
  depLine.layoutHorizontally();
  depLine.bottomAlignContent();

  if (j.cancelled) {
    addText(depLine, hhmm(j.depPlanned), Font.boldMonospacedSystemFont(14), COLORS.alert);
    depLine.addSpacer(4);
    addText(depLine, "✕ FÄLLT AUS", Font.heavySystemFont(10), COLORS.alert, { minScale: 0.7 });
  } else {
    addText(depLine, hhmm(j.depPlanned), Font.boldMonospacedSystemFont(14), COLORS.text);
    if (j.depDelay != null && j.depDelay !== 0) {
      depLine.addSpacer(3);
      const sign = j.depDelay > 0 ? "+" : "−";
      addText(depLine, `${sign}${Math.abs(j.depDelay)}`, Font.heavyMonospacedSystemFont(12), delayColor(j.depDelay));
    } else if (j.depDelay === 0) {
      depLine.addSpacer(3);
      addText(depLine, "+0", Font.mediumMonospacedSystemFont(11), COLORS.ok);
    }
  }

  // Info-Zeile unter der Zeit
  const mins = Math.round((j.depActual - now) / 60000);
  const arrText = j.cancelled
    ? `${j.cancelledLines.join(", ")} entfällt`
    : `an ${hhmm(j.arrActual)}${j.arrDelay >= CONFIG.DELAY_WARN_MIN ? ` (+${j.arrDelay})` : ""}`;
  const info = compact ? arrText : `${mins <= 0 ? "jetzt" : `in ${mins} min`} · ${arrText}`;
  addText(
    timeCol,
    info,
    Font.systemFont(10),
    j.cancelled ? COLORS.alert : j.arrDelay >= CONFIG.DELAY_WARN_MIN ? delayColor(j.arrDelay) : COLORS.sub,
    { minScale: 0.7 }
  );

  row.addSpacer();

  // Linien rechts
  if (!compact) {
    const right = row.addStack();
    right.layoutVertically();
    const lineStack = right.addStack();
    lineStack.addSpacer();
    addText(lineStack, j.lines.join(" › ") || "Fußweg", Font.semiboldSystemFont(12), j.cancelled ? COLORS.alert : COLORS.text, {
      minScale: 0.6,
    });
    const sub = right.addStack();
    sub.addSpacer();
    const changes = j.changes === 0 ? "direkt" : `${j.changes} Umst.`;
    addText(sub, `${j.platform ? `Gl./Steig ${j.platform} · ` : ""}${changes}`, Font.systemFont(9), COLORS.sub, {
      minScale: 0.6,
    });
  } else {
    addText(row, j.lines[0] || "", Font.semiboldSystemFont(11), j.cancelled ? COLORS.alert : COLORS.text, { minScale: 0.6 });
  }
}

function addHeader(widget, dir, from, to, compact) {
  const head = widget.addStack();
  head.layoutHorizontally();
  head.centerAlignContent();
  const sym = SFSymbol.named(dir.icon);
  const img = head.addImage(sym.image);
  img.imageSize = new Size(13, 13);
  img.tintColor = COLORS.accent;
  head.addSpacer(5);
  addText(head, dir.title, Font.boldSystemFont(13), COLORS.text);
  head.addSpacer();
  addText(head, `${dir.reason === "location" ? "📍 " : ""}${hhmm(new Date())}`, Font.systemFont(10), COLORS.sub);

  if (!compact) {
    addText(widget, `${from.name} → ${to.name}`, Font.systemFont(10), COLORS.sub, { minScale: 0.6 });
  }
}

function addSummary(widget, journeys) {
  const cancelled = journeys.filter((j) => j.cancelled).length;
  const delayed = journeys.filter((j) => !j.cancelled && severity(j) !== "ok").length;
  if (!cancelled && !delayed) return;
  const parts = [];
  if (cancelled) parts.push(`${cancelled}× Ausfall`);
  if (delayed) parts.push(`${delayed}× verspätet`);
  addText(widget, `⚠︎ ${parts.join(" · ")}`, Font.semiboldSystemFont(10), cancelled ? COLORS.alert : COLORS.warn);
}

function rowsForFamily(family) {
  switch (family) {
    case "small":
      return 3;
    case "large":
    case "extraLarge":
      return 8;
    default:
      return 3;
  }
}

function buildWidget({ dir, from, to, journeys, error, stale, family, now }) {
  const w = new ListWidget();
  w.backgroundColor = COLORS.bg;
  w.setPadding(10, 10, 10, 10);
  w.refreshAfterDate = new Date(now.getTime() + CONFIG.REFRESH_MIN * 60000);
  w.url = "https://www.vgn.de/verbindungen/";

  const compact = family === "small";
  addHeader(w, dir, from || { name: dir.from }, to || { name: dir.to }, compact);
  w.addSpacer(4);

  if (error && (!journeys || journeys.length === 0)) {
    w.addSpacer();
    addText(w, "Keine Daten", Font.boldSystemFont(13), COLORS.alert);
    addText(w, String(error), Font.systemFont(10), COLORS.sub, { minScale: 0.6 }).lineLimit = 3;
    w.addSpacer();
    return w;
  }

  if (!journeys || journeys.length === 0) {
    w.addSpacer();
    addText(w, "Keine Verbindungen gefunden", Font.systemFont(12), COLORS.sub);
    w.addSpacer();
    return w;
  }

  const shown = journeys.slice(0, rowsForFamily(family));
  shown.forEach((j, i) => {
    if (i > 0) w.addSpacer(3);
    addRow(w, j, compact, now);
  });

  w.addSpacer();
  if (!compact) addSummary(w, shown);
  if (stale) {
    addText(w, `Offline – Stand ${hhmm(stale)}`, Font.italicSystemFont(9), COLORS.warn);
  }
  return w;
}

// --------------------------------- Main ---------------------------------

async function run() {
  const now = new Date();
  const family = config.widgetFamily || "medium";
  const param = (args.widgetParameter || "").trim();
  const pos = param ? null : await currentPosition(now);
  const dir = chooseDirection(now, param, pos);
  const cacheKey = `trips-${dir.from}-${dir.to}`.replace(/[^\w-]/g, "_");

  let from, to, journeys, error, stale;
  try {
    from = await resolveLocation(dir.from);
    to = await resolveLocation(dir.to);
    journeys = await loadTrips(from, to, now);
    writeCache(cacheKey, { ts: now.toISOString(), from, to, journeys });
  } catch (e) {
    error = e && e.message ? e.message : String(e);
    const cached = readCache(cacheKey);
    if (cached) {
      from = cached.from;
      to = cached.to;
      stale = new Date(cached.ts);
      journeys = cached.journeys
        .map((j) => {
          for (const k of ["depPlanned", "depActual", "arrPlanned", "arrActual"]) j[k] = new Date(j[k]);
          return j;
        })
        .filter((j) => j.depActual.getTime() >= now.getTime() - 60000);
    }
  }

  const widget = buildWidget({ dir, from, to, journeys, error, stale, family, now });

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    await widget.presentLarge();
  }
  Script.complete();
}

await run();
