"""One-time migration from the earlier library layout to a Tutr library. Copies only: nothing in the old tree is
moved, changed or written.

    python tools/migrate_old_layout.py <old_root> <new_library> [--old-hub <dir>] [--report <file.md>] [--dry-run]
                                       [--overwrite]

The earlier layout (what the hub read before deck.json and course.json):

    <old_root>/CLAUDE.md                          study instructions for Claude Code
    <old_root>/.claude/skills/<skill>/            Claude Code skills
    <old_root>/<course>/                          a course = a folder with a study/ folder
        CLAUDE.md                                 course facts + deck table (Week | Deck | Tag | Topic) + Topics table
        course/WeekN/*.pdf, notes*.md|txt         lecture decks as downloaded, the student's class notes
        course/practice/*.pdf                     homework and practice exams
        course/<anything else>                    other downloads
        resources/*                               textbooks
        study/progress.md, hub-state.json, tutor-memory.md, slides/<tag>-sNNN.jpg, exams/<a>/*
        .cache/WeekN|practice/<stem>.transcript.md, .cache/textbooks/, .cache/uploads/, .cache/exams/<a>/*-key.md
        <other folders>                           labs, assignments, projects, ... (each kept whole)
    <old_hub>/.cache/chats/*.json, practice/*.json, drafts.json   the hub's runtime data, all courses mixed
                                                  (<old_hub> defaults to the folder under <old_root>, at most two levels down, that holds the hub's library.py and tutor.py)

The new layout (see library.py):

    <new_library>/CLAUDE.md, .claude/skills/<skill>/  (this repo's preparing-slides skill replaces the old one)
    <new_library>/<course>/
        CLAUDE.md                                 the old one without the deck table
        course.json                               code, title (from the folder name, as the old hub derived them),
                                                  assessment_style (the old hub's tutor.py STYLE[code]), topics
        sources/WeekN/, sources/practice/, sources/<other downloads>, sources/textbooks/
        decks/<safe tag>/deck.json, transcript.md, sNNN.jpg
        textbooks/                                from .cache/textbooks/
        me/progress.md, hub-state.json, tutor-memory.md, <other study/ files>
        me/notes/WeekN/ (class notes), me/notes/exams/<a>/, me/notes/<other folder>/ (labs, assignments, ...)
        me/private/exams/<a>/                     answer keys (never shown by the hub)
        me/uploads/, me/chats/, me/practice/, me/drafts.json
        .work/old-cache/, .work/old-slides/       the old caches (PNGs, scratch, audits, manifests) and slide images
                                                  that belong to no deck

Every deck.json holds exactly what the old hub computed on each load (tag, title, week, topic, order, page count);
`prepared` is true iff the deck had a transcript. A deck without a transcript, or with slide images missing, goes
through the preparing-slides Add stage (rough text-layer transcript and/or rendered images), which is what the old
hub showed for it. Upload paths stored in chats, practice records and drafts are rewritten to me/uploads/.

The report lists every source file (sha1, where it went), every chat/practice/draft record and the course it was
filed under, and everything skipped with the reason. Every plain copy is re-hashed at the end.
"""
import argparse, ast, datetime as dt, hashlib, json, os, re, shutil, sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SKILL = REPO / ".claude" / "skills" / "preparing-slides"
SKIP_DIRS = {".venv", "venv", "node_modules", "__pycache__", ".git", ".ipynb_checkpoints"}
WEEK_RE = re.compile(r"^Week(\d+)$", re.I)
NOTES_RE = re.compile(r"^notes.*\.(md|txt)$", re.I)
SLIDE_RE = re.compile(r"^(.+)-s(\d{3,})\.jpg$", re.I)    # <safe tag>-sNNN.jpg, the old hub's f"-s{n:03d}" form
PRACTICE = "practice"
PRACTICE_TOPIC = "Practice"     # the old hub's name for the practice list (a topic cell "Practice" meant: practice)
UNSORTED = "Unsorted"           # deck.json topic of an unsorted lecture deck (the hub shows "Not sorted yet")
OLD_UNSORTED = "Not sorted yet"
STUDY_TO_ME = ("progress.md", "hub-state.json", "tutor-memory.md")


class MigrationError(Exception):
    pass


def safe_tag(tag):
    return re.sub(r"[^A-Za-z0-9-]", "", tag)


def sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def page_count(pdf):
    """The PDF's page count, or None when it can't be read (the caller reports it as a problem: a page count is
    frozen into deck.json, so it must never silently become 0)."""
    import fitz          # migrate() has checked that PyMuPDF is installed
    try:
        with fitz.open(pdf) as d:
            return d.page_count
    except Exception:
        return None


