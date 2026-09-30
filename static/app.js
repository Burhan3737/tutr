// Study Hub — slide-first study with a tutor. Course → Topic → Deck → Slide.
// Routes (hash): "" home · c=ID course · c=ID&d=TAG&s=N slide · c=ID&notes=PATH class notes ·
//                review=ID reviews · upload=PID phone photo page
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
  return e;
};
// Let replaceChildren/append skip null/false, so "cond ? el : null" can be passed straight in.
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const name of ["replaceChildren", "append"]) {
    const orig = proto[name];
    proto[name] = function (...kids) { return orig.apply(this, kids.flat().filter((k) => k != null && k !== false)); };
  }
}
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const isPhone = () => matchMedia("(max-width: 760px)").matches;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function api(path, body) {
  const opt = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
  let r;
  try { r = await fetch(path, opt); } catch { throw new Error("The hub isn't responding. Start it again with start.bat, then retry."); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

// POST that streams: the server sends "status" lines and "text" deltas as Server-Sent Events, then
// "done" with the final result (or "error"). on = { status(text), text(delta) }.
async function apiStream(path, body, on = {}) {
  let r;
  try {
    r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, stream: true }) });
  } catch { throw new Error("The hub isn't responding. Start it again with start.bat, then retry."); }
  if (!r.ok || !(r.headers.get("content-type") || "").includes("event-stream")) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || "Something went wrong. Try again.");
  }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "", final = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = "message", data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) ev = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      const val = data ? JSON.parse(data) : null;
      if (ev === "done") final = val;
      else if (ev === "error") throw new Error((val && val.error) || "Something went wrong. Try again.");
      else if (on[ev]) on[ev](val);
    }
  }
  if (!final) throw new Error("The answer was cut off. Try again.");
  return final;
}

const APP = {
  home: null, courses: {}, deck: null, n: 1, tutor: "closed", pending: null, text: false, zoom: false,
  model: null, models: [], phoneUrl: null,
  session: store.get("session", null),
};
const STEPS = [["review", "Review"], ["new", "New slides"], ["practise", "Practise"], ["mix", "Mixed"], ["note", "Note"]];

// ------------------------------------------------------------ markdown + math

function renderMd(md, courseId) {
  const code = [], math = [];
  let src = String(md || "").replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => { code.push(m); return `CODETOKEN${code.length - 1}X`; });
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => { math.push([t, true]); return `MATHTOKEN${math.length - 1}X`; });
  src = src.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (_, pre, t) => { math.push([t, false]); return `${pre}MATHTOKEN${math.length - 1}X`; });
  src = src.replace(/CODETOKEN(\d+)X/g, (_, i) => code[+i]);
  const box = document.createElement("div");
  box.innerHTML = marked.parse(src, { gfm: true, breaks: false });
  box.innerHTML = box.innerHTML.replace(/MATHTOKEN(\d+)X/g, (_, i) => {
    const [tex, display] = math[+i];
    try { return katex.renderToString(tex, { displayMode: display, throwOnError: false }); } catch { return esc(tex); }
  });
  box.querySelectorAll("a[href]").forEach((a) => {
    if (/^https?:/.test(a.getAttribute("href"))) {
      a.target = "_blank"; a.rel = "noopener";
      try { if (a.textContent.trim() === a.href || /^https?:/.test(a.textContent)) a.textContent = new URL(a.href).hostname.replace(/^www\./, ""); } catch { /* keep */ }
    }
  });
  if (courseId) linkCitations(box, courseId);
  return box;
}

function courseTags(courseId) {
  const c = APP.courses[courseId];
  return c ? c.topics.flatMap((t) => t.decks.map((d) => d.tag)) : [];
}

