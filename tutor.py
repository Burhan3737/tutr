"""The tutor: what the Study Hub asks Claude, and what it does with the answers.

How the calls are made (the Claude Agent SDK on the Claude Code login, one open conversation per
course chat, streaming, the course-folder check) lives in engine.py. This file holds the prompts and the
study logic.

Modes
- chat (explain / example / quiz / map / before / cheatsheet / grill / ask / deeper / brush / side): Markdown answers
  streamed into the course's chat; a grill runs over several turns (the student's answers come back as grill_reply)
- drill (drill / drill_reply / drill_hint / drill_reveal / drill_skip / drill_end): an exam drill in its own chat:
  exam-style questions from a range of decks in the format of the practice papers picked, worked on paper; the
  range and a log of the questions live on the chat (chat["drill"])
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
import opencode_engine
import state as S

HERE = Path(__file__).resolve().parent
WORK = HERE / ".cache"
TIMEOUT = engine.TIMEOUT
# The two tutor engines: Claude Code (engine.py) and OpenCode (opencode_engine.py). A model id with a provider
# slash ("opencode/big-pickle") is an OpenCode one; a plain id ("claude-opus-5-5") is Claude's. The number is
# the intelligence score the model picker shows (0–99, higher is more capable).
CLAUDE_MODELS = {
    "claude-opus-5-5": ("Opus 5.5", 96, "Claude Code"),
    "claude-sonnet-5-5": ("Sonnet 5.5", 88, "Claude Code"),
    "claude-haiku-4-5": ("Haiku 4.5", 74, "Claude Code"),
}
DEFAULT_MODEL = "claude-opus-5-5"
_LOG_LOCK = threading.Lock()


def log(msg):
    WORK.mkdir(exist_ok=True)
    with _LOG_LOCK, open(WORK / "hub.log", "a", encoding="utf-8") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")


TutorError = engine.EngineError


def model_engine(model):
    """Which engine runs this model."""
    return "opencode" if "/" in str(model or "") else "claude"


def valid_model(model):
    """A Claude model, or an OpenCode provider/model id (new ones are allowed without a catalog refresh)."""
    if not isinstance(model, str) or not model:
        return False
    if model in CLAUDE_MODELS:
        return True
    return bool(re.fullmatch(r"[a-z0-9][a-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*", model))


def model_catalog():
    """Every model the tutor can use, grouped by provider: Claude Code first, then OpenCode's models (live if the
    server can be reached, else the cached or curated list), each group by intelligence score."""
    models = [{"id": k, "label": label, "iq": iq, "provider": provider}
              for k, (label, iq, provider) in CLAUDE_MODELS.items()]
    try:
        found = opencode_engine.known_models()
    except Exception:
        found = []
    groups = {}
    for m in found:
        groups.setdefault(m.get("provider") or "OpenCode", []).append(m)
    for provider in sorted(groups, key=lambda p: -max(m.get("iq") or 0 for m in groups[p])):
        models += sorted(groups[provider], key=lambda m: (-(m.get("iq") or 0), m.get("label") or ""))
    return {"default": DEFAULT_MODEL, "models": models}


def _claude_session(session):
    return None if str(session or "").startswith("ses_") else session


def _opencode_session(session):
    return session if str(session or "").startswith("ses_") else None


def run_model(cdir, system, prompt, *, model, session=None, fork=False, schema=None, web=True, label="", chat_key=None,
              emit=None):
    """Ask whichever engine the model belongs to. Returns {"text", "json", "session", "ms", "cost"}."""
    model = model if valid_model(model) else DEFAULT_MODEL
    if model_engine(model) == "opencode":
        return opencode_engine.run(cdir, system, prompt, model=model, web=web, schema=schema, chat_key=chat_key,
                                   session=_opencode_session(session), fork=fork, emit=emit, log=log,
                                   label=f"{label} course={L.course_meta(cdir)[0]}")
    return engine.run(cdir, system, prompt, model=model, web=web, schema=schema, chat_key=chat_key,
                      session=_claude_session(session), fork=fork, emit=emit, log=log,
                      label=f"{label} course={L.course_meta(cdir)[0]}")


def open_chat(chat_key, cdir, system, *, model, web=True, session=None, log=None):
    """Warm a chat's engine before the first question (no turn, no cost)."""
    model = model if valid_model(model) else DEFAULT_MODEL
    log = log or globals()["log"]
    if model_engine(model) == "opencode":
        opencode_engine.open_chat(chat_key, cdir, system, model=model, web=web,
                                  session=_opencode_session(session), log=log)
    else:
        engine.open_chat(chat_key, cdir, system, model=model, web=web, session=_claude_session(session), log=log)