def md_tables(text):
    """Every Markdown table in `text`, as (header cells, rows of cells, first line index, last line index)."""
    tables, cur = [], None
    lines = text.splitlines()
    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith("|"):
            cells = [c.strip() for c in s.strip("|").split("|")]
            if cur is None:
                cur = [cells, [], i, i]
            else:
                cur[3] = i
                if not all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
                    cur[1].append(cells)
        elif cur is not None:
            tables.append(cur)
            cur = None
    if cur is not None:
        tables.append(cur)
    return tables


def is_deck_table(head):
    return [c.lower() for c in head][:3] == ["week", "deck", "tag"]


def is_topics_table(head):
    return [c.lower() for c in head][:2] == ["topic", "read more"]


def course_meta(name):
    """(code, title) from a course folder name, as the old hub derived them."""
    m = re.match(r"^([A-Za-z]+)-?(\d+)_?(.*)$", name)
    return (f"{m.group(1).upper()}{m.group(2)}", m.group(3).replace("_", " ")) if m else (name, name)


def old_styles(old_hub):
    """The old hub's tutor.py STYLE dict (course code -> assessment style), read without running the code."""
    f = Path(old_hub) / "tutor.py"
    try:
        tree = ast.parse(f.read_text(encoding="utf-8"))
    except (OSError, SyntaxError, ValueError):
        return {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "STYLE" for t in node.targets):
            try:
                v = ast.literal_eval(node.value)
            except ValueError:
                return {}
            return {str(k): str(s) for k, s in v.items()} if isinstance(v, dict) else {}
    return {}


def strip_deck_table(text):
    """The course CLAUDE.md without its deck table (Week | Deck | Tag | Topic). Where a table sat between two blank
    lines, one of them goes too; nothing else in the file changes."""
    lines = text.splitlines(keepends=True)
    blank = lambda i: 0 <= i < len(lines) and not lines[i].strip()
    drop = set()
    for head, _, a, b in md_tables(text):
        if is_deck_table(head):
            drop.update(range(a, b + 1))
            if blank(a - 1) and blank(b + 1):
                drop.add(b + 1)
    return "".join(l for i, l in enumerate(lines) if i not in drop) if drop else text


# ---------------------------------------------------------------- the old hub's deck derivation

def old_pdfs(cdir):
    """(week, pdf) for every deck PDF, as the old hub found them: course/WeekN/*.pdf, then course/practice/*.pdf at
    the latest lecture week."""
    out = []
    base = cdir / "course"
    if base.is_dir():
        for w in base.iterdir():
            m = WEEK_RE.match(w.name)
            if w.is_dir() and m:
                out += [(int(m.group(1)), p) for p in sorted(w.glob("*.pdf"))]
    last = max((w for w, _ in out), default=0)
    out += [(last, p) for p in sorted((base / PRACTICE).glob("*.pdf"))]
    return sorted(out, key=lambda x: (x[0], x[1].name))


def old_decks(cdir, text):
    """The decks the old hub showed, with the exact values it computed. Returns (decks, hidden, read_more):
    decks = [dict(tag, stem, week, topic, order, pdf, transcript, practice_dir)] (topic = the old hub's topic:
    a table cell, "Practice" or OLD_UNSORTED); hidden = decks replaced by a later one with the same tag."""
    rows, read_more = [], {}
    for head, body, _, _ in md_tables(text):
        if is_deck_table(head):
            for r in body:
                tag = re.findall(r"`([^`]+)`", r[2]) if len(r) > 2 else []
                if tag:
                    rows.append((r[0], r[1], tag[0], r[3] if len(r) > 3 and r[3] else OLD_UNSORTED))
        elif is_topics_table(head):
            for r in body:
                if len(r) > 1:
                    read_more[r[0]] = r[1]
    by_stem = {p.stem: (w, p) for w, p in old_pdfs(cdir)}
    found, order = [], 0

    def make(tag, week, pdf, topic):
        tr = cdir / ".cache" / pdf.parent.name / f"{pdf.stem}.transcript.md"
        return {"tag": tag, "stem": pdf.stem, "week": week, "topic": topic, "order": order, "pdf": pdf,
                "transcript": tr if tr.exists() else None, "practice_dir": pdf.parent.name == PRACTICE}

    for wk, stem, tag, topic in rows:
        if stem not in by_stem:
            continue
        w, pdf = by_stem.pop(stem)
        if pdf.parent.name == PRACTICE:
            topic = PRACTICE_TOPIC
            if re.match(r"\d+", wk):
                w = int(re.match(r"\d+", wk).group())
        found.append(make(tag, w, pdf, topic))
        order += 1
    for stem, (w, pdf) in sorted(by_stem.items(), key=lambda x: (x[1][0], x[0])):
        if stem.lower().startswith("notes"):
            continue
        found.append(make(stem.replace("_", "-"), w, pdf, PRACTICE_TOPIC if pdf.parent.name == PRACTICE else OLD_UNSORTED))
        order += 1
    decks, hidden = {}, []
    for d in found:                      # the old hub kept the last deck of a tag
        if d["tag"] in decks:
            hidden.append(decks[d["tag"]])
        decks[d["tag"]] = d
    return list(decks.values()), hidden, read_more


