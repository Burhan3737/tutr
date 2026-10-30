"""Course material as the Study Hub sees it: Course → Topic → Deck → Slide.

Everything comes from files the course folders already have:
- `<course>/CLAUDE.md` — the deck table (Week | Deck | Tag | Topic) and the Topics table (Topic | Read more)
- `<course>/course/WeekN/<deck>.pdf` — the lecture decks, as downloaded
- `<course>/course/practice/<deck>.pdf` — homework and practice exams: decks too, but listed apart from the
  topics (`practice`), whatever their Topic cell says; their week is the Week cell of their deck-table row
  (else the last lecture week)
- `<course>/.cache/WeekN/<deck>.transcript.md` — slide-by-slide transcripts (`## [tag sN] title`);
  `.cache/practice/` for the practice decks
- `<course>/study/slides/<tag>-sNNN.jpg` — slide images
- `<course>/study/progress.md` — the Deadlines table (with a Covers column for exam scope)
- `<course>/course/WeekN/notes*.md` — the student's own class notes
- `<course>/.cache/textbooks/*.toc.md` — textbook contents (full text alongside, for search)

A deck that isn't in the CLAUDE.md table yet (new slides, not prepared) still shows up, under
"Not sorted yet", with its images rendered from the PDF and its PDF text layer as the transcript.
"""
import datetime as dt, json, os, re, threading
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _library_root():
    """Where the courses live: STUDY_HUB_ROOT, else `library` in config.json at the repo root (a relative path is
    relative to the repo root), else <repo>/library."""
    env = os.environ.get("STUDY_HUB_ROOT")
    if env:
        return Path(env).resolve()
    try:
        cfg = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
        path = cfg.get("library") if isinstance(cfg, dict) else None
    except (OSError, ValueError):
        path = None
    return (HERE / path).resolve() if path else (HERE / "library").resolve()


ROOT = _library_root()
WEEK_RE = re.compile(r"^Week(\d+)$", re.I)
PRACTICE = "practice"   # course/practice/: homework and practice exams, no week folder
PRACTICE_NAME = "Practice"   # what the hub calls them; never a topic
UNSORTED = "Not sorted yet"
_LOCK = threading.Lock()
_CACHE = {}     # key -> (signature, value); rebuilt only when the underlying files change


def course_dirs():
    if not ROOT.is_dir():       # no library yet: no courses
        return []
    return sorted(p for p in ROOT.iterdir() if p.is_dir() and (p / "study").is_dir())


def course_dir(course_id):
    return next((c for c in course_dirs() if c.name == course_id), None)


def course_meta(cdir):
    m = re.match(r"^([A-Za-z]+)-?(\d+)_?(.*)$", cdir.name)
    code = f"{m.group(1).upper()}{m.group(2)}" if m else cdir.name
    title = m.group(3).replace("_", " ") if m else cdir.name
    return code, title


def safe_tag(tag):
    """File-name form of a citation tag, e.g. 'S&D-2' -> 'SD-2' (same rule as the preparing-slides skill)."""
    return re.sub(r"[^A-Za-z0-9-]", "", tag)


def _sig(paths):
    out = []
    for p in paths:
        try:
            st = p.stat()
            out.append((str(p), st.st_size, st.st_mtime_ns))
        except OSError:
            out.append((str(p), None, None))
    return tuple(out)


def _cached(key, paths, build):
    sig = _sig(paths)
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and hit[0] == sig:
            return hit[1]
    val = build()
    with _LOCK:
        _CACHE[key] = (sig, val)
    return val


def md_tables(text):
    """Every Markdown table in `text`, as (header cells, rows of cells)."""
    tables, cur = [], None
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("|"):
            cells = [c.strip() for c in s.strip("|").split("|")]
            if cur is None:
                cur = [cells, []]
            elif not all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
                cur[1].append(cells)
        elif cur is not None:
            tables.append(cur)
            cur = None
    if cur is not None:
        tables.append(cur)
    return tables