def close_chat(chat_key):
    """Forget a chat in both engines (a saved chat's session is left on OpenCode's server for resume)."""
    engine.close_chat(chat_key)
    opencode_engine.close_chat(chat_key)


def shutdown():
    """Stop both engines when the hub stops."""
    for stop in (engine.shutdown, opencode_engine.shutdown):
        try:
            stop()
        except Exception:
            pass


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

# Exam drill: exam-style questions one at a time from a range of decks the student picked, in the format of the
# practice papers they picked (or of the course's assessments), solved on paper. Like the grill it runs over several
# turns ("drill" opens, the student's replies come back as "drill_reply", the buttons send drill_hint / drill_reveal /
# drill_skip / drill_end), but its range and papers live on the chat (chat["drill"]) and every turn's prompt carries
# them again with a ledger of the questions so far, so the range and the rotation hold over a long chat. Each closed
# question ends with a hidden <!--drill {...}--> line: the server strips it, logs the question, and sends a missed one
# to the review queue (a clean solve marks its deck solved).
DRILL_SUMMARY = """#### How the drill went
**Marks:** <one line per topic asked: topic · marks earned/available>
**Held up:** <bullets: what they showed they can write for full marks, each with its slide>
**Shaky:** <bullets: each gap, the right idea in one line, its slide; "- nothing" if none>
**Next:** <one line: the topic or question type to drill next>"""
DRILL_RULES = """

Range: ask only from these decks, never from a deck outside them, even one in the same topic:
{range}
Format model: {papers}
{focus}So far in this drill (kept by the hub; trust it over your memory of the chat):
{ledger}
Known weak points of this student (steer towards any inside the range; don't mention the list):
{mistakes}

The paper is the format, never the source. From it take the question types, the parts and marks per part, how
much working earns marks, the command verbs ("prove", "state the constants", "justify", "trace", "which and
why") and the length. Write new questions of those types on any deck in the range, including decks the paper never
asks about. Never reuse a paper's question or a slide's own example: change the setting, the numbers and what is
asked. Before writing a question on a deck whose slides aren't included below, Read its transcript (the map has
the path), and stay inside what it teaches.

Choosing the next question:
- Cover every deck in the range before repeating one, out of deck order; each question changes topic from the
  last one and, where the format allows, question type.
- Begin with the format's smaller parts; move to full-weight questions once two answers hold up.
- A concept missed earlier comes back 2–4 questions later, in a different form.
- A skipped question is listed under revisit and asked again later in the cycle, in a new form.

Asking, this shape, then stop:
**Q<n> · <topic> · <question type>** [<marks> marks] (style of [<paper tag> s<N>] <its question number>, when
there is a paper)
<the question, with its parts and the marks per part as the format sets them; a big design or proof question
opens with a small part that gives a way in>
**Slides you can use:** <2–4 slides, each with a few words on what it gives: the definition, the rule, a similar
example>
No hint, no method, no answer.

The student works on paper. Never ask them to type out their working: they send the result and the key steps,
often dictated by voice ("p squared", "10" for p), or a photo of the page. Read them generously, say in one
line how you read anything unclear, and never take marks off for transcription. A photo is marked like typed work.
A part they say is done on paper is taken as attempted; the write-up shows what it should contain.

Each reply, until the drill ends:
- An attempt, even a guess ("is it n²?"): for each part, "Right", "Right, but" or "Not quite" and the marks it
  would earn as it stands, e.g. (2/3): method marks for a valid approach, accuracy marks for the result, none for
  a bare answer where the format asks for working. Then the first wrong or missing step in one line, and a hint.
- A question ("which slide?", "how do I get…?", "am I on track?"): answer it as a hint, never with the answer.
- Hints climb one rung each time they stay stuck on the same point: (1) the slide and the rule or feature to use,
  asked as a question; (2) the first line, or the working with blanks to fill; (3) tiny numbers, a small table or
  a drawing aimed at what they misread. A hint never states the result it leads to. About 150 words.
- Only when they ask for the answer in so many words (give me / show me / lay out / go to the answer, "let's
  just solve it", "I give up"): the write-up at once, for the whole question unless they name a part.
- When every part is right, by them or revealed: the write-up, then the next question.

The write-up, this shape, up to about 450 words; keep it tight so the next question isn't buried:
#### Q<n> · Solution 1: as written for full marks
<the answer as it should look on paper, the shortest version that earns full marks: each line that earns a mark
tagged at its end as [1], constants and conditions explicit, the rule behind each step named>
#### Solution 2: shortcut
<a faster route or a check (a theorem, a pattern, a small case, a bound), and one line on whether it earns full
marks written alone or only checks the answer>
#### Method for variants
<a numbered recipe in general symbols that solves this kind of question, then 2–3 one-line variants it also
solves: other numbers, a changed condition, the reverse question>
**Common mistakes:** <2–3 one-liners; the student's own mistake first, if they made one>
**Slides:** <every slide the write-up used>
**Tally:** Q<n> <marks earned>/<marks set> · decks covered: <n of N> · revisit: <missed concepts, or none>
<!--drill {{"q": <n>, "deck": "<the deck tag it tests>", "slides": "<e.g. TAG s14–s16>", "concept": "<at most 8 words>", "problem": "<the question as asked, under 120 words, Markdown/KaTeX>", "marks": "<earned>/<set>", "outcome": "<solo | hinted | revealed | skipped>", "mistake": "<none | No attempt | Concept gap | Setup | Method choice | Algebra slip | Skipped step>"}}-->

---
<the next question>

The <!--drill …--> line is read by the hub, never shown: exactly one, on its own line, valid JSON, only in a reply
that closes a question (the write-up, or a skip). outcome: solo = they reached it with no hints; hinted = they
reached it after hints; revealed = you gave the answer; skipped = they moved on. mistake = their first error (none
if there was none).

End when the student asks to stop: instead of a new question, this summary:

""" + DRILL_SUMMARY
DRILL_PROMPTS = {
    "drill": """Run an exam drill: questions like the real paper, one at a time, until the student stops.
This turn: one line restating the range as its first and last deck and anything left out (e.g. "[A] → [F], not
[D]"), so a wrong range shows up at once; one line naming the question types and mark weights you will mirror;
then Q1.""" + DRILL_RULES,
    "drill_reply": """The student's reply in the exam drill (they are on slide {where}):

{question}{photos}

Carry on the drill by its rules: mark it or hint, the answer only on an explicit request, then the write-up and
the next question; or, if they asked to stop, the summary.""" + "{rules}",
    "drill_hint": """The student asks for a hint on the open question. Give the next rung of the hint ladder, not the
answer.{photos}""" + "{rules}",
    "drill_reveal": """The student asks for the answer to the open question (all of it). Mark anything they sent first,
then the write-up and the next question.{photos}""" + "{rules}",
    "drill_skip": """The student skips the open question for now: no write-up. One line naming what it tested, the hidden
drill line with outcome skipped, then the next question (a different topic).""" + "{rules}",
    "drill_end": """End the drill now: no new question. If a question is open, close it first with its hidden drill
line (outcome skipped). Then, from every answer in this drill, this summary:

""" + DRILL_SUMMARY + """

If no drill has run in this chat, say so in one line instead.""" + "{rules}",
}
DRILL_MODES = set(DRILL_PROMPTS)
DRILL_TAG = re.compile(r"[ \t]*<!--\s*drill\s*(\{.*?\})\s*-->[ \t]*\n?", re.S)
# Later drill turns get the rules again in short (the full set opened the drill; the ledger is what moves on).
DRILL_REMIND = """

Drill reminder: range {range_short}. {focus}So far:
{ledger}
Keep to the drill's rules from its first turn: one question at a time, never outside the range, the answer only on an
explicit request, the write-up shape with the hidden drill line when a question closes."""