def deck_json(d, pages, source):
    title = ""
    if d["transcript"]:
        m = re.search(r"^## \[[^\]]+ s1\]\s*(.*)$", d["transcript"].read_text(encoding="utf-8"), re.M)
        title = m.group(1).strip() if m else ""
    practice = d["topic"] == PRACTICE_TOPIC
    topic = "" if practice else (UNSORTED if d["topic"] == OLD_UNSORTED else d["topic"])
    return {"tag": d["tag"], "title": title or d["stem"].replace("_", " ").replace("-", " "),
            "role": PRACTICE if practice else "lecture", "week": d["week"], "topic": topic, "order": d["order"],
            "pages": pages, "prepared": d["transcript"] is not None, "source": source}


# ---------------------------------------------------------------- planning

def walk(base, skipped, label):
    """Files under `base` (sorted), skipping SKIP_DIRS; each skipped folder is recorded with its file count."""
    out = []
    for root, dirs, files in os.walk(base):
        keep = []
        for d in sorted(dirs):
            if d in SKIP_DIRS:
                p = Path(root) / d
                n = sum(len(f) for _, _, f in os.walk(p))
                skipped.append({"path": f"{label}/{p.relative_to(base).as_posix()}/", "files": n,
                                "reason": f"'{d}' folders are never copied (environments, caches, VCS data)"})
            else:
                keep.append(d)
        dirs[:] = keep
        out += [Path(root) / f for f in sorted(files)]
    return sorted(out)


class Plan:
    def __init__(self, old_root, new_lib, old_hub):
        self.old, self.new, self.hub = old_root, new_lib, old_hub
        self.files = []        # {src, rel(label), dest, kind: copy|transform|split|skip, note, sha1}
        self.skipped = []      # skipped folders / entries
        self.writes = []       # generated files: (dest, text)
        self.courses = []      # per course summary
        self.records = []      # chats / practice / drafts records: {kind, file, course, dest, rewritten}
        self.decks = {}        # course -> [deck rows]
        self.add_jobs = []     # (course name, deck folder, deck.json, pdf dest, old images [(src, dest)], reason)
        self.notes = []
        self.problems = []     # found while planning (e.g. an unreadable PDF): the run reports FAIL

    def file(self, src, label, dest, kind="copy", note=""):
        self.files.append({"src": src, "rel": label, "dest": dest, "kind": kind, "note": note})


