# 01 · Navigation, library browsing and app chrome

Functional requirements for how Tutr finds and shows course material, how the user moves around it, and the
app-wide chrome (header, sidebar, search, the ⋯ menu, layouts, error states). These describe what a user sees and
what ends up on disk. They do not describe how the current code does it.

**Out of scope, documented elsewhere** (this file only marks where they start):
- the tutor panel, chats, side questions, the shared Ask-box draft and live sync between devices → *tutor & live*
- practice problems, reviews, exam drill, practice by topic, the "Try one" deck problem → *practice*
- reading aloud, Talk/voice mode, dictation → *voice*

**Terms.** *Library*: the folder holding the courses. *Course*: a library folder with a `course.json`. *Deck*: a
folder `decks/<folder>/` with a `deck.json`, its slide images `sNNN.jpg` and `transcript.md`. *Lecture deck* /
*practice deck*: `deck.json` `role`. *User data*: everything under `<course>/me/`. *Hub state*: `me/hub-state.json`.
*Run*: one start-to-stop of the hub.

Requirements whose visible result depends on what the AI model returns are tagged **[model-dependent]**. Requirements
that describe behaviour that is currently broken are tagged **[currently broken]**; the requirement states the
intended behaviour.

---

## A. Library discovery and data contract

**NAV-001 — The library location is configurable.**
- The library is, in order of precedence: the folder named by the `STUDY_HUB_ROOT` environment variable; else the
  `library` value in `config.json` at the app's root (a relative path is relative to the app's root; a non-string
  value is ignored); else `library/` next to the app.
- If that folder does not exist, the hub starts and shows no courses (see NAV-090).

**NAV-002 — A course is any library sub-folder that contains `course.json`.**
- Given a library folder with sub-folders A (has `course.json`) and B (none), only A is a course.
- Only direct sub-folders of the library are considered. The course id is the folder name.
- Courses are listed in order of folder name.

**NAV-003 — Course code and title fall back to the folder name.**
- `course.json` `code` and `title` are shown; when either is missing or blank, the folder name is shown instead.
- An unreadable or invalid `course.json` still makes the folder a course (both values fall back to the folder name).

**NAV-004 — A deck is any `decks/<folder>/deck.json` in a course.**
- An unreadable, invalid or empty `deck.json` means that folder is not a deck (skipped silently).
- `tag` defaults to the folder name; `title` defaults to the tag.
- `week`, `order` and `pages` accept a number or a string starting with digits (`"3 pages"` → 3); anything else is 0.
- `prepared` counts only when it is exactly `true`.

**NAV-005 — Deck roles.**
- `role: "practice"` (any letter case) makes the deck a *practice deck*: it is listed under **Practice**, never under
  a topic, whatever its `topic` says.
- Any other deck is a *lecture deck* filed under its `topic`. A missing/blank topic, or `Unsorted` (any case), files
  it under the topic **Not sorted yet**.

**NAV-006 — Topic and deck ordering.**
- Lecture decks are in *lecture order*: by `week`, then `order`, then folder name.
- Topics are listed in the order of their earliest deck (week, then order), with **Not sorted yet** always last.
- The order of topics in `course.json` is not used for ordering; a topic listed in `course.json` with no decks is
  not shown.
- Practice decks are listed in lecture order.

**NAV-007 — Duplicate tags.** When two decks claim the same tag, the one first in lecture order (week, order,
folder name) keeps it; the other is not shown.

**NAV-008 — Read more pointer.** A topic's `read_more` text from `course.json` (matched by topic name) is shown with
that topic. Topics without one show nothing extra.

**NAV-009 — Slide text comes from `transcript.md`.**
- Each slide's section starts with `## [<tag> s<N>] <title>`. The section's body (minus a `Type: …` line) is the
  slide's text; `<title>` is the slide title.
- A deck has exactly `pages` slides. Slides with no section have an empty title and text. Sections numbered beyond
  `pages` are ignored. A missing transcript means every slide has empty text.
