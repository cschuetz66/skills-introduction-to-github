// Live-Test: führt VGN-Pendler.js mit simulierten Scriptable-APIs, aber
// ECHTEN Anfragen an die Fahrplanauskunft aus und gibt den Widget-Inhalt aus.
// Aufruf: TZ=Europe/Berlin node vgn-widget/test/live-check.js [hin|rueck] [small|medium|large]
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "VGN-Pendler.js"), "utf8");
const [param = "", family = "large"] = process.argv.slice(2);

class Node {
  constructor(type, props = {}) { Object.assign(this, props); this.type = type; this.children = []; }
  addStack() { const s = new Node("stack"); this.children.push(s); return s; }
  addText(text) { const t = new Node("text", { text }); this.children.push(t); return t; }
  addImage() { const i = new Node("image"); this.children.push(i); return i; }
  addSpacer() {}
  layoutHorizontally() {} layoutVertically() {} centerAlignContent() {} bottomAlignContent() {} setPadding() {}
}
// Jede Zeile des Widgets (Stack mit Hintergrund) als Textzeile ausgeben.
function render(node, depth = 0, out = []) {
  const own = [];
  (function collect(n) { if (n.type === "text") own.push(n.text); n.children.forEach(collect); })(node);
  if (node.type === "widget") {
    node.children.forEach((c) => render(c, depth + 1, out));
    return out;
  }
  const mark = node.backgroundColor ? `[${node.backgroundColor.name}] ` : "";
  out.push(mark + own.join("  "));
  return out;
}

const files = {};
let widget;
const g = {
  Color: class { constructor(hex) { this.name = hex; } static dynamic(l) { return l; } },
  Font: new Proxy({}, { get: () => () => ({}) }),
  Size: class {},
  SFSymbol: { named: () => ({}) },
  ListWidget: class extends Node { constructor() { super("widget"); } },
  FileManager: {
    local: () => ({
      cacheDirectory: () => "/cache", joinPath: (a, b) => `${a}/${b}`,
      fileExists: (p) => p in files, readString: (p) => files[p], writeString: (p, s) => { files[p] = s; },
    }),
  },
  Request: class {
    constructor(url) { this.url = url; }
    async loadJSON() {
      const body = execFileSync("curl", ["-sS", "-m", "40", this.url], { maxBuffer: 50e6 }).toString();
      console.error(`GET ${this.url.split("?")[0]} → ${(body.length / 1024).toFixed(0)} KB`);
      return JSON.parse(body);
    }
  },
  config: { runsInWidget: true, widgetFamily: family },
  args: { widgetParameter: param },
  Script: { setWidget: (w) => { widget = w; }, complete: () => {} },
};

(async () => {
  const names = Object.keys(g);
  await new Function(...names, `return (async () => {\n${SCRIPT}\n})();`)(...names.map((n) => g[n]));
  console.log(render(widget).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