def plan_course(P, cdir, styles):
    name = cdir.name
    ncd = P.new / name
    label = name
    text = ""
    if (cdir / "CLAUDE.md").is_file():
        with open(cdir / "CLAUDE.md", encoding="utf-8", newline="") as fh:     # keep its line endings as they are
            text = fh.read()
    code, title = course_meta(name)
    decks, hidden, read_more = old_decks(cdir, text)
    P.writes.append((ncd / "course.json", json.dumps(
        {"code": code, "title": title, "assessment_style": styles.get(code, ""),
         "topics": [{"name": n, "read_more": r} for n, r in read_more.items()]}, indent=2, ensure_ascii=False) + "\n"))

    # Decks: folder per safe tag; a second tag with the same folder name can't be stored
    by_folder = {}
    for d in sorted(decks, key=lambda d: (d["week"], d["order"])):
        f = safe_tag(d["tag"])
        if not f or f in by_folder:
            P.notes.append(f"{name}: deck {d['tag']!r} ({d['pdf'].name}) not migrated as a deck: its folder name "
                           f"{f!r} is empty or already used by {by_folder.get(f, {}).get('tag')!r}")
            continue
        by_folder[f] = d
    for d in hidden:
        P.notes.append(f"{name}: {d['pdf'].relative_to(cdir).as_posix()} was hidden in the old hub (tag "
                       f"{d['tag']!r} reused by a later deck table row); its PDF is kept in sources/, no deck")

    def src_dest(p):         # course/<rest> -> sources/<rest>
        parts = p.relative_to(cdir / "course").parts
        if parts[0].lower() == PRACTICE:
            parts = (PRACTICE,) + parts[1:]
        return ncd / "sources" / Path(*parts)

    transcripts = {d["transcript"]: f for f, d in by_folder.items() if d["transcript"]}
    slide_map = {}
    for f, d in by_folder.items():
        pages = page_count(d["pdf"])
        if pages is None:
            P.problems.append(f"{name}: {d['pdf'].relative_to(cdir).as_posix()} (deck {d['tag']!r}) could not be read "
                              "with PyMuPDF: its page count is unknown (written as 0, no images, no Add stage)")
            d["unreadable"], pages = True, 0
        source = src_dest(d["pdf"]).relative_to(ncd).as_posix()
        j = deck_json(d, pages, source)
        d["json"], d["pages"] = j, pages
        slide_map[f] = pages
    images = {f: [] for f in by_folder}

    # Every file of the course
    for src in walk(cdir, P.skipped, label):
        r = src.relative_to(cdir)
        p = r.parts
        lab = f"{label}/{r.as_posix()}"
        if p == ("CLAUDE.md",):
            P.file(src, lab, ncd / "CLAUDE.md", "transform", "deck table removed (now in each deck.json)")
            P.writes.append((ncd / "CLAUDE.md", strip_deck_table(text)))
        elif p[0] == "course" and len(p) > 1:
            if len(p) == 3 and WEEK_RE.match(p[1]) and NOTES_RE.match(p[2]):
                P.file(src, lab, ncd / "me" / "notes" / p[1] / p[2])
            else:
                P.file(src, lab, src_dest(src))
        elif p[0] == "resources" and len(p) > 1:
            P.file(src, lab, ncd / "sources" / "textbooks" / Path(*p[1:]))
        elif p[0] == ".cache" and len(p) > 1:
            if src in transcripts:
                P.file(src, lab, ncd / "decks" / transcripts[src] / "transcript.md")
            elif p[1] == "textbooks" and len(p) > 2:
                P.file(src, lab, ncd / "textbooks" / Path(*p[2:]))
            elif p[1] == "uploads" and len(p) > 2:
                P.file(src, lab, ncd / "me" / "uploads" / Path(*p[2:]))
            elif p[1] == "exams" and len(p) > 2:
                P.file(src, lab, ncd / "me" / "private" / "exams" / Path(*p[2:]))
            else:
                P.file(src, lab, ncd / ".work" / "old-cache" / Path(*p[1:]))
        elif p[0] == "study" and len(p) > 1:
            m = SLIDE_RE.match(p[2]) if len(p) == 3 and p[1] == "slides" else None
            if m and m.group(2) == f"{int(m.group(2)):03d}" and m.group(1) in by_folder \
                    and 1 <= int(m.group(2)) <= slide_map[m.group(1)]:
                dest = ncd / "decks" / m.group(1) / f"s{int(m.group(2)):03d}.jpg"
                images[m.group(1)].append((src, dest))
                P.file(src, lab, dest)
            elif p[1] == "slides":
                P.file(src, lab, ncd / ".work" / "old-slides" / Path(*p[2:]), note="slide image of no deck")
            elif p[1] == "exams" and len(p) > 2:
                P.file(src, lab, ncd / "me" / "notes" / "exams" / Path(*p[2:]))
            else:
                P.file(src, lab, ncd / "me" / Path(*p[1:]))
        elif len(p) == 1:
            P.file(src, lab, ncd / "me" / p[0])
        else:
            P.file(src, lab, ncd / "me" / "notes" / r)

    rows = []
    for f, d in sorted(by_folder.items(), key=lambda x: (x[1]["week"], x[1]["order"])):
        j = d["json"]
        P.writes.append((ncd / "decks" / f / "deck.json", json.dumps(j, indent=2, ensure_ascii=False) + "\n"))
        have = {int(SLIDE_RE.match(s.name).group(2)) for s, _ in images[f]}
        missing = [n for n in range(1, d["pages"] + 1) if n not in have]
        how = "copied"
        if d.get("unreadable"):
            how = "**PDF unreadable**: page count unknown, no Add"
        elif d["pages"] == 0:
            how = "PDF has 0 pages: no images, no Add"
        elif not d["transcript"]:
            how = "Add stage (rough transcript" + (", old images kept)" if have else ", rendered images)")
            P.add_jobs.append((ncd, f, j, ncd / j["source"], images[f], "no transcript"))
        elif missing:
            how = f"copied; Add stage rendered {len(missing)} missing image(s)"
            P.add_jobs.append((ncd, f, j, ncd / j["source"], images[f], "missing images"))
        rows.append(dict(j, folder=f, how=how, images=len(have)))
    P.decks[name] = rows
    P.courses.append({"name": name, "code": code, "title": title, "style": bool(styles.get(code)),
                      "topics": len(read_more), "decks": len(rows)})


