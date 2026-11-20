# 02 · The tutor and chats

Functional requirements for the tutor panel beside the slides, the course's chats, side questions, the Ask box (text,
photos, live draft), live multi-device sync, the tutor's memory of the student, and model / source selection. Written
as a user or observer sees the app, independent of how it is built.

**Scope boundaries (other documents):** navigation, the library, the ⋯ menu as a whole and the Usage panel; practice
problems ("Try one", "Your turn"), reviews, Exam drill and Practice by topic; voice (Voice view, ▶ Play, dictation,
spoken Talk). Where this area hands over to them, the requirement says so.

**Conventions**

- **[MODEL]** marks a requirement whose visible outcome depends on what the AI model returns. In tests the model is
  replaced by a fake that returns scripted text and streams "status" lines and "text" pieces; these requirements
  are verified against that scripted output, not against real model quality.
- "The course's data folder" is `<library>/<Course>/me/`. Files named there (`chats/`, `hub-state.json`,
  `drafts.json`, `uploads/`, `tutor-memory.md`, `progress.md`) are part of the product contract.
- "Device" means any open browser page on the hub (a second tab counts as a second device).
- Slide references use the deck's tag and slide number, written `[TAG sN]` (e.g. `[S&D-1 s2]`).

---

## 1. The tutor panel

**TUT-001 · Every slide view has a tutor, closed by default as an ask bar.**
Given a deck is open on a slide, when the page first loads, then under/beside the slide there is a one-line ask bar
(a ✦ mark, the Ask box, an attach-photo button, a dictation button where the browser allows the microphone, an
**Ask** button and an **Open the tutor** button). The panel's open/closed state is not remembered across a reload:
a freshly loaded page always starts with the ask bar.

**TUT-002 · The ask bar's hint names the slide.**
While closed, the Ask box's placeholder reads "Ask about slide N… or / for a mode" (N = current slide; at the
deck's end card, the last slide). It updates as the student changes slide.

**TUT-003 · Sending from the ask bar opens the panel with the question in it.**
Given the ask bar, when the student types a question and presses Enter (or **Ask**), then the full panel opens
and the question is answered there exactly as if asked from the open panel (TUT-020).

**TUT-004 · Opening and closing the panel.**
**Open the tutor** opens the full panel and puts the cursor in the Ask box. The panel's **×** ("Close the tutor")
returns to the ask bar; closing also closes any side question, stops any reading aloud and cancels any dictation
in progress. An answer still being written when the panel closes keeps being written and saved (it reappears when
the panel is reopened).

**TUT-005 · Panel header.**
The open panel shows, in order: the title "Tutor"; where it is working ("TAG sN", or "TAG · whole deck" when the
scope is Whole deck or the end card is shown); reading-view zoom tools; **Read**; **New chat**; **Print**; a ⋯ menu
holding **Copy chat as Markdown**; and **×**.

**TUT-006 · Scope switch: This slide | Whole deck.**
A two-option switch ("Work on": **This slide** / **Whole deck**) sits above the action buttons. The choice is
remembered on the device across reloads and decks. It changes what Explain simply, Worked example, Quiz prep,
Before you start and Grill me work on (TUT-011..TUT-016) and the "where" label (TUT-005). Changing it redraws the
panel without losing the chat, an answer still streaming, or an open side question.

**TUT-007 · Quick actions.**
The panel offers these buttons, each sending a tutor request in the course's current chat:

| Button | This slide scope | Whole deck scope |
|---|---|---|
| Big picture | whole deck always: "Big picture · whole deck" | same |
| Worked example | "Worked example" | "Worked example · whole deck" |
| Explain simply | "Explain simply" | "Explain simply · whole deck" |
| Grill me | "Grill me" | "Grill me · whole deck" |
| Exam drill | opens the drill setup (→ practice/drill document) | same |
| Practice by topic | starts Practice by topic (→ practice/drill document) | same |
| Quiz prep | "Quiz prep" | "Quiz prep · whole deck" |
| Before you start | "Before you start" | "Before you start · whole deck" |
| Cheat sheet | whole deck always: "Cheat sheet · whole deck" | same |

The quoted text is what appears as the question in the thread (TUT-021).

**TUT-008 · Each action asks for a distinct kind of answer.** [MODEL]
The request sent to the model differs per action, and always names where the student is: the slide as
`[TAG sN] "slide title"`, or for whole-deck actions the deck as `[TAG] "deck title" (slides 1–N)`:

- Explain simply (slide): a whiteboard-style explanation of the slide's idea through one small worked example and
  a drawing, ending with a "Check yourself" question whose answer is hidden.
