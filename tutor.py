"""The tutor: what the Study Hub asks Claude, and what it does with the answers.

How the calls are made (the Claude Agent SDK on the Claude Code login, one open conversation per
course chat, streaming, the course-folder check) lives in engine.py. This file holds the prompts and the
study logic.

Modes
- chat (explain / example / quiz / map / before / cheatsheet / grill / ask / deeper / brush / side): Markdown answers
  streamed into the course's chat; a grill runs over several turns (the student's answers come back as grill_reply)
- voice: a spoken question (the retired Talk tab's mode, still accepted), answered in plain spoken sentences
  (voice_prompt.md) in the same chat; afterwards the tutor's notes on the student (study/tutor-memory.md) are
  updated in the background. Dictated questions now go as asks with spoken: true.
- practice: a problem written and solved by Claude (structured output); the solution and hints stay
  on the server until the student has tried
- check: marks the student's work (typed and/or photographed), method first

Every entry point takes `emit(kind, data)`: "status" lines (what Claude is looking at) and, for
chats, "text" deltas as the answer is written. The server relays them to the browser.
"""
import json, os, re, threading, time, uuid
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


def run_claude(cdir, system, prompt, *, model, session=None, fork=False, schema=None, web=True, label="", chat_key=None,
               emit=None):
    return engine.run(cdir, system, prompt, model=model if model in MODELS else DEFAULT_MODEL, web=web, schema=schema,
                      chat_key=chat_key, session=session, fork=fork, emit=emit, log=log,
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
- Follow the slides: their method, notation and named quantities (if the slides call the price P, so do
  you). Never skip a step, even one the slides skip; in an example every number must be traceable to where it
  came from, so the student is never left to assume anything.
- Terms to look up: assume the student is meeting all of this for the first time. Wrap every technical term,
  symbol, piece of notation, rule or prerequisite that appears in the student's question or in your answer, and
  that your text doesn't already define in plain words, in double square brackets: [[opportunity cost]],
  [[marginal cost]], [[$\\mu$]], [[percentage change]]. The student taps one to have it explained on the side, so mark
  generously, with no limit, but only its first mention in each answer, and never inside headings, code,
  drawings or $$...$$ blocks (for a symbol, wrap the inline math: [[$x_i$]]). Don't explain a marked term
  inline beyond what the sentence needs. In a worked solution, name the rule behind a step as a marked term,
  e.g. "(by [[solving a linear equation]])".
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
  The drawing comes before the text that explains it. Give each part the text will talk about a short id:
  a mermaid node id (L[Left half] -> L); in svg an id on its element, or on a <g id> around a multi-shape part.
  In the text, end the sentence about a part with [#id] (one or two per sentence, only ids the drawing defines;
  never shown or read aloud). svg: viewBox on the opening <svg> tag; each part its own top-level element (no
  one <g> around everything); no <defs>, <marker> or <style> (use marker-end="url(#arrow)", which the hub
  provides); write & as &amp;.
- Spoken lines: directly above every table, display formula ($$), block of worked arithmetic, code or pseudocode
  block and drawing, write [say: …] on its own line: one or two sentences saying what the block shows and why it
  matters, as you'd explain it aloud to a student who can see it. Explain it, never read the cells or symbols.
  Read aloud, it replaces everything under it up to the next blank line, so keep that block to just the visual
  (the table, the $$ line, the lines of working), with a blank line before and after it. A long inline formula
  inside a paragraph or list item goes on its own $$ line with its spoken line; if it must stay inline, the
  spoken line has to say the whole paragraph aloud. Never shown on screen; no ] inside it, under 400 characters.
  Ordinary sentences, word lists and short maths get none, and a spoken line only ever stands in for a block:
  no talk of its own.
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

