"""Study Hub: a local reader for every course's study files, with an Ask panel.

    python server.py            # http://127.0.0.1:8765, this machine only
    python server.py --open     # also opens the browser
    python server.py --lan      # also reachable from phones on the same network

Nothing is configured per course. Any top-level folder with a `study/` subfolder is a
course; weeks are the union of `course/WeekN/` and `study/weeks/WeekN/`. New files show
up on the next page load.

The Ask panel shells out to the `claude` CLI (the Claude Code login on this machine;
no API key). Slide context comes from `<course>/.cache/WeekN/<deck>.transcript.md` when
present, otherwise from the PDF's text layer, extracted once and re-extracted if the PDF
changes. The log records timing and cost only, never question text.
"""
import argparse, hashlib, http.server, json, os, re, socketserver, subprocess, sys, threading, time, webbrowser
from pathlib import Path
from urllib.parse import urlparse, parse_qs

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("STUDY_HUB_ROOT") or HERE.parent.parent).resolve()
STATIC = HERE / "static"
WORK = HERE / ".cache"
ASK_MAX_TURNS = 25    # tool calls Claude may make while looking things up for one answer
ASK_TIMEOUT = 420     # seconds before a question gives up
# Models the Ask panel offers (id -> label). The first is the default unless STUDY_HUB_MODEL names another.
MODELS = {
    "claude-opus-5-5": "Opus 5.5 — best answers, highest cost",
    "claude-sonnet-5-5": "Sonnet 5.5 — balanced",
    "claude-haiku-4-5": "Haiku 4.5 — fastest, cheapest",
}
MODEL = os.environ.get("STUDY_HUB_MODEL", "claude-opus-5-5")

WEEK_RE = re.compile(r"^Week(\d+)$", re.I)
LOCK = threading.Lock()


# ---------------------------------------------------------------- discovery

def course_dirs():
    return sorted(p for p in ROOT.iterdir() if p.is_dir() and (p / "study").is_dir())


def course_meta(cdir):
    m = re.match(r"^([A-Za-z]+)-?(\d+)_?(.*)$", cdir.name)
    code = f"{m.group(1).upper()}{m.group(2)}" if m else cdir.name
    title = m.group(3).replace("_", " ") if m else cdir.name
    return code, title


def rel(p):
    return p.resolve().relative_to(ROOT).as_posix()


def week_num(name):
    m = WEEK_RE.match(name)
    return int(m.group(1)) if m else None


def md_title(path):
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if line.startswith("# "):
                    return line[2:].strip()
    except OSError:
        pass
    return path.stem


def deck_tags(cdir):
    """Map citation tags to PDFs using the course CLAUDE.md 'Deck tags' table,
    plus a fallback where tag 'U1-2' matches a PDF named 'U1_2.pdf'."""
    tags = {}
    pdfs = {p.stem: p for p in (cdir / "course").rglob("*.pdf")}
    cm = cdir / "CLAUDE.md"
    if cm.exists():
        for line in cm.read_text(encoding="utf-8").splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) < 3 or "`" not in cells[-1]:
                continue
            deck, tagcell = cells[-2], cells[-1]
            found = re.findall(r"`([^`]+)`", tagcell)
            rng = re.match(r"^(.*?)(\d+)\s*(?:…|\.\.\.)\s*(\d+)$", deck)
            if rng and len(found) == 2:
                tm = re.match(r"^(.*?)(\d+)$", found[0])
                if tm:
                    for i in range(int(rng.group(2)), int(rng.group(3)) + 1):
                        stem = f"{rng.group(1)}{i}"
                        if stem in pdfs:
                            tags[f"{tm.group(1)}{i}"] = rel(pdfs[stem])
                continue
            if found and deck in pdfs:
                tags[found[0]] = rel(pdfs[deck])
    for stem, p in pdfs.items():
        tags.setdefault(stem.replace("_", "-"), rel(p))
    return tags


def topic_count(guide):
    text = guide.read_text(encoding="utf-8")
    return sum(1 for h in re.findall(r"^## (.+)$", text, re.M) if h.strip().lower() != "mixed review")


