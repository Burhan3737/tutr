"""Checks for the live course channel: Ask-box drafts and chat turns (drafts.py, /api/draft*, static/drafts.js). A plain script:

    python tests/test_drafts.py           # everything, including ~100 devices listening at once
    python tests/test_drafts.py --quick   # without the load check

Everything runs on a demo library in a temporary folder; no real course is touched. The browser-side merge and cursor checks run in Node.
"""
import base64, http.client, json, queue, shutil, subprocess, sys, tempfile, threading, time, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))     # the modules under test live in the repo root

import drafts as D
import library as L
import server

FAILED = []


class Patch:
    """Set attributes for the length of a with-block, then put them back."""
    def __init__(self, *triples):
        self.triples, self.old = triples, []

    def __enter__(self):
        for obj, name, value in self.triples:
            self.old.append((obj, name, getattr(obj, name)))
            setattr(obj, name, value)

    def __exit__(self, *exc):
        for obj, name, value in reversed(self.old):
            setattr(obj, name, value)


def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        FAILED.append(name)


# ------------------------------------------------------------ the store

class Ear:
    """A device listening to a course straight on the store: the first ask gets a snapshot, then take() is
    everything since (waiting up to `timeout`)."""
    def __init__(self, store, course, client):
        self.store, self.course, self.client = store, course, client
        self.last = store.poll(course, client, None, None, 0)
        self.snap = self.last["snapshot"]

    def take(self, timeout=0):
        self.last = self.store.poll(self.course, self.client, self.last["seq"], self.last["epoch"], timeout)
        return self.last["events"]