- Explain simply (whole deck): the deck's main ideas in slide order (at most 6), each citing its slide range.
- Worked example (slide / deck): one worked problem with numbered steps and the answer in bold.
- Quiz prep (slide / deck): likely question types, what to memorise, traps; the deck version ends with self-check
  questions whose answers are hidden. Both use the course's assessment style when the course defines one.
- Before you start (slide / deck): prerequisites only, as tappable terms with where each is taught.
- Big picture: every concept of the deck at a glance, with a concept-map diagram.
- Cheat sheet: methods, formulas & facts, shortcuts and "don't forget" for the whole deck, for the course's
  assessment style.
- Go deeper: a fuller version of the last answer in this chat.

**TUT-009 · Go deeper.**
Under the last answer of the chat (unless that answer was itself a "Go deeper"), a **Go deeper** link sends
"Go deeper" (never scoped to the whole deck; its question shows the current slide).

**TUT-010 · What-next links under the newest answer.**
Only the newest answer in the thread carries what-next links (older answers lose them when a new question is sent):

- after a Worked example (either scope): **Your turn: finish from here ›** (→ practice document);
- after a whole-deck answer: **Try one on this deck ›**; after any other answer: **Try one on this ›**
  (→ practice document);
- **Go deeper** (TUT-009);
- after a Grill me question: only **End the grill: summary ›** (TUT-030);
- drill and Practice by topic answers carry their own controls (→ practice/drill document).

**TUT-011 · Free-form Ask.** [MODEL]
Given the panel, when the student types a question and presses Enter or **Ask**, then the question is sent with
the slide they are on (`(The student is looking at slide [TAG sN] "title".)` followed by their words) and answered in
the course's current chat. Shift+Enter inserts a new line instead of sending.

**TUT-012 · Empty Ask does nothing.**
With no text (whitespace only) and no attached photo, Enter / **Ask** does nothing, and **Ask** looks inactive
(ghost style). It becomes active as soon as there is text or a photo.

**TUT-013 · Photo-only question.**
With photos attached and no text, sending asks "See the photo." (one photo) or "See the photos." (several).

**TUT-014 · Ask-box placeholder by state.**
In the open panel the Ask box's placeholder (also its accessible name) is:
- normally: "Ask anything about this slide, or / for a mode";
- while a grill is running (TUT-030): `Your answer, or "stuck" / "stop"`;
- while an exam drill or Practice by topic runs: their own hints (→ practice/drill document).

**TUT-015 · Slash commands.**
Typing "/" at the start of an empty Ask box lists the modes, each with a hint: /explain (Explain simply),
/example (Worked example), /try (A practice problem), /quiz (Quiz prep), /grill (Grill me: an oral exam),
/drill (Exam drill), /practice (Practice by topic · whole deck), /before (Before you start), /deeper (Go deeper on
the last answer — only when the chat has messages), /bigpicture (Big picture · whole deck), /cheatsheet (Cheat
sheet · whole deck), /brush (Brush up a prerequisite). While a grill runs /end also appears; while a drill runs
/hint, /answer, /skip, /enddrill appear. Typing more letters filters the list; ↑/↓ move the highlight; Tab (or
Enter on a partly typed command) fills it in followed by a space; Esc hides the list; Enter on a complete command
runs it. Pressing "/" anywhere on the slide page (not while typing in a field) focuses the Ask box and opens the list.

**TUT-016 · Slash commands carry the student's own words.** [MODEL]
"/explain using a bank queue" runs Explain simply (following the scope switch) with the words added to the request
("The student added this to the request: "using a bank queue" …"); the question shows as
"Explain simply: using a bank queue". "/brush percentage change" asks a prerequisite brush-up and shows as
"Brush up: percentage change"; /brush with no words shows the message "Say what to brush up on, e.g. /brush
percentage change" and sends nothing. An unknown command shows "No command /xyz. Type / to see them."; a command not
available now (e.g. /end with no grill running) shows "/end isn't available right now." Both are brief toasts and
nothing is sent. /try hands over to practice; /drill opens the drill setup.

