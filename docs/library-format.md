# Library format

The **library** is the folder the hub reads: one sub-folder per course. By default it is `library/` next to
`server.py`. Point somewhere else with `config.json` (`{"library": "D:/study"}`; a relative path is relative to the
repo) or the `STUDY_HUB_ROOT` environment variable (which wins). `example-library/` has the same shape and is the
template a new user copies.

The hub never opens a PDF. The `preparing-slides` skill reads PDFs and writes everything below under `decks/`.

## Layout of a course

A folder is a course when it contains `course.json`; the folder name is the course id.

```
library/
  CLAUDE.md                     how you study with Claude Code (not read by the hub)
  .claude/skills/preparing-slides/   the skill, copied here by start.bat
  Demo-Course/
    CLAUDE.md                   course knowledge as prose
    course.json                 fixed facts for the hub
    sources/                    your downloaded PDFs (never read by the hub)
      Week1/*.pdf                 lectures, WeekN
      practice/*.pdf              homework and practice exams
      textbooks/*.pdf             textbooks
    decks/<folder>/             one folder per deck, written by the skill
      deck.json
      transcript.md
      s001.jpg, s002.jpg, ...
    textbooks/<book>.txt        full text with page markers
    textbooks/<book>.toc.md     contents, for finding chapters
    me/                         everything that is yours
      progress.md
      notes/
      private/
      tutor-memory.md           written by the hub
      hub-state.json, chats/, practice/, drafts.json, uploads/    written by the hub
    .work/                      disposable working files of the skill
```

## course.json

```json
{
  "code": "Demo-Course",
  "title": "Introductory Economics (demo)",
  "assessment_style": "a short closed-book quiz question: ...",
  "topics": [
    { "name": "Supply and Demand", "read_more": "Any introductory economics textbook, chapter on markets" }
  ]
}
```

| Field | Meaning |
|---|---|
| `code` | Short label shown in the hub and the tutor's prompts. Missing: the folder name. |
| `title` | Course title. Missing: the folder name. |
| `assessment_style` | What a typical assessment question looks like; the tutor words its practice and drill questions to match. Missing: "exam-style question". |
| `topics` | Topic list: `name` must match the `topic` of decks; `read_more` is the pointer shown under "Read more". The order of topics in the hub follows the first deck in each topic, not this list. |

The skill appends a topic here when it files a deck under a new one. Unknown keys are kept.

## deck.json

| Field | Type | Meaning |
|---|---|---|
| `tag` | string | The citation tag, e.g. `S&D-1`; slides are cited `[S&D-1 s2]`. Unique in the course; if two decks claim a tag, the first folder keeps it. Missing: the folder name. |
| `title` | string | Shown in the hub. Missing: the tag. |
| `role` | `lecture` or `practice` | See below. |
| `week` | number | Lecture week; orders decks and sets test scope. |
| `topic` | string | A lecture deck's topic. Empty or `Unsorted`: shown under "Not sorted yet". Ignored for practice decks. |
| `order` | number | Position inside the week. |
| `pages` | number | Slide count; must match the `sNNN.jpg` files. |
| `prepared` | true/false | `false` means the transcript is only a rough copy of the PDF's text layer (slides show as "raw"). |
| `source` | string | The PDF this came from, relative to the course (information only). |
| `sha1` | string | Hash of the PDF, used by the skill only, to skip unchanged files. |

The folder is the tag with everything except letters, digits and `-` removed (`S&D-1` is `SD-1`).

**Roles**

| Role | Shown in the hub | The tutor treats it as | Exam drill |
|---|---|---|---|
| `lecture` | under its topic | primary source; sets notation and scope | questions are drawn from these |
| `practice` | the **Practice** list, never a topic | questions only, no solutions | format model |

## transcript.md

One section per slide, in order, each starting with a heading of exactly this form:

```
## [S&D-1 s2] Demand and supply curves

Text of the slide, with equations as KaTeX ($...$ / $$...$$) and diagrams described in words.

Type: content
```

`Type:` is `content`, `exercise` or `admin` (title and logistics slides). The slide number must match
`sNNN.jpg` (`s002.jpg`).

## Textbooks

`textbooks/<book>.txt` is the book's full text with `===== <book> PAGE n =====` markers; `<book>.toc.md` lists
chapters with their PDF pages. The tutor searches and cites them. They are not shown as slides.

## me/: your own data

- `me/progress.md`: the Deadlines table (`| Date | Item | Weight | Status | Covers |`; `Covers` is the weeks a
  test covers, e.g. `W1-5`, or `(assumed)`), plus weak topics, the error log and the hub's saved mistakes between
  `<!-- study-hub:start -->` and `<!-- study-hub:end -->` (written by the hub; don't edit). This is the one place
  the hub reads a Markdown table.
- `me/notes/`: shown, grouped by top-level folder. A `WeekN` folder lists its `.md` and `.txt` files as that
  week's class notes; any other folder lists the `.md` files directly inside it and inside each of its subfolders
  (one level down). Files loose in `me/notes/` itself are not listed.
  - `WeekN/*.md`: class notes for week N, shown with that week.
  - `exams/<assessment>/`: mocks, marked mocks, cheat sheets. `labs/<lab>/`, `assignments/<a>/`: kept whole.
    Any other folder name is also a group of documents (`exams`, `labs`, `assignments` are listed first).
  - Other file types (PDFs, images, zips) can sit alongside and are not listed.
- `me/private/`: never listed or served. Put answer keys and mark schemes here.
- `me/tutor-memory.md`: the voice tutor's notes about you, shown as "What your tutor remembers"; edit freely.
- `me/hub-state.json`, `me/chats/`, `me/practice/`, `me/drafts.json`, `me/uploads/`: the hub's own data.

## Who reads what

| File | What it holds | Read by |
|---|---|---|
| `course.json` | The course's fixed facts | The hub's code |
| `decks/<folder>/deck.json` | Each deck's fixed facts | The hub's code |
| `decks/<folder>/transcript.md`, `sNNN.jpg` | Slide text and images | The hub and the tutor |
| `<course>/CLAUDE.md` | Course knowledge as prose: instructor, assessments and weights, exam format and allowed aids, dates, question types, weak points, AI-use policy | The tutor (its prompts point to it for format, aids and AI rules) and your Claude Code sessions. Never parsed by code |
| `library/CLAUDE.md` | How you study with Claude Code: layout, file conventions, the `progress.md` protocol, mocks and marking, cheat sheets, AI-rule warnings | Claude Code, when run in `library/`. Not the hub or the tutor |
| `me/progress.md` | Deadlines, weak topics, error log | The hub (Deadlines table) and Claude Code |
| `me/notes/**` | Your writing | The hub (shown to you); you |
| `me/private/**` | Answer keys and anything to keep out | Claude Code only |
| `sources/**`, `.work/**` | PDFs and scratch | The `preparing-slides` skill only |