def test_store(tmp):
    s = D.Drafts(tmp / "d.json")
    check("store: an unknown course is empty at rev 0", s.get("C") == {"text": "", "rev": 0, "spoken": False, "by": "", "photos": []})
    qa, qb, qo = Ear(s, "C", "laptop"), Ear(s, "C", "phone"), Ear(s, "Other", "phone")
    check("store: listening starts with the draft now", qa.snap["draft"]["rev"] == 0 and qa.snap["turns"] == [])
    ok, d = s.save("C", "laptop", "How does", 0)
    check("store: a save on the current rev is accepted", ok and d["rev"] == 1 and d["text"] == "How does")
    check("store: the other device hears it", qb.take() == [("draft", d)])
    check("store: the sender doesn't hear its own change", qa.take() == [])
    check("store: another course doesn't hear it", qo.take() == [])
    ok, d = s.save("C", "phone", "How does it", 0)
    check("store: a save on an old rev is refused with the newer draft", not ok and d["rev"] == 1 and d["text"] == "How does")
    check("store: a refused save tells nobody", qa.take() == [] and qb.take() == [])
    ok, d = s.save("C", "laptop", "How does", 1)
    check("store: saving the same text again makes no new rev", ok and d["rev"] == 1 and qb.take() == [])
    ok, d = s.save("C", "phone", "How does it", 1, spoken=True)
    check("store: spoken is kept", ok and d["spoken"] and qa.take()[0][1]["spoken"])
    ok, d = s.save("C", "phone", "", 2, spoken=True)
    check("store: an empty draft is never spoken", ok and not d["spoken"])
    for bad, why in ((None, "not text"), ("x" * (D.MAX_TEXT + 1), "too long")):
        try:
            s.save("C", "phone", bad, 3)
            check(f"store: refuses a draft that is {why}", False)
        except D.DraftError:
            check(f"store: refuses a draft that is {why}", True)
    try:
        s.save("C", "phone", "x", "nope")
        check("store: refuses a save with no usable base", False)
    except D.DraftError:
        check("store: refuses a save with no usable base", True)
    check("store: devices count as listening while they ask", s.watchers("C") == 2 and s.watchers() == 3)

    # a waiting request is answered the moment something happens
    rev = s.get("C")["rev"]
    t0 = time.perf_counter()
    threading.Timer(0.2, lambda: s.save("C", "laptop", "now", rev)).start()
    got = qb.take(5)
    took = time.perf_counter() - t0
    check("store: a waiting request is answered as soon as there's a change", got and got[-1][1]["text"] == "now" and took < 1, f"{took:.2f}s")
    t0 = time.perf_counter()
    check("store: nothing new is answered empty when the wait is up", qb.take(0.2) == [] and time.perf_counter() - t0 >= 0.19)
    # newest-only: a slow reader skips straight to the latest text
    q = Ear(s, "C", "slow")
    rev = s.get("C")["rev"]
    for i in range(5):
        rev = s.save("C", "fast", f"v{i}", rev)[1]["rev"]
    check("store: a slow reader gets only the newest change", q.take() == [("draft", s.get("C"))])
    # too far behind, or another run of the hub: a snapshot
    for i in range(D.LOG_SIZE + 1):
        rev = s.save("C", "fast", f"w{i}", rev)[1]["rev"]
    q.take()
    check("store: a device too far behind gets a snapshot", q.last["snapshot"] and q.last["snapshot"]["draft"]["text"] == s.get("C")["text"])
    r = s.poll("C", "slow", q.last["seq"], "another-run", 0)
    check("store: numbers from another run of the hub get a snapshot", r["snapshot"] is not None)
    check("store: …and so do numbers from the future", s.poll("C", "slow", s.poll("C", "x", None, None, 0)["seq"] + 5, s.epoch, 0)["snapshot"] is not None)

    # tutor turns: everyone hears them (the asking device knows its own by id); a late listener gets the text so far
    q1 = Ear(s, "C", "laptop")
    turn = s.turn_start("C", {"turn": "abc123", "mode": "ask", "question": "Why?", "tag": "D1", "n": 3, "spoken": False})
    check("store: a turn keeps the id the asking device gave it", turn == "abc123")
    s.turn_event("C", turn, "status", "Reading the slides")
    s.turn_event("C", turn, "text", "Because ")
    s.turn_event("C", turn, "text", "of this.")
    s.turn_event("C", turn, "bogus", "x")
    ev = q1.take()
    check("store: a turn's start, status and text reach every device, text pieces joined",
          [k for k, _ in ev] == ["turn_start", "turn_status", "turn_text"] and ev[0][1]["question"] == "Why?"
          and ev[2][1] == {"turn": "abc123", "text": "Because of this."}, ev)
    turns = Ear(s, "C", "late").snap["turns"]
    check("store: a device listening from mid-answer gets the turn with its text so far",
          len(turns) == 1 and turns[0]["text"] == "Because of this." and turns[0]["status"] == "Reading the slides")
    s.turn_end("C", turn, chat="0123456789ab")
    check("store: the end says which chat it was saved in", q1.take() == [("turn_done", {"turn": "abc123", "chat": "0123456789ab"})])
    check("store: a finished turn isn't in the next snapshot", Ear(s, "C", "later").snap["turns"] == [])
    t2 = s.turn_start("C", {"turn": "bad id!", "mode": "ask", "question": "?", "tag": "D1", "n": 1})
    check("store: a turn with an unusable id gets one", t2 != "bad id!" and len(t2) == 16)
    s.turn_end("C", t2, error="Claude is busy")
    ev = q1.take()
    check("store: a failed turn says why", ev[-1] == ("turn_error", {"turn": t2, "error": "Claude is busy"}))
    s.chat_switched("C", None, "laptop")
    check("store: a chat switch isn't sent back to the device that made it", q1.take() == [])
    q2 = Ear(s, "C", "phone2")
    s.chat_switched("C", "0123456789ab", "laptop")
    check("store: a chat switch reaches the others", q2.take() == [("chat", {"chat": "0123456789ab", "client": "laptop"})])

    # photos: added and removed one at a time, every device told (the one that added it too); sending takes them
    qp = Ear(s, "P", "phone")
    rev0 = s.get("P")["rev"]
    d = s.add_photo("P", "laptop", "me/uploads/ask-a.jpg")
    check("store: a photo added is in the draft, with a new rev", d["photos"] == ["me/uploads/ask-a.jpg"] and d["rev"] == rev0 + 1)
    check("store: every device hears of it", qp.take() == [("draft", d)])
    ok, t = s.save("P", "laptop", "what about this?", d["rev"])
    check("store: typing keeps the photos", ok and t["photos"] == ["me/uploads/ask-a.jpg"])
    s.add_photo("P", "phone", "me/uploads/ask-b.jpg")
    ok, t = s.save("P", "laptop", "stale", d["rev"])
    check("store: a photo added elsewhere makes an older text save stale (it merges and saves again)", not ok)
    gone, d = s.remove_photo("P", "laptop", "me/uploads/ask-a.jpg")
    check("store: a photo removed", gone and d["photos"] == ["me/uploads/ask-b.jpg"])
    check("store: removing one that isn't there changes nothing", s.remove_photo("P", "laptop", "nope")[0] is False)
    for i in range(D.MAX_PHOTOS - 1):
        s.add_photo("P", "x", f"me/uploads/ask-{i}.jpg")
    try:
        s.add_photo("P", "x", "me/uploads/ask-too-many.jpg")
        check("store: no more than MAX_PHOTOS", False)
    except D.DraftError:
        check("store: no more than MAX_PHOTOS", True)
    qp.take()
    took = s.take_photos("P", ["me/uploads/ask-b.jpg", "me/uploads/ask-0.jpg", "not-attached"])
    check("store: sending takes the photos it went with (only those attached), in order",
          took == ["me/uploads/ask-b.jpg", "me/uploads/ask-0.jpg"] and "me/uploads/ask-b.jpg" not in s.get("P")["photos"])
    check("store: and every device's box loses them", qp.take()[-1][1]["photos"] == s.get("P")["photos"])

    s.flush()
    again = D.Drafts(tmp / "d.json")
    check("store: drafts survive a restart", again.get("C") == s.get("C") and again.get("P")["photos"] == s.get("P")["photos"])
    (tmp / "bad.json").write_text("{not json", encoding="utf-8")
    check("store: an unreadable file starts empty", D.Drafts(tmp / "bad.json").get("C")["rev"] == 0)

    s2 = D.Drafts(tmp / "later.json")
    s2.save("C", "a", "soon", 0)
    time.sleep(D.SAVE_DELAY + 0.5)
    check("store: written to disk about a second after a change", (tmp / "later.json").exists())

    # each course's draft in its own file (the hub's: <course>/me/drafts.json), read the first time it's asked about
    files = {"A": tmp / "A" / "me" / "drafts.json", "B": tmp / "B" / "me" / "drafts.json"}
    s3 = D.Drafts(path_for=files.get)
    s3.save("A", "laptop", "a question for A", 0)
    s3.save("B", "laptop", "one for B", 0)
    s3.save("nope", "laptop", "a course with no folder", 0)
    s3.flush()
    on_disk = {c: json.loads(f.read_text(encoding="utf-8")) for c, f in files.items() if f.exists()}
    check("store per course: each course's draft in its own file, as {course: draft}",
          set(on_disk) == {"A", "B"} and on_disk["A"]["A"]["text"] == "a question for A" and set(on_disk["B"]) == {"B"}, on_disk)
    check("store per course: nothing written for a course with no file", not list(tmp.glob("nope*")))
    s4 = D.Drafts(path_for=files.get)
    check("store per course: read back after a restart", s4.get("A")["text"] == "a question for A" and s4.get("B")["rev"] == 1)
    ok, d = s4.save("B", "phone", "one for B, changed", 1)
    check("store per course: a save builds on the draft read back", ok and d["rev"] == 2)