# Grill me (after Matt Pocock's grill-me skill): an oral exam, one question at a time, walking the slide's ideas
# as a tree from the root. It's a conversation: the opening turn ("grill" / "grill_deck") sets the rules, every
# answer the student types while it runs comes back as "grill_reply" (app.js), and "grill_end" asks for the summary.
GRILL_SUMMARY = """#### How the grill went
**Held up:** <bullets: what they showed they know, each with its slide>
**Shaky:** <bullets: each gap, the right idea in one line, its slide; "- nothing" if none>
**Next:** <one line: what to practise next, e.g. Try one on [TAG sN]>"""
GRILL_RULES = """

Known weak points of this student (steer towards any that touch this material; don't mention the list):
{mistakes}

Each time the student replies, until the grill ends:
- Open with the verdict: "Right", "Right, but" (correct yet missing a reason or a step) or "Not quite".
- Right: confirm in one line; add the model answer in 1–2 lines only if theirs lacked something worth having.
- Right, but / Not quite: don't give the answer. Name what's missing or wrong in one line, then ask a smaller
  question on that same point. Don't move on until it holds up. Only when they say they're stuck, ask for the
  answer, or miss the same point twice: explain it briefly (about 80 words, citing the slide), then ask a
  variant of the same question (other numbers or a changed condition) to check it stuck.
- Probe the why: a correct answer with no reason gets "why?", "what rule allows that step?" or "what if
  <condition> changed?" before the next branch.
- Calculations and derivations: demand the full written working, as on paper in the exam: every step, the rule
  that justifies it as a marked term (e.g. [[solving a linear equation]]) and explicit constants. A bare final answer or
  a step with no rule is "Right, but". If the course's CLAUDE.md asks for more (e.g. the algebra rule behind
  every step), hold them to it.
- Then the next question, numbered on (Q2, Q3 …), same shape: ONE question per reply, never two. Climb the
  tree: core definitions → why each step works → edge cases and traps → an exam-style problem.
- Keep each reply under about 150 words. Don't lecture; the student does the talking.
- End when every branch is covered (about {count} questions) or the student asks to stop: instead of a new
  question, this summary:

""" + GRILL_SUMMARY
GRILL_SHAPE = """
**Q1 · <a few words naming what it tests>** [<its slide, e.g. {tag} s3>]
<the question: one thing only, answerable in a few lines>

Then stop and wait for the answer: no answer, no hint, no list of the questions to come."""

