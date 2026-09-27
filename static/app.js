"use strict";
// Study Hub front end: sidebar tree, Markdown + KaTeX reader, search, Ask panel.
// All data comes from server.py; nothing here knows about specific courses.

const $ = (s) => document.querySelector(s);
const state = {
  tree: [],
  path: null,        // repo-relative path of the open document
  course: null,      // course object the open document belongs to
  week: null,        // week number of the open document, or null
  guide: null,       // parsed week guide (topics) when a guide is open
  view: null,        // -1 = guide overview, n = topic index
  session: null,     // Ask thread id
};

// ------------------------------------------------------------ rendering

function slug(text) {
  return text.toLowerCase().replace(/MATHTOKEN\d+X/g, "").replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
}

function renderMarkdown(md, course, docPath) {
  const code = [], math = [];
  // Point relative image paths at the hub before the HTML exists, so the browser never
  // requests the unresolved path (it starts loading <img> as soon as it's parsed).
  if (docPath) {
    const dir = docPath.split("/").slice(0, -1);
    md = md.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => {
      if (/^[a-z]+:|^\//i.test(src)) return m;
      const parts = [...dir];
      for (const seg of src.split("/")) { if (seg === "..") parts.pop(); else if (seg && seg !== ".") parts.push(seg); }
      return `![${alt}](/api/img?path=${encodeURIComponent(parts.join("/"))})`;
    });
  }
  // Keep code verbatim so dollar signs inside it are never read as math.
  let src = md.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => { code.push(m); return `CODETOKEN${code.length - 1}X`; });
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => { math.push([t, true]); return `MATHTOKEN${math.length - 1}X`; });
  src = src.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g,
    (_, pre, t) => { math.push([t, false]); return `${pre}MATHTOKEN${math.length - 1}X`; });
  src = src.replace(/CODETOKEN(\d+)X/g, (_, i) => code[+i]);

  const box = document.createElement("div");
  box.innerHTML = marked.parse(src, { gfm: true });

  const used = new Set();
  box.querySelectorAll("h1,h2,h3,h4").forEach((h) => {
    let id = slug(h.textContent) || "section";
    while (used.has(id)) id += "-";
    used.add(id);
    h.id = id;
  });

  box.innerHTML = box.innerHTML.replace(/MATHTOKEN(\d+)X/g, (_, i) => {
    const [tex, display] = math[+i];
    try { return katex.renderToString(tex, { displayMode: display, throwOnError: false }); }
    catch { return tex; }
  });

  // ```mermaid blocks become diagrams; they're drawn once the box is in the page (drawDiagrams).
  box.querySelectorAll("pre > code.language-mermaid").forEach((c) => {
    const d = document.createElement("div");
    d.className = "mermaid";
    d.textContent = c.textContent;
    c.parentElement.replaceWith(d);
  });

  if (course) linkCitations(box, course);
  box.querySelectorAll("a[href]").forEach((a) => {
    if (/^https?:/.test(a.getAttribute("href"))) { a.target = "_blank"; a.rel = "noopener"; }
  });
  return box;
}

let mermaidReady = false;
async function drawDiagrams(root) {
  const nodes = [...root.querySelectorAll("div.mermaid:not([data-processed])")];
  if (!nodes.length || typeof mermaid === "undefined") return;
  if (!mermaidReady) {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict" });
    mermaidReady = true;
  }
  try { await mermaid.run({ nodes }); }
  catch (e) { console.warn("diagram failed", e); }
}

// Slide images sit in collapsed boxes; load them only when scrolled to.
function lazyImages(root) {
  root.querySelectorAll("img").forEach((img) => { img.loading = "lazy"; });
}

