"""Course material as the Study Hub sees it: Course → Topic → Deck → Slide.

Everything comes from the library (see _library_root), one folder per course:
- `<course>/course.json` — the course's fixed facts: {"code", "title", "assessment_style", "topics": [{"name",
  "read_more"}]}. A folder with a course.json is a course; its folder name is its id.
- `<course>/decks/<folder>/deck.json` — one deck: {"tag", "title", "role": "lecture" | "practice", "week", "topic",
  "order", "pages", "prepared", "source"}. Practice decks (homework, practice exams) are listed apart from the
  topics; a lecture deck with no topic (or "Unsorted") goes under "Not sorted yet".
- `<course>/decks/<folder>/transcript.md` — slide-by-slide transcript (`## [tag sN] title`)
- `<course>/decks/<folder>/sNNN.jpg` — slide images
- `<course>/textbooks/*.toc.md` — textbook contents (full text alongside, for search)
- `<course>/me/progress.md` — the Deadlines table (with a Covers column for exam scope)
- `<course>/me/notes/**` — the student's own writing: `WeekN/` holds class notes; any other folder (exams/, labs/,
  assignments/, …) is a group of documents. `me/private/` is never listed or served.
- `<course>/me/tutor-memory.md` — the voice tutor's notes on the student

`CLAUDE.md` is prose for Claude; nothing here parses it. No PDF is ever opened here: the preparing-slides skill
writes each deck's images, transcript and deck.json.
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
    path = path if isinstance(path, str) else None      # a number or a list there is ignored, not a crash at start
    return (HERE / path).resolve() if path else (HERE / "library").resolve()


ROOT = _library_root()
WEEK_RE = re.compile(r"^Week(\d+)$", re.I)
COURSE_FILE = "course.json"
DECK_FILE = "deck.json"
PRACTICE = "practice"   # deck.json role of homework and practice exams
PRACTICE_NAME = "Practice"   # what the hub calls them; never a topic
UNSORTED = "Not sorted yet"
DOC_GROUPS = ("exams", "labs", "assignments")     # me/notes/ folders listed first, in this order
_LOCK = threading.Lock()
_CACHE = {}     # key -> (signature, value); rebuilt only when the underlying files change


def course_dirs():
    if not ROOT.is_dir():       # no library yet: no courses
        return []
    return sorted(p for p in ROOT.iterdir() if p.is_dir() and (p / COURSE_FILE).is_file())


def course_dir(course_id):
    return next((c for c in course_dirs() if c.name == course_id), None)


def me_dir(cdir):
    """The student's own data in a course: progress, hub state, chats, practice, drafts, uploads, notes."""
    return cdir / "me"


def notes_dir(cdir):
    return me_dir(cdir) / "notes"


def _read_json(path):
    try:
        v = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return v if isinstance(v, dict) else {}


def course_json(cdir):
    f = cdir / COURSE_FILE
    return _cached(("course", cdir), [f], lambda: _read_json(f))


def course_meta(cdir):
    """(code, title) from course.json; the folder name for either when it's missing."""
    j = course_json(cdir)
    code = str(j.get("code") or "").strip() or cdir.name
    title = str(j.get("title") or "").strip() or cdir.name
    return code, title


def course_style(cdir):
    """The course's assessment style for the tutor's prompts (course.json); "" when it has none."""
    return str(course_json(cdir).get("assessment_style") or "").strip()


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

def _deck_files(cdir):
    return sorted((cdir / "decks").glob(f"*/{DECK_FILE}"))


def course_info(cdir):
    """{'code','title','topics':[{name, read_more, decks:[...]}], 'practice': [tag], 'decks': {tag: deck}} — cached."""
    files = _deck_files(cdir)
    watch = [cdir / COURSE_FILE] + files + sorted((cdir / "decks").glob("*/transcript.md"))
    return _cached(("info", cdir), watch, lambda: _build_info(cdir, files))


def _num(v, default=0):
    """A whole number from deck.json (a number or a numeric string); anything else -> default."""
    if isinstance(v, bool):
        return default
    if isinstance(v, (int, float)):
        return int(v)
    m = re.match(r"\s*(\d+)", str(v or ""))
    return int(m.group(1)) if m else default


