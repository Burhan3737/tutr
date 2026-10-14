// Drawings in tutor answers. The tutor writes one of three fenced blocks; renderMd() calls
// enhanceVisuals() on the rendered HTML and these become pictures:
//   ```mermaid  flowcharts, trees, sequence/state diagrams — drawn by Mermaid (loaded on first use)
//   ```svg      a free-form drawing — shown as an <img>, so any script inside it can never run
//   ```plot     exact function plots — the hub evaluates the functions itself and draws the chart
"use strict";

const VIS_COLORS = ["#2f5bb7", "#1f6f4a", "#b7791f", "#2b6cb0", "#8a3ffc", "#0f766e"];

// openFence: the text ends inside a ``` block that is still streaming in. That last block stays as
// plain source until it is closed; drawing half a diagram only produces an error.
function enhanceVisuals(root, openFence = false) {
  const blocks = [...root.querySelectorAll("pre > code")];
  if (openFence) blocks.pop();
  blocks.forEach((code) => {
    const lang = (code.className.match(/language-(\w+)/) || [])[1];
    const pre = code.parentElement;
    const src = code.textContent;
    try {
      if (lang === "mermaid") {
        const d = document.createElement("div");
        d.className = "diagram mermaid-box";
        d.dataset.src = src;
        d.textContent = "Drawing the diagram…";
        pre.replaceWith(d);
      } else if (lang === "svg") {
        pre.replaceWith(svgImage(src));
      } else if (lang === "plot") {
        pre.replaceWith(plotFigure(src));
      }
    } catch (e) {
      pre.before(visNote(`Couldn't draw this (${e.message}); here is its source.`));
      clientLog("visual", { lang, error: e.message, src });
    }
  });
}

// Drawing failures go to .cache/hub.log on the server (and the console), so they can be debugged later.
function clientLog(kind, detail) {
  console.warn(`[study-hub] ${kind}`, detail);
  fetch("/api/client-log", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, where: location.hash, ...detail }) }).catch(() => {});
}

function visNote(text) {
  const p = document.createElement("p");
  p.className = "vis-note";
  p.textContent = text;
  return p;
}

// ---------------------------------------------------------------- SVG (as an image: no scripts, no links)

function svgImage(src) {
  let s = src.trim();
  if (!/^<svg[\s>]/i.test(s)) throw new Error("not an <svg> element");
  if (!/xmlns=/.test(s.slice(0, 300))) s = s.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  // An SVG image is strict XML: a bare "&" (e.g. "P & Q") or an HTML <br> makes the whole picture fail.
  s = s.replace(/<br\s*\/?>/gi, " ").replace(/&nbsp;/g, "&#160;")
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/gi, "&amp;");
  const fig = document.createElement("figure");
  fig.className = "diagram svg-box";
  fig.dataset.src = s;         // the fixed-up source, for the Talk canvas to inline (inlineSvg in app.js)
  const img = document.createElement("img");
  img.alt = (s.match(/<title>([^<]*)<\/title>/i) || [])[1] || "Drawing";
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
  img.onerror = () => {
    fig.replaceWith(visNote("This drawing couldn't be shown."));
    clientLog("svg", { error: "the browser couldn't load the SVG", src });
  };
  fig.append(img);
  return fig;
}

// ---------------------------------------------------------------- Mermaid (lazy-loaded)

let mermaidLoading = null;
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!mermaidLoading) {
    mermaidLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "vendor/mermaid.min.js";
      s.onload = () => {
        const dark = matchMedia("(prefers-color-scheme: dark)").matches;
        window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral",
          fontFamily: "Segoe UI, system-ui, sans-serif" });
        resolve(window.mermaid);
      };
      s.onerror = () => reject(new Error("diagram library didn't load"));
      document.head.append(s);
    });
  }
  return mermaidLoading;
}

let mermaidSeq = 0;
async function drawMermaid() {
  const boxes = [...document.querySelectorAll(".mermaid-box:not([data-drawn])")].filter((b) => b.isConnected);
  if (!boxes.length) return;
  boxes.forEach((b) => { b.dataset.drawn = "1"; });
  let m;
  try { m = await loadMermaid(); } catch (e) { boxes.forEach((b) => b.replaceWith(visNote(e.message))); return; }
  for (const b of boxes) {
    const id = `mmd-${++mermaidSeq}`;
    try {
      await m.parse(b.dataset.src);       // syntax check first: it touches no page content
      const { svg } = await m.render(id, b.dataset.src);
      b.innerHTML = svg;
    } catch (e) {
      // Mermaid 10 leaves its "Syntax error in text" picture in <body> when render() fails.
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
      clientLog("mermaid", { error: String(e?.message || e), src: b.dataset.src });
      const pre = document.createElement("pre");
      pre.textContent = b.dataset.src;
      b.replaceChildren(visNote("Couldn't draw this diagram; here is its source."), pre);
    }
  }
}