- If the deck is not prepared (`prepared` not `true`), every slide's text is marked *raw* (see NAV-046).

**NAV-010 — Slide images.** Slide N is shown from `sNNN.jpg` (three-digit, zero-padded) in the deck folder. A slide
number outside 1…`pages`, or a missing image file, gives no image (see NAV-093).

**NAV-011 — The hub never reads PDFs or `sources/`, `.work/`, `CLAUDE.md`** for display. Nothing from those appears
in the UI.

**NAV-012 — Library changes on disk show without a restart.**
- Given the hub is running, when a new deck folder (with `deck.json`, images, transcript) is added to a course, then
  the next load of the home page or course page shows it. No restart is needed.
- The same holds for edits to `course.json`, `deck.json`, `transcript.md`, `me/progress.md`, a new course folder,
  and adding/removing notes files.
- Known limits a rewrite may improve on (not required): within one browser session, a deck already opened in the
  current course is reused, so a transcript edited after it was first opened shows only after a page reload or after
  visiting another course; slide images may be cached by the browser for up to an hour (see NAV-095).

---

## B. User data (`me/`) — what is read, what is written, what is never shown

**NAV-020 — Class notes.** Files `me/notes/WeekN/*.md` and `me/notes/WeekN/*.txt` (folder name `Week` + number, any
case) are the class notes for week N.
- Empty (0-byte) files are not listed. Listed by week number, then `.md` files by name, then `.txt` files by name.

**NAV-021 — Other documents.** Every other folder directly under `me/notes/` (not starting with `.`) is a *document
kind* named after the folder.
- `.md` files directly inside it form an unnamed group; each sub-folder (one level down) with `.md` files forms a
  group named after the sub-folder. Deeper levels and non-`.md` files are not listed.
- Kinds are ordered `exams`, `labs`, `assignments`, then any others by name.
- Files loose in `me/notes/` itself are not listed.

**NAV-022 — Tutor memory.** If `me/tutor-memory.md` exists it is listed as a document named **What your tutor
remembers** (kind "Voice tutor").

**NAV-023 — `me/private/` is never shown or served.** No file under `me/private/` appears in any list, and asking the
hub for it by path returns "not found". The same applies to any path that is not one of the listed notes/documents
(e.g. `course.json`, `me/hub-state.json`, `../…`).

**NAV-024 — Deadlines are read from `me/progress.md`.**
- The hub reads the Markdown table(s) under the `## Deadlines` heading that have a `Covers` column (header match is
  case-insensitive). Columns used: `Date`, `Item`, `Status`, `Covers`.
- A row counts as a *graded test* only if `Covers` is non-empty and `Status` does not start with `done`,
  `submitted` or `complete` (any case).
- Item: `**` markers are removed; the test's *name* is the text before an em dash `—` (the full text is its detail).
- Date: the first `<Month> <day>` found (month name or 3-letter abbreviation, any case, optional `.`), in the current
  year. A date starting with `~` is *approximate*. No recognisable date → undated.
- Covers: the numbers before any `(` give the week range (first to last number; `W1-5` → weeks 1–5, `W3` → week 3).
  No numbers → all weeks. The word `assumed` anywhere marks the scope as assumed.

**NAV-025 — The next assessment.** For each course, the *next assessment* is the earliest dated graded test dated
today or later; if none is dated, the first undated one; otherwise none.
- Its *days away* is the whole-day difference from today (undated: none).
- Its *topics covered* are the course's topics (excluding **Not sorted yet**) with at least one lecture deck whose
  week is within the test's week range.
- Tests dated in the past are ignored. (Dates are given without a year, so a date earlier in the calendar year than
  today is treated as past.)

**NAV-026 — Viewing slides records progress in the hub state.**
- When a slide stays on screen for about half a second, it is recorded as *seen* for that deck in
  `me/hub-state.json`: the slide number is added to the deck's seen list, the deck's *last slide* becomes that number,
  and the course's *resume point* becomes that deck and slide.
