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
// "done" with the final result (or "error"). on = { status(text), text(delta) }. An aborted signal rejects with
// the browser's AbortError (callers ignore it: whoever aborted already moved on).
const isAbort = (e) => e && e.name === "AbortError";
async function apiStream(path, body, on = {}, signal = undefined) {
  let r;
  try {
    r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, stream: true }), signal });
  } catch (e) { if (isAbort(e)) throw e; throw new Error("The hub isn't responding. Start it again with start.bat, then retry."); }
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
  model: null, models: [], phoneUrl: null, scope: store.get("scope", "slide"),
  session: store.get("session", null),
};
const STEPS = [["review", "Review"], ["new", "New slides"], ["practise", "Practise"], ["mix", "Mixed"], ["note", "Note"]];

// ------------------------------------------------------------ markdown + math

// A cue in an answer, [#left]: lights up that part of the answer's drawing. Never shown as text.
const CUE = /\[#([A-Za-z][\w-]{0,40})\]/g;
const uncue = (t) => String(t || "").replace(/[ \t]?\[#[A-Za-z][\w-]{0,40}\]/g, "");

function renderMd(md, courseId) {
  const code = [], math = [];
  let src = String(md || "").replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => { code.push(m); return `CODETOKEN${code.length - 1}X`; });
  src = uncue(src);
  // [[term]] becomes a button that explains the term in a side question (openSide), its maths still rendered.
  const terms = [];
  src = src.replace(/\[\[([^[\]\n]{1,120}?)\]\]/g, (_, t) => { terms.push(t); return `TERMOPEN${terms.length - 1}X${t}TERMCLOSEX`; });
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => { math.push([t, true]); return `MATHTOKEN${math.length - 1}X`; });
  src = src.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (_, pre, t) => { math.push([t, false]); return `${pre}MATHTOKEN${math.length - 1}X`; });
  // ||hidden answer|| becomes a blurred span you click to reveal (works inside lists and around maths).
  src = src.replace(/\|\|([^|\n][^\n]*?)\|\|/g, '<span class="spoiler" tabindex="0" role="button" title="Click to show the answer">$1</span>');
  src = src.replace(/CODETOKEN(\d+)X/g, (_, i) => code[+i]);
  const box = document.createElement("div");
  box.innerHTML = marked.parse(src, { gfm: true, breaks: false });
  box.innerHTML = box.innerHTML.replace(/MATHTOKEN(\d+)X/g, (_, i) => {
    const [tex, display] = math[+i];
    try { return katex.renderToString(tex, { displayMode: display, throwOnError: false }); } catch { return esc(tex); }
  });
  if (terms.length) box.innerHTML = box.innerHTML
    .replace(/TERMOPEN(\d+)X/g, (_, i) => `<button class="term" type="button" title="Explain this on the side" data-term="${esc(terms[+i])}">`)
    .replace(/TERMCLOSEX/g, "</button>");
  const openFence = (String(md || "").match(/^ {0,3}```/gm) || []).length % 2 === 1;   // still streaming in
  enhanceVisuals(box, openFence);   // ```mermaid / ```svg / ```plot become drawings (visuals.js)
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
  return c ? [...c.topics.flatMap((t) => t.decks), ...(c.practice || [])].map((d) => d.tag) : [];
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
        "data-c": courseId, "data-d": tag, "data-s": String(n) }, m[0].slice(1, -1)));
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

document.addEventListener("click", (e) => {
  const sp = e.target.closest(".spoiler");
  if (sp) { sp.classList.add("shown"); return; }
  const term = e.target.closest("button.term");
  if (term && !term.closest("#print-root")) { openSide({ anchor: term.dataset.term, para: paraOf(term), nested: !!term.closest(".side-sheet") }); return; }
  // A tap on the chat above the side sheet closes it (not the end of a drag that selected text).
  if (APP.side && e.target.isConnected && !APP.side.el.contains(e.target) && e.target.closest("#tutor .panel")
      && getSelection().isCollapsed) closeSide();
  const c = e.target.closest(".cite[data-d]");
  if (c && !c.closest("#print-root")) go({ c: c.dataset.c, d: c.dataset.d, s: +c.dataset.s });
});

document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("spoiler")) { e.preventDefault(); e.target.classList.add("shown"); }
});
// A ⋯ menu closes on a click anywhere else.
document.addEventListener("click", (e) => { $$("details.more-menu[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; }); });

// Rendering Markdown with many formulas is the expensive part of a long chat, so finished answers
// are rendered once and reused (as HTML) whenever the thread is drawn again.
const MD_CACHE = new Map();
function renderMdCached(text, courseId) {
  const key = `${courseId}\u0000${text}`;
  const hit = MD_CACHE.get(key);
  const box = document.createElement("div");
  if (hit != null) { box.innerHTML = hit; return box; }
  const fresh = renderMd(text, courseId);
  MD_CACHE.set(key, fresh.innerHTML);
  if (MD_CACHE.size > 300) MD_CACHE.delete(MD_CACHE.keys().next().value);
  return fresh;
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
  // A recording never outlives the page; speech only carries on while staying on the same deck (e.g. a citation).
  cancelDictation();
  if (!(APP.deck && p.c === APP.deck.course && p.d === APP.deck.tag)) stopSpeaking();
  const main = $("#main");
  try {
    if (p.upload) await showUpload(p.upload);
    else if (p.chat) await showOldChat(p.chat, token);
    else if (p.review) await showReview(p.review, token);
    else if (p.c && p.d) await showViewer(p.c, p.d, +p.s || 0, token);
    else if (p.c && p.notes) await showNotes(p.c, p.notes, token);
    else if (p.c) await showCourse(p.c, token);
    else if (p.step === "note") showNoteStep();
    else await showHome(token);
  } catch (e) {
    if (token !== routeToken) return;
    main.replaceChildren(h("div", { class: "page" }, h("p", { class: "err" }, e.message)));
  }
  if (token === routeToken) renderSidenav();
}

// ------------------------------------------------------------ topics sidebar
// Course → topics → decks (with state dots); the open deck lists its slides. Toggle with ☰ or "[".

APP.navOpen = store.get("navOpen", false) && !matchMedia("(max-width: 760px)").matches;

function toggleNav(open = !APP.navOpen) {
  APP.navOpen = open;
  if (!isPhone()) store.set("navOpen", open);
  renderSidenav();
}

// The course the page is in (null on the home page): the sidebar opens it and History lists only its chats.
function routeCourseId() {
  const p = params();
  return p.c || p.review || (APP.session && APP.session.course) || null;
}

// Every course, for the sidebar's course switcher; fetched once if the hub was opened straight into a course.
async function allCourses() {
  if (!APP.home) {
    APP.home = await api("/api/home");
    APP.home.courses.forEach((c) => { APP.courses[c.id] = APP.courses[c.id] || c; });
  }
  return APP.home.courses;
}

function sidenavCourseIds() {
  const cid = routeCourseId();
  if (cid) return [cid];
  return (APP.home ? APP.home.courses : Object.values(APP.courses)).map((c) => c.id);
}

async function renderSidenav() {
  const nav = $("#sidenav");
  $("#nav-btn").setAttribute("aria-expanded", String(APP.navOpen));
  document.body.classList.toggle("nav-open", APP.navOpen);
  $("#nav-scrim").hidden = !(APP.navOpen && isPhone());
  nav.hidden = !APP.navOpen || !!params().upload;
  if (nav.hidden) return;
  const p = params();
  const ids = sidenavCourseIds();
  let courses, others = [];
  try { courses = await Promise.all(ids.map((id) => loadCourse(id))); } catch { return; }
  if (routeCourseId()) {
    try { others = (await allCourses()).filter((c) => !ids.includes(c.id)); } catch { /* the switcher is optional */ }
  }
  const here = APP.deck && p.c === APP.deck.course && p.d === APP.deck.tag ? APP.deck : null;
  const parts = [];
  for (const c of courses) {
    parts.push(h("a", { class: "sn-course" + (p.c === c.id && !p.d ? " here" : ""), href: `#c=${encodeURIComponent(c.id)}` },
      h("b", {}, c.code), h("span", {}, c.title)));
    for (const t of c.topics) {
      const hasHere = here && t.decks.some((d) => d.tag === here.tag && c.id === here.course);
      const solved = t.decks.filter((d) => d.state === "solved").length;
      const box = h("details", { class: "sn-topic", open: hasHere || courses.length === 1 && !here ? true : hasHere },
        h("summary", {}, h("span", {}, t.name), h("span", { class: "sn-count" }, `${solved}/${t.decks.length}`)));
      box.append(...t.decks.flatMap((d) => sidenavDeck(c, d, here)));
      parts.push(box);
    }
    // Homework and practice exams: their own list under the topics, not a topic.
    if (c.practice?.length) parts.push(h("div", { class: "sn-practice" }, h("p", { class: "sn-label" }, "Practice"),
      ...c.practice.flatMap((d) => sidenavDeck(c, d, here))));
  }
  // Course switcher, pinned to the top so it stays in reach while a long slide list is scrolled.
  if (others.length) {
    const all = [...courses, ...others].sort((a, b) => a.code.localeCompare(b.code));
    parts.unshift(h("nav", { class: "sn-switch", "aria-label": "Courses" }, ...all.map((c) =>
      h("a", { class: ids.includes(c.id) ? "here" : "", href: `#c=${encodeURIComponent(c.id)}`, title: c.title,
        "aria-current": ids.includes(c.id) ? "page" : null }, c.code))));
  }
  nav.replaceChildren(...parts);
  const cur = $(".sn-slide.here", nav) || $(".sn-deck.here", nav);
  if (cur) cur.scrollIntoView({ block: "center" });
}

// A deck's sidebar link, plus its slide list when it's the open deck.
function sidenavDeck(c, d, here) {
  const isHere = here && here.tag === d.tag && here.course === c.id;
  const out = [h("a", { class: "sn-deck" + (isHere ? " here" : ""), href: `#c=${encodeURIComponent(c.id)}&d=${encodeURIComponent(d.tag)}&s=${d.last || 1}`,
    title: `${d.title} · ${stateLabel(d.state)}` },
    h("span", { class: `dot ${d.state}` }), h("span", { class: "sn-tag" }, d.tag), h("span", { class: "sn-title" }, d.title),
    h("span", { class: "chip week" }, `W${d.week}`))];
  if (isHere) {
    const list = h("ol", { class: "sn-slides" });
    for (const s of here.slides_text) {
      list.append(h("li", {}, h("a", { class: "sn-slide" + (s.n === APP.n ? " here" : ""), "data-n": String(s.n),
        href: `#c=${encodeURIComponent(c.id)}&d=${encodeURIComponent(d.tag)}&s=${s.n}`,
        onclick: (e) => { if (APP.deck === here) { e.preventDefault(); APP.n = s.n; showSlide(); if (APP.tutor === "open") updateTutorWhere(); else updateComposeHint(); if (isPhone()) toggleNav(false); } } },
        h("span", { class: "sn-n" }, String(s.n)), s.title || `Slide ${s.n}`)));
    }
    out.push(list);
  }
  return out;
}

// Keep the highlighted slide in step with the viewer without rebuilding the sidebar.
function markSidenavSlide(n) {
  const nav = $("#sidenav");
  if (!nav || nav.hidden) return;
  let cur = null;
  $$(".sn-slide", nav).forEach((a) => { const on = +a.dataset.n === n; a.classList.toggle("here", on); if (on) cur = a; });
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

$("#nav-btn").addEventListener("click", () => toggleNav());
$("#nav-scrim").addEventListener("click", () => toggleNav(false));
$("#sidenav").addEventListener("click", (e) => { if (isPhone() && e.target.closest("a")) toggleNav(false); });

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
    const decks = h("div", { class: "decks" }, ...t.decks.map((d) => deckRow(id, d)));
    if (t.read_more) decks.append(h("p", { class: "read-more" }, `Textbook: ${t.read_more}`));
    box.append(btn, decks);
    topics.append(box);
  }
  page.append(topics);
  // Homework and practice exams: a list of their own, apart from the topics.
  if (c.practice?.length) page.append(h("section", { class: "practice-list" + (p.t === "Practice" ? " open" : "") },
    h("h2", {}, "Practice"), h("p", { class: "muted small" }, "Homework and practice exams"),
    ...c.practice.map((d) => deckRow(id, d, "pages"))));
  if (c.notes.length) {
    page.append(h("p", { class: "notes-line" }, "Your class notes: ",
      ...c.notes.map((n, i) => {
        const k = c.notes.slice(0, i).filter((x) => x.week === n.week).length;
        return h("a", { href: `#c=${encodeURIComponent(id)}&notes=${encodeURIComponent(n.path)}` }, `W${n.week}${k ? ` (${k + 1})` : ""}`);
      })));
  }
  const label = { exams: "Mock tests & cheat sheets", labs: "Labs", assignments: "Assignments", tutor: "Voice tutor" };
  for (const kind of ["exams", "labs", "assignments", "tutor"]) {
    const groups = c.docs.filter((g) => g.kind === kind);
    if (!groups.length) continue;
    page.append(h("p", { class: "notes-line" }, `${label[kind]}: `,
      ...groups.flatMap((g) => [g.name ? h("span", { class: "muted" }, `${g.name} `) : null,
        ...g.files.map((f) => h("a", { href: `#c=${encodeURIComponent(id)}&notes=${encodeURIComponent(f.path)}` }, f.name))])));
  }
  $("#main").replaceChildren(page);
  if (p.t) $(".topic.open, .practice-list.open")?.scrollIntoView({ block: "center" });
}

function deckRow(id, d, unit = "slides") {
  return h("a", { class: "deck-row", href: `#c=${encodeURIComponent(id)}&d=${encodeURIComponent(d.tag)}&s=${d.last || 1}` },
    h("span", { class: `dot ${d.state}`, title: stateLabel(d.state) }),
    h("span", { class: "t" }, h("b", {}, d.tag), ` · ${d.title}`),
    h("span", { class: "chip week" }, `W${d.week}`),
    h("span", { class: "meta" }, d.state === "read" ? "Solve one to finish" : `${d.slides} ${unit}`));
}

const stateLabel = (s) => ({ new: "Not started", started: "Started", read: "Read · solve one to finish", solved: "Solved" })[s] || s;
function findDeck(c, tag) { for (const t of c.topics) for (const d of t.decks) if (d.tag === tag) return d; return (c.practice || []).find((d) => d.tag === tag) || null; }
// Lecture order (week, then the deck table's order), not topic order: topics can interleave within a week.
function courseDeckOrder(c) { return c.topics.flatMap((t) => t.decks).sort((a, b) => a.week - b.week || (a.order ?? 0) - (b.order ?? 0)); }

async function showNotes(id, path, token) {
  const c = await loadCourse(id);
  if (token !== routeToken) return;
  const n = c.notes.find((x) => x.path === path);
  const label = n ? `Class notes W${n.week}` : path === "study/tutor-memory.md" ? "What your tutor remembers"
    : path.split("/").slice(-2).join(" · ").replace(/\.md$/, "");
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
  const resizer = h("div", { class: "resizer", id: "resizer", role: "separator", "aria-orientation": "vertical", tabindex: "0",
    "aria-label": "Resize the tutor panel (drag, or ← → keys; double-click to reset)", title: "Drag to resize · double-click to reset", hidden: true });
  $("#main").replaceChildren(h("div", { class: "viewer" }, stage, resizer, tutor));
  setupResizer();
  const sm = $("#stage-main");
  let x0 = null, y0 = null;
  sm.addEventListener("touchstart", (e) => { if (e.touches.length === 1) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; } }, { passive: true });
  sm.addEventListener("touchend", (e) => {
    if (x0 == null || APP.zoom) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    x0 = null;
  });
  sm.addEventListener("dblclick", () => { if (!isPhone()) toggleZoom(); });
  // Phone: tap the left or right half of the slide to go back or forward; zoom is the browser's own two-finger pinch.
  sm.addEventListener("click", (e) => {
    if (!isPhone() || !e.target.classList.contains("slide-img")) return;
    if (window.visualViewport && visualViewport.scale > 1.05) return;   // pinched in: a tap shouldn't turn the page
    const r = e.target.getBoundingClientRect();
    step(e.clientX < r.left + r.width / 2 ? -1 : 1);
  });
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
  const { prev: prevDeck, next: nextDeck } = neighbourDecks(d);
  if (end) {
    sm.classList.remove("portrait");
    sm.replaceChildren(h("div", { class: "end-card" },
      h("h2", {}, `End of ${d.tag}`),
      h("p", {}, d.state.solved ? "You've solved a problem from this deck." : "Solve one problem from it to finish the deck."),
      h("button", { class: "btn", type: "button", onclick: () => startPracticeInPanel({ kind: "deck" }) }, "Try one"),
      h("div", { class: "deck-links" },
        prevDeck ? h("a", { class: "link quiet", href: `#c=${encodeURIComponent(d.course)}&d=${encodeURIComponent(prevDeck.tag)}&s=${prevDeck.slides}` }, `‹ Previous deck: ${prevDeck.tag}`) : null,
        nextDeck ? h("a", { class: "link", href: `#c=${encodeURIComponent(d.course)}&d=${encodeURIComponent(nextDeck.tag)}&s=1` }, `Next deck: ${nextDeck.tag} ›`) : null)));
  } else {
    let img = $(".slide-img", sm);
    if (!img) { img = h("img", { class: "slide-img", alt: "", draggable: "false" }); sm.replaceChildren(img); }
    img.style.opacity = ".001";
    img.onload = () => { fitSlide(); img.style.opacity = "1"; };
    const s = d.slides_text[n - 1];
    img.alt = s && s.title ? `Slide ${n}: ${s.title}` : `Slide ${n}`;
    img.src = slideUrl(n);
    if (n < d.slides) { const pre = new Image(); pre.src = slideUrl(n + 1); }
  }
  markSidenavSlide(n);
  const label = end ? `${d.slides} / ${d.slides}` : `${n} / ${d.slides}`;
  $("#counter").textContent = label; $("#counter-m").textContent = label;
  // At the edges of a deck the arrows carry on into the previous / next deck.
  $("#prev").disabled = n <= 1 && !prevDeck; $("#next").disabled = end && !nextDeck;
  $("#prev").title = n <= 1 && prevDeck ? `Previous deck: ${prevDeck.tag} (←)` : "Previous slide (←)";
  $("#next").title = end && nextDeck ? `Next deck: ${nextDeck.tag} (→)` : "Next slide (→)";
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
  let hgt = sm.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (isPhone()) {   // the slide sizes the stage on a phone, so measure the room around it, not the slide itself
    const v = $(".viewer"), st = $("#stage"), foot = $(".stage-foot", st);
    if (v && st) hgt = (v.classList.contains("ask-open") ? v.clientHeight * 0.42 : st.clientHeight) - (foot ? foot.offsetHeight : 0);
  }
  const k = portrait ? Math.min(w / img.naturalWidth, 760 / img.naturalWidth, 1.5)
                     : Math.min(w / img.naturalWidth, hgt / img.naturalHeight, isPhone() ? 9 : 1.5);
  img.style.width = Math.floor(img.naturalWidth * k) + "px";
  img.style.height = "auto";
}
window.addEventListener("resize", () => fitSlide());
const stageObserver = new ResizeObserver(() => fitSlide());

// The decks either side of this one, in lecture order across the whole course.
function neighbourDecks(d) {
  const c = APP.courses[d.course];
  const order = c ? courseDeckOrder(c) : [];
  const i = order.findIndex((x) => x.tag === d.tag);
  return { prev: i > 0 ? order[i - 1] : null, next: i >= 0 ? order[i + 1] || null : null };
}

function step(k) {
  if (!APP.deck) return;
  const d = APP.deck, { prev, next } = neighbourDecks(d);
  if (k < 0 && APP.n <= 1 && prev) return go({ c: d.course, d: prev.tag, s: prev.slides });
  if (k > 0 && APP.n > d.slides && next) return go({ c: d.course, d: next.tag, s: 1 });
  const n = Math.min(Math.max(1, APP.n + k), APP.deck.slides + 1);
  if (n === APP.n) return;
  APP.n = n;
  showSlide();
  if (APP.tutor === "open") updateTutorWhere(); else updateComposeHint();
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
  const fromBar = mode !== "closed" && $(".viewer")?.classList.contains("ask-closed");
  t.classList.toggle("open", mode === "open");
  t.classList.toggle("focus", mode === "focus");
  $(".viewer")?.classList.toggle("ask-closed", mode === "closed");   // the ask bar under the slide
  // Out of the ask bar, the panel slides in from the edge rather than shrinking from the bar's width.
  if (fromBar && !isPhone()) { t.style.transition = "none"; t.style.width = "0px"; void t.offsetWidth; t.style.transition = ""; }
  // The panel's width is dragged by its left edge; practice mode remembers its own width.
  const saved = mode === "open" ? store.get("panelW", 0) : mode === "focus" ? store.get("focusW", 0) : 0;
  t.style.width = saved && !isPhone() ? `${clampPanel(saved)}px` : "";
  $("#resizer")?.toggleAttribute("hidden", mode === "closed" || isPhone());
  $("#stage")?.classList.toggle("shrunk", mode === "focus");
  $(".viewer")?.classList.toggle("ask-open", mode === "open");   // phone: slide on top, chat below
  if (mode !== "focus") restoreStage();
  requestAnimationFrame(fitSlide);
  applyReading();
}

// Reading view: the chat takes the whole viewer and reads like a PDF page. A preference, so it's remembered.
// Zoom scales the text and the page with it; "Fit width" drops the grey margins so the page fills the screen.
const READ_ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2];