def md_table(text, heading):
    """Rows of the first Markdown table under '## heading', as dicts keyed by the header cells."""
    m = re.search(rf"^## {re.escape(heading)}\s*$(.*?)(?=^## |\Z)", text, re.M | re.S)
    if not m:
        return []
    lines = [l.strip() for l in m.group(1).splitlines() if l.strip().startswith("|")]
    if len(lines) < 2:
        return []
    cells = lambda l: [c.strip() for c in l.strip("|").split("|")]
    head = cells(lines[0])
    return [dict(zip(head, cells(l))) for l in lines[2:]]


def dashboard():
    """Per course: open deadlines and review items due today or earlier, from study/progress.md."""
    today = time.strftime("%Y-%m-%d")
    out = []
    for cdir in course_dirs():
        code, title = course_meta(cdir)
        prog = cdir / "study" / "progress.md"
        text = prog.read_text(encoding="utf-8") if prog.exists() else ""
        done = ("done", "submitted", "complete", "completed", "finished")
        deadlines = [r for r in md_table(text, "Deadlines") if r.get("Status", "").lower() not in done]
        due = [r for r in md_table(text, "Review queue") if re.match(r"\d{4}-\d{2}-\d{2}", r.get("Due", "")) and r["Due"] <= today]
        weak = [r for r in md_table(text, "Weak topics") if r.get("Status", "").lower() == "active"]
        out.append({"id": cdir.name, "code": code, "title": title,
                    "deadlines": deadlines[:3], "due": due, "weak": [w.get("Topic", "") for w in weak]})
    return out


def tree():
    out = []
    for cdir in course_dirs():
        code, title = course_meta(cdir)
        study = cdir / "study"
        weeks = {}
        for base in (cdir / "course", study / "weeks"):
            if base.is_dir():
                for w in base.iterdir():
                    n = week_num(w.name)
                    if w.is_dir() and n is not None:
                        weeks.setdefault(n, None)
        week_list = []
        for n in sorted(weeks):
            sdir, cwk = study / "weeks" / f"Week{n}", cdir / "course" / f"Week{n}"
            order = {"guide": 0, "practice": 1}
            docs = sorted(sdir.glob("*.md"), key=lambda p: (order.get(p.stem, 9), p.name)) if sdir.is_dir() else []
            srcs = sorted(cwk.glob("*.pdf")) if cwk.is_dir() else []
            guide = sdir / "guide.md"
            week_list.append({
                "n": n,
                "title": md_title(guide) if guide.exists() else "",
                "topics": topic_count(guide) if guide.exists() else 0,
                "docs": [{"path": rel(p), "name": p.stem, "title": md_title(p)} for p in docs],
                "sources": [{"path": rel(p), "name": p.stem,
                             "transcript": (cdir / ".cache" / f"Week{n}" / f"{p.stem}.transcript.md").exists()}
                            for p in srcs],
            })
        top = [p for p in sorted(study.glob("*.md"))]
        exams = []
        if (study / "exams").is_dir():
            for a in sorted(x for x in (study / "exams").iterdir() if x.is_dir()):
                files = sorted(a.glob("*.md"))
                if files:
                    exams.append({"name": a.name, "docs": [{"path": rel(p), "name": p.stem, "title": md_title(p)} for p in files]})
        work = []
        for group in ("labs", "assignments"):
            g = cdir / group
            if g.is_dir():
                for item in sorted(x for x in g.iterdir() if x.is_dir()):
                    files = sorted(item.glob("*.md"))
                    if files:
                        work.append({"name": item.name, "docs": [{"path": rel(p), "name": p.stem, "title": md_title(p)} for p in files]})
        out.append({
            "id": cdir.name, "code": code, "title": title,
            "docs": [{"path": rel(p), "name": p.stem, "title": md_title(p)} for p in top],
            "weeks": week_list, "exams": exams, "work": work,
            "tags": deck_tags(cdir),
        })
    return out


