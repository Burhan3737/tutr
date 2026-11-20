# 03 · Practice, marking, reviews and drills

Functional requirements for everything in Tutr that sets the student work and judges it: single practice problems
(hints, typed or photographed answers, marking), the saved-mistake review queue and its schedule, the study session's
practice steps, the multi-turn **Exam drill**, and the multi-turn **Practice by topic** walk-through. They describe what
a user sees and what ends up on disk, not how the current code does it.

**Out of scope, documented elsewhere** (this file only marks where they meet):
- the deck viewer, course page, home page, routes, study-session bar and its last step's page layout → *navigation* (01)
- the tutor panel, chat thread, chat titles/stars/history, the Ask box and its photos, slash-command menu, side
  questions, live sync between devices → *tutor & live*
- reading aloud, Voice view, dictation, the tutor's memory notebook (`me/tutor-memory.md`) → *voice* (04)

**Terms.**
- *Problem*: one generated practice question with its hidden solution, hints and metadata.
- *Kind* of problem: **slide** (about the open slide), **deck** (about the open deck as a whole), **your-turn** (a
  near copy of a worked example just shown), **mixed** (from any of several topics), **review** (a fresh variation of
  a saved mistake).
- *Marking*: the model's structured verdict on the student's work.
- *Clean solve*: marked correct, readable, and no hint (or worked solution) was revealed for that problem.
- *Review item* / *saved mistake*: an entry in the course's review queue (`me/hub-state.json`, `reviews`).
- *Due*: a review item whose due date is today or earlier.
- *Drill*: an Exam drill session, which lives on its own chat.
- *Topic practice*: a Practice by topic session, which lives on its own chat.
- *Lecture deck* / *practice deck*: `deck.json` `role` (`lecture` / `practice`); practice decks are "papers".
- *Mistake type*: one of `No attempt`, `Concept gap`, `Setup`, `Method choice`, `Algebra slip`, `Skipped step`
  (plus `Needed hints`, which the hub assigns itself; `none` means no mistake).

Requirements whose visible result depends on what the AI model returns are tagged **[model-dependent]**: for
those, the requirement states how the app reacts to each shape of model output. Behaviour that is currently broken
is tagged **[currently broken]** and states the intended behaviour. Curious-but-current behaviour that a rewrite may
change is tagged **[quirk]**.

---

## A. Starting a practice problem

**PRAC-001 — Ways to get a problem.** A practice problem can be started from:
- the link **Try one on this ›** under the last tutor answer (a *slide* problem on the current slide) — shown when the
  answer was not a worked example and the scope is *This slide*;
- **Try one on this deck ›** under the last answer when that answer was a whole-deck answer (a *deck* problem);
- **Your turn: finish from here ›** under the last answer when it was a worked example (slide or whole deck) — a
  *your-turn* problem built from that answer's text;
- the **Try one** button on a deck's end card (a *deck* problem; → 01 NAV-049);
- the slash command `/try`, optionally followed by words (`/try a harder one`): a *slide* problem, or a *deck*
  problem when the tutor's scope switch is on **Whole deck**;
- the study session's **Practise** and **Mixed** steps (SESS-*), and the review page (REV-*).

**PRAC-002 — The practice panel.** Starting a problem replaces the tutor panel with a practice panel:
- heading **Practise** (or **Mixed problem** for a mixed problem) and a close button (× "Back to the slide");
- the slide area shrinks to a thumbnail of the current slide with the caption `<TAG> s<n>` and a link
  **‹ Back to slide**. Clicking the thumbnail, the link or × closes the practice panel and returns to the tutor panel
  (open) with the course's chat as it was. Any speech or dictation in progress is stopped when practice starts.
- the slide number used is the current slide, or the last slide when the end card is showing.
- a *your-turn* problem and a `/try` problem start from the open deck; the deck must exist.

**PRAC-003 — While the problem is being written.** The panel shows *Writing a problem for you…* (*Setting up your
turn…* for a your-turn problem, *Writing a fresh variation…* on the review page). Progress messages from the model
replace it as `<message>…`. If a prefetched problem is still being written (PRAC-030), the message is *Finishing the
problem that's already being written…*.