# ------------------------------------------------------------ the library (library.py): a demo course in the new layout

JPEG = bytes.fromhex("ffd8ffe000104a464946") + b"demo"


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def demo_deck(cdir, tag, slides=None, **facts):
    """decks/<safe tag>/: deck.json, transcript.md (slides: {n: title}; None = no transcript) and one image per page."""
    d = cdir / "decks" / L.safe_tag(tag)
    write(d / "deck.json", json.dumps({"tag": tag, **facts}))
    if slides is not None:
        write(d / "transcript.md", f"# {tag}\n\n" + "".join(f"## [{tag} s{n}] {t}\nType: content\n\nAbout {t}.\n\n"
                                                           for n, t in slides.items()))
    for n in range(1, facts.get("pages", 0) + 1):
        (d / f"s{n:03d}.jpg").write_bytes(JPEG)
    return d


def build_demo(lib):
    """A library with one demo course in the new layout (and a folder that isn't a course)."""
    c = lib / "Demo-Course"
    write(c / "course.json", json.dumps({
        "code": "DEMO101", "title": "Demo Course", "assessment_style": "a short scenario question about a market",
        "topics": [{"name": "Supply and Demand", "read_more": "Demo textbook ch. 2"}, {"name": "Elasticity", "read_more": ""},
                   {"name": "Never taught", "read_more": "ch. 9"}]}))
    write(c / "CLAUDE.md", "# Demo-Course\n\nProse for Claude only.\n")
    demo_deck(c, "S&D-1", {1: "Supply and Demand", 3: "Price elasticity"}, title="Supply and Demand 1", role="lecture",
              week=1, topic="Supply and Demand", order=0, pages=3, prepared=True, source="sources/Week1/sd1.pdf")
    demo_deck(c, "S&D-2", {1: "Elasticity in practice", 2: "Cross elasticity"}, title="Elasticity 2", role="lecture",
              week=2, topic="Elasticity", order=1, pages=2, prepared=True)
    demo_deck(c, "S&D-3", {1: "Price elasticity of demand", 2: "Elastic or inelastic"}, title="Elasticity 1", role="lecture",
              week=1, topic="Elasticity", order=5, pages=2, prepared=True)
    demo_deck(c, "New-deck", {1: "Shifts of the demand curve", 2: "Raw text"}, title="New deck", role="lecture",
              week=2, topic="Unsorted", order=2, pages=2, prepared=False)
    demo_deck(c, "S&D-4", None, title="No transcript yet", role="lecture", week=3, topic="", order=6, pages=2, prepared=False)
    demo_deck(c, "HW1", {1: "Homework 1"}, title="Homework 1", role="practice", week=2, topic="", order=3, pages=1, prepared=True)
    demo_deck(c, "PE-1", {1: "Practice exam"}, title="Practice exam", role="practice", week=1, topic="", order=4, pages=1,
              prepared=True)
    write(c / "decks" / "broken" / "deck.json", "{not json")
    (c / "decks" / L.safe_tag("S&D-1") / "s002.jpg").unlink()      # an image missing
    write(c / "textbooks" / "Demo.toc.md", "# Contents\n")
    write(c / "textbooks" / "Demo.txt", "===== Demo PAGE 1 =====\nPrice elasticity\n")
    write(c / "me" / "progress.md", "# Progress\n\n## Deadlines\n\n| Date | Item | Weight | Status | Covers |\n|---|---|---|---|---|\n"
          "| Dec 20 | **Midterm** — written | 30% | upcoming | W1–2 |\n")
    write(c / "me" / "tutor-memory.md", "# What your tutor remembers\n\n## About me\n- (nothing yet)\n")
    write(c / "me" / "notes" / "Week2" / "notes.md", "Week 2 notes\n")
    write(c / "me" / "notes" / "Week1" / "notes.md", "Week 1 notes\n")
    write(c / "me" / "notes" / "Week1" / "notes.txt", "Week 1, typed\n")
    write(c / "me" / "notes" / "Week1" / "empty.md", "")
    write(c / "me" / "notes" / "exams" / "midterm" / "mock-1.md", "# Mock 1\n")
    write(c / "me" / "notes" / "exams" / "midterm" / "cheatsheet.md", "# Cheat sheet\n")
    write(c / "me" / "notes" / "labs" / "lab1" / "GUIDE.md", "# Lab 1\n")
    write(c / "me" / "notes" / "labs" / "lab1" / "readme.txt", "lab readme\n")
    write(c / "me" / "notes" / "labs" / "lab1" / "sub" / "deeper.md", "nested\n")
    write(c / "me" / "notes" / "assignments" / "a1" / "PLAN.md", "# Plan\n")
    write(c / "me" / "notes" / "readings" / "loose.md", "# Loose\n")
    write(c / "me" / "notes" / "readings" / "r1" / "summary.md", "# Summary\n")
    write(c / "me" / "private" / "exams" / "midterm" / "mock-1-key.md", "# Answer key\n")
    write(c / ".work" / "scratch.md", "scratch\n")
    write(lib / "Not-a-course" / "decks" / "X" / "deck.json", json.dumps({"tag": "X", "pages": 1}))
    return c