// [S&D-2 s14] / [S&D-2 s14–s16] become chips that open the slide.
function linkCitations(root, courseId) {
  const tags = courseTags(courseId).sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!tags.length) return;
  const re = new RegExp(`\\[(${tags.join("|")}) s(\\d+)([^\\]]*)\\]`, "g");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => n.parentElement.closest("code,pre,.katex,a,button") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) { re.lastIndex = 0; if (re.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode); }
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    const text = node.nodeValue;
    let last = 0;
    re.lastIndex = 0;
    for (let m; (m = re.exec(text));) {
      frag.append(text.slice(last, m.index));
      const [tag, n] = [m[1], +m[2]];
      frag.append(h("button", { class: "cite", type: "button", title: `Open ${tag} slide ${n}`,
        onclick: () => go({ c: courseId, d: tag, s: n }) }, m[0].slice(1, -1)));
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

// ------------------------------------------------------------ routing

function params() { return Object.fromEntries(new URLSearchParams(location.hash.slice(1))); }
function go(p) {
  const hash = "#" + new URLSearchParams(Object.entries(p).filter(([, v]) => v != null && v !== "")).toString();
  if (location.hash === hash) route(); else location.hash = hash;
}

async function loadCourse(id, fresh) {
  if (!APP.courses[id] || fresh) APP.courses[id] = await api(`/api/course?id=${encodeURIComponent(id)}`);
  return APP.courses[id];
}

let routeToken = 0;
async function route() {
  const p = params();
  const token = ++routeToken;
  closeMenu();
  renderSessionBar();
  const main = $("#main");
  try {
    if (p.upload) return await showUpload(p.upload);
    if (p.chat) return await showOldChat(p.chat, token);
    if (p.review) return await showReview(p.review, token);
    if (p.c && p.d) return await showViewer(p.c, p.d, +p.s || 0, token);
    if (p.c && p.notes) return await showNotes(p.c, p.notes, token);
    if (p.c) return await showCourse(p.c, token);
    if (p.step === "note") return showNoteStep();
    return await showHome(token);
  } catch (e) {
    if (token !== routeToken) return;
    main.replaceChildren(h("div", { class: "page" }, h("p", { class: "err" }, e.message)));
  }
}

function setCrumbs(...parts) {
  const nav = $("#crumbs");
  nav.replaceChildren();
  if (APP.session && !params().upload) {
    const c = APP.courses[APP.session.course];
    nav.append(h("span", { class: "here" }, `Session${c ? " · " + c.code : ""}`),
      h("button", { class: "link quiet end-session", type: "button", onclick: endSession }, "End session"));
    return;
  }
  parts.filter(Boolean).forEach((p, i, arr) => {
    if (i) nav.append(h("span", { class: "sep" }, "›"));
    nav.append(i === arr.length - 1 ? h("span", { class: "here" }, p.label) : h("a", { href: p.href }, p.label));
  });
}

// ------------------------------------------------------------ home

function whenText(a) {
  if (!a) return "";
  if (a.days == null) return a.date_text;
  const d = a.days === 0 ? "today" : a.days === 1 ? "tomorrow" : `${a.days} days`;
  return (a.approx ? "~" : "") + (a.days <= 1 ? d : `in ${d}`);
}

function dotsFor(course) {
  const decks = course.topics.flatMap((t) => t.decks).filter((d) => d.slides > 1);
  const solved = decks.filter((d) => d.state === "solved").length;
  return h("span", { class: "dots", title: `${solved} of ${decks.length} decks solved`, "aria-label": `${solved} of ${decks.length} decks solved` },
    course.topics.flatMap((t) => t.decks).filter((d) => d.slides > 1).map((d) => h("span", { class: `dot ${d.state}`, title: `${d.tag}: ${d.state}` })));
}

async function showHome(token) {
  const data = await api("/api/home");
  if (token !== routeToken) return;
  setCrumbs();
  APP.home = data;
  data.courses.forEach((c) => { APP.courses[c.id] = c; });
  const main = $("#main");
  const sug = data.courses.find((c) => c.id === data.suggested) || data.courses[0];
  const page = h("div", { class: "page" });
  if (sug) {
    const a = sug.next;
    page.append(h("p", { class: "next-line" }, a
      ? [h("b", {}, `${sug.code} ${a.name}`), ` · ${whenText(a)}`, a.topics.length ? ` · ${a.topics.join(", ")}` : ""]
      : "No upcoming tests found in your deadlines."));
    page.append(h("button", { class: "btn big", type: "button", onclick: () => startSession(sug.id) }, `Start session · ${sug.code}`));
    page.append(h("p", { class: "under" }, reviewLine(sug)));
  }
  const list = h("div", { class: "courses" });
  for (const c of data.courses) {
    const a = c.next;
    list.append(h("a", { class: "course-row", href: `#c=${encodeURIComponent(c.id)}` },
      h("span", { class: "name" }, h("b", {}, `${c.code} ${c.title}`),
        h("span", { class: "sub" }, a ? `${a.name} ${whenText(a)}` : `${c.topics.length} topics`)),
      dotsFor(c), h("span", { class: "go-arrow", "aria-hidden": "true" }, "›")));
  }
  page.append(list);
  main.replaceChildren(page);
  main.focus({ preventScroll: true });
}

function reviewLine(c) {
  const r = c.reviews;
  if (r.count && r.warmup === r.count) return [`Warm-up: basic maths · ${r.count} · ~${r.minutes} min · `, h("a", { href: `#review=${encodeURIComponent(c.id)}` }, "Do them now")];
  if (r.count) return [`${r.count} quick review${r.count === 1 ? "" : "s"} · ~${r.minutes} min first · `, h("a", { href: `#review=${encodeURIComponent(c.id)}` }, "Just the reviews")];
  const res = c.resume;
  return res ? ["Nothing due. ", h("a", { href: `#c=${encodeURIComponent(c.id)}&d=${encodeURIComponent(res.deck)}&s=${res.slide}` }, `Pick up at ${res.deck} →`)] : "Nothing due.";
}

// ------------------------------------------------------------ course page

async function showCourse(id, token) {
  const c = await loadCourse(id, true);
  if (token !== routeToken) return;
  const p = params();
  setCrumbs({ label: "Home", href: "#" }, { label: c.code });
  const page = h("div", { class: "page" });
  page.append(h("h1", { class: "page-title" }, c.code), h("p", { class: "page-sub" }, c.title));
  if (c.next) page.append(h("p", { class: "next-line", style: "text-align:left" }, h("b", {}, c.next.name), ` · ${whenText(c.next)}`,
    c.next.topics.length ? ` · covers ${c.next.topics.join(", ")}` : "", c.next.assumed ? " (scope assumed)" : ""));
  const res = c.resume;
  const actions = h("div", {},
    h("button", { class: "btn block", type: "button", onclick: () => startSession(id) }, "Start session"),
    h("p", { class: "under", style: "text-align:left" }, reviewLine(c)),
    res ? h("a", { class: "link", href: `#c=${encodeURIComponent(id)}&d=${encodeURIComponent(res.deck)}&s=${res.slide}` },
      `Continue reading: ${res.deck} · slide ${res.slide} ›`) : null);
  page.append(actions);
  const topics = h("div", { class: "topics" });
  const openTopic = p.t || (res && findDeck(c, res.deck)?.topic);
  for (const t of c.topics) {
    const solved = t.decks.filter((d) => d.state === "solved").length;
    const box = h("section", { class: "topic" + (t.name === openTopic ? " open" : "") });
    const btn = h("button", { type: "button", "aria-expanded": String(t.name === openTopic),
      onclick: () => { box.classList.toggle("open"); btn.setAttribute("aria-expanded", box.classList.contains("open")); } },
      h("span", { class: "caret", "aria-hidden": "true" }, "›"), h("b", {}, t.name),
      h("span", { class: "muted small", title: `${solved} of ${t.decks.length} decks solved` }, `${solved}/${t.decks.length}`));
    const decks = h("div", { class: "decks" });
    for (const d of t.decks) {
      decks.append(h("a", { class: "deck-row", href: `#c=${encodeURIComponent(id)}&d=${encodeURIComponent(d.tag)}&s=${d.last || 1}` },
        h("span", { class: `dot ${d.state}`, title: stateLabel(d.state) }),
        h("span", { class: "t" }, h("b", {}, d.tag), ` · ${d.title}`),
        h("span", { class: "chip week" }, `W${d.week}`),
        h("span", { class: "meta" }, d.state === "read" ? "Solve one to finish" : `${d.slides} slides`)));
    }
    if (t.read_more) decks.append(h("p", { class: "read-more" }, `Textbook: ${t.read_more}`));
    box.append(btn, decks);
    topics.append(box);
  }
  page.append(topics);
  if (c.notes.length) {
    page.append(h("p", { class: "notes-line" }, "Your class notes: ",
      ...c.notes.map((n, i) => {
        const k = c.notes.slice(0, i).filter((x) => x.week === n.week).length;
        return h("a", { href: `#c=${encodeURIComponent(id)}&notes=${encodeURIComponent(n.path)}` }, `W${n.week}${k ? ` (${k + 1})` : ""}`);
      })));
  }
  const label = { exams: "Mock tests & cheat sheets", labs: "Labs", assignments: "Assignments" };
  for (const kind of ["exams", "labs", "assignments"]) {
    const groups = c.docs.filter((g) => g.kind === kind);
    if (!groups.length) continue;
    page.append(h("p", { class: "notes-line" }, `${label[kind]}: `,
      ...groups.flatMap((g) => [h("span", { class: "muted" }, `${g.name} `),
        ...g.files.map((f) => h("a", { href: `#c=${encodeURIComponent(id)}&notes=${encodeURIComponent(f.path)}` }, f.name))])));
  }
  $("#main").replaceChildren(page);
  if (p.t) $(".topic.open")?.scrollIntoView({ block: "center" });
}

const stateLabel = (s) => ({ new: "Not started", started: "Started", read: "Read · solve one to finish", solved: "Solved" })[s] || s;
function findDeck(c, tag) { for (const t of c.topics) for (const d of t.decks) if (d.tag === tag) return d; return null; }
function courseDeckOrder(c) { return c.topics.flatMap((t) => t.decks).sort((a, b) => a.week - b.week); }

async function showNotes(id, path, token) {
  const c = await loadCourse(id);
  if (token !== routeToken) return;
  const n = c.notes.find((x) => x.path === path);
  const label = n ? `Class notes W${n.week}` : path.split("/").slice(-2).join(" · ").replace(/\.md$/, "");
  setCrumbs({ label: "Home", href: "#" }, { label: c.code, href: `#c=${encodeURIComponent(id)}` }, { label });
  const r = await fetch(`/api/note?course=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`);
  const text = r.ok ? await r.text() : "Not found.";
  if (token !== routeToken) return;
  const body = path.endsWith(".txt") ? h("pre", { style: "white-space:pre-wrap" }, text) : renderMd(text, id);
  $("#main").replaceChildren(h("article", { class: "prose" }, body));
}

// ------------------------------------------------------------ slide viewer

async function showViewer(courseId, tag, n, token) {
  const [c, deck] = await Promise.all([loadCourse(courseId), api(`/api/deck?course=${encodeURIComponent(courseId)}&tag=${encodeURIComponent(tag)}`)]);
  if (token !== routeToken) return;
  const same = APP.deck && APP.deck.course === courseId && APP.deck.tag === tag && $(".viewer");
  APP.deck = deck;
  APP.n = Math.min(Math.max(1, n || deck.state.last || 1), deck.slides + 1);
  setCrumbs({ label: "Home", href: "#" }, { label: c.code, href: `#c=${encodeURIComponent(courseId)}` },
    { label: deck.topic, href: `#c=${encodeURIComponent(courseId)}&t=${encodeURIComponent(deck.topic)}` }, { label: `${deck.tag} (W${deck.week})` });
  if (!same) buildViewer();
  showSlide();
  if (APP.pending) { const p = APP.pending; APP.pending = null; startPracticeInPanel(p); }
  else if (!same) renderTutor();
}

function buildViewer() {
  const stage = h("section", { class: "stage", id: "stage" },
    h("div", { class: "stage-main", id: "stage-main" }),
    h("div", { class: "stage-foot" },
      h("span", { class: "asked", id: "asked" }),
      h("span", { class: "mob-arrows" },
        h("button", { type: "button", "aria-label": "Previous slide", onclick: () => step(-1) }, "‹"),
        h("span", { class: "counter", id: "counter-m" }),
        h("button", { type: "button", "aria-label": "Next slide", onclick: () => step(1) }, "›")),
      h("span", { class: "counter", id: "counter" }),
      h("button", { class: "chip outline", id: "text-btn", type: "button", "aria-pressed": "false", title: "Slide text (T)", onclick: () => toggleText() }, "Text")),
    h("button", { class: "nav-arrow prev", id: "prev", type: "button", "aria-label": "Previous slide (←)", onclick: () => step(-1) }, "‹"),
    h("button", { class: "nav-arrow next", id: "next", type: "button", "aria-label": "Next slide (→)", onclick: () => step(1) }, "›"),
    h("div", { class: "transcript", id: "transcript", hidden: true }, h("div", { class: "inner", id: "transcript-inner" })));
  const tutor = h("aside", { class: "tutor", id: "tutor", "aria-label": "Tutor" });
  $("#main").replaceChildren(h("div", { class: "viewer" }, stage, tutor));
  const sm = $("#stage-main");
  let x0 = null, y0 = null;
  sm.addEventListener("touchstart", (e) => { if (e.touches.length === 1) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; } }, { passive: true });
  sm.addEventListener("touchend", (e) => {
    if (x0 == null || APP.zoom) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    x0 = null;
  });
  sm.addEventListener("dblclick", () => toggleZoom());
  sm.addEventListener("click", (e) => { if (isPhone() && e.target.classList.contains("slide-img")) toggleZoom(); });
  stageObserver.disconnect();
  stageObserver.observe(sm);
  APP.text = false; APP.zoom = false;
  if (APP.tutor === "focus") APP.tutor = "open";
}