function applyReading() {
  const on = APP.tutor === "open" && store.get("reading", false);
  const v = $(".viewer");
  if (v) {
    v.classList.toggle("reading", on);
    v.classList.toggle("read-wide", on && store.get("readWide", false));
    v.style.setProperty("--rz", store.get("readZoom", 1));
  }
  $("#read-btn")?.setAttribute("aria-pressed", String(on));
  $("#read-wide")?.setAttribute("aria-pressed", String(store.get("readWide", false)));
  const z = $("#read-zoom");
  if (z) z.textContent = `${Math.round(store.get("readZoom", 1) * 100)}%`;
}

// Re-lays out the chat while keeping the reader at the same place in it.
function keepPlace(change) {
  const th = $("#thread");
  const at = th && th.scrollHeight > th.clientHeight ? th.scrollTop / (th.scrollHeight - th.clientHeight) : 1;
  change();
  applyReading();
  if (th) th.scrollTop = at * (th.scrollHeight - th.clientHeight);
  return th;
}

function toggleReading() {
  // The Read view shows every answer whole and unlit: the voice stops (Voice paces nothing there). ▶ Play pressed in
  // the Read view still reads, without glow or lighting (playAnswer).
  const on = !store.get("reading", false);
  if (on) { stopSpeaking(); endCues(VOICE.lit); }
  const th = keepPlace(() => store.set("reading", on));
  if (th && $(".viewer.reading")) th.focus({ preventScroll: true });
}

function zoomReading(dir) {   // -1, +1, or 0 to reset
  const cur = READ_ZOOMS.indexOf(store.get("readZoom", 1));
  const i = dir === 0 ? READ_ZOOMS.indexOf(1) : Math.max(0, Math.min(READ_ZOOMS.length - 1, (cur < 0 ? 2 : cur) + dir));
  keepPlace(() => store.set("readZoom", READ_ZOOMS[i]));
}

function readTools() {
  return h("span", { class: "read-tools" },
    h("button", { class: "icon-btn", type: "button", title: "Smaller text (−)", "aria-label": "Zoom out", onclick: () => zoomReading(-1) }, "−"),
    h("button", { class: "link quiet zoom-level", type: "button", id: "read-zoom", title: "Reset zoom (0)", onclick: () => zoomReading(0) }, "100%"),
    h("button", { class: "icon-btn", type: "button", title: "Larger text (+)", "aria-label": "Zoom in", onclick: () => zoomReading(1) }, "+"),
    h("button", { class: "link quiet new-chat", type: "button", id: "read-wide", title: "Fill the screen width, no side margins (W)",
      onclick: () => keepPlace(() => store.set("readWide", !store.get("readWide", false))) }, "Fit width"));
}

function clampPanel(w) {
  const v = $(".viewer");
  const max = (v ? v.clientWidth : innerWidth) * 0.75;
  return Math.round(Math.max(300, Math.min(max, w)));
}

function setupResizer() {
  const r = $("#resizer"), t = $("#tutor");
  if (!r || !t) return;
  r.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    r.setPointerCapture(e.pointerId);
    t.classList.add("dragging"); r.classList.add("active");
    const right = $(".viewer").getBoundingClientRect().right;
    const move = (ev) => { t.style.width = `${clampPanel(right - ev.clientX)}px`; };
    const up = () => {
      t.classList.remove("dragging"); r.classList.remove("active");
      r.removeEventListener("pointermove", move);
      store.set(APP.tutor === "focus" ? "focusW" : "panelW", parseInt(t.style.width, 10));
    };
    r.addEventListener("pointermove", move);
    r.addEventListener("pointerup", up, { once: true });
  });
  r.addEventListener("dblclick", () => { store.set(APP.tutor === "focus" ? "focusW" : "panelW", 0); t.style.width = ""; });
  r.addEventListener("keydown", (e) => {      // keyboard: ←/→ widen or narrow by 40 px
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const w = clampPanel(t.getBoundingClientRect().width + (e.key === "ArrowLeft" ? 40 : -40));
    t.style.width = `${w}px`;
    store.set(APP.tutor === "focus" ? "focusW" : "panelW", w);
  });
}

// ---- star and rename

async function updateChat(chat, change) {
  const r = await api("/api/chat/update", { id: chat.id, ...change });
  chat.title = r.title; chat.starred = r.starred;
  return r;
}

function starButton(chat, after) {
  const b = h("button", { class: "star" + (chat.starred ? " on" : ""), type: "button" }, chat.starred ? "★" : "☆");
  const label = () => { b.title = chat.starred ? "Unstar this chat" : "Star this chat"; b.setAttribute("aria-label", b.title); b.setAttribute("aria-pressed", String(!!chat.starred)); };
  label();
  b.onclick = async (e) => {
    e.stopPropagation();
    try { await updateChat(chat, { starred: !chat.starred }); } catch (err) { return toast(err.message); }
    b.textContent = chat.starred ? "★" : "☆"; b.classList.toggle("on", chat.starred); label();
    if (after) after();
  };
  return b;
}

// Click the title to rename it in place: Enter saves, Esc cancels.
function renamable(chat, cls, after) {
  const t = h("button", { class: `chat-title ${cls || ""}`, type: "button", title: "Rename this chat" }, chat.title);
  t.onclick = (e) => {
    e.stopPropagation();
    const input = h("input", { class: "rename", type: "text", value: chat.title, maxlength: "120", "aria-label": "Chat name" });
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (save && v && v !== chat.title) { try { await updateChat(chat, { title: v }); } catch (err) { toast(err.message); } }
      t.textContent = chat.title; input.replaceWith(t);
      if (after) after();
    };
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); finish(true); } if (ev.key === "Escape") { ev.stopPropagation(); finish(false); } });
    input.addEventListener("blur", () => finish(true));
    t.replaceWith(input); input.focus(); input.select();
  };
  return t;
}

function chatBar(chat) {
  return h("div", { class: "chat-bar" }, starButton(chat), renamable(chat));
}

async function newChat() {
  const d = APP.deck;
  try { await api("/api/chat/new", { course: d.course }); } catch { /* the next question still starts fresh */ }
  if (d.chat) d.chats = [{ id: d.chat.id, title: d.chat.title, updated: d.chat.updated }, ...(d.chats || [])].slice(0, 5);
  d.chat = null;
  d.asked = [];
  cancelDictation();
  stopSpeaking();
  drawThread();
  $("#ask-input")?.focus();
}

async function openChat(id) {
  try {
    const r = await api("/api/chat/open", { id });
    APP.tutor = "open";
    // One chat per course: in a deck of its course, it opens beside that deck; otherwise go to the deck it started on.
    if (APP.deck && APP.deck.course === r.course) {
      APP.deck = await api(`/api/deck?course=${encodeURIComponent(r.course)}&tag=${encodeURIComponent(APP.deck.tag)}`);
      renderTutor();
    } else go({ c: r.course, d: r.deck, s: "" });
  } catch (e) { alert(e.message); }
}

function renderTutor() {
  const t = $("#tutor");
  if (!t) return;
  if (APP.tutor === "closed") {
    closeSide();
    stopSpeaking();
    cancelDictation();
    setTutor("closed");
    // Closed, the tutor is an ask bar under the slide: sending opens the panel with the question in it.
    t.replaceChildren(h("div", { class: "askbar" },
      h("span", { class: "askbar-mark", "aria-hidden": "true" }, "✦"),
      composeBox(composeHint(), (q, spoken) => tutorAsk(grilling() ? "grill_reply" : "ask", q, { spoken })),
      h("button", { class: "icon-btn askbar-open", type: "button", title: "Open the tutor", "aria-label": "Open the tutor",
        onclick: () => { APP.tutor = "open"; renderTutor(); $("#ask-input")?.focus(); } }, "⇤")));
    return;
  }
  setTutor("open");
  t.replaceChildren(h("div", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", {}, "Tutor"), h("span", { class: "muted small", id: "tutor-where" }), readTools(),
      h("button", { class: "link quiet new-chat", type: "button", id: "read-btn", title: "Reading view: the chat as full-width pages, like a PDF (R)", onclick: toggleReading }, "Read"),
      h("button", { class: "link quiet new-chat", type: "button", title: "Start a new chat in this course", onclick: newChat }, "New chat"),
      h("details", { class: "more-menu" },
        h("summary", { class: "icon-btn", title: "More", "aria-label": "More" }, "⋯"),
        h("div", { class: "more-pop", role: "menu", onclick: (e) => { if (e.target.closest("button")) e.currentTarget.parentElement.open = false; } },
          h("button", { type: "button", role: "menuitem", onclick: () => copyChat(APP.deck.chat, APP.deck) }, "Copy chat as Markdown"),
          h("button", { type: "button", role: "menuitem", onclick: () => printChat(APP.deck.chat, APP.deck) }, "Print or save as PDF"))),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Close the tutor", onclick: () => { APP.tutor = "closed"; renderTutor(); } }, "×")),
    h("div", { class: "panel-actions" },
      scopeSwitch(),
      h("div", { class: "links" },
        h("button", { class: "link", type: "button", title: "Every concept in this deck at a glance (always the whole deck)", onclick: () => tutorAsk("map_deck") }, "Big picture"),
        h("button", { class: "link", type: "button", onclick: () => tutorAsk("example") }, "Worked example"),
        h("button", { class: "link", type: "button", onclick: () => tutorAsk("explain") }, "Explain simply"),
        h("button", { class: "link", type: "button", title: "An oral exam: one question at a time, follow-ups on weak answers, a summary at the end", onclick: () => tutorAsk("grill") }, "Grill me"),
        h("button", { class: "link", type: "button", onclick: () => tutorAsk("quiz") }, "Quiz prep"),
        h("button", { class: "link", type: "button", title: "What to know first: prerequisites, rules and symbols", onclick: () => tutorAsk("before") }, "Before you start"),
        h("button", { class: "link", type: "button", title: "Methods, formulas and shortcuts to copy onto your sheet (always the whole deck)", onclick: () => tutorAsk("cheatsheet_deck") }, "Cheat sheet"))),
    h("div", { class: "thread", id: "thread", "aria-live": "polite", tabindex: "-1" }),
    h("div", { class: "ask-area" }, viewSwitch(),
      composeBox(composeHint(), (q, spoken) => tutorAsk(grilling() ? "grill_reply" : "ask", q, { spoken })), voiceRow())));
  fillVoices();
  voiceSet(VOICE.state);
  if (APP.view === "voice") warmOnce();       // Voice reads answers aloud: the voice loads meanwhile
  updateTutorWhere();
  drawThread();
  applyReading();
  // A side question survives the panel being redrawn (e.g. the scope switch), but not a change of deck.
  if (APP.side && APP.deck && APP.side.course === APP.deck.course && APP.side.tag === APP.deck.tag) $(".panel", t).append(APP.side.el);
  else closeSide();
}

