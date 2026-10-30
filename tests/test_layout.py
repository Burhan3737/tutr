"""Checks for the library layout the hub reads, and for what it writes (verification Layer 5). A plain script:

    python tests/test_layout.py            # everything (about a minute: runs the skill's own checks too)
    python tests/test_layout.py --quick    # without the skill's checks and the hub drive

Everything runs on made-up courses (Demo-Course and friends) built in a temporary folder under the repo's .cache/
(gitignored); nothing here reads or writes a real library, and nothing calls a model.

- where the library is: STUDY_HUB_ROOT, then config.json's "library", then <repo>/library
- course facts from course.json, and the fallbacks when a fact is missing (folder name, generic question style)
- deck.json: roles (lecture / practice), unsorted decks, a tag claimed twice, numbers as text, prepared or not
- me/notes: class notes in WeekN, every other folder a group of documents; me/private never listed or served,
  and the tutor's file-read guard refuses it (and anything outside the course)
- warm-ups (removed): old warm-up review items are skipped everywhere, the warm-up practice kind is refused
- data split: everything the hub writes for a course lands in that course's me/ (a full scripted drive)
- the Add and Prepare stages (the skill's own checks)
- the migration from the old layout: every source file accounted for, on a synthetic old tree
- .gitignore covers every user file
"""
import base64, hashlib, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FAILED = []
QUICK = "--quick" in sys.argv
JPEG = base64.b64decode("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////"
                        "////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=")


def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        FAILED.append(name)