def test_library(lib):
    c = lib / "Demo-Course"
    check("library: a course is a folder with a course.json", L.course_dirs() == [c] and L.course_dir("Not-a-course") is None)
    info = L.course_info(c)
    check("library: code and title from course.json", (info["code"], info["title"]) == ("DEMO101", "Demo Course"))
    topics = [(t["name"], t["read_more"], t["decks"]) for t in info["topics"]]
    check("library: topics in order of their first deck, Read more from course.json, unsorted last", topics == [
        ("Supply and Demand", "Demo textbook ch. 2", ["S&D-1"]), ("Elasticity", "", ["S&D-3", "S&D-2"]),
        (L.UNSORTED, "", ["New-deck", "S&D-4"])], topics)
    check("library: practice decks listed apart, in lecture order", info["practice"] == ["PE-1", "HW1"], info["practice"])
    check("library: lecture order is week, then order", [d["tag"] for d in L.deck_order(c)] ==
          ["S&D-1", "PE-1", "S&D-3", "S&D-2", "New-deck", "HW1", "S&D-4"], [d["tag"] for d in L.deck_order(c)])
    d = L.deck(c, "S&D-1")
    check("library: a deck's facts come from deck.json", (d["title"], d["week"], d["slides"], d["topic"], d["order"], d["prepared"],
          d["transcript"]) == ("Supply and Demand 1", 1, 3, "Supply and Demand", 0, True, "decks/SD-1/transcript.md"), d)
    check("library: a practice deck's topic is Practice", L.deck(c, "HW1")["topic"] == L.PRACTICE_NAME)
    check("library: a broken deck.json is skipped", "broken" not in info["decks"] and len(info["decks"]) == 7)
    pub = server._deck_public(L.deck(c, "New-deck"))
    check("library: the public deck row keeps its shape, prepared from deck.json",
          set(pub) == {"tag", "title", "week", "slides", "topic", "order", "prepared"} and pub["prepared"] is False, pub)
    v = server.deck_view(c, "HW1")
    check("library: a practice deck's siblings are the practice decks", v["topic_decks"] == ["PE-1", "HW1"] and v["read_more"] == "")
    v = server.deck_view(c, "S&D-1")
    check("library: a lecture deck's siblings and Read more are its topic's",
          v["topic_decks"] == ["S&D-1"] and v["read_more"] == "Demo textbook ch. 2")
    t = L.slide_texts(c, "S&D-1")
    check("library: slide texts from the transcript, one per page (a missing section is empty)",
          [(x["n"], x["title"], x["md"]) for x in t] == [(1, "Supply and Demand", "About Supply and Demand."), (2, "", ""),
                                                          (3, "Price elasticity", "About Price elasticity.")], t)
    check("library: a prepared deck's slides aren't raw", not any(x.get("raw") for x in t))
    check("library: a deck not fully prepared shows its rough transcript as raw text",
          all(x.get("raw") for x in L.slide_texts(c, "New-deck")))
    check("library: a deck with no transcript has empty texts", L.slide_texts(c, "S&D-4") == [
        {"n": 1, "title": "", "md": ""}, {"n": 2, "title": "", "md": ""}])
    check("library: slide images from decks/<folder>/sNNN.jpg", L.slide_image(c, "S&D-1", 3) == c / "decks" / "SD-1" / "s003.jpg")
    check("library: a missing image or page is None", L.slide_image(c, "S&D-1", 2) is None and L.slide_image(c, "S&D-1", 4) is None
          and L.slide_image(c, "nope", 1) is None)
    check("library: class notes from me/notes/WeekN, by week, empty files left out", L.class_notes(c) == [
        {"week": 1, "name": "notes.md", "path": "me/notes/Week1/notes.md"},
        {"week": 1, "name": "notes.txt", "path": "me/notes/Week1/notes.txt"},
        {"week": 2, "name": "notes.md", "path": "me/notes/Week2/notes.md"}], L.class_notes(c))
    docs = [(g["kind"], g["name"], [f["path"] for f in g["files"]]) for g in L.other_docs(c)]
    check("library: documents grouped by me/notes/ folder: exams, labs, assignments, then others, then the tutor's notes", docs == [
        ("exams", "midterm", ["me/notes/exams/midterm/cheatsheet.md", "me/notes/exams/midterm/mock-1.md"]),
        ("labs", "lab1", ["me/notes/labs/lab1/GUIDE.md"]),
        ("assignments", "a1", ["me/notes/assignments/a1/PLAN.md"]),
        ("readings", "", ["me/notes/readings/loose.md"]),
        ("readings", "r1", ["me/notes/readings/r1/summary.md"]),
        ("tutor", "", ["me/tutor-memory.md"])], docs)
    check("library: notes, documents and the tutor's notes can be read", all(L.readable_doc(c, p) for p in (
        "me/notes/Week1/notes.txt", "me/notes/exams/midterm/mock-1.md", "me/tutor-memory.md")))
    check("library: me/private and everything else can't", not any(L.readable_doc(c, p) for p in (
        "me/private/exams/midterm/mock-1-key.md", "me/notes/../private/exams/midterm/mock-1-key.md", "me/hub-state.json",
        "me/progress.md", "course.json", "decks/SD-1/transcript.md")))
    m = L.course_map(c)
    check("library: the course map names the new paths", all(x in m for x in (
        "# DEMO101 Demo Course", "`me/progress.md`", "`decks/SD-1/transcript.md`, 3 slides",
        "## Topic: Supply and Demand (read more: Demo textbook ch. 2)", "`decks/SD-4/ (no transcript yet: slide images only)`",
        "- [HW1] W2 Homework 1: `decks/HW1/transcript.md`, 1 pages", "full text in `textbooks/<name>.txt`",
        "- `textbooks/Demo.toc.md`", "- W1: `me/notes/Week1/notes.md`", "- `me/notes/labs/lab1/sub/deeper.md`",
        "- `me/notes/labs/lab1/readme.txt`"))
          and ".cache" not in m and "study/" not in m and "private" not in m, m)
    nxt = L.next_assessment(c)
    check("library: the next test and its topics from me/progress.md", nxt and nxt["name"] == "Midterm" and nxt["weeks"] == [1, 2]
          and nxt["topics"] == ["Supply and Demand", "Elasticity"], nxt)
    hits = L.search("cross elasticity")
    check("library: search finds a slide", [(h["deck"], h["slide"]) for h in hits] == [("S&D-2", 2)], hits)

    import asyncio, engine as E
    root = c.resolve()
    hook = E._confine(root)
    ask = lambda tool, **args: asyncio.run(hook({"tool_name": tool, "tool_input": args}, None, None))
    denied = lambda r: r.get("hookSpecificOutput", {}).get("permissionDecision") == "deny"
    check("guard: a course file can be read", not denied(ask("Read", file_path=str(root / "decks" / "SD-1" / "transcript.md"))))
    check("guard: me/private can't, however it's reached", all(denied(r) for r in (
        ask("Read", file_path=str(root / "me" / "private" / "exams" / "midterm" / "mock-1-key.md")),
        ask("Read", file_path="me/notes/../private/exams/midterm/mock-1-key.md"),
        ask("Glob", pattern="me/private/**/*.md"), ask("Grep", pattern="key", path="me/private"))))
    odd = lib.parent / "CaseCourse"         # a private folder spelt with capitals on disk
    write(odd / "me" / "Private" / "key.md", "# key")
    check("guard: me/private in any letter case", all(E._private(odd.resolve(), v) for v in (
        "me/private/key.md", "me/Private/key.md", "ME/PRIVATE/key.md", str(odd.resolve() / "me" / "private" / "key.md")))
          and all(E._private(root, v) for v in ("me/Private/x.md", "Me/private/exams/x.md"))
          and not E._private(root, "me/notes/Week1/notes.md"))
    import opencode_engine as O
    for web in (False, True):
        rules = O._permissions(web)
        last_allow = max(i for i, r in enumerate(rules) if r["effect"] == "allow" and r["action"] in ("read", "glob", "grep"))
        denies = {(r["action"], r["resource"]) for r in rules[last_allow + 1:] if r["effect"] == "deny"}
        want = {(a, f"*{m}{s}{p}*") for a in ("read", "glob", "grep") for s in ("/", chr(92)) for m in ("me", "Me", "ME")
                for p in ("private", "Private", "PRIVATE")}
        check(f"opencode: me/private denied after the allows, both separators and cases (web={web})", want <= denies,
              sorted(want - denies)[:5])
    check("guard: outside the course still refused", denied(ask("Read", file_path=str(root.parent / "Not-a-course" / "x.md"))))
    check("status line: a transcript read names its deck folder",
          E.describe("Read", {"file_path": str(root / "decks" / "SD-1" / "transcript.md")}, root) == "Reading the SD-1 slides")
    check("status line: textbooks, class notes, photos", (
        E.describe("Read", {"file_path": "textbooks/Demo.txt"}, root), E.describe("Read", {"file_path": "me/notes/Week1/notes.md"}, root),
        E.describe("Read", {"file_path": "me/uploads/ask-1.jpg"}, root)) ==
        ("Looking in Demo", "Reading your class notes", "Looking at your photo"))