def rewrite_uploads(obj):
    """Upload paths (.cache/uploads/<x>) stored in a record -> me/uploads/<x>. Returns (new obj, count)."""
    n = 0

    def go(o):
        nonlocal n
        if isinstance(o, dict):
            return {k: go(v) for k, v in o.items()}
        if isinstance(o, list):
            return [go(v) for v in o]
        if isinstance(o, str) and o.startswith(".cache/uploads/"):
            n += 1
            return "me/uploads/" + o[len(".cache/uploads/"):]
        return o
    return go(obj), n


def dump_like(src_bytes, obj):
    text = json.dumps(obj, ensure_ascii=False, indent=1)
    return text.replace("\n", "\r\n") if b"\r\n" in src_bytes else text


def plan_hub(P, course_names):
    cache = P.hub / ".cache"
    if not cache.is_dir():
        P.notes.append(f"no old hub data at {cache}")
        return
    for kind in ("chats", "practice"):
        for src in sorted((cache / kind).glob("*")) if (cache / kind).is_dir() else []:
            lab = f"<old-hub>/.cache/{kind}/{src.name}"
            if src.is_dir():
                P.skipped.append({"path": lab + "/", "files": sum(len(f) for _, _, f in os.walk(src)),
                                  "reason": "unexpected folder in the hub's record folder"})
                continue
            raw = src.read_bytes()
            try:
                rec = json.loads(raw.decode("utf-8"))
                course = rec.get("course") if isinstance(rec, dict) else None
            except ValueError:
                rec, course = None, None
            n = 0
            if course in course_names:
                dest = P.new / course / "me" / kind / src.name
                new, n = rewrite_uploads(rec)
                if n:
                    P.file(src, lab, dest, "transform", f"{n} upload path(s) rewritten to me/uploads/")
                    P.writes.append((dest, dump_like(raw, new)))
                else:
                    P.file(src, lab, dest)
            else:
                dest = P.new / "_unassigned" / kind / src.name
                P.file(src, lab, dest, note=f"course {course!r} is not a migrated course")
            P.records.append({"kind": kind, "file": src.name, "course": course if course in course_names else None,
                              "dest": dest, "uploads": n})
    df = cache / "drafts.json"
    if df.is_file():
        raw = df.read_bytes()
        try:
            data = json.loads(raw.decode("utf-8"))
        except ValueError:
            data = None
        if not isinstance(data, dict):
            P.problems.append("<old-hub>/.cache/drafts.json is not a readable {course: draft} file: not migrated")
        dests = []
        for course, d in (data.items() if isinstance(data, dict) else []):
            new, n = rewrite_uploads(d)
            dest = (P.new / course / "me" / "drafts.json") if course in course_names else \
                (P.new / "_unassigned" / "drafts" / f"{safe_tag(course) or 'draft'}.json")
            P.writes.append((dest, dump_like(raw, {course: new})))
            dests.append(dest)
            P.records.append({"kind": "drafts", "file": f"drafts.json[{course}]",
                              "course": course if course in course_names else None, "dest": dest, "uploads": n})
        P.file(df, "<old-hub>/.cache/drafts.json", dests, "split",
               "one {course: draft} file per course" if isinstance(data, dict) else "unreadable: not migrated")
    for e in sorted(cache.iterdir()):
        if e.name not in ("chats", "practice", "drafts.json"):
            n = sum(len(f) for _, _, f in os.walk(e)) if e.is_dir() else 1
            P.skipped.append({"path": f"<old-hub>/.cache/{e.name}" + ("/" if e.is_dir() else ""), "files": n,
                              "reason": "machine data (logs, prompts, models): stays with the hub, not personal"})


