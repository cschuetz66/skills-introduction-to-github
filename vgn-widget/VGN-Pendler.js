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
 * Datenquelle: VGN-Fahrplanauskunft (EFA, https://efa.vgn.de)
 *
 * Widget-Parameter (optional, lange auf das Widget tippen → „Widget bearbeiten“):
 *   hin    → immer Zuhause → Arbeit
 *   rueck  → immer Arbeit → Zuhause
 *   (leer) → automatisch nach Uhrzeit (siehe SWITCH_HOUR)
 */

// ============================ KONFIGURATION ============================
const CONFIG = {
  // Haltestelle oder Adresse – so, wie du sie in der VGN-App eingeben würdest.
  HOME: "Nürnberg, Plärrer",
  WORK: "Erlangen, Hauptbahnhof",

  // Bis zu dieser Stunde (exklusive) wird Zuhause → Arbeit angezeigt,
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

  EFA_BASE: "https://efa.vgn.de/vgnExt_oeffi/",
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
  return await req.loadJSON();
}

// -------------------------- Richtung bestimmen -------------------------

function chooseDirection(now, param) {
  const p = (param || "").trim().toLowerCase();
  let toWork;
  if (["hin", "arbeit", "work"].includes(p)) toWork = true;
  else if (["rueck", "rück", "zurueck", "zurück", "heim", "home"].includes(p)) toWork = false;
  else toWork = now.getHours() < CONFIG.SWITCH_HOUR;

  return toWork
    ? { from: CONFIG.HOME, to: CONFIG.WORK, title: "Zur Arbeit", icon: "briefcase.fill" }
    : { from: CONFIG.WORK, to: CONFIG.HOME, title: "Nach Hause", icon: "house.fill" };
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
  const cache = readCache("locations") || {};
  if (cache[name]) return cache[name];

  const json = await fetchJSON("XML_STOPFINDER_REQUEST", {
    outputFormat: "rapidJSON",
    type_sf: "any",
    name_sf: name,
    locationServerActive: 1,
    coordOutputFormat: "WGS84[dd.ddddd]",
  });
  const loc = pickBestLocation(json.locations);
  if (!loc) throw new Error(`Ort nicht gefunden: „${name}“`);

  const result = { id: loc.id, name: loc.disassembledName || loc.name || name };
  cache[name] = result;
  writeCache("locations", cache);
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
  return t.disassembledName || t.number || (t.name || "").replace(/^(Bus|Tram|U-Bahn|S-Bahn)\s*/i, "") || "?";
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

async function loadTrips(from, to, now) {
  const start = new Date(now.getTime() + CONFIG.OFFSET_MIN * 60000);
  const json = await fetchJSON("XML_TRIP_REQUEST2", {
    outputFormat: "rapidJSON",
    type_origin: "any",
    name_origin: from.id,
    type_destination: "any",
    name_destination: to.id,
    itdDate: efaDate(start),
    itdTime: efaTime(start),
    itdTripDateTimeDepArr: "dep",
    calcNumberOfTrips: 6,
    useRealtime: 1,
    locationServerActive: 1,
    coordOutputFormat: "WGS84[dd.ddddd]",
  });
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
  addText(head, hhmm(new Date()), Font.systemFont(10), COLORS.sub);

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
  const dir = chooseDirection(now, args.widgetParameter);
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