def _build_info(cdir, files):
    code, title = course_meta(cdir)
    read_more = {}
    for t in course_json(cdir).get("topics") or []:
        if isinstance(t, dict) and str(t.get("name") or "").strip():
            read_more[str(t["name"]).strip()] = str(t.get("read_more") or "")
    found = []
    for f in files:
        d = _deck(cdir, f.parent, _read_json(f))
        if d:
            found.append(d)
    decks = {}
    for d in sorted(found, key=lambda d: (d["week"], d["order"], d["folder"])):    # lecture order
        decks.setdefault(d["tag"], d)           # a tag claimed twice: the first folder keeps it
    topics, practice = {}, []
    for d in decks.values():
        if d["topic"] == PRACTICE_NAME:
            practice.append(d["tag"])
        else:
            topics.setdefault(d["topic"], []).append(d["tag"])
    # Topics in order of their first deck; decks inside a topic in lecture order.
    tlist = [{"name": n, "read_more": read_more.get(n, ""), "decks": tags} for n, tags in topics.items()]
    tlist.sort(key=lambda t: (t["name"] == UNSORTED, min(decks[x]["week"] * 1000 + decks[x]["order"] for x in t["decks"])))
    return {"code": code, "title": title, "topics": tlist, "practice": practice, "decks": decks}


def _deck(cdir, folder, j):
    if not j:
        return None
    tag = str(j.get("tag") or "").strip() or folder.name
    if str(j.get("role") or "").strip().lower() == PRACTICE:      # listed apart from the topics
        topic = PRACTICE_NAME
    else:
        topic = str(j.get("topic") or "").strip()
        topic = UNSORTED if not topic or topic.lower() == "unsorted" else topic
    tr = folder / "transcript.md"
    return {"tag": tag, "folder": folder.name, "week": _num(j.get("week")), "topic": topic, "order": _num(j.get("order")),
            "slides": _num(j.get("pages")), "title": str(j.get("title") or "").strip() or tag,
            "prepared": j.get("prepared") is True,
            "transcript": tr.relative_to(cdir).as_posix() if tr.is_file() else None}


def deck(cdir, tag):
    return course_info(cdir)["decks"].get(tag)


def deck_order(cdir):
    """All decks in lecture order (week, then deck.json's order)."""
    return sorted(course_info(cdir)["decks"].values(), key=lambda d: (d["week"], d["order"]))


def deck_dir(cdir, d):
    return cdir / "decks" / d["folder"]


# ---------------------------------------------------------------- slide text and images

TYPE_LINE = re.compile(r"^Type: \w+\s*$", re.M)


def slide_texts(cdir, tag):
    """[{n, title, md}] for every slide of a deck, from its transcript (empty when it has none). A deck not fully
    prepared yet (`prepared: false`) has a rough transcript from the PDF's text layer: its slides carry raw: True."""
    d = deck(cdir, tag)
    if not d:
        return []
    base = deck_dir(cdir, d)
    return _cached(("text", cdir, tag), [base / "transcript.md", base / DECK_FILE], lambda: _build_texts(cdir, d))


def _build_texts(cdir, d):
    out = {}
    tr = deck_dir(cdir, d) / "transcript.md"
    try:
        text = tr.read_text(encoding="utf-8")
    except OSError:
        text = None
    if text is not None:
        parts = re.split(r"^## \[([^\]]+?) s(\d+)\]\s*(.*)$", text, flags=re.M)
        for i in range(1, len(parts), 4):
            n = int(parts[i + 1])
            body = TYPE_LINE.sub("", parts[i + 3]).strip()
            out[n] = {"n": n, "title": parts[i + 2].strip(), "md": body}
            if not d["prepared"]:
                out[n]["raw"] = True
    return [out.get(n, {"n": n, "title": "", "md": ""}) for n in range(1, d["slides"] + 1)]


def slide_image(cdir, tag, n):
    """Path of the slide image (decks/<folder>/sNNN.jpg), or None."""
    d = deck(cdir, tag)
    if not d or not (1 <= n <= d["slides"]):
        return None
    img = deck_dir(cdir, d) / f"s{n:03d}.jpg"
    return img if img.is_file() else None


# ---------------------------------------------------------------- the student's notes (me/notes/)

def class_notes(cdir):
    """me/notes/WeekN/*.md and *.txt: the student's class notes for week N."""
    out = []
    base = notes_dir(cdir)
    weeks = [w for w in base.iterdir() if w.is_dir() and WEEK_RE.match(w.name)] if base.is_dir() else []
    for w in sorted(weeks, key=lambda p: int(WEEK_RE.match(p.name).group(1))):
        n = int(WEEK_RE.match(w.name).group(1))
        for f in sorted(w.glob("*.md")) + sorted(w.glob("*.txt")):
            if f.is_file() and f.stat().st_size > 0:
                out.append({"week": n, "name": f.name, "path": f.relative_to(cdir).as_posix()})
    return out