CHAT_PROMPTS = {
    "explain": """Tutor the student through the idea on slide {where} so they actually understand it, as a good tutor
would at a whiteboard. If that slide is a title, outline or admin slide, use the main idea of the slides around
it. Teach through ONE concrete example and a picture: the picture comes first, then the example that walks
through it, and the general rule is drawn out of it afterwards. This shape, about 350 words plus the drawing:

**The problem:** <1–2 sentences in everyday words: what goal or question this slide answers and why it matters.
Use a simple real-life situation if one captures it.>

<one drawing of the example below, labelled with its numbers: the state at each step of a process or
calculation (```svg, or a table with one row per step), a structure or flow (```mermaid), or a curve
(```plot). For a history or motivation slide, a simple timeline or flow.>

**Let's work through it:** <one small, concrete example with tiny numbers: the slide's own example if it is
small enough, otherwise one like it. Start from the raw input; if the slide uses a table, matrix or count, show
how it is built from that input. Then short numbered steps that walk through the drawing, each saying what we
are about to do and why, doing it, and saying what the result tells us. Every number is either given or
computed in front of the student; no number from the slide appears without where it comes from and what it
means.>

**So the idea is:** <the general rule in 2–3 plain sentences, pointing back at the example ("that's why step 3
started over"). Spell out every abbreviation at first use; the one or two terms the slide rests on get a
plain-words meaning here, not only a marked term. Then the slide's formula or definition in KaTeX if it has
one, with each symbol tied to its value in the example.>

**Why it works:** <1–2 sentences of intuition>

**Spot it / watch out:** <one line: the clue in a problem that calls for this · the mistake that costs marks>

**Check yourself:** <one short question on a slightly changed version of the example (one number or condition
changed), with the answer hidden in double bars on the same line: ||Answer: …||>

**Need to know:** <the prerequisites, rules and undefined symbols the slide assumes, as marked terms separated
by " · " (e.g. [[percentage change]] · [[slope of a line]]); leave this line out if it assumes nothing>

If the slide compares several methods, run the same tiny example through each one (a table, one row per
method) so the differences show in the numbers.""",
    "example": """Show ONE worked example of the idea on slide {where}. If that slide is a title, outline or admin slide,
use the main idea of the slides around it. Pick a problem like the slides' examples but not identical.
Shape: the problem in one or two lines, then numbered steps, each saying what it does and naming its rule
as a marked term, then the answer in bold. At most about 200 words.""",
    "ask": """(The student is looking at slide {where}.)

{question}""",
    "deeper": """Go deeper on your last answer: the fuller explanation, the reasoning behind each step, and one more
example if it helps. Up to about 250 words; if more is needed, stop and offer to continue.""",
    "brush": """The student wants to brush up on a prerequisite: {question}. Teach just that, briefly: the rule(s),
one tiny example each, and how it shows up on slide {where}. About 150 words.""",
    "before": """Before you start slide {where}: what the student must already know to follow it. If that slide is a
title, outline or admin slide, use the slides around it. Don't explain the slide itself or the terms (the
student taps a term to have it explained). This shape:

**This slide:** <one line, plain English: what the slide is about>

**Need to know:**
<2–5 bullets, the most basic first: the prerequisites, rules and any symbols or terms the slide uses without
defining, each as "- [[term]] — why it's needed here, a few words [TAG sN where it's taught, or (Beyond slides)]">""",
    "before_deck": """Before you start the whole deck {deck}: what the student must already know to follow it. Don't explain
the deck itself or the terms (the student taps a term to have it explained). This shape:

**This deck:** <one line, plain English: what the deck is about>

**Need to know:**
<up to 8 bullets, the most basic first: the prerequisites, rules and symbols the deck relies on but doesn't
teach, each as "- [[term]] — for [{tag} sA–sB] (the slides that rely on it) · [TAG sN where it's taught, or
(Beyond slides)]">""",
    "cheatsheet_deck": """Make a cheat sheet for the whole deck {deck}: what the student would copy onto a hand-written sheet
for this course's assessments ({style}; CLAUDE.md has the format and aids). Terse fragments, not sentences.
Cite slides. This shape:

#### Methods
<for each problem type in the deck: the type in bold, then a 3–5 step numbered recipe to solve it>

#### Formulas & facts
<bullets, KaTeX, each with its slide>

#### Shortcuts
<bullets: patterns and quick checks that save time>

#### Don't forget
<2–3 one-liners on what costs marks>

Name the rule behind a shortcut as a marked term rather than explaining it. HARD LIMIT 350 words.""",
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
kind of problem the deck builds up to). The problem in one or two lines, then numbered steps, each saying
what it does, naming its rule as a marked term and citing the slide it comes from, then the answer in bold.
At most about 250 words.""",
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
    "grill": """Grill the student on slide {where}: a relentless oral exam, one question at a time, until you both know
they understand it. If that slide is a title, outline or admin slide, use the main idea of the slides around it.
Map what it teaches as a tree: core definitions and facts at the root, then the steps and the reasons behind
them, then edge cases, then applying it the way this course's assessments ask ({style}). Walk it from the root,
one branch at a time, and never ask something that rests on an idea they haven't shown yet.

This turn: one line naming what the grill will cover (3–5 marked terms separated by " · "), then the first
question, this shape:
""" + GRILL_SHAPE + GRILL_RULES.replace("{count}", "8"),
    "grill_deck": """Grill the student on the whole deck {deck}: a relentless oral exam, one question at a time, until
you both know they understand it. Skip title, outline and admin slides. Map what the deck teaches as a tree: its
core definitions at the root, then each method and the reasons behind its steps, then how the ideas connect,
edge cases, and applying them the way this course's assessments ask ({style}). Walk it from the root, one branch
at a time, and never ask something that rests on an idea they haven't shown yet.

This turn: one line naming the deck's main ideas the grill will cover (at most 6 marked terms separated by
" · "), then the first question, this shape:
""" + GRILL_SHAPE + GRILL_RULES.replace("{count}", "12"),
    "grill_reply": """The student's answer to your last grill question (they are now on slide {where}):

{question}