// [S&D-2 s14], [Ch1 s3–5], [U1-2 s4] become links to that PDF page.
function linkCitations(root, course) {
  const tags = course.tags || {};
  const names = Object.keys(tags).sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!names.length) return;
  const re = new RegExp(`\\[(${names.join("|")}) s(\\d+)([^\\]]*)\\]`, "g");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => n.parentElement.closest("code,pre,.katex,a") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) if (re.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const text = node.nodeValue;
    re.lastIndex = 0;
    for (let m; (m = re.exec(text));) {
      frag.append(text.slice(last, m.index));
      const a = document.createElement("a");
      a.className = "cite";
      a.href = `/api/src?path=${encodeURIComponent(tags[m[1]])}#page=${m[2]}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.title = `Open ${tags[m[1]].split("/").pop()} at slide ${m[2]}`;
      a.textContent = m[0].slice(1, -1);
      frag.append(a);
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

// ------------------------------------------------------------ navigation

function courseOf(path) { return state.tree.find((c) => path.startsWith(c.id + "/")) || null; }
function weekOf(path) { const m = path.match(/\/study\/weeks\/Week(\d+)\//); return m ? +m[1] : null; }
function docLabel(d) { return ({ guide: "Study guide", progress: "Progress & deadlines", "course-map": "Key takeaways" })[d.name] || d.title; }
const weekTitle = (w) => (w.title || "").replace(/^Week\s*\d+\s*[·:.-]\s*/i, "");

// ------------------------------------------------------------ study progress (this browser only)

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem("studyhub:" + key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { localStorage.setItem("studyhub:" + key, JSON.stringify(value)); },
};
const doneSet = (path) => new Set(store.get("done", {})[path] || []);
function setDone(path, id, on) {
  const all = store.get("done", {});
  const s = new Set(all[path] || []);
  on ? s.add(id) : s.delete(id);
  all[path] = [...s];
  store.set("done", all);
}

function navButton(doc, label) {
  const b = document.createElement("a");
  b.className = "nav-item";
  b.href = `#doc=${encodeURIComponent(doc.path)}`;
  b.textContent = label;
  b.dataset.path = doc.path;
  return b;
}

function renderNav() {
  const nav = $("#nav");
  nav.innerHTML = "";
  if (!state.tree.length) {
    nav.innerHTML = `<p class="nav-label">No courses yet. A course is any top-level folder with a <code>study/</code> folder.</p>`;
    return;
  }
  for (const c of state.tree) {
    const sec = document.createElement("section");
    sec.className = "course";
    sec.innerHTML = `<h3>${c.code}<small>${c.title}</small></h3>`;
    for (const d of c.docs) sec.append(navButton(d, docLabel(d)));

    if (c.weeks.length) {
      const g = document.createElement("div");
      g.className = "nav-group";
      g.innerHTML = `<div class="nav-label">Weeks</div>`;
      for (const w of c.weeks) {
        const guide = w.docs.find((d) => d.name === "guide");
        if (!guide) {
          const s = document.createElement("span");
          s.className = "nav-item week-item muted";
          s.innerHTML = `<span class="wk-n"></span><span class="wk-t">Guide not built yet</span>`;
          s.querySelector(".wk-n").textContent = `Week ${w.n}`;
          g.append(s);
          continue;
        }
        const a = navButton(guide, "");
        a.classList.add("week-item");
        const done = doneSet(guide.path).size;
        a.innerHTML = `<span class="wk-n"></span><span class="wk-t"></span><span class="wk-bar"><i></i></span><span class="wk-c"></span>`;
        a.querySelector(".wk-n").textContent = `Week ${w.n}`;
        a.querySelector(".wk-t").textContent = weekTitle(w);
        a.querySelector(".wk-bar i").style.width = `${w.topics ? Math.round(100 * done / w.topics) : 0}%`;
        a.querySelector(".wk-c").textContent = `${done} of ${w.topics} understood`;
        g.append(a);
      }
      sec.append(g);
    }
    for (const [label, groups] of [["Exams", c.exams], ["Labs and assignments", c.work]]) {
      if (!groups.length) continue;
      const g = document.createElement("div");
      g.className = "nav-group";
      g.innerHTML = `<div class="nav-label">${label}</div>`;
      for (const grp of groups) for (const d of grp.docs) g.append(navButton(d, `${grp.name}: ${docLabel(d)}`));
      sec.append(g);
    }
    nav.append(sec);
  }
  markCurrent();
}

// ------------------------------------------------------------ document structure

// The six per-topic sections of a week guide, and the colour family each one gets.
const PART_KINDS = {
  "from the slides": "slides", "what you need to know first": "prereq", "in plain english": "plain",
  "watch out": "watch", "sample problems": "problems", "remember": "remember",
};
const isGuidePath = (p) => /\/study\/weeks\/Week\d+\/guide\.md$/.test(p || "");
const partKind = (title) => PART_KINDS[title.trim().toLowerCase()] || "other";

// Wrap each '##' and everything under it in <section class="topic">, and each '###' block
// inside it in <div class="part part-KIND">, so topics and their sections read as units.
function structureDoc(doc) {
  const frag = document.createDocumentFragment();
  let topic = null, part = null;
  for (const node of [...doc.childNodes]) {
    if (node.tagName === "H2") {
      part = null;
      topic = document.createElement("section");
      topic.className = "topic";
      if (/^mixed review$/i.test(node.textContent.trim())) topic.classList.add("topic-review");
      topic.append(node);
      frag.append(topic);
    } else if (node.tagName === "H3" && topic) {
      part = document.createElement("div");
      part.className = `part part-${partKind(node.textContent)}`;
      part.append(node);
      topic.append(part);
    } else {
      (part || topic || frag).append(node);
    }
  }
  doc.replaceChildren(frag);
}

// Links inside a study file: '#slug' stays in this file, 'guide.md#slug' goes to another one.
function fixLinks(root, path) {
  const dir = path.split("/").slice(0, -1);
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (href.startsWith("#")) {
      if (!href.startsWith("#doc=")) a.href = `#doc=${encodeURIComponent(path)}&h=${href.slice(1)}`;
    } else if (!/^[a-z]+:|^\//i.test(href) && /\.md(#|$)/.test(href)) {
      const [file, frag] = href.split("#");
      const parts = [...dir];
      for (const seg of file.split("/")) { if (seg === "..") parts.pop(); else if (seg && seg !== ".") parts.push(seg); }
      a.href = `#doc=${encodeURIComponent(parts.join("/"))}${frag ? `&h=${frag}` : ""}`;
    }
  });
}