- The deck becomes *read* when its last slide has been recorded, or when every slide has been seen.
- Slides passed through quickly (shown for less than ~0.5 s) are not recorded. The end card (NAV-049) is not a slide
  and records nothing.
- `me/` and `hub-state.json` are created if missing.

**NAV-027 — Deck states.** Each deck has one state, shown everywhere a deck is listed:
- *Not started* (`new`): nothing seen. *Started*: something seen, not read. *Read · solve one to finish* (`read`).
  *Solved*: a problem from the deck was answered correctly without a hint (set by *practice*).

**NAV-028 — The hub mirrors its saved mistakes into `progress.md`.** Whenever the hub state is saved (including the
first time a slide is recorded as seen) and `me/progress.md` exists, the hub writes a block between
`<!-- study-hub:start -->` and `<!-- study-hub:end -->` headed `## Mistakes saved in the Study Hub` (or replaces the
existing block). With no saved mistakes the block says `None yet.` Text outside the block is left unchanged. If
`progress.md` does not exist it is not created. (Contents of the table: see *practice*.)

**NAV-029 — The resume point.** The course's resume point is:
- the last slide viewed in the course, unless that deck is now read; then
- the first deck in lecture order (lecture *and* practice decks) that is not read, at its last slide (1 if never
  opened); else
- the last slide viewed; else the first deck's slide 1; else none (course with no decks).

**NAV-030 — Due-review count.** The home and course pages show how many saved mistakes are due today (the daily limit
is 5 per course, counting ones already answered today) and an estimate of ~1.5 minutes each, rounded, at least 1.
(What a review is: see *practice*.)

---

## C. Routes (deep links)

The app is one page; where the user is lives in the URL fragment (`#…`, form-encoded: `&` in a tag is `%26`, a space
is `+`). Every route below can be bookmarked, reloaded or opened directly and shows the same page.

| Route | Page |
|---|---|
| `#` (empty) | Home (NAV-040) |
| `#c=<course>` | Course page (NAV-060) |
| `#c=<course>&t=<topic>` | Course page with that topic (or `Practice`) expanded and scrolled into view |
| `#c=<course>&d=<tag>&s=<n>` | Deck viewer on slide n (NAV-045) |
| `#c=<course>&d=<tag>` | Deck viewer on the deck's last viewed slide (1 if never opened) |
| `#c=<course>&notes=<path>` | A notes page (NAV-070) |
| `#review=<course>` | Reviews (→ *practice*) |
| `#chat=<id>` | An earlier chat, read-only (→ *tutor*) |
| `#upload=<id>` / `#upload=ask-<course>` | Phone photo page (→ *practice* / *live*) |
| `#step=note` | Study session's last step (NAV-085) |

**NAV-031 — Route precedence.** When a fragment has several keys: `upload` wins, then `chat`, then `review`, then
`c`+`d` (viewer), then `c`+`notes`, then `c` alone, then `step=note`, else home.

**NAV-032 — Slide number normalisation.** In the viewer route, `s` is clamped to 1…pages+1 (pages+1 is the deck's end
card). A missing, zero or non-numeric `s` opens the deck's last viewed slide. After normalisation the address bar
shows the actual slide (`s=<n>`).

**NAV-033 — Back/forward history.**
- Moving between pages (home, course, a deck, notes, a search result, a citation, the previous/next *deck*) adds a
  browser history entry.