# ---------------------------------------------------------------- safe file access

def safe_path(relpath, kind):
    """Resolve a repo-relative path and allow only study Markdown ('doc') or course PDFs ('src')."""
    try:
        p = (ROOT / relpath).resolve()
        parts = p.relative_to(ROOT).parts
    except (ValueError, OSError):
        return None
    if len(parts) < 3 or not (ROOT / parts[0] / "study").is_dir() or not p.is_file():
        return None
    if kind == "doc":
        return p if p.suffix == ".md" and parts[1] in ("study", "labs", "assignments") else None
    if kind == "src":
        return p if p.suffix == ".pdf" and parts[1] in ("course", "labs", "assignments") else None
    if kind == "img":
        return p if p.suffix.lower() in IMAGE_TYPES and parts[1] in ("study", "labs", "assignments") else None
    return None


IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".svg": "image/svg+xml"}


# ---------------------------------------------------------------- slide text

def slide_text(cdir, week, pdf):
    cache = cdir / ".cache" / f"Week{week}"
    tr = cache / f"{pdf.stem}.transcript.md"
    if tr.exists():
        return tr.read_text(encoding="utf-8")
    txt = cache / f"{pdf.stem}.txt"
    if not txt.exists() or txt.stat().st_mtime < pdf.stat().st_mtime:
        try:
            import fitz
        except ImportError:
            return f"[{pdf.name}: PyMuPDF not installed, cannot read slides — pip install pymupdf]"
        cache.mkdir(parents=True, exist_ok=True)
        with fitz.open(pdf) as d:
            body = "\n".join(f"===== {pdf.stem} PAGE {i + 1} =====\n{p.get_text()}" for i, p in enumerate(d))
        txt.write_text(body, encoding="utf-8")
    return txt.read_text(encoding="utf-8")


_MAPS = {}   # course folder -> (signature of its files, map text)


def map_signature(cdir):
    """Name, size and modification time of every file the map is built from."""
    pats = ("CLAUDE.md", "study/*.md", "study/weeks/Week*/guide.md", "course/Week*/*.pdf",
            ".cache/Week*/*.transcript.md", ".cache/Week*/*.txt", "labs/**/*", "assignments/**/*")
    sig = []
    for pat in pats:
        for p in sorted(cdir.glob(pat)):
            if p.is_file():
                st = p.stat()
                sig.append((p.relative_to(cdir).as_posix(), st.st_size, st.st_mtime_ns))
    return tuple(sig)


def course_map(cdir):
    """The course map, rebuilt only when a guide, deck, transcript or handout was added or changed.
    Keeping it byte-identical between questions also lets prompt caching reuse it."""
    sig = map_signature(cdir)
    cached = _MAPS.get(cdir)
    if cached and cached[0] == sig:
        return cached[1]
    text = build_course_map(cdir)
    _MAPS[cdir] = (map_signature(cdir), text)   # re-sign: building may extract a missing text layer
    return text