**PRAC-004 — The problem as shown.** When ready, the panel shows, in order:
- `From <slides>` (the problem's slide reference as the model gave it, e.g. `From S&D-1 s2`); omitted when empty;
- the problem text, rendered as Markdown with maths (KaTeX), slide citations linked;
- a multi-line answer field labelled *Your working* (placeholder *Your working… (or add a photo of it)*), focused on
  desktop (not on phones);
- **📷 Add photo**, and **Send from phone** (PRAC-022), and a photo count;
- **Hint** and **Check**;
- for `/try` with words: a line *You asked for: <words>* under the heading.

**PRAC-005 — Problem generation failure.** If writing the problem fails (model error, unknown deck, expired review
item), the panel shows the error message and a **Try again** link that repeats the same request.
- No deck open / unknown deck for a slide, deck or your-turn problem: *Open a deck first.*
- An unknown kind of problem: *Unknown practice kind.*
- A review problem whose item no longer exists: *That review item no longer exists.*

**PRAC-006 — What the problem must be [model-dependent].** The model is asked for one problem with exactly these
parts: the problem text; a full worked solution; a one-line final answer; two hints (hint 1 a pointing question, hint
2 the first setup step, neither giving the answer); the concept tested (≤ 8 words); the slides it comes from; the
deck tag it comes from. How the app copes with imperfect output:
- empty hints are dropped and at most two are kept; with no usable hint, a single hint *Look again at the definition
  on the slide.* is used;
- a deck tag that is not a deck of the course is replaced by the open deck (slide, deck, your-turn) or the review
  item's deck (review); for a mixed problem it stays empty (the problem is then attached to no deck);
- an empty concept falls back to the review item's concept (review problems).
- The wording follows `course.json` `assessment_style` when present (else "an exam-style question for this course").
- Every kind but your-turn asks for a changed setting and wording (not a copy of the slide's example); your-turn
  asks for the same structure with different numbers, ending with **Your turn:** finish from here.
- A `/try` request's words are passed along as what the student asked for.
- Web/textbook search follows the course's *slides only* setting (→ tutor) for writing problems.

**PRAC-007 — Mixed problem scope.** A mixed problem may come from: the topics the course's next assessment covers;
else every topic in which at least one deck has been opened (state not *new*); else every topic of the course except
*Not sorted yet*. The problem must not name the method or topic. [model-dependent]

**PRAC-008 — Problems are kept.** Every problem written (including prefetched ones never shown) is saved as
`me/practice/<id>.json` in its course (PRAC-050). A problem stays usable (hints, photos, checking, phone page) for as
long as that file exists, across hub restarts.

## B. Hints

**PRAC-010 — Hints one at a time.** **Hint** reveals hint 1 in a box titled **Hint 1**; the button becomes
**Another hint** while more hints remain, then **Show worked example**. The next click shows the next hint (**Hint 2**);
after the last hint, a click shows the full worked solution in a box titled **Worked solution** and the button
disappears. With a single hint, the button goes from **Hint** straight to **Show worked example**.
- Each click is counted on the problem on disk (PRAC-050), including the worked-solution reveal. Repeated requests
  after the solution keep returning the solution.
- The button is disabled while a hint is being fetched; a failure shows the error under the hints.

**PRAC-011 — A hint means "hinted".** Once any hint (or the worked solution) has been revealed for a problem, a later
correct answer is *not* a clean solve (PRAC-041, PRAC-043, REV-020).

## C. Answering

**PRAC-020 — Typed answer.** The student types working in the answer field and presses **Check**.

**PRAC-021 — Photo of working.** **📷 Add photo** opens the device's image picker (camera preferred on phones). The
chosen image is reduced to at most 2000 px on its long side (JPEG) and attached to the problem; the count shows
`1 photo added` / `N photos added`. Several photos can be added one after another. Failures show an alert with the
reason (*That isn't an image.*, *That photo is too large (over 12 MB).*, *That file isn't an image the browser can
open.*, *That problem has expired.*). Photos are stored in the course at `me/uploads/<problem id>-<k>.<jpg|png|webp>`.

**PRAC-022 — Send from phone.** When the hub is reachable from phones (LAN or tunnel link known, → 01) and the page is
not itself on a phone, **Send from phone** opens a dialog *Send a photo from your phone* with a QR code for the phone
page of this problem and the text *Scan this with your phone's camera, take a photo of your working, and it appears
here.* The laptop checks every few seconds; as soon as the problem's photo count changes, the dialog closes and the
count updates.

**PRAC-023 — Phone photo page.** The phone page for a problem (→ route `#upload=<problem id>`) shows the problem's
slide reference, the problem text, a big button **Take a photo of your working** and, if photos were already sent,
`N photo(s) sent so far.` After taking a photo: *Sending…*, then `Sent ✓ (N photo(s)). Check your laptop, or add
another.` and the button becomes **Add another photo**. An unknown or deleted problem shows *That problem has
expired.* The session bar is hidden on this page.

**PRAC-024 — Something must be submitted.** **Check** with an empty answer and no photos shows *Write your answer or
add a photo of your working first.* and nothing is sent to the model; Check stays available. Photos alone are enough
(the model is then told to read the photos).

## D. Marking

**PRAC-030 — Marking in progress.** After **Check**, the button is disabled and the result area shows *Marking your
work…*; the model's "writing it up" progress shows as *Writing your feedback…*, other progress as `<message>…`.
Marking never searches the web, whatever the slides-only setting.

**PRAC-031 — What marking returns [model-dependent].** The model returns: correct (yes/no), unreadable (yes/no: the
photo can't be read), a one-line verdict leading with what went right, the mistake type of the *first* error (or
`none`), feedback (≤ ~120 words, the error and the corrected step; empty when fully correct), and the concept to
review (≤ 8 words; empty if correct). A result counts as correct only if correct is yes **and** unreadable is no.

**PRAC-032 — Showing a result.** After marking, **Check** and **Hint** disappear and the result shows:
- the verdict (inline Markdown/maths), prefixed with **✓** when correct;
- a chip with the mistake type, when it isn't `none`;
- the feedback (Markdown/maths), when not empty;
- a saved line (PRAC-041/PRAC-042, REV-021), when the problem went to (or stayed in) the review queue;
- **See the full solution**, a collapsed disclosure holding the worked solution;
- one action button (PRAC-034, REV-012, SESS-*).
- The result area scrolls into view. The open deck's progress state is refreshed (a clean solve shows the deck as
  solved in the sidebar/course page without a reload).

**PRAC-033 — Unreadable photo [model-dependent].** When marking says unreadable, the result shows the verdict (or
*I couldn't read that photo.*), *Try a clearer photo (flat, good light), or type the key steps.* and **Check again**.
Nothing is saved to the review queue, no solution is shown and the deck's state is unchanged. **Check again** removes
the result and brings back **Check** (the student can add a photo or type, then check again).
- [quirk] **Hint** does not come back after an unreadable result.

**PRAC-034 — The next problem.** Outside a session and outside reviews, the action button is **Try another**: a new
problem of the same kind (a your-turn problem is followed by a *slide* problem; `/try` words are kept).

**PRAC-035 — Marking failure.** A marking error shows the message in the result area and re-enables **Check**. A
problem whose file is gone: *That problem has expired. Start a new one.*

**PRAC-036 — Every attempt is recorded.** Each marking (including unreadable ones) appends to the problem's attempt
list on disk: the typed answer, the photos sent, the full marking returned and the time.

## E. What a result does to progress and the review queue

**PRAC-040 — Clean solve.** A clean solve of a problem attached to an existing deck marks that deck **solved** (its
state shows *Solved*; home and course-page counts of solved decks include it). Solved is never undone. Nothing goes to
the review queue.

**PRAC-041 — Wrong answer.** A readable wrong answer (not a review problem) saves a mistake to the review queue,
due tomorrow (REV-001), with: the deck and slides of the problem, the concept to review from marking (or the problem's
concept when marking gave none), the problem text, and the mistake type from marking. The result says *Saved to
review · back tomorrow*.

**PRAC-042 — Right, but with hints.** A correct answer after a hint (not a review problem) is saved the same way with
mistake type **Needed hints**; the result says *Solved with a hint · saved to review · back tomorrow*. The deck is
not marked solved.

**PRAC-043 — Saved once per problem.** A problem saves at most one review item, however many times it is checked
(only possible after an unreadable result). Later checks report the same item.

**PRAC-044 — Mirror into progress.md.** See REV-040.

## F. Prefetch ("Try another" is instant)

**PRAC-045 — Prefetch.** When a *slide*, *deck* or *mixed* problem without `/try` words is checked, the hub starts
writing the next problem of the same kind, deck and topics in the background. The next **Try another** (or any new
problem with the same kind, deck, model, slides-only setting and topics) takes that problem instead of writing a new
one; if it is still being written, the request waits for it (PRAC-003). Only one prefetch per such combination exists
at a time; it is used once.
- A *slide* prefetch is only used for the same slide number; otherwise a fresh problem is written (the prefetched one
  stays on disk unused).
- A failed prefetch is silently replaced by a fresh problem.
- Review, your-turn and `/try`-with-words problems are never prefetched.
- Prefetched problems are lost when the hub restarts (their files remain on disk).

## G. Problems on disk

**PRAC-050 — Problem record.** `me/practice/<id>.json` (id: 12 lowercase hex characters) holds: course, kind, the
deck the request came from and its slide number, the deck the problem belongs to, the review item it varies (if any),
problem text, worked solution, final answer, hints, concept, slide reference, hints used (count), attempts, photo
paths, creation time (`YYYY-MM-DD HH:MM`), the `/try` words, the model used, and the review item it saved (once
saved). The hub never deletes these files.

**PRAC-051 — Lookup.** A problem id is accepted only in the 12-hex form; anything else is "expired". A problem is
found in any course of the library.

---

## H. The review queue

**REV-001 — What a review item is.** A saved mistake: id, deck (may be empty), slides, concept, problem text, mistake
type, a note (the student's clue, ≤ 300 characters), its step on the schedule (0–4), due date, date created, date
last practised. Items are created by practice (PRAC-041/042) and by the Exam drill (DRILL-040). A new item is due
**tomorrow** at step 0.

**REV-002 — The schedule.** The spacing is **1 → 3 → 7 → 14 → 30 days**:
| Event | Effect |
|---|---|
| Item saved | step 0, due tomorrow |
| Review answered correctly with no hint, at step k (0–3) | step k+1, due today + 3 / 7 / 14 / 30 days (for k+1 = 1 / 2 / 3 / 4) |
| Review answered correctly with no hint at step 4 | the item is **retired**: never due again, not shown anywhere |
| Review answered wrong, or right only with a hint | back to step 0, due tomorrow; the mistake type is replaced by marking's (unless marking said `none`) |
| Unreadable photo | no change |
So an item retires after five clean reviews in a row.

**REV-003 — Due and the daily cap.** On a given day, the items offered are those due today or earlier that were not
already practised today, oldest due date first (then oldest created), at most **5 per course per day** — items
practised today count against the 5. Example: 7 due in the morning → 5 offered; after 2 are practised, 3 more are
offered (5 − 2), from the remaining due items.

**REV-004 — Due count on home and course page.** Home (for the suggested course) and the course page show
`N quick review(s) · ~M min first · ` and a link **Just the reviews** when N > 0, where N is the number offered now
(REV-003) and M = N × 1.5 rounded to the nearest whole number with halves rounded to even, minimum 1
(1→2, 2→3, 3→4, 4→6, 5→8). With N = 0 the line falls back to the resume line (*Nothing due.* … → 01 NAV-042). The
study session's first step goes to the reviews only when N > 0 (SESS-001).

**REV-005 — Ignored items.** Retired items and old "warm-up" items (`"warmup": true` in the file) are never due,
counted, mirrored or practised.

## I. The review page (`#review=<course>`)

**REV-010 — Layout.** Breadcrumbs *Home › <code> › Reviews*. The page works through the items offered when it was
opened (REV-003), one at a time, with a counter `i of N` above a practice area. Each item gets a *review* problem
(a fresh variation of the saved one, PRAC-*), with the same hint, photo, check and result behaviour as other problems.
The waiting text is *Writing a fresh variation…*.

**REV-011 — What a review problem is [model-dependent].** The model gets the saved problem text, concept and mistake
type and is asked for a fresh variation at the same difficulty where the missed step can't be avoided: for Setup,
Method choice, Concept gap or No attempt a changed setting and form; for Algebra slip or Skipped step a familiar
form with new numbers. The item's deck is the context; if the deck no longer exists, the course's first deck is.

**REV-012 — Next.** After each result, the button is **Next review**, or **Finish** on the last item.

**REV-013 — Done card.** After the last item: **Reviews done** and `N item(s) reviewed.`; with nothing offered when
the page opened: **Nothing due** and *Nothing to review today.* Below: during a study session for this course,
**Continue: new slides** (moves the session to its New slides step at the resume point); otherwise, if the course has
a resume point, a link **Back to <tag> · slide <n>**.

**REV-014 — Review answers update the schedule.** Checking a review problem applies REV-002 to its item and stamps it
practised today, so it drops out of today's due list and count. A clean solve also marks the problem's deck solved
(PRAC-040).

**REV-015 — Your note from last time. [currently broken]** When the item has a note (REV-030), the result of its
review problem shows a box **Your note from last time** with the note. Currently the list of due items sent to the
page does not include the note, so the box never appears.

**REV-016 — Missing item.** If an item disappears between listing and practising, its problem fails with *That review
item no longer exists.* and **Try again**.

**REV-021 — Saved line on review problems.** A review result that is not a clean solve shows *It'll come back
tomorrow.* A clean solve shows no saved line.

## J. Review notes

**REV-030 — The clue line.** A note (trimmed, at most 300 characters) can be attached to a review item. In the
current UI the only way is the study session's last step (SESS-004), which attaches it to the last mistake saved in
that session. Notes are shown in the progress.md mirror (*Clue noted*) and, intended, on the item's next review
(REV-015). Setting a note on an unknown item does nothing.

## K. Mirror into progress.md

**REV-040 — Saved mistakes are mirrored.** Whenever the hub saves its state for a course and `me/progress.md`
exists, the block between `<!-- study-hub:start -->` and `<!-- study-hub:end -->` is rewritten (or appended at the end
of the file, after a blank line, if the markers are missing):
```
<!-- study-hub:start -->
## Mistakes saved in the Study Hub

Written by the Study Hub from `me/hub-state.json`; don't edit by hand. Use it for mocks and cheat sheets.

| Saved | Where | Concept | Mistake | Clue noted | Step | Next due |
|---|---|---|---|---|---|---|
| <created> | <slides, else deck> | <concept> | <mistake> | <note> | <step+1>/5 | <due> |
<!-- study-hub:end -->
```
- One row per open item (not retired, not warm-up), oldest created first; `|` in a cell becomes `/`, line breaks
  become spaces. With no open items the table is replaced by `None yet.`
- If `progress.md` does not exist it is not created. Text outside the markers is preserved.
- The mirror is rewritten on any state save (also e.g. when a slide is viewed), not only when reviews change.

---

## L. Study session: the practice steps

(The session bar, its storage and the last step's page are → 01 NAV-080..085.)

**SESS-001 — Review step.** Step 1 opens the review page when N > 0 (REV-004), otherwise moves straight to step 2.
The review page's done card offers **Continue: new slides** (REV-013).

**SESS-002 — Practise step: three problems.** During a session for the open deck's course, starting a slide, deck or
your-turn problem while on step 2 (New slides) moves the session to step 3 (Practise). On step 3, after each result
the button is **Try another** for the first two problems, and **Next: one mixed problem** after the third (counting
problems marked on step 3, mixed excluded, across reloads; a your-turn's follow-up is a slide problem). Clicking the
session bar's **Practise** segment opens a slide problem on the deck and slide on screen if a deck of that course is
open, otherwise at the course's resume point.

**SESS-003 — Mixed step.** **Next: one mixed problem** (or the **Mixed** segment) moves to step 4 and opens a mixed
problem (PRAC-007) titled **Mixed problem**. Its result button is **Next: one line to remember** (→ step 5,
`#step=note`). While on step 4, any problem's result button is **Next: one line to remember**. A mixed problem
outside a session gets **Try another**.

**SESS-004 — The note goes on the last mistake.** Each practice result during the session that saved (or kept) a
review item remembers that item as the session's *last mistake*. At the last step, a non-empty line is saved as that
item's note (REV-030). The subtitle reads *Shown next time this comes back.* if there is a last mistake, else
*Nothing was missed today; a line still helps.* (the line is then discarded). Failure to save the note is silent.

---

## M. Exam drill

**DRILL-001 — Where it starts.** The drill setup dialog opens from: the tutor panel's **Exam drill** button; the
slash command `/drill`; the course page's **Exam drill ›** link (shown when the course has a resume point: it opens
the resume deck with the panel open and the dialog showing).

**DRILL-002 — The setup dialog.** Title **Exam drill**, close ×, and the explanation *Questions like the real paper,
one at a time, from the decks you pick. Work on paper, then send what you got (typed, spoken or a photo). Hints when
you ask; the answer only when you ask for it, then the written solution, a shortcut and the method for variants.*
- **Decks in range**: quick choices — a select *From the start up to…* listing lecture decks (choosing one ticks every
  lecture deck from the first up to it, in lecture order, and unticks the rest); a link
  `<assessment name> (W<lo>–<hi>[, assumed])` when the course has a next assessment (ticks lecture decks whose week is
  within those weeks); **All**; **None**. Then one checkbox per lecture deck `<tag> · W<week> · <title>`, grouped
  under their topic names, topics in lecture order (consecutive decks of one topic share a group; a topic split by
  another topic's decks appears twice). Practice decks are never in this list.
- **Format from**: one checkbox per practice deck `<tag> · <title>` and the note *None ticked: the format of the
  course's assessments.*; with no practice decks: *No practice papers in this course yet: the drill follows the
  assessment format in the course notes.*
- **Focus**: a free-text box (placeholder *Optional: e.g. calculations only, harder questions — or paste the test's
  study guide*), up to 8000 characters kept.
- **Start the drill**. With no deck ticked: *Pick at least one deck.* and the dialog stays.

**DRILL-003 — Defaults.** Initially ticked and filled: the range, papers and focus of the course's most recent drill
(starred drill chats take precedence over newer unstarred ones [quirk]); with no earlier drill, the lecture decks of the
next assessment's weeks (all lecture decks when there is no next assessment), no papers, empty focus. When opened
from the tutor panel while a practice deck is on screen, that paper alone is ticked under Format from (instead of the
default papers); from the course-page link it is not.

**DRILL-004 — Starting.** Start closes the dialog and starts a **new chat** in the course (the previous chat moves to
the earlier-chats list). The range is kept as lecture decks in lecture order and papers in lecture order; unknown
tags, and practice decks offered as range (or lecture decks offered as papers), are dropped. A range left empty after
that is refused: *Pick at least one deck for the drill.* The question line reads **Exam drill**. The chat's title is
`Exam drill: [<first>] → [<last>]` (or `Exam drill: [<tag>] only`), followed by ` · <paper tags>` when papers were
picked.

**DRILL-005 — The first turn [model-dependent].** The model is asked to restate the range in one line (first and last
deck and anything left out), name the question types and mark weights it will mirror, and ask Q1 in the shape
`**Q<n> · <topic> · <question type>** [<marks> marks] …` followed by **Slides you can use:** — no hint, method or
answer. The papers' pages, the focus and (when they fit) every deck in range are given as context; the drill's
context stays the same whichever deck is open while it runs.

**DRILL-006 — Drill status on the chat bar.** While the drill chat is shown, its bar reads
`Drill · <range> · <k> done[ · <got>/<set> marks] · <a>/<d> decks[ · <r> to revisit]` where range is
`<first> → <last>` or the single tag; *k* = questions closed; marks are summed from the closed questions whose marks
read `x/y`; *a* = range decks asked at least once; *r* = closed questions that were hinted, revealed, skipped or had a
mistake. Hovering shows `Range: <tags>[ · format of <papers>]`. It updates after every drill answer.

**DRILL-007 — Replying.** While the chat's last answer is a drill turn (not the end summary), the Ask box's
placeholder is *Your answer or what you got on paper, a question, or "give me the answer"* and whatever is sent
(text, dictation and/or Ask-box photos) is a drill reply, shown as the student's own words. Empty text with no photo
is refused (*Type a question first.*).

**DRILL-008 — Drill buttons.** Under the last drill answer: **Hint** (the next rung of hints, question line *Hint*),
**Show the answer** (*Show the answer*), **Skip** (*Skip this question*), **End the drill ›** (*End the drill*). The
same as slash commands `/hint`, `/answer`, `/skip`, `/enddrill`, which exist only while drilling (otherwise
`/<cmd> isn't available right now.`).

**DRILL-009 — Drill turn behaviour [model-dependent].** Replies are marked part by part ("Right" / "Right, but" /
"Not quite" with marks), hinted on a climbing ladder, answered fully only on explicit request, and every closed
question gets a full write-up (*Solution 1: as written for full marks*, *Solution 2: shortcut*, *Method for
variants*, *Common mistakes*, *Slides*, *Tally*) followed by the next question. Phase 1 covers each concept once in
deck-order rounds; when all are covered the model asks "Phase 2 (weak points), or stop?"; Phase 2 re-asks only weak
concepts. The end summary is **How the drill went** with *Marks*, *Held up*, *Shaky*, *Next*.

**DRILL-010 — The hidden question record.** A drill answer that closes a question carries a hidden machine-readable
record line (the question number, phase, deck, slides, concept, the question text, marks `earned/set`, outcome
`solo|hinted|revealed|skipped`, mistake type). It is **never shown**: it is removed from the saved answer, and the hub
logs the question on the drill (DRILL-030). Several such lines in one answer are each processed. An unreadable line
is removed and ignored. KaTeX backslashes inside the question text are accepted. An unknown mistake type counts as
`none`.

**DRILL-011 — Ending.** **End the drill ›** asks for the summary (closing any open question as skipped). After that,
the drill is over in the UI: the Ask box goes back to normal questions (in the same chat, with the drill's context),
the drill buttons are gone and the usual **Try one on this ›** / **Go deeper** links follow. The chat bar keeps the
final drill status.

**DRILL-012 — Drill with a drill reply outside a drill.** A drill reply/hint/answer/skip/end sent on a chat that has no
drill is refused: *No drill is running in this chat. Start one with Exam drill.*; a drill start without a range:
*Pick the drill's range first.*

**DRILL-013 — Memory.** Each drill reply also updates the tutor's notebook about the student (→ voice/memory).

**DRILL-014 — Weak points steer the drill [model-dependent].** The model is given the course's known weak points
(progress.md *Weak topics* and *Error log*, and the notebook's *Still shaky*) to steer towards inside the range.

### Drill records

**DRILL-030 — The drill log.** The drill (range, papers, focus, start time, log) is stored on its chat
(`me/chats/<chat id>.json`). Each logged question keeps: number, phase, deck, slides, concept, question text, marks,
outcome, mistake, the review item it created (if any) and when it was logged. A question number closed again
(e.g. once by a skip and again by End the drill) replaces its earlier entry but keeps the earlier non-empty values
(an earlier outcome is not overwritten by `skipped`).

**DRILL-031 — The ledger.** Every later drill turn tells the model, from the log: the phase, each question so far with
deck, concept, marks and outcome (last 15), the concepts already asked, the range decks not asked yet, the weak list,
and the next question number. [model-dependent: the student sees its effect only through the model's choices]

**DRILL-040 — Drill questions into the review queue.** When a question closes:
| Record says | Effect |
|---|---|
| outcome `solo`, mistake `none`, full marks (earned ≥ set) or marks unreadable | its deck (if in range) is marked **solved**; nothing saved |
| outcome `skipped` | nothing |
| anything else, with a question text | a review item is saved (due tomorrow, REV-001) with the record's deck (empty if not in range), slides, concept, question text, and mistake type = the record's mistake, or if `none`: `No attempt` (revealed), `Needed hints` (hinted), `Skipped step` (solo but marks lost) |
| no question text | nothing |
A question closed a second time never saves a second item.

---

## N. Practice by topic

**TOPIC-001 — Where it starts.** The tutor panel's **Practice by topic** button, or the slash command `/practice`
(optionally with words, which are passed to the model and shown as `Practice by topic: <words>`). It always works on
the **whole open deck** (lecture or practice deck), and always starts a **new chat** titled
`Practice by topic · <tag>` (the previous chat moves to the earlier-chats list). The question line reads
**Practice by topic**.

**TOPIC-002 — Slides only.** Every turn of a topic-practice chat — including ordinary questions asked in it — is
answered from the slides only (no web or textbooks), whatever the slides-only setting, and always about the deck it
started on, whichever deck is open later.

**TOPIC-003 — The first turn [model-dependent].** The model is asked for one line, then a plan table
`| # | Topic | Slides | Numerical problems | Concept / MCQ areas |`, then the first topic in the fixed format, ending
with `Say **done** when you've finished, and we'll move on to Topic <k>: <name>.`, and finally a hidden plan line
listing the topics (number, name, slide range, problem list). The fixed format per topic: `#### Topic k · <Name>:
concepts`, a `[say: …]` line, a concepts table `| # | Question | Answer | Slide |`; then (if the topic has problems)
`---`, `#### Topic k · problems`, and per problem: `**Problem (<id>): <name>** [<TAG> sN]`, `**Q:**`, numbered bold
steps with the final result bold, `**Your turn:**` a similar problem, and its answer inside a collapsed
**Answer** disclosure.

**TOPIC-004 — The hidden plan line.** The plan line is never shown: it is removed from the saved answer. The first
readable plan becomes the session's plan (topic names, slide ranges, problem lists, optional topic numbers; at most 40
topics and 40 problems each); later plan lines are ignored. An unreadable plan line is removed and the session runs
without a stored plan (TOPIC-007). Collapsed **Answer** disclosures render collapsed and open on click.

**TOPIC-005 — Topic status on the chat bar.** The chat bar reads `Practice · <tag> · <current topic name> (<i>/<n>)`,
or `Practice · <tag> · all <n> topics done` once finished, or just `Practice · <tag>` with no stored plan. Hovering
lists the plan (`1. <name> (<slides>)` per line).

**TOPIC-006 — Moving on with "done".** While topic practice is running (its last answer is a topic-practice turn and
it is not finished), the Ask box placeholder is *done, or ask about this topic* and what is sent is a topic-practice
reply. Under the last answer, **Done › next topic** (or **Done › finish the deck** when the current topic is the last
in the plan) sends `done`. A reply counts as "done" when, ignoring case, surrounding spaces and trailing `. ! , ?`,
it is exactly one of: *done, finished, next, next topic, next one, continue, go on, move on*, optionally preceded by
*ok/okay/alright/right/yes* (with or without a comma) and/or *I'm / Im / I am*, and optionally followed by *next,
thanks, thank you, please* (with or without a comma). Curly apostrophes count. Examples that are done: `Done.`,
`next?`, `I’m done`, `okay done`, `Done, thanks`. Not done: `not done`, `what is next?`, `done with step 2, but why…`.
- A "done" with a stored plan asks the model for exactly the next topic (its number, name, slides and problems from
  the plan), ending with the done line for the topic after it, or `Say **done** when you've finished, and we'll wrap
  up the deck.` before the last topic. Once the answer is saved, the current topic advances by one.
- A "done" on the last topic asks for a short close (one line that every topic is covered, one suggestion) and marks
  the session **finished**.
- Two "done"s sent at the same time advance only one topic.
- Anything else is answered inside the current topic, without moving on, ending with
  `Say **done** when you're ready, and we'll move on to Topic <k>: <name>` (or *the wrap-up*).

**TOPIC-007 — No plan stored.** Without a stored plan, "done" asks the model for "the next topic of your plan" and
the current topic never advances; the session never becomes finished, so the Done button keeps saying
**Done › next topic**.

**TOPIC-008 — Topic numbering.** Topics are numbered as the plan line gave them; without numbers, from 0 if the first
topic's name contains *overview*, *introduction* or *intro*, otherwise from 1.

**TOPIC-009 — Finished.** Once finished, the Done button is gone, the Ask box returns to normal questions (still
answered slides-only, TOPIC-002), and no further "done" is offered. No marking happens anywhere in topic practice
(the student checks against the hidden answers).

**TOPIC-010 — Refusal outside a topic practice.** A topic-practice reply sent on a chat without one is refused:
*No practice is running in this chat. Start one with Practice by topic.*

---

## O. Practice decks vs lecture decks, weak points

**DECK-001 — Practice decks.** Decks with `role: practice` (homework, past papers) are listed under **Practice**
(→ 01), never in a topic, never in the drill's range, and are offered as drill **Format from** papers. They can be
opened, explained and practised like any deck (Try one, Practice by topic). The model is told they hold questions
only, no solutions. [quirk] A lecture deck whose `topic` is literally `Practice` is treated as a practice deck.

**DECK-002 — Solved state.** A deck becomes *solved* by a clean solve of a practice problem attached to it
(PRAC-040, REV-014) or a clean drill question on it (DRILL-040). Only then do home's dots and the course page's
`solved/total` counts include it.

**DECK-003 — Weak points.** The course's weak points that steer drills (DRILL-014) and grills come from
`me/progress.md` sections *Weak topics* and *Error log* and the tutor notebook's *Still shaky*. When none exist the
model is told "(none recorded yet)". Saved review items are not part of this list.

---

## P. Edge cases (summary)

| Situation | Behaviour |
|---|---|
| Check with nothing typed and no photo | PRAC-024 message, nothing sent |
| Hint clicked after worked solution | (button is gone; server keeps returning the solution) |
| Problem file deleted | hints/photos: *That problem has expired.*; check: *…Start a new one.*; phone page: *That problem has expired.* |
| Model returns a deck tag that doesn't exist | PRAC-006 fallback; mixed problem attached to no deck (saved item has no deck; no solved marking) |
| Review item deleted while its page is open | REV-016 |
| More than 5 reviews due | REV-003 cap |
| progress.md missing | no mirror, nothing created |
| Drill range empty | dialog message; server refusal DRILL-004 |
| Drill record line malformed | removed, ignored |
| Plan line malformed | removed; TOPIC-007 |
| Practice by topic on a practice deck | allowed |
| Leaving the deck while a problem is open | the practice panel closes (navigating rebuilds the viewer); the problem stays on disk |