def drill_config(cdir, decks, papers, focus=""):
    """A drill's range and papers, checked against the course: lecture decks in lecture order, practice decks."""
    info = L.course_info(cdir)
    practice = set(info["practice"])
    order = [d["tag"] for d in L.deck_order(cdir)]
    want = {str(t) for t in decks or []}
    decks = [t for t in order if t in want and t not in practice]
    if not decks:
        raise TutorError("Pick at least one deck for the drill.", 400)
    want = {str(t) for t in papers or []}
    papers = [t for t in order if t in want and t in practice]
    return {"decks": decks, "papers": papers, "focus": " ".join(str(focus or "").split())[:500],
            "started": time.strftime("%Y-%m-%d %H:%M"), "log": [], "photos": []}


def drill_setup(cdir):
    """What the drill's setup dialog shows: the decks by topic, the practice papers, and a default range (the next
    test's weeks, or the last drill's choice)."""
    info = L.course_info(cdir)
    nxt = L.next_assessment(cdir)
    lecture = [d for d in L.deck_order(cdir) if d["tag"] not in info["practice"]]
    topics = []
    for d in lecture:
        if not topics or topics[-1]["name"] != d["topic"]:
            topics.append({"name": d["topic"], "decks": []})
        topics[-1]["decks"].append({"tag": d["tag"], "title": d["title"], "week": d["week"]})
    last = next((c.get("drill") for c in map(load_chat, (x["id"] for x in course_chats(cdir))) if c and c.get("drill")), None)
    if last:
        default = {"decks": last["decks"], "papers": last["papers"], "focus": last.get("focus", "")}
    else:
        lo, hi = nxt["weeks"] if nxt else (0, 99)
        default = {"decks": [d["tag"] for d in lecture if lo <= d["week"] <= hi], "papers": [], "focus": ""}
    return {"topics": topics, "papers": [{"tag": t, "title": info["decks"][t]["title"]} for t in info["practice"]],
            "default": default, "last": bool(last),
            "next": nxt and {"name": nxt["name"], "weeks": nxt["weeks"], "assumed": nxt["assumed"]}}