function slideUrl(n) { return `/api/slide?course=${encodeURIComponent(APP.deck.course)}&tag=${encodeURIComponent(APP.deck.tag)}&n=${n}`; }

let seenTimer;
function showSlide() {
  const d = APP.deck, n = APP.n, sm = $("#stage-main");
  if (!sm) return;
  const end = n > d.slides;
  sm.classList.toggle("zoomed", false); APP.zoom = false;
  if (end) {
    const c = APP.courses[d.course];
    const order = c ? courseDeckOrder(c) : [];
    const i = order.findIndex((x) => x.tag === d.tag);
    const nextDeck = order[i + 1];
    sm.classList.remove("portrait");
    $("#tutor")?.classList.add("quiet-rail");
    sm.replaceChildren(h("div", { class: "end-card" },
      h("h2", {}, `End of ${d.tag}`),
      h("p", {}, d.state.solved ? "You've solved a problem from this deck." : "Solve one problem from it to finish the deck."),
      h("button", { class: "btn", type: "button", onclick: () => startPracticeInPanel({ kind: "deck" }) }, "Try one"),
      h("br"),
      nextDeck ? h("a", { class: "link", href: `#c=${encodeURIComponent(d.course)}&d=${encodeURIComponent(nextDeck.tag)}&s=1` }, `Next deck: ${nextDeck.tag} ›`) : null));
  } else {
    $("#tutor")?.classList.remove("quiet-rail");
    let img = $(".slide-img", sm);
    if (!img) { img = h("img", { class: "slide-img", alt: "", draggable: "false" }); sm.replaceChildren(img); }
    img.style.opacity = ".001";
    img.onload = () => { fitSlide(); img.style.opacity = "1"; };
    const s = d.slides_text[n - 1];
    img.alt = s && s.title ? `Slide ${n}: ${s.title}` : `Slide ${n}`;
    img.src = slideUrl(n);
    if (n < d.slides) { const pre = new Image(); pre.src = slideUrl(n + 1); }
  }
  const label = end ? `${d.slides} / ${d.slides}` : `${n} / ${d.slides}`;
  $("#counter").textContent = label; $("#counter-m").textContent = label;
  $("#prev").disabled = n <= 1; $("#next").disabled = end;
  $("#text-btn").hidden = end;
  if (APP.text) fillTranscript();
  requestAnimationFrame(fitSlide);
  const hash = `#c=${encodeURIComponent(d.course)}&d=${encodeURIComponent(d.tag)}&s=${n}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
  clearTimeout(seenTimer);
  if (!end) seenTimer = setTimeout(async () => {
    try { const r = await api("/api/seen", { course: d.course, tag: d.tag, n }); d.state = r.state; } catch { /* offline */ }
  }, 500);
}

// Contain the slide in the stage, allowing up to 1.5x its native size; portrait pages (as in
// web lessons) fill a readable column and scroll instead of shrinking to fit the height.
function fitSlide() {
  const sm = $("#stage-main"), img = sm && $(".slide-img", sm);
  if (!img || !img.naturalWidth || APP.zoom) return;
  const portrait = img.naturalHeight > img.naturalWidth * 1.1;
  sm.classList.toggle("portrait", portrait);
  const cs = getComputedStyle(sm);
  const w = sm.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const hgt = sm.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const k = portrait ? Math.min(w / img.naturalWidth, 760 / img.naturalWidth, 1.5)
                     : Math.min(w / img.naturalWidth, hgt / img.naturalHeight, isPhone() ? 9 : 1.5);
  img.style.width = Math.floor(img.naturalWidth * k) + "px";
  img.style.height = "auto";
}
window.addEventListener("resize", () => fitSlide());
const stageObserver = new ResizeObserver(() => fitSlide());

function step(k) {
  if (!APP.deck) return;
  const n = Math.min(Math.max(1, APP.n + k), APP.deck.slides + 1);
  if (n === APP.n) return;
  APP.n = n;
  showSlide();
  if (APP.tutor === "open") updateTutorWhere();
}

function toggleText(on = !APP.text) {
  APP.text = on;
  $("#transcript").hidden = !on;
  $("#text-btn").setAttribute("aria-pressed", String(on));
  if (on) fillTranscript();
  requestAnimationFrame(fitSlide);
}

function fillTranscript() {
  const s = APP.deck.slides_text[APP.n - 1];
  const inner = $("#transcript-inner");
  if (!s) { inner.replaceChildren(); return; }
  inner.replaceChildren(h("h3", {}, `Slide ${s.n}${s.title ? " · " + s.title : ""}`),
    s.raw ? h("p", { class: "muted small" }, "Text layer only; equations and diagrams may be missing.") : null,
    s.raw ? h("pre", { style: "white-space:pre-wrap;font-family:inherit;background:none;padding:0" }, s.md) : renderMd(s.md, APP.deck.course));
}

function toggleZoom() {
  const sm = $("#stage-main");
  if (!sm || !$(".slide-img", sm)) return;
  APP.zoom = !APP.zoom;
  sm.classList.toggle("zoomed", APP.zoom);
  const img = $(".slide-img", sm);
  if (APP.zoom) { img.style.width = img.naturalWidth * 2 + "px"; } else fitSlide();
}

// ------------------------------------------------------------ tutor panel

function setTutor(mode) {
  APP.tutor = mode;
  const t = $("#tutor");
  if (!t) return;
  t.classList.toggle("open", mode === "open");
  t.classList.toggle("focus", mode === "focus");
  $("#stage")?.classList.toggle("shrunk", mode === "focus");
  if (mode !== "focus") restoreStage();
}

function renderTutor() {
  const t = $("#tutor");
  if (!t) return;
  if (APP.tutor === "closed") {
    setTutor("closed");
    t.replaceChildren(h("div", { class: "rail" },
      h("button", { class: "primary", type: "button", onclick: () => startPracticeInPanel({ kind: "try" }), title: "A problem on this slide" },
        h("span", { class: "go", "aria-hidden": "true" }, "✎"), "Try one"),
      h("button", { type: "button", onclick: () => { APP.tutor = "open"; renderTutor(); $("#ask-input")?.focus(); } },
        h("span", { class: "glyph", "aria-hidden": "true" }, "💬"), "Ask"),
      h("button", { type: "button", onclick: () => { APP.tutor = "open"; renderTutor(); tutorAsk("example"); } },
        h("span", { class: "glyph", "aria-hidden": "true" }, "▤"), "Example")));
    return;
  }
  setTutor("open");
  const thread = h("div", { class: "thread", id: "thread", "aria-live": "polite" });
  t.replaceChildren(h("div", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", {}, "Tutor"), h("span", { class: "muted small", id: "tutor-where" }),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Close the tutor", onclick: () => { APP.tutor = "closed"; renderTutor(); } }, "×")),
    h("div", { class: "panel-actions" },
      h("button", { class: "btn block", type: "button", onclick: () => startPracticeInPanel({ kind: "try" }) }, "Try one"),
      h("div", { class: "links" },
        h("button", { class: "link", type: "button", onclick: () => tutorAsk("example") }, "Worked example"),
        h("button", { class: "link", type: "button", onclick: () => tutorAsk("explain") }, "Explain simply"))),
    thread,
    composeBox("Ask anything about this slide", (q) => tutorAsk("ask", q))));
  updateTutorWhere();
  drawThread();
}

function updateTutorWhere() {
  const w = $("#tutor-where");
  if (w && APP.deck) w.textContent = APP.n > APP.deck.slides ? APP.deck.tag : `${APP.deck.tag} s${APP.n}`;
}

function composeBox(placeholder, onSend) {
  const ta = h("textarea", { id: "ask-input", rows: "1", placeholder, "aria-label": placeholder });
  const send = h("button", { class: "btn ghost", type: "submit" }, "Ask");
  const form = h("form", { class: "compose", onsubmit: (e) => { e.preventDefault(); const q = ta.value.trim(); if (!q) return; ta.value = ""; autosize(); send.classList.add("ghost"); onSend(q); } }, ta, send);
  const autosize = () => { ta.style.height = "auto"; ta.style.height = Math.min(160, ta.scrollHeight + 2) + "px"; };
  ta.addEventListener("input", () => { autosize(); send.classList.toggle("ghost", !ta.value.trim()); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  return form;
}

const MODE_LABEL = { explain: "Explain simply", example: "Worked example", deeper: "Go deeper" };

function drawThread() {
  const th = $("#thread");
  if (!th) return;
  th.replaceChildren();
  const msgs = APP.deck.chat ? APP.deck.chat.messages : [];
  if (!msgs.length) th.append(h("p", { class: "empty" }, "Ask anything about this slide, or tap Try one to practise it."));
  msgs.forEach((m, i) => {
    if (m.role === "q") th.append(h("p", { class: "msg-q" }, m.text, h("span", { class: "where" }, m.slide ? ` · s${m.slide}` : "")));
    else th.append(answerEl(m, i === msgs.length - 1));
  });
  th.scrollTop = th.scrollHeight;
}

function answerEl(m, isLast) {
  const body = renderMd(m.text, APP.deck.course);
  body.className = "msg-a";
  // "**Needs:** percentage change, slope of a line" becomes tappable brush-up chips.
  const raw = (m.text.match(/^\s*\**Needs:\**\s*(.+)$/im) || [])[1];
  const needsP = $$("p", body).find((p) => /^Needs:/i.test(p.textContent.trim()));
  if (raw && needsP) {
    const items = splitOutsideMath(raw).map((x) => x.replace(/\.$/, "").trim()).filter(Boolean);
    needsP.replaceWith(h("div", { class: "needs" }, "Needs:",
      ...items.map((it) => h("button", { class: "chip wrap", type: "button", title: "Brush up on this", onclick: () => tutorAsk("brush", it) }, plain(it)))));
  }
  const wrap = h("div", {}, body);
  if (isLast) {
    const next = m.mode === "example"
      ? h("button", { class: "link", type: "button", onclick: () => startPracticeInPanel({ kind: "yourturn", example_md: m.text }) }, "Your turn: finish from here ›")
      : h("button", { class: "link", type: "button", onclick: () => startPracticeInPanel({ kind: "try" }) }, "Try one on this ›");
    wrap.append(h("div", { class: "msg-foot" }, next,
      m.mode !== "deeper" ? h("button", { class: "link quiet", type: "button", onclick: () => tutorAsk("deeper") }, "Go deeper") : null));
  }
  return wrap;
}

// Split "a, b ($x, y$), c" on commas/semicolons that aren't inside $...$ or brackets.
function splitOutsideMath(t) {
  const out = [];
  let cur = "", math = false, depth = 0;
  for (const ch of t) {
    if (ch === "$") math = !math;
    if (!math && "([".includes(ch)) depth++;
    if (!math && ")]".includes(ch)) depth = Math.max(0, depth - 1);
    if (!math && !depth && (ch === "," || ch === ";")) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function inlineMd(t, courseId) {
  const box = renderMd(t, courseId);
  const p = box.firstElementChild;
  return p && p.tagName === "P" && box.children.length === 1 ? [...p.childNodes] : [...box.childNodes];
}

function metaText(m) {
  const who = APP.models.find((x) => x.id === m.model);
  return [who ? who.label.split(" — ")[0] : "", m.ms ? `${(m.ms / 1000).toFixed(0)} s` : "", m.cost != null ? `$${(+m.cost).toFixed(2)}` : ""].filter(Boolean).join(" · ");
}

async function tutorAsk(mode, question = "") {
  if (APP.tutor !== "open") { APP.tutor = "open"; renderTutor(); }
  const th = $("#thread");
  const d = APP.deck;
  const n = Math.min(APP.n, d.slides);
  $(".empty", th)?.remove();
  th.append(h("p", { class: "msg-q" }, mode === "ask" ? question : mode === "brush" ? `Brush up: ${question}` : MODE_LABEL[mode], h("span", { class: "where" }, ` · s${n}`)));
  const wait = h("p", { class: "waiting" }, mode === "example" ? "Writing a worked example…" : "Thinking…");
  th.append(wait);
  th.scrollTop = th.scrollHeight;
  $$("#thread .msg-foot").forEach((f) => f.remove());
  const live = h("div", { class: "msg-a" });
  let acc = "", queued = false;
  const paint = () => {
    queued = false;
    live.replaceChildren(...renderMd(acc, d.course).childNodes);
    if (th.scrollHeight - th.scrollTop - th.clientHeight < 160) th.scrollTop = th.scrollHeight;
  };
  try {
    const r = await apiStream("/api/tutor", { course: d.course, tag: d.tag, n, mode, question, model: APP.model, slides_only: slidesOnly(d.course) }, {
      status: (t) => { wait.textContent = `${t}…`; },
      text: (t) => {
        if (!acc) { wait.before(live); wait.textContent = "Writing…"; }
        acc += t;
        if (!queued) { queued = true; requestAnimationFrame(paint); }
      },
    });
    const chat = d.chat || { id: r.chat, title: mode === "ask" ? question : MODE_LABEL[mode] || question, updated: "", messages: [] };
    chat.messages.push({ role: "q", mode, slide: n, text: mode === "ask" ? question : mode === "brush" ? `Brush up: ${question}` : MODE_LABEL[mode] }, r.message);
    d.chat = chat;
    if (!d.asked.includes(n)) d.asked.push(n);
    if (APP.deck === d) { drawThread(); showAskedMark(); }
  } catch (e) {
    live.remove();
    wait.replaceWith(h("p", { class: "err" }, e.message));
  }
}

function showAskedMark() { /* deliberately no marker on the slide */ }

// ------------------------------------------------------------ practice

function openPractice(courseId, p) {
  APP.pending = p;
  const c = APP.courses[courseId];
  const res = c && c.resume;
  if (!res) { APP.pending = null; return; }
  if (APP.deck && APP.deck.course === courseId && $(".viewer")) { APP.pending = null; startPracticeInPanel(p); return; }
  go({ c: courseId, d: res.deck, s: res.slide });
}

function mixedTopics(courseId) {
  const c = APP.courses[courseId];
  if (!c) return null;
  if (c.next && c.next.topics.length) return c.next.topics;
  const touched = c.topics.filter((t) => t.decks.some((d) => d.state !== "new")).map((t) => t.name);
  return touched.length ? touched : null;
}

function restoreStage() {
  const sm = $("#stage-main");
  if (sm && $(".thumb", sm)) { sm.replaceChildren(); showSlide(); }
}

function startPracticeInPanel(p) {
  const d = APP.deck;
  if (!d) return;
  if (APP.session && APP.session.course === d.course && APP.session.step === 1 && ["try", "deck", "yourturn"].includes(p.kind)) {
    setSessionStep(2);
  }
  setTutor("focus");
  const sm = $("#stage-main");
  const n = Math.min(APP.n, d.slides);
  sm.classList.remove("portrait", "zoomed");
  sm.replaceChildren(h("img", { class: "thumb", src: slideUrl(n), alt: `Slide ${n}`, onclick: () => closePractice() }),
    h("span", { class: "muted small" }, `${d.tag} s${n}`),
    h("button", { class: "link", type: "button", onclick: () => closePractice() }, "‹ Back to slide"));
  const t = $("#tutor");
  const head = h("div", { class: "panel-head" }, h("h2", {}, p.kind === "mixed" ? "Mixed problem" : "Practise"),
    h("button", { class: "icon-btn", type: "button", "aria-label": "Back to the slide", onclick: () => closePractice() }, "×"));
  const area = h("div", { class: "practice" });
  t.replaceChildren(h("div", { class: "panel" }, head, area));
  const req = { course: d.course, kind: p.kind, tag: d.tag, n, example_md: p.example_md || "",
    topics: p.kind === "mixed" ? mixedTopics(d.course) : null };
  runPractice(area, req, practiceNext(p.kind));
}

function closePractice() {
  APP.tutor = "open";
  renderTutor();
}

// What the one button after marking does.
function practiceNext(kind) {
  return (result) => {
    const s = APP.session;
    const d = APP.deck;
    if (s && d && s.course === d.course) {
      if (s.step === 2 && kind !== "mixed") {
        s.practised = (s.practised || 0) + 1; saveSession();
        if (s.practised < 3) return { label: "Try another", run: () => startPracticeInPanel({ kind: kind === "yourturn" ? "try" : kind }) };
        return { label: "Next: one mixed problem", run: () => { setSessionStep(3); startPracticeInPanel({ kind: "mixed" }); } };
      }
      if (s.step === 3 || kind === "mixed") {
        if (s.step === 3) return { label: "Next: one line to remember", run: () => { setSessionStep(4); go({ step: "note" }); } };
      }
    }
    return { label: "Try another", run: () => startPracticeInPanel({ kind: kind === "yourturn" ? "try" : kind }) };
  };
}

// The practice flow: write a problem → the student works (text and/or photos, hints on request) → mark.
async function runPractice(area, req, nextFor, opts = {}) {
  const waitEl = h("p", { class: "waiting" }, opts.waitText || (req.kind === "yourturn" ? "Setting up your turn…" : "Writing a problem for you…"));
  area.replaceChildren(waitEl);
  let prob;
  try {
    prob = await apiStream("/api/practice/new", { ...req, model: APP.model, slides_only: slidesOnly(req.course) },
      { status: (t) => { waitEl.textContent = `${t}…`; } });
  } catch (e) {
    area.replaceChildren(h("p", { class: "err" }, e.message), h("button", { class: "link", type: "button", onclick: () => runPractice(area, req, nextFor, opts) }, "Try again"));
    return;
  }
  if (opts.onProblem) opts.onProblem(prob);
  const from = prob.warmup ? "Warm-up" : prob.slides ? `From ${prob.slides}` : "";
  const answer = h("textarea", { class: "answer", placeholder: "Your working… (or add a photo of it)", "aria-label": "Your working" });
  const photoCount = h("span", { class: "count" });
  const hints = h("div", {});
  let hintsUsed = 0;
  const hintBtn = h("button", { class: "link quiet", type: "button" }, "Hint");
  const check = h("button", { class: "btn", type: "button" }, "Check");
  const result = h("div", {});
  const setPhotos = (k) => { photoCount.textContent = k ? `${k} photo${k === 1 ? "" : "s"} added` : ""; };
  hintBtn.onclick = async () => {
    hintBtn.disabled = true;
    try {
      const r = await api("/api/practice/hint", { id: prob.id });
      hintsUsed = r.n;
      if (r.hint) {
        hints.append(h("div", { class: "hint-box" }, h("b", {}, `Hint ${r.n}`), renderMd(r.hint, req.course)));
        hintBtn.textContent = r.more && r.n < prob.hints_total ? "Another hint" : "Show worked example";
      } else {
        hints.append(h("div", { class: "hint-box" }, h("b", {}, "Worked solution"), renderMd(r.solution_md, req.course)));
        hintBtn.hidden = true;
      }
    } catch (e) { hints.append(h("p", { class: "err" }, e.message)); }
    hintBtn.disabled = false;
  };
  const phoneLink = APP.phoneUrl && !isPhone()
    ? h("button", { class: "link", type: "button", onclick: () => sendFromPhone(prob, setPhotos) }, "Send from phone") : null;
  check.onclick = async () => {
    check.disabled = true;
    const markEl = h("p", { class: "waiting" }, "Marking your work…");
    result.replaceChildren(markEl);
    try {
      const s = APP.session;
      const r = await apiStream("/api/practice/check", { id: prob.id, answer: answer.value, model: APP.model,
        slides_only: slidesOnly(req.course), prefetch: ["try", "deck", "mixed"].includes(req.kind), topics: req.topics },
        { status: (t) => { markEl.textContent = t === "Writing it up" ? "Writing your feedback…" : `${t}…`; } });
      if (s && r.saved && r.review_id) { s.lastMistake = r.review_id; saveSession(); }
      result.replaceChildren(resultEl(r, prob, req, nextFor, opts));
      check.hidden = true; hintBtn.hidden = true;
      const sc = result.closest(".practice, main");
      if (sc) sc.scrollTo({ top: Math.max(0, result.offsetTop - sc.offsetTop - 16), behavior: "smooth" });
      if (APP.deck) refreshDeckState();
    } catch (e) {
      result.replaceChildren(h("p", { class: "err" }, e.message));
      check.disabled = false;
    }
  };
  area.replaceChildren(
    from ? h("p", { class: "from" }, from) : null,
    h("div", { class: "problem" }, renderMd(prob.problem_md, req.course)),
    answer,
    h("div", { class: "photo-row" },
      h("button", { class: "link", type: "button", onclick: () => pickPhoto(prob, setPhotos) }, "📷 Add photo"),
      phoneLink, photoCount),
    hints,
    h("div", { class: "check-row" }, hintBtn, check),
    result);
  if (!isPhone()) answer.focus({ preventScroll: true });
}

function resultEl(r, prob, req, nextFor, opts) {
  const box = h("div", { class: "result" });
  if (r.unreadable) {
    box.append(h("p", { class: "verdict" }, r.verdict || "I couldn't read that photo."),
      h("p", { class: "muted" }, "Try a clearer photo (flat, good light), or type the key steps."));
    const again = h("button", { class: "btn", type: "button", onclick: () => { box.remove(); $$(".check-row .btn").forEach((b) => { b.hidden = false; b.disabled = false; }); } }, "Check again");
    box.append(again);
    return box;
  }
  box.append(h("p", { class: "verdict" }, r.correct ? h("span", { class: "ok" }, "✓ ") : null, ...inlineMd(r.verdict, req.course)));
  if (r.mistake) box.append(h("span", { class: "chip mistake" }, r.mistake));
  if (r.feedback_md) box.append(h("div", { class: "msg-a", style: "margin-top:8px" }, renderMd(r.feedback_md, req.course)));
  if (r.saved) box.append(h("p", { class: "saved" }, prob.review_id ? "It'll come back tomorrow." : r.hinted && r.correct ? "Solved with a hint · saved to review · back tomorrow" : "Saved to review · back tomorrow"));
  if (r.solution_md) box.append(h("details", {}, h("summary", {}, "See the full solution"), h("div", { class: "msg-a" }, renderMd(r.solution_md, req.course))));
  if (opts.afterResult) opts.afterResult(box, r);
  const nx = nextFor(r);
  if (nx) box.append(h("div", { class: "next-row" }, h("button", { class: "btn", type: "button", onclick: nx.run }, nx.label),
    nx.alt ? h("button", { class: "link quiet", type: "button", onclick: nx.alt.run }, nx.alt.label) : null));
  return box;
}

async function refreshDeckState() {
  const d = APP.deck;
  try {
    const fresh = await api(`/api/deck?course=${encodeURIComponent(d.course)}&tag=${encodeURIComponent(d.tag)}`);
    d.state = fresh.state;
    APP.courses[d.course] = await api(`/api/course?id=${encodeURIComponent(d.course)}`);
  } catch { /* keep the old state */ }
}

// ---------- photos

function pickPhoto(prob, setPhotos) {
  const input = $("#photo-input");
  input.value = "";
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    setPhotos(0);
    try {
      const data = await shrinkImage(f);
      const r = await api("/api/practice/photo", { id: prob.id, data });
      setPhotos(r.photos);
    } catch (e) { alert(e.message); }
  };
  input.click();
}

// Phones take 12-megapixel photos; 2000 px on the long side is plenty to read handwriting.
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      resolve(cv.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("That file isn't an image the browser can open."));
    img.src = URL.createObjectURL(file);
  });
}

function sendFromPhone(prob, setPhotos) {
  const url = `${APP.phoneUrl}#upload=${prob.id}`;
  const qr = qrcode(0, "M"); qr.addData(url); qr.make();
  $("#qr-title").textContent = "Send a photo from your phone";
  $("#qr-text").textContent = "Scan this with your phone's camera, take a photo of your working, and it appears here.";
  $("#qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  $("#qr-url").textContent = "";
  const dlg = $("#qr-dlg");
  dlg.showModal();
  const timer = setInterval(async () => {
    try { const r = await api(`/api/practice?id=${prob.id}`); setPhotos(r.photos); if (r.photos) dlg.close(); } catch { /* keep polling */ }
  }, 2500);
  dlg.addEventListener("close", () => clearInterval(timer), { once: true });
}

async function showUpload(pid) {
  setCrumbs({ label: "Send a photo" });
  $("#session-bar").hidden = true;
  const main = $("#main");
  let prob;
  try { prob = await api(`/api/practice?id=${encodeURIComponent(pid)}`); }
  catch (e) { main.replaceChildren(h("div", { class: "upload-page" }, h("p", { class: "err" }, e.message))); return; }
  const status = h("p", { class: "muted" }, prob.photos ? `${prob.photos} photo${prob.photos === 1 ? "" : "s"} sent so far.` : "");
  const btn = h("button", { class: "btn big", type: "button" }, "Take a photo of your working");
  btn.onclick = () => {
    const input = $("#photo-input");
    input.value = "";
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      status.textContent = "Sending…";
      try {
        const r = await api("/api/practice/photo", { id: pid, data: await shrinkImage(f) });
        status.textContent = `Sent ✓ (${r.photos} photo${r.photos === 1 ? "" : "s"}). Check your laptop, or add another.`;
        btn.textContent = "Add another photo";
      } catch (e) { status.textContent = e.message; }
    };
    input.click();
  };
  main.replaceChildren(h("div", { class: "upload-page" }, h("p", { class: "from" }, prob.slides || ""),
    h("div", { class: "problem msg-a" }, renderMd(prob.problem_md)), btn, status));
}