// ------------------------------------------------------------ side questions
// Tapping a [[term]] or asking about a selection opens a sheet over the lower part of the tutor panel. The
// server forks the course's chat for it, so it knows the conversation, but nothing it says joins the chat; the
// chat underneath keeps its place (and keeps streaming). × or a tap on the chat closes it; it isn't saved.
// A term tapped inside the sheet opens its own side on top; ‹ (or Esc) goes back to the previous one.

const sideStack = [];   // the sides under APP.side, still open on the server

function paraOf(el) {
  const p = el.closest("p, li, td, blockquote") || el.parentElement;
  return p ? p.textContent.trim().slice(0, 600) : "";
}

function openSide({ anchor, para = "", selection = false, nested = false }) {
  const d = APP.deck;
  if (!d || !anchor) return;
  hideSelAsk();
  if (APP.tutor !== "open") { APP.tutor = "open"; renderTutor(); }
  if (nested && APP.side) { sideStack.push(APP.side); APP.side.el.remove(); APP.side = null; }
  else closeSide();
  const thread = h("div", { class: "side-thread", "aria-live": "polite" });
  const ta = h("textarea", { rows: "1", placeholder: selection ? "What do you want to know about this?" : "Ask a follow-up", "aria-label": "Side question" });
  const form = h("form", { class: "compose side-compose", onsubmit: (e) => { e.preventDefault(); const q = ta.value.trim(); if (!q) return; ta.value = ""; sideAsk(q); } },
    ta, h("button", { class: "btn ghost", type: "submit" }, "Ask"));
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  const el = h("section", { class: "side-sheet", role: "dialog", "aria-label": "Side question" },
    h("div", { class: "side-head" },
      sideStack.length ? h("button", { class: "icon-btn side-back", type: "button", "aria-label": "Back to the previous side question",
        title: "Back (Esc)", onclick: () => sideBack() }, "‹") : null,
      h("div", { class: "side-quote" }, h("span", { class: "side-label" }, "On the side · not added to your chat"),
        h("div", { class: "side-anchor" }, ...inlineMd(anchor, d.course))),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Close the side question", title: "Close (Esc)", onclick: () => closeSide() }, "×")),
    thread, form);
  APP.side = { el, thread, ta, id: null, course: d.course, tag: d.tag, n: Math.min(APP.n, d.slides), anchor, para, selection, busy: false };
  $("#tutor .panel")?.append(el);
  if (selection) ta.focus(); else sideAsk("");
}

function dropSide(s) {
  s.el.remove();
  if (s.id) api("/api/side/close", { course: s.course, side: s.id }).catch(() => {});
}

function closeSide() {   // closes the whole stack
  if (APP.side) dropSide(APP.side);
  APP.side = null;
  while (sideStack.length) dropSide(sideStack.pop());
}

function sideBack() {
  if (!sideStack.length) return closeSide();
  if (APP.side) dropSide(APP.side);
  APP.side = sideStack.pop();
  $("#tutor .panel")?.append(APP.side.el);
}

async function sideAsk(question) {
  const s = APP.side;
  if (!s || s.busy) return;
  if (!s.id && !question && s.selection) return;      // a selection waits for the student's question
  s.busy = true;
  if (question) s.thread.append(h("p", { class: "msg-q" }, question));
  const wait = h("p", { class: "waiting" }, "Thinking…");
  const live = h("div", { class: "msg-a" });
  s.thread.append(wait);
  s.thread.scrollTop = s.thread.scrollHeight;
  let acc = "", queued = false;
  const paint = () => { queued = false; live.replaceChildren(...renderMd(acc, s.course).childNodes); s.thread.scrollTop = s.thread.scrollHeight; };
  const deck = APP.deck;
  try {
    const r = await apiStream("/api/side", { course: s.course, tag: s.tag, n: s.n, chat: deck.chat ? deck.chat.id : "", side: s.id,
      anchor: s.anchor, para: s.para, question, model: APP.model, slides_only: slidesOnly(s.course) }, {
      status: (t) => { wait.textContent = `${t}…`; },
      text: (t) => {
        if (!acc) { wait.replaceWith(live); }
        acc += t;
        if (!queued) { queued = true; requestAnimationFrame(paint); }
      },
    });
    s.id = r.side;
    if (APP.side !== s && !sideStack.includes(s)) { api("/api/side/close", { course: s.course, side: r.side }).catch(() => {}); return; }   // closed meanwhile
    const done = renderMdCached(r.message.text, s.course);
    done.className = "msg-a";
    (live.isConnected ? live : wait).replaceWith(done);
    s.thread.scrollTop = s.thread.scrollHeight;
  } catch (e) {
    (live.isConnected ? live : wait).replaceWith(h("p", { class: "err" }, e.message));
  } finally {
    s.busy = false;
  }
}

// Select part of an answer (main chat or side) → "Ask about this" just below the selection.
let selAskBtn = null;
function hideSelAsk() { selAskBtn?.remove(); selAskBtn = null; }

// The selected text as Markdown: formulas come back as $TeX$ (from KaTeX's annotation), not as jumbled glyphs.
function selectionMarkdown(range) {
  const k0 = range.startContainer.parentElement?.closest(".katex"), k1 = range.endContainer.parentElement?.closest(".katex");
  if (k0) range.setStartBefore(k0);
  if (k1) range.setEndAfter(k1);
  const frag = range.cloneContents();
  frag.querySelectorAll(".katex").forEach((k) => {
    const tex = k.querySelector("annotation")?.textContent || k.textContent;
    k.replaceWith(k.closest(".katex-display") ? `$$${tex}$$` : `$${tex}$`);
  });
  const box = document.createElement("div");
  box.append(frag);
  return box.textContent.replace(/\s+\n/g, "\n").trim();
}

function maybeShowSelAsk() {
  hideSelAsk();
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const msg = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer.closest(".msg-a") : range.commonAncestorContainer.parentElement?.closest(".msg-a");
  if (!msg || !msg.closest("#tutor") || !sel.toString().trim()) return;
  const rect = range.getBoundingClientRect();
  selAskBtn = h("button", { class: "sel-ask", type: "button",
    onmousedown: (e) => e.preventDefault(),         // keep the selection while clicking
    onclick: () => { const r = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : range; const md = selectionMarkdown(r); const para = paraOf(r.startContainer.parentElement); sel.removeAllRanges(); openSide({ anchor: md, para, selection: true }); } },
    "Ask about this");
  selAskBtn.style.left = `${Math.max(8, Math.min(window.innerWidth - 140, rect.left + rect.width / 2 - 60))}px`;
  selAskBtn.style.top = `${Math.min(window.innerHeight - 44, rect.bottom + 8)}px`;
  document.body.append(selAskBtn);
}
let selTimer = 0;
document.addEventListener("selectionchange", () => { clearTimeout(selTimer); selTimer = setTimeout(maybeShowSelAsk, 250); });
document.addEventListener("scroll", hideSelAsk, true);

function updateTutorWhere() {
  const w = $("#tutor-where");
  if (w && APP.deck) w.textContent = APP.scope === "deck" || APP.n > APP.deck.slides ? `${APP.deck.tag} · whole deck` : `${APP.deck.tag} s${APP.n}`;
}

// What Try one / Worked example / Explain simply / Grill me / Quiz prep / Before you start work on: the current slide or
// the whole deck. (Big picture and Cheat sheet are always the whole deck.)
const tryKind = () => (APP.scope === "deck" ? "deck" : "try");
function scopeSwitch() {
  const mk = (value, label) => h("button", { type: "button", role: "radio", "aria-checked": String(APP.scope === value),
    class: APP.scope === value ? "on" : "", onclick: () => { APP.scope = value; store.set("scope", value); renderTutor(); } }, label);
  return h("div", { class: "scope-switch", role: "radiogroup", "aria-label": "Work on" }, mk("slide", "This slide"), mk("deck", "Whole deck"));
}

function composeBox(placeholder, onSend) {
  const ta = h("textarea", { id: "ask-input", rows: "1", placeholder, "aria-label": placeholder,
    "aria-autocomplete": "list", "aria-controls": "slash-menu" });
  // A new box is empty, so nothing in it was dictated; one drawn mid-dictation takes over the text so far.
  if (DICT.state === "idle") DICT.spoken = false; else ta.value = DICT.last;
  const send = h("button", { class: "btn ghost", type: "submit" }, "Ask");
  const menu = h("ul", { class: "slash-menu", id: "slash-menu", role: "listbox", hidden: true });
  const form = h("form", { class: "compose", onsubmit: (e) => {
    e.preventDefault();
    const q = ta.value.trim();
    if (!q) return;
    const slash = q.startsWith("/") ? slashCommand(q) : null;
    if (slash && slash.error) return toast(slash.error);
    const spoken = DICT.spoken;                     // dictated (even in part)
    cancelDictation();                              // sending while still listening drops the recording
    DICT.spoken = false;
    ta.value = ""; autosize(); send.classList.add("ghost"); slashMenu();
    if (slash) slash.run(spoken); else onSend(q, spoken);
  } }, menu, ta, micOk() ? dictateButton(ta) : null, send);
  const autosize = () => {
    ta.style.height = "auto";
    ta.style.height = ta.value ? `${Math.min(160, ta.scrollHeight + 2)}px` : "";      // (empty: its own height, not the placeholder's)
  };
  // Typing "/" at the start lists the modes; up/down pick, Tab (or Enter) fills one in, then add your own words.
  let pick = 0, shown = [];
  const fill = (c) => { ta.value = `/${c.cmd} `; ta.focus(); ta.dispatchEvent(new Event("input")); };
  const slashMenu = () => {
    const m = ta.value.match(/^\/(\w*)$/);
    shown = m ? slashList().filter((c) => c.cmd.startsWith(m[1].toLowerCase())) : [];
    pick = Math.min(pick, Math.max(0, shown.length - 1));
    menu.hidden = !shown.length;
    ta.setAttribute("aria-expanded", String(!!shown.length));
    menu.replaceChildren(...shown.map((c, i) => h("li", { role: "option", id: `slash-${c.cmd}`, "aria-selected": String(i === pick), class: i === pick ? "on" : "",
      onmousedown: (e) => { e.preventDefault(); fill(c); } }, h("b", {}, `/${c.cmd}`), h("span", {}, c.hint))));
    if (shown.length) { ta.setAttribute("aria-activedescendant", `slash-${shown[pick].cmd}`); menu.children[pick].scrollIntoView({ block: "nearest" }); }
    else ta.removeAttribute("aria-activedescendant");
  };
  ta.addEventListener("input", () => { autosize(); send.classList.toggle("ghost", !ta.value.trim()); pick = 0; slashMenu(); if (!ta.value.trim()) DICT.spoken = false; });
  ta.addEventListener("blur", () => { menu.hidden = true; ta.setAttribute("aria-expanded", "false"); });
  ta.addEventListener("keydown", (e) => {
    if (!menu.hidden && shown.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); pick = (pick + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length; slashMenu(); return; }
      if (e.key === "Escape") { e.preventDefault(); menu.hidden = true; ta.setAttribute("aria-expanded", "false"); return; }
      // Tab fills the command in; so does Enter, unless it's already typed out in full (then Enter runs it).
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && ta.value.trim() !== `/${shown[pick].cmd}`)) { e.preventDefault(); fill(shown[pick]); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  return form;
}

// Slash commands: every tutor mode from the chat box, with your own words after it ("/explain using a bank
// queue", "/try something with worked numbers"). They follow the This slide / Whole deck switch like the buttons.
const SLASH = [
  { cmd: "explain", mode: "explain", hint: "Explain simply" },
  { cmd: "example", mode: "example", hint: "Worked example" },
  { cmd: "try", hint: "A practice problem (say what kind)" },
  { cmd: "quiz", mode: "quiz", hint: "Quiz prep" },
  { cmd: "grill", mode: "grill", hint: "Grill me: an oral exam" },
  { cmd: "end", mode: "grill_end", hint: "End the grill", when: () => grilling() },
  { cmd: "before", mode: "before", hint: "Before you start: what to know first" },
  { cmd: "deeper", mode: "deeper", hint: "Go deeper on the last answer", when: () => !!(APP.deck && APP.deck.chat && APP.deck.chat.messages.length) },
  { cmd: "bigpicture", mode: "map_deck", hint: "Big picture · whole deck" },
  { cmd: "cheatsheet", mode: "cheatsheet_deck", hint: "Cheat sheet · whole deck" },
  { cmd: "brush", mode: "brush", hint: "Brush up a prerequisite (say which)", needs: "Say what to brush up on, e.g. /brush percentage change" },
];
const slashList = () => SLASH.filter((c) => !c.when || c.when());

function slashCommand(text) {
  const m = text.match(/^\/(\w+)\s*([\s\S]*)$/);
  const c = m && SLASH.find((x) => x.cmd === m[1].toLowerCase());
  if (!c) return { error: `No command ${text.split(/\s/)[0]}. Type / to see them.` };
  if (c.when && !c.when()) return { error: `/${c.cmd} isn't available right now.` };
  const extra = m[2].trim();
  if (c.needs && !extra) return { error: c.needs };
  if (!c.mode) return { run: () => startPracticeInPanel({ kind: tryKind(), focus: extra }) };
  return { run: (spoken) => tutorAsk(c.mode, extra, { spoken }) };
}

const MODE_LABEL = { explain: "Explain simply", example: "Worked example", deeper: "Go deeper", quiz: "Quiz prep",
  explain_deck: "Explain simply · whole deck", example_deck: "Worked example · whole deck", quiz_deck: "Quiz prep · whole deck",
  map_deck: "Big picture · whole deck", before: "Before you start", before_deck: "Before you start · whole deck",
  cheatsheet_deck: "Cheat sheet · whole deck", grill: "Grill me", grill_deck: "Grill me · whole deck", grill_end: "End the grill" };
const DECK_MODES = ["explain", "example", "quiz", "before", "grill"];
// The question line for a request: what the student typed, or the mode's label.
const askText = (mode, question) => (mode === "ask" || mode === "grill_reply" ? question : mode === "brush" ? `Brush up: ${question}`
  : question ? `${MODE_LABEL[mode]}: ${question}` : MODE_LABEL[mode]);     // a slash command's own words follow the mode

// Grill me runs over several turns: while the chat's last answer is a grill question, what the student types is
// their answer (mode grill_reply), so it stays in the grill until the summary or another request ends it.
const GRILL_MODES = ["grill", "grill_deck", "grill_reply"];
function grilling() {
  const msgs = APP.deck && APP.deck.chat ? APP.deck.chat.messages : [];
  const last = msgs[msgs.length - 1];
  return !!last && last.role === "a" && GRILL_MODES.includes(last.mode);
}
const composeHint = () => (grilling() ? "Your answer, or \"stuck\" / \"stop\""
  : APP.tutor === "open" ? "Ask anything about this slide, or / for a mode"
  : `Ask about slide ${Math.min(APP.n, APP.deck ? APP.deck.slides : APP.n)}… or / for a mode`);
function updateComposeHint() {
  const ta = $("#ask-input");
  if (ta) { ta.placeholder = composeHint(); ta.setAttribute("aria-label", ta.placeholder); }
  if (DICT.state !== "idle") dictShow();          // still dictating: keep "Listening…" in the box
}

function drawThread() {
  const th = $("#thread");
  if (!th) return;
  th.replaceChildren();
  // Turns still being written go back at the end, in order (place); another deck's turns are gone. An answer still
  // being read aloud keeps its element (VOICE.view), so its voice, glow and pacing carry on.
  for (const t of TURNS) if (!sameDeck(t.d, APP.deck)) TURNS.delete(t);
  const msgs = APP.deck.chat ? APP.deck.chat.messages : [];
  if (APP.deck.chat && msgs.length) th.append(chatBar(APP.deck.chat));
  if (!msgs.length && !TURNS.size) {
    th.append(h("p", { class: "empty" }, APP.view === "voice" ? "Ask anything about this slide, or type / for a mode. Voice: answers are read aloud as they appear."
      : "Ask anything about this slide, or type / for a mode."));
    const earlier = APP.deck.chats || [];
    if (earlier.length) th.append(h("div", { class: "earlier" }, h("p", { class: "empty" }, "Earlier chats in this course:"),
      ...earlier.map((c) => h("button", { class: "link", type: "button", onclick: () => openChat(c.id) }, c.starred ? `★ ${c.title}` : c.title))));
  }
  const spoken = VOICE.view && VOICE.view.msg;
  msgs.forEach((m, i) => {
    if (m.role === "q") th.append(h("p", { class: "msg-q" }, m.spoken || m.mode === "voice" ? `🎙 ${m.text}` : m.text, h("span", { class: "where" }, msgWhere(m, APP.deck.chat, APP.deck.tag))));
    else if (m === spoken) th.append(VOICE.view.root);
    else th.append(answerEl(m, i === msgs.length - 1 && !TURNS.size));
  });
  for (const t of TURNS) t.place(th);
  if (VOICE.view && !VOICE.view.root.isConnected) stopSpeaking();      // (its answer went with another deck)
  pinBelowBar(th);
  th.scrollTop = th.scrollHeight;
  updateComposeHint();
}

// The same deck, even when it was fetched again (a citation chip, the deck reopened).
const sameDeck = (a, b) => !!a && !!b && a.course === b.course && a.tag === b.tag;
// An answer's pinned drawing sticks just under the chat bar (--pin: the bar's height), so the bar stays in view.
const PIN_RO = new ResizeObserver((es) => { for (const e of es) e.target.parentElement?.style.setProperty("--pin", `${e.target.offsetHeight}px`); });
function pinBelowBar(th) {
  const bar = $(".chat-bar", th);
  th.style.setProperty("--pin", `${bar?.offsetHeight || 0}px`);
  PIN_RO.disconnect();
  if (bar) PIN_RO.observe(bar);       // (and again whenever its height changes)
}

// The deck a saved question is about: older ones carry none (the chat's own deck), and `deck: true` once meant Whole deck.
const msgDeck = (m, chat) => (typeof m.deck === "string" ? m.deck : chat.deck) || "";
// " · s14" on the open deck, " · S&D-2 s14" from another deck of the course, " · S&D-2" for a whole-deck question.
function msgWhere(m, chat, tag) {
  const deck = msgDeck(m, chat);
  if (m.whole || m.deck === true) return ` · ${deck || tag}`;
  return m.slide ? ` · ${deck && deck !== tag ? `${deck} ` : ""}s${m.slide}` : "";
}

// A finished answer: drawings in their place in the text, cues on their paragraphs, sentences marked for the glow.
function answerEl(m, isLast) {
  const body = cueMdCached(m.text, APP.deck.course);
  body.className = "msg-a";
  const root = h("div", { class: "ans" }, body, answerTools(m, isLast));
  body.addEventListener("click", (e) => tapCues(e, root));
  return root;
}

// Under an answer: Copy, ▶ Play, and what to do next (the last one).
function answerTools(m, isLast) {
  const out = [h("button", { class: "copy-one", type: "button", title: "Copy this answer", onclick: (e) => copyText(unmark(m.text), e.currentTarget) }, "Copy")];
  const play = h("button", { class: "link quiet play", type: "button", title: "Read this answer aloud", onclick: (e) => playAnswer(m, e.currentTarget) }, "▶ Play");
  play.msg = m;
  // Drawn again while it is read aloud: this one is its ■ Stop now.
  if (VOICE.playBtn && VOICE.playBtn.msg === m) { VOICE.playBtn = play; play.textContent = "■ Stop"; }
  out.push(play);
  if (isLast && GRILL_MODES.includes(m.mode)) {
    out.push(h("div", { class: "msg-foot" },
      h("button", { class: "link", type: "button", title: "Stop here: what held up and what's shaky", onclick: () => tutorAsk("grill_end") }, "End the grill: summary ›")));
  } else if (isLast) {
    const deckWide = (m.mode || "").endsWith("_deck");
    const next = (m.mode || "").startsWith("example")
      ? h("button", { class: "link", type: "button", onclick: () => startPracticeInPanel({ kind: "yourturn", example_md: m.text }) }, "Your turn: finish from here ›")
      : h("button", { class: "link", type: "button", onclick: () => startPracticeInPanel({ kind: deckWide ? "deck" : "try" }) }, deckWide ? "Try one on this deck ›" : "Try one on this ›");
    out.push(h("div", { class: "msg-foot" }, next,
      m.mode !== "deeper" ? h("button", { class: "link quiet", type: "button", onclick: () => tutorAsk("deeper") }, "Go deeper") : null));
  }
  return out;
}

// ---- Text | Voice
// One chat, two paces. Text: an answer appears as fast as it is written, silent unless ▶ Play. Voice: it is read
// aloud, appearing in the thread a sentence at a time as it is spoken. Both draw it with answerView. (A stored
// "board" is the old name of Voice.)
APP.view = store.get("view", "text") === "text" ? "text" : "voice";
// TURNS: the questions still being answered, oldest first (tutorAsk's handles: { d: its deck, place(thread) }),
// so a redraw of the thread puts them back.
const TURNS = new Set();
const voiceOn = () => APP.view === "voice" && !store.get("reading", false);     // (the Read view is never paced)

function viewSwitch() {
  const mk = (v, label, title) => h("button", { type: "button", role: "radio", "aria-checked": String(APP.view === v), title,
    class: APP.view === v ? "on" : "", onclick: () => { if (APP.view !== v) { APP.view = v; store.set("view", v); stopSpeaking(); renderTutor(); } } }, label);
  return h("div", { class: "scope-switch view-switch", role: "radiogroup", "aria-label": "Answers" },
    mk("text", "Text", "Answers appear as they're written; ▶ Play reads one aloud"),
    mk("voice", "Voice", "Answers are read aloud, appearing as they're spoken"));
}

// An answer as it is written. answerView(course, { paced }) returns { root, feed(chunk), end(text?), revealTo(i)
// (resolves once the drawings shown are drawn), glow(start, end), showAll(), settle, msg }. While it is written its
// drawings go up in .ans-draw, pinned at the top of the thread, one figure each in order: an ```svg drawing element
// by element as it streams (svgStream), Mermaid and plots whole once their block closes. The text goes in the
// .msg-a under it, finished blocks rendered once. Once it is all shown and the stream has ended, settle() (set by
// the caller) swaps in the finished answer (answerEl), its drawings in their place in the text.
// Unpaced (Text), the answer shows as it streams. Paced (Voice), only up to revealTo(i), an offset in the raw text
// (cues included): the text up to there, and a drawing once i reaches its fence; showAll() shows the rest.
// glow(start, end): the sentences of raw text [start, end) are being spoken (.spoken); glow(null): none.
// Cues: a part named by a cue already seen in the stream when it is drawn waits, hidden, until that cue's text is
// revealed; a part drawn before any cue names it stays shown. The latest revealed cued sentence lights its parts.
const DRAWING = /^ {0,3}(```|~~~)\s*(mermaid|svg|plot)\b/;
function answerView(course, { paced = false } = {}) {
  const draw = h("div", { class: "ans-draw" }), done = h("div"), tail = h("div");
  const root = h("div", { class: "ans live" }, draw, h("div", { class: "msg-a", onclick: (e) => tapCues(e, root) }, done, tail));
  const st = root.cue = { build: true, shown: new Set(), on: [], named: new Set() };
  // taken: the raw text already written or drawn; open: the svg drawing streaming in at `taken`; figs: drawings done;
  // live: drawn on as it goes up (streamed in, or paced: even an answer that arrived whole before its first paint);
  // said: the raw text being spoken, [start, end).
  let acc = "", taken = 0, upto = 0, ended = false, all = false, live = paced, open = null, figs = [], said = null;
  let fresh = [];         // svg parts drawn while streaming, not yet stroked on: each is, once it is first in view
  let drawn = Promise.resolve();      // the drawings put up so far are drawn (Mermaid renders later)
  const got = (n) => { if (live) fresh.push(n); };
  const pens = () => {
    if (!draw.isConnected) return;
    let k = 0;
    fresh = fresh.filter((n) => { const r = penOn(n, k); if (r.did) k++; return r.left; });
  };
  const shownTo = () => (all || !paced ? acc.length : Math.min(upto, acc.length));
  const write = (md, at = taken) => { if (md.trim()) done.append(...cueMd(md, course, at).childNodes); };
  const paint = () => {
    const was = said && $(".snt.spoken", root);
    if (was) track = inThread(was);       // (scrolled away from it: stay there; back on it: follow again)
    for (const m of acc.matchAll(CUE)) st.named.add(m[1]);      // first: a part drawn now must know it is named
    const lim = shownTo(), final = ended && lim >= acc.length;
    tail.replaceChildren();
    for (;;) {
      const rest = acc.slice(taken), f = rest.search(/^ {0,3}(```|~~~)/m);
      // (Paced, nothing goes up before the first reveal: a drawing the answer opens with waits for the first piece
      // said, so the cues streamed by then decide which of its parts wait for their sentence.)
      if (f < 0 || taken + f > lim || (paced && !all && !upto)) {    // text: everything before the last blank line that isn't inside $$…$$
        const txt = acc.slice(taken, lim);
        let cut = final ? txt.length : 0;
        for (let i = txt.lastIndexOf("\n\n"); !final && i > 0; i = txt.lastIndexOf("\n\n", i - 1)) {
          if ((txt.slice(0, i).split("$$").length - 1) % 2 === 0) { cut = i + 2; break; }
        }
        write(txt.slice(0, cut));
        taken += cut;
        const t = acc.slice(taken, lim);
        tail.replaceChildren(...cueMd(final ? t : t.replace(/\[(#[\w-]*)?$/, ""), course, taken).childNodes);   // not half a cue
        break;
      }
      write(rest.slice(0, f));
      taken += f;
      const block = acc.slice(taken), nl = block.indexOf("\n"), isDraw = DRAWING.test(block), mark = block.trimStart().slice(0, 3);
      const close = block.slice(1).match(new RegExp(`\\n {0,3}${mark}[ \\t]*(?:\\n|$)`));
      // Still streaming in: an svg drawing goes up as its elements close, code shows as it comes. (Paced, a drawing
      // goes up whole once it is complete, every part decided then, with all the cues streamed so far.)
      if (!close) {
        if (!isDraw) { if (final) write(block); else tail.replaceChildren(...cueMd(block, course, taken).childNodes); }
        else if (/^\s*(```|~~~)\s*svg/.test(block) && (all || !paced)) {
          if (!open) open = svgStream();
          if (nl > 0 && open.feed(block.slice(nl + 1), got)) {
            open.el = draw.appendChild(h("div", { class: "ans-fig" }, open.fig));
            drawn = fitDrawings(draw).then(cues);
          }
        } else if (/mermaid/.test(block.slice(0, nl < 0 ? 20 : nl))) loadMermaid().catch(() => {});   // it loads meanwhile
        if (final) {           // never closed: what was drawn of it stays, otherwise its source is text
          if (isDraw && open && open.count) figs.push({ el: open.el, end: acc.length });
          else if (isDraw) { open?.el?.remove(); write(block); }
          open = null;
          taken = acc.length;
        }
        break;
      }
      const end = 1 + close.index + close[0].length, src = block.slice(0, end);
      if (!isDraw) { write(src); taken += end; continue; }       // a code block is text
      taken += end;
      let el = open && open.el;
      if (el) open.feed(block.slice(nl + 1, 1 + close.index), got);
      // Nothing streamed (no viewBox, or it arrived whole), or a piece it couldn't read: drawn whole.
      if (!el || !open.count || !open.sound()) {
        const fig = h("div", { class: "ans-fig" }, ...renderMd(src, course).childNodes);
        if (el) { fresh = fresh.filter((n) => !el.contains(n)); el.replaceWith(fig); } else draw.append(fig);
        el = fig;
        drawn = fitDrawings(draw).then(cues);       // (inlines the svg at once; Mermaid draws later)
        $$(".cue-svg", fig).forEach((s) => [...s.children].forEach((n) => { if (n.localName !== "defs") got(n); }));
      }
      open = null;
      figs.push({ el, end: taken });
    }
    cues();
    pens();       // after the cues, so a part waiting for its sentence is drawn on when it appears
    glowText(root, said);      // (the text was written again: the sentence being said glows again)
    keep();
  };
  // The sentence being said stays in view (below the pinned drawing) while the student follows it.
  let track = true;     // (declared here, used by paint, revealTo and glow)
  const keep = () => { const sp = said && track && $(".snt.spoken", root); if (sp && root.isConnected) keepInView(sp); };
  // Which parts show and which are lit, from the text revealed so far (while this answer is building its drawing).
  const cues = () => {
    if (root.cue !== st || !draw.isConnected) return;
    const lim = shownTo(), shown = acc.slice(0, lim);
    st.on = [];
    for (const p of cueSplit(shown)) if (p.cues.length) { p.cues.forEach((id) => st.shown.add(id)); st.on = p.cues; }
    // A drawing whose first two sentences after it name none of its parts was drawn without cues: it shows whole.
    for (const fg of figs) {
      if (fg.decided || fg.end > lim || $$(".mermaid-box", fg.el).some((m) => !$("svg, pre", m))) continue;   // (still drawing)
      const ids = [...cueParts(fg.el).parts.keys()];
      const after = sentences(shown.slice(fg.end).replace(/(```|~~~)[\s\S]*?(\1|$)/g, " ")).filter((s) => s.trim()).slice(0, 2);
      if (after.some((s) => [...s.matchAll(CUE)].some((m) => ids.includes(m[1])))) fg.decided = true;
      else if ((after.length === 2 && /([.!?]["')\]]*\s+|\n+)$/.test(after[1])) || (ended && lim >= acc.length)) {
        fg.decided = true;
        ids.forEach((id) => st.shown.add(id));
      }
    }
    applyCues(root);
  };
  const view = {
    root, msg: null, settle: null,
    following: () => paced && upto > 0 && track,       // (the student follows the voice: the end follows too)
    feed: (chunk) => { acc += chunk; live = true; paint(); },
    // The answer is complete (final: the saved text, in case it isn't what streamed).
    end: (final) => {
      if (final != null && final !== acc) {
        if (!final.startsWith(acc)) { draw.replaceChildren(); done.replaceChildren(); taken = 0; open = null; figs = []; }
        acc = final;
      }
      ended = true;
      if (paced && !all) paint(); else view.showAll();
    },
    // (Following the newest words down, unless the student scrolled up; the sentence being said stays in view while
    // the student follows it: decided before this scrolls.)
    revealTo: (i) => {
      const was = $(".snt.spoken", root);
      track = !was || inThread(was);       // (the student is following it, or it's the first)
      if (i > upto) {
        const th = root.closest(".thread"), follow = th && th.scrollHeight - th.scrollTop - th.clientHeight < 80;
        upto = i;
        paint();
        if (follow) th.scrollTop = th.scrollHeight;
      }
      return drawn;
    },
    glow: (s, e) => {
      said = s == null ? null : [s, e];
      glowText(root, said);
      keep();
    },
    showAll: () => {
      all = true;
      said = null;
      paint();
      if (root.cue === st) endCues(root);
      pens();
      if (ended && view.settle) { const s = view.settle; view.settle = null; s(); }
    },
  };
  return view;
}

// ▶ Play on a finished answer: nothing is hidden or written again; the sentence being said glows and the drawing
// parts it names light up, in this answer only. Same shape as answerView's handle.
function playView(root, m) {
  inlineDrawings(root);
  litOnly(root);
  const st = root.cue = { build: false, shown: new Set(), on: [] };
  return {
    root, msg: m,
    revealTo: (i) => {
      st.on = [];
      for (const p of cueSplit(m.text.slice(0, i))) if (p.cues.length) st.on = p.cues;
      if (root.cue === st) applyCues(root);
      return Promise.resolve();
    },
    // The glow stays in view while the student follows it (it was in view, or it's the first).
    glow: (s, e) => {
      const was = $(".snt.spoken", root), follow = !was || inThread(was);
      glowText(root, s == null ? null : [s, e]);
      const now = $(".snt.spoken", root);
      if (now && follow) keepInView(now);
    },
    showAll: () => { glowText(root, null); if (root.cue === st) endCues(root); },
  };
}

// The sentences of root covering raw text [span[0], span[1]) glow (.spoken); span null: none. A sentence is the
// .snt elements sharing a data-o (its offset in the raw text, from cueMd); the one the span starts inside counts too.
function glowText(root, span) {
  const els = $$(".snt", root);
  let from = -1;
  if (span) for (const el of els) { const o = +el.dataset.o; if (o <= span[0] && o > from) from = o; }
  if (span && from < 0) from = span[0];
  for (const el of els) { const o = +el.dataset.o; el.classList.toggle("spoken", !!span && o >= from && o < span[1]); }
}
// The part of the thread that shows its text: below the chat bar and any pinned drawing stuck at its top.
function threadView(th) {
  const t = th.getBoundingClientRect();
  let top = t.top;
  for (const el of $$(":scope > .chat-bar, :scope > .ans.live > .ans-draw", th)) {
    const r = el.getBoundingClientRect();
    if (r.height && r.top <= top + 4 && r.bottom > top) top = r.bottom;
  }
  return { top, bottom: t.bottom };
}
function inThread(el) {
  const th = el.closest(".thread");
  if (!th) return false;
  const r = el.getBoundingClientRect(), v = threadView(th);
  return r.bottom > v.top && r.top < v.bottom;
}
function keepInView(el) {       // (scrolls only the thread, never the page; a tall sentence shows from its start)
  const th = el.closest(".thread");
  if (!th) return;
  for (let k = 0; k < 2; k++) {      // (scrolling can pin or unpin a drawing: look again once)
    const r = el.getBoundingClientRect(), v = threadView(th), pad = 8;
    if (r.top < v.top + pad) th.scrollTop -= v.top + pad - r.top;
    else if (r.bottom > v.bottom - pad) th.scrollTop += Math.min(r.bottom - v.bottom + pad, r.top - v.top - pad);
    else return;
  }
}

// An ```svg drawing as it streams in: a scanner over the block's body that tracks tag depth (skipping comments and
// quoted ">") puts up the root once its opening tag is complete, then each top-level element once it closes.
// Every piece goes through inlineSvg's allowlist; the root also gets the hub's arrowhead (unless the drawing defines
// its own, as in svgImage). A root without a viewBox is left to be drawn whole (off), and so is a drawing with a
// piece that wouldn't parse or whose tags didn't add up (!sound()). feed(body so far, got) calls got(element) for
// each element put up, and returns true when the root has just gone up.
function svgStream() {
  let pos = 0, depth = 0, start = -1, over = false, bad = false, hub = null, last = "";
  // Sound: the root closed with nothing after it (a lost count would end it early, or never), every piece read.
  const s = { fig: null, root: null, count: 0, off: false, sound: () => over && !bad && !last.slice(pos).includes("<") };
  const piece = (src) => inlineSvg(svgFix(`<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}">${src}</svg>`));
  s.feed = (src, got) => {
    let up = false;
    last = src;
    const add = (part) => {
      const w = piece(part);
      if (!w) { bad = true; return; }
      if (hub && w.querySelector("#tsvg-arrow")) { hub.remove(); hub = null; }
      for (const n of [...w.children]) { s.root.append(n); s.count++; got(n); }
    };
    while (!s.off && !over) {
      const lt = src.indexOf("<", pos);
      if (lt < 0) { pos = src.length; break; }
      if (src.length - lt < 4) break;                // "<!-" or a name: wait for more
      if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); if (e < 0) break; pos = e + 3; continue; }
      if (src.startsWith("<![CDATA[", lt)) { const e = src.indexOf("]]>", lt + 9); if (e < 0) break; pos = e + 3; continue; }
      if (src[lt + 1] === "!" || src[lt + 1] === "?") { const e = src.indexOf(">", lt); if (e < 0) break; pos = e + 1; continue; }
      let q = "", e = -1;
      for (let i = lt + 1; i < src.length; i++) {
        const c = src[i];
        if (q) { if (c === q) q = ""; } else if (c === '"' || c === "'") q = c; else if (c === ">") { e = i; break; }
      }
      if (e < 0) break;                              // the tag is still streaming in
      pos = e + 1;
      const tag = src.slice(lt, pos), closing = tag[1] === "/", empty = /\/\s*>$/.test(tag);
      if (!s.root) {
        if (closing || !/^<svg[\s/>]/i.test(tag)) continue;
        const r = inlineSvg(svgFix(`${tag.replace(/\/\s*>$/, ">")}</svg>`));
        if (!r || !r.hasAttribute("viewBox")) { s.off = true; break; }
        hub = piece(SVG_ARROW).firstElementChild;
        r.prepend(hub);
        s.root = r;
        s.fig = h("figure", { class: "diagram svg-box" }, r);
        up = true;
        if (empty) over = true; else depth = 1;
      } else if (closing) {
        if (--depth === 1 && start >= 0) { add(src.slice(start, pos)); start = -1; }
        if (depth < 1) over = true;                  // the root closed
      } else if (depth === 1) {
        if (empty) add(tag); else { start = lt; depth = 2; }
      } else if (!empty) depth++;
    }
    return up;
  };
  return s;
}

// Pen: a part is stroked on (stroke-dashoffset from its length, --len, to 0) as it comes into view; fills fade in,
// and so do text and dashed lines (which keep their dashes). Elements still hidden by a cue wait: { did: any drawn
// now, left: how many still wait }. k staggers the parts that go up together.
const PENNED = new WeakSet();
function penOn(node, k = 0) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return { did: false, left: 0 };
  let did = false, left = 0;
  for (const el of [node, ...node.querySelectorAll("*")]) {
    if (PENNED.has(el) || el.closest("defs")) continue;
    if (el.closest(".cue-hide")) { left++; continue; }
    PENNED.add(el);
    did = true;
    el.style.animationDelay = `${Math.min(k, 8) * 0.15}s`;
    if (el.localName === "text" || el.hasAttribute("stroke-dasharray")) el.classList.add("pen-fade");
    else if (el instanceof SVGGeometryElement) {
      let len = 0;
      try { len = +el.getAttribute("pathLength") || el.getTotalLength(); } catch { /* not laid out */ }
      if (len > 0) { el.style.setProperty("--len", len); el.classList.add("pen"); }
    }
  }
  if (did) node.addEventListener("animationend", (e) => e.target.classList.remove("pen", "pen-fade"));
  return { did, left };
}

// An answer's text (md: from a line start, at offset `at` of the answer's raw text), rendered exactly as renderMd
// renders it, with its sentences marked for the spoken glow (.snt spans, data-o: the raw offset where each starts)
// and its cues kept as data-cues on the paragraph (or item) of the sentence that carried them, for a tap to light.
// The marks must never change the rendering: if the marked render differs from the plain one (apart from the marks),
// the marks inside lines are dropped, and failing that the whole text is one sentence.
function cueMd(md, course, at = 0) {
  md = String(md);
  const same = (a, b) => a.innerHTML.replace(SNT_MARKS, "").replace(/clip[0-9a-z]*/g, "clip") === b.innerHTML.replace(/clip[0-9a-z]*/g, "clip");
  const plain = renderMd(md, course);       // (a plot's clip id is random: not a difference)
  let box = renderMd(markSentences(md, at), course), start = null;
  if (!same(box, plain)) {
    box = renderMd(markSentences(md, at, true), course);
    if (!same(box, plain)) { box = plain; start = at; }
  }
  spanSentences(box, start);
  if (start != null) { cueBlocks(md, course, box); return box; }
  // A cue belongs to the sentence it is in: its paragraph (or item) carries it.
  const snts = $$(".snt", box).map((el) => [+el.dataset.o, el]);
  for (const m of md.matchAll(CUE)) {
    const c = at + m.index;
    let el = null, o = -1;
    for (const [k, e] of snts) if (k <= c && k > o) { o = k; el = e; }
    // (a cue a sentence opens with sits before its mark, on the same line: it is that sentence's)
    const next = snts.find(([k]) => k > c && /^([ \t]*\[#[A-Za-z][\w-]{0,40}\])*[ \t]*$/.test(md.slice(c - at, k - at)));
    if (next) el = next[1];
    const blk = (el || box).closest("p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dd") || $("p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dd", box);
    if (blk && box.contains(blk)) blk.dataset.cues = `${blk.dataset.cues || ""} ${m[1]}`.trim();
  }
  return box;
}
// Cues on their paragraphs without sentence marks: rendered as markers, each marker's block (by its place among
// the blocks) carries its cue in box, the same text rendered plain.
const CUE_BLOCK = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dd";
function cueBlocks(md, course, box) {
  const ids = [];
  const marked = renderMd(md.replace(/[ \t]?\[#([A-Za-z][\w-]{0,40})\]/g, (_, id) => `\uE000${ids.push(id) - 1}\uE001`), course);
  const from = $$(CUE_BLOCK, marked), to = $$(CUE_BLOCK, box);
  const walk = document.createTreeWalker(marked, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) for (const m of walk.currentNode.nodeValue.matchAll(/\uE000(\d+)\uE001/g)) {
    const blk = to[from.indexOf(walk.currentNode.parentElement.closest(CUE_BLOCK))] || to[0];
    if (blk) blk.dataset.cues = `${blk.dataset.cues || ""} ${ids[+m[1]]}`.trim();
  }
}
// Finished answers are rendered once and reused, like renderMdCached.
const CUE_CACHE = new Map();
function cueMdCached(text, course) {
  const key = `${course}\u0000${text}`, hit = CUE_CACHE.get(key), box = document.createElement("div");
  if (hit != null) { box.innerHTML = hit; return box; }
  const fresh = cueMd(text, course);
  CUE_CACHE.set(key, fresh.innerHTML);
  if (CUE_CACHE.size > 300) CUE_CACHE.delete(CUE_CACHE.keys().next().value);
  return fresh;
}

// The spoken glow needs to know which rendered words are which raw text. Before rendering, a mark carrying its raw
// offset goes in where each sentence starts: at each line's content (after any list, task box, heading, quote or
// table-cell marker) and after each ". " / "? " / "! " in it (linesOnly: line starts only). A mark goes inside an
// emphasis opener (**…), never between characters renderMd takes as code, a [[term]], maths, an HTML tag or a link
// target (mdProtected: its own regexes), never before an autolink, and not on lines a character could change
// (fences, table rules, rules and setext underlines, link definitions, HTML lines). spanSentences then wraps each
// run of text in a .snt span with the offset of the mark before it; maths, inline code and term buttons become .snt
// whole; code blocks (never read out) don't glow. A sentence missing a mark joins the one before: it glows with it.
const SNT_OPEN = "", SNT_CLOSE = "", SNT_MARKS = /\d+/g;
function mdProtected(md) {      // an id per character: 0, or the code / term / maths / tag range it is in
  const id = new Int32Array(md.length + 1);
  let t = md, n = 0;
  // Like renderMd's replacements in order, each match taken out of what the later ones see (as x's).
  const pass = (re, fill = true) => {
    let out = "", last = 0;
    for (const m of t.matchAll(re)) {
      const a = m.index + (m.groups?.pre?.length || 0), b = m.index + m[0].length;
      n++;
      for (let i = a; i < b; i++) if (!id[i]) id[i] = n;       // (inside an earlier range: it stays that range)
      if (!fill) continue;
      out += t.slice(last, a) + (m.groups?.keep != null ? `xx${m.groups.keep}xx` : "x".repeat(b - a));
      last = b;
    }
    if (fill) t = out + t.slice(last);
  };
  pass(/```[\s\S]*?```|`[^`\n]+`/g);
  pass(/\[\[(?<keep>[^[\]\n]{1,120}?)\]\]/g);         // (a term's words stay: its maths is still maths)
  pass(/\$\$([\s\S]+?)\$\$/g);
  pass(/(?<pre>^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g);
  pass(/<\/?[A-Za-z][^>\n]*>|\]\([^)\n]*\)|\]\[[^\]\n]*\]/g, false);
  return id;
}
function markSentences(md, at, linesOnly = false) {
  const prot = mdProtected(md), out = [];
  let pos = 0, fence = "";
  for (const line of md.split("\n")) {
    const f = line.match(/^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+|>\s?)*(`{3,}|~{3,})/);
    let s = line;
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = ""; }
    else if (f) fence = f[1];
    else if (!/^\s*(<|([-*_=]\s*){3,}$|\|?[\s:|]*-[\s:|-]*$)|^\s{0,3}(=+|-+)\s*$|^\s{0,3}\[[^\]]+\]:/.test(line)) {
      const pre = line.match(/^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s?|\|\s*)*/)[0].length;
      const spots = [];
      const add = (i) => {
        i += line.slice(i).match(/^(\[#[A-Za-z][\w-]{0,40}\][ \t]*)*/)[0].length;   // after a cue (it goes with the space before it)
        i += line.slice(i).match(/^[*_~]*/)[0].length;          // inside an emphasis opener, not before it
        const g = pos + i;
        if (i >= line.length || /\s/.test(line[i]) || (prot[g] && prot[g] === prot[g - 1])
          || /^(www\.|https?:|[\w.+-]+@)/i.test(line.slice(i))) return;
        if (spots[spots.length - 1] !== i) spots.push(i);
      };
      if (pre < line.length && (pre === 0 || /\s/.test(line[pre - 1]))) add(pre);
      if (!linesOnly) for (const m of line.matchAll(/[.!?]["')\]]*[ \t]+(?=\S)/g)) if (m.index + m[0].length > pre) add(m.index + m[0].length);
      let k = 0;
      s = "";
      for (const i of spots) { s += line.slice(k, i) + SNT_OPEN + (at + pos + i) + SNT_CLOSE; k = i; }
      s += line.slice(k);
    }
    out.push(s);
    pos += line.length + 1;
  }
  return out.join("\n");
}
const BLOCK = "p, ul, ol, li, table, thead, tbody, tfoot, tr, td, th, caption, pre, div, blockquote, h1, h2, h3, h4, h5, h6, figure, details, summary, hr, dl, dd, dt, .katex-display";
function spanSentences(box, start = null) {
  let cur = start;
  const inline = (n) => n && (n.nodeType === 3 || (n.nodeType === 1 && !n.matches(BLOCK)));
  const walk = (el) => {
    for (const n of [...el.childNodes]) {
      if (n.nodeType === 1) {
        if (n.matches(".katex, .katex-display, pre, code, button.term, svg, .diagram, summary")) {      // whole: no spans inside
          const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
          while (w.nextNode()) if (w.currentNode.nodeValue.includes(SNT_OPEN)) w.currentNode.nodeValue = w.currentNode.nodeValue.replace(SNT_MARKS, "");
          if (cur != null && !n.matches("pre, svg, .diagram, summary")) { n.classList.add("snt"); n.dataset.o = cur; }
        } else walk(n);
      } else if (n.nodeType === 3 && (cur != null || n.nodeValue.includes(SNT_OPEN))) {
        const bits = n.nodeValue.split(/(\d+)/);
        // (the space between blocks stays as it is; between words and inline elements it glows too)
        if (bits.length === 1 && !/\S/.test(bits[0]) && !(inline(n.previousSibling) && inline(n.nextSibling))) continue;
        const out = [];
        bits.forEach((b, i) => {
          if (i % 2) cur = +b;
          else if (b) out.push(cur == null || (!/\S/.test(b) && bits.length > 1) ? b : h("span", { class: "snt", "data-o": cur }, b));
        });
        n.replaceWith(...out);
      }
    }
  };
  walk(box);
  for (const el of box.querySelectorAll("*")) for (const a of el.attributes) {      // (an image's words, a term, a link)
    if (a.value.includes(SNT_OPEN)) a.value = a.value.replace(SNT_MARKS, "");
  }
}

// A tap on a paragraph of an answer lights the parts of its drawing that the paragraph's cues name.
function tapCues(e, root) {
  if (e.target.closest("a, button, .spoiler") || !getSelection().isCollapsed || store.get("reading", false)) return;
  const ids = (e.target.closest("[data-cues]")?.dataset.cues || "").split(" ").filter(Boolean);
  if (ids.length && showCues(ids, root)) $(".cue-on", root)?.scrollIntoView({ block: "nearest" });
  else if (root.cue && !root.cue.build) endCues(root);
}

// SVG drawings go in as live (cleaned) SVG, so cues can reach their parts (a finished answer's at the size its image had).
function inlineDrawings(c) {
  $$(".svg-box[data-src]", c).forEach((fig) => {
    const img = $("img", fig), svg = img && inlineSvg(fig.dataset.src);
    if (!svg) return;
    if (img.clientWidth && !fig.closest(".ans-draw")) { svg.style.width = "100%"; svg.style.maxWidth = `${img.clientWidth}px`; }
    img.replaceWith(svg);
  });
}
// An answer's pinned drawings, while it is written: live SVG, scaled to the thread rather than to their text (Mermaid
// sets a max-width in px). Resolves once any Mermaid diagram is drawn.
function fitDrawings(c) {
  const root = c.closest(".ans") || c;
  inlineDrawings(c);
  applyCues(root);
  return drawMermaid().then(() => {
    // The drawings together (with their frames, ~24px each) take at most 40% of the thread: the text gets the rest.
    const svgs = $$(".mermaid-box svg, .svg-box svg", c);
    const max = `${Math.max(56, ((c.closest(".thread")?.clientHeight || 400) * 0.4) / svgs.length - 24)}px`;
    svgs.forEach((s) => {
      s.style.removeProperty("max-width");
      s.removeAttribute("height");
      s.style.maxHeight = max;
    });
    applyCues(root);
  });
}

function inlineMd(t, courseId) {
  const box = renderMd(t, courseId);
  const p = box.firstElementChild;
  return p && p.tagName === "P" && box.children.length === 1 ? [...p.childNodes] : [...box.childNodes];
}

// ---- copy and print a chat

function toast(msg) {
  const t = h("div", { class: "toast", role: "status" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 1800);
}

// navigator.clipboard needs a secure page; over the Wi-Fi address (http) the old copy command is the fallback.
async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = h("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text; document.body.append(ta); ta.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
  }
  if (btn) { const old = btn.textContent; btn.textContent = ok ? "Copied" : "Couldn't copy"; setTimeout(() => { btn.textContent = old; }, 1500); }
  else toast(ok ? "Copied" : "Couldn't copy");
}

// Describes the chat, not the deck open now: its one deck (with the title if that's the open one), or every deck it covers.
function chatMeta(chat, deck) {
  const code = chat.code || (deck && deck.code) || "";
  const decks = [...new Set((chat.messages || []).map((m) => msgDeck(m, chat)).filter(Boolean))];
  const one = decks.length > 1 ? "" : decks[0] || chat.deck || "";
  const where = decks.length > 1 ? decks.join(", ") : deck && deck.tag === one ? `${deck.tag} · ${deck.title}` : one;
  return [code, where, chat.updated || chat.created || ""].filter(Boolean).join(" · ");
}

// Copied Markdown shows terms as plain words, without the [[…]] that makes them buttons (or any cues).
const unmark = (t) => uncue(t).replace(/\[\[([^[\]\n]{1,120}?)\]\]/g, "$1");

function chatMarkdown(chat, deck) {
  const out = [`# ${chat.title || "Tutor chat"}`, "", `_${chatMeta(chat, deck)}_`, ""];
  for (const m of chat.messages || []) {
    if (m.role === "q") out.push(`**You**${m.slide ? ` (${[msgDeck(m, chat), `slide ${m.slide}`].filter(Boolean).join(" ")})` : ""}: ${m.text}`, "");
    else out.push(unmark(m.text).trim(), "", "---", "");
  }
  return out.join("\n");
}

function copyChat(chat, deck) {
  if (!chat || !(chat.messages || []).length) return toast("Nothing to copy yet");
  copyText(chatMarkdown(chat, deck));
}

// Print only the chat (questions, answers with rendered maths); the browser's dialog offers "Save as PDF".
function printChat(chat, deck) {
  if (!chat || !(chat.messages || []).length) return toast("Nothing to print yet");
  const courseId = chat.course || (deck && deck.course);
  const root = h("article", { id: "print-root" },
    h("h1", {}, chat.title || "Tutor chat"), h("p", { class: "print-meta" }, chatMeta(chat, deck)));
  for (const m of chat.messages) {
    if (m.role === "q") root.append(h("p", { class: "print-q" }, h("b", {}, "You"), m.slide ? ` (${[msgDeck(m, chat), `slide ${m.slide}`].filter(Boolean).join(" ")})` : "", ": ", m.text));
    else { const b = renderMd(m.text, courseId); b.className = "print-a"; $$("details", b).forEach((x) => { x.open = true; }); root.append(b); }
  }
  $("#print-root")?.remove();
  document.body.append(root);
  document.body.classList.add("printing");
  const done = () => { document.body.classList.remove("printing"); root.remove(); };
  window.addEventListener("afterprint", done, { once: true });
  // Diagrams are drawn asynchronously; wait for them so they appear in the PDF.
  setTimeout(() => drawMermaid().finally(() => setTimeout(() => window.print(), 80)), 80);
}

function metaText(m) {
  const who = APP.models.find((x) => x.id === m.model);
  return [who ? who.label.split(" — ")[0] : "", m.ms ? `${(m.ms / 1000).toFixed(0)} s` : "", m.cost != null ? `$${(+m.cost).toFixed(2)}` : ""].filter(Boolean).join(" · ");
}

// Scroll to the end now and again once a new answer is laid out (off-screen answers skip layout, content-visibility:
// a new one counts as 240px until its first frame).
const bottom = (th) => { th.scrollTop = th.scrollHeight; requestAnimationFrame(() => requestAnimationFrame(() => { th.scrollTop = th.scrollHeight; })); };
let askSeq = 0;     // the newest question: only its answer gets the "what next" links
async function tutorAsk(mode, question = "", { spoken = false } = {}) {
  if (APP.scope === "deck" && DECK_MODES.includes(mode)) mode += "_deck";
  if (APP.tutor !== "open" || !$("#thread")) { APP.tutor = "open"; renderTutor(); }
  let th = $("#thread");
  const d = APP.deck;
  const n = Math.min(APP.n, d.slides);
  const seq = ++askSeq;
  stopSpeaking();
  $(".empty", th)?.remove();
  $(".earlier", th)?.remove();
  const q = th.appendChild(h("p", { class: "msg-q" }, (spoken ? "🎙 " : "") + askText(mode, question), h("span", { class: "where" }, mode.endsWith("_deck") ? ` · ${d.tag}` : ` · s${n}`)));
  // Voice: read aloud, the answer keeps pace with the voice; without it (models still loading, or failed), it shows
  // as it streams.
  const voiced = voiceOn() && VOICE.tts === "ready";
  if (voiceOn() && !voiced) {
    if (VOICE.tts === "off") { if (!VOICE.warned) toast(VOICE_OFF); VOICE.warned = true; }
    else { if (!VOICE.loadWarned) toast("The voice is still loading; showing the answer without it."); VOICE.loadWarned = true; }
  }
  const ans = answerView(d.course, { paced: voiced });
  const sp = voiced && readAloud(null, ans), spoke = VOICE.gen;     // (unlocks the audio in this tap)
  const speaking = () => sp && VOICE.gen === spoke;
  const wait = h("p", { class: "waiting" }, mode.startsWith("example") ? "Writing a worked example…" : mode.endsWith("_deck") ? "Reading the whole deck…" : "Thinking…");
  th.append(wait);
  th.scrollTop = th.scrollHeight;
  $$("#thread .msg-foot").forEach((f) => f.remove());
  let sc = null;                    // what scrolls as the answer is written
  let acc = "", fed = 0, queued = false, cost = 0, follow = true, over = false;
  const onScroll = () => { follow = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80; };
  const scrollOn = (el) => { sc?.removeEventListener("scroll", onScroll); sc = el; sc?.addEventListener("scroll", onScroll, { passive: true }); };
  scrollOn(th);
  const paint = () => {
    queued = false;
    if (over) return;
    const t0 = performance.now();
    const t = acc.slice(fed);
    ans.feed(t);
    if (sp) sp.feed(t);
    fed = acc.length;
    cost = performance.now() - t0;
    if (follow && !speaking()) sc.scrollTop = sc.scrollHeight;
  };
  // The thread was drawn again (scope switch, Read, the panel reopened…): the question and its answer so far go
  // back at its end (the same element, so its voice and glow carry on).
  const me = { d,
    place: (into) => {
      th = into;
      th.append(q, ans.root, wait);
      scrollOn(th);
    } };
  TURNS.add(me);
  try {
    const r = await apiStream("/api/tutor", { course: d.course, tag: d.tag, n, mode, question, spoken, model: APP.model, slides_only: slidesOnly(d.course) }, {
      status: (t) => { wait.textContent = `${t}…`; },
      text: (t) => {
        if (!acc) { wait.before(ans.root); wait.textContent = "Writing…"; }
        acc += t;
        if (!queued) { queued = true; setTimeout(() => requestAnimationFrame(paint), Math.max(50, cost * 4)); }
      },
    });
    over = true;
    TURNS.delete(me);
    ans.msg = r.message;
    // The voice goes on to the end of the saved text; if that isn't what streamed, the pacing is off: all shows.
    if (sp) { if (r.message.text.startsWith(acc.slice(0, fed))) sp.feed(r.message.text.slice(fed)); else ans.showAll(); sp.end(); }
    const chat = d.chat || { id: r.chat, title: askText(mode, question), updated: "", messages: [] };
    chat.messages.push({ role: "q", mode, deck: d.tag, slide: n, text: askText(mode, question), ...(spoken ? { spoken } : {}) }, r.message);
    chat.updated = new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    d.chat = chat;
    if (!d.asked.includes(n)) d.asked.push(n);
    scrollOn(null);
    if (!sameDeck(APP.deck, d)) { ans.end(r.message.text); return; }     // (another deck: its voice was stopped on leaving)
    if (APP.deck !== d) { APP.deck.chat = chat; APP.deck.asked = [...new Set([...(APP.deck.asked || []), ...d.asked])]; }
    // Not in the panel any more (New chat, practice): the newest question draws the panel from the chat; an older
    // one never redraws over it (its answer is in the chat for the next redraw).
    if (!wait.isConnected) { if (seq === askSeq) drawThread(); return; }
    // Swap in just the finished answer; the rest of the thread stays as it is.
    if (!$(".chat-bar", th)) { th.prepend(chatBar(chat)); pinBelowBar(th); }      // the chat's first answer
    wait.remove();
    // Once all of it shows (now, or when the voice is done), the finished answer takes its place, drawings in the text.
    ans.settle = () => {
      const t = ans.root.closest(".thread"), f = t && (t.scrollHeight - t.scrollTop - t.clientHeight < 80 || ans.following());
      if (ans.root.isConnected) ans.root.replaceWith(answerEl(r.message, seq === askSeq));
      if (f) bottom(t);
    };
    if (speaking()) {        // still being read: only ■ Stop under it meanwhile (the rest comes when it settles)
      VOICE.playBtn = answerTools(r.message, false).find((x) => x.classList?.contains("play"));
      VOICE.playBtn.textContent = "■ Stop";
      ans.root.append(VOICE.playBtn);
    }
    ans.end(r.message.text);
    if (!speaking() && follow) bottom(th);
    updateComposeHint();
  } catch (e) {
    over = true;
    TURNS.delete(me);
    if (speaking()) stopSpeaking();
    scrollOn(null);
    ans.root.remove();
    const err = h("p", { class: "err" }, e.message);
    if (wait.isConnected) wait.replaceWith(err);
  }
}

// ------------------------------------------------------------ voice
// Answers read aloud a sentence at a time (Kokoro, local, on the hub): every answer in Voice, any answer on ▶ Play.
// The sentence being said glows, and cues ([#id]) light up parts of the answer's drawing. Speech is transcribed on
// the hub too (faster-whisper), for dictation.
//   state: the voice row's (idle: hidden, waiting: to be read aloud, nothing playing yet, speaking, blocked: the
//   browser wouldn't play without a tap)
//   tts: the speech models (undefined: not asked yet, loading, ready, off); done: what ends the speech in progress
//   (the answer it paces shows whole, its glow goes); view: the answer being read (answerView / playView, its .msg
//   once known, so a redraw keeps its element); warned / loadWarned: "Voice isn't available" / "still loading" was
//   said once already (until the voice is ready); playBtn: the ▶ Play reading ■ Stop (its .msg: the answer);
//   lit: the answer whose drawing a tap or ▶ Play lit last.

const VOICE = { state: "idle", gen: 0, ctrl: null, el: null, voices: null, tts: undefined, poll: 0, playBtn: null, done: null, view: null, lit: null,
  warned: false, loadWarned: false };
const talking = () => VOICE.state === "waiting" || VOICE.state === "speaking";
const micOk = () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && !!window.MediaRecorder;
const VOICE_LINE = { waiting: "Getting the voice ready…", speaking: "Speaking…",
  blocked: "The browser blocked the voice: tap ▶ Play under the answer (once it's written) to hear it." };
const VOICE_OFF = "Voice isn't available; showing the answer without it.";
const MAX_RECORDING_MS = 120000;

// Under the compose box, while an answer is read aloud (or couldn't be): what's happening, ■ Stop, voice and speed.
function voiceRow() {
  const voice = h("select", { id: "voice-pick", "aria-label": "Voice", onchange: (e) => store.set("voice", e.target.value) });
  const speed = h("select", { "aria-label": "Speed", onchange: (e) => store.set("voiceSpeed", +e.target.value) },
    ...[0.85, 1, 1.1, 1.2, 1.35].map((s) => h("option", { value: s }, `${s}×`)));
  speed.value = store.get("voiceSpeed", 1);
  return h("div", { class: "voice-row", id: "voice-row", hidden: true },
    h("span", { class: "voice-state", id: "voice-state", role: "status" }),
    h("button", { class: "link quiet", id: "voice-stop", type: "button", onclick: () => stopSpeaking() }, "■ Stop"), voice, speed);
}

function voiceSet(state) {
  VOICE.state = state;
  if (!talking() && VOICE.playBtn) { VOICE.playBtn.textContent = "▶ Play"; VOICE.playBtn = null; }
  const row = $("#voice-row");
  if (!row) return;
  row.hidden = state === "idle";
  $("#voice-state").textContent = VOICE_LINE[state] || "";
  $("#voice-stop").hidden = !talking();
}

function fillVoices() {
  const sel = $("#voice-pick");
  if (!sel) return;
  sel.hidden = !VOICE.voices;
  if (!VOICE.voices) return;
  sel.replaceChildren(...Object.entries(VOICE.voices.voices).map(([id, label]) => h("option", { value: id }, label)));
  sel.value = store.get("voice", VOICE.voices.default_voice);
}

// Load the speech models quietly (polling until they're up).
async function warmVoice() {
  clearTimeout(VOICE.poll);
  VOICE.tts = "loading";
  let st;
  // With the deck, the hub also opens the course's conversation now, so the first answer skips that step.
  try { st = await api("/api/voice/warm", APP.deck ? { course: APP.deck.course, tag: APP.deck.tag, model: APP.model, slides_only: slidesOnly(APP.deck.course) } : {}); } catch { VOICE.tts = "off"; return; }
  if (st.error) { VOICE.tts = "off"; return; }
  if (!st.ready) { VOICE.poll = setTimeout(warmVoice, 2000); return; }
  Object.assign(VOICE, { tts: "ready", warned: false, loadWarned: false, voices: st });
  fillVoices();
}
const warmOnce = () => { if (VOICE.tts !== "ready" && VOICE.tts !== "loading") warmVoice(); };

// ▶ Play under an answer (■ Stop while it plays): its sentences glow and its drawing lights up as it is read (not
// in the Read view, where everything shows whole and unlit).
function playAnswer(m, btn) {
  if (VOICE.playBtn === btn) return stopSpeaking();
  stopSpeaking();
  warmOnce();                 // (fills the voice list)
  const root = !store.get("reading", false) && btn.closest(".ans");
  speakAll(m.text, btn, root ? playView(root, m) : null);
}

// The tutor's SVG as live markup, rebuilt from an allowlist: SVG shapes and text with drawing attributes only, so
// nothing in it can run, fetch or navigate (a blocklist missed html:meta refresh, html:img, image-set() in style).
// Ids get a tsvg- prefix (and references with them) so a part called "thread" can't take over the page's #thread;
// class is dropped so page CSS (.on, .empty…) can't reach in. null if it isn't clean SVG.
const SVG_NS = "http://www.w3.org/2000/svg", XLINK_NS = "http://www.w3.org/1999/xlink";
const SVG_TAGS = new Set(("svg g defs title desc rect circle ellipse line polyline polygon path text tspan marker linearGradient "
  + "radialGradient stop clipPath mask pattern symbol use").split(" "));
const SVG_PAINT = new Set(("fill fill-opacity fill-rule stroke stroke-width stroke-dasharray stroke-dashoffset stroke-linecap "
  + "stroke-linejoin stroke-miterlimit stroke-opacity opacity font-size font-family font-weight font-style text-anchor "
  + "dominant-baseline alignment-baseline baseline-shift letter-spacing word-spacing text-decoration stop-color stop-opacity "
  + "visibility display paint-order vector-effect").split(" "));
const SVG_ATTRS = new Set([...SVG_PAINT, ...("x y x1 y1 x2 y2 cx cy r rx ry fx fy width height d points pathLength transform viewBox "
  + "preserveAspectRatio dx dy rotate textLength lengthAdjust marker-start marker-mid marker-end markerWidth markerHeight refX refY "
  + "orient markerUnits offset gradientUnits gradientTransform spreadMethod clip-path clip-rule clipPathUnits mask maskUnits "
  + "maskContentUnits patternUnits patternContentUnits patternTransform").split(" ")]);
const SVG_ID = /^[A-Za-z][\w.-]*$/;
// An attribute value with its url(#id) references re-pointed at prefixed ids; null if it could fetch or escape.
function svgValue(v) {
  if (/\\|image-set|javascript:|expression\(|@import/i.test(v)) return null;
  v = v.replace(/url\(\s*(['"]?)#([A-Za-z][\w.-]*)\1\s*\)/g, "url(#tsvg-$2)");
  return /url\(/i.test(v.replace(/url\(#tsvg-[\w.-]+\)/g, "")) ? null : v;
}
function inlineSvg(src) {
  const doc = new DOMParser().parseFromString(src, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName !== "svg" || root.namespaceURI !== SVG_NS || doc.getElementsByTagName("parsererror").length) return null;
  const copy = (from, to) => {
    for (const n of from.childNodes) {
      if (n.nodeType === 3 || n.nodeType === 4) { to.append(n.nodeValue); continue; }
      if (n.nodeType !== 1 || n.namespaceURI !== SVG_NS) continue;            // html:*, comments, …: gone with their subtree
      if (n.localName === "a") { copy(n, to); continue; }                       // a link: keep what it wraps, not the link
      if (!SVG_TAGS.has(n.localName)) continue;
      to.append(copy(n, cleanSvgEl(n)));
    }
    return to;
  };
  const svg = copy(root, cleanSvgEl(root));
  // Without a viewBox, dropping width/height would leave it drawn at 300×150 user units, cropped.
  const num = (v) => /^\d+(\.\d+)?(px)?$/.test((v || "").trim()) ? parseFloat(v) : 0;
  const w = num(root.getAttribute("width")), ht = num(root.getAttribute("height"));
  if (!svg.hasAttribute("viewBox") && w && ht) svg.setAttribute("viewBox", `0 0 ${w} ${ht}`);
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("class", "cue-svg");
  return svg;
}
// A fresh SVG element with only the allowed attributes of el (simple style declarations become attributes).
function cleanSvgEl(el) {
  const out = document.createElementNS(SVG_NS, el.localName);
  for (const a of el.attributes) {
    if (a.namespaceURI && a.namespaceURI !== XLINK_NS) continue;
    const n = a.localName, v = a.value.trim();
    if (n === "id") { if (SVG_ID.test(v)) out.setAttribute("id", `tsvg-${v}`); continue; }
    if (n === "href") { if (/^#[A-Za-z][\w.-]*$/.test(v)) out.setAttribute("href", `#tsvg-${v.slice(1)}`); continue; }
    if (a.namespaceURI || !SVG_ATTRS.has(n)) continue;
    const ok = svgValue(v);
    if (ok != null) out.setAttribute(n, ok);
  }
  for (const decl of (el.getAttribute("style") || "").split(";")) {      // style beats attributes, so it goes last
    const m = decl.match(/^\s*([a-z-]+)\s*:\s*([#\w\s.,%()-]+?)\s*$/i);
    if (m && SVG_PAINT.has(m[1].toLowerCase()) && !/url\(|image-set/i.test(m[2])) out.setAttribute(m[1].toLowerCase(), m[2]);
  }
  return out;
}

// Cues ([#id] in the answer's text) and the answer's drawing. While an answer is written over a new drawing, its
// named parts start hidden and appear when the sentence that names them is reached (answerView); the part being
// talked about is lit and the rest fade back. Everything shows once the answer ends or is cut short, so a missed
// cue never hides a part. A tap on a paragraph lights its parts (showCues), and so does ▶ Play as it reads (playView).
//   root.cue (on the answer's .ans) = { build: parts start hidden, shown: Set of ids, on: ids lit now, named?:
//   (answerView) only parts a cue named start hidden, and a part once shown stays } (none: all shown, none lit)
function cueParts(c) {
  const parts = new Map();     // id → its elements; mermaid edges (and their labels) come with both ends
  const add = (id, el) => {     // only a name a cue can carry ([#id]) is a part
    if (!/^[A-Za-z][\w-]{0,40}$/.test(id)) return;
    if (!parts.has(id)) parts.set(id, []);
    parts.get(id).push(el);
  };
  $$(".cue-svg", c).forEach((svg) => svg.querySelectorAll(":is(g, rect, circle, ellipse, line, polyline, polygon, path, text, use)[id]").forEach((el) => {
    if (!el.closest("defs, marker, symbol, clipPath, mask, pattern")) add(el.id.replace(/^tsvg-/, ""), el);
  }));
  const edges = [];
  $$(".mermaid-box svg", c).forEach((mm) => {
    mm.querySelectorAll("g.node[id]").forEach((el) => { const m = el.id.match(/^flowchart-(.+)-\d+$/); if (m) add(m[1], el); });
    mm.querySelectorAll("g.cluster[id]").forEach((el) => add(el.id, el));
    const labels = $$(".edgeLabels > .edgeLabel", mm);
    $$(".edgePaths > path", mm).forEach((p, i) => {
      const from = [...p.classList].find((k) => k.startsWith("LS-"))?.slice(3), to = [...p.classList].find((k) => k.startsWith("LE-"))?.slice(3);
      if (from && to) edges.push({ from, to, els: [p, labels[i]].filter(Boolean) });
    });
  });
  return { parts, edges };
}

function applyCues(root) {
  if (!root) return;
  const { parts, edges } = cueParts(root), st = root.cue;
  const on = new Set(st ? st.on.filter((id) => parts.has(id)) : []);
  const shows = (id) => !st || !st.build || st.shown.has(id) || (st.named && !st.named.has(id));
  if (st && st.named) for (const id of parts.keys()) if (shows(id)) st.shown.add(id);
  for (const [id, els] of parts) for (const el of els) {
    el.classList.add("cue-part");
    el.classList.toggle("cue-hide", !shows(id));
    el.classList.toggle("cue-on", on.has(id));
  }
  for (const e of edges) for (const el of e.els) {
    el.classList.toggle("cue-hide", !(shows(e.from) && shows(e.to)));
    el.classList.toggle("cue-dim", on.size > 0 && !on.has(e.from) && !on.has(e.to));   // fades back with the nodes
  }
  // A part drawn inside another named part: showing it shows the group around it too.
  for (const [id, els] of parts) if (shows(id)) for (const el of els) {
    for (let up = el.parentElement; up && up !== root; up = up.parentElement) up.classList.remove("cue-hide");
  }
  root.classList.toggle("cueing", on.size > 0);
}

// One answer's drawing is lit at a time (one still building keeps its state).
function litOnly(root) {
  const was = VOICE.lit;
  VOICE.lit = root;
  if (was && was !== root && was.cue && !was.cue.build) endCues(was);
}

// A paragraph was tapped: the parts its cues name appear (if hidden) and light up. Cues naming no part of this
// answer's drawing are ignored; returns how many did name one.
function showCues(ids, root) {
  if (!root.cue || !root.cue.build) inlineDrawings(root);
  const parts = cueParts(root).parts;
  ids = ids.filter((id) => parts.has(id));
  if (!ids.length) return 0;
  litOnly(root);
  const st = root.cue || (root.cue = { build: false, shown: new Set(), on: [] });
  ids.forEach((id) => st.shown.add(id));
  st.on = ids;
  applyCues(root);
  return ids.length;
}
function endCues(root) { if (root && root.cue) { root.cue = null; applyCues(root); } }

// ------------------------------------------------------------ dictation
// 🎙 next to Ask: speak a question, and what the hub heard is typed into the box to check and edit before sending.
// Nothing is sent until Ask. The clip is written down in one pass when you stop (a live draft re-read the whole
// clip every 1.5 s and made the final pass wait its turn). `before`/`after` are the text either side of the cursor
// when dictation began, so they stay untouched. `spoken` marks the question as dictated when it is sent.
const DICT = { rec: null, stream: null, chunks: [], gen: 0, timer: 0, state: "idle",
  before: "", after: "", last: "", spoken: false, spaceHeld: false };
const DICT_TITLE = { idle: "Dictate: speak your question, then edit it before sending (Ctrl+Space)", listening: "Stop and type out what you said (Ctrl+Space)",
  hearing: "Writing down what you said…" };

function dictateButton(ta) {
  const b = h("button", { class: "btn ghost dictate", id: "dict-mic", type: "button", onclick: dictTap });
  dictShow(b, ta);                                  // the new box isn't in the page yet (re-render mid-dictation)
  return b;
}
function dictShow(b = $("#dict-mic"), ta = $("#ask-input")) {
  if (!b) return;
  const st = DICT.state;
  b.textContent = st === "listening" ? "■" : st === "hearing" ? "…" : "🎙";
  b.title = DICT_TITLE[st];
  b.setAttribute("aria-label", "Dictate");
  b.setAttribute("aria-pressed", String(st === "listening"));
  b.classList.toggle("on", st === "listening");
  b.disabled = st === "hearing";
  if (ta) ta.readOnly = st !== "idle";              // what you said goes in at the cursor: typing meanwhile would be lost
  if (ta) ta.placeholder = st === "listening" ? "Listening… tap ■ or Ctrl+Space to stop" : st === "hearing" ? "Writing down what you said…" : composeHint();
}
function dictSet(state) { DICT.state = state; dictShow(); }

async function dictTap() {
  if (DICT.state === "listening") return dictFinish();
  if (DICT.state !== "idle") return;
  stopSpeaking();                                   // so the mic doesn't hear the tutor
  const tok = ++DICT.gen;
  DICT.last = $("#ask-input")?.value || "";         // a redraw before the mic starts keeps what's in the box
  dictSet("listening");
  api("/api/voice/warm", {}).catch(() => {});       // the speech models load while you talk (the first time ~10 s)
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch {
    if (tok === DICT.gen) { dictSet("idle"); toast("The microphone is blocked: allow it from the site settings."); }
    return;
  }
  if (tok !== DICT.gen) { stream.getTracks().forEach((t) => t.stop()); return; }   // cancelled meanwhile
  try {
    const rec = new MediaRecorder(stream), chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    // Where the words go: at the cursor, replacing a selection (it keeps its place after tapping 🎙 takes the focus).
    const ta = $("#ask-input"), at = ta ? ta.selectionStart ?? ta.value.length : 0;
    Object.assign(DICT, { rec, stream, chunks,
      last: ta ? ta.value : "", before: ta ? ta.value.slice(0, at) : "", after: ta ? ta.value.slice(ta.selectionEnd ?? at) : "" });
    DICT.timer = setTimeout(() => { if (DICT.rec === rec) dictFinish(); }, MAX_RECORDING_MS);
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    dictSet("idle");
    toast("This browser couldn't start recording. Try Chrome or Edge.");
  }
}

async function dictFinish() {
  const { rec, stream, chunks, gen: tok } = DICT;
  if (!rec) { DICT.gen++; return dictSet("idle"); }   // tapped again before the mic had started: don't start it
  clearTimeout(DICT.timer);
  Object.assign(DICT, { rec: null, stream: null, chunks: [] });
  dictSet("hearing");
  const d = APP.deck;
  let text = "", msg = "Didn't catch that. Tap 🎙 and try again.";
  try {
    if (rec.state !== "inactive") await new Promise((res) => { rec.onstop = res; rec.onerror = res; rec.stop(); setTimeout(res, 3000); });   // never stuck on "…"
    const wav = await toWav16k(new Blob(chunks, { type: rec.mimeType }));
    if (tok !== DICT.gen) return;
    text = (await dictTranscribe(d, wav)).trim();
  } catch (e) { if (e && e.message && !(e instanceof DOMException)) msg = e.message; } finally {   // a recording that won't decode: "didn't catch that"
    stream.getTracks().forEach((t) => t.stop());
  }
  if (tok !== DICT.gen) return;
  dictSet("idle");
  const ta = $("#ask-input");
  if (!text) return toast(msg);
  if (ta && APP.deck === d) dictInsert(text);       // into the box to check; nothing is sent
}

const dictTranscribe = async (d, wav) => (await api("/api/voice/transcribe",
  { course: d.course, tag: d.tag, n: Math.min(APP.n, d.slides), scope: APP.scope, audio: await blobBase64(wav) })).text;

// Put `text` in the box between `before` and `after`, with the cursor after it and the focus in the box.
function dictInsert(text) {
  const ta = $("#ask-input");
  if (!ta) return;
  const { before, after } = DICT;
  const ins = (before && !/\s$/.test(before) ? " " : "") + text + (after && !/^\s/.test(after) ? " " : "");
  DICT.spoken = true;
  ta.value = DICT.last = before + ins + after;
  ta.focus();
  ta.setSelectionRange(before.length + ins.length, before.length + ins.length);
  ta.dispatchEvent(new Event("input"));            // resize the box and light up Ask
}

// Leaving the deck, closing the panel, starting practice: stop listening and drop what was recorded.
function cancelDictation() {
  DICT.gen++;
  DICT.spaceHeld = false;
  clearTimeout(DICT.timer);
  const rec = DICT.rec;
  if (rec) {
    rec.onstop = rec.onerror = rec.ondataavailable = null;
    if (rec.state !== "inactive") { try { rec.stop(); } catch { /* already stopping */ } }
  }
  DICT.stream?.getTracks().forEach((t) => t.stop());
  Object.assign(DICT, { rec: null, stream: null, chunks: [] });
  if (DICT.state !== "idle") dictSet("idle");
}

// Whatever the browser recorded (webm/opus, mp4…) → 16 kHz mono 16-bit WAV, what Whisper wants.
async function toWav16k(blob) {
  const ctx = new AudioContext();
  let buf;
  try { buf = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close(); }
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * 16000)), 16000);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return new Blob([pcmWav((await off.startRendering()).getChannelData(0), 16000)], { type: "audio/wav" });
}
function pcmWav(pcm, rate) {
  const v = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, pcm.length * 2, true);
  pcm.forEach((x, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 32767, true));
  return v.buffer;
}
const blobBase64 = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

// Read text aloud: speakAll(text) at once, readAloud() for an answer still streaming in (feed, end). With its view
// (answerView, playView), the speech paces it and makes it glow (speaker); it shows whole, unlit, when the speech ends
// however it ends.
function speakAll(text, btn = null, view = null) {
  const sp = readAloud(btn, view);
  sp.feed(text);
  sp.end();
}
function readAloud(btn = null, view = null) {
  stopSpeaking();
  unlockAudio();
  const ctrl = VOICE.ctrl = new AbortController();
  VOICE.view = view;
  VOICE.done = view && (() => view.showAll());
  voiceSet("waiting");                              // "Speaking…" once the first piece plays
  if (btn) { VOICE.playBtn = btn; btn.textContent = "■ Stop"; }
  return speaker(VOICE.gen, ctrl.signal, view, !!btn);
}

// Speaks streamed Markdown a few sentences at a time, in order: each piece is synthesised while the previous
// one plays. A ``` drawing block isn't read out. With a view, each piece reveals it up to the piece's end (an offset
// in the raw text both were fed) and makes the piece's sentences glow as it starts playing; a drawing goes up when
// the speech reaches it, a Mermaid diagram getting up to 2 s to be drawn before the next piece. stopSpeaking() (a new
// question, Stop, closing the panel) makes every queued piece drop out. The voice failing stops it, with a toast.
const ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|dr|fig)\.$/i;
function speaker(gen, signal, view = null, asked = false) {     // asked: by ▶ Play
  let acc = "", taken = 0, first = true, ended = false, pending = 0;
  let synth = Promise.resolve(), play = Promise.resolve();
  const live = () => gen === VOICE.gen;
  const reveal = (i) => view.revealTo(i);
  const queue = (step) => {
    pending++;
    play = play.then(step).catch((e) => console.error(e)).then(() => { if (--pending === 0 && ended && live()) stopSpeaking(); });
  };
  const failed = () => {
    if (!live() || signal.aborted) return;
    VOICE.tts = "off";
    stopSpeaking();
    if (asked || !view) toast("Voice isn't available right now.");      // ▶ Play always says so
    else { if (!VOICE.warned) toast(VOICE_OFF); VOICE.warned = true; }
  };
  const sayOne = (text, start, end) => {      // the raw text [start, end), said as `text`
    const audio = synth = synth.then(() => (live() && text ? fetchSpeech(text, signal) : null)).catch(() => { failed(); return null; });
    queue(async () => {
      const url = await audio;
      if (!live()) { if (url) URL.revokeObjectURL(url); return; }
      if (view) reveal(end);
      if (!url) return;
      if (view) view.glow(start, end);
      if (VOICE.state === "waiting") voiceSet("speaking");
      if (!(await playUrl(url)) && live()) { stopSpeaking(); voiceSet("blocked"); }   // the browser refused (no tap)
    });
  };
  const drawAt = (end) => queue(() => live() && Promise.race([reveal(end), new Promise((res) => setTimeout(res, 2000))]));
  const say = (chunk, at) => {      // a piece per cued sentence (so a cue lands as it is said); none over 1000 characters
    for (const { text: part } of cueSplit(chunk)) {
      const end = at + part.length, full = speakable(part);
      let text = full;
      let from = at;
      while (text.length > 1000) {
        const sp = text.lastIndexOf(" ", 1000);
        const k = sp > 200 ? sp : 1000, to = end - Math.round((part.length * (text.length - k)) / full.length);
        sayOne(text.slice(0, k), from, to);
        from = to;
        text = text.slice(k).trim();
      }
      sayOne(text, from, end);
      at = end;
    }
  };
  const take = (final) => {
    for (;;) {
      const rest = acc.slice(taken);
      if (!rest.trim()) return;
      const ws = rest.search(/\S/);
      if (ws > 0) { taken += ws; continue; }      // (a blank isn't a piece: it shows with the next one)
      const fence = rest.search(/```|~~~/);
      if (fence === 0) {          // a drawing: wait until it is complete, then show it
        const mark = rest.slice(0, 3), close = rest.indexOf(mark, 3);
        if (close < 0) {
          if (/^...\s*mermaid\b/.test(rest)) loadMermaid().catch(() => {});   // the library loads while the diagram streams in
          if (final) taken = acc.length;
          return;
        }
        taken += close + 3;
        if (view && !first) drawAt(taken);     // (one the answer opens with goes up with the first piece said)
        continue;
      }
      const scan = fence > 0 ? rest.slice(0, fence) : rest;
      // Cut after a sentence or a line; the first piece as early as possible, then pieces of 140+ characters.
      const re = /[.!?](?=["')\]]*\s)|\n/g;
      let cut = -1, soft = -1, m;
      while ((m = re.exec(scan))) {
        const end = m.index + m[0].length;
        if (m[0] === "." && ABBREV.test(scan.slice(0, end))) continue;
        if (first || end >= 140) { cut = end; break; }
        soft = end;
      }
      if (cut < 0 && scan.length > 350) {       // a long run with no sentence end: break at a pause, or a space
        const head = scan.slice(0, 350);
        const p = Math.max(head.lastIndexOf(","), head.lastIndexOf(";"), head.lastIndexOf(":"));
        cut = soft > 0 ? soft : p > 0 ? p + 1 : head.lastIndexOf(" ") > 0 ? head.lastIndexOf(" ") + 1 : 350;
      }
      if (cut < 0) {
        if (fence > 0) cut = fence;              // speak what comes before the drawing
        else if (final) cut = rest.length;
        else return;
      }
      say(rest.slice(0, cut), taken);
      taken += cut;
      first = false;
    }
  };
  return { feed: (t) => { acc += t; take(false); }, end: () => { take(true); ended = true; if (!pending && live()) stopSpeaking(); } };
}

// A piece of speech → parts, a new one at each sentence carrying a cue, with the cues it carries (its words keep them;
// speakable() drops them).
function cueSplit(text) {
  const out = [];
  for (const sent of sentences(text)) {
    const cues = [...sent.matchAll(CUE)].map((m) => m[1]);
    if (!out.length || (cues.length && out[out.length - 1].text.trim())) out.push({ text: sent, cues });
    else { const last = out[out.length - 1]; last.text += sent; last.cues.push(...cues); }
  }
  return out;
}

// Sentences with the space after each (no lookbehind: older iPhone Safari can't even parse one); the last may be
// unfinished.
function sentences(text) {
  const out = [], re = /[.!?]["')\]]*\s+|\n+/g;
  let last = 0;
  for (let m; (m = re.exec(text));) { out.push(text.slice(last, re.lastIndex)); last = re.lastIndex; }
  if (last < text.length || !out.length) out.push(text.slice(last));
  return out;
}

// Markdown → words to say. The voice prompt asks for plain sentences; this catches whatever slips through.
const TEX_WORDS = { cdot: "times", times: "times", le: "at most", leq: "at most", ge: "at least", geq: "at least",
  neq: "not equal to", approx: "about", to: "to", rightarrow: "to", infty: "infinity", sqrt: "root of", pm: "plus or minus" };
const TEX_DROP = /^(left|right|text|textbf|mathrm|mathbf|mathit|mathcal|operatorname|displaystyle|quad|qquad|big|Big|bigg|Bigg)$/;
function speakable(md) {
  return String(md)
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, " ")
    .replace(CUE, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/\|\|[\s\S]*?\|\|/g, " ")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[[A-Za-z&0-9-]+ s\d+(?:\s*[–-]\s*s?\d+)?\]/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\$+([^$]*)\$+/g, "$1")
    .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, " $1 over $2 ")
    .replace(/\^\{?2\}?(?![\d}])/g, " squared ")
    .replace(/\^/g, " to the ")
    .replace(/\\([a-zA-Z]+)/g, (_, c) => (TEX_DROP.test(c) ? " " : ` ${TEX_WORDS[c] || c} `))
    .replace(/\\[,;:! ]/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`#|\\]/g, "")
    .replace(/\s+/g, " ").replace(/ ([,.;:!?])/g, "$1").trim();     // "half [#L], four" → "half, four"
}

async function fetchSpeech(text, signal) {
  const r = await fetch("/api/voice/speak", { method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ text, voice: store.get("voice", ""), speed: store.get("voiceSpeed", 1) }) });
  if (!r.ok) throw new Error("no voice");
  return URL.createObjectURL(await r.blob());
}

// One <audio> for every answer, unlocked by playing a moment of silence inside a tap: iOS Safari (and autoplay
// rules elsewhere) only let an element play later if it first played during a user gesture.
const SILENT_WAV = URL.createObjectURL(new Blob([pcmWav(new Float32Array(800), 8000)], { type: "audio/wav" }));
function unlockAudio() {
  if (!VOICE.el) VOICE.el = new Audio();
  const a = VOICE.el;
  if (!a.paused) return;
  a.src = SILENT_WAV;
  a.play().catch(() => { /* a later play() reports it */ });
}

// Resolves true when the piece played to the end (or was stopped), false when the browser refused to play it.
function playUrl(url) {
  if (!VOICE.el) VOICE.el = new Audio();
  const a = VOICE.el;
  return new Promise((res) => {
    let over = false;
    const done = (ok) => {
      if (over) return;
      over = true;
      a.onended = a.onerror = a.onpause = null;
      if (!ok) { a.removeAttribute("src"); a.load(); }       // (it would go on loading the revoked url)
      URL.revokeObjectURL(url);
      res(ok);
    };
    a.src = url;
    a.onended = () => done(true); a.onerror = () => done(true); a.onpause = () => done(true);
    a.play().catch((e) => done(!(e && e.name === "NotAllowedError")));
  });
}

// The speech has ended, or Stop / a new question / leaving cut it short: queued pieces drop out, and the answer it
// was reading shows whole, with nothing glowing.
function stopSpeaking() {
  VOICE.ctrl?.abort();
  VOICE.ctrl = null;
  VOICE.gen++;
  if (VOICE.el && !VOICE.el.paused) VOICE.el.pause();
  const done = VOICE.done;
  VOICE.done = null;
  VOICE.view = null;
  done?.();
  $$(".snt.spoken").forEach((el) => el.classList.remove("spoken"));
  voiceSet("idle");
}

// Hold Space to dictate into the Ask box (not while typing in a field or on a button, nor where Space scrolls: the
// Read view, the thread).
document.addEventListener("keydown", (e) => {
  if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || APP.tutor === "focus" || !$("#dict-mic") || !micOk() || $(".viewer.reading")
    || e.target.closest("input, textarea, select, button, a, summary, [contenteditable], .spoiler, #thread, .side-sheet")) return;
  e.preventDefault();
  if (e.repeat || DICT.spaceHeld) return;
  DICT.spaceHeld = true;
  if (DICT.state === "idle") dictTap();
});
document.addEventListener("keyup", (e) => {
  if (e.key !== " " || !DICT.spaceHeld) return;
  e.preventDefault();
  DICT.spaceHeld = false;
  if (DICT.state === "listening") dictFinish();      // let go before the mic started: dictFinish cancels the start
});

// Ctrl+Space dictates from anywhere, the Ask box included (into the ask bar while the tutor is closed): press to start and
// again to stop, or hold it and let go.
let ctrlSpaceAt = 0;
document.addEventListener("keydown", (e) => {
  if (e.key !== " " || !e.ctrlKey || e.metaKey || e.altKey || !APP.deck || !micOk()) return;
  e.preventDefault();
  if (e.repeat) return;
  if (DICT.state === "listening") return dictFinish();
  if (DICT.state !== "idle") return;
  if (!$("#dict-mic")) { APP.tutor = "open"; renderTutor(); }   // the ask bar (tutor closed) has its own mic
  ctrlSpaceAt = Date.now();
  dictTap();
});
document.addEventListener("keyup", (e) => {
  if (e.key !== " " || !ctrlSpaceAt) return;
  const held = Date.now() - ctrlSpaceAt > 400;      // a quick press toggles; a hold stops on release
  ctrlSpaceAt = 0;
  if (held && DICT.state === "listening") dictFinish();
});

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
  cancelDictation();
  stopSpeaking();
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
    topics: p.kind === "mixed" ? mixedTopics(d.course) : null, focus: p.focus || "" };
  if (req.focus) head.after(h("p", { class: "muted small practice-focus" }, `You asked for: ${req.focus}`));
  runPractice(area, req, practiceNext(p.kind, req.focus));
}

function closePractice() {
  APP.tutor = "open";
  renderTutor();
}

// What the one button after marking does.
function practiceNext(kind, focus = "") {     // focus: /try's own words, kept for "Try another" 
  return (result) => {
    const s = APP.session;
    const d = APP.deck;
    if (s && d && s.course === d.course) {
      if (s.step === 2 && kind !== "mixed") {
        s.practised = (s.practised || 0) + 1; saveSession();
        if (s.practised < 3) return { label: "Try another", run: () => startPracticeInPanel({ kind: kind === "yourturn" ? "try" : kind, focus }) };
        return { label: "Next: one mixed problem", run: () => { setSessionStep(3); startPracticeInPanel({ kind: "mixed" }); } };
      }
      if (s.step === 3 || kind === "mixed") {
        if (s.step === 3) return { label: "Next: one line to remember", run: () => { setSessionStep(4); go({ step: "note" }); } };
      }
    }
    return { label: "Try another", run: () => startPracticeInPanel({ kind: kind === "yourturn" ? "try" : kind, focus }) };
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
        slides_only: slidesOnly(req.course), prefetch: ["try", "deck", "mixed"].includes(req.kind) && !req.focus, topics: req.topics },
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
  const art = h("article", { class: "prose" }, h("h1", {}, c.title),
    h("p", {}, h("button", { class: "link", type: "button", onclick: () => copyChat(c) }, "Copy chat"), " ",
      h("button", { class: "link", type: "button", onclick: () => printChat(c) }, "Save as PDF")));
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
  const cid = routeCourseId();
  const course = cid && APP.courses[cid];
  $("#history-title").textContent = course ? `History · ${course.code}` : "History";
  $("#history-dlg").showModal();
  const chats = (await api("/api/chats").catch(() => [])).filter((c) => !cid || c.course === cid);
  list.replaceChildren();
  if (!chats.length) list.append(h("p", { class: "muted" }, course ? `No tutor chats in ${course.code} yet.` : "No tutor chats yet."));
  for (const c of chats) {
    const open = () => { $("#history-dlg").close(); if (!c.deck) return go({ chat: c.id }); openChat(c.id); };
    const title = renamable(c, "hist-title", () => { if (APP.deck && APP.deck.chat && APP.deck.chat.id === c.id) { APP.deck.chat.title = c.title; drawThread(); } });
    const row = h("div", { class: "hist-row" },
      starButton(c, () => { if (APP.deck && APP.deck.chat && APP.deck.chat.id === c.id) { APP.deck.chat.starred = c.starred; drawThread(); } }),
      h("div", { class: "open" }, title,
        h("button", { class: "hist-meta", type: "button", onclick: open },
          `${c.code}${c.deck ? " · " + c.deck : ""} · ${c.count} question${c.count === 1 ? "" : "s"} · ${c.updated || c.created} · Open ›`)),
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
  $("#qr-text").textContent = APP.phoneUrl.startsWith("https:")
    ? "Scan this with your phone's camera. It works on any Wi-Fi or mobile data while this computer is on. Anyone with the link can open the hub, so don't share it."
    : "Connect your phone to the same Wi-Fi, then scan this with its camera. Keep this computer on while you use it.";
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
    if (selAskBtn) return hideSelAsk();
    if (APP.side) return sideBack();
    if (APP.zoom) return toggleZoom();
    if (APP.text) return toggleText(false);
    if (APP.tutor === "focus" && !typing) return closePractice();
    if ($(".viewer.reading") && !typing) return toggleReading();
    if (APP.navOpen && isPhone()) return toggleNav(false);
  }
  if (!typing && e.key === "[" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); toggleNav(); return; }
  if (typing || !$(".viewer") || APP.tutor === "focus") return;
  if (e.key.toLowerCase() === "r" && !e.ctrlKey && !e.metaKey && !e.altKey && APP.tutor === "open") return toggleReading();
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && $("#ask-input")) {   // jump to the Ask box, modes listed
    e.preventDefault();
    const ta = $("#ask-input");
    ta.focus();
    if (!ta.value) { ta.value = "/"; ta.dispatchEvent(new Event("input")); }
    return;
  }
  if ($(".viewer.reading")) {   // the slide is hidden: arrows and Page keys scroll the chat instead
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomReading(1);
    else if (e.key === "-" || e.key === "_") zoomReading(-1);
    else if (e.key === "0") zoomReading(0);
    else if (e.key.toLowerCase() === "w") keepPlace(() => store.set("readWide", !store.get("readWide", false)));
    return;
  }
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
