"""The tutor: every Claude call the Study Hub makes.

Each call runs the `claude` CLI (the Claude Code login on this machine; no API key) inside the
course folder with read-only tools. With default permissions and the course folder as the working
directory, reads outside the course are refused; only WebSearch/WebFetch are pre-approved, and
those can't read local files. (Tested: an outside file read is denied while web search works.)
Never pre-approve Read/Grep/Glob with --allowedTools: that would allow reads anywhere.

Modes
- chat (explain / example / ask / deeper): Markdown answers in one resumable Claude session per deck
- practice: a problem written and solved by Claude (structured output); the solution and hints stay
  on the server until the student has tried
- check: marks the student's work (typed and/or photographed), method first
"""
import hashlib, json, re, subprocess, threading, time, uuid
from pathlib import Path

import library as L
import state as S

HERE = Path(__file__).resolve().parent
WORK = HERE / ".cache"
MAX_TURNS = 25
TIMEOUT = 420
MODELS = {
    "claude-opus-5-5": "Opus 5.5 — best answers, highest cost",
    "claude-sonnet-5-5": "Sonnet 5.5 — balanced",
    "claude-haiku-4-5": "Haiku 4.5 — fastest, cheapest",
}
DEFAULT_MODEL = "claude-opus-5-5"
_LOG_LOCK = threading.Lock()


def log(msg):
    WORK.mkdir(exist_ok=True)
    with _LOG_LOCK, open(WORK / "hub.log", "a", encoding="utf-8") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")


class TutorError(Exception):
    def __init__(self, msg, status=502):
        super().__init__(msg)
        self.status = status


def run_claude(cdir, system, prompt, *, model, session=None, schema=None, web=True, label=""):
    WORK.mkdir(exist_ok=True)
    key = hashlib.sha1(system.encode("utf-8")).hexdigest()[:12]
    pfile = WORK / f"prompt-{key}-{threading.get_ident()}.md"
    pfile.write_text(system, encoding="utf-8")
    tools = "Read,Grep,Glob" + (",WebSearch,WebFetch" if web else "")
    cmd = ["claude", "-p", "--output-format", "json", "--model", model if model in MODELS else DEFAULT_MODEL,
           "--tools", tools, "--max-turns", str(MAX_TURNS),
           "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "local",
           "--system-prompt-file", str(pfile)]
    if web:
        cmd += ["--allowedTools", "WebSearch", "WebFetch"]
    if session:
        cmd += ["--resume", session]
    if schema:
        cmd += ["--json-schema", json.dumps(schema)]
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8",
                              timeout=TIMEOUT, cwd=str(cdir))
    except FileNotFoundError:
        raise TutorError("The claude command isn't on PATH. Install Claude Code, then restart the hub.", 500)
    except subprocess.TimeoutExpired:
        raise TutorError("That took too long. Try again.", 504)
    finally:
        pfile.unlink(missing_ok=True)
    ms = int((time.time() - t0) * 1000)
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        log(f"{label} failed: {(proc.stderr or proc.stdout)[-300:]!r}")
        raise TutorError("Claude didn't answer. Check that Claude Code is signed in, then try again.")
    if data.get("subtype") == "error_max_turns":
        raise TutorError("Claude ran out of look-up steps. Try a narrower question.")
    if data.get("is_error"):
        log(f"{label} error: {str(data.get('result'))[:300]!r}")
        raise TutorError("Claude reported an error. Try again in a moment.")
    if schema and not isinstance(data.get("structured_output"), dict):
        raise TutorError("Claude's answer came back in the wrong shape. Try again.")
    cost = data.get("total_cost_usd") or 0
    log(f"{label} course={L.course_meta(cdir)[0]} model={model} turns={data.get('num_turns')} "
        f"denied={len(data.get('permission_denials') or [])} ms={ms} cost={cost:.4f}")
    return {"text": data.get("result", ""), "json": data.get("structured_output"), "session": data.get("session_id"),
            "ms": ms, "cost": cost}


# ---------------------------------------------------------------- the system prompt

STYLE = {
    "DEMO": "a short closed-book quiz question",
}