// Chats from the earlier Ask panel (before decks) open as a read-only page.
async function showOldChat(id, token) {
  const c = await api(`/api/chat?id=${encodeURIComponent(id)}`);
  if (token !== routeToken) return;
  setCrumbs({ label: "Home", href: "#" }, { label: "Earlier chat" });
  const art = h("article", { class: "prose" }, h("h1", {}, c.title));
  for (const m of c.messages || []) {
    if (m.role === "q") art.append(h("p", { class: "msg-q" }, m.text));
    else { const b = renderMd(m.text, c.course); b.className = "msg-a"; art.append(b); }
  }
  $("#main").replaceChildren(art);
}

// ------------------------------------------------------------ reviews

async function showReview(courseId, token) {
  const c = await loadCourse(courseId, true);
  setCrumbs({ label: "Home", href: "#" }, { label: c.code, href: `#c=${encodeURIComponent(courseId)}` }, { label: "Reviews" });
  const items = await api(`/api/reviews?course=${encodeURIComponent(courseId)}`);
  if (token !== routeToken) return;
  const main = $("#main");
  const page = h("div", { class: "review" });
  main.replaceChildren(page);
  let i = 0;
  const total = items.length;
  const finish = () => {
    const s = APP.session;
    const res = c.resume;
    page.replaceChildren(h("div", { class: "done-card" }, h("h1", {}, total ? "Reviews done" : "Nothing due"),
      h("p", {}, total ? `${total} item${total === 1 ? "" : "s"} reviewed.` : "Nothing to review today."),
      s && s.course === courseId
        ? h("button", { class: "btn", type: "button", onclick: () => { setSessionStep(1); go({ c: courseId, d: res.deck, s: res.slide }); } }, "Continue: new slides")
        : res ? h("a", { class: "btn", href: `#c=${encodeURIComponent(courseId)}&d=${encodeURIComponent(res.deck)}&s=${res.slide}` }, `Back to ${res.deck} · slide ${res.slide}`) : null));
  };
  const next = () => {
    if (i >= items.length) return finish();
    const it = items[i];
    const area = h("div", { class: "practice" });
    page.replaceChildren(h("p", { class: "count" }, `${i + 1} of ${total}${it.warmup ? " · Warm-up: basic maths" : ""}`), area);
    i += 1;
    runPractice(area, { course: courseId, kind: it.warmup ? "warmup" : "review", review_id: it.id }, () =>
      ({ label: i < items.length ? "Next review" : "Finish", run: next }), {
      waitText: "Writing a fresh variation…",
      afterResult: (box) => {
        if (it.note) box.append(h("p", { class: "hint-box" }, h("b", {}, "Your note from last time"), it.note));
      },
    });
  };
  next();
}

