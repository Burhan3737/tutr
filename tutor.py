"""The tutor: what the Study Hub asks Claude, and what it does with the answers.

How the calls are made (the Claude Agent SDK on the Claude Code login, one open conversation per
deck, streaming, the course-folder check) lives in engine.py. This file holds the prompts and the
study logic.

Modes
- chat (explain / example / quiz / map / ask / deeper / brush): Markdown answers streamed into the deck's chat
- practice: a problem written and solved by Claude (structured output); the solution and hints stay
  on the server until the student has tried
- check: marks the student's work (typed and/or photographed), method first

Every entry point takes `emit(kind, data)`: "status" lines (what Claude is looking at) and, for
chats, "text" deltas as the answer is written. The server relays them to the browser.
"""
import json, re, threading, time, uuid
from pathlib import Path

import engine
import library as L
import state as S

HERE = Path(__file__).resolve().parent
WORK = HERE / ".cache"
TIMEOUT = engine.TIMEOUT
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


TutorError = engine.EngineError


def run_claude(cdir, system, prompt, *, model, session=None, schema=None, web=True, label="", chat_key=None, emit=None):
    return engine.run(cdir, system, prompt, model=model if model in MODELS else DEFAULT_MODEL, web=web, schema=schema,
                      chat_key=chat_key, session=session, emit=emit, log=log,
                      label=f"{label} course={L.course_meta(cdir)[0]}")


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
- Drawings: draw whenever a picture genuinely helps understanding, and whenever the student asks for a
  visual — then use as many as the explanation needs (e.g. one per step of a process). Never draw for
  decoration. Keep each drawing focused on one idea. The hub renders three fenced blocks:
  ```mermaid — flowcharts, trees (e.g. a hierarchy's shape), sequence or state diagrams. Short labels,
    no styling or colours; aim for about 15 nodes or fewer per diagram.
  ```svg — a custom drawing (a labelled diagram, a step-by-step process, a labelled tree, a two-way
    split): one complete <svg xmlns="http://www.w3.org/2000/svg" viewBox="…">, aiming for about 60 lines, dark
    strokes on a white background, text 12–14px, no scripts, no external images or fonts.
  ```plot — exact function plots; the hub computes the curves, so never invent data points. Lines:
    f: 100 - 2*x, 3*x      (up to 6, comma-separated; n or x; + - * / ^; log2 ln log10 sqrt exp fact)
    x: 1..64
    y: log                      (optional: log scale, or a range such as 0..5000)
    title: Demand and supply
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
    "quiz": """Quiz prep for slide {where}, for this course's assessments ({style}). If it's a title or admin slide,
use the slides around it. About 150 words, this shape:

**Could be asked:** <2–3 likely question types on this slide, each with the method in one line>

**Memorise:** <the key fact, definition or formula, in KaTeX, with its slide>

**Trap:** <the one mistake that costs marks here>""",
    "explain_deck": """Explain the whole deck {deck} simply, in the order its slides teach it. Skip title, outline and
admin slides. Group it into at most 6 main ideas (merge small ones). For each idea:

**<idea name>** [{tag} sA–sB]
<2–3 plain-English sentences: what it is and why it works>
*Use it when:* <one line: the clue in a problem>

End with **How it fits together:** <2 sentences linking the ideas>. About 50 words per idea; HARD LIMIT 400 words
in total — the student is overwhelmed by long text, and can ask "Go deeper" for more.""",
    "map_deck": """Give the big picture of the whole deck {deck}: every concept it teaches, laid out at a glance, without
explaining any of them. Skip title, outline and admin slides. The student wants the map, not the territory —
no derivations, no examples, no "why". This shape:

#### Concepts
<one line per concept, in the order the slides teach it, at most 10 (merge small ones):
"- **<name>** — <what it is, 12 words at most> [{tag} sA–sB]">

#### How they connect
<one ```mermaid flowchart (graph TD or LR), one node per concept above using the same short names, edges
labelled with a word or two such as "solved by", "special case of", "used in"; nothing else in this section>

#### You'll be asked to
<2–3 bullets, each a verb phrase naming a task an assessment could set ({style}), e.g. "find an equilibrium
price from two equations">

HARD LIMIT 180 words outside the diagram. Bold names and tags only; no other prose.""",
    "example_deck": """Show ONE worked example that uses the central method of the whole deck {deck} from start to finish (the
kind of problem the deck builds up to). The problem in one or two lines, then numbered steps, each naming
the rule or reason and citing the slide it comes from, then the answer in bold. At most about 250 words.""",
    "quiz_deck": """Make a quiz-prep sheet for the whole deck {deck}, shaped by this course's assessments ({style}; see