def _range_text(cdir, cfg):
    info = L.course_info(cdir)
    out, topic = [], None
    for t in cfg["decks"]:
        d = info["decks"][t]
        if d["topic"] != topic:
            topic = d["topic"]
            out.append(f"- {topic}:")
        out.append(f"  - [{t}] {d['title']}")
    left = [d["tag"] for d in L.deck_order(cdir) if d["tag"] not in cfg["decks"] and d["tag"] not in info["practice"]]
    if left:
        out.append(f"Not in range (never ask from these): {', '.join(f'[{t}]' for t in left)}")
    return "\n".join(out)


def _range_short(cfg):
    ds = cfg["decks"]
    return f"[{ds[0]}] → [{ds[-1]}] ({len(ds)} decks: {', '.join(ds)})" if len(ds) > 1 else f"[{ds[0]}] only"


def _papers_text(cdir, cfg):
    if cfg["papers"]:
        info = L.course_info(cdir)
        return ("the practice paper(s) " + ", ".join(f"[{t}] {info['decks'][t]['title']}" for t in cfg["papers"]) +
                " (their pages are included below). Questions only; any solution you give is your own.")
    return ("no sample paper was picked: mirror the format of this course's next assessment (CLAUDE.md: its format, "
            f"time and aids; question style: {STYLE.get(info_code(cdir), 'exam-style questions')}). Exercise and "
            "self-check slides in the range show the kind of question the course sets.")


def info_code(cdir):
    return L.course_meta(cdir)[0]