// ------------------------------------------------------------ study session

function saveSession() { store.set("session", APP.session); }
function endSession() { APP.session = null; saveSession(); renderSessionBar(); go({}); }

function startSession(courseId) {
  APP.session = { course: courseId, step: 0, practised: 0, lastMistake: null, started: Date.now() };
  saveSession();
  runStep(0);
}

async function runStep(i) {
  const s = APP.session;
  if (!s) return;
  setSessionStep(i);
  const c = await loadCourse(s.course, true);
  const res = c.resume;
  if (i === 0) {
    if (c.reviews.count) return go({ review: s.course });
    return runStep(1);
  }
  if (i === 1) return go({ c: s.course, d: res.deck, s: res.slide });
  if (i === 2) return openPractice(s.course, { kind: "try" });
  if (i === 3) return openPractice(s.course, { kind: "mixed" });
  if (i === 4) return go({ step: "note" });
}

function setSessionStep(i) {
  if (!APP.session) return;
  APP.session.step = i;
  saveSession();
  renderSessionBar();
}

function renderSessionBar() {
  const bar = $("#session-bar");
  const s = APP.session;
  const on = !!s && !params().upload;
  bar.hidden = !on;
  document.body.classList.toggle("session-on", on);
  if (!on) return;
  bar.replaceChildren(...STEPS.map(([, label], i) => h("button", {
    type: "button", class: i < s.step ? "done" : i === s.step ? "current" : "", "aria-current": i === s.step ? "step" : null,
    "aria-label": `Session step ${i + 1}: ${label}`, onclick: () => runStep(i),
  }, h("span", { class: "seg" }), h("span", { class: "lbl" }, label))));
}

