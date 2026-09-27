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
import argparse, hashlib, http.server, json, math, os, re, socketserver, subprocess, sys, threading, time, webbrowser
from pathlib import Path
from urllib.parse import urlparse, parse_qs

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("STUDY_HUB_ROOT") or HERE.parent.parent).resolve()
STATIC = HERE / "static"
WORK = HERE / ".cache"
CONTEXT_CAP = 60_000   # characters of material sent with a question (~15k tokens)
TOPICS_PER_QUESTION = 4   # guide topics picked by relevance, besides the one on screen
SLIDES_PER_QUESTION = 10  # slide sections picked by relevance
MODEL = os.environ.get("STUDY_HUB_MODEL", "sonnet")

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


STOP = set("""a an and are as at be by can do does for from how i if in is it its of on or so
that the their then there these this to was what when where which who why will with you your
not no yes me my we our they them than into about over under between each any all also""".split())


def tokens(text):
    return [w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in STOP and len(w) > 1]


def chunks_of(text, marker):
    """Split Markdown into (heading, body) chunks at lines starting with `marker`."""
    parts = re.split(rf"^(?={re.escape(marker)})", text, flags=re.M)
    out = []
    for p in parts:
        if p.startswith(marker):
            out.append((p.splitlines()[0][len(marker):].strip(), p))
    return out


def bm25_top(query, docs, k):
    """Indices of the k docs (strings) most relevant to query (Okapi BM25)."""
    q = set(tokens(query))
    if not q or not docs:
        return []
    toks = [tokens(d) for d in docs]
    n = len(docs)
    avg = sum(map(len, toks)) / n or 1
    df = {t: sum(1 for d in toks if t in set(d)) for t in q}
    scores = []
    for i, d in enumerate(toks):
        tf = {}
        for w in d:
            if w in q:
                tf[w] = tf.get(w, 0) + 1
        s = 0.0
        for t, f in tf.items():
            idf = math.log(1 + (n - df[t] + .5) / (df[t] + .5))
            s += idf * f * 2.2 / (f + 1.2 * (.25 + .75 * len(d) / avg))
        scores.append((s, i))
    return [i for s, i in sorted(scores, reverse=True)[:k] if s > 0]


def build_context(cdir, week, scope, question="", topic=""):
    """Only what this question needs: course facts, the topic being read, and the guide topics and
    slides that best match the question (BM25) — from one week, or from every week of the course."""
    parts = []
    cm = cdir / "CLAUDE.md"
    if cm.exists():
        parts.append(("Course facts (CLAUDE.md)", cm.read_text(encoding="utf-8")))
    weeks = [week] if scope == "week" else sorted(
        n for n in (week_num(w.name) for w in (cdir / "study" / "weeks").glob("Week*")) if n is not None)
    if scope != "week":
        weeks = sorted(set(weeks) | {n for n in (week_num(w.name) for w in (cdir / "course").glob("Week*")) if n is not None})

    topics, slides = [], []          # (label, text)
    for w in weeks:
        g = cdir / "study" / "weeks" / f"Week{w}" / "guide.md"
        if g.exists():
            for head, body in chunks_of(g.read_text(encoding="utf-8"), "## "):
                if head.lower() != "mixed review":   # cross-topic problems match everything; skip
                    topics.append((f"Week {w} guide · {head}", body, head))
        for pdf in sorted((cdir / "course" / f"Week{w}").glob("*.pdf")):
            text = slide_text(cdir, w, pdf)
            for head, body in chunks_of(text, "## [") or chunks_of(text, "===== "):
                slides.append((f"Week {w} slides · [{head.split(']')[0].lstrip('[')}]", body, head))

    # A title that matches the question is the strongest signal: count it three times.
    ranked = lambda items: [f"{h} {h} {h}\n{b}" for _, b, h in items]
    picked = []
    if topic:   # the topic open on screen always comes first
        picked += [t for t in topics if t[2] == topic][:1]
    for i in bm25_top(question, ranked(topics), TOPICS_PER_QUESTION):
        if topics[i] not in picked:
            picked.append(topics[i])
    parts += [(label, body) for label, body, _ in picked]
    for i in sorted(bm25_top(question, ranked(slides), SLIDES_PER_QUESTION)):
        parts.append((slides[i][0], slides[i][1]))

    out, used, dropped = [], 0, []
    for title, body in parts:
        block = f"\n\n########## {title} ##########\n{body}"
        if used + len(block) > CONTEXT_CAP:
            dropped.append(title)
            continue
        out.append(block)
        used += len(block)
    if dropped:
        out.append("\n\n[Left out to fit the size limit: " + "; ".join(dropped) + "]")
    return "".join(out)


