// Tutr — slide-first study with a tutor. Course → Topic → Deck → Slide.
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

async function api(path, body, ms = 0) {
  const opt = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
  const ctl = ms ? new AbortController() : null, timer = ctl && setTimeout(() => ctl.abort(), ms);   // ms: give up after
  if (ctl) opt.signal = ctl.signal;
  let r;
  try { r = await fetch(path, opt); } catch { throw new Error("The hub isn't responding. Start it again with start.bat, then retry."); } finally { clearTimeout(timer); }
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

// A spoken line, [say: …], on its own line before a table, formula, working, code block or drawing: what the voice
// says in its place. Never shown, copied or printed; inside a code fence it is code and stays as written.
const SAY = /^[ \t]*\[say:[ \t]*([^\]\n]{1,400})\][ \t]*$/gm;
const SAY_OR_FENCE = new RegExp(`(\`\`\`|~~~)[\\s\\S]*?(?:\\1|(?![\\s\\S]))|${SAY.source}(?:\\r?\\n|(?![\\s\\S]))`, "gm");
const unsay = (t) => String(t || "").replace(SAY_OR_FENCE, (m, fence) => (fence ? m : ""));
// Text still streaming in, without the half cue or half spoken line at its end (final: only a spoken line's half).
const halfCut = (t, final = false) => (final ? t : t.replace(/\[(#[\w-]*)?$/, "")).replace(/(^|\n)[ \t]*\[(?:say:[^\]\n]*|s|sa|say)$/, "$1");

function renderMd(md, courseId) {
  const code = [], math = [];
  let src = String(md || "").replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => { code.push(m); return `CODETOKEN${code.length - 1}X`; });
  src = unsay(uncue(src));
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
  draftFollow(p.c || null);         // the Ask box's live draft is the course's (before the box is drawn)
  renderSessionBar();
  // A recording never outlives the page; speech carries on while staying in the course's slides (another deck, a citation).
  cancelDictation();
  if (!(APP.deck && p.c === APP.deck.course && p.d && $(".viewer"))) stopSpeaking();
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
      `Continue reading: ${res.deck} · slide ${res.slide} ›`) : null,
    res ? h("p", { class: "under", style: "text-align:left" }, h("button", { class: "link", type: "button",
      title: "Exam-style questions from a range of decks, in the format of a practice paper, worked on paper",
      onclick: () => { APP.pending = { drill: true }; go({ c: id, d: res.deck, s: res.slide }); } }, "Exam drill ›")) : null);
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
  // Any other folder in the course's me/notes/ is listed under its own name, before the tutor's notes.
  const other = [...new Set(c.docs.map((g) => g.kind))].filter((k) => !Object.hasOwn(label, k));
  for (const kind of ["exams", "labs", "assignments", ...other, "tutor"]) {
    const groups = c.docs.filter((g) => g.kind === kind);
    if (!groups.length) continue;
    page.append(h("p", { class: "notes-line" }, `${Object.hasOwn(label, kind) ? label[kind] : kind}: `,
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
// Lecture order (week, then each deck's order), not topic order: topics can interleave within a week.
function courseDeckOrder(c) { return c.topics.flatMap((t) => t.decks).sort((a, b) => a.week - b.week || (a.order ?? 0) - (b.order ?? 0)); }

async function showNotes(id, path, token) {
  const c = await loadCourse(id);
  if (token !== routeToken) return;
  const n = c.notes.find((x) => x.path === path);
  const label = n ? `Class notes W${n.week}` : path === "me/tutor-memory.md" ? "What your tutor remembers"
    : path.split("/").slice(-2).join(" · ").replace(/\.md$/, "");
  setCrumbs({ label: "Home", href: "#" }, { label: c.code, href: `#c=${encodeURIComponent(id)}` }, { label });
  const r = await fetch(`/api/note?course=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`);
  const text = r.ok ? await r.text() : "Not found.";
  if (token !== routeToken) return;
  const body = path.endsWith(".txt") ? h("pre", { style: "white-space:pre-wrap" }, text) : renderMd(text, id);
  $("#main").replaceChildren(h("article", { class: "prose" }, body));
}

// ------------------------------------------------------------ slide viewer

// The chat is the course's: every deck of a course reads and writes the same one (and its earlier chats) here, through
// its `chat` / `chats`. Fetched on entering a course's viewer; the live channel keeps it current after that.
APP.courseChat = {};         // course id -> { chat, chats }
async function loadCourseChat(id) {
  const r = await api(`/api/course/chat?course=${encodeURIComponent(id)}`);
  return (APP.courseChat[id] = { chat: r.chat, chats: r.chats || [] });
}

// The slides of this deck asked about in the course's chat (older messages carry no deck: the chat's own).
const askedIn = (chat, tag) => (chat ? [...new Set(chat.messages.filter((m) => m.slide && msgDeck(m, chat) === tag).map((m) => m.slide))].sort((a, b) => a - b) : []);

// A deck from /api/deck, wired to its course's chat (again is fine: a cached reply is adopted each time it's shown).
function adoptDeck(deck) {
  const cc = () => APP.courseChat[deck.course] || (APP.courseChat[deck.course] = { chat: null, chats: [] });
  return Object.defineProperties(deck, {
    chat: { get: () => cc().chat, set: (v) => { cc().chat = v; }, configurable: true },
    chats: { get: () => cc().chats, set: (v) => { cc().chats = v; }, configurable: true },
    asked: { get: () => askedIn(deck.chat, deck.tag), configurable: true },
  });
}

// /api/deck replies of the open course, so the decks either side open at once (prefetchNeighbours). A few at most.
const DECKS = new Map();     // "course/tag" -> the reply (a promise)
let decksCourse = null;
function fetchDeck(course, tag) {
  if (decksCourse !== course) { DECKS.clear(); decksCourse = course; }
  const k = `${course}/${tag}`;
  if (!DECKS.has(k)) {
    DECKS.set(k, api(`/api/deck?course=${encodeURIComponent(course)}&tag=${encodeURIComponent(tag)}`).catch((e) => { DECKS.delete(k); throw e; }));
    if (DECKS.size > 8) DECKS.delete(DECKS.keys().next().value);
  }
  return DECKS.get(k);
}

// After a deck shows: the decks either side and the slide each opens on, when the browser has nothing else to do.
function prefetchNeighbours(d) {
  const { prev, next } = neighbourDecks(d);
  (window.requestIdleCallback || ((f) => setTimeout(f, 300)))(() => {
    for (const [x, n] of [[next, 1], [prev, prev && prev.slides]]) {
      if (!x || d.course !== decksCourse) continue;
      fetchDeck(d.course, x.tag).catch(() => {});
      new Image().src = slideSrc(d.course, x.tag, n);
    }
  });
}

async function showViewer(courseId, tag, n, token) {
  // Another deck of the same course on screen: only the stage changes, the tutor panel stays as it is (the chat is the
  // course's), like changing slide. Practice closes as before (a problem belongs to its deck): the viewer is built again.
  const inCourse = () => !!(APP.deck && APP.deck.course === courseId && $(".viewer") && APP.tutor !== "focus");
  const cached = decksCourse === courseId && DECKS.has(`${courseId}/${tag}`);
  const chatNow = !(APP.deck && APP.deck.course === courseId && $(".viewer") && APP.courseChat[courseId]);   // entering the course's viewer: its chat as it is now
  const [c, deck] = await Promise.all([loadCourse(courseId), fetchDeck(courseId, tag), chatNow ? loadCourseChat(courseId) : null]);
  if (token !== routeToken) return;
  const same = APP.deck && APP.deck.course === courseId && APP.deck.tag === tag && $(".viewer");
  const swap = !same && inCourse();
  APP.deck = adoptDeck(deck);
  APP.n = Math.min(Math.max(1, n || deck.state.last || 1), deck.slides + 1);
  setCrumbs({ label: "Home", href: "#" }, { label: c.code, href: `#c=${encodeURIComponent(courseId)}` },
    { label: deck.topic, href: `#c=${encodeURIComponent(courseId)}&t=${encodeURIComponent(deck.topic)}` }, { label: `${deck.tag} (W${deck.week})` });
  if (swap) { if (APP.text) toggleText(false); }      // the stage as a new viewer has it (showSlide unzooms)
  else if (!same) buildViewer();
  showSlide();
  if (APP.pending && APP.pending.drill) { APP.pending = null; APP.tutor = "open"; renderTutor(); openDrillSetup(false); }
  else if (APP.pending) { const p = APP.pending; APP.pending = null; startPracticeInPanel(p); }
  else if (swap) keepTutor();
  else if (!same) renderTutor();
  // A cached reply's state may be older than the deck's: shown at once, then put right.
  if (cached) api(`/api/deck?course=${encodeURIComponent(courseId)}&tag=${encodeURIComponent(tag)}`).then((f) => { deck.state = f.state; }).catch(() => {});
  prefetchNeighbours(deck);
}

// The kept panel, on its new deck: where it is, the hint, and each question's slide label (relative to the deck).
function keepTutor() {
  updateTutorWhere();
  updateComposeHint();
  $$("#thread .msg-q").forEach((q) => {
    const w = $(".where", q);
    if (q.__m && w) w.textContent = msgWhere(q.__m, APP.deck.chat, APP.deck.tag);
  });
  if (APP.side && !(APP.side.course === APP.deck.course && APP.side.tag === APP.deck.tag)) closeSide();
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

const slideSrc = (course, tag, n) => `/api/slide?course=${encodeURIComponent(course)}&tag=${encodeURIComponent(tag)}&n=${n}`;
function slideUrl(n) { return slideSrc(APP.deck.course, APP.deck.tag, n); }

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
  // The Read view is the same chat on a wider page: an answer being read aloud carries on, glowing as before.
  const on = !store.get("reading", false);
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
  return h("div", { class: "chat-bar" }, starButton(chat), renamable(chat), chat.drill ? drillStatus(chat.drill) : null);
}

async function newChat() {
  const d = APP.deck;
  try { await api("/api/chat/new", { course: d.course, client: DRAFT.client }); } catch { /* the next question still starts fresh */ }
  if (d.chat) d.chats = [{ id: d.chat.id, title: d.chat.title, updated: d.chat.updated }, ...(d.chats || [])].slice(0, 5);
  d.chat = null;
  cancelDictation();
  stopSpeaking();
  drawThread();
  $("#ask-input")?.focus();
}

async function openChat(id) {
  try {
    const r = await api("/api/chat/open", { id, client: DRAFT.client });
    APP.tutor = "open";
    // One chat per course: in a deck of its course, it opens beside that deck; otherwise go to the deck it started on.
    if (APP.deck && APP.deck.course === r.course) {
      await loadCourseChat(r.course);
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
      composeBox(composeHint(), (q, spoken) => tutorAsk(replyMode(), q, { spoken })),
      h("button", { class: "icon-btn askbar-open", type: "button", title: "Open the tutor", "aria-label": "Open the tutor",
        onclick: () => { APP.tutor = "open"; renderTutor(); $("#ask-input")?.focus(); } }, "⇤")));
    return;
  }
  setTutor("open");
  t.replaceChildren(h("div", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", {}, "Tutor"), h("span", { class: "muted small", id: "tutor-where" }), readTools(),
      h("button", { class: "link quiet new-chat", type: "button", id: "read-btn", title: "Reading view: the chat as full-width pages, like a PDF (R)", onclick: toggleReading }, "Read"),
      h("button", { class: "link quiet new-chat", type: "button", title: "Start a new chat in this course", onclick: newChat }, "New chat"),
      h("button", { class: "link quiet new-chat", type: "button", title: "Print the chat or save it as a PDF", onclick: () => printChat(APP.deck.chat, APP.deck) }, "Print"),
      h("details", { class: "more-menu" },
        h("summary", { class: "icon-btn", title: "More", "aria-label": "More" }, "⋯"),
        h("div", { class: "more-pop", role: "menu", onclick: (e) => { if (e.target.closest("button")) e.currentTarget.parentElement.open = false; } },
          h("button", { type: "button", role: "menuitem", onclick: () => copyChat(APP.deck.chat, APP.deck) }, "Copy chat as Markdown"))),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Close the tutor", onclick: () => { APP.tutor = "closed"; renderTutor(); } }, "×")),
    h("div", { class: "panel-actions" },
      scopeSwitch(),
      h("div", { class: "links" },
        h("button", { class: "link", type: "button", title: "Every concept in this deck at a glance (always the whole deck)", onclick: () => tutorAsk("map_deck") }, "Big picture"),
        h("button", { class: "link", type: "button", onclick: () => tutorAsk("example") }, "Worked example"),
        h("button", { class: "link", type: "button", onclick: () => tutorAsk("explain") }, "Explain simply"),
        h("button", { class: "link", type: "button", title: "An oral exam: one question at a time, follow-ups on weak answers, a summary at the end", onclick: () => tutorAsk("grill") }, "Grill me"),
        h("button", { class: "link", type: "button", title: "Exam-style questions from a range of decks, in the format of a practice paper, solved on paper: hints, marks, then the written solution", onclick: () => openDrillSetup() }, "Exam drill"),
        h("button", { class: "link", type: "button", onclick: () => tutorAsk("quiz") }, "Quiz prep"),
        h("button", { class: "link", type: "button", title: "What to know first: prerequisites, rules and symbols", onclick: () => tutorAsk("before") }, "Before you start"),
        h("button", { class: "link", type: "button", title: "Methods, formulas and shortcuts to copy onto your sheet (always the whole deck)", onclick: () => tutorAsk("cheatsheet_deck") }, "Cheat sheet"))),
    h("div", { class: "thread", id: "thread", "aria-live": "polite", tabindex: "-1" }),
    h("div", { class: "ask-area" }, viewSwitch(),
      composeBox(composeHint(), (q, spoken) => tutorAsk(replyMode(), q, { spoken })), voiceRow())));
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
  const paint = () => { queued = false; live.replaceChildren(...renderMd(halfCut(acc), s.course).childNodes); s.thread.scrollTop = s.thread.scrollHeight; };
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

// ------------------------------------------------------------ live draft
// The Ask box's unsent text is shared by every device with the same course open: type on the laptop, carry on
// on the phone, send from either. The hub keeps the one copy (drafts.py); this page listens to the course by long
// polling (/api/live: each request is answered as soon as there's news, then the next one goes; a stream wouldn't
// get through Cloudflare's quick tunnels) and saves what's typed (/api/draft), one save at a time, built on the
// version (`rev`) it last had. A save built on an older version is refused with the newer text: both edits are
// merged (drafts.js) and saved again. Another device's change goes into the box with the cursor left where it
// was, except while a word is being composed or a question dictated (it waits until that ends). A page in the
// background stops listening and catches up when it's back on screen (`since`: the last event it heard).
// Photos attached in the box are part of the draft too, but aren't merged: the page always shows the hub's newest
// list (photoRev), since they're only ever added or removed one at a time. Sending a question takes them along.
//   local: this page's text (the box's, when there is one); spoken: it was dictated (even in part)
//   base / rev / baseSpoken: the hub's copy that `local` was built on; remote: a newer copy waiting to be merged
const DRAFT = { client: Math.random().toString(36).slice(2, 12) + Date.now().toString(36), course: null, poll: null, since: null, epoch: "",
  local: "", spoken: false, base: "", rev: 0, baseSpoken: false, remote: null, inflight: false, sentAt: 0,
  timer: 0, due: 0, composing: false, applying: false, photos: [], photoRev: -1, uploading: 0, onPhotos: null };
const DRAFT_EVERY_MS = 150;      // at most one save this often while typing

// The course whose draft this page follows (null: none). Called on every route.
function draftFollow(course) {
  if (course === DRAFT.course) { if (course && !DRAFT.poll && !document.hidden) draftListen(); return; }
  if (DRAFT.course && DRAFT.local !== DRAFT.base)       // typed just before leaving the course: still saved
    api("/api/draft", { course: DRAFT.course, client: DRAFT.client, text: DRAFT.local, base: DRAFT.rev, spoken: DRAFT.spoken }).catch(() => {});
  draftUnlisten();
  clearTimeout(DRAFT.timer);
  Object.assign(DRAFT, { course, local: "", spoken: false, base: "", rev: 0, baseSpoken: false, remote: null, timer: 0, photos: [], photoRev: -1,
    since: null, epoch: "" });
  drawTray();
  if (course && !document.hidden) draftListen();
}

// Listen until stopped: one request at a time, each picking up after the last event heard. The hub away: try
// again, less often (up to every 10 s).
function draftListen() {
  draftUnlisten();
  const ctl = new AbortController(), course = DRAFT.course;
  DRAFT.poll = ctl;
  (async () => {
    let fails = 0;
    while (DRAFT.poll === ctl) {
      let r;
      try {
        const after = DRAFT.since == null ? "" : `&since=${DRAFT.since}&epoch=${DRAFT.epoch}`;
        const res = await fetch(`/api/live?course=${encodeURIComponent(course)}&client=${DRAFT.client}${after}`, { signal: ctl.signal, cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        r = await res.json();
      } catch {
        if (DRAFT.poll !== ctl) return;
        await new Promise((ok) => setTimeout(ok, Math.min(10000, 1000 * 2 ** fails++)));
        continue;
      }
      if (DRAFT.poll !== ctl) return;
      fails = 0;
      const resumed = DRAFT.since != null;
      Object.assign(DRAFT, { since: r.seq, epoch: r.epoch });
      if (r.snapshot) liveSnapshot(r.snapshot, resumed);
      for (const [kind, d] of r.events) liveEvent(kind, d);
    }
  })();
}
function draftUnlisten() { if (DRAFT.poll) DRAFT.poll.abort(); DRAFT.poll = null; }

// Everything as it is now: on first listening, or when this page fell too far behind (or the hub restarted).
function liveSnapshot(s, resumed) {
  const d = s.draft;
  if (d.rev < DRAFT.rev) {     // the hub lost its drafts (restarted without its file): this page's is the newest
    draftPhotos(d, true);
    Object.assign(DRAFT, { base: d.text, rev: d.rev, baseSpoken: d.spoken, remote: null });
    draftKick();
  } else draftRemote(d);
  for (const t of s.turns) liveTurn("turn_start", t);
  // Turns may have finished while this page wasn't listening: the course's chat as it is now.
  const deck = APP.deck;
  if (resumed && deck && deck.course === DRAFT.course) {
    if (s.chat) liveRefresh(s.chat, null);
    else if (deck.chat) liveChatSwitch({ chat: null });
  }
}

function liveEvent(kind, d) {
  if (kind === "draft") draftRemote(d);
  else if (kind === "chat") liveChatSwitch(d);
  else liveTurn(kind, d);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) draftUnlisten();
  else if (DRAFT.course) draftListen();         // back on screen: what happened meanwhile comes in at once
});

// The box changed here (typing, dictation, a / command filled in, sending).
function draftTyped(ta) {
  if (DRAFT.applying || !DRAFT.course) return;
  DRAFT.local = ta.value;
  DRAFT.spoken = !!ta.value && DICT.spoken;
  draftKick(DRAFT.sentAt + DRAFT_EVERY_MS - Date.now());
}

// A newer copy from the hub: merged in by the next pump (not while a save is on its way: its answer comes first).
function draftRemote(d) {
  draftPhotos(d);
  if (d.rev <= DRAFT.rev || (DRAFT.remote && DRAFT.remote.rev >= d.rev)) return;
  DRAFT.remote = { text: String(d.text || ""), rev: d.rev, spoken: !!d.spoken };
  draftKick();
}

function draftKick(delay = 0) {
  const due = Date.now() + Math.max(0, delay);
  if (DRAFT.timer && DRAFT.due <= due) return;
  clearTimeout(DRAFT.timer);
  DRAFT.due = due;
  DRAFT.timer = setTimeout(draftPump, Math.max(0, delay));
}

// Merge in what came from the hub, then save what's new here: one request at a time, each built on the last.
async function draftPump() {
  DRAFT.timer = 0;
  const course = DRAFT.course;
  if (!course || DRAFT.inflight) return;
  const ta = $("#ask-input");
  if (ta && DICT.state === "idle") DRAFT.local = ta.value;
  if (DRAFT.remote) {
    if (DRAFT.composing || DICT.state !== "idle") return draftKick(300);
    const d = DRAFT.remote;
    DRAFT.remote = null;
    draftApply(d);
  }
  const text = DRAFT.local, spoken = DRAFT.spoken;
  if (text === DRAFT.base && spoken === DRAFT.baseSpoken) return;
  const wait = DRAFT.sentAt + DRAFT_EVERY_MS - Date.now();
  if (wait > 0) return draftKick(wait);
  DRAFT.inflight = true;
  DRAFT.sentAt = Date.now();
  let r = null;
  try { r = await api("/api/draft", { course, client: DRAFT.client, text, base: DRAFT.rev, spoken }); } catch { /* the hub didn't answer */ }
  DRAFT.inflight = false;
  if (DRAFT.course !== course) return draftKick();
  if (!r) return draftKick(2000);
  if (r.ok) { Object.assign(DRAFT, { base: text, rev: r.rev, baseSpoken: !!r.spoken }); draftPhotos(r); }
  else draftRemote(r);                                  // someone else's change got there first: merge, then save again
  draftKick();
}

function draftApply(d) {
  if (d.rev <= DRAFT.rev) return;
  const mine = DRAFT.local, edited = mine !== DRAFT.base;
  const text = draftMerge(DRAFT.base, mine, d.text);
  DRAFT.spoken = !!text && (d.spoken || (edited && DRAFT.spoken));
  Object.assign(DRAFT, { base: d.text, rev: d.rev, baseSpoken: d.spoken, local: text });
  if (DICT.state === "idle") DICT.spoken = DRAFT.spoken;
  const ta = $("#ask-input");
  if (!ta || ta.value === text) return;
  const before = ta.value, focused = document.activeElement === ta, a = ta.selectionStart, b = ta.selectionEnd;
  DRAFT.applying = true;
  ta.value = text;
  if (focused) ta.setSelectionRange(draftCaret(before, text, a), draftCaret(before, text, b));
  ta.dispatchEvent(new Event("input"));                // resize the box, light up Ask
  DRAFT.applying = false;
  if (!focused) { const m = $("#slash-menu"); if (m) m.hidden = true; }      // the / menu is for whoever's typing
}

// ---- photos in the Ask box
// Attached from the 📷 button (a file, the camera, or the phone by QR code), pasted or dropped into the box. Each is
// saved by the hub at once and shows on every device; it goes with the next question, whatever its mode.
const uploadUrl = (course, p) => `/api/upload?course=${encodeURIComponent(course)}&path=${encodeURIComponent(p)}`;
const photoThumbs = (course, photos) => h("span", { class: "msg-photos" }, photos.map((p) =>
  h("a", { href: uploadUrl(course, p), target: "_blank", rel: "noopener" }, h("img", { src: uploadUrl(course, p), alt: "Attached photo", loading: "lazy" }))));

// The hub's newest list of photos (in a draft, a save's answer, or a snapshot), unless an older one.
function draftPhotos(d, force = false) {
  if (!d || !Array.isArray(d.photos) || (!force && d.rev <= DRAFT.photoRev)) return;
  DRAFT.photoRev = d.rev;
  const more = d.photos.length > DRAFT.photos.length;
  if (DRAFT.photos.join("\n") === d.photos.join("\n")) return;
  DRAFT.photos = d.photos.slice();
  drawTray();
  if (more && DRAFT.onPhotos) DRAFT.onPhotos();
}

function drawTray() {
  const tray = $("#ask-photos");
  if (tray) {
    tray.hidden = !DRAFT.photos.length && !DRAFT.uploading;
    tray.replaceChildren(...DRAFT.photos.map((p) => h("span", { class: "thumb" },
      h("a", { href: uploadUrl(DRAFT.course, p), target: "_blank", rel: "noopener" }, h("img", { src: uploadUrl(DRAFT.course, p), alt: "Attached photo" })),
      h("button", { class: "x", type: "button", title: "Remove this photo", "aria-label": "Remove this photo", onclick: () => removePhoto(p) }, "×"))),
      DRAFT.uploading ? h("span", { class: "thumb adding" }, "Adding…") : null);
  }
  const ta = $("#ask-input"), send = $("#ask-send");
  if (ta && send) send.classList.toggle("ghost", !ta.value.trim() && !DRAFT.photos.length);
}

async function attachPhotos(files) {
  const course = DRAFT.course;
  if (!course) return;
  for (const f of files) {
    DRAFT.uploading++; drawTray();
    try {
      const r = await api("/api/draft/photo", { course, client: DRAFT.client, data: await shrinkImage(f) });
      if (DRAFT.course === course) draftPhotos(r);
    } catch (e) { toast(e.message); }
    finally { DRAFT.uploading--; drawTray(); }
  }
}

async function removePhoto(p) {
  const course = DRAFT.course;
  DRAFT.photos = DRAFT.photos.filter((x) => x !== p);
  drawTray();
  try {
    const r = await api("/api/draft/photo/remove", { course, client: DRAFT.client, path: p });
    if (DRAFT.course === course) draftPhotos(r);
  } catch (e) { toast(e.message); }
}

// The file picker: the camera straight away, or a choice of files (several at once).
function photoPicker(camera, onFiles) {
  const input = $("#photo-input");
  input.value = "";
  input.multiple = !camera;
  if (camera) input.setAttribute("capture", "environment"); else input.removeAttribute("capture");
  input.onchange = () => { const fs = [...input.files]; if (fs.length) onFiles(fs); };
  input.click();
}

// 📷 next to the mic: on a phone, the camera or a picture; on the laptop, a file, or the phone's camera by QR code.
function attachButton() {
  const items = isPhone() ? [["Take a photo", () => photoPicker(true, attachPhotos)], ["Choose a picture", () => photoPicker(false, attachPhotos)]]
    : [["Choose a file", () => photoPicker(false, attachPhotos)], APP.phoneUrl ? ["Take it with your phone", () => sendFromPhone({ ask: DRAFT.course })] : null].filter(Boolean);
  const menu = h("ul", { class: "attach-menu", role: "menu", hidden: true },
    items.map(([label, fn]) => h("li", { role: "menuitem", tabindex: "-1", onclick: () => { menu.hidden = true; fn(); } }, label)));
  const b = h("button", { class: "btn ghost attach", type: "button", title: "Attach a photo: it goes with your next question",
    "aria-label": "Attach a photo", "aria-haspopup": items.length > 1 ? "menu" : null, onclick: () => {
      if (items.length === 1) return items[0][1]();
      menu.hidden = !menu.hidden;
      if (!menu.hidden) setTimeout(() => document.addEventListener("click", () => { menu.hidden = true; }, { once: true }));
    } }, "📷");
  return h("span", { class: "attach-wrap" }, menu, b);
}

// ---- the chat, live
// The same channel brings the course chat's turns from the other devices: the question as soon as it's sent, the
// answer as it's written (never read aloud here: the voice stays with the device that asked), then the chat as
// saved. This page's own turns carry an id it made (MY_TURNS): their events go to the turn being drawn here.
// A page that connects mid-answer gets the turn with its text so far.
const MY_TURNS = new Map();     // turn id -> (event, data) for this page's own turn
const REMOTE = new Map();       // turn id -> another device's turn being drawn here: { d, n, q, wait, ans, place }
const newTurnId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function liveTurn(kind, t) {
  if (!t) return;
  const mine = MY_TURNS.get(t.turn);
  if (mine) return mine(kind, t);
  const deck = APP.deck;
  let r = REMOTE.get(t.turn);
  if (kind === "turn_start") {
    if (r || !deck || deck.course !== DRAFT.course) return;
    const where = t.whole || String(t.mode).endsWith("_deck") ? ` · ${t.tag}` : ` · ${t.tag !== deck.tag ? `${t.tag} ` : ""}s${t.n}`;
    r = { d: deck, n: t.n, tag: t.tag, pending: "", timer: 0,
      q: qMeta(h("p", { class: "msg-q" }, (t.spoken || t.mode === "voice" ? "🎙 " : "") + askText(t.mode, t.question), h("span", { class: "where" }, where),
        t.photos && t.photos.length ? photoThumbs(deck.course, t.photos) : null), { deck: t.tag, slide: t.n, whole: t.whole, mode: t.mode }),
      wait: h("p", { class: "waiting" }, t.status ? `${t.status}…` : "Answering a question from another device…"),
      ans: answerView(deck.course) };
    r.place = (th) => { th.append(r.q, r.ans.root, r.wait); };
    REMOTE.set(t.turn, r);
    TURNS.add(r);
    const th = $("#thread");
    if (th) { $(".empty", th)?.remove(); $(".earlier", th)?.remove(); r.place(th); bottom(th); }
    if (t.text) liveFeed(r, t.text);
    return;
  }
  if (!r) {             // a turn this page didn't see start (its own, cut off; or from before it connected): the saved chat
    if (kind === "turn_done") liveRefresh(t.chat, null);
    return;
  }
  if (kind === "turn_status") r.wait.textContent = `${t.text}…`;
  else if (kind === "turn_text") liveFeed(r, t.text);
  else {
    clearTimeout(r.timer);
    REMOTE.delete(t.turn);
    TURNS.delete(r);
    if (kind === "turn_done") liveRefresh(t.chat, r);
    else if (r.wait.isConnected) r.wait.replaceWith(h("p", { class: "err" }, t.error || "Something went wrong."));
  }
}

// The answer as it's written, painted a few times a second (not on every piece).
function liveFeed(r, text) {
  r.wait.textContent = "Writing…";
  r.pending += text;
  if (r.timer) return;
  r.timer = setTimeout(() => {
    r.timer = 0;
    const th = r.ans.root.closest(".thread"), follow = th && th.scrollHeight - th.scrollTop - th.clientHeight < 80;
    r.ans.feed(r.pending);
    r.pending = "";
    if (follow) th.scrollTop = th.scrollHeight;
  }, 80);
}

// Another device's turn is saved: fetch the chat and draw it. Messages already here keep their elements (an answer
// being read aloud carries on).
async function liveRefresh(chatId, r) {
  let deck = APP.deck;
  if (!chatId || !deck || deck.course !== DRAFT.course) return;
  let chat;
  try { chat = await api(`/api/chat?id=${encodeURIComponent(chatId)}`); } catch { return; }
  if (!APP.deck || APP.deck.course !== deck.course) return;          // gone to another course meanwhile
  deck = APP.deck;
  const old = deck.chat;
  if (old && old.id === chat.id)
    chat.messages = chat.messages.map((m, i) => (old.messages[i] && old.messages[i].role === m.role && old.messages[i].text === m.text ? old.messages[i] : m));
  else if (old) deck.chats = [{ id: old.id, title: old.title, updated: old.updated }, ...(deck.chats || []).filter((c) => c.id !== chat.id)].slice(0, 5);
  deck.chat = chat;
  if ($("#thread")) drawThread();
  else updateComposeHint();
}

// Another device started a new chat, opened an older one, or deleted this one: follow it, so the next question here
// goes where the chat shown says.
async function liveChatSwitch(e) {
  const deck = APP.deck;
  if (!deck || deck.course !== DRAFT.course || (deck.chat ? deck.chat.id : null) === e.chat) return;
  if (e.chat) return liveRefresh(e.chat, null);
  if (deck.chat) deck.chats = [{ id: deck.chat.id, title: deck.chat.title, updated: deck.chat.updated }, ...(deck.chats || [])].slice(0, 5);
  deck.chat = null;
  if ($("#thread")) drawThread();
  else updateComposeHint();
}

function composeBox(placeholder, onSend) {
  const ta = h("textarea", { id: "ask-input", rows: "1", placeholder, "aria-label": placeholder,
    "aria-autocomplete": "list", "aria-controls": "slash-menu" });
  // A new box starts with the course's live draft (empty if there's none); one drawn mid-dictation takes over the
  // text so far.
  if (DICT.state === "idle") { ta.value = DRAFT.local; DICT.spoken = DRAFT.spoken; } else ta.value = DICT.last;
  const send = h("button", { class: "btn ghost", id: "ask-send", type: "submit" }, "Ask");
  const menu = h("ul", { class: "slash-menu", id: "slash-menu", role: "listbox", hidden: true });
  const tray = h("div", { class: "ask-photos", id: "ask-photos", hidden: true });
  const empty = () => !ta.value.trim() && !DRAFT.photos.length;
  const form = h("form", { class: "compose", onsubmit: (e) => {
    e.preventDefault();
    let q = ta.value.trim();
    if (!q && !DRAFT.photos.length) return;
    if (!q) q = DRAFT.photos.length > 1 ? "See the photos." : "See the photo.";
    const slash = q.startsWith("/") ? slashCommand(q) : null;
    if (slash && slash.error) return toast(slash.error);
    const spoken = DICT.spoken;                     // dictated (even in part)
    cancelDictation();                              // sending while still listening drops the recording
    DICT.spoken = false;
    ta.value = ""; autosize(); slashMenu();
    draftTyped(ta);                                 // sent: the box empties on the other devices too
    if (slash) slash.run(spoken); else onSend(q, spoken);
    send.classList.toggle("ghost", empty());
  } }, menu, tray, ta, attachButton(), micOk() ? dictateButton(ta) : null, send);
  const images = (list) => [...(list || [])].filter((f) => f.type.startsWith("image/"));
  ta.addEventListener("paste", (e) => { const fs = images(e.clipboardData && e.clipboardData.files); if (fs.length) { e.preventDefault(); attachPhotos(fs); } });
  form.addEventListener("dragover", (e) => { if ([...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) e.preventDefault(); });
  form.addEventListener("drop", (e) => { const fs = images(e.dataTransfer.files); if (fs.length) { e.preventDefault(); attachPhotos(fs); } });
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
  ta.addEventListener("input", () => { autosize(); send.classList.toggle("ghost", empty()); pick = 0; slashMenu(); if (!ta.value.trim()) DICT.spoken = false; draftTyped(ta); });
  // A word being composed (phone keyboards, IMEs) isn't replaced under the keyboard: other devices' changes wait.
  ta.addEventListener("compositionstart", () => { DRAFT.composing = true; });
  ta.addEventListener("compositionend", () => { DRAFT.composing = false; draftKick(); });
  if (ta.value) requestAnimationFrame(() => { if (ta.isConnected) autosize(); });
  requestAnimationFrame(() => { if (tray.isConnected) drawTray(); });      // (once the box is in the page)
  ta.addEventListener("blur", () => { menu.hidden = true; ta.setAttribute("aria-expanded", "false"); if (DRAFT.composing) { DRAFT.composing = false; draftKick(); } });
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
  { cmd: "drill", hint: "Exam drill: exam-style questions from a range of decks", run: () => openDrillSetup() },
  { cmd: "hint", mode: "drill_hint", hint: "A hint on the drill's question", when: () => drilling() },
  { cmd: "answer", mode: "drill_reveal", hint: "Show the drill question's answer", when: () => drilling() },
  { cmd: "skip", mode: "drill_skip", hint: "Skip the drill's question", when: () => drilling() },
  { cmd: "enddrill", mode: "drill_end", hint: "End the drill: summary", when: () => drilling() },
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
  if (c.run) return { run: c.run };
  if (!c.mode) return { run: () => startPracticeInPanel({ kind: tryKind(), focus: extra }) };
  return { run: (spoken) => tutorAsk(c.mode, extra, { spoken }) };
}

const MODE_LABEL = { explain: "Explain simply", example: "Worked example", deeper: "Go deeper", quiz: "Quiz prep",
  explain_deck: "Explain simply · whole deck", example_deck: "Worked example · whole deck", quiz_deck: "Quiz prep · whole deck",
  map_deck: "Big picture · whole deck", before: "Before you start", before_deck: "Before you start · whole deck",
  cheatsheet_deck: "Cheat sheet · whole deck", grill: "Grill me", grill_deck: "Grill me · whole deck", grill_end: "End the grill",
  drill: "Exam drill", drill_hint: "Hint", drill_reveal: "Show the answer", drill_skip: "Skip this question", drill_end: "End the drill" };
const DECK_MODES = ["explain", "example", "quiz", "before", "grill"];
// The question line for a request: what the student typed, or the mode's label.
const askText = (mode, question) => (mode === "ask" || mode === "grill_reply" || mode === "drill_reply" ? question
  : mode === "drill" ? question || MODE_LABEL.drill : mode === "brush" ? `Brush up: ${question}`
  : question ? `${MODE_LABEL[mode]}: ${question}` : MODE_LABEL[mode]);     // a slash command's own words follow the mode

// Grill me runs over several turns: while the chat's last answer is a grill question, what the student types is
// their answer (mode grill_reply), so it stays in the grill until the summary or another request ends it.
const GRILL_MODES = ["grill", "grill_deck", "grill_reply"];
function grilling() {
  const msgs = APP.deck && APP.deck.chat ? APP.deck.chat.messages : [];
  const last = msgs[msgs.length - 1];
  return !!last && last.role === "a" && GRILL_MODES.includes(last.mode);
}
// An exam drill runs the same way while the chat's last answer is one of the drill's (drill_end closes it).
const DRILL_MODES = ["drill", "drill_reply", "drill_hint", "drill_reveal", "drill_skip"];
function drilling() {
  const chat = APP.deck && APP.deck.chat, msgs = chat ? chat.messages : [];
  const last = msgs[msgs.length - 1];
  return !!chat && !!chat.drill && !!last && last.role === "a" && DRILL_MODES.includes(last.mode);
}
const replyMode = () => (drilling() ? "drill_reply" : grilling() ? "grill_reply" : "ask");
const composeHint = () => (drilling() ? "Your answer or what you got on paper, a question, or \"give me the answer\""
  : grilling() ? "Your answer, or \"stuck\" / \"stop\""
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
  for (const t of TURNS) if (t.d.course !== APP.deck.course) TURNS.delete(t);
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
    if (m.role === "q") th.append(qMeta(h("p", { class: "msg-q" }, m.spoken || m.mode === "voice" ? `🎙 ${m.text}` : m.text, h("span", { class: "where" }, msgWhere(m, APP.deck.chat, APP.deck.tag)),
      m.photos && m.photos.length ? photoThumbs(APP.deck.course, m.photos) : null), m));
    else if (m === spoken) th.append(VOICE.view.root);
    else th.append(answerEl(m, i === msgs.length - 1 && !TURNS.size));
  });
  for (const t of TURNS) t.place(th);
  if (VOICE.view && !VOICE.view.root.isConnected) stopSpeaking();      // (its answer went with another deck)
  th.scrollTop = th.scrollHeight;
  updateComposeHint();
}

// A question's bubble keeps where it was asked, so its label can follow the deck the panel is on (keepTutor).
const qMeta = (el, m) => { el.__m = { deck: typeof m.deck === "string" ? m.deck : (APP.deck && APP.deck.chat && APP.deck.chat.deck) || "", slide: m.slide, whole: !!m.whole || String(m.mode || "").endsWith("_deck") }; foldable(el, m); return el; };

// A question's ▾ folds its answer away (CSS hides the .ans / .waiting after a .folded bubble, so an answer still
// streaming in stays folded too). Kept on the message for this session, so a redraw of the thread keeps it.
const FOLDED = new WeakSet();
function foldable(q, m) {
  const btn = h("button", { class: "fold", type: "button", "aria-expanded": "true", title: "Hide the answer",
    onclick: () => set(!q.classList.contains("folded")) }, "▾");
  const set = (on) => {
    q.classList.toggle("folded", on);
    btn.setAttribute("aria-expanded", String(!on));
    btn.title = on ? "Show the answer" : "Hide the answer";
    if (on) FOLDED.add(m); else FOLDED.delete(m);
  };
  q.prepend(btn);
  if (FOLDED.has(m)) set(true);
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
  if (isLast && DRILL_MODES.includes(m.mode) && APP.deck.chat && APP.deck.chat.drill) {
    out.push(drillFoot());
  } else if (isLast && GRILL_MODES.includes(m.mode)) {
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
const voiceOn = () => APP.view === "voice";

function viewSwitch() {
  const mk = (v, label, title) => h("button", { type: "button", role: "radio", "aria-checked": String(APP.view === v), title,
    class: APP.view === v ? "on" : "", onclick: () => { if (APP.view !== v) { APP.view = v; store.set("view", v); stopSpeaking(); renderTutor(); } } }, label);
  return h("div", { class: "scope-switch view-switch", role: "radiogroup", "aria-label": "Answers" },
    mk("text", "Text", "Answers appear as they're written; ▶ Play reads one aloud"),
    mk("voice", "Voice", "Answers are read aloud, appearing as they're spoken"));
}

// An answer as it is written. answerView(course, { paced }) returns { root, feed(chunk), end(text?), revealTo(i)
// (resolves once the drawings shown are drawn), glow(start, end), showAll(), settle, msg }. While it is written its
// drawings go up in .ans-draw, above its text, one figure each in order: an ```svg drawing element
// by element as it streams (svgStream), Mermaid and plots whole once their block closes. The text goes in the
// .msg-a under it, finished blocks rendered once. Once it is all shown and the stream has ended, settle() (set by
// the caller) swaps in the finished answer (answerEl), its drawings in their place in the text.
// Unpaced (Text), the answer shows as it streams. Paced (Voice), only up to revealTo(i), an offset in the raw text
// (cues included): the text up to there, and a drawing once i reaches its fence; showAll() shows the rest.
// glow(start, end): the sentences of raw text [start, end) are being spoken (.spoken); glow(start, end, true): the
// block rendered from [start, end) glows whole; glow(null): none.
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
  const write = (md, at = taken) => { if (md.trim()) done.append(...fromMd(cueMd(md, course, at), md, at)); };
  const paint = () => {
    const was = said && $(".spoken", root);
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
        const md = halfCut(t, final);   // not half a cue or spoken line
        tail.replaceChildren(...fromMd(cueMd(md, course, taken), md, taken));
        break;
      }
      write(rest.slice(0, f));
      taken += f;
      const block = acc.slice(taken), nl = block.indexOf("\n"), isDraw = DRAWING.test(block), mark = block.trimStart().slice(0, 3);
      const close = block.slice(1).match(new RegExp(`\\n {0,3}${mark}[ \\t]*(?:\\n|$)`));
      // Still streaming in: an svg drawing goes up as its elements close, code shows as it comes. (Paced, a drawing
      // goes up whole once it is complete, every part decided then, with all the cues streamed so far.)
      if (!close) {
        if (!isDraw) { if (final) write(block); else tail.replaceChildren(...fromMd(cueMd(block, course, taken), block, taken)); }
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
  // The sentence being said stays in view while the student follows it.
  let track = true;     // (declared here, used by paint, revealTo and glow)
  const keep = () => { const sp = said && track && $(".spoken", root); if (sp && root.isConnected) keepInView(sp); };
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
      const was = $(".spoken", root);
      track = !was || inThread(was);       // (the student is following it, or it's the first)
      if (i > upto) {
        const th = root.closest(".thread"), follow = th && th.scrollHeight - th.scrollTop - th.clientHeight < 80;
        upto = i;
        paint();
        if (follow) th.scrollTop = th.scrollHeight;
      }
      return drawn;
    },
    glow: (s, e, whole = false) => {
      said = s == null ? null : [s, e, whole];
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
  const body = $(".msg-a", root);
  if (body) fromMd(body, m.text, 0);
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
    glow: (s, e, whole = false) => {
      const was = $(".spoken", root), follow = !was || inThread(was);
      glowText(root, s == null ? null : [s, e, whole]);
      const now = $(".spoken", root);
      if (now && follow) keepInView(now);
    },
    showAll: () => { glowText(root, null); if (root.cue === st) endCues(root); },
  };
}

// The sentences of root covering raw text [span[0], span[1]) glow (.spoken); span null: none. A sentence is the
// .snt elements sharing a data-o (its offset in the raw text, from cueMd); the one the span starts inside counts too.
// span[2] (a block said as one line: its spoken line, or the line said for it): the block glows whole, every
// sentence in it too, even a block with none (a formula, code); a block it can't find, nothing.
function glowText(root, span) {
  const els = $$(".snt", root);
  $$(".spoken:not(.snt)", root).forEach((el) => el.classList.remove("spoken"));
  if (span && span[2]) {
    const lit = blockEls(root, span[0], span[1]);
    for (const el of els) el.classList.toggle("spoken", lit.some((b) => b.contains(el)));
    lit.forEach((b) => b.classList.add("spoken"));
    return;
  }
  let from = -1;
  if (span) for (const el of els) { const o = +el.dataset.o; if (o <= span[0] && o > from) from = o; }
  if (span && from < 0) from = span[0];
  for (const el of els) { const o = +el.dataset.o; el.classList.toggle("spoken", !!span && o >= from && o < span[1]); }
}
// An answer's top-level blocks as rendered from md (from offset `at` of the raw text): each keeps where it came from
// (rawMd), so blockEls can find a block among them. Returns the nodes.
function fromMd(box, md, at) {
  const src = [md, at];
  for (const el of box.children) el.rawMd = src;
  return [...box.childNodes];
}
// The top-level blocks of root rendered from raw text [s, e), found by their place among the blocks written with
// them: their text rendered with that range swapped for a marker paragraph puts the marker where they start. They
// must look as the range does rendered alone (same tags, same words), or it's none: never the wrong text. (No marks
// go into the maths or code: the rendering is untouched.)
const BLOCK_AT = new Map();
const blockWords = (el) => el.textContent.replace(/\s+/g, "");
function blockEls(root, s, e) {
  if (!(e > s)) return [];
  const tops = $$(".msg-a > *, .msg-a > div > *", root).filter((el) => el.rawMd);
  const src = tops.map((el) => el.rawMd).find(([md, at]) => at <= s && e <= at + md.length);
  if (!src) return [];
  const [md, at] = src, kids = tops.filter((el) => el.rawMd === src), key = `${at} ${s} ${e} ${md}`;
  let hit = BLOCK_AT.get(key);
  if (!hit) {
    const alone = [...renderMd(md.slice(s - at, e - at)).children].map((el) => [el.tagName, blockWords(el)]);
    const k = [...renderMd(`${md.slice(0, s - at)}\n\n\uE004\n\n${md.slice(e - at)}`).children].findIndex((el) => el.textContent.trim() === "\uE004");
    hit = { k, alone };
    BLOCK_AT.set(key, hit);
    if (BLOCK_AT.size > 50) BLOCK_AT.delete(BLOCK_AT.keys().next().value);
  }
  const { k, alone } = hit, els = k < 0 ? [] : kids.slice(k, k + alone.length);
  return alone.length && els.length === alone.length && els.every((el, i) => el.tagName === alone[i][0] && blockWords(el) === alone[i][1]) ? els : [];
}
// The part of the thread that shows its text: below the chat bar stuck at its top.
function threadView(th) {
  const t = th.getBoundingClientRect();
  let top = t.top;
  for (const el of $$(":scope > .chat-bar", th)) {
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
    else if (!/^\s*\[say:/.test(line) && !/^\s*(<|([-*_=]\s*){3,}$|\|?[\s:|]*-[\s:|-]*$)|^\s{0,3}(=+|-+)\s*$|^\s{0,3}\[[^\]]+\]:/.test(line)) {
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
  if (e.target.closest("a, button, .spoiler") || !getSelection().isCollapsed) return;
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
// An answer's drawings, while it is written: live SVG, scaled to the thread rather than to their text (Mermaid
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
const unmark = (t) => uncue(unsay(t)).replace(/\[\[([^[\]\n]{1,120}?)\]\]/g, "$1");

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
  const name = who ? (who.iq !== undefined ? `${who.label} · ${who.iq}` : who.label) : "";
  return [name, m.ms ? `${(m.ms / 1000).toFixed(0)} s` : "", m.cost != null ? `$${(+m.cost).toFixed(2)}` : ""].filter(Boolean).join(" · ");
}

// Scroll to the end now and again once a new answer is laid out (off-screen answers skip layout, content-visibility:
// a new one counts as 240px until its first frame).
const bottom = (th) => { th.scrollTop = th.scrollHeight; requestAnimationFrame(() => requestAnimationFrame(() => { th.scrollTop = th.scrollHeight; })); };
let askSeq = 0;     // the newest question: only its answer gets the "what next" links
async function tutorAsk(mode, question = "", { spoken = false, drill = null } = {}) {
  if (APP.scope === "deck" && DECK_MODES.includes(mode)) mode += "_deck";
  if (mode === "drill") {          // a drill always starts its own chat
    const d0 = APP.deck;
    if (d0.chat) d0.chats = [{ id: d0.chat.id, title: d0.chat.title, updated: d0.chat.updated }, ...(d0.chats || [])].slice(0, 5);
    d0.chat = null;
    if ($("#thread")) drawThread();
  }
  if (APP.tutor !== "open" || !$("#thread")) { APP.tutor = "open"; renderTutor(); }
  let th = $("#thread");
  const d = APP.deck;
  const n = Math.min(APP.n, d.slides);
  const seq = ++askSeq;
  const turn = newTurnId();
  MY_TURNS.set(turn, () => {});
  // The photos attached in the Ask box go with it (the hub takes them off the box on every device, and puts them
  // back if the question fails).
  const photos = d.course === DRAFT.course ? DRAFT.photos.slice() : [];
  if (photos.length) { DRAFT.photos = []; drawTray(); }
  stopSpeaking();
  $(".empty", th)?.remove();
  $(".earlier", th)?.remove();
  const q = th.appendChild(qMeta(h("p", { class: "msg-q" }, (spoken ? "🎙 " : "") + askText(mode, question), h("span", { class: "where" }, mode.endsWith("_deck") ? ` · ${d.tag}` : ` · s${n}`),
    photos.length ? photoThumbs(d.course, photos) : null), { deck: d.tag, slide: n, mode }));
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
  // The answer comes two ways, the same text on both: this request's own stream, and the live channel. Whichever
  // is further on is shown (on a Cloudflare quick tunnel the stream only arrives at the end; the channel is live).
  const grow = (full) => {
    if (over || full.length <= acc.length) return;
    if (!acc) { wait.before(ans.root); wait.textContent = "Writing…"; }
    acc = full;
    if (!queued) { queued = true; setTimeout(() => requestAnimationFrame(paint), Math.max(50, cost * 4)); }
  };
  const status = (t) => { if (!over) wait.textContent = `${t}…`; };
  let streamed = "", heard = "";
  MY_TURNS.set(turn, (kind, t) => {
    if (kind === "turn_start") { if (t.status) status(t.status); if (t.text) grow(heard = t.text); }
    else if (kind === "turn_status") status(t.text);
    else if (kind === "turn_text") grow(heard += t.text);
  });
  try {
    const r = await apiStream("/api/tutor", { course: d.course, tag: d.tag, n, mode, question, spoken, drill, model: APP.model, slides_only: slidesOnly(d.course),
      turn, client: DRAFT.client, photos }, {
      status,
      text: (t) => grow(streamed += t),
    });
    over = true;
    MY_TURNS.set(turn, () => {});          // (its end comes on the channel too: nothing to do, it's drawn)
    TURNS.delete(me);
    ans.msg = r.message;
    // The voice goes on to the end of the saved text; if that isn't what streamed, the pacing is off: all shows.
    if (sp) { if (r.message.text.startsWith(acc.slice(0, fed))) sp.feed(r.message.text.slice(fed)); else ans.showAll(); sp.end(); }
    const chat = d.chat || { id: r.chat, title: askText(mode, question), updated: "", messages: [] };
    if (r.drill) chat.drill = r.drill;
    // (Unless the chat was fetched again meanwhile, after another device's turn, with this answer already in it.)
    if (!chat.messages.some((m) => m.role === "a" && m.text === r.message.text && m.ms === r.message.ms))
      chat.messages.push({ role: "q", mode, deck: d.tag, slide: n, text: askText(mode, question), ...(spoken ? { spoken } : {}), ...(photos.length ? { photos } : {}) }, r.message);
    chat.updated = new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    d.chat = chat;            // (the course's: another deck of it open now has it too, the panel still on screen)
    scrollOn(null);
    if (!APP.deck || APP.deck.course !== d.course) { ans.end(r.message.text); return; }     // (another course: its voice was stopped on leaving)
    // Not in the panel any more (New chat, practice): the newest question draws the panel from the chat; an older
    // one never redraws over it (its answer is in the chat for the next redraw).
    if (!wait.isConnected) { if (seq === askSeq) drawThread(); return; }
    // Swap in just the finished answer; the rest of the thread stays as it is.
    if (!$(".chat-bar", th)) th.prepend(chatBar(chat));      // the chat's first answer
    else if (chat.drill) $(".chat-bar", th).replaceWith(chatBar(chat));     // the drill's tally moved on
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
    MY_TURNS.delete(turn);          // (if the hub answers it anyway, the live channel brings the answer in)
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
const micOk = () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && !!window.AudioWorkletNode;
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

// ▶ Play under an answer (■ Stop while it plays): its sentences glow and its drawing lights up as it is read.
function playAnswer(m, btn) {
  if (VOICE.playBtn === btn) return stopSpeaking();
  stopSpeaking();
  warmOnce();                 // (fills the voice list)
  const root = btn.closest(".ans");
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
// Nothing is sent until Ask. While you talk, the recording streams to the hub as 16 kHz PCM (pcm-worklet.js) in small
// POSTs, one at a time; the hub writes each piece down at a pause (dictation.py), so Stop only waits for the last few
// seconds. The whole recording is kept too: if streaming fails anywhere, Stop sends it to /api/voice/transcribe in one
// pass, as before. `before`/`after` are the text either side of the cursor when dictation began, so they stay
// untouched. `spoken` marks the question as dictated when it is sent.
//   ctx/node/stream: the mic's audio graph; id: the hub's session (null until `started` resolves); all: every block
//   recorded; queue: blocks not sent yet, sent in `seq` order; sending: the request in flight; failed: streaming gave
//   up (the fallback runs at Stop); text: the words written down so far.
const DICT = { ctx: null, node: null, stream: null, id: null, started: null, all: [], queue: [], seq: 0, sending: null,
  failed: false, text: "", gen: 0, timer: 0, state: "idle", before: "", after: "", last: "", spoken: false, spaceHeld: false };
const DICT_TITLE = { idle: "Dictate: speak your question, then edit it before sending (hold Space, or Ctrl+Space)", listening: "Stop and type out what you said (Ctrl+Space)",
  hearing: "Writing down what you said…" };
const DICT_SEND_MAX = 150;                          // blocks per request: 15 s of audio, well under the hub's 1 MB
const DICT_WAIT_MS = 8000;                          // a start or a chunk not answered by then: the tunnel stalled, fall back
const dictPreview = () => !!store.get("dictPreview", false);

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
  if (ta) ta.placeholder = st === "listening" ? DICT.spaceHeld ? "Listening… let go of Space to stop" : "Listening… tap ■ or Ctrl+Space to stop" : st === "hearing" ? "Writing down what you said…" : composeHint();
  if (ta && st !== "idle") dictLive(ta);            // a box drawn mid-dictation keeps the preview
}
function dictSet(state) { DICT.state = state; dictShow(); }

async function dictTap() {
  if (DICT.state === "listening") return dictFinish();
  if (DICT.state !== "idle") return;
  stopSpeaking();                                   // so the mic doesn't hear the tutor
  const tok = ++DICT.gen, d = APP.deck;
  DICT.last = $("#ask-input")?.value || "";         // a redraw before the mic starts keeps what's in the box
  Object.assign(DICT, { id: null, started: null, all: [], queue: [], seq: 0, sending: null, failed: false, text: "", before: "", after: "" });
  dictSet("listening");
  // The hub opens the session (and loads the speech models, the first time ~10 s) while the mic starts.
  const started = DICT.started = !d ? Promise.resolve(null) : api("/api/voice/dictate/start",
    { course: d.course, tag: d.tag, n: Math.min(APP.n, d.slides), scope: APP.scope }, DICT_WAIT_MS).then((r) => {
    if (tok !== DICT.gen) { dictCancelId(r.id); return null; }     // cancelled meanwhile
    DICT.id = r.id;
    dictPump();
    return r.id;
  }, () => null);
  started.then((id) => { if (!id && tok === DICT.gen) DICT.failed = true; });
  let ctx, loaded;
  try {
    ctx = DICT.ctx = new AudioContext();            // made in the tap itself, so Safari lets it run
    ctx.resume().catch(() => {});
    loaded = ctx.audioWorklet.addModule("/pcm-worklet.js");
    loaded.catch(() => {});                         // (awaited below)
  } catch {
    cancelDictation();
    return toast("This browser couldn't start recording. Try Chrome or Edge.");
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch {
    if (tok === DICT.gen) { cancelDictation(); toast("The microphone is blocked: allow it from the site settings."); }
    return;
  }
  if (tok !== DICT.gen) { stream.getTracks().forEach((t) => t.stop()); return; }   // cancelled meanwhile
  DICT.stream = stream;
  try {
    await loaded;
    if (tok !== DICT.gen) return;                   // cancelDictation closed the mic and the context
    const node = new AudioWorkletNode(ctx, "pcm16k");
    node.port.onmessage = (e) => dictBlock(tok, e.data);
    ctx.createMediaStreamSource(stream).connect(node);
    node.connect(ctx.destination);                  // it writes silence; some browsers don't run a node that goes nowhere
    ctx.resume().catch(() => {});                   // again: iOS Safari can suspend it when capture starts
    // Where the words go: at the cursor, replacing a selection (it keeps its place after tapping 🎙 takes the focus).
    const ta = $("#ask-input"), at = ta ? ta.selectionStart ?? ta.value.length : 0;
    Object.assign(DICT, { node,
      last: ta ? ta.value : "", before: ta ? ta.value.slice(0, at) : "", after: ta ? ta.value.slice(ta.selectionEnd ?? at) : "" });
    const track = stream.getAudioTracks()[0];
    if (track) track.onended = () => { if (DICT.node === node) dictFinish(); };   // mic unplugged or blocked: as Stop
    DICT.timer = setTimeout(() => { if (DICT.node === node) dictFinish(); }, MAX_RECORDING_MS);
  } catch {
    if (tok !== DICT.gen) return;
    cancelDictation();
    toast("This browser couldn't start recording. Try Chrome or Edge.");
  }
}

// A block of 16 kHz samples from the worklet: kept for the fallback, and queued for the hub.
function dictBlock(tok, data) {
  if (tok !== DICT.gen || !(data instanceof Float32Array)) return;
  DICT.all.push(data);
  DICT.queue.push(data);
  dictPump();
}

// One request at a time; what piled up meanwhile (a phone over the tunnel) goes in the next one. A failure stops the
// streaming but not the recording: Stop falls back to the whole clip. Returns the request in flight, if any.
function dictPump() {
  if (DICT.sending || !DICT.id || DICT.failed || !DICT.queue.length) return DICT.sending;
  const tok = DICT.gen;
  DICT.sending = dictSend(tok, DICT.queue.splice(0, DICT_SEND_MAX)).then(() => {
    if (tok !== DICT.gen) return;
    DICT.sending = null;
    dictPump();
  });
  return DICT.sending;
}
async function dictSend(tok, blocks) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), DICT_WAIT_MS);
  try {
    const r = await fetch(`/api/voice/dictate/chunk?id=${encodeURIComponent(DICT.id)}&seq=${DICT.seq}`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: pcm16(blocks), signal: ctl.signal });
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error);
    if (tok !== DICT.gen) return;
    DICT.seq++;
    if (data.text !== DICT.text) { DICT.text = data.text || ""; dictLive(); }   // shown only with the preview on
  } catch {
    if (tok === DICT.gen) DICT.failed = true;
  } finally {
    clearTimeout(timer);
  }
}

// Live preview (☰ "Show words while dictating", off by default): the words so far, between `before` and `after`. The
// box stays read-only and the focus stays where it is; DICT.last isn't touched, so a cancel puts the box back.
function dictLive(ta = $("#ask-input")) {
  if (!ta || !DICT.text || !dictPreview() || DICT.state !== "listening") return;
  const { before, after } = DICT;
  dictBox(ta, before + (before && !/\s$/.test(before) ? " " : "") + DICT.text + (after && !/^\s/.test(after) ? " " : "") + after);
}
// Set the box's text and its height, without the input event (that would send a draft to the other devices).
function dictBox(ta, value) {
  if (ta.value === value) return;
  ta.value = value;
  ta.style.height = "auto";
  ta.style.height = ta.value ? `${Math.min(160, ta.scrollHeight + 2)}px` : "";
}

async function dictFinish() {
  const { node, ctx, stream, gen: tok } = DICT;
  if (!node) return cancelDictation();              // tapped again before the mic had started: don't start it
  clearTimeout(DICT.timer);
  DICT.node = null;
  dictSet("hearing");
  const d = APP.deck;
  let text = "", msg = "Didn't catch that. Tap 🎙 and try again.";
  try {
    // The last samples still in the worklet (never stuck on "…"), then the mic goes.
    await new Promise((res) => {
      node.port.onmessage = (e) => { if (e.data === "done") res(); else dictBlock(tok, e.data); };
      node.port.postMessage("flush");
      setTimeout(res, 500);
    });
    dictStop(node, ctx, stream);
    if (tok !== DICT.gen) return;
    await DICT.started;                             // Stop before the session id came back: wait for it (or the fallback)
    if (tok !== DICT.gen) return;
    text = (await dictText(tok, d)).trim();
  } catch (e) { if (e && e.message && !(e instanceof DOMException)) msg = e.message; } finally {
    dictStop(node, ctx, stream);
  }
  if (tok !== DICT.gen) return;
  Object.assign(DICT, { id: null, text: "" });      // done: nothing for a cancel to send, nothing for the next preview
  dictSet("idle");
  const ta = $("#ask-input");
  if (!text) { if (ta) dictBox(ta, DICT.last); return toast(msg); }   // (a preview shown meanwhile goes)
  if (ta && APP.deck === d) dictInsert(text);       // into the box to check; nothing is sent
  else if (ta) dictBox(ta, DICT.last);
}

// What you said: the hub's session, once the last blocks are sent; if streaming failed, the whole clip in one pass.
async function dictText(tok, d) {
  if (DICT.id && !DICT.failed) {
    dictPump();
    while (tok === DICT.gen && DICT.sending) await DICT.sending;
    if (tok !== DICT.gen) return "";
    if (!DICT.failed) {
      // The hub may still be writing down what queued before Stop: normally one call (~3 s), at worst the whole
      // recording in one pass (~0.22x its length). 15 s + 0.1 s per second recorded covers that (27 s at 120 s);
      // past it the tunnel has stalled and the whole clip goes by the old route.
      const ms = 15000 + 100 * DICT.all.reduce((n, b) => n + b.length, 0) / 16000;
      try {
        const text = (await api("/api/voice/dictate/finish", { id: DICT.id }, ms)).text || "";
        DICT.id = null;                             // the hub dropped the session
        return text;
      } catch { /* the fallback below */ }
      if (tok !== DICT.gen) return "";
    }
  }
  dictCancelId(DICT.id);                            // a session that's no use any more (it would expire anyway)
  DICT.id = null;
  const all = new Float32Array(DICT.all.reduce((n, b) => n + b.length, 0));
  DICT.all.reduce((o, b) => { all.set(b, o); return o + b.length; }, 0);
  return dictTranscribe(d, new Blob([pcmWav(all, 16000)], { type: "audio/wav" }));
}

const dictTranscribe = async (d, wav) => (await api("/api/voice/transcribe",
  { course: d.course, tag: d.tag, n: Math.min(APP.n, d.slides), scope: APP.scope, audio: await blobBase64(wav) })).text;

const dictCancelId = (id) => { if (id) api("/api/voice/dictate/cancel", { id }).catch(() => {}); };   // not waited for

function dictStop(node, ctx, stream) {
  if (node) { node.port.onmessage = null; try { node.disconnect(); } catch { /* not connected */ } }
  stream?.getTracks().forEach((t) => t.stop());
  if (ctx && ctx.state !== "closed") ctx.close().catch(() => {});
}

// Blocks of float samples -> one buffer of 16-bit samples (little-endian, as every browser's platform is).
function pcm16(blocks) {
  const out = new Int16Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of blocks) for (let i = 0; i < b.length; i++) out[o++] = Math.max(-1, Math.min(1, b[i])) * 32767;
  return out;
}

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
  dictStop(DICT.node, DICT.ctx, DICT.stream);
  dictCancelId(DICT.id);                            // nothing more is written down (a start still on its way cancels itself)
  const ta = $("#ask-input"), was = DICT.state;
  Object.assign(DICT, { ctx: null, node: null, stream: null, id: null, started: null, all: [], queue: [], sending: null, text: "" });
  if (was !== "idle") { if (ta) dictBox(ta, DICT.last); dictSet("idle"); }   // a preview shown meanwhile goes
}

// Float samples -> a mono 16-bit WAV (the fallback's whole recording, and SILENT_WAV).
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

// The blocks of an answer's raw text, for the voice: from i (where a line's text starts) to `end` (where its last
// line ends). A fence (to its closing fence), $$…$$, a table (lines starting with |), with work: two or more lines
// of working; otherwise a paragraph or list run, to a blank line or a spoken line. done: nothing streamed later can
// change it (open: more may stream in; otherwise the text is whole).
const SAY_LINE = new RegExp(SAY.source);
const lineEnd = (t, j) => { const k = t.indexOf("\n", j); return k < 0 ? t.length : k; };
// A line of working (8 + 8 = 16, = 24): a digit and hardly anything but digits and operators, once a list marker
// and a leading label (Week 3:) are set aside. A run of them is working only if a line has a real operator
// (workOp): =, <, >, or one between spaces; a - or / between digits is a date or a mark (2030-01-15, 4/5).
const workLine = (l) => l.replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, "").replace(/^[A-Za-z][\w ()'-]{0,30}:\s+/, "");
const isWork = (l) => {
  const x = workLine(l).replace(/\s/g, "");
  return /\d/.test(x) && !/^[|$]/.test(x) && x.replace(/[\d=+*/×÷^<>≤≥−().,·-]/g, "").length * 10 <= x.length * 3;
};
const workOp = (l) => /[=<>≤≥]|\s[+*/×÷−·-]\s|^[+*/×÷−-]\s/.test(workLine(l).trim());
function mdBlock(t, i, work = false, open = false) {
  const le = lineEnd(t, i), first = t.slice(i, le);
  const run = (ok) => {        // the lines after the first while ok(line, whole) (null: can't tell until it's whole)
    let end = le, n = 1;
    for (let j = le; j < t.length; n++) {
      const k = lineEnd(t, j + 1), r = ok(t.slice(j + 1, k), k < t.length || !open);
      if (!r) return { end, n, done: r === false };
      end = j = k;
    }
    return { end, n, done: !open };
  };
  const f = first.match(/^(`{3,}|~{3,})/);
  if (f) {
    const close = new RegExp(`\\n {0,3}${f[1][0]}{${f[1].length},}[ \\t]*(?=\\n|$)`, "g");
    close.lastIndex = le;
    const c = close.exec(t);
    return { kind: "fence", end: c ? c.index + c[0].length : t.length, done: !!c || !open };
  }
  if (first.startsWith("$$")) {
    const c = t.indexOf("$$", i + 2), end = c < 0 ? t.length : lineEnd(t, c + 2);
    return { kind: "math", end, done: end < t.length || !open };
  }
  if (first.startsWith("|")) return { kind: "table", ...run((l, whole) => (/^\s*\|/.test(l) ? true : whole || /\S/.test(l) ? false : null)) };
  if (work && isWork(first)) {
    if (le === t.length && open) return { kind: "work", end: le, done: false };
    const r = run((l, whole) => (whole ? isWork(l) : null));
    if (!r.done || (r.n >= 2 && t.slice(i, r.end).split("\n").some(workOp))) return { kind: "work", ...r };
  }
  const opens = /^ {0,3}(```|~~~|\$\$|\|)/;       // (a paragraph running straight into one of these stops before it)
  return { kind: "text", ...run((l, whole) => (!/\S/.test(l) ? (whole ? false : null) : !whole && /^\s*[`~$|]/.test(l) ? null
    : !(whole && SAY_LINE.test(l)) && !opens.test(l))) };
}
// What a spoken line ending at `at` covers, up to the returned offset: the block on the next non-blank line; nothing
// (at) when that's another spoken line or there's none. open: still streaming in, -1 until the block is whole.
function sayCover(raw, at, open = false) {
  const i = at + raw.slice(at).search(/\S|$/);
  if (i >= raw.length) return open ? -1 : at;
  const le = lineEnd(raw, i);
  if (SAY_LINE.test(raw.slice(i, le))) return le < raw.length || !open ? at : -1;
  const b = mdBlock(raw, i, false, open);
  return b.done ? b.end : -1;
}
// A half-written spoken line at the end of the text (it's a spoken line once its ] comes).
const HALF_SAY = /^\[(?:s(?:a(?:y(?::[^\]\n]*)?)?)?)?$/;

// Speaks streamed Markdown a few sentences at a time, in order: each piece is synthesised while the previous
// one plays. A ``` drawing block isn't read out. A spoken line is said in place of the block it covers, which goes
// up whole and glows as it is said; a table, formula, code or working without one is a line of its own
// (visualFallback), glowing whole. With a view, each piece reveals it up to the piece's end (an offset
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
  // (draws: [start, end) is a drawing, given up to 2 s to be drawn before its line plays)
  const sayOne = (text, start, end, whole = false, draws = false) => {      // the raw text [start, end), said as `text`
    const audio = synth = synth.then(() => (live() && text ? fetchSpeech(text, signal) : null)).catch(() => { failed(); return null; });
    queue(async () => {
      const url = await audio;
      if (!live()) { if (url) URL.revokeObjectURL(url); return; }
      if (view && draws) await Promise.race([reveal(end), new Promise((res) => setTimeout(res, 2000))]);
      else if (view) reveal(end);
      if (!url || !live()) return;
      if (view) view.glow(start, end, whole);
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
      const line = rest.slice(0, lineEnd(rest, 0)), whole = line.length < rest.length || final;
      if (!acc.slice(acc.lastIndexOf("\n", taken - 1) + 1, taken).trim()) {      // at a line's start
        if (!whole && HALF_SAY.test(line)) return;
        const said = SAY_LINE.exec(line);
        if (said) {           // a spoken line: said in place of its block, once the block is whole (or the stream ended)
          if (!whole) return;
          const at = Math.min(acc.length, taken + line.length + 1), end = sayCover(acc, at, !final);
          if (end < 0) return;
          const start = end > at ? at + acc.slice(at).search(/\S/) : at;
          const draws = DRAWING.test(acc.slice(start, end));
          // (a drawing the answer opens with waits, as before, for the text after it to begin: the cues streamed by
          // then decide which of its parts wait for their sentence)
          if (draws && first && !final && !/\S[\s\S]*?(?:[.!?](?=["')\]]*\s)|\n)/.test(acc.slice(end))) return;
          sayOne(speakable(said[1]), start, end, true, draws);
          taken = end;
          first = false;
          continue;
        }
        if (final && HALF_SAY.test(line)) { taken += line.length; continue; }     // (never shown either)
        const b = mdBlock(acc, taken, true, !final);
        if (b.kind !== "text" && !DRAWING.test(line)) {     // a table, formula, code or working: one line for it
          if (!b.done) return;
          sayOne(FALLBACK[b.kind === "fence" ? "code" : b.kind], taken, b.end, true);
          taken = b.end;
          first = false;
          continue;
        }
      }
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
      // (a piece ends where a drawing, a spoken line or a block said as one line starts)
      let stop = fence > 0 ? fence : rest.length;
      for (const m of rest.matchAll(/\n[ \t]*(?=\S)/g)) {
        const j = m.index + m[0].length, l = rest.slice(j, lineEnd(rest, j));
        if (j >= stop) break;
        if (SAY_LINE.test(l) || (j + l.length === rest.length && HALF_SAY.test(l)) || /^(\$\$|\|)/.test(l)
          || (isWork(l) && mdBlock(acc, taken + j, true, !final).kind === "work")) { stop = j; break; }
      }
      const scan = rest.slice(0, stop);
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
        if (stop < rest.length) cut = stop;      // speak what comes before the drawing or block
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
// A table, formula, code block or working with no spoken line: one line said for it, never its cells, TeX, code or
// sums; long inline maths (over 12 characters) is "the formula on screen" in its sentence. A drawing says nothing:
// its cues narrate it.
const FALLBACK = { table: "Have a look at the table.", math: "The formula's on screen.", code: "The code's on screen.", work: "The working's on screen." };
function visualFallback(md) {
  const line = (k) => `\n${FALLBACK[k]}\n`;
  const lines = String(md)
    .replace(/(```|~~~)[ \t]*(\w*)[\s\S]*?(?:\1|$)/g, (_, f, lang) => (/^(mermaid|svg|plot)$/.test(lang) ? " " : line("code")))
    .replace(/(?:^[ \t]*\|[^\n]*(?:\n|(?![\s\S])))+/gm, line("table"))      // (before $$: a cell may hold one)
    .replace(/\$\$[\s\S]+?\$\$/g, line("math"))
    .split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {      // two or more lines of working in a row
    let j = i;
    while (j < lines.length && isWork(lines[j])) j++;
    if (j - i >= 2 && lines.slice(i, j).some(workOp)) { out.push(FALLBACK.work); i = j - 1; } else out.push(lines[i]);
  }
  return out.join("\n").replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (m, pre, t) => (t.length > 12 ? `${pre}the formula on screen` : m));
}
function speakable(md) {
  return visualFallback(unsay(md))
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
  $$(".spoken").forEach((el) => el.classList.remove("spoken"));
  voiceSet("idle");
}

// Hold Space to dictate into the Ask box, from anywhere a deck is open (into the ask bar while the tutor is closed), like
// Ctrl+Space; let go and what you said is written down. Outside a text field the mic starts once Space has been held
// SPACE_HOLD_MS, and a quick tap still does what Space did (press the focused button, scroll the chat). In the Ask box
// the first press types its space as usual; when the key starts repeating (it's being held) that space is taken back
// and the mic starts. Other text fields keep Space for typing. A press while listening (🎙 tapped) stops it.
const SPACE_HOLD_MS = 300;
const SPACE = { timer: 0, target: null, typed: null };
function spaceDictate() {
  if (DICT.state !== "idle") return;
  DICT.spaceHeld = true;
  if (!$("#dict-mic")) { APP.tutor = "open"; renderTutor(); }   // the ask bar (tutor closed) has its own mic
  dictTap();
}
// A tap that wasn't a hold: what Space would have done there.
function spaceTap(el, up) {
  const hit = el.closest?.("button, a[href], summary, [role=button], [role=radio], [role=tab], .spoiler");
  if (hit) return hit.click();
  let s = el instanceof Element ? el : null;
  while (s && !(s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
  s = s || ($(".viewer.reading") && $("#thread")) || document.scrollingElement;
  s.scrollBy({ top: (up ? -0.85 : 0.85) * s.clientHeight, behavior: "smooth" });
}
document.addEventListener("keydown", (e) => {
  if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || !APP.deck || !micOk()) return;
  const ask = e.target.id === "ask-input";
  if (!ask && e.target.closest("input, textarea, select, [contenteditable]")) return;
  if (!$("#dict-mic") && APP.tutor === "focus") return;
  if (DICT.state === "listening" && !DICT.spaceHeld) { e.preventDefault(); if (!e.repeat) dictFinish(); return; }
  if (DICT.spaceHeld || SPACE.timer || DICT.state !== "idle") { e.preventDefault(); return; }   // still held, or writing down
  if (ask) {
    const ta = e.target;
    if (!e.repeat) { SPACE.typed = { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd }; return; }   // types its space
    e.preventDefault();
    const t = SPACE.typed;
    SPACE.typed = null;
    if (!t) return;
    ta.value = t.value;                             // take back the space the first press typed
    ta.setSelectionRange(t.start, t.end);
    ta.dispatchEvent(new Event("input"));
    return spaceDictate();
  }
  e.preventDefault();
  if (e.repeat) return;
  SPACE.target = e.target;
  SPACE.timer = setTimeout(() => { SPACE.timer = 0; spaceDictate(); }, SPACE_HOLD_MS);
});
document.addEventListener("keyup", (e) => {
  if (e.key !== " ") return;
  SPACE.typed = null;
  if (SPACE.timer) {
    clearTimeout(SPACE.timer);
    SPACE.timer = 0;
    e.preventDefault();                             // (a button would also click itself on this keyup)
    return spaceTap(SPACE.target, e.shiftKey);
  }
  if (!DICT.spaceHeld) return;
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

// ------------------------------------------------------------ exam drill
// Exam-style questions from a range of decks the student picks, in the format of the practice papers they pick (or
// of the course's assessments), one at a time, worked on paper. The server keeps the range and a log of the questions
// on the chat (chat.drill); this file only sets it up, shows the tally and offers the drill's buttons.

async function openDrillSetup(viewing = true) {      // viewing: a practice paper open now is the default format
  const d = APP.deck;
  if (!d) return;
  let st;
  try { st = await api(`/api/drill/setup?course=${encodeURIComponent(d.course)}`); } catch (e) { alert(e.message); return; }
  const lecture = st.topics.flatMap((t) => t.decks);
  const chosen = new Set(st.default.decks);
  const papers = new Set(viewing && st.papers.some((p) => p.tag === d.tag) ? [d.tag] : st.default.papers);     // the paper being viewed
  const deckBoxes = [], paperBoxes = [];
  const option = (tag, label, set, list) => {
    const i = h("input", { type: "checkbox", value: tag });
    i.checked = set.has(tag);
    list.push(i);
    return h("label", { class: "drill-opt" }, i, h("span", {}, label));
  };
  const setRange = (tags) => deckBoxes.forEach((i) => { i.checked = tags.includes(i.value); });
  const upto = h("select", { "aria-label": "From the first deck up to a deck" }, h("option", { value: "" }, "From the start up to…"),
    ...lecture.map((x) => h("option", { value: x.tag }, x.tag)));
  upto.onchange = () => { if (upto.value) setRange(lecture.slice(0, lecture.findIndex((x) => x.tag === upto.value) + 1).map((x) => x.tag)); };
  const nx = st.next;
  const focus = h("textarea", { class: "drill-focus", rows: 4, "aria-label": "Focus",
    placeholder: "Optional: e.g. calculations only, harder questions — or paste the test's study guide" });
  focus.value = st.default.focus || "";
  const err = h("p", { class: "err", hidden: true });
  const dlg = h("dialog", { class: "dlg drill-dlg" },
    h("div", { class: "dlg-head" }, h("h2", {}, "Exam drill"),
      h("form", { method: "dialog" }, h("button", { class: "icon-btn", "aria-label": "Close" }, "×"))),
    h("p", { class: "muted small" }, "Questions like the real paper, one at a time, from the decks you pick. Work on paper, then send what you got (typed, spoken or a photo). Hints when you ask; the answer only when you ask for it, then the written solution, a shortcut and the method for variants."),
    h("h3", {}, "Decks in range"),
    h("div", { class: "drill-quick" }, upto,
      nx ? h("button", { class: "link", type: "button", onclick: () => setRange(lecture.filter((x) => x.week >= nx.weeks[0] && x.week <= nx.weeks[1]).map((x) => x.tag)) },
        `${nx.name} (W${nx.weeks[0]}–${nx.weeks[1]}${nx.assumed ? ", assumed" : ""})`) : null,
      h("button", { class: "link", type: "button", onclick: () => setRange(lecture.map((x) => x.tag)) }, "All"),
      h("button", { class: "link", type: "button", onclick: () => setRange([]) }, "None")),
    h("div", { class: "drill-decks" }, ...st.topics.map((t) => h("div", { class: "drill-topic" }, h("b", {}, t.name),
      ...t.decks.map((x) => option(x.tag, `${x.tag} · W${x.week} · ${x.title}`, chosen, deckBoxes))))),
    h("h3", {}, "Format from"),
    st.papers.length
      ? h("div", { class: "drill-decks" }, ...st.papers.map((p) => option(p.tag, `${p.tag} · ${p.title}`, papers, paperBoxes)),
        h("p", { class: "muted small" }, "None ticked: the format of the course's assessments."))
      : h("p", { class: "muted small" }, "No practice papers in this course yet: the drill follows the assessment format in the course notes."),
    h("h3", {}, "Focus"), focus, err,
    h("div", { class: "drill-go" }, h("button", { class: "btn", type: "button", onclick: () => {
      const decks = deckBoxes.filter((i) => i.checked).map((i) => i.value);
      if (!decks.length) { err.hidden = false; err.textContent = "Pick at least one deck."; return; }
      dlg.close();
      tutorAsk("drill", "", { drill: { decks, papers: paperBoxes.filter((i) => i.checked).map((i) => i.value), focus: focus.value.trim() } });
    } }, "Start the drill")));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// On the chat bar: the range, questions done, marks so far, decks covered, what's coming back.
function drillStatus(dr) {
  const log = dr.log || [];
  const asked = new Set(log.map((e) => e.deck));
  let got = 0, set = 0;
  for (const e of log) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(e.marks || "");
    if (m) { got += +m[1]; set += +m[2]; }
  }
  const redo = log.filter((e) => ["hinted", "revealed", "skipped"].includes(e.outcome) || (e.mistake && e.mistake !== "none")).length;
  const range = dr.decks.length > 1 ? `${dr.decks[0]} → ${dr.decks[dr.decks.length - 1]}` : dr.decks[0];
  return h("span", { class: "drill-status", title: `Range: ${dr.decks.join(", ")}${dr.papers.length ? ` · format of ${dr.papers.join(", ")}` : ""}` },
    `Drill · ${range} · ${log.length} done` + (set ? ` · ${got}/${set} marks` : "") +
    ` · ${dr.decks.filter((t) => asked.has(t)).length}/${dr.decks.length} decks` + (redo ? ` · ${redo} to revisit` : ""));
}

// Under the drill's last answer: what the student can do besides typing an answer.
// (A photo of the page is attached with 📷 in the Ask box, like any question's.)
function drillFoot() {
  return h("div", { class: "msg-foot drill-foot" },
    h("button", { class: "link", type: "button", title: "The next hint, never the answer (/hint)", onclick: () => tutorAsk("drill_hint") }, "Hint"),
    h("button", { class: "link", type: "button", title: "The written solution for full marks, a shortcut and the method for variants (/answer)", onclick: () => tutorAsk("drill_reveal") }, "Show the answer"),
    h("button", { class: "link quiet", type: "button", title: "Move on; it comes back later in the drill (/skip)", onclick: () => tutorAsk("drill_skip") }, "Skip"),
    h("button", { class: "link quiet", type: "button", title: "Stop: marks per topic, what held up, what's shaky (/enddrill)", onclick: () => tutorAsk("drill_end") }, "End the drill ›"));
}

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
  const from = prob.slides ? `From ${prob.slides}` : "";
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
  photoPicker(true, async ([f]) => {
    setPhotos(0);
    try {
      const r = await api("/api/practice/photo", { id: prob.id, data: await shrinkImage(f) });
      setPhotos(r.photos);
    } catch (e) { alert(e.message); }
  });
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

// prob: a practice problem, or { ask: course } for the Ask box (the photo then arrives over the live draft).
function sendFromPhone(prob, setPhotos) {
  const url = `${APP.phoneUrl}#upload=${prob.ask ? `ask-${encodeURIComponent(prob.ask)}` : prob.id}`;
  const qr = qrcode(0, "M"); qr.addData(url); qr.make();
  $("#qr-title").textContent = "Send a photo from your phone";
  $("#qr-text").textContent = prob.ask ? "Scan this with your phone's camera and take a photo: it goes into the Ask box here, with your next question."
    : "Scan this with your phone's camera, take a photo of your working, and it appears here.";
  $("#qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  $("#qr-url").textContent = "";
  const dlg = $("#qr-dlg");
  dlg.showModal();
  if (prob.ask) {
    DRAFT.onPhotos = () => dlg.close();
    dlg.addEventListener("close", () => { DRAFT.onPhotos = null; }, { once: true });
    return;
  }
  const sent = prob.photos || 0;        // the count before this phone's photo
  const timer = setInterval(async () => {
    try {
      const r = await api(`/api/practice?id=${prob.id}`);
      if (r.photos !== sent) { setPhotos(r.photos); dlg.close(); }
    } catch { /* keep polling */ }
  }, 2500);
  dlg.addEventListener("close", () => clearInterval(timer), { once: true });
}

async function showUpload(pid) {
  setCrumbs({ label: "Send a photo" });
  $("#session-bar").hidden = true;
  const main = $("#main");
  let prob;
  const ask = pid.startsWith("ask-") ? pid.slice(4) : null;         // the Ask box of this course
  try {
    prob = ask ? { slides: ask.replace(/_/g, " "), problem_md: "Take a photo of your page. It goes into the Ask box on your laptop, and with your next question.", photos: 0 }
      : await api(`/api/practice?id=${encodeURIComponent(pid)}`);
  }
  catch (e) { main.replaceChildren(h("div", { class: "upload-page" }, h("p", { class: "err" }, e.message))); return; }
  const status = h("p", { class: "muted" }, prob.photos ? `${prob.photos} photo${prob.photos === 1 ? "" : "s"} sent so far.` : "");
  const btn = h("button", { class: "btn big", type: "button" }, "Take a photo of your working");
  btn.onclick = () => photoPicker(true, async ([f]) => {
    status.textContent = "Sending…";
    try {
      const data = await shrinkImage(f);
      const r = ask ? await api("/api/draft/photo", { course: ask, client: DRAFT.client, data }) : await api("/api/practice/photo", { id: pid, data });
      const k = ask ? r.photos.length : r.photos;
      status.textContent = `Sent ✓ (${k} photo${k === 1 ? "" : "s"}${ask ? " in the Ask box" : ""}). Check your laptop, or add another.`;
      btn.textContent = "Add another photo";
    } catch (e) { status.textContent = e.message; }
  });
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
    page.replaceChildren(h("p", { class: "count" }, `${i + 1} of ${total}`), area);
    i += 1;
    runPractice(area, { course: courseId, kind: "review", review_id: it.id }, () =>
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
  $("#dict-preview").checked = dictPreview();
  api("/api/usage").then((u) => { $("#usage-sum").textContent = usageSum(u.this); }).catch(() => {});
  m.hidden = false;
  $("#menu-btn").setAttribute("aria-expanded", "true");
}
function closeMenu() { $("#menu").hidden = true; $("#menu-btn").setAttribute("aria-expanded", "false"); }
$("#menu-btn").addEventListener("click", (e) => { e.stopPropagation(); $("#menu").hidden ? openMenu() : closeMenu(); });
document.addEventListener("click", (e) => { if (!$("#menu").hidden && !e.target.closest("#menu")) closeMenu(); });
$("#slides-only").addEventListener("change", (e) => { const cid = currentCourseId(); if (cid) store.set(`slidesOnly:${cid}`, e.target.checked); });
$("#dict-preview").addEventListener("change", (e) => store.set("dictPreview", e.target.checked));   // from the next words written down
$("#model-pick").addEventListener("change", (e) => { APP.model = e.target.value; store.set("model", APP.model); });
$("#menu").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "history") { closeMenu(); showHistory(); }
  if (act === "phone") { closeMenu(); showPhoneQr(); }
  if (act === "usage") { closeMenu(); showUsage(); }
});

// Tokens and cost of every model call, kept by the server across runs (a run: from the hub starting to it stopping).
const kTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);
const tokTotal = (t) => t.in + t.cache_read + t.cache_write + t.out;
const usd = (c) => `$${(+c || 0).toFixed(c && c < 0.01 ? 4 : 2)}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function usageSum(t) { return t.calls || t.failed ? `${kTok(tokTotal(t))} · ${usd(t.cost)}` : ""; }
const tokParts = (t) => `${kTok(t.in)} new · ${kTok(t.cache_read)} cache read · ${kTok(t.cache_write)} cache write · ${kTok(t.out)} out`;
const runWhen = (run) => run.slice(0, 16);

function usageTotal(title, t) {
  const counts = [plural(t.calls, "answer"), t.failed ? `${t.failed} failed` : "", t.unknown ? `${t.unknown} not fully known` : ""];
  return h("div", { class: "usage-total" },
    h("span", { class: "usage-label" }, title),
    h("b", {}, `${kTok(tokTotal(t))} tokens · ${usd(t.cost)}`),
    h("span", {}, counts.filter(Boolean).join(" · ")),
    h("span", {}, tokParts(t)));
}

function usageRow(c) {
  const who = APP.models.find((x) => x.id === c.model);
  const head = c.tokens ? `${kTok(tokTotal(c.tokens))} tokens` : "Tokens unknown";
  const cost = c.cost == null ? "cost unknown" : usd(c.cost);
  return h("div", { class: "usage-row" + (c.error ? " failed" : "") },
    h("b", {}, `${c.error ? "Failed · " : ""}${head} · ${cost}`),
    h("span", {}, [c.at.slice(11), c.kind, c.course, who ? who.label : c.model, c.ms ? `${Math.round(c.ms / 1000)} s` : ""].filter(Boolean).join(" · ")),
    c.tokens ? h("span", {}, tokParts(c.tokens)) : null,
    c.error ? h("span", {}, c.error) : null);
}

async function showUsage() {
  const body = $("#usage-body");
  body.replaceChildren(h("p", { class: "waiting" }, "Loading…"));
  $("#usage-dlg").showModal();
  const u = await api("/api/usage").catch(() => null);
  if (!u) return body.replaceChildren(h("p", { class: "muted" }, "Couldn't load usage."));
  body.replaceChildren(
    usageTotal(`This run · since ${runWhen(u.run)}`, u.this),
    u.runs.length > 1 ? usageTotal(`All runs · ${plural(u.runs.length, "run")}`, u.all) : null);
  body.append(...(u.calls.length ? u.calls.map(usageRow) : [h("p", { class: "muted" }, "No answers yet this run.")]));
  const earlier = u.runs.filter((r) => r.run !== u.run);
  if (!earlier.length) return;
  body.append(h("p", { class: "usage-label usage-head" }, "Earlier runs"));
  for (const r of earlier) {
    const list = h("div", { class: "usage-calls", hidden: true });
    const btn = h("button", { class: "usage-run", type: "button", "aria-expanded": "false", onclick: async () => {
      const open = list.hidden;
      list.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      if (!open || list.childElementCount) return;
      list.append(h("p", { class: "waiting" }, "Loading…"));
      const got = await api(`/api/usage?run=${encodeURIComponent(r.run)}`).catch(() => null);
      list.replaceChildren(...(got ? got.calls.map(usageRow) : [h("p", { class: "muted" }, "Couldn't load that run.")]));
    } },
      h("b", {}, `${runWhen(r.run)} · ${kTok(tokTotal(r))} tokens · ${usd(r.cost)}`),
      h("span", {}, [plural(r.calls, "answer"), r.failed ? `${r.failed} failed` : ""].filter(Boolean).join(" · ") + " ›"));
    body.append(btn, list);
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
    // Grouped by engine/provider; each option ends with its intelligence score (higher = more capable).
    const groups = new Map();
    for (const x of m.models) {
      const key = x.provider || "Models";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(x);
    }
    $("#model-pick").replaceChildren(...[...groups].map(([provider, xs]) => h("optgroup", { label: provider },
      ...xs.map((x) => h("option", { value: x.id }, `${x.label} · ${x.iq}`)))));
    $("#model-pick").value = APP.model;
  } catch { /* the server default applies */ }
  try {
    APP.phoneUrl = (await api("/api/phone")).url;
    $("#phone-item").hidden = !APP.phoneUrl;
  } catch { /* local only */ }
  route();
})();