function showNoteStep() {
  const s = APP.session;
  setCrumbs({ label: "Home", href: "#" }, { label: "Session" });
  const main = $("#main");
  if (!s) return go({});
  const input = h("input", { type: "text", placeholder: "The clue I missed was…", "aria-label": "The clue I missed was", maxlength: "300" });
  const finish = async () => {
    const note = input.value.trim();
    if (note && s.lastMistake) {
      try { await api("/api/review/note", { course: s.course, id: s.lastMistake, note }); } catch { /* not critical */ }
    }
    APP.session = null; saveSession(); renderSessionBar();
    main.replaceChildren(h("div", { class: "page" }, h("div", { class: "done-card" }, h("h1", {}, "Session done"),
      h("p", {}, note ? "Your note will show up next time this comes back." : "Nice work."), h("a", { class: "btn", href: "#" }, "Home"))));
  };
  main.replaceChildren(h("div", { class: "page" },
    h("h1", { class: "page-title" }, "One line to remember"),
    h("p", { class: "page-sub" }, s.lastMistake ? "Shown next time this comes back." : "Nothing was missed today; a line still helps."),
    h("form", { class: "clue", onsubmit: (e) => { e.preventDefault(); finish(); } }, input, h("button", { class: "btn", type: "submit" }, "Finish")),
    h("button", { class: "link quiet", type: "button", onclick: () => { input.value = ""; finish(); } }, "Skip")));
  input.focus();
}

