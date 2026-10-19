---
name: preparing-slides
description: Use when new lecture slides or lesson PDFs land in a course's course/WeekN folder (or homework / practice exams in course/practice) and need preparing for the Study Hub — "build week 3", "new slides were posted", "prepare week 4", "add the new deck", or a course/WeekN PDF with no transcript in .cache/WeekN. Extracts slide images, transcribes every slide faithfully (equations, diagrams, handwriting), audits the transcription, and files each deck under a topic. All courses.
---

# Preparing slides

The Study Hub is slide-first: Course → Topic → Deck → Slide. The student reads the
real slides; the tutor answers from faithful transcripts. This skill makes a week's decks ready for that.
No study guides are written.

## What you produce

| Output | What it is |
|---|---|
| `<course>/study/slides/<tag>-sNNN.jpg` | Every page as an image (the viewer shows these) |
| `<course>/.cache/WeekN/<deck>.transcript.md` | One `## [<tag> sN] <title>` section per page: all text verbatim, equations in KaTeX, diagrams described, handwriting marked, `Possible erratum:` notes, a `Type:` line |
| `<course>/.cache/WeekN/audit-<deck>-p<a>-<b>.md` | The independent audit log (every page checked against its image) |
| `<course>/CLAUDE.md` deck table | One row per deck, in lecture order: `Week · Deck · Tag · Topic`; and the Topics table's `Read more` for any new topic |
| `<course>/study/progress.md` | New dates the slides announce (Deadlines table, with `Covers` for tests) |

## Workflow

`S` = this skill's folder. Scripts take the course folder and week number. Everyone — you and every agent —
writes files with the Write/Edit tools, never shell heredocs (they mangle `\\` in KaTeX).

1. **Extract.** `python S/scripts/extract.py <course> N`. It lists decks with no row in the course CLAUDE.md
   deck table: add them now, in lecture order, with a tag (short, e.g. `S&D-5`, `Ch3`, `U3-2`) and leave
   Topic for step 4. Re-run (no `--force`) if you added rows: untranscribed decks pick up the new tag; existing
   transcripts are kept unless the PDF changed. `--force` rewrites every deck in the week — never use it
   to apply a tag.
2. **Transcribe** every VISUAL-PENDING page from its PNG (prompt 1 in `reference/agent-prompts.md`;
   ≤ 45 pages per agent, in parallel). Text layers lose superscripts, equations, diagrams and handwriting —
   never judge a page "clean enough" to skip. `python S/scripts/check.py <course> N transcripts` → OK.
3. **Audit** (prompt 1b): fresh agents compare every page image — admin and text-layer pages included —
   with its transcript and fix omissions and misreads in place, logging each change.
   `python S/scripts/check.py <course> N audit` → OK. The tutor is only as good as this step.
   Then collect every `Possible erratum` and check the slides' claims, formulas and code yourself.
4. **File each deck under a topic.** A topic is a group of whole decks the student studies together
   (e.g. "Supply and Demand" = S&D-1…4). For each new deck: join an existing topic in the Topics table
   when it continues that idea, otherwise start a new one named the way the syllabus would (1–4 words).
   Never split a deck. Show the student one line per deck — `S&D-5 → Supply and Demand (existing)` —
   and ask them to confirm or change it; then write the Topic cells. For a new topic, add a Topics-table
   row with **Read more**: the textbook sections (from the slides' own citations first; the textbooks'
   contents are in `.cache/textbooks/*.toc.md`) or, where there is one, the official documentation.
   `python S/scripts/check.py <course> N sorted` → OK.
5. **Dates.** If the slides announce a quiz, test, due date or scope, update the Deadlines table in
   `study/progress.md` (for tests: `Covers` = the weeks, e.g. `W4–6`, add `(assumed)` if not stated).
6. **Report** to the student: decks prepared, pages, slide errors found (one line each), the topic each
   deck went under. Then point them to the Study Hub (`start.bat`) — new decks show up on
   the next page load; nothing needs restarting.

**Homework and practice exams** live in `<course>/course/practice/` and are prepared the same way with
`practice` in place of the week number (`extract.py <course> practice`, `check.py <course> practice …`);
everything goes to `.cache/practice/` instead of `.cache/WeekN/`. Pages are problems, not slides: transcribe
them verbatim (blank answer space noted in one line), type them `exercise`, and never add solutions. Their
deck-table Week is the latest lecture week whose material they exercise (the hub uses it for order and test
scope); their Topic cell is `Practice`: the hub lists them on their own, apart from the topics.

Before starting, read `<course>/CLAUDE.md`. If `study/progress.md` doesn't exist, create it with
`## Deadlines` (`| Date | Item | Weight | Status | Covers |`), `## Weak topics`, `## Error log` and
`## Review queue` ("Kept by the Study Hub in `study/hub-state.json`").

## Course differences

Take them from the course CLAUDE.md, not memory:

| Course | Slides look like | Watch for |
|---|---|---|
| Slide type A | Annotated lecture slides; handwriting over equations | Handwritten derivations and corrections carry the real content — transcribe every stroke |
| Slide type B | Chapter decks with diagrams and tables | Tables and charts: every cell and axis |
| Slide type C | Web pages or documents saved as PDF (portrait, "s" = page) | Code and lists verbatim; an index page is admin |

## Common mistakes

| Mistake | Effect | Instead |
|---|---|---|
| Judging a page "clean text" by eye | $x^n-1$ read as "xn - 1"; diagram slides vanish | Transcribe every VISUAL-PENDING page |
| Explaining or correcting in the transcript | The tutor can't tell what the slide actually said | Verbatim only; slide errors stay, marked `Possible erratum:` |
| Several agents editing one transcript with whole-file writes | Lost pages | Edit tool, own pages only (prompt 1) |
| Trusting a transcript because every page has a section | A skipped bullet or misread exponent passes every check | Step 3: an independent page-by-page audit against the images |
| Filing a deck without asking | Topics drift from how the student thinks of the course | One line per deck, student confirms (step 4) |
| Splitting a deck across topics | Citations and progress break | Whole decks only |