**TUT-017 · Question bubbles.**
Each question appears in the thread as a bubble with: a fold toggle ▾, the question text (the student's words, or
the action's label per TUT-007/TUT-016), and where it was asked: " · sN" for a slide of the open deck,
" · OTHERTAG sN" for a slide of another deck of the course, " · TAG" for a whole-deck question. A dictated
question is prefixed with 🎙. Photos sent with it show as thumbnails (each opens the full image in a new tab).

**TUT-018 · Labels follow the open deck.**
The chat is the course's (CHAT-001). When the student moves to another deck of the same course, the panel stays as
it is (no reload, an answer still streaming continues) and every question's "where" label is recomputed relative
to the newly open deck.

**TUT-019 · Folding an answer.**
The ▾ on a question hides its answer (also one still streaming); tapping again shows it. The toggle's tooltip is
"Hide the answer" / "Show the answer" and its expanded state is exposed to assistive tech. Folding lasts for the
page's lifetime (survives redraws of the thread, not a reload).

**TUT-020 · Sending a question shows it at once.**
When a question is sent, its bubble appears at the bottom of the thread immediately, followed by a waiting line
(STR-001), and the thread scrolls to the bottom. Any "empty chat" message and earlier-chats list disappear.

**TUT-021 · Several questions may be in flight.**
The student may send another question before the previous answer has finished. Each gets its own bubble and
waiting line, answers stream into their own places, and both are saved into the same chat.

**TUT-022 · Copy one answer.**
Under every answer, **Copy** copies that answer as Markdown without the tappable-term brackets, drawing cues or
spoken-only lines; the button briefly reads "Copied" (or "Couldn't copy").

**TUT-023 · Copy the whole chat.**
⋯ → **Copy chat as Markdown** copies the chat: `# <title>`, an italic line with course code, deck(s) and date, then
each question as `**You** (TAG slide N): text` and each answer followed by `---`. With no messages it shows the
toast "Nothing to copy yet".

**TUT-024 · Print the chat.**
**Print** opens the browser's print dialog with only the chat: title, the meta line, each question ("You (TAG
slide N): …") and each answer with maths and diagrams rendered and hidden-answer blocks expanded. With no messages:
toast "Nothing to print yet".

**TUT-025 · Reading view.**
**Read** (or the R key when not typing) turns the chat into a full-width page that hides the slide; zoom −/+ (80%
… 200%), a reset showing the current percentage, and **Fit width** (W) adjust it; Esc leaves. The reading view, zoom
and fit-width choices are remembered on the device. Toggling keeps the reader at the same place in the chat.

**TUT-026 · Panel width.**
On a wide screen the panel's left edge can be dragged (or moved with ←/→ when focused, 40 px per press) between
300 px and 75% of the viewer; double-click resets it. The width is remembered on the device.

**TUT-027 · Keyboard focus safety.**
Slide shortcuts (←/→, T, Z, R, /) do not fire while the student is typing in the Ask box or any other field.

### Grill me

**TUT-030 · Grill me is a multi-turn oral exam.** [MODEL]
Grill me (slide or whole deck) asks the tutor to open an oral exam: one line naming what it will cover, then Q1.
While the chat's last answer is a grill turn, whatever the student types is sent as their **answer** to the grill
(not a new question), the placeholder reads `Your answer, or "stuck" / "stop"`, and the only what-next link is
**End the grill: summary ›** (also /end). End the grill sends "End the grill" and the tutor replies with a summary
("How the grill went": Held up / Shaky / Next). After any non-grill answer, typing returns to normal questions.

**TUT-031 · Grill steers by known weak points.** [MODEL]
The grill's opening request includes the student's known weak points: the "Weak topics" and "Error log" sections
of the course's `me/progress.md` and the "Still shaky" section of `me/tutor-memory.md` (or "(none recorded yet)").

**TUT-032 · Grill answers feed the tutor's memory.**
Each answer the student types during a grill updates the tutor's memory in the background (MEM-001).

---

## 2. Answers: streaming, status, errors

**STR-001 · Waiting line.**
Right after sending, a waiting line shows "Writing a worked example…" (Worked example), "Reading the whole
deck…" (any whole-deck action), or "Thinking…" (anything else).

**STR-002 · Status lines replace the waiting text.** [MODEL]
Whenever the tutor reports what it is doing, the waiting line shows that status followed by "…", e.g. "Reading the
S&D-1 slides…", "Searching the course for “elasticity”…", "Looking in <book>…", "Reading your class notes…",
"Looking at your photo…", "Searching the web: <query>…", "Reading <domain>…", "Thinking it through…",
"Opening the conversation…", "Waiting for the last answer to finish…", "Writing it up…".

**STR-003 · The answer appears as it is written.** [MODEL]
When the first piece of text arrives, the answer area appears above the waiting line, which then reads
"Writing…". Text keeps appearing as pieces arrive (a few repaints per second, not necessarily per piece). The
thread follows the newest text unless the student has scrolled up (more than ~80 px from the bottom); scrolling
back to the bottom resumes following.

**STR-004 · Half-written markup is never shown.**
While streaming, a partly arrived drawing cue (`[#…`) or spoken-only line (`[say: …`) is not shown as text; a
display formula is not rendered until its closing `$$` arrives (text before the last complete paragraph is
rendered; the incomplete tail is rendered provisionally).

**STR-005 · Finished answer settles in place.**
When the answer is complete, the waiting line disappears and the finished answer takes the streamed one's place
without visible jumps (drawings already drawn are kept, not redrawn). If the saved text differs from what streamed,
the saved text is what is shown. Copy / ▶ Play / what-next links appear under it.