// ------------------------------------------------------------ week guides: one topic at a time

// A heading's id, computed from its Markdown source the same way renderMarkdown computes it
// from the rendered text (math and markup dropped), so ids match either way.
const headingSlug = (t) => slug(t.replace(/\$[^$]*\$/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));

// Split a guide into its title block and its topics, and give every heading the id it would
// have in the full document — links, search results and saved progress all use those ids.
function parseGuide(path, md) {
  const chunks = [{ title: null, lines: [], heads: [] }];
  let inCode = false;
  for (const line of md.split(/\r?\n/)) {   // guides written on Windows end lines with \r\n
    if (/^\s*```/.test(line)) inCode = !inCode;
    const m = !inCode && line.match(/^(#{1,4}) (.+)$/);
    if (m && m[1] === "##") chunks.push({ title: m[2].trim(), lines: [], heads: [] });
    const c = chunks[chunks.length - 1];
    c.lines.push(line);
    if (m) c.heads.push({ level: m[1].length, text: m[2].trim() });
  }
  const used = new Set();
  for (const c of chunks) for (const h of c.heads) {
    let id = headingSlug(h.text) || "section";
    while (used.has(id)) id += "-";
    used.add(id);
    h.id = id;
  }
  const g = { path, intro: chunks[0], topics: [], idTo: {} };
  let n = 0;
  chunks.slice(1).forEach((c, i) => {
    const mixed = /^mixed review$/i.test(c.title);
    const t = { title: c.title, md: c.lines.join("\n"), heads: c.heads, id: c.heads[0].id,
                n: mixed ? null : ++n, parts: c.heads.filter((h) => h.level === 3) };
    g.topics.push(t);
    for (const h of c.heads) g.idTo[h.id] = i;
  });
  g.total = n;
  for (const h of g.intro.heads) g.idTo[h.id] = -1;
  return g;
}

// Give rendered headings their full-document ids (renderMarkdown only saw one topic).
function applyIds(root, heads) {
  [...root.querySelectorAll("h1, h2, h3, h4")].forEach((el, i) => { if (heads[i]) el.id = heads[i].id; });
}

function renderGuideView(i) {
  const g = state.guide, doc = $("#doc");
  doc.classList.remove("wide");
  state.view = i;
  if (i < 0) {
    // Overview: title, lecture slides, every topic with its number and whether it's understood.
    const box = renderMarkdown(g.intro.lines.join("\n"), state.course, g.path);
    applyIds(box, g.intro.heads);
    doc.replaceChildren(...box.childNodes);
    addSourcesLine(doc);
    const done = doneSet(g.path);
    const list = document.createElement("ol");
    list.className = "topic-list";
    for (const t of g.topics) {
      const li = document.createElement("li");
      if (done.has(t.id)) li.classList.add("done");
      const a = document.createElement("a");
      a.href = `#doc=${encodeURIComponent(g.path)}&h=${t.id}`;
      a.innerHTML = `<span class="tl-n"></span><span class="tl-t"></span>`;
      a.querySelector(".tl-n").textContent = t.n ?? "★";
      a.querySelector(".tl-t").textContent = t.title;
      li.append(a);
      list.append(li);
    }
    const head = document.createElement("div");
    head.className = "overview-head";
    head.innerHTML = `<h2 class="overview-title">Topics</h2><span class="overview-count"></span>`;
    head.querySelector(".overview-count").textContent = `${done.size} of ${g.total} understood`;
    const start = document.createElement("a");
    start.className = "start-btn";
    const next = g.topics.find((t) => t.n && !done.has(t.id)) || g.topics[0];
    start.href = `#doc=${encodeURIComponent(g.path)}&h=${next.id}`;
    start.textContent = done.size ? `Continue with topic ${next.n ?? ""}` : "Start with topic 1";
    doc.append(head, start, list);
    renderCrumbs(null);
  } else {
    const t = g.topics[i];
    const box = renderMarkdown(t.md, state.course, g.path);
    applyIds(box, t.heads);
    structureDoc(box);
    const sec = box.querySelector("section.topic");
    if (t.n) {
      sec.dataset.n = t.n;
      const no = document.createElement("div");
      no.className = "topic-no";
      no.textContent = `Topic ${t.n} of ${g.total}`;
      sec.prepend(no);
    }
    sec.append(topicFooter(i));
    if (t.n && doneSet(g.path).has(t.id)) sec.classList.add("is-done");
    doc.replaceChildren(...box.childNodes);
    renderCrumbs(t);
    store.set("last", { path: g.path, id: t.id, topic: t.title, n: t.n ?? "",
                        course: state.course?.code, week: state.week });
  }
  lazyImages(doc);
  fixLinks(doc, g.path);
  drawDiagrams(doc);
}