def _ledger(cfg):
    """The questions so far, from the hidden drill lines: what's been asked, how it went, what's still to come."""
    log_ = cfg.get("log", [])
    if not log_:
        return "- nothing yet: this is the first question."
    out = [f"- Q{e.get('q', '?')} [{e.get('deck', '?')}] {e.get('concept', '')}: {e.get('marks', '?')}, {e.get('outcome', '?')}"
           for e in log_[-15:]]
    asked = {e.get("deck") for e in log_}
    todo = [t for t in cfg["decks"] if t not in asked]
    out.append(f"- Decks not asked yet this cycle: {', '.join(todo) if todo else 'none: start the next cycle, weakest first'}")
    redo = [f"{e.get('concept') or 'Q' + str(e.get('q', '?'))} [{e.get('deck', '')}]" for e in log_[-15:] if e.get("outcome") in ("hinted", "revealed", "skipped")
            or e.get("mistake", "none") != "none"]
    out.append(f"- Revisit (in a new form): {'; '.join(redo) if redo else 'none'}")
    out.append(f"- Next question number: Q{max([int(e.get('q') or 0) for e in log_ if str(e.get('q', '')).isdigit()] + [len(log_)]) + 1}")
    return "\n".join(out)


def drill_system_prompt(cdir, cfg, web):
    """The system prompt of a drill chat: the same whichever deck is open (so jumping to a slide doesn't reopen the
    conversation), with the papers' pages and, when they fit, every deck in the range."""
    info = L.course_info(cdir)
    papers = "\n\n".join(L.deck_context(cdir, t) for t in cfg["papers"])
    decks = "\n\n".join(L.deck_context(cdir, t) for t in cfg["decks"])
    parts = []
    if papers:
        parts.append(f"# The practice paper(s) the drill copies the format of\n\n{papers}")
    if len(papers) + len(decks) <= 100_000:
        parts.append(f"# Slides of every deck in the drill's range\n\n{decks}")
    else:
        parts.append("# Slides of the drill's range\n\nToo many to include: Read a deck's transcript (path in the map) "
                     "before writing a question on it, only the deck you are asking about.")
    return SYSTEM.format(code=info["code"], title=info["title"], sources=SOURCES_WEB if web else SOURCES_SLIDES,
                         context="\n\n".join(parts), course_map=L.course_map(cdir))


def chat_system(cdir, chat, tag, web):
    return drill_system_prompt(cdir, chat["drill"], web) if chat and chat.get("drill") else system_prompt(cdir, tag, web)


def _drill_prompt(cdir, chat, mode, tag, n, question):
    cfg = chat["drill"]
    photos = cfg.get("photos") or []
    photo_txt = ("\n\nPhotos of the student's handwritten working (Read each image file):\n" +
                 "\n".join(f"- {p}" for p in photos)) if photos and mode != "drill" else ""
    focus = f"The student asked for: \"{cfg['focus']}\". Follow it inside the range.\n" if cfg.get("focus") else ""
    fill = {"range": _range_text(cdir, cfg), "papers": _papers_text(cdir, cfg), "focus": focus, "ledger": _ledger(cfg),
            "mistakes": weak_points(cdir), "where": where(cdir, tag, n), "question": question.strip() or "(see the photos)",
            "photos": photo_txt}
    if mode == "drill":
        return DRILL_PROMPTS["drill"].format(**fill)
    rules = DRILL_REMIND.format(range_short=_range_short(cfg), focus=focus, ledger=fill["ledger"])
    return DRILL_PROMPTS[mode].format(**fill, rules=rules)


