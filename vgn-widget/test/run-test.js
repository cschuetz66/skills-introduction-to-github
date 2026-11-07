// Testet VGN-Pendler.js unter Node.js mit simulierten Scriptable-APIs.
// Aufruf: node vgn-widget/test/run-test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "VGN-Pendler.js"), "utf8");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "trip-fixture.json"), "utf8"));

// ---- Mock-Elemente, die einen Baum aufzeichnen ----
class Node {
  constructor(type, props = {}) {
    Object.assign(this, props);
    this.type = type;
    this.children = [];
  }
  addStack() { const s = new Node("stack"); this.children.push(s); return s; }
  addText(text) { const t = new Node("text", { text }); this.children.push(t); return t; }
  addImage(img) { const i = new Node("image", { img }); this.children.push(i); return i; }
  addSpacer() { this.children.push(new Node("spacer")); }
  layoutHorizontally() {} layoutVertically() {} centerAlignContent() {} bottomAlignContent() {}
  setPadding() {}
  async presentLarge() { this.presented = true; }
}
function texts(node, out = []) {
  if (node.type === "text") out.push(node.text);
  node.children.forEach((c) => texts(c, out));
  return out;
}
function textsWithColor(node, out = []) {
  if (node.type === "text") out.push({ text: node.text, color: node.textColor && node.textColor.name });
  node.children.forEach((c) => textsWithColor(c, out));
  return out;
}

function makeGlobals({ hour, widgetParameter, family, failNetwork }) {
  const requests = [];
  const files = {};
  const now = new Date(Date.UTC(2026, 10, 9, hour - 1, 0, 0)); // Mo 09.11.2026, MEZ = UTC+1
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(now.getTime()); else super(...a); }
    static now() { return now.getTime(); }
  }
  let widgetSet = null;
  const g = {
    Date: FakeDate,
    Color: class { constructor(hex) { this.name = hex; } static dynamic(l) { return l; } },
    Font: new Proxy({}, { get: () => () => ({}) }),
    Size: class { constructor(w, h) { this.w = w; this.h = h; } },
    SFSymbol: { named: (n) => ({ image: n }) },
    ListWidget: class extends Node { constructor() { super("widget"); } },
    FileManager: {
      local: () => ({
        cacheDirectory: () => "/cache",
        joinPath: (a, b) => `${a}/${b}`,
        fileExists: (p) => p in files,
        readString: (p) => files[p],
        writeString: (p, s) => { files[p] = s; },
      }),
    },
    Request: class {
      constructor(url) { this.url = url; requests.push(url); }
      async loadJSON() {
        if (failNetwork) throw new Error("Die Internetverbindung scheint offline zu sein.");
        if (this.url.includes("XML_STOPFINDER_REQUEST")) {
          const name = decodeURIComponent(this.url.match(/name_sf=([^&]*)/)[1]);
          return {
            locations: [
              { id: "de:09564:9999", name: "Falscher Treffer", matchQuality: 10 },
              { id: `id:${name}`, name, disassembledName: name.split(", ").pop(), isBest: true, matchQuality: 900 },
            ],
          };
        }
        return FIXTURE;
      }
    },
    config: { runsInWidget: true, widgetFamily: family },
    args: { widgetParameter },
    Script: { setWidget: (w) => { widgetSet = w; }, complete: () => {} },
  };
  return { g, requests, files, getWidget: () => widgetSet, now };
}

async function runScript(opts) {
  const env = makeGlobals(opts);
  const names = Object.keys(env.g);
  const fn = new Function(...names, `return (async () => {\n${SCRIPT}\n})();`);
  await fn(...names.map((n) => env.g[n]));
  return env;
}

(async () => {
  // 1) Vormittag → Zuhause → Arbeit
  let env = await runScript({ hour: 7, family: "medium" });
  let w = env.getWidget();
  let t = texts(w);
  console.log("--- medium, 07:00 ---\n" + t.join(" | "));
  assert(t.includes("Zur Arbeit"), "Titel vormittags");
  const trip = env.requests.find((u) => u.includes("XML_TRIP_REQUEST2"));
  assert(trip.includes("name_origin=id%3AN%C3%BCrnberg%2C%20Pl%C3%A4rrer"), "Start = HOME");
  assert(trip.includes("itdTime=0700"), "Uhrzeit im Request");

  // Ausfall + Verspätung hervorgehoben
  const colored = textsWithColor(w);
  const cancel = colored.find((x) => x.text === "✕ FÄLLT AUS");
  assert(cancel && cancel.color === "#d70015", "Ausfall rot");
  const late = colored.find((x) => x.text === "+7");
  assert(late && late.color === "#d70015", "+7 min rot");
  const warn = colored.find((x) => x.text === "+3");
  assert(warn && warn.color === "#c75c00", "+3 min orange");
  assert(t.some((s) => s.includes("Ausfall") && s.includes("verspätet")), "Zusammenfassung");
  // Bereits abgefahrene Verbindung (06:50) ist ausgeblendet
  assert(!t.includes("06:50"), "Vergangene Verbindung ausgeblendet");

  // 2) Nachmittag → Arbeit → Zuhause
  env = await runScript({ hour: 16, family: "small" });
  t = texts(env.getWidget());
  console.log("--- small, 16:00 ---\n" + t.join(" | "));
  assert(t.includes("Nach Hause"));
  assert(env.requests.find((u) => u.includes("XML_TRIP_REQUEST2")).includes("name_origin=id%3AErlangen"));

  // 3) Parameter erzwingt Richtung
  env = await runScript({ hour: 16, family: "large", widgetParameter: "hin" });
  t = texts(env.getWidget());
  console.log("--- large, 16:00, Parameter hin ---\n" + t.join(" | "));
  assert(t.includes("Zur Arbeit"));

  // 3b) Großes Widget: alle 4 kommenden Fahrten, Umstieg, Fußweg nicht als Linie
  env = await runScript({ hour: 7, family: "large" });
  t = texts(env.getWidget());
  console.log("--- large, 07:00 ---\n" + t.join(" | "));
  assert(t.includes("07:35"), "4. Verbindung sichtbar");
  assert(t.includes("U1 › 10"), "Linienkette ohne Fußweg");
  assert(t.some((s) => s.includes("1 Umst.")), "Umstiege");

  // 3c) Small: Ausfall auch kompakt sichtbar
  env = await runScript({ hour: 7, family: "small" });
  t = texts(env.getWidget());
  console.log("--- small, 07:00 ---\n" + t.join(" | "));
  assert(t.includes("✕ FÄLLT AUS"));

  // 4) Offline ohne Cache → Fehlermeldung
  env = await runScript({ hour: 7, family: "medium", failNetwork: true });
  t = texts(env.getWidget());
  console.log("--- offline ---\n" + t.join(" | "));
  assert(t.includes("Keine Daten"));

  console.log("\nAlle Tests bestanden ✔");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