// Draw any diagram as soon as it lands on the page (answers, practice, notes, print view).
let mermaidTimer = null;
new MutationObserver(() => {
  if (!document.querySelector(".mermaid-box:not([data-drawn])")) return;
  clearTimeout(mermaidTimer);
  mermaidTimer = setTimeout(drawMermaid, 60);
}).observe(document.documentElement, { childList: true, subtree: true });

// ---------------------------------------------------------------- function plots
// ```plot
// f: 100 - 2*x, 3*x
// x: 1..64
// y: log          (optional: logarithmic y axis, or a range like 0..500)
// title: Growth rates
// ```

function plotFigure(src) {
  const spec = {};
  for (const line of src.split("\n")) {
    const m = line.match(/^\s*(\w+)\s*:\s*(.+?)\s*$/);
    if (m) spec[m[1].toLowerCase()] = m[2];
  }
  if (!spec.f) throw new Error("no f: line");
  const exprs = splitTop(spec.f).map((s) => s.trim()).filter(Boolean).slice(0, 6);
  const fns = exprs.map((e) => ({ label: e, fn: compileExpr(e) }));
  const [x0, x1] = range(spec.x || "1..64");
  const logY = /^log/i.test(spec.y || "");
  const yRange = spec.y && !logY ? range(spec.y) : null;
  const N = 240;
  const series = fns.map(({ label, fn }) => {
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const x = x0 + (x1 - x0) * i / N;
      const y = fn(x);
      if (Number.isFinite(y) && (!logY || y > 0)) pts.push([x, y]);
    }
    return { label, pts };
  });
  let ys = series.flatMap((s) => s.pts.map((p) => p[1]));
  if (!ys.length) throw new Error("nothing to plot in that range");
  let y0 = yRange ? yRange[0] : Math.min(0, ...ys), y1 = yRange ? yRange[1] : Math.max(...ys);
  if (logY) { y0 = Math.min(...ys); y1 = Math.max(...ys); }
  if (y1 === y0) y1 = y0 + 1;
  return drawPlot(series, { x0, x1, y0, y1, logY, title: spec.title || "", xLabel: spec.xlabel || (/\bn\b/.test(spec.f) ? "n" : "x") });
}

function range(s) {
  const m = String(s).match(/^\s*(-?[\d.e+]+)\s*(?:\.\.|to|,|–|-)\s*(-?[\d.e+]+)\s*$/i);
  if (!m) throw new Error(`can't read the range "${s}"`);
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  if (!(b > a)) throw new Error("the range must go from small to large");
  return [a, b];
}