- Moving between slides *within* a deck (arrows, keys, swipe, the sidebar's slide list) does **not** add entries; it
  updates the current entry's address in place.
- Given home → course → deck slide 1 → next → next (slide 3), when the user presses Back, then the course page shows;
  when they press Forward, the deck shows at slide 3.

---

## D. Home page

**NAV-040 — Home shows the suggested course's next test.**
- The *suggested course* is the course whose next assessment is soonest (dated ones only); if none is dated, the
  first course.
- A line shows `<code> <test name>` · *when* · the topics it covers (comma-separated, omitted if none). With no
  upcoming test: **No upcoming tests found in your deadlines.**
- *When*: `today`, `tomorrow`, `in N days`; prefixed by `~` when the date is approximate (e.g. `~in 3 days`); for an
  undated test, the Date cell as written.

**NAV-041 — Home's main action.** A button **Start session · <code>** for the suggested course starts a study session
(NAV-080).

**NAV-042 — Home's review/resume line.** Under the button:
- with reviews due: `N quick review(s) · ~M min first · ` + link **Just the reviews** (→ `#review=<course>`);
- otherwise **Nothing due.** + link **Pick up at <tag> →** to the course's resume point (or just *Nothing due.* when
  there is none).

**NAV-043 — Course list.** Every course is listed (in NAV-002 order) as a link to its course page, showing
`<code> <title>`, a sub-line with the next test (`<name> <when>`) or, if none, `<N> topics`, and one state dot per
lecture deck that has more than one slide (dot style per NAV-027; tooltip `<tag>: <state>`; the group is labelled
`<solved> of <total> decks solved`).

**NAV-044 — Home is always fresh.** Every visit to home re-reads the library (NAV-012).

---

## E. Deck viewer

**NAV-045 — Opening a deck shows one slide large.** The viewer shows the slide image fitted to the available space
(never enlarged beyond 1.5× its natural size on desktop; tall portrait pages fill a readable column and scroll),
a counter `n / N`, previous/next arrows and a **Text** toggle. The image's accessible name is `Slide n: <slide title>`
(or `Slide n` when untitled).

**NAV-046 — Text panel.** **Text** (or key `T`) toggles a panel with the current slide's text:
- a heading `Slide n · <title>` (just `Slide n` when untitled), then the slide text rendered as Markdown with maths
  (NAV-075);
- for a raw (unprepared) deck, the note **Text layer only; equations and diagrams may be missing.** and the text shown
  as plain pre-formatted text, not rendered;
- the panel follows the slide as the user steps; it stays open across slides of the same deck and closes when another
  deck is opened. `Escape` closes it. The toggle reports pressed/not pressed.
- On phones the panel is a bottom sheet over ~70% of the screen.