SYSTEM = """You are a patient tutor for {code} {title}, answering one student's questions.
The course material for the selected scope ({scope_label}) is below. Rules:

- Ground every answer in the material. Cite slides exactly as the material does, e.g. [S&D-2 s14].
- If the material does not cover the question, say "Not covered in the selected material", then
  give a short explanation labelled **Beyond slides** if it helps the student understand.
- Teach: plain-language idea first, then the precise version. In any algebra or derivation show
  every step and name the rule it uses, e.g. "(solving a linear equation: same step on both sides)".
- Be concise; no preamble. Markdown; math in KaTeX with $...$ and $$...$$.
- If the student says the question is from a live graded quiz, test or exam, add one short line
  noting the course's rule on AI use during assessments (see the course facts), then answer it fully.
{material}"""


def ask(course_id, week, scope, question, session, topic=""):
    cdir = next((c for c in course_dirs() if c.name == course_id), None)
    if cdir is None:
        return {"error": "Unknown course."}, 400
    if scope == "week" and not ((cdir / "course" / f"Week{week}").is_dir() or (cdir / "study" / "weeks" / f"Week{week}").is_dir()):
        return {"error": f"Week {week} has no material yet."}, 400
    code, title = course_meta(cdir)
    material = build_context(cdir, week, scope, question, topic)
    label = (f"week {week}" if scope == "week" else "the whole course") +         ": the parts of the study guide and slides most relevant to the question"
    system = SYSTEM.format(code=code, title=title, scope_label=label, material=material)
    WORK.mkdir(exist_ok=True)
    key = hashlib.sha1(system.encode("utf-8")).hexdigest()[:16]
    pfile = WORK / f"prompt-{key}-{threading.get_ident()}.md"
    pfile.write_text(system, encoding="utf-8")   # deleted as soon as Claude has answered
    # Tutor-only session: no tools, connectors, skills, hooks or user/project settings.
    # Without these flags every question also pays for the whole Claude Code setup (~30x the cost).
    cmd = ["claude", "-p", "--output-format", "json", "--model", MODEL, "--tools", "",
           "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "local",
           "--system-prompt-file", str(pfile)]
    if session:
        cmd += ["--resume", session]
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, input=question, capture_output=True, text=True, encoding="utf-8",
                              timeout=240, cwd=str(WORK))
    except FileNotFoundError:
        return {"error": "The claude command isn't on PATH. Install Claude Code, then restart the hub."}, 500
    except subprocess.TimeoutExpired:
        return {"error": "Claude took longer than 4 minutes. Ask again, or narrow the question."}, 504
    finally:
        pfile.unlink(missing_ok=True)
    ms = int((time.time() - t0) * 1000)
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"error": "Claude returned no answer. " + (proc.stderr or proc.stdout)[-400:].strip()}, 502
    if data.get("is_error"):
        return {"error": str(data.get("result") or "Claude reported an error.")}, 502
    cost = data.get("total_cost_usd")
    log(f"ask course={code} scope={scope} week={week} context_chars={len(material)} ms={ms} cost={cost}")
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
        return super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path != "/api/ask":
            return self._json({"error": "Not found."}, 404)
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "Bad request."}, 400)
        q = (req.get("question") or "").strip()
        if not q:
            return self._json({"error": "Type a question first."}, 400)
        session = req.get("session") or None
        if session and not re.fullmatch(r"[A-Za-z0-9-]+", session):
            session = None
        scope = "course" if req.get("scope") == "course" else "week"
        try:
            week = int(req.get("week") or 0)
        except (TypeError, ValueError):
            week = 0
        payload, status = ask(str(req.get("course", "")), week, scope, q, session, str(req.get("topic") or ""))
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