def build_course_map(cdir):
    """A compact map of everything in the course that Claude can open: every week guide with its
    topics (numbered, with line numbers), every slide transcript with its slides (tag, number, line),
    and the other study and handout files. Paths are relative to the course folder."""
    code, title = course_meta(cdir)
    out = [f"# {code} {title} — map of the course material",
           "Every path below is relative to the course folder, which is your working directory.", ""]
    for f in ("CLAUDE.md", "study/course-map.md", "study/progress.md"):
        if (cdir / f).exists():
            out.append(f"- `{f}` — " + {"CLAUDE.md": "course facts: grading, assessment format, dates, AI policy",
                                         "study/course-map.md": "every topic's key takeaways, all weeks",
                                         "study/progress.md": "deadlines, weak topics, review queue"}[f])
    weeks = sorted({n for base in (cdir / "course", cdir / "study" / "weeks") if base.is_dir()
                    for n in (week_num(w.name) for w in base.iterdir() if w.is_dir()) if n is not None})
    for w in weeks:
        g = cdir / "study" / "weeks" / f"Week{w}" / "guide.md"
        if g.exists():
            lines = g.read_text(encoding="utf-8").splitlines()
            head = next((l[2:] for l in lines if l.startswith("# ")), f"Week {w}")
            out += ["", f"## {head}", f"Study guide `study/weeks/Week{w}/guide.md` ({len(lines)} lines). Topics — line: title",
                    "(each topic runs to the line before the next; inside each: From the slides, What you need to "
                    "know first, In plain English, Watch out, Sample problems, Remember)"]
            n = 0
            for i, l in enumerate(lines, 1):
                if l.startswith("## "):
                    t = l[3:].strip()
                    if t.lower() == "mixed review":
                        out.append(f"  {i}: Mixed review (problems combining the week's topics)")
                    else:
                        n += 1
                        out.append(f"  {i}: {n}. {t}")
        pdfs = sorted((cdir / "course" / f"Week{w}").glob("*.pdf"))
        if pdfs:
            if not g.exists():
                out += ["", f"## Week {w} (no study guide yet)"]
            out.append(f"Slides for week {w} — exact slide wording; section per slide — line: [tag sN] title")
        for pdf in pdfs:
            tr = cdir / ".cache" / f"Week{w}" / f"{pdf.stem}.transcript.md"
            if tr.exists():
                src = tr
            else:   # no transcript yet: fall back to the PDF's text layer (extracted once)
                slide_text(cdir, w, pdf)
                src = cdir / ".cache" / f"Week{w}" / f"{pdf.stem}.txt"
            rel_src = src.relative_to(cdir).as_posix()
            entries = []
            for i, l in enumerate(src.read_text(encoding="utf-8").splitlines(), 1):
                m = re.match(r"^## \[([^\]]+)\]\s*(.*)$", l) or re.match(r"^===== \S+ PAGE (\d+) =====", l)
                if m:
                    label = f"[{m.group(1)}] {m.group(2)[:60]}" if m.lastindex == 2 else f"page {m.group(1)}"
                    entries.append(f"{i}: {label}")
            kind = "transcript" if src.suffix == ".md" else "text layer only (no transcript: may miss equations/diagrams)"
            out.append(f"- `{rel_src}` — {pdf.stem}, {kind}")
            out.append("    " + " · ".join(entries))
    extra = [p for grp in ("labs", "assignments") if (cdir / grp).is_dir()
             for p in sorted((cdir / grp).rglob("*")) if p.is_file() and p.suffix.lower() in (".md", ".txt", ".html")]
    if extra:
        out += ["", "## Labs and assignments (handouts, grading grids, report templates, guides)"]
        out += [f"- `{p.relative_to(cdir).as_posix()}`" for p in extra]
    return "\n".join(out)


SYSTEM = """You are a patient tutor for {code} {title}, answering one student's questions.

You can open every piece of this course's material with the Read, Grep and Glob tools (read-only;
confined to this course's folder). The map below lists all of it. Decide from the question what to load:

- Read only what the question needs, by line range: a guide topic runs from its line to the next
  topic's line. Guides teach (plain English, worked examples, prerequisites); slide transcripts give the
  exact slide wording, formulas and diagrams — open them when wording or detail matters.
- Use Grep to find a term, formula or name across the whole course; then Read around the hits.
- Questions about structure ("what's in week 2", "which decks") can be answered from the map.
- Questions spanning topics or weeks: open each relevant topic, not just one.
- Never answer from memory when the material covers it. If, after looking, nothing in the course
  covers the question, say "Not covered in the course material", then give a short explanation
  labelled **Beyond slides** if it helps.

Answering:
- Cite slides as the material does, e.g. [S&D-2 s14]; cite a guide topic by its title.
- Teach: plain-language idea first, then the precise version. In any algebra or derivation show
  every step and name the rule it uses, e.g. "(solving a linear equation: same step on both sides)".
- Be concise; no preamble; don't narrate which files you opened. Markdown; math in KaTeX with $...$ and $$...$$.
- If the student says the question is from a live graded quiz, test or exam, add one short line
  noting the course's rule on AI use during assessments (CLAUDE.md), then answer it fully.
{screen}
{course_map}"""


