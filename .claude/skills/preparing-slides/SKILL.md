---
name: preparing-slides
description: Use when new lecture slides, lesson PDFs, homework or practice exams land in a course's sources/WeekN or sources/practice folder (or textbooks in sources/textbooks) and need adding or preparing for the Study Hub — "new slides were posted", "add the new deck", "prepare week 4", or a deck the hub shows as not prepared yet. Add makes a deck appear in the hub in seconds (slide images and a rough text-layer transcript); Prepare transcribes every slide faithfully (equations, diagrams, handwriting), audits the transcription, and files the deck under a topic. Works for any course in the library.
---

# Preparing slides

The Study Hub is slide-first: Course → Topic → Deck → Slide. The student reads the real slides; the tutor
answers from faithful transcripts. This skill is the only thing that reads PDFs: it turns each PDF a course
receives into a deck the hub can show. No study guides are written.

## The course folder

```
<course>/
├── course.json               code, title, assessment_style, topics [{name, read_more}]
├── sources/WeekN/*.pdf       lecture decks as downloaded          (never edit or move)
├── sources/practice/*.pdf    homework and practice exams
├── sources/textbooks/*.pdf   textbooks
├── decks/<folder>/           one deck: deck.json · transcript.md · s001.jpg …   (what the hub shows)
├── textbooks/                <book>.txt (page markers) · <book>.toc.md         (what the tutor searches)
├── me/progress.md            deadlines (Covers = weeks a test covers), weak topics, error log
└── .work/<folder>/           disposable: work transcript, PNGs, scratch, audit logs
```