def _drill_record(cdir, chat, text):
    """Strip the hidden drill lines from an answer; log each closed question on the chat, and send a missed one to the
    review queue (a clean solve marks its deck solved). Returns the text without them."""
    cfg = chat["drill"]
    for raw in DRILL_TAG.findall(text):
        # KaTeX in "problem" comes with single backslashes (\sum, \frac): escape each lone one, keeping \\ and \"
        raw = re.sub(r'\\\\|\\"|\\', lambda m: m.group(0) if len(m.group(0)) == 2 else "\\\\", raw)
        try:
            e = json.loads(raw, strict=False)
        except json.JSONDecodeError:
            log(f"drill tag unreadable chat={chat['id']}: {raw[:200]}")
            continue
        if not isinstance(e, dict):
            continue
        e = {k: str(e.get(k, "")).strip()[:2000] for k in ("q", "deck", "slides", "concept", "problem", "marks", "outcome", "mistake")}
        e["mistake"] = e["mistake"] if e["mistake"] in MARK_SCHEMA["properties"]["mistake"]["enum"] else "none"
        deck_ok = e["deck"] in cfg["decks"]
        m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)", e["marks"])
        full = bool(m) and float(m.group(1)) >= float(m.group(2))
        before = next((x for x in cfg.get("log", []) if e["q"] and x.get("q") == e["q"]), {})
        if before.get("review_id"):         # the same question closed again (e.g. by End the drill): saved once
            e["review_id"] = before["review_id"]
        elif e["outcome"] == "solo" and e["mistake"] == "none" and (full or not m):
            if deck_ok:
                S.mark_solved(cdir, e["deck"])
        elif e["outcome"] != "skipped" and e["problem"]:
            mistake = e["mistake"] if e["mistake"] != "none" else {"revealed": "No attempt", "hinted": "Needed hints"}.get(
                e["outcome"], "Skipped step")       # solo but marks lost: a justification left out
            item = S.add_mistake(cdir, deck=e["deck"] if deck_ok else None, slides=e["slides"], concept=e["concept"],
                                 problem_md=e["problem"], mistake=mistake)
            e["review_id"] = item["id"]
        if before:      # closed again: keep what the first close said
            e = before | {k: v for k, v in e.items() if v and v != "none" and not (k == "outcome" and v == "skipped")}
        e["at"] = time.strftime("%Y-%m-%d %H:%M")
        cfg["log"] = [x for x in cfg.get("log", []) if not (x.get("q") == e["q"] and e["q"])] + [e]
    return DRILL_TAG.sub("", text).rstrip()


DECK_MODES = {"explain_deck","example_deck", "quiz_deck", "map_deck", "before_deck", "cheatsheet_deck", "grill_deck"}
MODE_LABELS = {"explain": "Explain simply", "example": "Worked example", "deeper": "Go deeper", "quiz": "Quiz prep",
               "map_deck": "Big picture · whole deck", "before": "Before you start",
               "before_deck": "Before you start · whole deck", "cheatsheet_deck": "Cheat sheet · whole deck",
               "explain_deck": "Explain simply · whole deck", "example_deck": "Worked example · whole deck",
               "quiz_deck": "Quiz prep · whole deck", "grill": "Grill me", "grill_deck": "Grill me · whole deck",
               "grill_end": "End the grill", "drill": "Exam drill", "drill_hint": "Hint", "drill_reveal": "Show the answer",
               "drill_skip": "Skip this question", "drill_end": "End the drill"}    # grill_reply / drill_reply: the student's words


# A mode asked by slash command (/explain …) can carry the student's own words: added to the mode's prompt.
QUESTION_MODES = {"ask", "brush", "grill_reply", "drill_reply"}       # their prompts already are the student's words
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