// End of a topic: previous · mark understood · next (the overview sits before topic 1).
function topicFooter(i) {
  const g = state.guide, t = g.topics[i];
  const foot = document.createElement("div");
  foot.className = "topic-foot";
  const step = (j, cls, label) => {
    const target = j < 0 ? { id: g.intro.heads[0]?.id, title: "Week overview" } : g.topics[j];
    if (!target || !target.id) return document.createElement("span");
    const a = document.createElement("a");
    a.className = `step ${cls}`;
    a.href = `#doc=${encodeURIComponent(g.path)}&h=${target.id}`;
    a.innerHTML = `<small></small><span></span>`;
    a.querySelector("small").textContent = label;
    a.querySelector("span").textContent = target.title;
    return a;
  };
  let mark = document.createElement("span");
  if (t.n) {
    mark = document.createElement("button");
    mark.type = "button";
    mark.className = "mark";
    const paint = (on) => {
      mark.classList.toggle("on", on);
      mark.textContent = on ? "✓ Understood" : "Mark as understood";
      mark.setAttribute("aria-pressed", on);
      foot.parentElement?.classList.toggle("is-done", on);
    };
    paint(doneSet(g.path).has(t.id));
    mark.addEventListener("click", () => {
      const on = !mark.classList.contains("on");
      setDone(g.path, t.id, on);
      paint(on);
      document.querySelector(`.ol-topic[data-id="${CSS.escape(t.id)}"]`)?.classList.toggle("done", on);
      refreshWeekProgress();
    });
  }
  const next = i + 1 < g.topics.length ? step(i + 1, "next", "Next topic") : step(-1, "next", "Back to");
  foot.append(step(i - 1, "prev", i === 0 ? "Back to" : "Previous topic"), mark, next);
  return foot;
}

function refreshWeekProgress() {
  for (const c of state.tree) for (const w of c.weeks) {
    const guide = w.docs.find((d) => d.name === "guide");
    const a = guide && document.querySelector(`.week-item[data-path="${CSS.escape(guide.path)}"]`);
    if (!a) continue;
    const done = doneSet(guide.path).size;
    a.querySelector(".wk-bar i").style.width = `${w.topics ? Math.round(100 * done / w.topics) : 0}%`;
    a.querySelector(".wk-c").textContent = `${done} of ${w.topics} understood`;
  }
}