def screen_note(cdir, week, topic):
    """Where the student is reading, so "explain this" works without searching."""
    if not topic or not week:
        return ""
    g = cdir / "study" / "weeks" / f"Week{week}" / "guide.md"
    if not g.exists():
        return ""
    lines = g.read_text(encoding="utf-8").splitlines()
    starts = [i for i, l in enumerate(lines, 1) if l.startswith("## ")]
    for k, i in enumerate(starts):
        if lines[i - 1][3:].strip() == topic:
            end = starts[k + 1] - 1 if k + 1 < len(starts) else len(lines)
            return (f"\nThe student is reading week {week}, topic \"{topic}\" — "
                    f"study/weeks/Week{week}/guide.md lines {i}–{end}. \"This\" / \"here\" refers to it.\n")
    return ""


# ---------------------------------------------------------------- saved chats
# One JSON file per Ask conversation. The Claude session id stays here on the server, so the
# browser only ever holds the chat id; reopening a chat resumes the same Claude session.

CHATS = WORK / "chats"
CHAT_ID = re.compile(r"^[a-f0-9]{12}$")


def chat_file(chat_id):
    return CHATS / f"{chat_id}.json" if chat_id and CHAT_ID.match(chat_id) else None


def load_chat(chat_id):
    f = chat_file(chat_id)
    return json.loads(f.read_text(encoding="utf-8")) if f and f.exists() else None


def save_chat(chat):
    CHATS.mkdir(parents=True, exist_ok=True)
    with LOCK:
        chat_file(chat["id"]).write_text(json.dumps(chat, ensure_ascii=False, indent=1), encoding="utf-8")


def list_chats():
    out = []
    for f in CHATS.glob("*.json") if CHATS.exists() else []:
        try:
            c = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        out.append({k: c.get(k) for k in ("id", "title", "course", "code", "created", "updated")}
                   | {"count": sum(1 for m in c.get("messages", []) if m["role"] == "q")})
    return sorted(out, key=lambda c: c["updated"] or "", reverse=True)


def public_chat(c):
    """A chat as the browser sees it — everything except the Claude session id."""
    return {k: v for k, v in c.items() if k != "session"}


def ask_chat(chat_id, course_id, question, week=0, topic="", model=None):
    """Answer a question inside a saved chat (a new one when chat_id is empty) and record both."""
    chat = load_chat(chat_id) if chat_id else None
    if chat_id and chat is None:
        return {"error": "That chat no longer exists. Start a new one."}, 404
    history = ""
    if chat:   # a chat keeps its course
        course_id = chat["course"]
        if chat.get("v") != 2:
            # Chats from before course-wide lookup ran in another folder, so their Claude session
            # can't be resumed; carry the conversation over as text instead.
            history = "\n\n".join(f"{'Student' if m['role'] == 'q' else 'Tutor'}: {m['text']}"
                                  for m in chat.get("messages", [])[-8:])
    model = model if model in MODELS else MODEL
    session = chat["session"] if chat and chat.get("v") == 2 else None
    prompt = (f"Earlier in this chat:\n\n{history}\n\nNew question: {question}" if history else question)
    payload, status = ask(course_id, prompt, session, week, topic, model)
    if status != 200:
        return payload, status
    now = time.strftime("%Y-%m-%d %H:%M")
    if chat is None:
        import uuid
        cdir = next(c for c in course_dirs() if c.name == course_id)
        chat = {"id": uuid.uuid4().hex[:12], "title": " ".join(question.split())[:80], "course": course_id,
                "code": course_meta(cdir)[0], "created": now, "messages": []}
    chat["v"] = 2
    chat["session"] = payload["session"]
    chat["updated"] = now
    chat["messages"] += [{"role": "q", "text": question},
                         {"role": "a", "text": payload["answer"], "ms": payload["ms"], "cost": payload["cost"],
                          "model": model}]
    save_chat(chat)
    return {"answer": payload["answer"], "ms": payload["ms"], "cost": payload["cost"], "chat": chat["id"],
            "model": model}, 200