Carry on the grill by its rules: the verdict, then probe, follow up or ask the next single question; or, if
they asked to stop or every branch is covered, the summary.""",
    "grill_end": """End the grill now: no new question. From all the student's answers in this grill, this summary:

""" + GRILL_SUMMARY + """

If no grill has run in this chat, say so in one line instead.""",
}

DECK_MODES = {"explain_deck", "example_deck", "quiz_deck", "map_deck", "before_deck", "cheatsheet_deck", "grill_deck"}
MODE_LABELS = {"explain": "Explain simply", "example": "Worked example", "deeper": "Go deeper", "quiz": "Quiz prep",
               "map_deck": "Big picture · whole deck", "before": "Before you start",
               "before_deck": "Before you start · whole deck", "cheatsheet_deck": "Cheat sheet · whole deck",
               "explain_deck": "Explain simply · whole deck", "example_deck": "Worked example · whole deck",
               "quiz_deck": "Quiz prep · whole deck", "grill": "Grill me", "grill_deck": "Grill me · whole deck",
               "grill_end": "End the grill"}       # grill_reply is labelled with the student's answer, like ask


# A mode asked by slash command (/explain …) can carry the student's own words: added to the mode's prompt.
QUESTION_MODES = {"ask", "brush", "grill_reply"}       # their prompts already are the student's words
EXTRA = """

The student added this to the request: "{extra}". Let it shape the answer (what to focus on, an example to use,
what they already know or find hard) while keeping the form asked for above."""


def deck_where(cdir, tag):
    d = L.deck(cdir, tag)
    return f"[{tag}] \"{d['title']}\" (slides 1–{d['slides']})" if d else f"[{tag}]"


# Two questions in one course can be in flight at once (a voice turn spoken while the last one is still being
# answered). Both go into the same chat: the first to start a new chat registers it at once (_PENDING until its
# file is saved), so the second joins it, and the engine runs both on the same client, one after the other.
# Each turn reloads the chat just before saving and appends to the fresh copy, so neither overwrites the other.
_COURSE_LOCKS = {}          # course -> lock around picking/creating the chat and around reload→append→save
_COURSE_LOCKS_LOCK = threading.Lock()
_PENDING = {}               # chat id -> the new chat's skeleton, until its first answer is saved
_WARM_IDS = {}              # course -> the id a warm-up opened a client for, used by the next new chat


def _course_lock(cdir):
    with _COURSE_LOCKS_LOCK:
        return _COURSE_LOCKS.setdefault(cdir.name, threading.Lock())


def current_chat(cdir):
    """The id of the course's current chat. Before there was one per course, each deck had its own: the most
    recently updated of those that still exist becomes the course's (once)."""
    s = S.load(cdir)
    if "chat" in s:
        return s["chat"]
    old = [c for c in map(load_chat, set(s["chats"].values())) if c]
    chat_id = max(old, key=lambda c: c.get("updated") or c.get("created") or "")["id"] if old else None
    S.set_chat(cdir, chat_id)
    return chat_id