def chat_turn(cdir, tag, n, mode, question, model, web, emit=None, whole_deck=False, spoken=False, drill=None):
    """One tutor answer inside the course's chat, about deck tag. Returns the saved message and the chat id. whole_deck: a voice
    question asked with Whole deck chosen (about the deck, not slide n). drill: a new exam drill's config
    (drill_config), for mode "drill": it always starts a new chat."""
    whole_deck = whole_deck and mode == "voice"
    if mode not in CHAT_PROMPTS and mode not in DRILL_MODES and mode != "voice":
        raise TutorError("Unknown request.", 400)
    if mode == "drill" and not drill:
        raise TutorError("Pick the drill's range first.", 400)
    extra = question.strip() if mode in CHAT_PROMPTS and mode not in QUESTION_MODES else ""
    label = MODE_LABELS.get(mode) or (f"Brush up: {question.strip()}" if mode == "brush" else question.strip())
    if extra and mode in MODE_LABELS:
        label = f"{MODE_LABELS[mode]}: {extra}"
    if mode == "drill":
        label = f"Exam drill: {_range_short(drill).split(' (')[0]}" + (f" · {', '.join(drill['papers'])}" if drill["papers"] else "")
    now = time.strftime("%Y-%m-%d %H:%M")
    lock = _course_lock(cdir)
    with lock:
        chat_id = None if mode == "drill" else current_chat(cdir)
        chat = load_chat(chat_id) if chat_id else None
        joined = chat is None and chat_id in _PENDING
        if joined:      # another turn is starting this chat right now: join it
            chat = dict(_PENDING[chat_id])
        created = chat is None
        if created:     # the file is saved only once Claude has answered
            chat = {"id": (None if mode == "drill" else _WARM_IDS.pop(cdir.name, None)) or uuid.uuid4().hex[:12],
                    "course": cdir.name, "code": L.course_meta(cdir)[0], "deck": tag, "created": now, "messages": [],
                    "title": label[:90] if mode == "drill" else
                    f"{label[:70]} · " + (tag if mode in DECK_MODES or whole_deck else f"s{n}")}
            if mode == "drill":
                chat["drill"] = drill
            _PENDING[chat["id"]] = dict(chat, messages=[])
            S.set_chat(cdir, chat["id"])
    if mode in DRILL_MODES and not chat.get("drill"):
        raise TutorError("No drill is running in this chat. Start one with Exam drill.", 400)
    if mode in DRILL_MODES:
        prompt = _drill_prompt(cdir, chat, mode, tag, n, question)
    elif mode == "voice":
        prompt = voice_prompt(cdir, f"the whole deck {deck_where(cdir, tag)}" if whole_deck else f"slide {where(cdir, tag, n)}",
                              question.strip())
    else:
        prompt = CHAT_PROMPTS[mode].format(where=where(cdir, tag, n), question=question.strip(), tag=tag,
                                           deck=deck_where(cdir, tag),
                                           style=STYLE.get(L.course_meta(cdir)[0], "this course's quizzes and exams"),
                                           mistakes=weak_points(cdir) if mode in ("grill", "grill_deck") else "")
        if extra:
            prompt += EXTRA.format(extra=extra[:2000])
    sent_photos = list((chat.get("drill") or {}).get("photos") or []) if mode in DRILL_MODES and mode != "drill" else []
    try:
        r = run_model(cdir, chat_system(cdir, chat, tag, web), prompt, model=model, chat_key=(cdir.name, chat["id"]),
                       session=chat.get("session"), web=web, label=f"chat:{mode}", emit=emit)
        msg = {"role": "a", "mode": mode, "deck": tag, "slide": n, "text": r["text"], "ms": r["ms"], "cost": r["cost"], "model": model}
        with lock:      # reload: another turn on this chat may have been saved while this one was answered
            saved = load_chat(chat["id"])
            if saved is None and not (created or joined):       # deleted while answering: don't bring it back
                raise TutorError("That chat was deleted while it was answering.", 410)
            chat = saved or chat
            if chat.get("drill"):       # the hidden drill lines go into the drill's log, not into the chat's text
                msg["text"] = _drill_record(cdir, chat, msg["text"])
                if sent_photos:         # photos sent with this turn have been read: the next turn starts empty
                    chat["drill"]["photos"] = [p for p in chat["drill"].get("photos", []) if p not in sent_photos]
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
        remember(cdir, tag, None if whole_deck else n, question.strip(), r["text"], model=model)
    elif spoken and mode == "ask":      # a spoken question typed into Ask is remembered like a voice turn
        remember(cdir, tag, n, question.strip(), r["text"], model=model)
    elif mode in ("grill_reply", "drill_reply"):    # a missed point goes into the same notes as a corrected voice mistake
        remember(cdir, tag, n, question.strip(), msg["text"], grill=True, model=model)
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
    open_chat((cdir.name, chat["id"]), cdir, chat_system(cdir, chat, tag, web),
              model=model, web=web, session=chat.get("session"), log=log)


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