def section(text, heading):
    m = re.search(rf"^## {re.escape(heading)}\s*$(.*?)(?=^## |\Z)", text, re.M | re.S)
    return m.group(1) if m else ""


# ---------------------------------------------------------------- decks and topics

def _pdfs(cdir):
    out = []
    base = cdir / "course"
    if base.is_dir():
        for w in base.iterdir():
            m = WEEK_RE.match(w.name)
            if w.is_dir() and m:
                out += [(int(m.group(1)), p) for p in sorted(w.glob("*.pdf"))]
    last = max((w for w, _ in out), default=0)
    out += [(last, p) for p in sorted((base / PRACTICE).glob("*.pdf"))]    # week set from the deck table later
    return sorted(out, key=lambda x: (x[0], x[1].name))


def course_info(cdir):
    """{'code','title','topics':[{name, read_more, decks:[...]}], 'practice': [tag], 'decks': {tag: deck}} — cached."""
    cm = cdir / "CLAUDE.md"
    pdfs = _pdfs(cdir)
    watch = [cm] + [p for _, p in pdfs] + sorted((cdir / ".cache").glob("Week*/*.transcript.md")) + \
        sorted((cdir / ".cache" / PRACTICE).glob("*.transcript.md"))
    return _cached(("info", cdir), watch, lambda: _build_info(cdir, pdfs))


def _build_info(cdir, pdfs):
    code, title = course_meta(cdir)
    text = cdir.joinpath("CLAUDE.md").read_text(encoding="utf-8") if (cdir / "CLAUDE.md").exists() else ""
    rows, read_more = [], {}
    for head, body in md_tables(text):
        h = [c.lower() for c in head]
        if h[:3] == ["week", "deck", "tag"]:
            for r in body:
                tag = re.findall(r"`([^`]+)`", r[2])
                if tag:
                    rows.append((r[0], r[1], tag[0], r[3] if len(r) > 3 and r[3] else UNSORTED))
        elif h[:2] == ["topic", "read more"]:
            for r in body:
                if len(r) > 1:
                    read_more[r[0]] = r[1]
    by_stem = {p.stem: (w, p) for w, p in pdfs}
    decks, order = {}, 0
    for wk, stem, tag, topic in rows:
        if stem not in by_stem:
            continue
        w, pdf = by_stem.pop(stem)
        if pdf.parent.name == PRACTICE:                 # listed apart from the topics; week from its table row
            topic = PRACTICE_NAME
            if re.match(r"\d+", wk):
                w = int(re.match(r"\d+", wk).group())
        decks[tag] = _deck(cdir, tag, w, pdf, topic, order)
        order += 1
    for stem, (w, pdf) in sorted(by_stem.items(), key=lambda x: (x[1][0], x[0])):   # not in the table yet
        if stem.lower().startswith("notes"):
            continue
        tag = stem.replace("_", "-")
        decks[tag] = _deck(cdir, tag, w, pdf, PRACTICE_NAME if pdf.parent.name == PRACTICE else UNSORTED, order)
        order += 1
    topics, practice = {}, []
    for d in sorted(decks.values(), key=lambda d: (d["week"], d["order"])):
        if d["topic"] == PRACTICE_NAME:
            practice.append(d["tag"])
        else:
            topics.setdefault(d["topic"], []).append(d["tag"])
    # Topics in order of their first deck; decks inside a topic in lecture order.
    tlist = [{"name": n, "read_more": read_more.get(n, ""), "decks": tags} for n, tags in topics.items()]
    tlist.sort(key=lambda t: (t["name"] == UNSORTED, min(decks[x]["week"] * 1000 + decks[x]["order"] for x in t["decks"])))
    return {"code": code, "title": title, "topics": tlist, "practice": practice, "decks": decks}


