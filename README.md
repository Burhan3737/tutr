# Tutr

A local study app. Open your lecture slides in the browser and study them with a tutor (Claude) that explains,
gives worked examples, grills you, marks your practice answers and brings back the mistakes you saved. It
runs on your computer; nothing is uploaded except what the tutor sends to Claude.

Course, then topic, then deck, then slide. Alongside the slides: your own notes, textbooks the tutor can search,
a spoken Talk tab (speech to text and the tutor's voice both run locally), and a deadlines view that shows what the
next test covers.

## Requirements

- Windows 11 (the launcher is a `.bat`; the Python code is not Windows-specific)
- Python 3.12
- [Claude Code](https://claude.com/claude-code), signed in. The tutor uses that login through the Claude Agent SDK;
  there is no API key to set up.
- Node.js, only to run one of the test scripts
- Optional: the `opencode` CLI on `PATH` to use OpenCode models; `cloudflared` for the "anywhere" link

`start.bat` installs the Python packages in `requirements.txt` the first time.

## Setup

1. Get the repo and open a terminal in its folder.
2. Run `start.bat`. On the first run it copies `example-library\` to `library\` (your study library) and puts the
   `preparing-slides` skill in `library\.claude\skills\`, installs the packages, then asks how to open the app:
   this computer only, your phone on the same Wi-Fi, or anywhere through a Cloudflare link.
3. The browser opens on the example course (`Demo-Course`). Try it, then delete it or replace it with your own.

To keep your library somewhere else, skip the copy by pointing at it first: put `{"library": "D:/study"}` in
`config.json` at the repo root (a relative path is relative to the repo), or set the `STUDY_HUB_ROOT` environment
variable (it wins over `config.json`). Then copy `example-library\CLAUDE.md` into it, and the skill folder
`.claude\skills\preparing-slides\` into its `.claude\skills\`, if you want to work with Claude Code there.

## Adding a course

Make `library\<Course>\` with a `course.json` (copy `example-library\Demo-Course\course.json` and edit it) and a
`CLAUDE.md` for the course facts. Drop its PDFs in `sources\Week1\`, `sources\practice\` (homework, practice exams)
and `sources\textbooks\`.

## Adding slides

Run Claude Code in `library\` and ask it to prepare the new slides ("prepare week 3"). That runs the
`preparing-slides` skill:

1. **Add**: every PDF becomes a deck in seconds (slide images, a rough transcript from the PDF's text, `deck.json`).
   It shows in the hub at once; no restart.
2. **Prepare**: Claude reads each slide visually, writes a faithful transcript (equations, diagrams, handwriting),
   audits it, and files the deck under a topic.

Textbook PDFs are turned into searchable text the same way. The skill is described in
`.claude/skills/preparing-slides/SKILL.md`.

## Your files

Everything in `library\<Course>\me\` is yours: `progress.md` (deadlines and the exam scope each test covers),
`notes\` (your own writing, shown in the hub), `private\` (never shown), and the hub's own data (saved mistakes,
chats, practice records, the tutor's memory of you). The complete format is in
[docs/library-format.md](docs/library-format.md).

## What is not in git

`.gitignore` leaves out everything that belongs to one user or one machine:

- `library/`: your courses, slides, notes and progress
- `config.json`: where your library is
- `.cache/`: speech models, logs, prompts
- `agentTempWork/` and `__pycache__/`

The repo itself holds the code, the skill, the docs and `example-library/`.

## Tests

From the repo root:

```
python tests/test_drafts.py
python tests/test_voice.py              # loads the speech models; add --no-models to skip them
python .claude/skills/preparing-slides/tests/test_scripts.py
```

The first two build a demo library in a temporary folder and never touch your courses. The skill's own test lives
beside the skill because the skill is copied into each library.