// ------------------------------------------------------------ menu, search, history, settings

function slidesOnly(courseId) { return !!store.get(`slidesOnly:${courseId}`, false); }

function currentCourseId() {
  const p = params();
  return p.c || p.review || (APP.session && APP.session.course) || (APP.home && APP.home.suggested) || null;
}

function openMenu() {
  const m = $("#menu");
  const cid = currentCourseId();
  const c = cid && APP.courses[cid];
  $("#slides-only-row").hidden = !c;
  if (c) { $("#slides-only").checked = slidesOnly(cid); $("#slides-only-course").textContent = c.code; }
  m.hidden = false;
  $("#menu-btn").setAttribute("aria-expanded", "true");
}
function closeMenu() { $("#menu").hidden = true; $("#menu-btn").setAttribute("aria-expanded", "false"); }
$("#menu-btn").addEventListener("click", (e) => { e.stopPropagation(); $("#menu").hidden ? openMenu() : closeMenu(); });
document.addEventListener("click", (e) => { if (!$("#menu").hidden && !e.target.closest("#menu")) closeMenu(); });
$("#slides-only").addEventListener("change", (e) => { const cid = currentCourseId(); if (cid) store.set(`slidesOnly:${cid}`, e.target.checked); });
$("#model-pick").addEventListener("change", (e) => { APP.model = e.target.value; store.set("model", APP.model); });
$("#menu").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "history") { closeMenu(); showHistory(); }
  if (act === "phone") { closeMenu(); showPhoneQr(); }
});