# ------------------------------------------------------------ the browser's merge and cursor (Node)

JS_TESTS = r"""
const { draftMerge: M, draftCaret: C } = require(process.argv[1]);
const out = [];
const t = (name, got, want) => out.push([name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`]);
t("merge: only theirs changed", M("ab", "ab", "abc"), "abc");
t("merge: only mine changed", M("ab", "abX", "ab"), "abX");
t("merge: both the same", M("ab", "abc", "abc"), "abc");
t("merge: mine at the start, theirs at the end", M("hello world", ">hello world", "hello world!"), ">hello world!");
t("merge: theirs at the start, mine at the end", M("hello world", "hello world!", ">hello world"), ">hello world!");
t("merge: both typed at the end: theirs, then mine", M("Q: ", "Q: mine", "Q: theirs"), "Q: theirsmine");
t("merge: overlapping edits: the hub's copy wins", M("the cat sat", "the dog sat", "the cow sat"), "the cow sat");
t("merge: sent here (emptied) while they added at the end", M("ask", "", "ask more"), " more");
t("merge: a deletion here and an insertion there", M("one two three", "one three", "one two three four"), "one three four");
t("caret: before the change stays", C("abc", "abXc", 1), 1);
t("caret: after the change shifts", C("abc", "Xabc", 3), 4);
t("caret: at the end stays before text the other device added after it", C("abc", "abcd", 3), 3);
t("caret: inside a replaced part goes to its end", C("the cat sat", "the dog sat", 5), 7);
t("caret: after a deletion shifts back", C("one two three", "one three", 13), 9);
console.log(JSON.stringify(out));
"""