SYSTEM = """You are the tutor inside a student's Study Hub for {code} {title}.
Their goal: understand the concepts well enough to solve problems they have never seen, and get top marks.

Sources, in order of trust:
1. The lecture slides (transcripts below; the course map lists every deck). Slides set the notation and scope
   the exams use.
{sources}
Label where each part of an answer comes from: slides as [S&D-2 s14] (the deck tag and slide number),
textbooks as (Smith §2.3), web as (web: domain.org). When a source's notation or convention differs from the
slides (e.g. per-unit vs total figures), say so in one line and follow the slides.

Style:
- Short: one idea per answer, about 150 words unless told otherwise. No preamble, no summary of what you did,
  don't narrate which files you opened.
- In algebra or derivations, show every step and name the rule, e.g. "(solving a linear equation: same step on both sides)".
- Markdown. Math in KaTeX: $...$ inline, $$...$$ display. No headings bigger than ####.
- If the student says a question is from a live graded quiz or exam, add one short line noting the course's
  rule on AI use during assessments (CLAUDE.md), then help fully.

{context}

{course_map}"""

SOURCES_WEB = """2. The course textbooks (.cache/textbooks: Grep the .txt, or read the .toc.md first) and the student's
   own class notes.
3. Official documentation and university course notes on the web (WebSearch/WebFetch).
4. The general web, only when nothing above covers it.
Open the slides first; reach for 2–4 only when the slides are thin, skip a step, or the student needs a
prerequisite or a clearer example."""
SOURCES_SLIDES = """2. The student's own class notes. Stick to the slides: no textbooks, no web. If the slides don't cover it,
   say "The slides don't cover this" and stop."""


def system_prompt(cdir, tag, web):
    info = L.course_info(cdir)
    d = info["decks"][tag]
    ctx = L.topic_context(cdir, d["topic"])
    if ctx:
        context = f"# Slides of the topic the student is studying: {d['topic']}\n\n{ctx}"
    else:
        context = (f"# The deck the student is studying (topic {d['topic']} is too big to include whole; "
                   f"open its other decks from the map when needed)\n\n{L.deck_context(cdir, tag)}")
    return SYSTEM.format(code=info["code"], title=info["title"], sources=SOURCES_WEB if web else SOURCES_SLIDES,
                         context=context, course_map=L.course_map(cdir))


def where(cdir, tag, n):
    s = next((x for x in L.slide_texts(cdir, tag) if x["n"] == n), None)
    return f"[{tag} s{n}]" + (f" \"{s['title']}\"" if s and s["title"] else "")


# ---------------------------------------------------------------- chat (explain / example / ask / deeper)

CHAT_PROMPTS = {
    "explain": """Explain the idea on slide {where} simply. If that slide is a title, outline or admin slide, explain
the main idea of the slides around it instead. Use exactly this shape, about 150 words in total:

<the idea in plain English, 2–3 sentences, no jargon before it's explained>

**Why it works:** <1–3 sentences>

**Use it when:** <the clues in a problem that tell you to reach for this, as a short list (at most 3)>

**Common trap:** <one line: the mistake students make with this on exams>

**Needs:** <2–3 short plain names of prerequisites the slide assumes, no math and no examples (e.g. percentage
change, slope of a line); leave this line out if none>

**Used in:** <one line: where this is used in real systems or real work>""",
    "example": """Show ONE worked example of the idea on slide {where}. If that slide is a title, outline or admin slide,
use the main idea of the slides around it. Pick a problem like the slides' examples but not identical.
Shape: the problem in one or two lines, then numbered steps, each naming the rule or reason, then the
answer in bold. At most about 200 words.""",
    "ask": """(The student is looking at slide {where}.)

{question}""",
    "deeper": """Go deeper on your last answer: the fuller explanation, the reasoning behind each step, and one more
example if it helps. Up to about 250 words; if more is needed, stop and offer to continue.""",
    "brush": """The student wants to brush up on a prerequisite: {question}. Teach just that, briefly: the rule(s),
one tiny example each, and how it shows up on slide {where}. About 150 words.""",
}