CLAUDE.md for the format and aids). Cite slides. HARD LIMIT 400 words — terse bullets, no filler. This shape:

#### Must know
<at most 8 bullets: the definitions, formulas (KaTeX) and facts a question could hinge on>

#### Likely questions
<3–4 question types, each: the type in bold, then the method in one line>

#### Traps
<3 one-line traps that cost marks>

#### Check yourself
<3 short questions of the likely types, as a numbered list; end each item with its answer hidden in double
bars on the same line, e.g. "1. What is …? ||Answer: … (one or two sentences)||">""",
}

DECK_MODES = {"explain_deck", "example_deck", "quiz_deck", "map_deck"}
MODE_LABELS = {"explain": "Explain simply", "example": "Worked example", "deeper": "Go deeper", "quiz": "Quiz prep",
               "map_deck": "Big picture · whole deck",
               "explain_deck": "Explain simply · whole deck", "example_deck": "Worked example · whole deck",
               "quiz_deck": "Quiz prep · whole deck"}


def deck_where(cdir, tag):
    d = L.deck(cdir, tag)
    return f"[{tag}] \"{d['title']}\" (slides 1–{d['slides']})" if d else f"[{tag}]"


def chat_turn(cdir, tag, n, mode, question, model, web, emit=None):
    """One tutor answer inside the deck's chat. Returns the saved message and the chat id."""
    if mode not in CHAT_PROMPTS:
        raise TutorError("Unknown request.", 400)
    chat_id = S.chat_for(cdir, tag)
    chat = load_chat(chat_id) if chat_id else None
    label = MODE_LABELS.get(mode) or (f"Brush up: {question.strip()}" if mode == "brush" else question.strip())
    now = time.strftime("%Y-%m-%d %H:%M")
    new = chat is None
    if new:     # saved only once Claude has answered
        chat = {"id": uuid.uuid4().hex[:12], "course": cdir.name, "code": L.course_meta(cdir)[0], "deck": tag,
                "title": f"{label[:70]} · " + (tag if mode in DECK_MODES else f"s{n}"), "created": now, "messages": []}
    prompt = CHAT_PROMPTS[mode].format(where=where(cdir, tag, n), question=question.strip(), tag=tag,
                                       deck=deck_where(cdir, tag),
                                       style=STYLE.get(L.course_meta(cdir)[0], "this course's quizzes and exams"))
    r = run_claude(cdir, system_prompt(cdir, tag, web), prompt, model=model, chat_key=(cdir.name, tag, chat["id"]),
                   session=chat.get("session"), web=web, label=f"chat:{mode}", emit=emit)
    if new:
        S.set_chat(cdir, tag, chat["id"])
    chat["session"] = r["session"]
    chat["updated"] = now
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
                   | {"starred": bool(c.get("starred")), "count": sum(1 for m in c.get("messages", []) if m["role"] == "q")})
    out.sort(key=lambda c: c["updated"] or "", reverse=True)
    return sorted(out, key=lambda c: not c["starred"])       # starred first, each group newest first


def update_chat(chat_id, title=None, starred=None):
    """Rename and/or star a saved chat."""
    chat = load_chat(chat_id)
    if not chat:
        raise TutorError("That chat no longer exists.", 404)
    if title is not None:
        title = " ".join(str(title).split())[:120]
        if not title:
            raise TutorError("A chat needs a name.", 400)
        chat["title"] = title
    if starred is not None:
        chat["starred"] = bool(starred)
    save_chat(chat)
    return {"id": chat["id"], "title": chat["title"], "starred": bool(chat.get("starred"))}


def deck_chats(cdir, tag):
    """Every saved chat on one deck, newest first (for the 'earlier chats' list)."""
    return [c for c in list_chats() if c.get("course") == cdir.name and c.get("deck") == tag]


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


def _generate(cdir, req, model, web, emit=None):
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
                   label=f"practice:{kind}", emit=emit)
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


def new_problem(cdir, req, model, web, emit=None):
    """A new problem; takes a prefetched one when it's ready (or waits for it) instead of starting over."""
    key = _prefetch_key(cdir, req, model, web)
    if req.get("kind") in ("try", "deck", "mixed"):
        with _P_LOCK:
            pf = _PREFETCH.pop(key, None)
        if pf:
            if not pf["event"].is_set() and emit:
                emit("status", "Finishing the problem that's already being written")
            pf["event"].wait(TIMEOUT)
            if pf.get("rec") and (req.get("kind") != "try" or pf["rec"]["n"] == int(req.get("n") or 1)):
                return pf["rec"]
    return _generate(cdir, req, model, web, emit)


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


def check(cdir, pid, answer, model, web, emit=None):
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
                   label="check", emit=emit)
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