**NAV-047 — Stepping through slides.**
- Next: the **›** arrow, `→` or `PageDown`, a left swipe (phone), or a tap on the right half of the slide (phone).
- Previous: **‹**, `←` or `PageUp`, a right swipe, or a tap on the left half (phone).
- Keys are ignored while typing in a text field and while the tutor's reading view or practice focus is open
  (→ *tutor*/*practice*). Swipes are ignored while zoomed; taps are ignored while the page is pinch-zoomed.

**NAV-048 — Arrows continue across decks.** Decks are chained in the course's lecture order of **lecture decks only**:
- On slide 1, Previous goes to the previous lecture deck's **last** slide (tooltip `Previous deck: <tag> (←)`);
  with no previous deck it is disabled.
- On the end card, Next goes to the next lecture deck's slide 1 (tooltip `Next deck: <tag> (→)`); with no next deck
  it is disabled.
- Practice decks are not in the chain: in a practice deck, Previous is disabled on slide 1 and Next on its end card.

**NAV-049 — End card.** Stepping past the last slide shows an end card instead of an image: **End of <tag>**, then
*Solve one problem from it to finish the deck.* (or *You've solved a problem from this deck.* when solved), a
**Try one** button (→ *practice*), and links **‹ Previous deck: <tag>** (to its last slide) and **Next deck: <tag> ›**
(to its slide 1) when those decks exist. The counter shows `N / N`; the Text toggle is hidden.

**NAV-050 — Zoom.** On desktop, double-clicking the slide or pressing `Z` toggles a 2× view of the image; `Escape`
or changing slide un-zooms. On phones the browser's own pinch-zoom is used.

**NAV-051 — Deck breadcrumbs.** The header shows `Home › <course code> › <topic> › <tag> (W<week>)`; Home, the course
and the topic are links (the topic link opens the course page with that topic expanded; for a practice deck the topic
is `Practice`).

**NAV-052 — Neighbouring decks load ahead.** After a deck opens, the next and previous decks' data and opening slides
are fetched in the background so moving to them is immediate. The next slide's image is also preloaded. (Not
observable except as speed; not required to be tested.)

**NAV-053 — Changing deck within a course keeps the tutor panel.** Moving to another deck of the same course changes
only the slide area; the tutor panel/ask bar stays as it is (→ *tutor*). Moving to another course rebuilds the viewer.

**NAV-054 — The tutor area in the viewer.** The viewer always shows the tutor's ask bar under the slide (closed
state) or the tutor panel beside it (→ *tutor*). Opening a deck from the course page's **Exam drill ›** link opens
the panel with the drill setup (→ *practice*).

**NAV-055 — Seen tracking from the viewer.** Each slide shown (not the end card) for ~0.5 s is recorded per NAV-026,
so the deck's state, the course page, the sidebar and home reflect it on their next display.

---

## F. Course page

**NAV-060 — Course page header.** Breadcrumbs `Home › <code>`. A title `<code>` and subtitle `<title>`. If the course
has a next assessment: `<test name> · <when> · covers <topics>` plus ` (scope assumed)` when assumed. (This line is
the only deadlines view; there is no separate deadlines page.)

**NAV-061 — Course actions.**
- **Start session** (NAV-080).
- The review/resume line as on home (NAV-042).
- If the course has a resume point: link **Continue reading: <tag> · slide <n> ›** to it, and **Exam drill ›**
  (opens the resume deck with the drill setup, → *practice*).

**NAV-062 — Topics.** Each topic is a collapsible section with its name and `<solved>/<total>` (decks solved). It
lists its decks (NAV-064) and, if it has a read-more pointer, a line **Textbook: <read_more>**.
- Expanded initially: the topic named in the route (`t=`), else the topic of the resume deck. Others are collapsed.
- Clicking a topic header toggles it; the header reports expanded/collapsed.

**NAV-063 — Practice list.** If the course has practice decks, a **Practice** section with the subtitle
*Homework and practice exams* lists them (NAV-064, counting `pages` instead of `slides`).

**NAV-064 — Deck rows.** Each deck row links to the deck at its last viewed slide and shows a state dot (tooltip =
state label), `<tag> · <title>`, a week chip `W<week>`, and either `<N> slides` / `<N> pages` or, when the deck is
read, **Solve one to finish**.

**NAV-065 — Notes and documents on the course page.**
- If the course has class notes: **Your class notes:** followed by one link per file labelled `W<week>`, with
  `(2)`, `(3)`… for further files of the same week.
- Then one line per document kind present, in order *exams*, *labs*, *assignments*, other kinds by folder name, then
  the tutor memory, labelled **Mock tests & cheat sheets**, **Labs**, **Assignments**, the folder name, **Voice
  tutor**. Each group shows its sub-folder name (if any) then a link per file named by the file name without `.md`.
- Each link opens the notes page (NAV-070).

**NAV-066 — The course page is always fresh.** Every visit re-reads the course (NAV-012).

---

## G. Notes pages

**NAV-070 — A notes page shows one listed file.** `#c=<course>&notes=<path>` shows the file full-width:
- `.md` files rendered as Markdown with maths (NAV-075); `.txt` files as pre-formatted text, line breaks kept.
- Breadcrumbs `Home › <code> › <label>`; label is `Class notes W<week>` for class notes, `What your tutor remembers`
  for the tutor memory, otherwise the last two path parts joined with ` · ` without `.md` (e.g. `midterm · cheat`).

**NAV-071 — Unlisted paths show "Not found."** Any path that is not a listed note/document (including anything in
`me/private/`) shows the page body **Not found.**

**NAV-072 — Notes are re-read on each visit.** Editing a notes file and reopening the page shows the new content.

**NAV-075 — Rendering rules for Markdown everywhere in this area (slide text, notes).**
- GitHub-flavoured Markdown (tables, lists, code blocks).
- `$…$` inline maths and `$$…$$` display maths are typeset; a malformed formula shows its source rather than failing.
- A citation `[<tag> s<N>]` (or a range like `[<tag> s2–s4]`) naming a deck of the same course becomes a button
  that opens that deck at slide N (tooltip `Open <tag> slide <N>`); not inside code or maths.
- `||text||` becomes hidden text revealed by click, Enter or Space.
- External `http(s)` links open in a new tab; a link whose text is its own URL is shown as the host name.
- ` ```mermaid `, ` ```svg `, ` ```plot ` blocks are drawn as diagrams (→ *tutor* for drawing rules).

---

## H. Header, sidebar and search

**NAV-076 — Header.** Always present: a sidebar toggle (☰), the **Tutr** brand linking home (hidden on phones), the
breadcrumbs, a search button and the ⋯ menu button. On home the breadcrumbs are empty.

**NAV-077 — Topics sidebar.**
- Toggled by ☰ or the `[` key (not while typing). On desktop its open/closed state is remembered across reloads
  (browser storage); on phones it always starts closed, opens over the page with a dimmed backdrop, and closes on a
  backdrop tap, a link tap or `Escape`.
- Inside a course (course, deck, notes, reviews, or during a session): that course only, as a link `<code>` /
  `<title>`, then each topic as a collapsible group `<name>  <solved>/<total>`, each deck as a link (state dot, tag,
  title, `W<week>`) to its last viewed slide, then a **Practice** group for practice decks.
- On home: every course, the same way.
- The open deck lists its slides (`<n>  <slide title or "Slide n">`); the current slide is highlighted and kept in
  view as the user steps. Clicking a slide there changes slide in place (no new history entry, NAV-033).
- Topic groups start expanded when they contain the open deck, or when only one course is shown and no deck is open.
- When inside a course and other courses exist, a course switcher (all course codes, alphabetical, current one
  marked) is pinned at the top.
- Hidden on the phone photo page.

**NAV-078 — Search all slides.**
- Opened by the search button or `Ctrl+K` / `Cmd+K` (anywhere, even while typing). Shows an empty box with
  placeholder *Search all slides*, focused.
- After a short pause in typing, queries of 2+ characters (after trimming) search every slide's title and text in
  every course, case-insensitively, as a plain substring. Shorter queries show nothing.
- Results (at most 60) in course-folder order, then lecture order of decks (practice decks included): each shows
  `<code> · <topic> · <tag> s<N>` and a snippet around the match, with Markdown and common LaTeX stripped
  (e.g. `\frac{a}{b}` → `(a)/(b)`, `\le` → `≤`). Practice deck results show topic `Practice`.
- No hits: **Nothing matches "<query>".**
- `↓`/`↑` move a highlight; `Enter` opens the highlighted (or first) result; clicking a result opens it. Opening goes
  to the deck at that slide and closes the search. `Escape` or clicking outside the box closes it.
- Searches transcripts only (not notes, textbooks or chats).

**NAV-079 — Keyboard summary (this area).** `←`/`→`/`PageUp`/`PageDown` step slides; `T` text; `Z` zoom; `[`
sidebar; `Ctrl/Cmd+K` search; `Escape` closes, first match wins: search → ⋯ menu → (tutor selection/side question)
→ zoom → text panel → (practice focus / reading view, → *tutor*/*practice*) → phone sidebar. `/` and `R` → *tutor*.