// Under the guide's metadata line: links to the original lecture PDFs.
function addSourcesLine(doc) {
  const w = state.course?.weeks.find((x) => x.n === state.week);
  if (!w || !w.sources.length) return;
  const p = document.createElement("p");
  p.className = "sources-line";
  p.append("Lecture slides: ");
  w.sources.forEach((s, i) => {
    const a = document.createElement("a");
    a.href = `/api/src?path=${encodeURIComponent(s.path)}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = s.name.replace(/[-_]/g, " ");
    if (i) p.append(" · ");
    p.append(a);
  });
  const h1 = doc.querySelector("h1");
  const meta = h1?.nextElementSibling;
  (meta && meta.tagName === "P" ? meta : h1)?.after(p);
}

// ------------------------------------------------------------ sidebar: numbered topic tree

function markCurrent() {
  document.querySelectorAll(".nav-item[aria-current]").forEach((e) => e.removeAttribute("aria-current"));
  document.querySelectorAll(".outline").forEach((e) => e.remove());
  spy.part = null;
  if (!state.path) return;
  const item = document.querySelector(`.nav-item[data-path="${CSS.escape(state.path)}"]`);
  if (!item) return;
  item.setAttribute("aria-current", "page");
  const g = state.guide && state.guide.path === state.path ? state.guide : null;
  if (!g) return;
  const link = (id) => `#doc=${encodeURIComponent(g.path)}&h=${id}`;
  const done = doneSet(g.path);
  const ol = document.createElement("ol");
  ol.className = "outline";
  g.topics.forEach((t, i) => {
    const li = document.createElement("li");
    li.className = "ol-topic";
    li.dataset.id = t.id;
    if (done.has(t.id)) li.classList.add("done");
    if (i === state.view) li.classList.add("current", "open");
    const row = document.createElement("div");
    row.className = "ol-row";
    const a = document.createElement("a");
    a.className = "ol-link";
    a.href = link(t.id);
    a.innerHTML = `<span class="ol-n"></span><span class="ol-t"></span>`;
    a.querySelector(".ol-n").textContent = t.n ?? "★";
    a.querySelector(".ol-t").textContent = t.title;
    row.append(a);
    li.append(row);
    if (t.parts.length) {
      const tog = document.createElement("button");
      tog.type = "button";
      tog.className = "ol-toggle";
      tog.setAttribute("aria-label", `Show sections of ${t.title}`);
      tog.addEventListener("click", () => li.classList.toggle("open"));
      row.append(tog);
      const ul = document.createElement("ul");
      ul.className = "ol-parts";
      for (const p of t.parts) {
        const sli = document.createElement("li");
        const sa = document.createElement("a");
        sa.className = `ol-part k-${partKind(p.text)}`;
        sa.href = link(p.id);
        sa.dataset.id = p.id;
        sa.textContent = p.text;
        sli.append(sa);
        ul.append(sli);
      }
      li.append(ul);
    }
    ol.append(li);
  });
  item.after(ol);
  ol.querySelector(".ol-topic.current")?.scrollIntoView({ block: "nearest" });
}

// ------------------------------------------------------------ where am I in this topic

function spy() {
  spy.raf = 0;
  const line = $("#reader").getBoundingClientRect().top + 90;
  let part = null;
  for (const h of document.querySelectorAll("#doc .part > h3")) {
    if (h.getBoundingClientRect().top <= line) part = h; else break;
  }
  const pId = part ? part.id : null;
  if (pId !== spy.part) {
    document.querySelectorAll(".ol-part.active").forEach((e) => e.classList.remove("active"));
    if (pId) document.querySelector(`.ol-part[data-id="${CSS.escape(pId)}"]`)?.classList.add("active");
    spy.part = pId;
  }
}
$("#reader").addEventListener("scroll", () => { if (!spy.raf) spy.raf = requestAnimationFrame(spy); });

async function openDoc(path, anchor) {
  const doc = $("#doc");
  const fresh = path !== state.path;
  if (fresh) {
    const r = await fetch(`/api/doc?path=${encodeURIComponent(path)}`);
    if (!r.ok) {
      doc.innerHTML = `<div class="empty"><h1>That file isn't available</h1><p>It may have been moved or deleted. Pick another file from the list.</p></div>`;
      return;
    }
    const md = await r.text();
    doc.classList.remove("wide");
    state.path = path;
    state.course = courseOf(path);
    state.week = weekOf(path);
    state.view = null;
    if (isGuidePath(path)) {
      state.guide = parseGuide(path, md);
    } else {
      state.guide = null;
      doc.replaceChildren(...renderMarkdown(md, state.course, path).childNodes);
      structureDoc(doc);
      lazyImages(doc);
      fixLinks(doc, path);
      drawDiagrams(doc);
      renderCrumbs(null);
    }
    syncAskScope();
  }
  let moved = fresh;
  if (state.guide) {
    // Which page holds the anchor: -1 = the week overview, otherwise a topic.
    const i = anchor && anchor in state.guide.idTo ? state.guide.idTo[anchor] : -1;
    if (i !== state.view) {
      renderGuideView(i);
      markCurrent();
      moved = true;
    }
  } else if (fresh) {
    markCurrent();
  }
  const el = anchor && document.getElementById(anchor);
  const isTop = !el || el.tagName === "H1" || (el.tagName === "H2" && state.guide);
  if (isTop) {
    $("#reader").scrollTo({ top: 0, behavior: "instant" });
  } else {
    const det = el.closest("details");
    if (det) det.open = true;
    el.scrollIntoView({ behavior: moved ? "instant" : "smooth" });
  }
  setTimeout(spy, moved ? 50 : 450);
}

function renderCrumbs(topic) {
  const c = state.course;
  const box = $("#crumbs");
  box.replaceChildren();
  const where = document.createElement("span");
  where.className = "where";
  const bits = [c ? c.code : ""];
  if (state.week) bits.push(`Week ${state.week}`);
  if (!isGuidePath(state.path)) {
    const d = c?.docs.find((x) => x.path === state.path);
    bits.push(d ? docLabel(d) : (state.path || "").split("/").pop().replace(/\.md$/, ""));
  }
  where.textContent = bits.filter(Boolean).join(" · ");
  box.append(where);
  if (state.guide) {
    const t = document.createElement("span");
    t.className = "here";
    t.textContent = !topic ? "Overview" : topic.n ? `Topic ${topic.n} of ${state.guide.total} — ${topic.title}` : topic.title;
    box.append(t);
  }
}

async function showHome() {
  state.path = null;
  state.course = null;
  state.guide = null;
  state.view = null;
  $("#crumbs").replaceChildren();
  markCurrent();
  const doc = $("#doc");
  doc.classList.add("wide");
  doc.innerHTML = `<div class="home"><h1>What to study next</h1><div class="home-grid" id="home-grid"></div></div>`;
  let dash = [];
  try { dash = await (await fetch("/api/dashboard")).json(); } catch { /* shown as empty below */ }
  const grid = $("#home-grid");
  if (!grid) return;

  const last = store.get("last", null);
  if (last && state.tree.some((c) => c.weeks.some((w) => w.docs.some((d) => d.path === last.path)))) {
    const a = document.createElement("a");
    a.className = "card continue";
    a.href = `#doc=${encodeURIComponent(last.path)}&h=${last.id}`;
    a.innerHTML = `<small>Continue where you left off</small><strong></strong><span></span>`;
    a.querySelector("strong").textContent = last.topic;
    a.querySelector("span").textContent = `${last.course} · Week ${last.week}${last.n ? ` · Topic ${last.n}` : ""}`;
    grid.append(a);
  }

  for (const c of state.tree) {
    const info = dash.find((x) => x.id === c.id) || { deadlines: [], due: [], weak: [] };
    const card = document.createElement("section");
    card.className = "card course-card";
    const h = document.createElement("h2");
    h.innerHTML = `<span class="code"></span><span class="title"></span>`;
    h.querySelector(".code").textContent = c.code;
    h.querySelector(".title").textContent = c.title;
    card.append(h);

    const plain = (s) => (s || "").replace(/\*\*/g, "");
    if (info.deadlines.length) {
      const ul = document.createElement("ul");
      ul.className = "deadlines";
      for (const d of info.deadlines) {
        const li = document.createElement("li");
        li.innerHTML = `<b></b><span></span>`;
        li.querySelector("b").textContent = plain(d.Date);
        li.querySelector("span").textContent = plain(d.Item);
        ul.append(li);
      }
      const lab = document.createElement("div");
      lab.className = "card-label";
      lab.textContent = "Coming up";
      card.append(lab, ul);
    }

    const prog = c.docs.find((d) => d.name === "progress");
    const rev = document.createElement(prog ? "a" : "div");
    rev.className = "reviews" + (info.due.length ? " has-due" : "");
    if (prog) rev.href = `#doc=${encodeURIComponent(prog.path)}&h=review-queue`;
    rev.textContent = info.due.length
      ? `${info.due.length} review item${info.due.length > 1 ? "s" : ""} due today`
      : "No reviews due today";
    card.append(rev);
    if (info.weak.length) {
      const wk = document.createElement("p");
      wk.className = "weak";
      wk.textContent = `Working on: ${info.weak.map(plain).join("; ")}`;
      card.append(wk);
    }

    const weeks = document.createElement("div");
    weeks.className = "card-weeks";
    for (const w of c.weeks) {
      const guide = w.docs.find((d) => d.name === "guide");
      const row = document.createElement(guide ? "a" : "div");
      row.className = "wk-row";
      if (guide) row.href = `#doc=${encodeURIComponent(guide.path)}`;
      const done = guide ? doneSet(guide.path).size : 0;
      row.innerHTML = `<span class="wk-n"></span><span class="wk-t"></span><span class="wk-bar"><i></i></span><span class="wk-c"></span>`;
      row.querySelector(".wk-n").textContent = `Week ${w.n}`;
      row.querySelector(".wk-t").textContent = guide ? weekTitle(w) : "Guide not built yet";
      row.title = guide ? `Week ${w.n}: ${weekTitle(w)}` : "";
      row.querySelector(".wk-bar i").style.width = `${w.topics ? Math.round(100 * done / w.topics) : 0}%`;
      row.querySelector(".wk-c").textContent = guide ? `${done}/${w.topics}` : "";
      weeks.append(row);
    }
    card.append(weeks);

    const links = document.createElement("div");
    links.className = "card-links";
    for (const d of c.docs) {
      const a = document.createElement("a");
      a.href = `#doc=${encodeURIComponent(d.path)}`;
      a.textContent = docLabel(d);
      links.append(a);
    }
    card.append(links);
    grid.append(card);
  }
}

function route() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("doc")) openDoc(h.get("doc"), h.get("h"));
  else showHome();
}