def _deck(cdir, tag, week, pdf, topic, order):
    tr = cdir / ".cache" / pdf.parent.name / f"{pdf.stem}.transcript.md"     # WeekN/ or practice/
    try:
        import fitz
        with fitz.open(pdf) as d:
            n = d.page_count
    except Exception:
        n = 0
    title = ""
    if tr.exists():
        m = re.search(r"^## \[[^\]]+ s1\]\s*(.*)$", tr.read_text(encoding="utf-8"), re.M)
        title = m.group(1).strip() if m else ""
    return {"tag": tag, "stem": pdf.stem, "week": week, "topic": topic, "order": order, "slides": n,
            "title": title or pdf.stem.replace("_", " ").replace("-", " "),
            "pdf": pdf.relative_to(cdir).as_posix(),
            "transcript": tr.relative_to(cdir).as_posix() if tr.exists() else None}


def deck(cdir, tag):
    return course_info(cdir)["decks"].get(tag)


def deck_order(cdir):
    """All decks in lecture order (week, then table order)."""
    return sorted(course_info(cdir)["decks"].values(), key=lambda d: (d["week"], d["order"]))


# ---------------------------------------------------------------- slide text and images

TYPE_LINE = re.compile(r"^Type: \w+\s*$", re.M)


def slide_texts(cdir, tag):
    """[{n, title, md}] for every slide of a deck — from the transcript, else the PDF text layer."""
    d = deck(cdir, tag)
    if not d:
        return []
    src = cdir / (d["transcript"] or d["pdf"])
    return _cached(("text", cdir, tag), [src], lambda: _build_texts(cdir, d))


def _build_texts(cdir, d):
    out = {}
    if d["transcript"]:
        text = (cdir / d["transcript"]).read_text(encoding="utf-8")
        parts = re.split(r"^## \[([^\]]+?) s(\d+)\]\s*(.*)$", text, flags=re.M)
        for i in range(1, len(parts), 4):
            n = int(parts[i + 1])
            body = TYPE_LINE.sub("", parts[i + 3]).strip()
            out[n] = {"n": n, "title": parts[i + 2].strip(), "md": body}
    else:
        try:
            import fitz
            with fitz.open(cdir / d["pdf"]) as doc:
                for i, page in enumerate(doc, 1):
                    t = page.get_text().strip()
                    out[i] = {"n": i, "title": (t.splitlines() or [""])[0][:80], "md": t, "raw": True}
        except Exception:
            pass
    return [out.get(n, {"n": n, "title": "", "md": ""}) for n in range(1, d["slides"] + 1)]


def slide_image(cdir, tag, n):
    """Path of the slide image; renders it from the PDF (once) when the prepared image is missing."""
    d = deck(cdir, tag)
    if not d or not (1 <= n <= d["slides"]):
        return None
    img = cdir / "study" / "slides" / f"{safe_tag(tag)}-s{n:03d}.jpg"
    if img.exists():
        return img
    out = cdir / ".cache" / "render" / f"{safe_tag(tag)}-s{n:03d}.jpg"
    if not out.exists():
        import fitz
        out.parent.mkdir(parents=True, exist_ok=True)
        with fitz.open(cdir / d["pdf"]) as doc:
            doc[n - 1].get_pixmap(dpi=110).save(str(out), jpg_quality=85)
    return out


# ---------------------------------------------------------------- class notes

def class_notes(cdir):
    out = []
    base = cdir / "course"
    for w in sorted(base.glob("Week*"), key=lambda p: int(WEEK_RE.match(p.name).group(1)) if WEEK_RE.match(p.name) else 0):
        m = WEEK_RE.match(w.name)
        if m:
            for f in sorted(w.glob("notes*.md")) + sorted(w.glob("notes*.txt")):
                if f.stat().st_size > 0:
                    out.append({"week": int(m.group(1)), "name": f.name, "path": f.relative_to(cdir).as_posix()})
    return out