def chat_turn(cdir, tag, n, mode, question, model, web):
    """One tutor answer inside the deck's chat. Returns the saved message and the chat id."""
    if mode not in CHAT_PROMPTS:
        raise TutorError("Unknown request.", 400)
    chat_id = S.chat_for(cdir, tag)
    chat = load_chat(chat_id) if chat_id else None
    prompt = CHAT_PROMPTS[mode].format(where=where(cdir, tag, n), question=question.strip())
    r = run_claude(cdir, system_prompt(cdir, tag, web), prompt, model=model,
                   session=chat.get("session") if chat else None, web=web, label=f"chat:{mode}")
    now = time.strftime("%Y-%m-%d %H:%M")
    if not chat:
        code, _ = L.course_meta(cdir)
        d = L.deck(cdir, tag)
        chat = {"id": uuid.uuid4().hex[:12], "course": cdir.name, "code": code, "deck": tag,
                "title": f"{d['title']} [{tag}]", "created": now, "messages": []}
        S.set_chat(cdir, tag, chat["id"])
    chat["session"] = r["session"]
    chat["updated"] = now
    label = {"explain": "Explain simply", "example": "Worked example", "deeper": "Go deeper",
             "brush": f"Brush up: {question.strip()}"}.get(mode, question.strip())
    msg = {"role": "a", "mode": mode, "slide": n, "text": r["text"], "ms": r["ms"], "cost": r["cost"], "model": model}
    chat["messages"] += [{"role": "q", "mode": mode, "slide": n, "text": label}, msg]
    save_chat(chat)
    return chat, msg


# ---------------------------------------------------------------- saved chats

CHATS = WORK / "chats"
CHAT_ID = re.compile(r"^[a-f0-9]{12}$")
_CHAT_LOCK = threading.Lock()


def chat_file(chat_id):
    return CHATS / f"{chat_id}.json" if chat_id and CHAT_ID.match(chat_id) else None


def load_chat(chat_id):
    f = chat_file(chat_id)
    try:
        return json.loads(f.read_text(encoding="utf-8")) if f and f.exists() else None
    except (OSError, json.JSONDecodeError):
        return None


def save_chat(chat):
    CHATS.mkdir(parents=True, exist_ok=True)
    with _CHAT_LOCK:
        chat_file(chat["id"]).write_text(json.dumps(chat, ensure_ascii=False, indent=1), encoding="utf-8")


def list_chats():
    out = []
    for f in CHATS.glob("*.json") if CHATS.exists() else []:
        try:
            c = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        out.append({k: c.get(k) for k in ("id", "title", "course", "code", "deck", "created", "updated")}
                   | {"count": sum(1 for m in c.get("messages", []) if m["role"] == "q")})
    return sorted(out, key=lambda c: c["updated"] or "", reverse=True)


def public_chat(c):
    return {k: v for k, v in c.items() if k != "session"}


# ---------------------------------------------------------------- practice

PROBLEM_SCHEMA = {
    "type": "object",
    "properties": {
        "problem_md": {"type": "string", "description": "The problem as the student sees it (Markdown + KaTeX)."},
        "solution_md": {"type": "string", "description": "Full worked solution: numbered steps, each naming its rule."},
        "final_answer": {"type": "string", "description": "The final answer in one line."},
        "hints": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 2,
                  "description": "Two hints. Hint 1: a question pointing at the key feature, not naming the "
                                 "method. Hint 2: the first step of the setup only. Neither gives the answer."},
        "concept": {"type": "string", "description": "The concept tested, at most 8 words."},
        "slides": {"type": "string", "description": "The slides it comes from, e.g. 'S&D-2 s14–s16'."},
        "deck": {"type": "string", "description": "The deck tag it comes from, e.g. 'S&D-2' (empty for warm-ups)."},
    },
    "required": ["problem_md", "solution_md", "final_answer", "hints", "concept", "slides", "deck"],
}

PRACTICE_BASE = """Write ONE practice problem for the student, then solve it yourself.

Rules:
- Style: {style}.
- It must test understanding, not recall of the slide's own example: {surface}
- ONE question with ONE final answer; no (a)(b) parts. Solvable by hand in about 3–6 minutes. Keep
  problem_md under about 60 words (code or a small table may add to that). Stay inside what the slides
  teach (and what earlier decks taught).
- Don't name the method in the problem unless choosing it is not the point.
- Solve it completely, then check your solution a second, independent way (substitute back, a small case,
  or a different method). The problem must have one clear correct answer and be free of ambiguity.
- Hints: Hint 1 is a question that points to the key feature of the problem without naming the method
  (e.g. "What happens to the price when supply is fixed?"). Hint 2 writes out the
  first step of the setup, and nothing after it. Neither gives the answer.
- Don't mention hints or the solution inside problem_md.

{task}"""

SURFACE_NEW = "change the setting and wording as well as the numbers, so the student has to recognise the idea."