**STR-006 · The answer is saved even if the page goes away.**
If the student closes the panel, moves to another deck or course, reloads, or loses the connection while an answer
is being written, the answer still completes and is saved in the chat. A device that reconnects mid-answer catches
up with the text so far (LIVE-006).

**STR-007 · No cancel for a written answer.**
There is no control to stop an answer being written; it always runs to completion (or error). (■ Stop exists only
for reading aloud → voice document.)

**ERR-001 · A failed answer shows an error in place.** [MODEL]
If the tutor fails, the waiting line (and any partial answer) is replaced by a red error message. The question
bubble stays on screen for now, but neither the question nor an answer is saved in the chat (after a reload, or
the next redraw of the thread, the failed question is gone). The text the student typed is not put back in the box.

**ERR-002 · Error messages.**
The error shown is the tutor's own message when it gives one, e.g. "That took too long. Try again.", "Claude didn't
answer. Check that Claude Code is signed in, then try again.", "Claude ran out of look-up steps. Try a narrower
question.", "Claude reported an error. Try again in a moment.", "Claude's answer came back in the wrong shape. Try
again.", "The last answer in this chat is still coming. Try again in a moment.", "That chat was deleted while it was
answering."; otherwise "Something went wrong. Try again.". If the hub cannot be reached: "The hub isn't responding.
Start it again with start.bat, then retry."; if the answer stream ends without completing: "The answer was cut
off. Try again."

**ERR-003 · Photos come back after a failed question.**
Photos attached to a question that fails are put back in the Ask box (on every device).

**ERR-004 · Request validation.**
A question with no text and no photos is refused ("Type a question first."); a request for a deck that does not
exist is refused ("Open a deck first."); an unknown mode is refused ("Unknown request."); an unknown course is
refused ("Unknown course.").

**ERR-005 · Every failure is still counted.**
A failed answer is recorded in usage (with whatever it consumed), for the Usage panel (→ navigation/usage document).

---

## 3. Rendering answers

**REN-001 · Markdown.** [MODEL]
Answers render as Markdown (GitHub flavour: headings, lists, bold/italic, tables, code blocks, links).

**REN-002 · Maths.** [MODEL]
`$…$` renders as inline maths and `$$…$$` as display maths (KaTeX); a formula that cannot be parsed shows as
its source rather than breaking the answer. Maths inside code is left alone.

**REN-003 · Tappable terms.** [MODEL]
`[[term]]` renders as a tappable term (tooltip "Explain this on the side"), its content rendered (maths too), with
no brackets visible. Tapping it opens a side question about that term (SIDE-001).