---

## I. Study session shell

**NAV-080 — Start session.** **Start session** (home or course page) starts a five-step session for that course:
**Review**, **New slides**, **Practise**, **Mixed**, **Note**. It is remembered across reloads (browser storage).
- Step 1 goes to the reviews if any are due, otherwise straight to step 2. Step 2 opens the course's resume point.
  Steps 3–4 open practice in the tutor panel (→ *practice*). Step 5 is NAV-085.

**NAV-081 — Session bar.** While a session is on, a bar of five labelled segments is shown above the header
(done / current / to-do); clicking a segment runs that step. The breadcrumbs are replaced by `Session · <code>` and an
**End session** button, which ends the session and goes home. Hidden on the phone photo page.

**NAV-085 — Session's last step.** `#step=note` shows **One line to remember**, a subtitle (*Shown next time this comes
back.* if a mistake was made this session, else *Nothing was missed today; a line still helps.*), a text field
*The clue I missed was…* (max 300 characters), **Finish** and **Skip**. Finishing ends the session and shows
**Session done** with a **Home** link (*Your note will show up next time this comes back.* if a note was given, else
*Nice work.*). The note is saved on the session's last mistake (→ *practice*). Without a session, `#step=note`
goes home.

---

## J. The ⋯ menu

**NAV-086 — Menu behaviour.** The ⋯ button opens a menu; it closes on a second click, a click elsewhere, `Escape`, or
any navigation. Items in order: **History**, **Model** picker, **Stick to slides** (with the course code), **Show
words while dictating**, **Open on your phone** (only sometimes, NAV-089), **Usage** with this run's summary.