def plan_root(P, course_names):
    cm = P.old / "CLAUDE.md"
    if cm.is_file():
        P.file(cm, "CLAUDE.md", P.new / "CLAUDE.md", note="copied as is (to be adapted to the new layout)")
    skills = P.old / ".claude" / "skills"
    for sk in sorted(skills.iterdir()) if skills.is_dir() else []:
        if sk.name == SKILL.name:
            n = sum(len(f) for _, _, f in os.walk(sk))
            P.skipped.append({"path": f".claude/skills/{sk.name}/", "files": n,
                              "reason": "replaced by this repo's copy of the skill (new layout)"})
            continue
        if sk.is_dir():
            for src in walk(sk, P.skipped, f".claude/skills/{sk.name}"):
                P.file(src, f".claude/skills/{sk.name}/{src.relative_to(sk).as_posix()}",
                       P.new / ".claude" / "skills" / sk.name / src.relative_to(sk))
        else:
            P.skipped.append({"path": f".claude/skills/{sk.name}", "files": 1,
                              "reason": "a loose file in .claude/skills/ (skills are folders)"})
    if SKILL.is_dir():
        for src in walk(SKILL, [], "<repo-skill>"):
            P.file(src, f"<this repo>/.claude/skills/{SKILL.name}/{src.relative_to(SKILL).as_posix()}",
                   P.new / ".claude" / "skills" / SKILL.name / src.relative_to(SKILL))
    hub = P.hub.resolve()
    for e in sorted(P.old.iterdir()):
        if e.name in course_names or e.name in ("CLAUDE.md",):
            continue
        if e.name == ".claude":
            others = [x.name for x in e.iterdir() if x.name != "skills"]
            if others:
                P.skipped.append({"path": ".claude/ (" + ", ".join(sorted(others)) + ")", "files": None,
                                  "reason": "only .claude/skills is migrated"})
            continue
        what = "the old hub's code and runtime data (records migrated above)" if hub.is_relative_to(e.resolve()) \
            else "not a course (no study/ folder) and not part of the library"
        P.skipped.append({"path": e.name + ("/" if e.is_dir() else ""), "files": None, "reason": what})


# ---------------------------------------------------------------- doing it

def run_add(jobs):
    sys.path.insert(0, str(SKILL / "scripts"))
    from add import add, AddError
    out = []
    for ncd, folder, j, pdf, images, why in jobs:
        try:
            status, _ = add(ncd, pdf, tag=j["tag"], title=j["title"], week=j["week"], order=j["order"],
                            role=j["role"], topic=j["topic"] if j["role"] != PRACTICE else None)
        except Exception as e:            # AddError, or e.g. a render error: report it, carry on, let verify see it
            status = f"FAILED: {type(e).__name__}: {e}"
        for src, dest in images:          # the old prepared images are what the old hub showed: keep them
            shutil.copy2(src, dest)
        out.append(f"{ncd.name}/decks/{folder}: {why}: {status}")
    return out


def execute(P):
    for f in P.files:
        f["sha1"] = sha1(f["src"])
        if f["kind"] == "copy":
            f["dest"].parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f["src"], f["dest"])
    for dest, text in P.writes:
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
    return run_add(P.add_jobs) if P.add_jobs else []


def verify(P):
    bad = []
    for f in P.files:
        if f["kind"] == "copy":
            if not f["dest"].is_file() or sha1(f["dest"]) != f["sha1"]:
                bad.append(f"{f['rel']} -> {f['dest']}: copy missing or different")
        elif f["kind"] in ("transform", "split"):
            for d in (f["dest"] if isinstance(f["dest"], list) else [f["dest"]]):
                if not d.is_file():
                    bad.append(f"{f['rel']} -> {d}: not written")
    dests = {}
    for f in P.files:
        for d in (f["dest"] if isinstance(f["dest"], list) else [f["dest"]]):
            dests.setdefault(str(d).lower(), []).append(f["rel"])
    bad += [f"{d}: written from {len(s)} sources: {s}" for d, s in dests.items() if len(s) > 1 and not d.endswith("drafts.json")]
    for course, rows in P.decks.items():
        for r in rows:
            folder = P.new / course / "decks" / r["folder"]
            j = json.loads((folder / "deck.json").read_text(encoding="utf-8"))
            if any(j.get(k) != r[k] for k in ("tag", "title", "role", "week", "topic", "order", "pages")):
                bad.append(f"{course}/decks/{r['folder']}/deck.json: fields changed after writing")
            if r["pages"] and not all((folder / f"s{n:03d}.jpg").is_file() for n in range(1, r["pages"] + 1)):
                bad.append(f"{course}/decks/{r['folder']}: slide images incomplete")
            if not (folder / "transcript.md").is_file() and r["pages"]:
                bad.append(f"{course}/decks/{r['folder']}: no transcript")
    return bad