def ask(course_id, question, session, week=0, topic="", model=None):
    """One question to Claude, run inside the course folder with read-only tools, so it can open
    any of the course's material it decides the question needs (and nothing outside the course)."""
    cdir = next((c for c in course_dirs() if c.name == course_id), None)
    if cdir is None:
        return {"error": "Unknown course."}, 400
    code, title = course_meta(cdir)
    system = SYSTEM.format(code=code, title=title, screen=screen_note(cdir, week, topic), course_map=course_map(cdir))
    WORK.mkdir(exist_ok=True)
    key = hashlib.sha1(system.encode("utf-8")).hexdigest()[:16]
    pfile = WORK / f"prompt-{key}-{threading.get_ident()}.md"
    pfile.write_text(system, encoding="utf-8")   # deleted as soon as Claude has answered
    model = model if model in MODELS else MODEL
    # Read, Grep and Glob only — no writing, commands or web. With default permissions and the course
    # folder as the working directory, reads outside the course are refused (nobody can approve them in
    # -p mode). Never pass --allowedTools for these: that pre-approves reads anywhere on the machine.
    # No connectors, skills, hooks or user/project settings (each would add cost and reach).
    cmd = ["claude", "-p", "--output-format", "json", "--model", model,
           "--tools", "Read,Grep,Glob", "--max-turns", str(ASK_MAX_TURNS),
           "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "local",
           "--system-prompt-file", str(pfile)]
    if session:
        cmd += ["--resume", session]
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, input=question, capture_output=True, text=True, encoding="utf-8",
                              timeout=ASK_TIMEOUT, cwd=str(cdir))
    except FileNotFoundError:
        return {"error": "The claude command isn't on PATH. Install Claude Code, then restart the hub."}, 500
    except subprocess.TimeoutExpired:
        return {"error": f"Claude took longer than {ASK_TIMEOUT // 60} minutes. Ask again, or narrow the question."}, 504
    finally:
        pfile.unlink(missing_ok=True)
    ms = int((time.time() - t0) * 1000)
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"error": "Claude returned no answer. " + (proc.stderr or proc.stdout)[-400:].strip()}, 502
    if data.get("subtype") == "error_max_turns":
        return {"error": "Claude ran out of look-up steps before answering. Ask a narrower question."}, 502
    if data.get("is_error"):
        return {"error": str(data.get("result") or "Claude reported an error.")}, 502
    cost = data.get("total_cost_usd")
    denied = len(data.get("permission_denials") or [])
    log(f"ask course={code} model={model} map_chars={len(system)} turns={data.get('num_turns')} "
        f"denied={denied} ms={ms} cost={cost}")
    return {"answer": data.get("result", ""), "session": data.get("session_id"), "ms": ms, "cost": cost}, 200


def log(msg):
    WORK.mkdir(exist_ok=True)
    with LOCK, open(WORK / "hub.log", "a", encoding="utf-8") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")


# ---------------------------------------------------------------- search

def search(q):
    q = q.strip().lower()
    if len(q) < 2:
        return []
    hits = []
    for c in tree():
        paths = [d["path"] for d in c["docs"]]
        paths += [d["path"] for w in c["weeks"] for d in w["docs"]]
        paths += [d["path"] for e in c["exams"] + c["work"] for d in e["docs"]]
        for rp in paths:
            heading = topic = ""
            for i, line in enumerate((ROOT / rp).read_text(encoding="utf-8").splitlines()):
                if line.startswith("#"):
                    heading = line.lstrip("#").strip()
                    if line.startswith("## "):
                        topic = heading
                if q in line.lower():
                    hits.append({"course": c["code"], "path": rp, "heading": heading, "topic": topic,
                                 "line": i + 1, "text": line.strip()[:200]})
                    if len(hits) >= 80:
                        return hits
    return hits


# ---------------------------------------------------------------- HTTP

# ---------------------------------------------------------------- network mode