def chat_turn(cdir, tag, n, mode, question, model, web, emit=None, whole_deck=False, spoken=False):
    """One tutor answer inside the course's chat, about deck tag. Returns the saved message and the chat id. whole_deck: a voice
    question asked with Whole deck chosen (about the deck, not slide n)."""
    whole_deck = whole_deck and mode == "voice"
    if mode not in CHAT_PROMPTS and mode != "voice":
        raise TutorError("Unknown request.", 400)
    extra = question.strip() if mode in CHAT_PROMPTS and mode not in QUESTION_MODES else ""
    label = MODE_LABELS.get(mode) or (f"Brush up: {question.strip()}" if mode == "brush" else question.strip())
    if extra and mode in MODE_LABELS:
        label = f"{MODE_LABELS[mode]}: {extra}"
    now = time.strftime("%Y-%m-%d %H:%M")
    lock = _course_lock(cdir)
    with lock:
        chat_id = current_chat(cdir)
        chat = load_chat(chat_id) if chat_id else None
        joined = chat is None and chat_id in _PENDING
        if joined:      # another turn is starting this chat right now: join it
            chat = dict(_PENDING[chat_id])
        created = chat is None
        if created:     # the file is saved only once Claude has answered
            chat = {"id": _WARM_IDS.pop(cdir.name, None) or uuid.uuid4().hex[:12], "course": cdir.name,
                    "code": L.course_meta(cdir)[0], "deck": tag, "created": now, "messages": [],
                    "title": f"{label[:70]} · " + (tag if mode in DECK_MODES or whole_deck else f"s{n}")}
            _PENDING[chat["id"]] = dict(chat, messages=[])
            S.set_chat(cdir, chat["id"])
    if mode == "voice":
        prompt = voice_prompt(cdir, f"the whole deck {deck_where(cdir, tag)}" if whole_deck else f"slide {where(cdir, tag, n)}",
                              question.strip())
    else:
        prompt = CHAT_PROMPTS[mode].format(where=where(cdir, tag, n), question=question.strip(), tag=tag,
                                           deck=deck_where(cdir, tag),
                                           style=STYLE.get(L.course_meta(cdir)[0], "this course's quizzes and exams"),
                                           mistakes=weak_points(cdir) if mode in ("grill", "grill_deck") else "")
        if extra:
            prompt += EXTRA.format(extra=extra[:2000])
    try:
        r = run_claude(cdir, system_prompt(cdir, tag, web), prompt, model=model, chat_key=(cdir.name, chat["id"]),
                       session=chat.get("session"), web=web, label=f"chat:{mode}", emit=emit)
        msg = {"role": "a", "mode": mode, "deck": tag, "slide": n, "text": r["text"], "ms": r["ms"], "cost": r["cost"], "model": model}
        with lock:      # reload: another turn on this chat may have been saved while this one was answered
            saved = load_chat(chat["id"])
            if saved is None and not (created or joined):       # deleted while answering: don't bring it back
                raise TutorError("That chat was deleted while it was answering.", 410)
            chat = saved or chat
            chat["session"] = r["session"] or chat.get("session")       # the last finished turn's
            chat["updated"] = time.strftime("%Y-%m-%d %H:%M")
            q = {"role": "q", "mode": mode, "deck": tag, "slide": n, "text": label}
            if whole_deck:
                q["whole"] = True
            if spoken:
                q["spoken"] = True
            chat["messages"] = chat.get("messages", []) + [q, msg]
            save_chat(chat)
    finally:
        if created:
            with lock:
                _PENDING.pop(chat["id"], None)
    if mode == "voice":
        remember(cdir, tag, None if whole_deck else n, question.strip(), r["text"])
    elif spoken and mode == "ask":      # a spoken question typed into Ask is remembered like a voice turn
        remember(cdir, tag, n, question.strip(), r["text"])
    elif mode == "grill_reply":     # a missed point in a grill goes into the same notes as a corrected voice mistake
        remember(cdir, tag, n, question.strip(), r["text"], grill=True)
    return chat, msg


def warm_chat(cdir, tag, model, web):
    """Open the course's chat client before the first question (Voice chosen): no turn is sent. A course
    with no chat yet gets its id reserved, so the next new chat uses the client opened here."""
    with _course_lock(cdir):
        chat_id = current_chat(cdir)
        chat = load_chat(chat_id) if chat_id else None
        if chat is None and chat_id in _PENDING:
            return      # its first turn is already opening it
        if chat is None:
            chat = {"id": _WARM_IDS.setdefault(cdir.name, uuid.uuid4().hex[:12])}
    engine.open_chat((cdir.name, chat["id"]), cdir, system_prompt(cdir, tag, web),
                     model=model if model in MODELS else DEFAULT_MODEL, web=web, session=chat.get("session"), log=log)


# ---------------------------------------------------------------- voice turns and the tutor's memory
# A spoken question in mode "voice" (the retired Talk tab's; dictated questions now go as asks with spoken: true).
# Its prompt is voice_prompt.md (read on every turn, so it can be tuned without a restart). The voice tutor keeps notes on the student in
# <course>/study/tutor-memory.md: read into every voice turn, and rewritten after each one by a quick one-off
# call in the background, so the next answer knows what was asked again and which mistakes were corrected.
# Answers typed during a Grill me feed the same notes (what the grill found wrong), and a grill steers by them.