TASKS = {
    "try": "The problem is about the idea on slide {where} (if that slide is a title or admin slide, the main "
           "idea of the slides around it), within deck [{tag}].",
    "deck": "The problem is about the main ideas of deck [{tag}] as a whole.",
    "yourturn": "The student has just read this worked example:\n\n{example}\n\nWrite a near-identical problem "
                "(same structure, different numbers). In problem_md, show only the setup already worked, and leave "
                "the key step (the one that uses the slide's idea) and everything after it for the student, ending "
                "with: **Your turn:** finish from here.",
    "mixed": "Mixed practice: the problem may come from any of these topics: {topics}. The student must first "
             "decide which method applies, so don't name the method or the topic. Prefer ideas that are easy to "
             "confuse with a neighbouring method.",
    "review": "Review of an earlier mistake. The student got this problem wrong ({mistake}):\n\n{problem}\n\n"
              "Write a fresh variation that tests the same idea ({concept}) at the same difficulty, where the "
              "step they got wrong can't be avoided. If the mistake was Setup, Method choice, Concept gap or No "
              "attempt: change the setting and form, so the idea has to be recognised, and prefer a neighbouring "
              "method as the tempting wrong choice. If it was Algebra slip or Skipped step: keep the form familiar "
              "and change the numbers, so the same rule or check is needed.",
    "warmup": "A short algebra warm-up (1–3 minutes, not tied to a slide) on: {concept}. Leave `deck` empty and "
              "set `slides` to 'Warm-up'.",
}

_PRACTICE = {}          # id -> record (also saved to .cache/practice)
_PREFETCH = {}          # key -> {"event", "rec", "err"}
_P_LOCK = threading.Lock()
PRACTICE_DIR = WORK / "practice"
PID = re.compile(r"^[a-f0-9]{12}$")


def _save_practice(rec):
    PRACTICE_DIR.mkdir(parents=True, exist_ok=True)
    (PRACTICE_DIR / f"{rec['id']}.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")


def get_practice(pid):
    if not pid or not PID.match(pid):
        return None
    with _P_LOCK:
        if pid in _PRACTICE:
            return _PRACTICE[pid]
    f = PRACTICE_DIR / f"{pid}.json"
    if f.exists():
        rec = json.loads(f.read_text(encoding="utf-8"))
        with _P_LOCK:
            _PRACTICE[pid] = rec
        return rec
    return None


def public_problem(rec):
    return {"id": rec["id"], "kind": rec["kind"], "problem_md": rec["problem_md"], "concept": rec["concept"],
            "slides": rec["slides"], "deck": rec["deck"], "hints_total": len(rec["hints"]),
            "review_id": rec.get("review_id"), "warmup": rec["kind"] == "warmup", "ms": rec.get("ms"),
            "cost": rec.get("cost")}


def _generate(cdir, req, model, web):
    kind = req["kind"]
    info = L.course_info(cdir)
    tag = req.get("tag") or ""
    n = int(req.get("n") or 1)
    review = S.get_review(cdir, req["review_id"]) if req.get("review_id") else None
    if review and review["warmup"]:
        kind = "warmup"
    if kind in ("try", "deck", "yourturn") and not L.deck(cdir, tag):
        raise TutorError("Open a deck first.", 400)
    if kind == "review" and not review:
        raise TutorError("That review item no longer exists.", 404)
    if kind in ("mixed",) or (kind == "review" and not (review.get("deck") and L.deck(cdir, review["deck"]))) or kind == "warmup":
        # no single deck: give the tutor the first deck in scope for its context; the map covers the rest
        scope_tag = tag if L.deck(cdir, tag) else (review or {}).get("deck") or L.deck_order(cdir)[0]["tag"]
    else:
        scope_tag = tag if kind != "review" else review["deck"]
    topics = req.get("topics") or [t["name"] for t in info["topics"] if t["name"] != L.UNSORTED]
    task = TASKS[kind].format(where=where(cdir, tag, n) if L.deck(cdir, tag) else "", tag=tag,
                              example=req.get("example_md", "")[:4000], topics=", ".join(topics),
                              mistake=(review or {}).get("mistake") or "a mistake",
                              problem=(review or {}).get("problem_md") or (review or {}).get("concept", ""),
                              concept=(review or {}).get("concept", ""))
    prompt = PRACTICE_BASE.format(style=STYLE.get(info["code"], "an exam-style question for this course"),
                                  surface=SURFACE_NEW if kind != "yourturn" else "same structure as the example.",
                                  task=task)
    r = run_claude(cdir, system_prompt(cdir, scope_tag, web), prompt, model=model, schema=PROBLEM_SCHEMA, web=web,
                   label=f"practice:{kind}")
    j = r["json"]
    deck_tag = j.get("deck") if L.deck(cdir, j.get("deck") or "") else (tag if kind in ("try", "deck", "yourturn") else
                                                                      (review or {}).get("deck"))
    rec = {"id": uuid.uuid4().hex[:12], "course": cdir.name, "kind": kind, "tag": tag, "n": n,
           "deck": deck_tag or "", "review_id": review["id"] if review else None,
           "problem_md": j["problem_md"], "solution_md": j["solution_md"], "final_answer": j["final_answer"],
           "hints": [h for h in j["hints"] if h][:2] or ["Look again at the definition on the slide."],
           "concept": j["concept"] or (review or {}).get("concept", ""), "slides": j.get("slides", ""),
           "hints_used": 0, "attempts": [], "photos": [], "created": time.strftime("%Y-%m-%d %H:%M"),
           "ms": r["ms"], "cost": r["cost"], "model": model}
    with _P_LOCK:
        _PRACTICE[rec["id"]] = rec
    _save_practice(rec)
    return rec