def test_js():
    node = shutil.which("node")
    if not node:
        print("skip  js: Node isn't installed")
        return
    r = subprocess.run([node, "-e", JS_TESTS, str(REPO / "static" / "drafts.js")], capture_output=True, text=True, timeout=30)
    if r.returncode:
        check("js: the checks ran", False, r.stderr.strip()[:300])
        return
    for name, ok, detail in json.loads(r.stdout):
        check(f"js {name}", ok, detail)


# ------------------------------------------------------------ the course's chat, once per course

def test_course_chat():
    courses = L.course_dirs()
    if not courses:
        print("skip  chat: no course folders found")
        return
    c = courses[0]
    tag = next(iter(L.course_info(c)["decks"]))
    chat = {"id": "aaaaaaaaaaaa", "course": c.name, "deck": tag, "session": "secret",
            "messages": [{"role": "q", "slide": 3, "text": "?"}, {"role": "a", "text": "!"}]}
    listed = [{"id": f"{i:012d}", "title": f"c{i}", "course": c.name} for i in range(7)] + [{"id": chat["id"], "course": c.name}]
    with Patch((server.T, "current_chat", lambda cdir: chat["id"]), (server.T, "load_chat", lambda i: chat if i == chat["id"] else None),
               (server.T, "course_chats", lambda cdir: listed)):
        v = server.deck_view(c, tag)
        check("chat: a deck no longer carries the chat", v and not {"chat", "chats", "asked"} & v.keys() and "state" in v, v and sorted(v))
        r = server.course_chat(c)
        check("chat: the course's chat, without its session", r["chat"]["id"] == chat["id"] and "session" not in r["chat"])
        check("chat: up to five earlier chats, not the current one", [x["id"] for x in r["chats"]] == [f"{i:012d}" for i in range(5)])
    with Patch((server.T, "current_chat", lambda cdir: None), (server.T, "course_chats", lambda cdir: listed[:2])):
        check("chat: none yet", server.course_chat(c) == {"chat": None, "chats": listed[:2]})


# ------------------------------------------------------------ the hub's endpoints

class Live:
    """A device listening over HTTP: long polls /api/live on a thread, its news queued as (event, data, time). A
    snapshot comes as ("snapshot", draft) then a turn_start per turn being answered. pings: empty answers."""
    def __init__(self, port, course, client):
        self.port, self.course, self.client = port, course, client
        self.events, self.pings, self.stopped, self.conn = queue.Queue(), 0, False, None
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        since = epoch = None
        while not self.stopped:
            try:
                self.conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
                after = f"&since={since}&epoch={epoch}" if since is not None else ""
                self.conn.request("GET", f"/api/live?course={self.course}&client={self.client}{after}")
                r = json.loads(self.conn.getresponse().read())
                self.conn.close()
            except (OSError, ValueError):
                if self.stopped:
                    return
                time.sleep(0.2)
                continue
            now = time.perf_counter()
            since, epoch = r["seq"], r["epoch"]
            if r["snapshot"]:
                self.events.put(("snapshot", r["snapshot"]["draft"], now))
                for t in r["snapshot"]["turns"]:
                    self.events.put(("turn_start", t, now))
            elif not r["events"]:
                self.pings += 1
            for kind, data in r["events"]:
                self.events.put((kind, data, now))

    def next(self, timeout=3):
        return self.events.get(timeout=timeout)

    def close(self):
        self.stopped = True
        try:
            self.conn and self.conn.sock and self.conn.sock.close()
        except OSError:
            pass


def post(port, body, path="/api/draft"):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    c.request("POST", path, json.dumps(body), {"Content-Type": "application/json"})
    r = c.getresponse()
    out = r.status, json.loads(r.read() or b"{}")
    c.close()
    return out


def wait_for(cond, timeout=3):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return cond()