**NAV-087 — Model picker.** A drop-down of every model the tutor can use, grouped by provider (Claude Code first,
then other providers by their best model), each option `<label> · <score>` (an intelligence score, higher = more
capable), best first within a group.
- The default is the app's default model (currently Opus 5.5). A choice is remembered across reloads in this
  browser; a remembered model that is no longer offered falls back to the default.
- The chosen model is the one used for every subsequent tutor, practice and marking request from this browser.
- The provider list beyond Claude Code depends on what's installed and reachable (environment-dependent).

**NAV-088 — Stick to slides.** Shown only when there is a current course (from the route, the session, or on home
the suggested course), labelled with that course's code. A per-course, per-browser setting (remembered). When on,
the tutor's answers for that course must not use web search (→ *tutor*).

**NAV-089 — Open on your phone.** Shown only when the hub was started for other devices (same Wi-Fi, or a public
tunnel link) **and** the page is being viewed on the computer running the hub. It opens a dialog **Open on your
phone** with a QR code of the link and the link as text. Text: for a public `https` link, *Scan this with your
phone's camera. It works on any Wi-Fi or mobile data while this computer is on. Anyone with the link can open the hub,
so don't share it.*; otherwise *Connect your phone to the same Wi-Fi, then scan this with its camera. Keep this
computer on while you use it.* Closed with ×.

**NAV-091 — Usage panel.** **[depends on model calls]**
- The menu item shows this run's total `<tokens> · <cost>` (e.g. `1.6k · $0.01`), or nothing when no model call
  was made this run.
- **Usage** opens a dialog titled **Usage**: a total for **This run · since <YYYY-MM-DD HH:MM>** (`<tokens> tokens ·
  $<cost>`, `<N> answer(s)` · `<k> failed` · `<j> not fully known`, and the split `<a> new · <b> cache read · <c>
  cache write · <d> out`); if more than one run is on record, the same for **All runs · <N> runs**.
- Then this run's calls, newest first (up to 500): `<tokens> tokens · <cost>` (prefixed **Failed ·** for a failed
  attempt; *Tokens unknown* / *cost unknown* when not reported), a line `<time> · <kind> · <course code> · <model
  label> · <seconds> s`, the token split, and the error text for failures. With none: **No answers yet this run.**
- Then **Earlier runs**, newest first, each a collapsed row `<run start> · <tokens> tokens · $<cost>` /
  `<N> answers · <k> failed ›` that expands to that run's calls.