// ------------------------------------------------------------ search

let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(async () => {
    const box = $("#results");
    if (q.length < 2) { box.hidden = true; $("#nav").hidden = false; return; }
    const hits = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
    box.innerHTML = hits.length ? "" : `<p class="nav-label">Nothing matches "${q.replace(/</g, "&lt;")}".</p>`;
    for (const hit of hits) {
      const a = document.createElement("a");
      a.className = "result";
      a.href = `#doc=${encodeURIComponent(hit.path)}&h=${headingSlug(hit.topic || hit.heading)}`;
      const where = hit.path.split("/").slice(-2).join("/");
      a.innerHTML = `<b></b><span></span>`;
      a.querySelector("b").textContent = `${hit.course} · ${where}${hit.heading ? " · " + hit.heading : ""}`;
      a.querySelector("span").textContent = hit.text;
      box.append(a);
    }
    box.hidden = false;
    $("#nav").hidden = true;
  }, 180);
});
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.target.value = ""; e.target.dispatchEvent(new Event("input")); }
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#search").focus(); }
});

// ------------------------------------------------------------ ask panel

// One choice: what Claude answers from — a week of one course, or the whole course.
// It follows the page you're reading until you pick something else.
function fillAskScope() {
  const sel = $("#ask-scope");
  sel.innerHTML = "";
  for (const c of state.tree) {
    const grp = document.createElement("optgroup");
    grp.label = `${c.code} ${c.title}`;
    for (const w of c.weeks) {
      const title = weekTitle(w);
      grp.append(new Option(`Week ${w.n}${title ? " — " + title : ""}`, `${c.id}|week|${w.n}`));
    }
    grp.append(new Option(`All of ${c.code} (every week)`, `${c.id}|course|0`));
    sel.append(grp);
  }
}