def remember(cdir, tag, n, question, answer, grill=False, model=None):
    """Update the tutor's notes on the student after a voice turn (or a grill answer: grill=True), in the
    background (nobody waits for it). On an OpenCode chat the same model does it; otherwise a quick Claude one."""
    mem_model = model if model and model_engine(model) == "opencode" else MEMORY_MODEL
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
                    r = run_model(cdir, MEMORY_SYSTEM, prompt + (MEMORY_RETRY if attempt == 2 else ""),
                                   model=mem_model, schema=MEMORY_SCHEMA, web=False, label="memory")
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
    r = run_model(cdir, system_prompt(cdir, tag, web), prompt, model=model, chat_key=side["key"], session=session,
                   fork=fork, web=web, label="side", emit=emit)
    side["session"] = r["session"]
    with _SIDES_LOCK:
        _SIDES[side_id] = side
    return side_id, {"role": "a", "text": r["text"], "ms": r["ms"], "cost": r["cost"], "model": model}


def side_close(side_id):
    with _SIDES_LOCK:
        side = _SIDES.pop(side_id, None)
    if side:
        close_chat(side["key"])


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
                   | {"starred": bool(c.get("starred")), "drill": bool(c.get("drill")),
                      "count": sum(1 for m in c.get("messages", []) if m["role"] == "q")})
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
    r = run_model(cdir, system_prompt(cdir, scope_tag, web), prompt, model=model, schema=PROBLEM_SCHEMA, web=web,
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
    r = run_model(cdir, system_prompt(cdir, tag, False), prompt, model=model, schema=MARK_SCHEMA, web=False,
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


def _save_image(cdir, stem, data):
    """Save a photo of handwritten work inside the course folder (so the tutor may read it); its relative path."""
    import base64
    m = re.match(r"^data:image/(jpeg|jpg|png|webp);base64,(.+)$", data or "", re.S)
    if not m:
        raise TutorError("That isn't an image.", 400)
    raw = base64.b64decode(m.group(2))
    if len(raw) > 12_000_000:
        raise TutorError("That photo is too large (over 12 MB).", 400)
    ext = "jpg" if m.group(1) in ("jpeg", "jpg") else m.group(1)
    rel = f".cache/uploads/{stem}.{ext}"
    (cdir / rel).parent.mkdir(parents=True, exist_ok=True)
    (cdir / rel).write_bytes(raw)
    return rel


def add_photo(cdir, pid, data):
    rec = get_practice(pid)
    if not rec:
        raise TutorError("That problem has expired.", 404)
    rec["photos"].append(_save_image(cdir, f"{pid}-{len(rec['photos']) + 1}", data))
    _save_practice(rec)
    return {"photos": len(rec["photos"])}


def add_drill_photo(chat_id, data):
    """A photo of the page for the drill's open question: it goes with the student's next reply, then is cleared."""
    with _CHAT_LOCK:
        chat = load_chat(chat_id)
    cdir = L.course_dir(chat["course"]) if chat and chat.get("drill") else None
    if not cdir:
        raise TutorError("That drill is no longer open.", 404)
    with _course_lock(cdir):
        chat = load_chat(chat_id)
        k = sum(1 for _ in (cdir / ".cache" / "uploads").glob(f"drill-{chat_id}-*")) if (cdir / ".cache" / "uploads").is_dir() else 0
        chat["drill"].setdefault("photos", []).append(_save_image(cdir, f"drill-{chat_id}-{k + 1}", data))
        save_chat(chat)
    return {"photos": len(chat["drill"]["photos"])}


def drill_status(chat_id):
    """For the phone's photo page: the drill's title, its open question's number and the photos waiting."""
    chat = load_chat(chat_id)
    if not chat or not chat.get("drill"):
        raise TutorError("That drill is no longer open.", 404)
    return {"title": chat.get("title", "Exam drill"), "photos": len(chat["drill"].get("photos") or []),
            "q": len(chat["drill"].get("log") or []) + 1}