**REN-004 · Hidden answers.** [MODEL]
`||text||` renders blurred; clicking it, or Enter/Space when focused, reveals it (tooltip "Click to show the
answer"). Hidden-answer `<details>` blocks are collapsed with a "Answer" summary.

**REN-005 · Slide citations are links.** [MODEL]
A citation `[TAG sN]` (or a range `[TAG sN–sM]`) naming a deck of the course renders as a chip (tooltip "Open TAG
slide N"); clicking it opens that slide of that deck. Citations inside code, maths, links or buttons are not
linked; tags of other courses are not linked.

**REN-006 · External links.** [MODEL]
Web links open in a new tab; a link whose text is its own URL shows just the host name (without "www.").

**REN-007 · Never-shown markup.** [MODEL]
Drawing cues `[#id]` and spoken-only lines `[say: …]` (a line of its own) are never shown, copied or printed;
inside a code block they are left as written.

**DRW-001 · Mermaid diagrams.** [MODEL]
A ```mermaid block renders as a diagram (a placeholder "Drawing the diagram…" until drawn). A diagram that fails
shows "Couldn't draw this diagram; here is its source." and the source.

**DRW-002 · SVG drawings.** [MODEL]
An ```svg block renders as the drawing (scripts can never run). A bare `&` or `<br>` in it is tolerated. A drawing
that references the arrowhead `url(#arrow)` without defining it gets one. A drawing that cannot be shown is
replaced by "This drawing couldn't be shown."

**DRW-003 · Function plots.** [MODEL]
A ```plot block (`f:` up to 6 comma-separated functions of x or n with + − * / ^ and log2 ln log10 sqrt exp fact;
optional `x: a..b`, `y: log` or `y: a..b`, `title:`) renders as an exact chart computed by the app (axes, ticks,
legend, title; "(log scale on y)" when log). A block without `f:` or with nothing plottable shows "Couldn't draw this
(<reason>); here is its source."

**DRW-004 · Handwritten A4 sheets.** [MODEL]
A ```sheet block (optional `cols: 1|2|3`, `title: …`, then Markdown) renders as an A4 page in a handwriting font,
shrunk to fit one side, with a note: "One A4 side · N columns", or "Fits, but small (X px): hard to copy by hand.
Consider cutting it down.", or "This doesn't fit on one side even at the smallest size: cut it down, or split it over
two sheets.", and a **Print / Save as PDF** button that prints that page alone.

**DRW-005 · Drawings appear in place while streaming.** [MODEL]
While an answer streams, each drawing appears at its place in the text: an SVG drawing element by element as its
parts arrive (strokes drawn on with a short pen animation unless the system asks for reduced motion); a Mermaid
diagram or plot once its block is complete. An unfinished drawing block never shows a broken half-diagram; if the
answer ends with it still open, whatever was drawn stays, or else its source is shown as text.

**DRW-006 · Parts are revealed as the text describes them ("followed while described").** [MODEL]
When the text names parts of a drawing with cues (`[#id]` matching a Mermaid node id or an SVG element id), then
while the answer is being written, a named part stays hidden until the sentence carrying its cue has arrived, and
the parts named by the latest such sentence are highlighted. A drawing whose next two sentences name none of its
parts is shown whole. When the answer is complete every part is shown and none highlighted.

**DRW-007 · Tap a paragraph to light its parts.** [MODEL]
In a finished answer, tapping a paragraph (not a link, button or hidden answer, and not ending a text selection)
whose sentences carried cues highlights those parts of the drawing (scrolling them into view); tapping elsewhere in
the answer clears the highlight. Only one answer's drawing is highlighted at a time.

**DRW-008 · Drawing failures are reported.**
A drawing that fails to render is reported to the hub's log (what failed and its source), without bothering the
student beyond the in-place note.

---

## 4. Chats

**CHAT-001 · One current chat per course, shared by every deck.**
Every deck of a course reads and writes the same current chat. Questions asked on different decks of the course
land in the same chat, each remembering its deck and slide. Different courses have separate chats.

**CHAT-002 · A chat is created by its first answer.**
With no current chat, the first question starts a new chat; its file `me/chats/<id>.json` (id: 12 lowercase hex
characters) is written only once the first answer is saved. If that first answer fails, no chat file is written.
`me/hub-state.json` records the course's current chat id under `chat`.

**CHAT-003 · Default chat name.**
A new chat is named after its first question: the action label or the student's words (first 70 characters),
then " · sN" (slide) or " · TAG" (whole-deck action). E.g. "Explain simply · s2", "Explain simply · whole deck ·
S&D-1", "See the photo. · s2". (The chat bar may show the short form without the " · sN" suffix until the chat is
next loaded.)

**CHAT-004 · What a saved chat holds.**
Each saved turn adds a question record (mode, deck tag, slide, the question text as shown, plus "whole", "spoken"
and "photos" when they apply) and an answer record (mode, deck, slide, the answer's full text, time taken, cost,
model id). The chat also holds its course, course code, starting deck, created/updated times, name, starred flag,
and, for drills / Practice by topic, their own state. The tutor's conversation handle is stored too but never
sent to the browser.

**CHAT-005 · The chat survives reload and restart.**
Given a chat with answers, when the page is reloaded (or the hub restarted), then opening any deck of the course
and the tutor panel shows the same chat: its name, star, and every question and answer rendered as before.

**CHAT-006 · Chat bar.**
Above a chat's first message is a bar with a star toggle and the chat's name (plus drill / practice status when
those run → practice/drill document). An empty chat shows no bar.

**CHAT-007 · Rename.**
Clicking the chat's name turns it into a text field (accessible name "Chat name", max 120 characters) with the name
selected; Enter or leaving the field saves, Esc cancels. Whitespace is collapsed; an empty name is not saved (the
old name stays). The new name is written to the chat file and shown at once.

**CHAT-008 · Star.**
The star toggle (☆ "Star this chat" / ★ "Unstar this chat", pressed state exposed) marks the chat starred in its
file. Starred chats are listed before unstarred ones in earlier-chat lists, with a ★ before the name.

**CHAT-009 · New chat.**
**New chat** makes the course have no current chat: the thread empties (any reading aloud stops, dictation is
cancelled), the Ask box gets focus, and the next question starts a new chat. Every other device with the course open
switches to the empty chat too (LIVE-008). The previous chat is kept and appears first among the earlier chats.

**CHAT-010 · Empty-chat view and earlier chats.**
With no messages, the thread says "Ask anything about this slide, or type / for a mode." (in Voice view: "… Voice:
answers are read aloud as they appear."). If the course has other saved chats it lists, under "Earlier chats in
this course:", up to five of them (excluding the current one), starred first then most recently updated, each a
button with its name (★-prefixed if starred).

**CHAT-011 · Open an earlier chat.**
Clicking an earlier chat makes it the course's current chat: its messages appear in the panel (same deck), and the
next question continues it. Other devices with the course open switch to it too.

**CHAT-012 · Continuing an old chat keeps its conversation.** [MODEL]
A reopened chat continues the tutor's same conversation (the tutor remembers what was said in it), provided the
chosen model's engine still has it.

**CHAT-013 · Delete a chat.**
Deleting a chat removes its file. If it was the course's current chat, the course has no current chat and every
device showing it switches to the empty chat. A chat deleted while an answer is being written into it is not
brought back: that answer fails with "That chat was deleted while it was answering."
*(Current build: no on-screen control reaches this; see "Known issues".)*

**CHAT-014 · History of all chats.**
The ⋯ menu has a **History** item meant to list the course's chats (name, course code, deck, number of questions,
last update, "Open ›", star, rename, **Delete** with a confirmation "Delete this chat?"). *(Current build: the item
does nothing and raises a page error; see "Known issues".)*

**CHAT-015 · Chats from before decks.**
A chat that has no deck (from an older version) cannot be continued ("That chat can't be continued.") and opens as a
read-only page with its name, **Copy chat** and **Save as PDF**.

**CHAT-016 · Missing chat.**
Asking for a chat that no longer exists (to open, rename or star it) answers "That chat no longer exists."

---

## 5. Side questions

**SIDE-001 · Tap a term for a side explanation.** [MODEL]
Tapping a tappable term in an answer opens a sheet over the lower part of the panel labelled "On the side · not
added to your chat", quoting the term, and immediately asks the tutor to explain just that term (with the
paragraph it appeared in and the current slide). The sheet shows "Thinking…", then status lines, then the answer as
it streams.