- Token numbers: under 1,000 as is, then `1.6k`, `2.3M`. Costs: `$0.00` format, 4 decimals under one cent.
- Usage history persists across hub restarts (kept with the app's own scratch files, not in the library). A run
  starts when the hub starts.
- If usage can't be loaded: **Couldn't load usage.**

**NAV-092 — History.** **[currently broken]** **History** should open a dialog **History · <code>** (or **History**
outside a course) listing the saved tutor chats of the current course (all courses on home), starred first, each
group newest first; each row: a star toggle, the title (click to rename), `<code> · <deck> · <N> question(s) ·
<date> · Open ›`, and **Delete** (with confirmation). Empty: *No tutor chats in <code> yet.* / *No tutor chats yet.*
Opening a chat → *tutor*. *Currently, choosing History closes the menu and nothing opens.*

**NAV-094 — Show words while dictating.** A per-browser checkbox, remembered (→ *voice*).

---

## K. Layout and theme

**NAV-100 — Theme follows the system.** Light or dark colours follow the operating system's setting; there is no
in-app theme switch. Reduced-motion settings turn animations off.

**NAV-101 — Phone layout at 760 px wide or less.**
- Brand hidden; tighter page padding.
- Viewer: the slide on top, a footer with **‹** `n / N` **›** buttons and **Text**; side arrows hidden; tap halves /
  swipes step slides (NAV-047); the Text panel is a bottom sheet; the tutor is a bar at the bottom (open: the slide
  stays on top, the chat fills the space below → *tutor*).
- Sidebar overlays the page (NAV-077).

**NAV-102 — Desktop layout above 760 px.** Viewer: slide area with side arrows **‹** **›** (labelled
*Previous slide (←)* / *Next slide (→)*), counter and **Text** under it; the tutor ask bar floats under the slide
when closed, or a resizable panel on the right when open (→ *tutor*). The sidebar sits beside the page.

**NAV-103 — Page title and icon.** The browser tab title is **Tutr**, with a small blue rounded-square icon.

---

## L. Errors and empty states

**NAV-090 — Empty library.** With no courses (missing library folder, or no `course.json` anywhere), home shows no
next-test line, no Start session button and an empty course list. (No guidance message is shown; a rewrite may add
one.)

**NAV-093 — Missing slide image.** A slide whose image file is missing shows an empty slide area (no broken-image
icon visible); the counter, arrows and text still work.

**NAV-095 — Slide images may be cached.** A slide image, once loaded, may be reused by the browser for up to an
hour; all other data is always fetched fresh.

**NAV-096 — Unknown course.** `#c=<unknown>` (course page, deck, or notes route) shows **Unknown course.** in the page
body. The header and sidebar still work.

**NAV-097 — Unknown deck.** `#c=<course>&d=<unknown tag>` shows **Unknown deck.**

**NAV-098 — Deck with no slides.** A deck whose `pages` is 0 or missing opens straight on its end card, counter
`0 / 0`.

**NAV-099 — Hub not reachable.** If the hub stops while the page is open, the next navigation shows **The hub isn't
responding. Start it again with start.bat, then retry.** in the page body.

**NAV-104 — Course with no decks.** The course page shows its title and Start session, no topics, no Continue reading
or Exam drill links; home's resume link reads just *Nothing due.*

---

## M. Starting the hub

**NAV-110 — One hub at a time.** Starting the hub closes any other Tutr hub already running on this computer (on the
requested port and the 19 after it) so all devices share one hub, and says so in its window.

**NAV-111 — Port fallback.** If the requested port (default 8765) is taken by something else, the next free one of
the following 19 is used, and the window says which. If all 20 are taken, it says so and exits.

**NAV-112 — Access modes.** By default the hub is reachable from this computer only. *Same Wi-Fi* mode also listens on
the network and prints the address for phones; *anywhere* mode starts a Cloudflare quick tunnel and prints its public
`https` link (or explains that `cloudflared` isn't installed / the tunnel didn't start, and continues locally). The
address used for **Open on your phone** is that one (NAV-089).

**NAV-113 — Opening the browser.** Asked to open the browser, the hub opens it on its local address (waiting up to
30 s for a tunnel link first so the menu item is present).
