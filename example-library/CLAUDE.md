# Study library

Your courses live here, one folder each. Run Claude Code in this folder for the work the hub doesn't do:
preparing new slides, writing and marking mock exams, and building cheat sheets. Each course folder has its own
`CLAUDE.md` with its grading, exam format, dates and AI-use policy. Read it before doing course work.

## Layout (every course)

```
<Course>/
  CLAUDE.md          course facts + AI-use policy, as prose for Claude
  course.json        fixed facts for the hub: code, title, assessment_style, topics (+ read_more)
  sources/           your downloaded PDFs: WeekN/ (lectures), practice/ (homework, practice exams), textbooks/
  decks/<tag>/       one folder per deck: deck.json, transcript.md, sNNN.jpg (written by the preparing-slides skill)
  textbooks/         book text for search: <book>.txt (page markers) and <book>.toc.md
  me/                everything that is yours
    progress.md      deadlines, weak topics, error log
    notes/           your own writing, shown in the hub: WeekN/ class notes, exams/, labs/, assignments/
    private/         never shown or served (answer keys, anything you want kept out)
    hub-state.json, chats/, practice/, drafts.json, uploads/, tutor-memory.md   (written by the hub)
  .work/             disposable working files
```

The full format is in the Tutr repo: `docs/library-format.md`.

## Source of truth for slide content

`decks/<tag>/transcript.md` (slides read visually, one `## [<tag> sN] <title>` section per slide). Slide text layers in
PDFs are often near-empty because equations, diagrams and handwriting are images; never trust extraction alone.
A deck with `prepared: false` has only a rough transcript from the PDF's text layer.

## Conventions for every study file

- Markdown only. Math in KaTeX: `$...$` inline, `$$...$$` display.
- Hidden answers: `<details><summary>Answer</summary>` + blank line + content + blank line + `</details>`.
- Slide citations: `[<deck tag> s<slide>]`, e.g. `[S&D-1 s2]`. Tags are in each `deck.json`.
- Material not from the course slides is marked **Beyond slides**.
- Write files with the Write/Edit tools, not shell heredocs (they mangle backslashes in KaTeX).

## New slides

Use the `preparing-slides` skill (`.claude/skills/preparing-slides/`): drop PDFs in `sources/WeekN/` or
`sources/practice/`, ask Claude to prepare them. The hub shows a new deck immediately; Prepare makes its text
faithful and files it under a topic. When the course's assessments change, keep `course.json` and `me/progress.md` current.

## progress.md protocol

Read `<Course>/me/progress.md` first and update it before finishing:
- **Deadlines**: date, item, weight, status, and for quizzes and tests `Covers` (weeks, e.g. `W1-5`; `(assumed)`
  when not stated). The hub uses it for "next test" and the topics in scope.
- **Weak topics**: add when a mistake repeats or a concept is shaky; mark resolved after 2 clean recalls.
- **Error log**: one row per distinct mistake from Claude Code sessions (mock marking): what was wrong, the
  correct idea, the rule, a count.
- **Mistakes saved in the hub**: between `<!-- study-hub:start/end -->`; written by the hub from
  `me/hub-state.json`, never edited by hand. The review schedule (1, 3, 7, 14, 30 days; a miss or a hint resets
  to 1) lives in `hub-state.json` under `reviews`. To add a mistake from a marked mock so it comes back in the
  hub, append an item there: `{"id", "deck", "slides", "concept", "problem_md", "mistake", "note": "", "step": 0,
  "due": "<tomorrow>", "created": "<today>", "last": null}`.

## Mocks, review and marking

- A mock follows the real assessment's format, time limit and allowed aids (course `CLAUDE.md`), and covers only
  material taught by then. Say what is unconfirmed about scope.
- Questions go in `me/notes/exams/<assessment>/mock-N.md` (the hub lists them). The answer key and mark scheme go in
  `me/private/exams/<assessment>/mock-N-key.md`, which the hub never shows.
- Full mocks are marked in a Claude Code session from photos you send (single practice problems are marked in the
  hub). Marks, comments and model solutions go in `mock-N-marked.md` beside the mock; every mistake updates
  `progress.md` (and `hub-state.json`, above).
- Cheat sheets: a prioritised list of what belongs on the sheet (`me/notes/exams/<assessment>/cheatsheet.md`), driven
  by the error log, the hub's saved mistakes and weak topics. You write the sheet by hand.

## Course AI rules: warn, don't refuse

Each course `CLAUDE.md` summarises that course's AI-use policy. You decide how to use AI; the policies are yours to
weigh. So:

- When a request conflicts with a course rule (answering a live graded quiz or test, writing assignment or project
  work), give **one short warning**: which rule, and the risk (e.g. a mark of
  0, a misconduct record). Then do what was asked, fully.
- Warn once per task, not on every message. Don't lecture, don't water the help down, don't ask for justification.
- Where the course requires disclosure or citation of AI help, keep the help log the course `CLAUDE.md` names
  (e.g. `AI-HELP.md`) so you can disclose it.
- Git: commit only when asked, under your configured identity, with no AI attribution.