def _prefetch_key(cdir, req, model, web):
    return (cdir.name, req.get("kind"), req.get("tag") or "", model, web, tuple(req.get("topics") or ()))


def new_problem(cdir, req, model, web):
    """A new problem; takes a prefetched one when it's ready (or waits for it) instead of starting over."""
    key = _prefetch_key(cdir, req, model, web)
    if req.get("kind") in ("try", "deck", "mixed"):
        with _P_LOCK:
            pf = _PREFETCH.pop(key, None)
        if pf:
            pf["event"].wait(TIMEOUT)
            if pf.get("rec") and (req.get("kind") != "try" or pf["rec"]["n"] == int(req.get("n") or 1)):
                return pf["rec"]
    return _generate(cdir, req, model, web)


def prefetch(cdir, req, model, web):
    """Start writing the next problem in the background, so 'Try another' is instant."""
    if req.get("kind") not in ("try", "deck", "mixed"):
        return
    key = _prefetch_key(cdir, req, model, web)
    with _P_LOCK:
        if key in _PREFETCH:
            return
        pf = _PREFETCH[key] = {"event": threading.Event()}

    def work():
        try:
            pf["rec"] = _generate(cdir, req, model, web)
        except Exception as e:      # the student simply gets a fresh one later
            pf["err"] = str(e)
        finally:
            pf["event"].set()
    threading.Thread(target=work, daemon=True).start()


def hint(pid):
    rec = get_practice(pid)
    if not rec:
        raise TutorError("That problem has expired. Start a new one.", 404)
    i = rec["hints_used"]
    rec["hints_used"] = i + 1
    _save_practice(rec)
    if i < len(rec["hints"]):
        return {"hint": rec["hints"][i], "n": i + 1, "more": True}
    return {"solution_md": rec["solution_md"], "n": i + 1, "more": False}


MARK_SCHEMA = {
    "type": "object",
    "properties": {
        "correct": {"type": "boolean"},
        "unreadable": {"type": "boolean", "description": "True only if the photo can't be read."},
        "verdict": {"type": "string", "description": "One line that leads with what went right, e.g. "
                                                     "'Method right, algebra slip in step 3.' No grades, no ✗."},
        "mistake": {"type": "string", "enum": ["none", "No attempt", "Concept gap", "Setup", "Method choice",
                                               "Algebra slip", "Skipped step"]},
        "feedback_md": {"type": "string", "description": "At most ~120 words: the specific error and the corrected "
                                                         "step (KaTeX). Empty when fully correct."},
        "concept_missed": {"type": "string", "description": "What to review, at most 8 words; empty if correct."},
    },
    "required": ["correct", "unreadable", "verdict", "mistake", "feedback_md", "concept_missed"],
}

MARK_PROMPT = """Mark the student's work on this problem.

## Problem
{problem}

## Reference solution (written earlier; it may contain an error)
{solution}

## The student's work
{answer}
{photos}

How to mark:
1. Solve the problem yourself first, independently. If your careful solution disagrees with the reference,
   trust the re-derivation.
2. Mark the method, not only the final answer. correct = the method is valid AND the final answer is right
   (equivalent forms and small notation differences are fine). A right answer reached by a broken method is
   not correct.
3. If the problem needs working and the student gave only a final answer, judge the answer, and in
   feedback ask for the one key step next time. Multiple-choice answers need no working.
3b. Partial credit: name every step that would earn marks on a paper exam, then the first wrong step. For
   No attempt, do NOT give the full solution in feedback_md: give only the first move and why, and ask
   them to try again.
4. mistake = the FIRST error in the work: No attempt (nothing that moves toward the answer, e.g. only a
   formula or identity copied), Concept gap (misunderstands what the idea says), Setup (the problem
   translated wrongly: wrong equation, wrong quantity, misread), Method choice (the wrong technique for
   this problem), Algebra slip (a calculation or rule applied wrongly), Skipped step (a needed
   justification or case check left out). "none" when correct.
5. verdict: one line, lead with what went right. feedback_md: the specific error and the corrected step, in
   the course's notation. Be warm and direct; no grades."""