def report(P, add_log, problems, dry, clash=(), overwrite=False):
    rel = lambda d: (Path(d).relative_to(P.new).as_posix() if Path(d).is_relative_to(P.new) else str(d))
    L = [f"# Migration report", "", f"- Date: {dt.datetime.now():%Y-%m-%d %H:%M}", f"- From: `{P.old}`",
         f"- Old hub: `{P.hub}`", f"- To: `{P.new}`", f"- Mode: {'DRY RUN (nothing written)' if dry else 'copied'}", ""]
    n_copy = sum(f["kind"] == "copy" for f in P.files)
    n_tr = sum(f["kind"] in ("transform", "split") for f in P.files)
    L += ["## Summary", "", f"- Source files accounted for: **{len(P.files)}** ({n_copy} copied byte for byte, "
          f"{n_tr} transformed or split)",
          f"- Skipped entries: {len(P.skipped)} (listed below with the reason)",
          f"- Records: " + ", ".join(f"{k} {sum(r['kind'] == k for r in P.records)}" for k in ("chats", "practice", "drafts")),
          f"- Records filed in no course: {sum(r['course'] is None for r in P.records)}",
          f"- Verification: " + (("not run (dry run)" + (f"; **{len(problems)} problem(s) found while planning**"
                                                          if problems else "")) if dry else
                                 ("**OK** (every copy re-hashed, every deck complete)" if not problems
                                  else f"**FAIL: {len(problems)} problem(s)**")),
          ""]
    if problems:
        L += ["## Problems", ""] + [f"- {p}" for p in problems] + [""]
    if clash:
        head = "Overwritten (--overwrite)" if overwrite else "Would be overwritten (a real run refuses without --overwrite)"
        L += [f"## {head}: {len(clash)} existing path(s)", ""] + [f"- `{c}`" for c in clash] + [""]
    if P.notes:
        L += ["## Notes", ""] + [f"- {n}" for n in P.notes] + [""]
    L += ["## Courses", "", "| Course | code | title | style | topics | decks |", "|---|---|---|---|---|---|"]
    L += [f"| {c['name']} | {c['code']} | {c['title']} | {'yes' if c['style'] else 'no'} | {c['topics']} | {c['decks']} |"
          for c in P.courses] + [""]
    for course, rows in P.decks.items():
        L += [f"### Decks: {course}", "", "| tag | folder | role | week | topic | order | pages | prepared | images | title | how |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
        L += [f"| {r['tag']} | {r['folder']} | {r['role']} | {r['week']} | {r['topic']} | {r['order']} | {r['pages']} | "
              f"{str(r['prepared']).lower()} | {r['images']} | {r['title']} | {r['how']} |" for r in rows] + [""]
    if add_log:
        L += ["## Add stage", ""] + [f"- {a}" for a in add_log] + [""]
    L += ["## Where things went (count by destination area)", ""]
    areas = {}
    for f in P.files:
        for d in (f["dest"] if isinstance(f["dest"], list) else [f["dest"]]):
            r = rel(d).split("/")
            key = "/".join(r[:3]) if r[0] not in ("CLAUDE.md",) else r[0]
            if len(r) > 1 and r[1] in ("decks",):
                key = f"{r[0]}/decks"
            areas[key] = areas.get(key, 0) + 1
    L += ["| destination | files |", "|---|---|"] + [f"| `{k}` | {v} |" for k, v in sorted(areas.items())] + [""]
    L += ["## Records (chats, practice, drafts)", "", "| kind | record | course | destination | upload paths rewritten |",
          "|---|---|---|---|---|"]
    L += [f"| {r['kind']} | {r['file']} | {r['course'] or '**none**'} | `{rel(r['dest'])}` | {r['uploads']} |"
          for r in P.records] + [""]
    L += ["## Skipped", "", "| path | files | reason |", "|---|---|---|"]
    L += [f"| `{s['path']}` | {'' if s['files'] is None else s['files']} | {s['reason']} |" for s in P.skipped] + [""]
    L += ["## Every source file", "", "| source | sha1 | how | destination | note |", "|---|---|---|---|---|"]
    for f in P.files:
        d = f["dest"] if isinstance(f["dest"], list) else [f["dest"]]
        L.append(f"| `{f['rel']}` | {f.get('sha1', '')[:12]} | {f['kind']} | " + ", ".join(f"`{rel(x)}`" for x in d) +
                 f" | {f['note']} |")
    return "\n".join(L) + "\n"


def planned_paths(P, rp):
    """Every path the run would write: copies, generated files, Add-stage deck folders, the report."""
    out = []
    for f in P.files:
        out += f["dest"] if isinstance(f["dest"], list) else [f["dest"]]
    out += [d for d, _ in P.writes]
    out += [ncd / "decks" / folder for ncd, folder, _, _, _, _ in P.add_jobs]
    out += [ncd / ".work" for ncd, _, _, _, _, _ in P.add_jobs]     # the Add stage may keep files there
    if rp:
        out.append(rp)
    return sorted(set(out))


def find_old_hub(old):
    """The earlier hub's code folder inside the old tree (holds library.py and tutor.py), or the old tree itself."""
    for pattern in ("library.py", "*/library.py", "*/*/library.py"):
        for f in sorted(old.glob(pattern)):
            if (f.parent / "tutor.py").is_file():
                return f.parent.resolve()
    return old


def migrate(old_root, new_lib, old_hub=None, dry_run=False, report_path=None, overwrite=False):
    try:
        import fitz  # noqa: F401  (page counts are frozen into deck.json: never guess them)
    except ImportError:
        raise MigrationError("PyMuPDF is required (pip install pymupdf): page counts come from the PDFs")
    old, new = Path(old_root).resolve(), Path(new_lib).resolve()
    hub = Path(old_hub).resolve() if old_hub else find_old_hub(old)
    rp = Path(report_path).resolve() if report_path else (None if dry_run else new / "migration-report.md")
    if not old.is_dir():
        raise MigrationError(f"no old tree at {old}")
    if new == old or new.is_relative_to(old) or old.is_relative_to(new):
        raise MigrationError("the new library must be outside the old tree (and not contain it)")
    if rp and rp.is_relative_to(old):
        raise MigrationError("the report can't be written inside the old tree")
    courses = sorted(p for p in old.iterdir() if p.is_dir() and (p / "study").is_dir())
    if not courses:
        raise MigrationError(f"no course folders (folders with a study/ folder) in {old}")
    names = {c.name for c in courses}
    P = Plan(old, new, hub)
    styles = old_styles(hub)
    for c in courses:
        plan_course(P, c, styles)
    plan_hub(P, names)
    plan_root(P, names)

    # Before anything is written: every output must lie outside the old tree, and nothing may be overwritten
    # unless asked for.
    paths = planned_paths(P, rp)
    inside = [x for x in paths if x.resolve().is_relative_to(old)]
    if inside:
        raise MigrationError(f"{len(inside)} output path(s) would be inside the old tree, e.g. {inside[0]}")
    clash = sorted({str(x) for x in paths if x.exists() and x.resolve().is_relative_to(new)} |
                   {str(new / n) for n in sorted(names) + ["_unassigned"] if (new / n).exists()})
    if clash and not overwrite and not dry_run:
        shown = "\n  ".join(clash[:20]) + (f"\n  ... and {len(clash) - 20} more" if len(clash) > 20 else "")
        raise MigrationError(f"{len(clash)} path(s) already exist in {new} and would be overwritten:\n  {shown}\n"
                             "migrate into an empty library, or pass --overwrite (run --dry-run --report to see all)")

    problems = list(P.problems)
    if dry_run:
        for f in P.files:
            f["sha1"] = sha1(f["src"])
        add_log = [f"{ncd.name}/decks/{folder}: {why}: would run the Add stage" for ncd, folder, _, _, _, why in P.add_jobs]
    else:
        new.mkdir(parents=True, exist_ok=True)
        add_log = execute(P)
        problems += verify(P)
        problems += [f"Add stage: {a}" for a in add_log if ": FAILED: " in a]
    text = report(P, add_log, problems, dry_run, clash, overwrite)
    if rp:
        rp.parent.mkdir(parents=True, exist_ok=True)
        rp.write_text(text, encoding="utf-8")
    return P, problems, rp, text


def main():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("old_root", help="the library in the earlier layout (read only)")
    ap.add_argument("new_library", help="the library to create (nothing it would write may exist yet, unless --overwrite)")
    ap.add_argument("--old-hub", help="the earlier hub's code folder (default: found under <old_root>)")
    ap.add_argument("--report", help="where to write the report (default: <new_library>/migration-report.md)")
    ap.add_argument("--dry-run", action="store_true",
                    help="plan and report only; write nothing but --report (no --report: the report is printed)")
    ap.add_argument("--overwrite", action="store_true",
                    help="allow replacing files that already exist in the new library (listed in the report)")
    a = ap.parse_args()
    try:
        P, problems, rp, text = migrate(a.old_root, a.new_library, a.old_hub, a.dry_run, a.report, a.overwrite)
    except MigrationError as e:
        sys.exit(f"migrate: {e}")
    for c in P.courses:
        print(f"{c['name']}: {c['decks']} decks, {c['topics']} topics, style {'yes' if c['style'] else 'no'}")
    print(f"{len(P.files)} source files accounted for, {len(P.skipped)} skipped entries, {len(P.records)} records, "
          f"{sum(r['course'] is None for r in P.records)} in no course")
    if a.dry_run and not rp:
        print(text)
    print(("dry run: nothing written" + (f"; {len(problems)} PROBLEM(S) found while planning" if problems else ""))
          if a.dry_run else ("verification OK" if not problems else f"verification FAIL: {len(problems)} problem(s)"))
    if rp:
        print(f"report: {rp}")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