`<folder>` is the tag with every character other than letters, digits and `-` removed (`S&D-2` → `SD-2`).
`deck.json`: `tag`, `title`, `role` (`lecture` | `practice`), `week`, `topic`, `order`, `pages`, `prepared`,
`source`, `sha1` (the PDF's hash, used by the scripts). A lecture deck with topic `Unsorted` shows under
"Not sorted yet"; a practice deck has no topic and shows in the Practice list.

## Two stages

| Stage | Time | What it does | Deck afterwards |
|---|---|---|---|
| **Add** | seconds, no agents | page images, a rough transcript from the PDF's text layer, `deck.json` | in the hub, `prepared: false`, lecture topic `Unsorted` |
| **Prepare** | the full process | visual transcription, independent audit, topic | `prepared: true`, filed under its topic |

Always Add every new PDF first (the student can read the slides at once), then Prepare when asked
("prepare week 4", "prepare S&D-5") — or straight away if the student asked for the whole thing.

`S` = this skill's folder, `C` = the course folder. Scripts print what they did; read their output.
Everyone — you and every agent — writes files with the Write/Edit tools, never shell heredocs (they mangle `\\`
in KaTeX).

Before starting, read `C/CLAUDE.md` (course facts) and `C/me/progress.md`. If `me/progress.md` doesn't exist,
create it with `## Deadlines` (`| Date | Item | Weight | Status | Covers |`), `## Weak topics`, `## Error log` and
`## Review queue` ("Kept by the Study Hub in `me/hub-state.json`").

### Add

1. `python S/scripts/add.py C --list` shows each PDF in `sources/` that isn't a deck yet, with a default tag
   (the file name), its role and week.
2. Ask the student for a tag for each new deck — short and citable, e.g. `S&D-5`, `Ch3`, `U3-2`, `HW2` —
   offering the default. One line per deck: `sources/Week5/SupplyDemand5.pdf → S&D-5?`
3. Per PDF: `python S/scripts/add.py C <pdf> --tag <tag>` (optional `--title`, `--week N`, `--order N`).
   `python S/scripts/add.py C` with no PDF adds every new PDF with its default tag.
   - Week: `N` of `sources/WeekN/`. A practice deck's week is the latest lecture week in the course; give
     `--week` when it exercises an earlier week's material (the hub uses the week for order and test scope).
   - Order: next in that week. Title: from the file name until Prepare takes the first slide's title.
   - Re-running is safe: an unchanged deck is left alone; a prepared deck is never touched unless its PDF
     changed (then it goes back to `prepared: false`, the old transcript kept in `.work/<folder>/`).
4. `python S/scripts/check.py C all deck` → OK. Tell the student the decks are in the hub now (no restart
   needed) and that Prepare makes their text faithful.

### Prepare

1. **Work files.** `python S/scripts/extract.py prepare C <scope>` — scope: a tag, a week (`4`), `practice`
   or `all`. For each deck not yet prepared it writes `.work/<folder>/transcript.md` (text-rich pages filled
   from the text layer, every other page VISUAL-PENDING) and `.work/<folder>/png/pNNN.png` for the
   VISUAL-PENDING pages. Work in progress is kept on a re-run. The hub keeps showing the rough transcript until
   step 5.
2. **Transcribe** every VISUAL-PENDING page from its PNG (prompt 1 in `reference/agent-prompts.md`;
   ≤ 45 pages per agent, in parallel). Text layers lose superscripts, equations, diagrams and handwriting —
   never judge a page "clean enough" to skip. `python S/scripts/check.py C <scope> transcripts` → OK.
3. **Audit** (prompt 1b): fresh agents compare every page image — admin and text-layer pages included —
   with its transcript and fix omissions and misreads in place, logging each change in
   `.work/<folder>/audit-p<A>-<B>.md`. `python S/scripts/check.py C <scope> audit` → OK. The tutor is only
   as good as this step. Then collect every `Possible erratum` and check the slides' claims, formulas and code
   yourself.
4. **Choose a topic for each lecture deck.** A topic is a group of whole decks the student studies together
   (e.g. "Supply and Demand" = S&D-1…4). Join an existing topic in `course.json` when the deck continues that
   idea, otherwise start a new one named the way the syllabus would (1–4 words). Never split a deck. Show the
   student one line per deck — `S&D-5 → Supply and Demand (existing)` — and ask them to confirm or change it.
   For a new topic, find its **Read more**: the textbook sections (from the slides' own citations first; the
   textbooks' contents are in `textbooks/*.toc.md`) or, where there is one, the official documentation.
   Practice decks get no topic.
5. **Finish** each deck: `python S/scripts/extract.py finish C <tag> --topic "<topic>"` (add
   `--read-more "<sections>"` for a new topic; practice decks: no `--topic`). It refuses a deck whose
   transcript or audit check fails, then publishes the work transcript to `decks/<folder>/transcript.md`, sets
   `prepared: true`, the title (the first slide's heading, or `--title`) and the topic, and adds a new topic to
   `course.json`. To move a prepared deck to another topic later, run `finish` again with the new `--topic`.
   `python S/scripts/check.py C <scope> sorted` → OK.
6. **Dates.** If the slides announce a quiz, test, due date or scope, update the Deadlines table in
   `me/progress.md` (for tests: `Covers` = the weeks, e.g. `W4–6`, add `(assumed)` if not stated).
7. **Report** to the student: decks prepared, pages, slide errors found (one line each), the topic each
   deck went under. New decks show up in the Study Hub on the next page load; nothing needs restarting.
   `.work/` can be deleted once every deck is finished.

**Homework and practice exams** (`sources/practice/`, role `practice`) go through the same stages. Pages are
problems, not slides: transcribe them verbatim (blank answer space noted in one line), type them `exercise`,
and never add solutions.

### Textbooks

`python S/scripts/extract.py textbooks C` writes `textbooks/<book>.txt` (full text, page markers
`===== <book> PAGE n =====`) and `<book>.toc.md` for each `sources/textbooks/*.pdf`. The contents come from the
PDF's outline; without one they are scanned from chapter headings and marked APPROXIMATE — check them, and fix
the `# … — contents` title line to the book's real title and edition. Existing files are kept unless the PDF
changed (`--force` redoes them).

## Kinds of slides

Read the course's `CLAUDE.md` for what its material looks like; in general:

| Slides look like | Watch for |
|---|---|
| Lecture slides annotated by hand over equations | Handwritten derivations and corrections carry the real content — transcribe every stroke |
| Chapter decks with diagrams, tables and charts | Tables and charts: every cell, axis, label and legend |
| Web pages or documents saved as PDF (portrait, a "slide" is a page) | Code and lists verbatim; an index or navigation page is admin |
| Scanned pages, homework, practice exams | Questions verbatim, answer space noted, never a solution |

## Common mistakes

| Mistake | Effect | Instead |
|---|---|---|
| Preparing before adding | The deck isn't in the hub, `prepare` finds nothing | `add.py` first, always |
| Judging a page "clean text" by eye | $x^n-1$ read as "xn - 1"; diagram slides vanish | Transcribe every VISUAL-PENDING page |
| Explaining or correcting in the transcript | The tutor can't tell what the slide actually said | Verbatim only; slide errors stay, marked `Possible erratum:` |
| Several agents editing one transcript with whole-file writes | Lost pages | Edit tool, own pages only (prompt 1) |
| Trusting a transcript because every page has a section | A skipped bullet or misread exponent passes every check | Step 3: an independent page-by-page audit against the images |
| Editing `decks/<folder>/transcript.md` or `deck.json` by hand during Prepare | The hub shows half-done pages; fields drift | Agents edit the work transcript; `finish` publishes it |
| Filing a deck without asking | Topics drift from how the student thinks of the course | One line per deck, student confirms (step 4) |
| Splitting a deck across topics | Citations and progress break | Whole decks only |
| `add.py --force` or a new `--tag` on a prepared deck | Its finished transcript is replaced by a rough one | Only when the student wants it redone |