function askScope() {
  const [course, scope, week] = ($("#ask-scope").value || "").split("|");
  return { course, scope, week: +week || 0 };
}

function syncAskScope() {
  if (!state.course) return;
  const want = state.week ? `${state.course.id}|week|${state.week}` : `${state.course.id}|course|0`;
  if ($("#ask-scope").value !== want && [...$("#ask-scope").options].some((o) => o.value === want)) {
    $("#ask-scope").value = want;
    newThread();
  }
}

function newThread() {
  state.session = null;
  $("#thread").innerHTML = `<p class="hint">Answers come from the parts of your study guide and slides that match your question, with slide citations.</p>`;
}

function addMsg(cls, content) {
  const m = document.createElement("div");
  m.className = `msg ${cls}`;
  if (typeof content === "string") m.textContent = content; else m.append(content);
  $("#thread").append(m);
  m.scrollIntoView({ block: "end" });
  return m;
}

$("#ask-scope").addEventListener("change", newThread);
$("#new-thread").addEventListener("click", newThread);
$("#question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#compose").requestSubmit(); }
});

$("#compose").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#question").value.trim();
  if (!q) return;
  const { course: courseId, scope, week } = askScope();
  const course = state.tree.find((x) => x.id === courseId);
  if (!course) return;
  // The topic on screen (if it's in the chosen scope) is always sent along with the question.
  const g = state.guide;
  const onScreen = g && state.view >= 0 && state.course?.id === courseId && (scope === "course" || state.week === week)
    ? g.topics[state.view].title : "";
  $("#question").value = "";
  $("#thread .hint")?.remove();
  addMsg("q", q);
  const wait = addMsg("wait", "Reading the material…");
  const t0 = Date.now();
  const tick = setInterval(() => { wait.textContent = `Reading the material… ${Math.round((Date.now() - t0) / 1000)} s`; }, 1000);
  $("#send").disabled = true;
  try {
    const r = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ course: courseId, week, scope, question: q, session: state.session, topic: onScreen }),
    });
    const data = await r.json();
    wait.remove();
    if (!r.ok || data.error) { addMsg("err", data.error || "The hub couldn't get an answer. Check that it's still running."); return; }
    state.session = data.session;
    const body = renderMarkdown(data.answer, course);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${(data.ms / 1000).toFixed(1)} s${data.cost != null ? ` · $${data.cost.toFixed(3)}` : ""}`;
    body.append(meta);
    drawDiagrams(addMsg("a", body));
  } catch {
    wait.remove();
    addMsg("err", "The hub isn't responding. Start it again with start.bat, then retry.");
  } finally {
    clearInterval(tick);
    $("#send").disabled = false;
  }
});

// The Ask panel is a drawer: closed by default so the reading column gets the room.
function setAsk(open) {
  $("#app").classList.toggle("ask-hidden", !open);
  $("#open-ask").hidden = open;
  store.set("askOpen", open);
  if (open) $("#question").focus();
}
$("#close-ask").addEventListener("click", () => setAsk(false));
$("#open-ask").addEventListener("click", () => setAsk(true));
setAsk(store.get("askOpen", false));
$("#home").addEventListener("click", (e) => { e.preventDefault(); location.hash = ""; });

// Phones: the course list is a slide-over menu, closed whenever you pick something.
function setNav(open) {
  $("#app").classList.toggle("nav-open", open);
  $("#menu-btn").setAttribute("aria-expanded", open);
  $("#menu-btn").textContent = open ? "✕ Close" : "☰ Topics";
}
$("#menu-btn").addEventListener("click", () => setNav(!$("#app").classList.contains("nav-open")));
window.addEventListener("hashchange", () => setNav(false));

// Network mode: this computer can show a QR code with the phone's private link.
async function setupPhoneLink() {
  let url = null;
  try { url = (await (await fetch("/api/phone")).json()).url; } catch { /* hub is local-only */ }
  if (!url || typeof qrcode === "undefined") return;
  $("#phone-btn").hidden = false;
  $("#phone-btn").addEventListener("click", () => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    $("#qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    $("#phone-url").textContent = url;
    $("#phone-dlg").showModal();
  });
}

// ------------------------------------------------------------ start

(async function init() {
  state.tree = await (await fetch("/api/tree")).json();
  renderNav();
  fillAskScope();
  setupPhoneLink();
  window.addEventListener("hashchange", route);
  route();
})();