def check(cdir, pid, answer, model, web):
    rec = get_practice(pid)
    if not rec:
        raise TutorError("That problem has expired. Start a new one.", 404)
    photos = [p for p in rec.get("photos", []) if (cdir / p).exists()]
    if not answer.strip() and not photos:
        raise TutorError("Write your answer or add a photo of your working first.", 400)
    photo_txt = ("\nPhotos of the student's handwritten working (Read each image file):\n" +
                 "\n".join(f"- {p}" for p in photos)) if photos else ""
    prompt = MARK_PROMPT.format(problem=rec["problem_md"], solution=rec["solution_md"],
                                answer=answer.strip() or "(see the photos)", photos=photo_txt)
    tag = rec["deck"] if L.deck(cdir, rec["deck"] or "") else (rec["tag"] if L.deck(cdir, rec["tag"] or "") else
                                                               L.deck_order(cdir)[0]["tag"])
    r = run_claude(cdir, system_prompt(cdir, tag, False), prompt, model=model, schema=MARK_SCHEMA, web=False,
                   label="check")
    j = r["json"]
    hinted = rec["hints_used"] > 0
    correct = bool(j["correct"]) and not j.get("unreadable")
    rec["attempts"].append({"answer": answer, "photos": photos, "result": j, "at": time.strftime("%Y-%m-%d %H:%M")})
    _save_practice(rec)
    saved = False
    review_item = None
    if j.get("unreadable"):
        pass
    elif rec.get("review_id"):
        review_item = S.review_result(cdir, rec["review_id"], correct=correct, hinted=hinted,
                                      mistake="" if j["mistake"] == "none" else j["mistake"])
        saved = not (correct and not hinted)
    elif not correct or hinted:
        # wrong, or right only with hints: it comes back tomorrow (a hinted solve isn't learned yet)
        if not rec.get("saved_review"):
            review_item = S.add_mistake(cdir, deck=rec["deck"] or None, slides=rec["slides"],
                                        concept=j.get("concept_missed") or rec["concept"], problem_md=rec["problem_md"],
                                        mistake="Needed hints" if correct else j["mistake"])
            rec["saved_review"] = review_item["id"]
            _save_practice(rec)
        saved = True
    if correct and not hinted and rec["deck"] and L.deck(cdir, rec["deck"]):
        S.mark_solved(cdir, rec["deck"])
    return {"correct": correct, "unreadable": bool(j.get("unreadable")), "verdict": j["verdict"],
            "mistake": "" if j["mistake"] == "none" else j["mistake"], "feedback_md": j["feedback_md"],
            "solution_md": rec["solution_md"] if not j.get("unreadable") else "", "saved": saved,
            "hinted": hinted, "review_id": (review_item or {}).get("id") or rec.get("saved_review"),
            "ms": r["ms"], "cost": r["cost"]}


def add_photo(cdir, pid, data):
    """Save a photo of handwritten work inside the course folder (so the tutor may read it)."""
    import base64
    rec = get_practice(pid)
    if not rec:
        raise TutorError("That problem has expired.", 404)
    m = re.match(r"^data:image/(jpeg|jpg|png|webp);base64,(.+)$", data or "", re.S)
    if not m:
        raise TutorError("That isn't an image.", 400)
    raw = base64.b64decode(m.group(2))
    if len(raw) > 12_000_000:
        raise TutorError("That photo is too large (over 12 MB).", 400)
    ext = "jpg" if m.group(1) in ("jpeg", "jpg") else m.group(1)
    rel = f".cache/uploads/{pid}-{len(rec['photos']) + 1}.{ext}"
    (cdir / rel).parent.mkdir(parents=True, exist_ok=True)
    (cdir / rel).write_bytes(raw)
    rec["photos"].append(rel)
    _save_practice(rec)
    return {"photos": len(rec["photos"])}