async function showHistory() {
  const list = $("#history-list");
  list.replaceChildren(h("p", { class: "waiting" }, "Loading…"));
  $("#history-dlg").showModal();
  const chats = await api("/api/chats").catch(() => []);
  list.replaceChildren();
  if (!chats.length) list.append(h("p", { class: "muted" }, "No tutor chats yet."));
  for (const c of chats) {
    const row = h("div", { class: "hist-row" },
      h("button", { class: "open", type: "button", onclick: () => { $("#history-dlg").close(); if (!c.deck) return go({ chat: c.id }); APP.tutor = "open"; go({ c: c.course, d: c.deck, s: "" }); } },
        h("b", {}, c.title), h("span", {}, `${c.code} · ${c.count} question${c.count === 1 ? "" : "s"} · ${c.updated || c.created}`)),
      h("button", { class: "link quiet", type: "button", onclick: async () => {
        if (!confirm(`Delete this chat?\n\n${c.title}`)) return;
        await api("/api/chat/delete", { id: c.id }).catch(() => {});
        row.remove();
        if (APP.deck && APP.deck.chat && APP.deck.chat.id === c.id) { APP.deck.chat = null; drawThread(); }
      } }, "Delete"));
    list.append(row);
  }
}

function showPhoneQr() {
  const qr = qrcode(0, "M"); qr.addData(APP.phoneUrl); qr.make();
  $("#qr-title").textContent = "Open on your phone";
  $("#qr-text").textContent = "Connect your phone to the same Wi-Fi, then scan this with its camera. Keep this computer on while you use it.";
  $("#qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  $("#qr-url").textContent = APP.phoneUrl;
  $("#qr-dlg").showModal();
}

// ---------- search (Ctrl K)

// Search snippets are raw transcript text; strip Markdown and the commonest LaTeX so they read cleanly.
const TEX = { Theta: "Θ", Omega: "Ω", omega: "ω", sum: "Σ", le: "≤", leq: "≤", ge: "≥", geq: "≥", cdot: "·", times: "×",
  infty: "∞", log: "log", lg: "lg", ln: "ln", sqrt: "√", ldots: "…", dots: "…", in: "∈", to: "→", rightarrow: "→", neq: "≠", approx: "≈" };
function plain(t) {
  return t.replace(/\*\*|__|`/g, "").replace(/\$\$?/g, "").replace(/\\(left|right|,|;|!|quad|qquad|displaystyle|text|mathrm|mathbf)/g, "")
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)").replace(/\\([A-Za-z]+)/g, (m, w) => TEX[w] ?? w).replace(/[{}]/g, "");
}
let searchTimer, searchSel = -1;
function openSearch() {
  $("#search").hidden = false;
  const input = $("#search-input");
  input.value = ""; $("#search-results").replaceChildren();
  input.focus();
}
function closeSearch() { $("#search").hidden = true; }
$("#search-btn").addEventListener("click", openSearch);
$("#search").addEventListener("click", (e) => { if (e.target.id === "search") closeSearch(); });
$("#search-input").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(async () => {
    const box = $("#search-results");
    if (q.length < 2) { box.replaceChildren(); return; }
    const hits = await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => []);
    searchSel = -1;
    box.replaceChildren(...(hits.length ? hits.map((x) => h("a", { href: `#c=${encodeURIComponent(x.course)}&d=${encodeURIComponent(x.deck)}&s=${x.slide}`, onclick: closeSearch },
      h("b", {}, `${x.code} · ${x.topic} · ${x.deck} s${x.slide}`), h("span", {}, plain(x.text)))) : [h("p", {}, `Nothing matches "${q}".`)]));
  }, 160);
});
$("#search-input").addEventListener("keydown", (e) => {
  const links = $$("#search-results a");
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    searchSel = Math.max(0, Math.min(links.length - 1, searchSel + (e.key === "ArrowDown" ? 1 : -1)));
    links.forEach((a, i) => a.classList.toggle("sel", i === searchSel));
    links[searchSel]?.scrollIntoView({ block: "nearest" });
  }
  if (e.key === "Enter" && links.length) { (links[searchSel] || links[0]).click(); }
  if (e.key === "Escape") closeSearch();
});

// ---------- keys

document.addEventListener("keydown", (e) => {
  const typing = e.target.closest("input, textarea, select, [contenteditable]");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openSearch(); return; }
  if (e.key === "Escape") {
    if (!$("#search").hidden) return closeSearch();
    if (!$("#menu").hidden) return closeMenu();
    if (APP.zoom) return toggleZoom();
    if (APP.text) return toggleText(false);
    if (APP.tutor === "focus" && !typing) return closePractice();
  }
  if (typing || !$(".viewer") || APP.tutor === "focus") return;
  if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); step(1); }
  else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); step(-1); }
  else if (e.key.toLowerCase() === "t") toggleText();
  else if (e.key.toLowerCase() === "z") toggleZoom();
});

// ------------------------------------------------------------ start

(async function init() {
  window.addEventListener("hashchange", route);
  try {
    const m = await api("/api/models");
    APP.models = m.models;
    const saved = store.get("model", m.default);
    APP.model = m.models.some((x) => x.id === saved) ? saved : m.default;
    $("#model-pick").replaceChildren(...m.models.map((x) => h("option", { value: x.id }, x.label.split(" — ")[0])));
    $("#model-pick").value = APP.model;
  } catch { /* the server default applies */ }
  try {
    APP.phoneUrl = (await api("/api/phone")).url;
    $("#phone-item").hidden = !APP.phoneUrl;
  } catch { /* local only */ }
  route();
})();