**SIDE-002 · Ask about a selection.**
Selecting text inside an answer (main chat or a side sheet) shows an **Ask about this** button just below the
selection (after a short pause). Clicking it opens a side sheet quoting the selection (formulas quoted as their
`$…$` source) with the box focused and placeholder "What do you want to know about this?"; nothing is sent until
the student types a question.

**SIDE-003 · Follow-ups in a side question.** [MODEL]
The sheet has its own box (placeholder "Ask a follow-up", button **Ask**, Enter sends, Shift+Enter new line).
Follow-ups continue the same side conversation. A follow-up sent while the side answer is still being written is
ignored (and the typed text is lost).

**SIDE-004 · Side questions know the chat but never join it.** [MODEL]
A side question starts from a copy of the chat's conversation so far (it knows what was said), but nothing asked or
answered in it is added to the chat, saved to disk, or shown on other devices.

**SIDE-005 · Nested side questions.**
Tapping a term inside a side answer opens a new side sheet on top; it has a **‹** button ("Back to the previous side
question") returning to the previous sheet. Esc goes back one level (closing the sheet when it is the last).

**SIDE-006 · Closing a side question.**
**×** ("Close the side question"), Esc on the last sheet, or a tap on the chat above the sheet (not the end of a
text-selection drag) closes all side sheets. Closed side questions are ended on the hub; following up on a closed
one answers "That side question was closed. Ask it again."

**SIDE-007 · Side questions and navigation.**
A side question survives redraws of the panel (scope switch, reading view) and changing slide within the deck, but
is closed when the deck changes or the panel is closed.

**SIDE-008 · Side errors.**
A failed side answer shows the error message in red in the sheet.

---

## 6. Photos in the Ask box

**PHOTO-001 · Attach a photo.**
The 📷 button ("Attach a photo", tooltip "Attach a photo: it goes with your next question") attaches images. On a
laptop it opens a file chooser (several images at once), or, when the hub is reachable from a phone, offers a menu:
**Choose a file** / **Take it with your phone**. On a phone (narrow screen) it offers **Take a photo** (camera) /
**Choose a picture**. Images can also be pasted into the Ask box or dropped onto it.

**PHOTO-002 · Attached photos show as thumbnails.**
While a photo uploads a placeholder "Adding…" shows; then a thumbnail (opens the full image in a new tab) with a ×
("Remove this photo"). Photos are resized (longest side at most 2000 px) and saved as JPEG in the course's
`me/uploads/` (named `ask-<id>.jpg`) as soon as they are attached.

**PHOTO-003 · Photos are part of the shared draft.**
Attached photos appear in the Ask box of every device with the course open, are kept in `me/drafts.json`, and
survive reload and hub restart.

**PHOTO-004 · Remove a photo.**
× removes the photo from every device's box and deletes its file from `me/uploads/` (it was never sent).

**PHOTO-005 · Photos go with the next question, whatever its mode.** [MODEL]
Sending any question or action (including quick-action buttons and slash commands) takes the attached photos
along: they leave the box on every device, appear as thumbnails in the question bubble, are stored with the question
in the chat, and the request tells the tutor to read each photo (by its path in the course). A sent photo's file
is kept.

**PHOTO-006 · Limits and errors.**
At most 8 photos per question ("A question can have 8 photos at most."). A file the browser cannot open as an
image: "That file isn't an image the browser can open."; a non-image upload: "That isn't an image."; a photo over
12 MB: "That photo is too large (over 12 MB)." Errors show as a brief toast; the other photos are unaffected.

**PHOTO-007 · Take it with your phone.**
**Take it with your phone** shows a QR code ("Send a photo from your phone", "Scan this with your phone's camera
and take a photo: it goes into the Ask box here, with your next question."). The phone opens a page with "Take a
photo of your working"; after sending it shows "Sent ✓ (N photos in the Ask box). Check your laptop, or add
another." and the button becomes "Add another photo". The photo appears in the laptop's Ask box, and the QR dialog
closes by itself when it arrives.

**PHOTO-008 · Serving photos.**
Only photos saved in a course's `me/uploads/` (jpg/png/webp, simple file names) can be fetched; anything else answers
"No such photo.".

---

## 7. The Ask-box draft and live multi-device sync

**DRAFT-001 · One draft per course, shared by all devices.**
The Ask box's unsent text belongs to the course: type on one device and the same text appears in the Ask box of
every other device with that course open (any deck), within about a second.

**DRAFT-002 · The draft survives reload and restart.**
Unsent text is saved to `me/drafts.json` about a second after the last change; reloading the page, or restarting
the hub, brings it back into the Ask box. The file holds `{ "<Course>": { text, rev, spoken, by, at, photos } }`.

**DRAFT-003 · Sending empties the box everywhere.**
When a question is sent from one device, the box empties on every device.

**DRAFT-004 · Concurrent edits merge.**
If two devices edit the draft at the same time: edits to different parts of the text are both kept; edits to the
same part resolve to the version that reached the hub first; when both typed at the very end, the hub's text comes
first, then this device's.

**DRAFT-005 · The cursor stays put.**
When another device's change arrives while the student is typing, the box updates with the student's cursor and
selection kept in the right place (unmoved before the change, shifted after it, at the end of the changed part if
it was inside it). Changes wait while the student is composing a word (phone keyboards / IMEs) or dictating, and
are applied as soon as that ends. The "/" mode list is not opened on devices that did not type the "/".

**DRAFT-006 · Dictated drafts are marked.**
A draft that was (even partly) dictated is marked as spoken; a question sent from it is shown with 🎙 and treated as
spoken (MEM-001). Clearing the box clears the mark.

**DRAFT-007 · Leaving a course keeps its draft.**
Text typed just before navigating to another course (or home) is still saved to that course's draft.

**DRAFT-008 · Draft limits.**
A draft longer than 20,000 characters is refused ("That's too long for a question.").

**LIVE-001 · Devices listen to the course live.**
Every page with a course open listens to that course: drafts, questions being answered and chat switches arrive as
they happen, also through links that only deliver a reply when it ends (each listen is a short request answered as
soon as there is news, or empty after about 25 seconds).

**LIVE-002 · Another device's question appears live.**
When another device sends a question in the course, this device's open panel shows the question bubble (🎙 if
spoken, its photos, its where-label) and a waiting line "Answering a question from another device…" (or its
latest status line), then the answer as it is written ("Writing…"), then the finished, saved answer. Another
device's answer is never read aloud here.

**LIVE-003 · Closed panel still catches up.**
If this device's panel is closed when another device's question starts, opening the panel shows that turn
(the answer so far, then continuing live).

**LIVE-004 · Another device's failure.**
If another device's question fails, this device shows the error in red in place of that answer.

**LIVE-005 · Asking device sees its own answer either way.**
The asking device shows its answer from whichever arrives further first: its own request's stream or the live
channel (so an answer is still seen live when the request's stream is held back by a tunnel).

**LIVE-006 · Joining mid-answer.**
A device that opens the course while a question is being answered receives that turn with its text so far and
follows it to the end.

**LIVE-007 · Background tabs stop listening and catch up.**
A page that is hidden (background tab, phone asleep) stops listening; when visible again it catches up at once:
missed draft changes, turns in progress, and, if a turn finished meanwhile or the hub restarted, the course's chat as
it is now.

**LIVE-008 · Chat switches follow on every device.**
New chat, opening an earlier chat, or deleting the current chat on one device switches every other device with the
course open to the same chat (empty, the opened one, or empty), so the next question there goes where its screen says.

**LIVE-009 · Hub restart.**
After the hub restarts, listening devices recover by themselves (retrying, up to every 10 s while it is down) and
take a fresh snapshot; a device holding newer draft text than the restarted hub re-saves its own.

---

## 8. The tutor's memory of the student

**MEM-001 · The memory is updated after spoken questions and grill/drill answers.** [MODEL]
After (a) a dictated question sent from the Ask box, (b) a spoken Talk question, (c) a typed answer during Grill me,
or (d) a reply during an exam drill, the tutor's notes on the student are updated in the background (the student
does not wait). Ordinary typed questions and quick actions do not update it.

**MEM-002 · Memory file format.**
The notes live in `me/tutor-memory.md`: a title "# What your tutor remembers", an italic line "_Kept by the Study
Hub's tutor after each spoken question and grill answer. Edit or delete anything._", then four sections in order:
"## About me", "## Questions I keep asking", "## Mistakes I've corrected", "## Still shaky" (any extra sections the
student added are kept after them).

**MEM-003 · Updates are all-or-nothing and safe.** [MODEL]
An update the tutor says adds nothing leaves the file untouched. An update missing any of the four sections is
retried once and otherwise dropped. If the student edited the file while an update was being prepared, the
student's edit wins (the update is dropped). Updates for one course happen one at a time. A failed update leaves the
file as it was.

**MEM-004 · Which model updates the memory.**
The memory is updated by a fast Claude model (Haiku 4.5), except when the chat uses an OpenCode model, in which case
that same model does it.

**MEM-005 · The memory is used.** [MODEL]
Spoken (Talk) answers receive the notes and the progress file's weak topics / error log; Grill me receives the weak
points (TUT-031).

**MEM-006 · The memory is visible and editable.**
The memory appears on the course page as "What your tutor remembers" (→ navigation document) and can be edited by
hand.

**MEM-007 · Corrections are flagged.** [MODEL]
When the tutor's answer opens with a correction ("Not quite", "Actually", "No, …", "Close, but" …), the memory
update is told the student said something wrong, so it is recorded under "Mistakes I've corrected".

---

## 9. Model and sources

**MODEL-001 · Model picker.**
The ⋯ menu has **Model** with a drop-down grouped by provider: "Claude Code" first (Opus 5.5 · 96, Sonnet 5.5 · 88,
Haiku 4.5 · 74), then OpenCode providers (each group sorted by score, providers by their best score). Each option
reads "<name> · <score>" (an intelligence score, higher is more capable). Default: Opus 5.5.

**MODEL-002 · OpenCode models list.**
The OpenCode models are the ones its server reports when reachable, else a cached or built-in list. If none can be
found only the Claude Code group is shown.

**MODEL-003 · The choice persists per device.**
The chosen model is remembered on the device (not synced to other devices) and used for every tutor request,
side question, practice and marking from then on. If the remembered model is no longer listed, the default is used.
A request naming no or an invalid model is answered by the default model.

**MODEL-004 · Each answer records its model.**
Every saved answer records the model id, time taken and cost in the chat file (MEM-004 aside). These are not
shown under the answer in the chat; they appear in the Usage panel (→ usage document).

**MODEL-005 · Stick to slides (web on/off).**
The ⋯ menu shows, while a course is open, **Stick to slides** followed by the course code. The setting is per
course and per device (remembered). Off (default): the tutor may use the textbooks, the student's notes and the web
(sources labelled, e.g. "(web: domain.org)"). On: only the slides and the student's notes; if the slides don't cover
it the tutor says "The slides don't cover this" [MODEL]. Applies to tutor answers and side questions.
Practice by topic always sticks to the slides regardless.

**MODEL-006 · What the tutor is given.** [MODEL]
Every tutor request carries the course's code and title, the slides of the topic being studied (or the deck's
alone if the topic is too big), a map of every deck of the course, the citation and drawing conventions, the
location (slide or deck) and the student's words / the action; plus photo paths when photos are attached.

---

## Known issues in the current build (baseline as observed)

- **History is broken.** ⋯ → History does nothing and raises a page error ("showHistory is not defined"); the dialog
  never opens. As a result there is no on-screen way to delete a chat (CHAT-013), see more than five earlier chats,
  or rename/star a chat other than the current one. The hub-side operations still work.
- **Per-answer cost/time is never shown in the chat** (only stored, and shown in the Usage panel).
- **A turn that finishes after "New chat" pulls the display back.** If New chat is pressed while an answer is still
  being written, the answer is saved into the old chat; when it completes, devices display that old chat (or a
  partial copy of it) although the course has no current chat, so the next question starts a new chat while the
  screen shows the old one.
- **Failed question text is lost** (ERR-001) and a **side follow-up typed during a streaming side answer is silently
  dropped** (SIDE-003).
- **Identical answers are de-duplicated on screen.** If an answer has exactly the same text and timing as one already
  in the chat, the asking device does not add it to its view (the server still saves it). Matters for fakes.
- **New chat name shows short** until reload (CHAT-003).
- **An over-long draft** (> 20,000 characters) is refused silently and retried every 2 s.
- **No cancel** for a written answer (STR-007).