def write(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(text, bytes):
        path.write_bytes(text)
    else:
        path.write_text(text if isinstance(text, str) else json.dumps(text, indent=1), encoding="utf-8")
    return path


def py(code, root=None, cwd=REPO):
    """Run code in a fresh interpreter with the hub's modules importable (from cwd) on library `root`; returns the JSON
    it prints last."""
    env = dict(os.environ)
    env.pop("STUDY_HUB_ROOT", None)
    if root is not None:
        env["STUDY_HUB_ROOT"] = str(root)
    r = subprocess.run([sys.executable, "-c", f"import sys, json; sys.path.insert(0, {str(cwd)!r})\n" + code], cwd=cwd,
                       env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode:
        raise RuntimeError(r.stderr[-3000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


SERVE = """
import threading, urllib.request, urllib.parse, urllib.error
import server as SV, tutor as T
T.run_model = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no model in tests"))
srv = SV.Server(("127.0.0.1", 0), SV.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    rq = urllib.request.Request(f"http://127.0.0.1:{srv.server_address[1]}{path}", data=data, method=method)
    try:
        with urllib.request.urlopen(rq, timeout=60) as r:
            raw, status, ctype = r.read(), r.status, r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        raw, status, ctype = e.read(), e.code, e.headers.get("Content-Type", "")
    return {"status": status, "json": json.loads(raw) if ctype.startswith("application/json") else None,
            "text": raw.decode("utf-8", "replace") if ctype.startswith("text/") else None}
out = [call(*c) for c in CALLS]
srv.shutdown()
print(json.dumps(out))
"""


def serve(root, calls):
    """The hub's HTTP handler on library `root` (in a fresh interpreter, port chosen by the system): the replies to
    calls [(method, path, body)]."""
    return py(f"CALLS = json.loads({json.dumps(json.dumps(calls))})\n" + SERVE, root)


# ---------------------------------------------------------------- a made-up library

def make_library(lib):
    c = lib / "Demo-Course"
    write(c / "course.json", {"code": "DEMO-1", "title": "Introductory Economics (demo)",
                              "assessment_style": "a short demo quiz question",
                              "topics": [{"name": "Supply and Demand", "read_more": "Any textbook, chapter 2"},
                                         {"name": "Elasticity", "read_more": ""}]})
    write(c / "CLAUDE.md", "# Demo course\n")

    def deck(folder, j, slides, transcript=True):
        write(c / "decks" / folder / "deck.json", j)
        for n in range(1, slides + 1):
            write(c / "decks" / folder / f"s{n:03d}.jpg", JPEG)
        if transcript:
            write(c / "decks" / folder / "transcript.md", "\n\n".join(
                f"## [{j.get('tag') or folder} s{n}] Slide {n} of {folder}\nType: content\n\nText of slide {n}."
                for n in range(1, slides + 1)) + "\n")

    deck("SD-1", {"tag": "S&D-1", "title": "Price elasticity", "role": "lecture", "week": 1, "topic": "Supply and Demand",
                  "order": 1, "pages": 3, "prepared": True, "source": "sources/Week1/elasticity.pdf"}, 3)
    deck("SD-2", {"tag": "S&D-2", "title": "Shifts", "role": "lecture", "week": "2", "topic": "Elasticity", "order": "1",
                  "pages": 2, "prepared": False}, 2)
    deck("New", {"tag": "New", "title": "", "role": "lecture", "week": 3, "topic": "Unsorted", "order": 1, "pages": 2,
                 "prepared": False}, 2, transcript=False)
    deck("NoTopic", {"tag": "NoTopic", "role": "lecture", "week": 3, "order": 2, "pages": 1}, 1)
    deck("HW-1", {"tag": "HW-1", "title": "Homework 1", "role": "practice", "week": 2, "topic": "Supply and Demand",
                  "order": 1, "pages": 1, "prepared": True}, 1)
    deck("ZZ-dup", {"tag": "S&D-1", "title": "A second deck with the same tag", "role": "lecture", "week": 9,
                    "topic": "Elasticity", "order": 1, "pages": 1, "prepared": True}, 1)
    write(c / "decks" / "NoFacts" / "s001.jpg", JPEG)               # no deck.json: not a deck
    me = c / "me"
    write(me / "notes" / "Week1" / "notes.md", "# My week 1 notes\n")
    write(me / "notes" / "Week1" / "extra.txt", "more notes\n")
    write(me / "notes" / "Week1" / "empty.md", "")
    write(me / "notes" / "week2" / "notes.md", "# week 2\n")
    write(me / "notes" / "exams" / "midterm" / "mock-1.md", "# Mock 1\n")
    write(me / "notes" / "exams" / "plan.md", "# Exam plan\n")
    write(me / "notes" / "labs" / "lab1" / "GUIDE.md", "# Lab 1\n")
    write(me / "notes" / "labs" / "lab1" / "data.zip", b"PK")
    write(me / "notes" / "project" / "roadmap.md", "# Project\n")
    write(me / "notes" / ".hidden" / "x.md", "# hidden\n")
    write(me / "private" / "exams" / "midterm" / "mock-1-key.md", "# THE ANSWER KEY\n")
    write(me / "private" / "secret.jpg", JPEG)
    write(me / "uploads" / "ask-aaaa.jpg", JPEG)
    write(me / "tutor-memory.md", "# What your tutor remembers\n\n## About me\n")
    write(me / "progress.md", "# Progress\n\n## Deadlines\n\n| Date | Item | Weight | Status | Covers |\n|---|---|---|---|---|\n"
                              "| Dec 31 | **Quiz 1** — in class | 5% | upcoming | W1–2 |\n\n## Weak topics\n\n"
                              "<!-- study-hub:start -->\n<!-- study-hub:end -->\n")
    import datetime as dt
    today = dt.date.today().isoformat()
    item = lambda i, **kw: {"id": f"{i:010x}", "deck": "S&D-1", "slides": "s2", "concept": f"concept {i}",
                            "problem_md": f"problem {i}", "mistake": "Setup", "note": "", "step": 0, "due": today,
                            "created": today, "last": None, **kw}
    write(me / "hub-state.json", {"v": 1, "decks": {}, "chats": {}, "warmups_seeded": today, "reviews": [
        item(1, warmup=False), item(2, warmup=True, deck=None, concept="Old warm-up one"),
        item(3, warmup=True, deck=None, concept="Old warm-up two"), item(4), item(5, retired=True)]})
    b = lib / "Bare-Course"                                          # a course.json with no facts at all
    write(b / "course.json", {})
    write(b / "decks" / "Only" / "deck.json", {"role": "lecture", "week": 1, "pages": 1, "prepared": True})
    write(b / "decks" / "Only" / "transcript.md", "## [Only s1] The only slide\n\nText.\n")
    write(b / "decks" / "Only" / "s001.jpg", JPEG)
    write(lib / "Not-A-Course" / "decks" / "X" / "deck.json", {"tag": "X", "pages": 1})   # no course.json
    write(lib / "Broken-Course" / "course.json", "{ not json")     # unreadable course.json: still a course
    return c


# ---------------------------------------------------------------- the checks

def test_location(tmp):
    """STUDY_HUB_ROOT wins, then config.json's "library" (relative to the repo root), then <repo>/library."""
    code = tmp / "code"
    code.mkdir()
    shutil.copy2(REPO / "library.py", code / "library.py")
    get = lambda root=None: Path(py("import library as L; print(json.dumps(str(L.ROOT)))", root, cwd=code))
    check("location: <repo>/library by default", get() == (code / "library").resolve())
    write(code / "config.json", {"library": "elsewhere/lib"})
    check("location: config.json 'library', relative to the repo", get() == (code / "elsewhere" / "lib").resolve())
    write(code / "config.json", {"library": str(tmp / "abs-lib")})
    check("location: config.json 'library', absolute", get() == (tmp / "abs-lib").resolve())
    check("location: STUDY_HUB_ROOT beats config.json", get(tmp / "env-lib") == (tmp / "env-lib").resolve())
    for bad in ("{ not json", [1, 2], {"library": 5}, {"library": ["a"]}, {"library": ""}, {"other": "x"}):
        write(code / "config.json", bad if isinstance(bad, str) else json.dumps(bad))
        try:
            ok = get() == (code / "library").resolve()
        except RuntimeError as e:
            ok = False
            bad = f"{bad}: {str(e).strip().splitlines()[-1]}"
        check(f"location: a config.json without a usable 'library' falls back to <repo>/library ({str(bad)[:40]})", ok)
    (code / "config.json").unlink()
    check("location: no library folder yet means no courses",
          py("import library as L; print(json.dumps(L.course_dirs()))", tmp / "missing") == [])


def test_facts_and_decks(lib):
    got = py("""
import library as L
out = {"courses": [c.name for c in L.course_dirs()]}
for c in L.course_dirs():
    info = L.course_info(c)
    out[c.name] = {"meta": L.course_meta(c), "style": L.course_style(c), "topics": info["topics"], "practice": info["practice"],
                   "decks": {t: {k: d[k] for k in ("tag", "folder", "week", "topic", "order", "slides", "title", "prepared")}
                             for t, d in info["decks"].items()},
                   "texts": {t: L.slide_texts(c, t) for t in info["decks"]},
                   "image": {t: bool(L.slide_image(c, t, 1)) for t in info["decks"]},
                   "map": L.course_map(c)}
print(json.dumps(out))""", lib)
    check("course: a folder is a course iff it has course.json (an unreadable one counts)",
          got["courses"] == ["Bare-Course", "Broken-Course", "Demo-Course"], got["courses"])
    d = got["Demo-Course"]
    check("course facts: code and title from course.json", d["meta"] == ["DEMO-1", "Introductory Economics (demo)"])
    check("course facts: assessment style from course.json", d["style"] == "a short demo quiz question")
    for name in ("Bare-Course", "Broken-Course"):
        check(f"course facts: missing code/title -> the folder name ({name})", got[name]["meta"] == [name, name])
        check(f"course facts: missing style -> empty, so prompts use their generic wording ({name})", got[name]["style"] == "")
    check("deck: no tag in deck.json -> the folder name", "Only" in got["Bare-Course"]["decks"])
    check("deck: no title -> the tag", got["Bare-Course"]["decks"]["Only"]["title"] == "Only")
    names = [t["name"] for t in d["topics"]]
    check("topics: in order of their first deck, Not sorted yet last", names == ["Supply and Demand", "Elasticity", "Not sorted yet"], names)
    check("topics: Read more from course.json", d["topics"][0]["read_more"] == "Any textbook, chapter 2" and d["topics"][1]["read_more"] == "")
    check("role practice: listed apart from the topics, whatever its topic says",
          d["practice"] == ["HW-1"] and d["decks"]["HW-1"]["topic"] == "Practice" and
          all("HW-1" not in t["decks"] for t in d["topics"]))
    check("lecture deck with topic 'Unsorted' or none -> Not sorted yet",
          d["decks"]["New"]["topic"] == d["decks"]["NoTopic"]["topic"] == "Not sorted yet")
    check("a tag claimed twice: the first deck in lecture order keeps it",
          d["decks"]["S&D-1"]["folder"] == "SD-1" and d["decks"]["S&D-1"]["title"] == "Price elasticity")
    check("deck.json numbers given as text are read as numbers", d["decks"]["S&D-2"]["week"] == 2 and d["decks"]["S&D-2"]["order"] == 1)
    check("page count from deck.json", d["decks"]["S&D-1"]["slides"] == 3 and d["decks"]["New"]["slides"] == 2)
    check("prepared: true only when deck.json says true", d["decks"]["S&D-1"]["prepared"] and not d["decks"]["S&D-2"]["prepared"]
          and not d["decks"]["NoTopic"]["prepared"])
    check("slide text from transcript.md (Type: lines dropped)",
          d["texts"]["S&D-1"][1] == {"n": 2, "title": "Slide 2 of SD-1", "md": "Text of slide 2."})
    check("a deck not prepared yet: its slides are marked raw", all(s.get("raw") for s in d["texts"]["S&D-2"]))
    check("a deck with no transcript: empty slides, still listed", d["texts"]["New"] == [{"n": 1, "title": "", "md": ""},
                                                                                        {"n": 2, "title": "", "md": ""}])
    check("slide images from decks/<folder>/sNNN.jpg", all(d["image"].values()))
    check("course map: practice section lists the practice deck", "## Practice: homework and practice exams" in d["map"]
          and "- [HW-1] W2 Homework 1: `decks/HW-1/transcript.md`, 1 pages" in d["map"])
    check("course map: a deck without transcript points at its images",
          "`decks/New/ (no transcript yet: slide images only)`" in d["map"])
    check("course map: names the new layout's paths", "`me/progress.md`" in d["map"] and "study/" not in d["map"])
    check("course map: lists the class notes and the lab files",
          "`me/notes/Week1/notes.md`" in d["map"] and "`me/notes/labs/lab1/GUIDE.md`" in d["map"])


def test_prompts_fallback(lib):
    """A course without assessment_style: each prompt keeps its own generic wording."""
    got = py("""
import library as L, tutor as T
seen = []
T.run_model = lambda cdir, system, prompt, **k: seen.append(prompt) or {"text": "x", "json": {
    "problem_md": "p", "solution_md": "s", "final_answer": "f", "hints": ["a", "b"], "concept": "c", "slides": "", "deck": ""},
    "session": None, "ms": 1, "cost": 0}
out = {}
for name in ("Bare-Course", "Demo-Course"):
    c = L.course_dir(name)
    tag = L.deck_order(c)[0]["tag"]
    T._generate(c, {"kind": "try", "tag": tag, "n": 1}, "claude-haiku-4-5", False)
    out[name] = {"practice": seen[-1], "papers": T._papers_text(c, {"papers": []}),
                 "quiz": T.CHAT_PROMPTS["quiz"].format(where="1", question="", tag=tag, deck="d", mistakes="",
                                                       style=L.course_style(c) or "this course's quizzes and exams")}
print(json.dumps(out))""", lib)
    check("style fallback: practice prompt says 'an exam-style question for this course'",
          "Style: an exam-style question for this course." in got["Bare-Course"]["practice"])
    check("style fallback: drill format says 'exam-style questions'", "question style: exam-style questions)" in got["Bare-Course"]["papers"])
    check("style from course.json reaches the practice prompt", "Style: a short demo quiz question." in got["Demo-Course"]["practice"])
    check("style from course.json reaches the drill format", "question style: a short demo quiz question)" in got["Demo-Course"]["papers"])


def test_notes_private_warmups(lib):
    cid = "Demo-Course"
    from urllib.parse import urlencode
    g = lambda _url, **q: ("GET", _url + "?" + urlencode(q), None)
    r = serve(lib, [g("/api/course", id=cid),
                    g("/api/note", course=cid, path="me/notes/Week1/notes.md"),
                    g("/api/note", course=cid, path="me/notes/exams/midterm/mock-1.md"),
                    g("/api/note", course=cid, path="me/notes/project/roadmap.md"),
                    g("/api/note", course=cid, path="me/tutor-memory.md"),
                    g("/api/note", course=cid, path="me/private/exams/midterm/mock-1-key.md"),
                    g("/api/note", course=cid, path="me/notes/../private/exams/midterm/mock-1-key.md"),
                    g("/api/note", course=cid, path="ME/PRIVATE/exams/midterm/mock-1-key.md"),
                    g("/api/note", course=cid, path="me/progress.md"),
                    g("/api/note", course=cid, path="course.json"),
                    g("/api/note", course=cid, path="me/notes/Week1/empty.md"),
                    g("/api/note", course=cid, path="me/notes/.hidden/x.md"),
                    g("/api/upload", course=cid, path="me/private/secret.jpg"),
                    g("/api/upload", course=cid, path="me/uploads/ask-aaaa.jpg"),
                    g("/api/reviews", course=cid),
                    g("/api/search", q="ANSWER KEY"),
                    g("/api/search", q="slide 2"),
                    ("POST", "/api/practice/new", {"course": cid, "kind": "warmup", "tag": "S&D-1"}),
                    ("POST", "/api/practice/new", {"course": cid, "kind": "review", "review_id": "0000000002"}),
                    ("POST", "/api/review/note", {"course": cid, "id": "0000000001", "note": "a note"})])
    course = r[0]["json"]
    check("me/notes: WeekN .md and .txt are class notes (empty ones skipped), any letter case",
          [(n["week"], n["path"]) for n in course["notes"]] ==
          [(1, "me/notes/Week1/notes.md"), (1, "me/notes/Week1/extra.txt"), (2, "me/notes/week2/notes.md")], course["notes"])
    kinds = [(d["kind"], d["name"]) for d in course["docs"]]
    check("me/notes: other folders are document groups, exams/labs/assignments first, the tutor's notes last",
          kinds == [("exams", ""), ("exams", "midterm"), ("labs", "lab1"), ("project", ""), ("tutor", "")], kinds)
    check("me/notes: only .md files are listed in a group (a zip sits alongside)",
          [f["path"] for d in course["docs"] if d["kind"] == "labs" for f in d["files"]] == ["me/notes/labs/lab1/GUIDE.md"])
    check("me/notes: listed documents are served", all(x["status"] == 200 and x["text"] for x in r[1:5]))
    listed = json.dumps(course)
    check("me/private: never listed", "private" not in listed and "ANSWER" not in listed)
    check("me/private: never served as a note (also by ../ or letter case)", all(x["status"] == 404 for x in r[5:8]))
    check("only listed documents are served (not progress.md, course.json, an empty or hidden note)",
          all(x["status"] == 404 for x in r[8:12]))
    check("me/private: never served as a photo", r[12]["status"] == 404)
    check("a photo in me/uploads is served", r[13]["status"] == 200)
    check("search never looks in me/private", r[15]["json"] == [])
    check("search finds slide text", any(h["deck"] == "S&D-1" for h in r[16]["json"]))
    check("warm-ups: old warm-up items are not due reviews", [x["id"] for x in r[14]["json"]] == ["0000000001", "0000000004"]
          and all("warmup" not in x for x in r[14]["json"]), r[14]["json"])
    check("warm-ups: the review count leaves them out", course["reviews"] == {"count": 2, "minutes": 3}, course["reviews"])
    check("warm-ups: the warm-up practice kind is refused", r[17]["status"] == 400)
    check("warm-ups: an old warm-up item can't be practised as a review", r[18]["status"] == 404, r[18])
    prog = (lib / cid / "me" / "progress.md").read_text(encoding="utf-8")
    check("warm-ups: the mirror into progress.md leaves them out (and lists the open mistakes)",
          "concept 1" in prog and "concept 4" in prog and "warm-up" not in prog and "concept 5" not in prog)
    state = json.loads((lib / cid / "me" / "hub-state.json").read_text(encoding="utf-8"))
    check("warm-ups: old items stay in hub-state.json untouched", sum(1 for x in state["reviews"] if x.get("warmup")) == 2)


def test_guard(lib):
    got = py("""
import asyncio, engine as E, opencode_engine as OE, library as L
c = L.course_dir("Demo-Course")
hook = E._confine(c)
def ask(tool, **args):
    out = asyncio.run(hook({"tool_name": tool, "tool_input": args}, "id", None))
    return (out.get("hookSpecificOutput") or {}).get("permissionDecision", "allow")
cases = {
 "read a transcript": ask("Read", file_path=str(c / "decks/SD-1/transcript.md")),
 "read relative": ask("Read", file_path="me/notes/Week1/notes.md"),
 "read private": ask("Read", file_path=str(c / "me/private/exams/midterm/mock-1-key.md")),
 "read private relative": ask("Read", file_path="me/private/exams/midterm/mock-1-key.md"),
 "read private upper case": ask("Read", file_path="ME/Private/exams/midterm/mock-1-key.md"),
 "read private backslashes": ask("Read", file_path=str(c / "me" / "private" / "secret.jpg").replace("/", "\\\\")),
 "read private via ..": ask("Read", file_path="me/notes/../private/secret.jpg"),
 "glob private": ask("Glob", pattern="me/private/**/*.md"),
 "grep in private": ask("Grep", pattern="KEY", path="me/private"),
 "read outside": ask("Read", file_path=str(c.parent / "Bare-Course" / "course.json")),
 "read outside via ..": ask("Read", file_path="../Bare-Course/course.json"),
 "glob outside": ask("Glob", pattern="../**/*.md"),
}
deny = [r for r in OE.PERMISSIONS if r.get("effect") == "deny"] if hasattr(OE, "PERMISSIONS") else []
print(json.dumps({"cases": cases, "oc": [r for r in getattr(OE, "PERMISSIONS", []) if "private" in r.get("resource", "").lower()],
                  "patterns": getattr(OE, "PRIVATE_PATTERNS", [])}))""", lib)
    c = got["cases"]
    check("guard: course files can be read", c["read a transcript"] == c["read relative"] == "allow", c)
    for k in ("read private", "read private relative", "read private upper case", "read private backslashes",
              "read private via ..", "glob private", "grep in private"):
        check(f"guard: me/private refused ({k})", c[k] == "deny", c[k])
    for k in ("read outside", "read outside via ..", "glob outside"):
        check(f"guard: outside the course refused ({k})", c[k] == "deny", c[k])
    pats = got["patterns"]
    check("OpenCode: me/private denied for read, glob and grep, with either separator",
          bool(pats) and any("/" in p for p in pats) and any("\\" in p for p in pats) and
          {r["action"] for r in got["oc"] if r["effect"] == "deny"} >= {"read", "glob", "grep"}, got["oc"][:3])


def test_data_split(tmp):
    """A full scripted drive of the hub (tests/verify/hubdrive.py: every tutor mode, practice, drill, drafts, photos,
    chats) on a copy of the made-up library: everything it writes for a course lands in that course's me/."""
    lib = tmp / "split-lib"
    make_library(lib)
    shutil.rmtree(lib / "Broken-Course")
    code = tmp / "split-code"
    shutil.copytree(REPO, code, ignore=shutil.ignore_patterns(".git", "__pycache__", "library", "agentTempWork", ".cache",
                                                               "tests", "docs", "tools", "example-library", ".claude",
                                                               "config.json"))
    out = tmp / "split.json"
    env = dict(os.environ)
    env.pop("STUDY_HUB_ROOT", None)
    r = subprocess.run([sys.executable, str(REPO / "tests" / "verify" / "hubdrive.py"), "--code", str(code), "--root",
                        str(lib), "--out", str(out)], capture_output=True, text=True, encoding="utf-8", errors="replace",
                       env=env)
    check("data split: the scripted drive ran", r.returncode == 0, r.stderr[-1500:])
    if r.returncode:
        return
    run = json.loads(out.read_text(encoding="utf-8"))
    writes = list(run["writes"]) + list(run["writes_by_views"])
    outside = [w for w in writes if not (w.split("/")[0] in ("Demo-Course", "Bare-Course") and w.split("/")[1] == "me")]
    check(f"data split: all {len(writes)} files written are in a course's me/", not outside and len(writes) > 10, outside[:5])
    kinds = {w.split("/")[2] for w in writes if w.count("/") >= 2}
    check("data split: chats, practice, drafts, uploads, hub state, progress and memory were written",
          {"chats", "practice", "drafts.json", "uploads", "hub-state.json", "progress.md", "tutor-memory.md"} <= kinds, kinds)
    machine = sorted(p.relative_to(code).as_posix() for p in (code / ".cache").rglob("*") if p.is_file()) \
        if (code / ".cache").is_dir() else []
    check("data split: the hub's own .cache holds only machine files (its log)", all(m == ".cache/hub.log" for m in machine), machine)
    check("data split: the drive called the tutor in every mode", len(run["calls"]) > 40, len(run["calls"]))


def test_skill():
    r = subprocess.run([sys.executable, str(REPO / ".claude" / "skills" / "preparing-slides" / "tests" / "test_scripts.py")],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    n = sum(1 for line in r.stdout.splitlines() if line.startswith("ok"))
    check(f"Add and Prepare: the skill's checks pass ({n} checks)", r.returncode == 0 and "0 failed" in r.stdout,
          r.stdout[-800:] + r.stderr[-800:])


def make_old_tree(old):
    """A synthetic library in the earlier layout (course/WeekN, study/, .cache/, a hub folder with its records)."""
    import fitz
    def pdf(path, pages):
        path.parent.mkdir(parents=True, exist_ok=True)
        doc = fitz.open()
        for i in range(pages):
            doc.new_page(width=720, height=405).insert_text((50, 80), f"{path.stem} page {i + 1}", fontsize=20)
        doc.save(path)
        doc.close()
    c = old / "Demo-101_Intro_Economics"
    write(old / "CLAUDE.md", "# Study notes\n")
    write(c / "CLAUDE.md", "# Demo 101\n\n| Week | Deck | Tag | Topic |\n|---|---|---|---|\n"
                           "| 1 | Elasticity | `S&D-1` | Supply and Demand |\n| 3 | Practice-1 | `HW-1` | |\n\n"
                           "| Topic | Read more |\n|---|---|\n| Supply and Demand | Chapter 2 |\n\nAI policy: ask.\n")
    pdf(c / "course" / "Week1" / "Elasticity.pdf", 3)
    pdf(c / "course" / "Week2" / "Markets_Intro.pdf", 2)          # not in the deck table: unsorted, no transcript
    pdf(c / "course" / "practice" / "Practice-1.pdf", 1)
    write(c / "course" / "Week1" / "notes.md", "# notes week 1\n")
    write(c / "course" / "Week1" / "handout.txt", "a download\n")
    pdf(c / "resources" / "Book.pdf", 1)
    write(c / ".cache" / "Week1" / "Elasticity.transcript.md", "## [S&D-1 s1] Price elasticity\n\nx\n\n## [S&D-1 s2] Two\n\ny\n\n"
                                                                "## [S&D-1 s3] Three\n\nz\n")
    write(c / ".cache" / "practice" / "Practice-1.transcript.md", "## [HW-1 s1] Homework 1\n\nq\n")
    write(c / ".cache" / "Week1" / "Elasticity.audit.md", "audit\n")
    write(c / ".cache" / "textbooks" / "Book.txt", "===== Book PAGE 1 =====\ntext\n")
    write(c / ".cache" / "textbooks" / "Book.toc.md", "# Book\n")
    write(c / ".cache" / "uploads" / "ask-0123456789ab.jpg", JPEG)
    write(c / ".cache" / "exams" / "midterm" / "mock-1-key.md", "# key\n")
    for n in (1, 2, 3):
        write(c / "study" / "slides" / f"SD-1-s{n:03d}.jpg", JPEG + bytes([n]))
    write(c / "study" / "slides" / "HW-1-s001.jpg", JPEG + b"h")
    write(c / "study" / "slides" / "Gone-s001.jpg", JPEG + b"g")
    write(c / "study" / "progress.md", "# Progress\n")
    write(c / "study" / "hub-state.json", {"v": 1, "decks": {}, "reviews": [], "chats": {}})
    write(c / "study" / "tutor-memory.md", "# What your tutor remembers\n")
    write(c / "study" / "exams" / "midterm" / "mock-1.md", "# mock\n")
    write(c / "labs" / "lab1" / "GUIDE.md", "# lab\n")
    write(c / "project" / "plan.md", "# plan\n")
    write(c / "project" / ".venv" / "lib" / "x.py", "x = 1\n")
    hub = old / "app" / "hub"
    write(hub / "tutor.py", 'STYLE = {"DEMO101": "a short demo question"}\n')
    write(hub / "library.py", "")
    write(hub / ".cache" / "chats" / "aaaaaaaaaaaa.json", {"id": "aaaaaaaaaaaa", "course": c.name, "messages": [
        {"role": "q", "text": "photo", "photos": [".cache/uploads/ask-0123456789ab.jpg"]}]})
    write(hub / ".cache" / "chats" / "bbbbbbbbbbbb.json", {"id": "bbbbbbbbbbbb", "course": "Gone-Course", "messages": []})
    write(hub / ".cache" / "practice" / "cccccccccccc.json", {"id": "cccccccccccc", "course": c.name, "photos": []})
    write(hub / ".cache" / "drafts.json", {c.name: {"text": "half", "rev": 3, "photos": [".cache/uploads/ask-0123456789ab.jpg"]}})
    write(hub / ".cache" / "hub.log", "log\n")
    return c


def test_migration(tmp):
    old, new = tmp / "old", tmp / "new"
    c = make_old_tree(old)
    before = {p.relative_to(old).as_posix(): hashlib.sha1(p.read_bytes()).hexdigest() for p in old.rglob("*") if p.is_file()}
    r = subprocess.run([sys.executable, str(REPO / "tools" / "migrate_old_layout.py"), str(old), str(new),
                        "--report", str(tmp / "migration.md")], capture_output=True, text=True, encoding="utf-8", errors="replace")
    check("migration: runs and verifies itself", r.returncode == 0 and "verification OK" in r.stdout, r.stdout[-800:] + r.stderr[-800:])
    after = {p.relative_to(old).as_posix(): hashlib.sha1(p.read_bytes()).hexdigest() for p in old.rglob("*") if p.is_file()}
    check("migration: the old tree is unchanged", before == after)
    report = (tmp / "migration.md").read_text(encoding="utf-8") if (tmp / "migration.md").is_file() else ""
    new_hashes = {hashlib.sha1(p.read_bytes()).hexdigest() for p in new.rglob("*") if p.is_file()}
    course_files = [k for k in before if k.startswith(c.name + "/") and "/.venv/" not in k]
    unaccounted = [k for k in course_files if f"`{k}`" not in report]
    check(f"migration: every course file ({len(course_files)}) is listed in the report", not unaccounted, unaccounted)
    lost = [k for k in course_files if before[k] not in new_hashes and not k.endswith("CLAUDE.md")]
    check("migration: every course file's bytes are in the new library (except the course CLAUDE.md, rewritten)", not lost, lost)
    check("migration: a virtual environment is skipped and reported", ".venv/" in report and
          not any("/.venv/" in p.as_posix() for p in new.rglob("*")))
    n = new / c.name
    expect = {"course.json": None, "CLAUDE.md": None, "me/notes/Week1/notes.md": None, "sources/Week1/handout.txt": None,
              "sources/Week1/Elasticity.pdf": None, "sources/practice/Practice-1.pdf": None, "sources/textbooks/Book.pdf": None,
              "textbooks/Book.txt": None, "textbooks/Book.toc.md": None, "me/uploads/ask-0123456789ab.jpg": None,
              "me/private/exams/midterm/mock-1-key.md": None, "me/progress.md": None, "me/hub-state.json": None,
              "me/tutor-memory.md": None, "me/notes/exams/midterm/mock-1.md": None, "me/notes/labs/lab1/GUIDE.md": None,
              "me/notes/project/plan.md": None, "me/chats/aaaaaaaaaaaa.json": None, "me/practice/cccccccccccc.json": None,
              "me/drafts.json": None, "decks/SD-1/s003.jpg": None, "decks/SD-1/transcript.md": None,
              "decks/HW-1/transcript.md": None, ".work/old-slides/Gone-s001.jpg": None}
    missing = [k for k in expect if not (n / k).is_file()]
    check("migration: every kind of file lands where the new layout keeps it", not missing, missing)
    check("migration: a chat of a course that isn't migrated is kept, filed in no course",
          (new / "_unassigned" / "chats" / "bbbbbbbbbbbb.json").is_file())
    cj = json.loads((n / "course.json").read_text(encoding="utf-8")) if (n / "course.json").is_file() else {}
    check("migration: course.json has the code, title, style and topics the old hub used",
          cj == {"code": "DEMO101", "title": "Intro Economics", "assessment_style": "a short demo question",
                 "topics": [{"name": "Supply and Demand", "read_more": "Chapter 2"}]}, cj)
    cm = (n / "CLAUDE.md").read_text(encoding="utf-8") if (n / "CLAUDE.md").is_file() else ""
    check("migration: the course CLAUDE.md loses its deck table, keeps the rest",
          "| Week | Deck |" not in cm and "| Topic | Read more |" in cm and "AI policy" in cm)
    chat = json.loads((n / "me/chats/aaaaaaaaaaaa.json").read_text(encoding="utf-8")) if (n / "me/chats/aaaaaaaaaaaa.json").is_file() else {}
    drafts = json.loads((n / "me/drafts.json").read_text(encoding="utf-8")) if (n / "me/drafts.json").is_file() else {}
    check("migration: upload paths in chats and drafts point at me/uploads",
          chat.get("messages", [{}])[0].get("photos") == ["me/uploads/ask-0123456789ab.jpg"] and
          drafts.get(c.name, {}).get("photos") == ["me/uploads/ask-0123456789ab.jpg"])
    got = py("""
import library as L
c = L.course_dirs()[0]
print(json.dumps({t: {k: d[k] for k in ("tag", "week", "topic", "order", "slides", "title", "prepared")}
                  for t, d in L.course_info(c)["decks"].items()} | {"_texts": L.slide_texts(c, "Markets-Intro")}))""", new)
    texts = got.pop("_texts")
    check("migration: the hub reads the decks with the old hub's facts", got == {
        "S&D-1": {"tag": "S&D-1", "week": 1, "topic": "Supply and Demand", "order": 0, "slides": 3, "title": "Price elasticity", "prepared": True},
        "Markets-Intro": {"tag": "Markets-Intro", "week": 2, "topic": "Not sorted yet", "order": 2, "slides": 2, "title": "Markets Intro", "prepared": False},
        "HW-1": {"tag": "HW-1", "week": 3, "topic": "Practice", "order": 1, "slides": 1, "title": "Homework 1", "prepared": True}}, got)
    check("migration: a deck without transcript went through Add (rough text, images)",
          all(s.get("raw") for s in texts) and "Markets_Intro page 1" in texts[0]["md"] and
          (n / "decks" / "Markets-Intro" / "s002.jpg").is_file(), texts[:1])
    r2 = subprocess.run([sys.executable, str(REPO / "tools" / "migrate_old_layout.py"), str(old), str(new)],
                        capture_output=True, text=True, encoding="utf-8", errors="replace")
    check("migration: refuses to overwrite an existing library without --overwrite", r2.returncode != 0 and "overwrite" in (r2.stdout + r2.stderr))


def test_gitignore(tmp):
    def ignored(paths):
        r = subprocess.run(["git", "-C", str(REPO), "check-ignore", "--no-index", "--stdin", "-z"],   # -z: no quoting
                           input="\0".join(paths).encode("utf-8"), capture_output=True)
        return set(r.stdout.decode("utf-8").split("\0")) - {""}
    lib = tmp / "split-lib"
    user = ["library/CLAUDE.md", "library/.claude/skills/x/SKILL.md", "config.json", ".cache/hub.log",
            ".cache/voice/model.bin", "__pycache__/x.pyc", "tests/__pycache__/x.pyc"]
    if lib.is_dir():        # every file of a course after a scripted drive, as it would sit in library/
        user += [f"library/{p.relative_to(lib).as_posix()}" for p in lib.rglob("*") if p.is_file()]
    got = ignored(user)
    check(f"gitignore: every user file is ignored ({len(user)} paths)", got == set(user), sorted(set(user) - got)[:5])
    kept = ["server.py", "tests/test_layout.py", "tests/verify/hubdrive.py", "example-library/Demo-Course/course.json",
            "static/app.js", ".claude/skills/preparing-slides/SKILL.md", "docs/library-format.md", "tools/migrate_old_layout.py"]
    check("gitignore: the code, tests, docs and example library are not ignored", not ignored(kept), ignored(kept))
    tracked_or_new = subprocess.run(["git", "-C", str(REPO), "ls-files", "--cached", "--others", "--exclude-standard"],
                                    capture_output=True, text=True, encoding="utf-8").stdout.splitlines()
    bad = [p for p in tracked_or_new if p.startswith(("library/", ".cache/", "config.json")) or "/me/chats/" in p]
    check("gitignore: git sees no user file in the working tree", not bad, bad[:5])


def main():
    base = REPO / ".cache"
    base.mkdir(exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="layout-", dir=base))
    try:
        lib = tmp / "lib"
        make_library(lib)
        test_location(tmp)
        test_facts_and_decks(lib)
        test_prompts_fallback(lib)
        test_notes_private_warmups(lib)
        test_guard(lib)
        test_migration(tmp)
        if not QUICK:
            test_data_split(tmp)
            test_skill()
        test_gitignore(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{len(FAILED)} failed" + (": " + ", ".join(FAILED) if FAILED else ""))
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