PHONE_URL = None    # set in --lan mode: the address phones on the same network use


def lan_ip():
    """This computer's address on the local network (no traffic is sent)."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()



class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def log_message(self, fmt, *args):
        pass

    def _local(self):
        return self.client_address[0] in ("127.0.0.1", "::1")

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path, ctype):
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        if u.path == "/api/phone":
            # Shown only on this computer (a phone doesn't need a QR code for itself).
            return self._json({"url": PHONE_URL if self._local() else None})
        if u.path == "/api/tree":
            return self._json(tree())
        if u.path == "/api/dashboard":
            return self._json(dashboard())
        if u.path == "/api/doc":
            p = safe_path(qs.get("path", [""])[0], "doc")
            return self._file(p, "text/markdown; charset=utf-8") if p else self._json({"error": "Not a study file."}, 404)
        if u.path == "/api/src":
            p = safe_path(qs.get("path", [""])[0], "src")
            return self._file(p, "application/pdf") if p else self._json({"error": "Not a course PDF."}, 404)
        if u.path == "/api/img":
            p = safe_path(qs.get("path", [""])[0], "img")
            return self._file(p, IMAGE_TYPES[p.suffix.lower()]) if p else self._json({"error": "Not a study image."}, 404)
        if u.path == "/api/search":
            return self._json(search(qs.get("q", [""])[0]))
        if u.path == "/api/models":
            return self._json({"default": MODEL, "models": [{"id": k, "label": v} for k, v in MODELS.items()]})
        if u.path == "/api/chats":
            return self._json(list_chats())
        if u.path == "/api/chat":
            c = load_chat(qs.get("id", [""])[0])
            return self._json(public_chat(c)) if c else self._json({"error": "That chat no longer exists."}, 404)
        return super().do_GET()

    def _body(self):
        try:
            return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except json.JSONDecodeError:
            return None

    def do_POST(self):
        path = urlparse(self.path).path
        req = self._body()
        if req is None:
            return self._json({"error": "Bad request."}, 400)
        if path == "/api/chat/delete":
            f = chat_file(str(req.get("id", "")))
            if f and f.exists():
                f.unlink()
            return self._json({"ok": True})
        if path != "/api/ask":
            return self._json({"error": "Not found."}, 404)
        q = (req.get("question") or "").strip()
        if not q:
            return self._json({"error": "Type a question first."}, 400)
        try:
            week = int(req.get("week") or 0)
        except (TypeError, ValueError):
            week = 0
        payload, status = ask_chat(str(req.get("chat") or ""), str(req.get("course", "")), q, week,
                                   str(req.get("topic") or ""), str(req.get("model") or ""))
        self._json(payload, status)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    # On Windows, SO_REUSEADDR lets a second hub bind the same port silently and steal requests;
    # SO_EXCLUSIVEADDRUSE makes a second start fail loudly instead.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt":
            import socket
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--lan", action="store_true",
                    help="also reachable from phones/tablets (anyone) on the same network")
    ap.add_argument("--open", action="store_true", help="open the browser")
    args = ap.parse_args()
    global PHONE_URL
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    url = f"http://127.0.0.1:{args.port}/"
    if args.lan:
        PHONE_URL = f"http://{lan_ip()}:{args.port}/"
    try:
        srv = Server((host, args.port), Handler)
    except OSError:
        print(f"Port {args.port} is already in use — the Study Hub is probably already running.\n"
              f"Open {url} in your browser, or close the other window first.")
        if args.open:
            webbrowser.open(url)
        sys.exit(1)
    print(f"Study Hub is running on this computer: {url}")
    if args.lan:
        print(f"\nOn your phone or tablet (same Wi-Fi), open:\n\n    {PHONE_URL}\n\n"
              "or scan the QR code under 'Open on your phone' in the Study Hub.\n"
              "Anyone on this network can open it. If Windows Firewall asks, allow Python on private networks.")
    print("\nKeep this window open while you study. Close it (or press Ctrl+C) to stop the hub.")
    log(f"start host={host} port={args.port}")
    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