def _doc_folders(cdir):
    """me/notes/'s folders other than WeekN: exams, labs, assignments first, then any other by name."""
    base = notes_dir(cdir)
    if not base.is_dir():
        return []
    tops = sorted(d for d in base.iterdir() if d.is_dir() and not WEEK_RE.match(d.name) and not d.name.startswith("."))
    return sorted(tops, key=lambda d: (DOC_GROUPS.index(d.name) if d.name in DOC_GROUPS else len(DOC_GROUPS), d.name))


def other_docs(cdir):
    """The student's documents in me/notes/ outside the WeekN folders: each top-level folder is a kind (exams = mocks
    and cheat sheets, labs, assignments, or any other folder's name), each folder inside it a group of its .md files
    (.md files right in the kind's folder make a group with no name); and the voice tutor's notes on the student
    (me/tutor-memory.md)."""
    groups = []
    for top in _doc_folders(cdir):
        loose = sorted(f for f in top.glob("*.md") if f.is_file())
        dirs = [("", loose)] if loose else []
        dirs += [(d.name, sorted(f for f in d.glob("*.md") if f.is_file()))
                 for d in sorted(x for x in top.iterdir() if x.is_dir())]
        for name, files in dirs:
            if files:
                groups.append({"kind": top.name, "name": name,
                               "files": [{"name": f.stem, "path": f.relative_to(cdir).as_posix()} for f in files]})
    memory = me_dir(cdir) / "tutor-memory.md"      # the voice tutor's notes on the student (tutor.py)
    if memory.is_file():
        groups.append({"kind": "tutor", "name": "", "files": [{"name": "What your tutor remembers",
                                                               "path": memory.relative_to(cdir).as_posix()}]})
    return groups


def readable_doc(cdir, path):
    """True only for the class notes, documents and tutor notes listed above (never anything in me/private/)."""
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
    prog = me_dir(cdir) / "progress.md"
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
    books = sorted((cdir / "textbooks").glob("*.toc.md"))
    notes = class_notes(cdir)
    watch = [cdir / COURSE_FILE] + _deck_files(cdir) + books + [cdir / n["path"] for n in notes] + \
            [cdir / d["transcript"] for d in info["decks"].values() if d["transcript"]]
    return _cached(("map", cdir), watch, lambda: _build_map(cdir, info, books, notes))


def _source(d):
    return d["transcript"] or f"decks/{d['folder']}/ (no transcript yet: slide images only)"


def _build_map(cdir, info, books, notes):
    out = [f"# {info['code']} {info['title']}: map of the course material",
           "Paths are relative to the course folder (your working directory).", "",
           "- `CLAUDE.md`: course facts: assessments, format, dates, AI policy",
           "- `me/progress.md`: deadlines (with the weeks each test covers), weak topics, error log", ""]
    for t in info["topics"]:
        out.append(f"## Topic: {t['name']}" + (f" (read more: {t['read_more']})" if t["read_more"] else ""))
        for tag in t["decks"]:
            d = info["decks"][tag]
            titles = " · ".join(f"s{s['n']} {s['title'][:50]}" for s in slide_texts(cdir, tag) if s["title"])
            out.append(f"- [{tag}] W{d['week']} {d['title']}: `{_source(d)}`, {d['slides']} slides")
            out.append(f"    {titles}")
        out.append("")
    if info["practice"]:
        out.append("## Practice: homework and practice exams (questions only, no solutions)")
        for tag in info["practice"]:
            d = info["decks"][tag]
            out.append(f"- [{tag}] W{d['week']} {d['title']}: `{_source(d)}`, {d['slides']} pages")
        out.append("")
    if notes:
        out.append("## The student's own class notes")
        out += [f"- W{n['week']}: `{n['path']}`" for n in notes]
        out.append("")
    if books:
        out.append("## Textbooks (full text in `textbooks/<name>.txt`, page markers `===== <name> PAGE n =====`; "
                   "contents in `<name>.toc.md`: Grep the .txt for a term, or Read the toc first)")
        out += [f"- `{b.relative_to(cdir).as_posix()}`" for b in books]
    extra = [p for g in ("labs", "assignments") if (notes_dir(cdir) / g).is_dir()
             for p in sorted((notes_dir(cdir) / g).rglob("*")) if p.is_file() and p.suffix.lower() in (".md", ".txt")]
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