def test_http(tmp, load):
    courses = L.course_dirs()
    if not courses:
        print("skip  http: no course folders found")
        return
    course = courses[0].name
    server.DRAFTS = D.Drafts(path_for=server._drafts_file)     # as the hub keeps them: <course>/me/drafts.json
    D.POLL_SECONDS = 0.5
    srv = server.Server(("127.0.0.1", 0), server.Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        laptop, phone = Live(port, course, "laptop"), Live(port, course, "phone")
        k, d, _ = laptop.next()
        check("http: a device first gets a snapshot", k == "snapshot" and d["rev"] == 0)
        phone.next()
        st, r = post(port, {"course": course, "client": "laptop", "text": "How does price", "base": 0})
        check("http: a save is accepted", st == 200 and r["ok"] and r["rev"] == 1)
        k, d, _ = phone.next()
        check("http: the other device gets the change", k == "draft" and d["text"] == "How does price")
        check("http: the device that typed it doesn't", laptop.events.empty())
        st, r = post(port, {"course": course, "client": "phone", "text": "stale", "base": 0})
        check("http: a stale save gets the newer draft back", st == 200 and not r["ok"] and r["text"] == "How does price")
        st, r = post(port, {"course": course, "client": "phone", "text": "How does price elasticity", "base": 1, "spoken": True})
        k, d, _ = laptop.next()
        check("http: the phone's change reaches the laptop", r["ok"] and d["text"].endswith("elasticity") and d["spoken"])
        late = Live(port, course, "tablet")
        k, d, _ = late.next()
        check("http: a device opening later gets the text so far", k == "snapshot" and d["text"].endswith("elasticity") and d["rev"] == 2)
        st, r = post(port, {"course": course, "client": "laptop", "text": "", "base": 2})
        check("http: sending (emptying) reaches every other device",
              phone.next()[1]["text"] == "" and late.next()[1]["text"] == "")
        check("http: a request with nothing new is answered empty when its wait is up", wait_for(lambda: laptop.pings >= 1, 2))
        st, r = post(port, {"course": "nope", "client": "laptop", "text": "x", "base": 0})
        check("http: an unknown course is refused", st == 404)
        st, r = post(port, {"course": course, "client": "laptop", "text": "x" * (D.MAX_TEXT + 1), "base": 3})
        check("http: a draft that's too long is refused", st == 400)
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        c.request("GET", "/api/live?course=nope&client=x")
        check("http: listening to an unknown course is refused", c.getresponse().status == 404)
        c.close()
        r = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/course/chat?course={course}").read())
        check("http: the course's chat comes on its own", set(r) == {"chat", "chats"})
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        c.request("GET", "/api/course/chat?course=nope")
        check("http: an unknown course's chat is refused", c.getresponse().status == 404)
        c.close()
        def get(url):
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            c.request("GET", url)
            r = c.getresponse()
            out = r.status, r.getheader("Content-Type"), r.read()
            c.close()
            return out
        st, _, body = get(f"/api/course?id={course}")
        r = json.loads(body)
        check("http: a course keeps its JSON shape", st == 200 and set(r) == {"id", "code", "title", "next", "reviews", "topics",
              "practice", "resume", "notes", "docs"} and [d["tag"] for d in r["practice"]] == ["PE-1", "HW1"], sorted(r))
        st, ctype, body = get(f"/api/slide?course={course}&tag=S%26D-1&n=1")
        check("http: a slide image comes from decks/<folder>/", st == 200 and ctype == "image/jpeg" and body == JPEG)
        check("http: a missing slide image is a 404", get(f"/api/slide?course={course}&tag=S%26D-1&n=2")[0] == 404)
        st, _, body = get(f"/api/note?course={course}&path=me/notes/exams/midterm/mock-1.md")
        check("http: a note is served", st == 200 and body.decode().strip() == "# Mock 1", body)
        for p in ("me/private/exams/midterm/mock-1-key.md", "me/notes/../private/exams/midterm/mock-1-key.md", "me/hub-state.json"):
            check(f"http: never served: {p}", get(f"/api/note?course={course}&path={p}")[0] == 404)

        # a question sent from the phone: the laptop sees it start, stream and land (Claude replaced by a fake)
        tag = next(iter(L.course_info(courses[0])["decks"]))
        go, mid = threading.Event(), threading.Event()
        def fake_turn(cdir, tag_, n, mode, q, model, web, emit=None, **kw):
            emit("status", "Reading the slides")
            emit("text", "The answer ")
            mid.set()
            go.wait(5)
            emit("text", "is 42.")
            return {"id": "0123456789ab"}, {"role": "a", "text": "The answer is 42."}
        with Patch((server.T, "chat_turn", fake_turn)):
            asked = threading.Thread(target=lambda: post(port, {"course": course, "tag": tag, "n": 2, "mode": "ask",
                                                                 "question": "What is it?", "turn": "phoneturn1", "client": "phone"},
                                                         "/api/tutor"), daemon=True)
            asked.start()
            k, d, _ = laptop.next()
            check("http: a question sent on the phone shows on the laptop at once",
                  k == "turn_start" and d["question"] == "What is it?" and d["turn"] == "phoneturn1" and d["n"] == 2)
            mid.wait(5)
            k2, d2, _ = laptop.next()
            k3, d3, _ = laptop.next()
            check("http: its status and text stream to the laptop", (k2, d2["text"], k3, d3["text"]) ==
                  ("turn_status", "Reading the slides", "turn_text", "The answer "), (k2, d2, k3, d3))
            mid_join = Live(port, course, "tablet2")
            mid_join.next()
            k, d, _ = mid_join.next()
            check("http: a device opening mid-answer gets the answer so far", k == "turn_start" and d["text"] == "The answer ")
            r = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/live?course={course}&client=t9").read())
            check("http: a snapshot says which chat is the course's", "chat" in r["snapshot"])
            go.set()
            asked.join(5)
            got = [laptop.next()[:2] for _ in range(2)]
            check("http: the rest of the answer, then where it was saved",
                  got == [("turn_text", {"turn": "phoneturn1", "text": "is 42."}),
                          ("turn_done", {"turn": "phoneturn1", "chat": "0123456789ab"})], got)
            mid_join.close()
        def failing_turn(*a, **kw):
            raise server.T.TutorError("Claude is busy.", 503)
        with Patch((server.T, "chat_turn", failing_turn)):
            st, _ = post(port, {"course": course, "tag": tag, "n": 1, "mode": "ask", "question": "x", "turn": "t2", "client": "phone"}, "/api/tutor")
            got = [laptop.next()[:2] for _ in range(2)]
            check("http: a failed turn tells the other devices why",
                  st == 503 and got[1] == ("turn_error", {"turn": "t2", "error": "Claude is busy."}), (st, got))
        # photos in the Ask box: attached on the phone, shown on the laptop, sent with the laptop's question
        png = "data:image/png;base64," + base64.b64encode(bytes.fromhex(
            "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
            "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")).decode()
        made = []
        def drain(*devs):
            for dev in devs:
                while True:
                    try: dev.next(0.3)
                    except queue.Empty: break
        drain(laptop, phone)
        try:
            st, d = post(port, {"course": course, "client": "phone", "data": png}, "/api/draft/photo")
            made += d.get("photos", [])
            check("http: a photo attached on the phone is saved in the draft", st == 200 and len(d["photos"]) == 1, (st, d))
            k, e, _ = laptop.next()
            check("http: the laptop sees it at once", k == "draft" and e["photos"] == d["photos"])
            phone.next()
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            c.request("GET", f"/api/upload?course={course}&path={d['photos'][0]}")
            r = c.getresponse()
            check("http: the photo can be shown", r.status == 200 and r.getheader("Content-Type") == "image/png" and r.read()[1:4] == b"PNG")
            c.request("GET", f"/api/upload?course={course}&path=me/uploads/../hub-state.json")
            r = c.getresponse(); r.read()
            check("http: nothing but an uploaded photo is served", r.status == 404)
            c.close()
            st, e = post(port, {"course": course, "client": "phone", "data": "data:text/plain;base64,aGk="}, "/api/draft/photo")
            check("http: something that isn't an image is refused", st == 400)
            seen = {}
            def photo_turn(cdir, tag_, n, mode, q, model, web, emit=None, **kw):
                seen.update(kw)
                return {"id": "0123456789ab"}, {"role": "a", "text": "Looks right."}
            with Patch((server.T, "chat_turn", photo_turn)):
                st, _ = post(port, {"course": course, "tag": tag, "n": 1, "mode": "drill_reply", "question": "", "photos": d["photos"],
                                    "turn": "lap1", "client": "laptop"}, "/api/tutor")
            evs = [phone.next()[:2] for _ in range(3)]
            check("http: a question with just a photo goes, in any mode, with the photo", st == 200 and seen.get("photos") == d["photos"], (st, seen))
            check("http: sending empties the photos on every device, and the turn shows them",
                  evs[0][0] == "draft" and evs[0][1]["photos"] == [] and evs[1][0] == "turn_start" and evs[1][1]["photos"] == d["photos"], evs)
            laptop.next(); laptop.next(); laptop.next()
            st, d2 = post(port, {"course": course, "client": "phone", "data": png}, "/api/draft/photo")
            made += d2["photos"]
            laptop.next(); phone.next()
            with Patch((server.T, "chat_turn", failing_turn)):
                post(port, {"course": course, "tag": tag, "n": 1, "mode": "ask", "question": "x", "photos": d2["photos"], "turn": "t3", "client": "laptop"}, "/api/tutor")
            check("http: a failed question puts its photos back", wait_for(lambda: server.DRAFTS.get(course)["photos"] == d2["photos"]))
            st, d3 = post(port, {"course": course, "client": "laptop", "path": d2["photos"][0]}, "/api/draft/photo/remove")
            check("http: removing a photo takes it off and deletes it",
                  d3["photos"] == [] and not (courses[0] / d2["photos"][0]).exists())
            drain(laptop)
        finally:
            for rel in made:
                (courses[0] / rel).unlink(missing_ok=True)
        with Patch((server.S, "set_chat", lambda cdir, chat_id: None)):      # (the real course keeps its chat)
            st, _ = post(port, {"course": course, "client": "phone"}, "/api/chat/new")
        k, d, _ = laptop.next()
        check("http: New chat on the phone reaches the laptop", st == 200 and (k, d["chat"]) == ("chat", None))
        before = server.DRAFTS.watchers(course)
        for x in (laptop, phone, late):
            x.close()
        check("http: devices that stop asking are no longer counted", wait_for(lambda: server.DRAFTS.watchers(course) == before - 3, 8),
              server.DRAFTS.watchers(course))

        if load:
            n = 100
            many = [Live(port, course, f"dev{i}") for i in range(n)]
            for m in many:
                m.next(10)
            check(f"load: {n} devices connected", wait_for(lambda: server.DRAFTS.watchers(course) == n, 5),
                  server.DRAFTS.watchers(course))
            rev = server.DRAFTS.get(course)["rev"]
            worst = []
            for i in range(5):
                t0 = time.perf_counter()
                st, r = post(port, {"course": course, "client": "writer", "text": f"change {i}", "base": rev})
                rev = r["rev"]
                worst.append(max(m.next(10)[2] for m in many) - t0)
            ms = sorted(x * 1000 for x in worst)
            print(f"      {n} devices: a change reached all of them in {ms[0]:.0f}–{ms[-1]:.0f} ms, "
                  f"hub threads {threading.active_count()}")
            check(f"load: a change reaches {n} devices in under a second", ms[-1] < 1000, f"{ms[-1]:.0f} ms")
            for m in many:
                m.close()
            check("load: none counted once they stop", wait_for(lambda: server.DRAFTS.watchers(course) == 0, 8),
                  server.DRAFTS.watchers(course))
    finally:
        srv.shutdown()
        srv.server_close()


def main():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        lib = tmp / "library"
        build_demo(lib)
        with Patch((L, "ROOT", lib)):       # the demo library, never the real one
            test_store(tmp)
            test_library(lib)
            test_course_chat()
            test_js()
            test_http(tmp, "--quick" not in sys.argv)
    print(f"\n{len(FAILED)} failed" + (": " + ", ".join(FAILED) if FAILED else ""))
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