VOICE_PROMPT = HERE / "voice_prompt.md"
MEMORY_MODEL = "claude-haiku-4-5"
MEMORY_TITLE = "# What your tutor remembers"
MEMORY_HEAD = MEMORY_TITLE + "\n\n_Kept by the Study Hub's tutor after each spoken question and grill answer. Edit or delete anything._\n\n"
MEMORY_SECTIONS = ("About me", "Questions I keep asking", "Mistakes I've corrected", "Still shaky")
_MEMORY_LOCKS = {}
_MEMORY_LOCKS_LOCK = threading.Lock()


def memory_file(cdir):
    return cdir / "study" / "tutor-memory.md"


def _read_memory(cdir):
    """(the file's text, its mtime) — ("", None) when there's no file yet."""
    f = memory_file(cdir)
    try:
        return f.read_text(encoding="utf-8", errors="replace").strip(), f.stat().st_mtime_ns
    except FileNotFoundError:
        return "", None


def memory_text(cdir, text=None):
    """The notes without the file's title and intro line (from the first "## " heading on)."""
    text = _read_memory(cdir)[0] if text is None else text
    m = re.search(r"^## ", text, re.M)
    return text[m.start():].strip() if text.startswith(MEMORY_TITLE) and m else text


def known_mistakes(cdir, limit=3000):
    """Weak topics and the error log from progress.md (marked mocks), for the voice tutor to steer by."""
    f = cdir / "study" / "progress.md"
    if not f.is_file():
        return ""
    text = f.read_text(encoding="utf-8")
    out = [f"### {h}\n{L.section(text, h).strip()}" for h in ("Weak topics", "Error log") if L.section(text, h).strip()]
    return "\n\n".join(out)[:limit]


def weak_points(cdir):
    """What a grill steers towards: progress.md's weak topics and error log, and the notes' Still shaky."""
    shaky = L.section(memory_text(cdir), "Still shaky").strip()
    out = [known_mistakes(cdir)] + ([f"### Still shaky (tutor's notes)\n{shaky}"] if shaky and shaky != "- (nothing yet)" else [])
    return "\n\n".join(x for x in out if x) or "(none recorded yet)"


def voice_prompt(cdir, where_, question):
    t = re.sub(r"<!--.*?-->\s*", "", VOICE_PROMPT.read_text(encoding="utf-8"), flags=re.S).strip()
    fill = {"where": where_, "question": question, "memory": memory_text(cdir) or "(nothing yet: this is a new student)",
            "mistakes": known_mistakes(cdir) or "(none recorded yet)"}
    # Plain replacement, not str.format: the file is edited by hand and may contain other braces.
    return re.sub(r"\{(where|question|memory|mistakes)\}", lambda m: fill[m.group(1)], t)


MEMORY_SCHEMA = {"type": "object", "properties": {
    "changed": {"type": "boolean", "description": "False only if the exchange adds nothing to the notebook."},
    "memory": {"type": "string", "description": "The whole updated notebook as Markdown, starting with "
                                                "'## About me'; not a summary of the exchange."}},
    "required": ["changed", "memory"], "additionalProperties": False}