def other_docs(cdir):
    """Mocks and cheat sheets (study/exams/<assessment>/), lab/assignment guides (labs/, assignments/), and the
    voice tutor's notes on the student (study/tutor-memory.md)."""
    groups = []
    for kind, base in (("exams", cdir / "study" / "exams"), ("labs", cdir / "labs"), ("assignments", cdir / "assignments")):
        if base.is_dir():
            for d in sorted(x for x in base.iterdir() if x.is_dir()):
                files = sorted(d.glob("*.md"))
                if files:
                    groups.append({"kind": kind, "name": d.name,
                                   "files": [{"name": f.stem, "path": f.relative_to(cdir).as_posix()} for f in files]})
    memory = cdir / "study" / "tutor-memory.md"      # the voice tutor's notes on the student (tutor.py)
    if memory.is_file():
        groups.append({"kind": "tutor", "name": "", "files": [{"name": "What your tutor remembers",
                                                               "path": memory.relative_to(cdir).as_posix()}]})
    return groups


def readable_doc(cdir, path):
    """True only for the class notes, mocks/cheat sheets and lab/assignment guides listed above."""
    return any(n["path"] == path for n in class_notes(cdir)) or \
        any(f["path"] == path for g in other_docs(cdir) for f in g["files"])


# ---------------------------------------------------------------- assessments

MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def parse_date(s, year):
    m = re.search(r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b", s, re.I)
    if not m:
        return None
    try:
        return dt.date(year, MONTHS[m.group(1).lower()[:3]], int(m.group(2)))
    except ValueError:
        return None


def assessments(cdir):
    """Graded tests of lecture content from progress.md → Deadlines rows with a Covers value."""
    prog = cdir / "study" / "progress.md"
    if not prog.exists():
        return []
    text = prog.read_text(encoding="utf-8")
    year = dt.date.today().year
    out = []
    for head, body in md_tables(section(text, "Deadlines")):
        h = [c.lower() for c in head]
        if "covers" not in h:
            continue
        for r in body:
            row = dict(zip(h, r))
            cov = row.get("covers", "")
            if not cov or row.get("status", "").lower().startswith(("done", "submitted", "complete")):
                continue
            weeks = [int(x) for x in re.findall(r"\d+", cov.split("(")[0])]
            lo, hi = (weeks[0], weeks[-1]) if weeks else (0, 99)
            item = re.sub(r"\*\*", "", row.get("item", ""))
            name = item.split("—")[0].strip()
            date = parse_date(row.get("date", ""), year)
            out.append({"name": name, "detail": item, "date_text": row.get("date", ""),
                         "date": date.isoformat() if date else None, "approx": row.get("date", "").startswith("~"),
                         "weeks": [lo, hi], "assumed": "assumed" in cov.lower()})
    return out


def next_assessment(cdir):
    today = dt.date.today()
    upcoming = [a for a in assessments(cdir) if not a["date"] or a["date"] >= today.isoformat()]
    dated = sorted((a for a in upcoming if a["date"]), key=lambda a: a["date"])
    a = dated[0] if dated else (upcoming[0] if upcoming else None)
    if a:
        info = course_info(cdir)
        lo, hi = a["weeks"]
        a = dict(a, days=(dt.date.fromisoformat(a["date"]) - today).days if a["date"] else None,
                 topics=[t["name"] for t in info["topics"]
                         if any(lo <= info["decks"][x]["week"] <= hi for x in t["decks"]) and t["name"] != UNSORTED])
    return a


# ---------------------------------------------------------------- search

def search(q, limit=60):
    q = q.strip().lower()
    if len(q) < 2:
        return []
    hits = []
    for cdir in course_dirs():
        info = course_info(cdir)
        for d in deck_order(cdir):
            for s in slide_texts(cdir, d["tag"]):
                hay = (s["title"] + "\n" + s["md"]).lower()
                i = hay.find(q)
                if i < 0:
                    continue
                flat = re.sub(r"\s+", " ", (s["title"] + " — " + s["md"]))
                j = flat.lower().find(q)
                snip = flat[max(0, j - 60): j + 90]
                hits.append({"course": cdir.name, "code": info["code"], "topic": d["topic"], "deck": d["tag"],
                             "slide": s["n"], "title": s["title"], "text": ("…" if j > 60 else "") + snip})
                if len(hits) >= limit:
                    return hits
    return hits


# ---------------------------------------------------------------- course map (for the tutor)

def course_map(cdir):
    info = course_info(cdir)
    books = sorted((cdir / ".cache" / "textbooks").glob("*.toc.md"))
    notes = class_notes(cdir)
    watch = [cdir / "CLAUDE.md"] + books + [cdir / n["path"] for n in notes] + \
            [cdir / d["transcript"] for d in info["decks"].values() if d["transcript"]]
    return _cached(("map", cdir), watch, lambda: _build_map(cdir, info, books, notes))


def _build_map(cdir, info, books, notes):
    out = [f"# {info['code']} {info['title']}: map of the course material",
           "Paths are relative to the course folder (your working directory).", "",
           "- `CLAUDE.md`: course facts: assessments, format, dates, AI policy",
           "- `study/progress.md`: deadlines (with the weeks each test covers), weak topics, error log", ""]
    for t in info["topics"]:
        out.append(f"## Topic: {t['name']}" + (f" (read more: {t['read_more']})" if t["read_more"] else ""))
        for tag in t["decks"]:
            d = info["decks"][tag]
            src = d["transcript"] or f"{d['pdf']} (no transcript yet: PDF only)"
            titles = " · ".join(f"s{s['n']} {s['title'][:50]}" for s in slide_texts(cdir, tag) if s["title"])
            out.append(f"- [{tag}] W{d['week']} {d['title']}: `{src}`, {d['slides']} slides")
            out.append(f"    {titles}")
        out.append("")
    if info["practice"]:
        out.append("## Practice: homework and practice exams (questions only, no solutions)")
        for tag in info["practice"]:
            d = info["decks"][tag]
            src = d["transcript"] or f"{d['pdf']} (no transcript yet: PDF only)"
            out.append(f"- [{tag}] W{d['week']} {d['title']}: `{src}`, {d['slides']} pages")
        out.append("")
    if notes:
        out.append("## The student's own class notes")
        out += [f"- W{n['week']}: `{n['path']}`" for n in notes]
        out.append("")
    if books:
        out.append("## Textbooks (full text in `.cache/textbooks/<name>.txt`, page markers `===== <name> PAGE n =====`; "
                   "contents in `<name>.toc.md`: Grep the .txt for a term, or Read the toc first)")
        out += [f"- `{b.relative_to(cdir).as_posix()}`" for b in books]
    extra = [p for g in ("labs", "assignments") if (cdir / g).is_dir()
             for p in sorted((cdir / g).rglob("*")) if p.is_file() and p.suffix.lower() in (".md", ".txt")]
    if extra:
        out += ["", "## Labs and assignments"] + [f"- `{p.relative_to(cdir).as_posix()}`" for p in extra]
    return "\n".join(out)


def topic_context(cdir, topic, budget_chars=100_000):
    """The transcripts of every deck in a topic, whole (about 25k tokens at most). If the topic is
    bigger, returns None and the tutor gets the current deck plus the map instead."""
    info = course_info(cdir)
    t = next((x for x in info["topics"] if x["name"] == topic), None)
    if not t:
        return None
    parts = []
    for tag in t["decks"]:
        body = "\n\n".join(f"### [{tag} s{s['n']}] {s['title']}\n{s['md']}" for s in slide_texts(cdir, tag))
        parts.append(f"## Deck [{tag}] {info['decks'][tag]['title']}\n\n{body}")
    text = "\n\n".join(parts)
    return text if len(text) <= budget_chars else None


def deck_context(cdir, tag):
    info = course_info(cdir)
    body = "\n\n".join(f"### [{tag} s{s['n']}] {s['title']}\n{s['md']}" for s in slide_texts(cdir, tag))
    return f"## Deck [{tag}] {info['decks'][tag]['title']}\n\n{body}"