function splitTop(s) {     // split on commas that aren't inside parentheses
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const SVGNS = "http://www.w3.org/2000/svg";
function el(tag, attrs, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

function niceTicks(a, b, count = 5) {
  const span = b - a, step0 = span / count, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= count) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(a / step) * step; v <= b + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

function fmt(v) {
  const a = Math.abs(v);
  if (a >= 1e6 || (a > 0 && a < 1e-3)) return v.toExponential(0).replace("e+", "e");
  if (a >= 1000) return Math.round(v).toLocaleString();
  return String(+v.toPrecision(3));
}

function drawPlot(series, o) {
  const W = 560, H = 320, L = 56, R = 16, T = o.title ? 34 : 14, B = 44 + 18 * Math.ceil(series.length / 3);
  const toY = o.logY ? (y) => Math.log10(y) : (y) => y;
  const ya = toY(o.y0), yb = toY(o.y1);
  const sx = (x) => L + (x - o.x0) / (o.x1 - o.x0) * (W - L - R);
  const sy = (y) => { const v = (toY(y) - ya) / (yb - ya); return T + (1 - Math.max(-0.05, Math.min(1.05, v))) * (H - T - B); };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "plot", role: "img", "aria-label": o.title || "Plot" });
  if (o.title) svg.append(el("text", { x: W / 2, y: 20, class: "plot-title", "text-anchor": "middle" }, o.title));
  const clip = el("clipPath", { id: `clip${Math.random().toString(36).slice(2, 8)}` });
  clip.append(el("rect", { x: L, y: T, width: W - L - R, height: H - T - B }));
  svg.append(clip);
  // grid and ticks
  for (const x of niceTicks(o.x0, o.x1)) {
    svg.append(el("line", { x1: sx(x), x2: sx(x), y1: T, y2: H - B, class: "plot-grid" }));
    svg.append(el("text", { x: sx(x), y: H - B + 16, class: "plot-tick", "text-anchor": "middle" }, fmt(x)));
  }
  const yTicks = o.logY
    ? Array.from({ length: Math.floor(yb) - Math.ceil(ya) + 1 }, (_, i) => Math.pow(10, Math.ceil(ya) + i))
    : niceTicks(o.y0, o.y1);
  for (const y of yTicks) {
    svg.append(el("line", { x1: L, x2: W - R, y1: sy(y), y2: sy(y), class: "plot-grid" }));
    svg.append(el("text", { x: L - 6, y: sy(y) + 4, class: "plot-tick", "text-anchor": "end" }, fmt(y)));
  }
  svg.append(el("line", { x1: L, x2: W - R, y1: H - B, y2: H - B, class: "plot-axis" }));
  svg.append(el("line", { x1: L, x2: L, y1: T, y2: H - B, class: "plot-axis" }));
  svg.append(el("text", { x: (L + W - R) / 2, y: H - B + 32, class: "plot-tick", "text-anchor": "middle" }, o.xLabel + (o.logY ? "   (log scale on y)" : "")));
  // curves
  const g = el("g", { "clip-path": `url(#${clip.id})` });
  series.forEach((s, i) => {
    if (!s.pts.length) return;
    const d = s.pts.map((p, j) => `${j ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join("");
    g.append(el("path", { d, fill: "none", stroke: VIS_COLORS[i % VIS_COLORS.length], "stroke-width": 2.25 }));
  });
  svg.append(g);
  // legend
  series.forEach((s, i) => {
    const lx = L + (i % 3) * ((W - L - R) / 3), ly = H - B + 50 + Math.floor(i / 3) * 18;
    svg.append(el("rect", { x: lx, y: ly - 9, width: 14, height: 4, rx: 2, fill: VIS_COLORS[i % VIS_COLORS.length] }));
    svg.append(el("text", { x: lx + 20, y: ly - 3, class: "plot-legend" }, s.label));
  });
  const fig = document.createElement("figure");
  fig.className = "diagram plot-box";
  fig.append(svg);
  return fig;
}

// ---------------------------------------------------------------- a small, safe expression compiler
// Numbers, n or x, + - * / ^, parentheses, implicit multiplication (2n, 3 sqrt(x)), and the functions
// below. "log" and "lg" are base 2 (the convention in computer science). No eval, no access to anything else.

const VIS_FUNCS = {
  log2: Math.log2, lg: Math.log2, log: Math.log2, ln: Math.log, log10: Math.log10, sqrt: Math.sqrt, exp: Math.exp,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, sin: Math.sin, cos: Math.cos, min: Math.min, max: Math.max,
  fact: (k) => { if (k < 0 || k > 170) return NaN; let r = 1; for (let i = 2; i <= Math.floor(k); i++) r *= i; return r; },
};
const VIS_CONSTS = { pi: Math.PI, e: Math.E };

function compileExpr(src) {
  const toks = src.replace(/·|×/g, "*").replace(/−/g, "-").match(/\d*\.?\d+(?:e[+-]?\d+)?|[A-Za-z_]\w*|[-+*/^(),!]/g);
  if (!toks || toks.join("") !== src.replace(/\s+/g, "").replace(/·|×/g, "*").replace(/−/g, "-")) throw new Error(`can't read "${src}"`);
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const startsPrimary = (t) => t != null && (/^[\d.]/.test(t) || /^[A-Za-z_]/.test(t) || t === "(");
  function expr() {
    let f = term();
    while (peek() === "+" || peek() === "-") {
      const op = next(), a = f, b = term();
      f = op === "+" ? (x) => a(x) + b(x) : (x) => a(x) - b(x);
    }
    return f;
  }
  function term() {
    let f = power();
    for (;;) {
      if (peek() === "*" || peek() === "/") {
        const op = next(), a = f, b = power();
        f = op === "*" ? (x) => a(x) * b(x) : (x) => a(x) / b(x);
      } else if (startsPrimary(peek())) {           // implicit multiplication: 2n, 3 sqrt(x)
        const a = f, b = power();
        f = (x) => a(x) * b(x);
      } else return f;
    }
  }
  function power() {
    const base = unary();
    if (peek() === "^") { next(); const ex = power(); return (x) => Math.pow(base(x), ex(x)); }
    return base;
  }
  function unary() {
    if (peek() === "-") { next(); const a = unary(); return (x) => -a(x); }
    if (peek() === "+") { next(); return unary(); }
    let f = primary();
    while (peek() === "!") { next(); const a = f; f = (x) => VIS_FUNCS.fact(a(x)); }
    return f;
  }
  function primary() {
    const t = next();
    if (t == null) throw new Error("unexpected end");
    if (/^[\d.]/.test(t)) { const v = parseFloat(t); return () => v; }
    if (t === "(") { const f = expr(); if (next() !== ")") throw new Error("missing )"); return f; }
    if (/^[A-Za-z_]/.test(t)) {
      const name = t.toLowerCase();
      if (name === "n" || name === "x") return (x) => x;
      if (name in VIS_CONSTS) { const v = VIS_CONSTS[name]; return () => v; }
      if (name in VIS_FUNCS) {
        if (next() !== "(") throw new Error(`${name} needs (…)`);
        const args = [expr()];
        while (peek() === ",") { next(); args.push(expr()); }
        if (next() !== ")") throw new Error("missing )");
        const fn = VIS_FUNCS[name];
        return (x) => fn(...args.map((a) => a(x)));
      }
      throw new Error(`unknown name "${t}"`);
    }
    throw new Error(`unexpected "${t}"`);
  }
  const f = expr();
  if (i !== toks.length) throw new Error(`unexpected "${toks[i]}"`);
  return f;
}