MEMORY_SYSTEM = """You keep a tutor's private notebook about one student. Answer only with the structured output;
don't open any files."""
MEMORY_PROMPT = """Today is {today}. Here is the notebook so far:

<notebook>
{memory}
</notebook>

Here is the latest {exchange}, on deck [{tag}] {at}.{heard}

<student>{question}</student>
<tutor>{answer}</tutor>
{hint}
Update the notebook from this exchange. Return the complete notebook as Markdown starting with these four
sections, in this order, each a short bullet list (a section with nothing in it says "- (nothing yet)"):

## About me
How this student likes things explained, what they already know well, what they're aiming for. Only from
something the student explicitly said about themselves or their preferences ("I'm a visual learner", "I did
economics in high school"). Never infer it from what they asked.
## Questions I keep asking
One concept per line, by concept rather than word for word, with a count and the last date, e.g.
"- When demand counts as elastic (3 times, last {today}, [S&D-3])". If this exchange asks about a
concept already listed, raise its count and date instead of adding a line. Count only the same concept: "how
demand slopes down", "what shifts the demand curve" and "why demand slopes down" are three lines, not one.
## Mistakes I've corrected
"- Thought X, actually Y ([{tag}])". If the student states something wrong and the tutor corrects it ("Not
quite", "Actually", "No, ..."), it MUST go here and "changed" must be true; if it's already listed, add
"(again, {today})". A plain question with no wrong claim in it is not a mistake.
## Still shaky
Every concept asked about 3 or more times, and every corrected mistake that came back. An item stays under
Questions I keep asking (with its count) when it's also listed here; don't move it out. Remove an item from
here once later exchanges show they've got it.

Rules:
- Record only what this exchange and the notebook show; never invent.
- Deck references are the deck tag in square brackets, exactly as given: [{tag}].
- Plain words; no maths symbols or formulas needed.
- The student may edit this notebook. Keep every line they wrote themselves as it is, and keep any other "## "
  section they added, word for word, after the four sections.
- Keep the whole notebook under 400 words; drop the oldest one-off questions first.
- "changed" is false only if the exchange adds nothing at all (then return the notebook unchanged). A new or
  repeated question, or a corrected mistake, is always a change."""
# An answer that opens like this corrected the student: the memory prompt is told so (Haiku missed it otherwise).
CORRECTION = re.compile(r"^\W*(not quite|actually|no[,.!]|nope|that's not|that is not|that isn't|not really|"
                        r"close,? but)", re.I)
MEMORY_HINT = """
Note: the tutor's answer opens with a correction, so the student said something wrong. Record it under
Mistakes I've corrected.
"""
MEMORY_SPOKEN = """ The question came through speech recognition,
so ignore misheard words."""
MEMORY_GRILL = """ The tutor is grilling the student (asking them
questions); the student's text is their typed answer to its last question, not a question of their own. Record
under Mistakes I've corrected what the tutor said was wrong or missing ("Not quite", "Right, but"), and nothing
under Questions I keep asking."""
MEMORY_RETRY = """

Your last reply put a summary in "memory". It must be the whole notebook itself: the four "## " sections with
their bullets, as described above."""


def remember(cdir, tag, n, question, answer, grill=False):
    """Update the tutor's notes on the student after a voice turn (or a grill answer: grill=True), in the
    background (nobody waits for it)."""
    def work():
        with _MEMORY_LOCKS_LOCK:
            lock = _MEMORY_LOCKS.setdefault(cdir.name, threading.Lock())
        with lock:      # one update at a time per course, each starting from the last one's result
            f = memory_file(cdir)
            tmp = f.with_suffix(".md.tmp")
            try:
                text, mtime = _read_memory(cdir)
                hint = MEMORY_HINT if CORRECTION.match(answer.replace("’", "'")) else ""
                prompt = MEMORY_PROMPT.format(today=time.strftime("%Y-%m-%d"), tag=tag, hint=hint,
                                              exchange="grill exchange" if grill else "spoken exchange",
                                              heard=MEMORY_GRILL if grill else MEMORY_SPOKEN,
                                              at=f"slide {n}" if n else "(about the whole deck)",
                                              memory=memory_text(cdir, text) or "(empty: this is the first exchange)",
                                              question=question[:2000], answer=answer[:4000])
                for attempt in (1, 2):      # Haiku now and then returns a summary instead of the notebook: once more
                    r = run_claude(cdir, MEMORY_SYSTEM, prompt + (MEMORY_RETRY if attempt == 2 else ""),
                                   model=MEMORY_MODEL, schema=MEMORY_SCHEMA, web=False, label="memory")
                    body = str(r["json"].get("memory", "")).strip()
                    if not r["json"].get("changed"):
                        return log(f"memory unchanged course={cdir.name}")
                    # the four sections must be there (the student may have added more); "I’ve" counts as "I've"
                    heads = {re.sub(r"\s+", " ", h).strip(" :").replace("’", "'").lower()
                             for h in re.findall(r"^##[ \t]+(.+)$", body, re.M)}
                    missing = [sec for sec in MEMORY_SECTIONS if sec.lower() not in heads]
                    if not missing:
                        break
                    log(f"memory rejected: missing sections {missing} attempt={attempt} course={cdir.name}")
                else:
                    return
                tmp.write_text(MEMORY_HEAD + body + "\n", encoding="utf-8")
                if _read_memory(cdir)[1] != mtime:     # the student edited it meanwhile: their edit wins
                    tmp.unlink()
                    return log(f"memory skipped: edited meanwhile course={cdir.name}")
                os.replace(tmp, f)
            except Exception as e:      # the notes just stay as they were
                log(f"memory update failed: {type(e).__name__}: {str(e)[:200]}")
                tmp.unlink(missing_ok=True)
    threading.Thread(target=work, daemon=True).start()


# ---------------------------------------------------------------- side questions (a term or a selection)
# A side question forks the course's chat: it starts from a copy of the conversation, so it knows what was said,
# and nothing it says is added to the chat. Follow-ups continue the fork. Nothing is saved; closing ends it.

SIDE_TERM = """Side question: the student tapped "{anchor}" in your answer, in this passage:

> {para}

(They are on slide {where}.) Explain just that, as a short aside: what it is (the rule or definition, in KaTeX
where it's math), one tiny example with numbers, and in one line how it shows up here. About 120 words. Mark
terms as usual."""
SIDE_SELECTION = """Side question about this part of your answer (the student is on slide {where}):

> {anchor}

{question}

Answer just that, briefly: about 150 words unless they ask for more. Mark terms as usual."""
_SIDES = {}         # side id -> {"key", "session", "tag"}
_SIDES_LOCK = threading.Lock()


def _quote(t, limit):
    t = " ".join(str(t or "").split())
    return t if len(t) <= limit else t[:limit].rsplit(" ", 1)[0] + " …"


def side_turn(cdir, tag, n, side_id, chat_id, anchor, para, question, model, web, emit=None):
    """One answer in a side question. side_id None → a new side question (forking chat_id's conversation)."""
    with _SIDES_LOCK:
        side = _SIDES.get(side_id) if side_id else None
    if side_id and not side:
        raise TutorError("That side question was closed. Ask it again.", 410)
    if side:
        prompt, session, fork = question.strip(), side["session"], False
    else:
        if not anchor.strip():
            raise TutorError("Nothing to ask about.", 400)
        chat = load_chat(chat_id) if chat_id else None
        if chat and chat.get("course") != cdir.name:
            chat = None
        side_id = uuid.uuid4().hex[:12]
        side = {"key": (cdir.name, f"side-{side_id}"), "session": None, "tag": tag}
        fill = dict(anchor=_quote(anchor, 1500), para=_quote(para, 600), where=where(cdir, tag, n), question=question.strip())
        prompt = (SIDE_SELECTION if question.strip() else SIDE_TERM).format(**fill)
        session = chat.get("session") if chat else None
        fork = bool(session)
    r = run_claude(cdir, system_prompt(cdir, tag, web), prompt, model=model, chat_key=side["key"], session=session,
                   fork=fork, web=web, label="side", emit=emit)
    side["session"] = r["session"]
    with _SIDES_LOCK:
        _SIDES[side_id] = side
    return side_id, {"role": "a", "text": r["text"], "ms": r["ms"], "cost": r["cost"], "model": model}


def side_close(side_id):
    with _SIDES_LOCK:
        side = _SIDES.pop(side_id, None)
    if side:
        engine.close_chat(side["key"])


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


def course_chats(cdir):
    """Every saved chat in one course, newest first (for the 'earlier chats' list)."""
    return [c for c in list_chats() if c.get("course") == cdir.name]


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
    focus = str(req.get("focus") or "").strip()[:500]
    if focus:       # /try with the student's own words
        task += (f'\n\nThe student asked for this problem: "{focus}". Follow it (topic, difficulty, kind of '
                 f'question) as long as it fits the slides.')
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
           "hints_used": 0, "attempts": [], "photos": [], "created": time.strftime("%Y-%m-%d %H:%M"), "focus": focus,
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
    if req.get("kind") in ("try", "deck", "mixed") and not req.get("focus"):      # a prefetched one has no focus
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
