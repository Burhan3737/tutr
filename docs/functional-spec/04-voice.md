# 04 — Voice: reading answers aloud, dictation, spoken questions

Functional requirements for everything the app does with sound: the tutor's answers read aloud, questions
dictated by microphone, and how a spoken question is treated differently from a typed one. Written from the
student's point of view and independent of the current implementation.

**Scope note — there is no separate "Talk" tab any more.** Earlier versions had a dedicated spoken-conversation
tab. Its behaviour now lives in two places inside the ordinary tutor panel: the **Voice** answer mode (answers are
read aloud as they appear) and **dictation** into the Ask box (speak, check the words, then send). The former
tab's "spoken question" request type is still accepted by the hub and still has its own answer style
(VOICE-085 to VOICE-092), but no control in the current interface sends it.

Conventions

- IDs are stable: `VOICE-001`, …. New requirements get the next free number; numbers are never reused.
- **[model]** marks a requirement whose outcome depends on a speech model (speech recognition or speech
  synthesis) or on the AI tutor model. Its *observable shape* can still be checked with stand-ins; its *quality*
  cannot.
- **[real-device]** marks behaviour that depends on real hardware or a real browser policy and can only partly be
  checked automatically.
- Speech recognition and the tutor's voice run **on the student's own computer** (the hub). Nothing about voice
  is sent anywhere else, and no recording or synthesised audio is kept after use.
- "The hub" is the local server; "the page" is the browser app. "Deck open" means a slide deck is on screen.

Handoffs (covered elsewhere): the tutor panel's layout, chats and streaming answers (tutor chat spec); the Ask
box's shared draft between devices (live-sync / tutor chat spec); drawings and their cues as such (tutor chat
spec); Practice by topic and Exam drill (practice specs). Only the voice-specific parts are specified here.

---

## 1. The speech engine: availability and warm-up

**VOICE-001 — Voice works without any account or cost.** Reading aloud and dictation use speech models that run
on the student's computer. No sign-in, key or network service is needed once the models are on the computer.

**VOICE-002 — Models load in the background when already downloaded.** When the hub starts and the speech models
are already on the computer, it begins loading them straight away, so reading aloud and dictation are ready (after
a few seconds) by the time they are first used. If they have never been downloaded, nothing is downloaded at
start-up; the first download happens only when voice is first used.

**VOICE-003 — First use downloads the models.** The first time voice is used on a computer, the speech models are
downloaded (this needs an internet connection and can take a while). Later starts load them from disk.
[real-device]

**VOICE-004 — Choosing Voice starts the warm-up.** When the tutor panel is shown with the Voice answer mode
selected (VOICE-010), the page asks the hub to get the voice ready. While the voice is not yet ready the page keeps
checking, about every two seconds, until it is ready or has failed. The same request also prepares the course's
tutor conversation, so the first answer starts sooner.

**VOICE-005 — Pressing ▶ Play also starts the warm-up** (VOICE-028), so the voice list fills in even in Text mode.

**VOICE-006 — Starting a dictation also starts the warm-up** of the speech models on the hub (the first dictation
on a cold hub can take ~10 s longer to be written down).

**VOICE-007 — Voice status is one of: not asked yet, loading, ready, unavailable.** The page treats voice as
*unavailable* when the hub reports that the models failed to load (missing software, failed download) or when the
hub cannot be reached, and as *ready* only once the hub says both speech recognition and the voice are loaded.
There is no on-screen progress for a download; the student only learns the state through the messages in
VOICE-015/016 and VOICE-046–049.

**VOICE-008 — The app still works without voice.** If the voice software is not installed or the models cannot
be loaded, every non-voice feature works normally; voice features fail with a short message instead of breaking the
page.

**VOICE-009 — An unavailable voice is retried.** After voice was found unavailable, showing the tutor panel again
in Voice mode, or pressing ▶ Play, tries again.

## 2. Text and Voice answer modes

**VOICE-010 — Text | Voice switch.** Above the Ask box in the open tutor panel is a two-option switch labelled
"Answers" with **Text** and **Voice**. Exactly one is selected.
- Text: "Answers appear as they're written; ▶ Play reads one aloud".
- Voice: "Answers are read aloud, appearing as they're spoken".

**VOICE-011 — The choice is remembered** on this browser across reloads and courses. A browser that has never
chosen defaults to Text. (A choice saved by an older version under a former name of Voice still counts as Voice.)

**VOICE-012 — Switching modes stops any reading in progress** (as Stop does, VOICE-023) and redraws the panel.

**VOICE-013 — Empty chat hint mentions voice.** With Voice selected and nothing in the chat yet, the thread says
"Ask anything about this slide, or type / for a mode. Voice: answers are read aloud as they appear." (Text mode
shows the same without the second sentence.)

**VOICE-014 — In Voice mode every new answer is read aloud** — answers to typed questions, dictated questions, the
mode buttons (Explain simply, Worked example, Grill me, …) and slash commands alike — provided the voice is ready.

**VOICE-015 — Voice not ready yet: the answer still arrives, silently.** If a question is asked in Voice mode while
the voice is still loading, the answer is shown as it is written (as in Text mode) and a brief message says "The
voice is still loading; showing the answer without it." This message is shown at most once until the voice
becomes ready.

**VOICE-016 — Voice unavailable: the answer still arrives, silently.** If voice is unavailable, the answer is
shown as in Text mode and a brief message says "Voice isn't available; showing the answer without it." — at most
once until voice becomes ready again.

**VOICE-017 — Only the asking device speaks.** When the same course is open on several devices, an answer is read
aloud only on the device that asked. Other devices show the question and answer as they are written, silently,
even if they are in Voice mode.

## 3. Reading an answer aloud

**VOICE-018 — Sentence-by-sentence reading.** An answer is read aloud in short pieces, in order: the first piece
is the first sentence (so speech starts as early as possible); later pieces are a few sentences long. Each piece is
prepared while the previous one plays, so there are no long gaps. [model] for voice quality.

**VOICE-019 — Paced appearance (Voice mode).** In Voice mode the answer appears in the chat in step with the
voice: text up to the end of the piece being spoken is shown, the rest appears as speech reaches it. When the
reading ends — finished, stopped, or failed — the whole answer is shown at once.

**VOICE-020 — The sentence being spoken is highlighted.** While a piece plays, the sentence(s) being spoken are
visibly highlighted in the answer (both in Voice mode and with ▶ Play). When a table, formula, block of working or
code is being described as a whole, that whole block is highlighted. The highlight is removed when the reading
ends.

**VOICE-021 — Drawings follow the voice.** When an answer contains a drawing whose parts are referred to in the
text, the parts appear and are lit as the sentence that talks about them is spoken; the others fade back. A drawing
is put up when the reading reaches it (a diagram gets up to about two seconds to be drawn before the next piece
plays). When the reading ends, every part is shown and nothing stays lit. [model] — the answer has to contain
such references.

**VOICE-022 — Voice row while reading.** Below the Ask box, a row is shown only while an answer is being read (or
could not be): a status text, a **■ Stop** button, the **Voice** picker and the **Speed** picker. Status texts:
- before the first piece plays: "Getting the voice ready…"
- while playing: "Speaking…"
- browser refused to play (VOICE-048): "The browser blocked the voice: tap ▶ Play under the answer (once it's
  written) to hear it." (■ Stop is hidden in this state.)
When nothing is being read the row is hidden.

**VOICE-023 — Stop.** ■ Stop in the voice row ends the reading at once: audio stops, nothing further is spoken, the
answer shows whole, and the highlight goes. The answer itself is not affected (it keeps arriving if still being
written).

**VOICE-024 — Under an answer being read in Voice mode.** While a Voice-mode answer is still being read, the only
control under it is "■ Stop" (pressing it stops the reading). When the reading ends, the usual controls appear
(Copy, ▶ Play, and the "what next" links for the newest answer).

**VOICE-025 — Things that stop the reading.** Reading stops (as with Stop) when the student:
- asks a new question (any mode) — the new answer then starts its own reading in Voice mode;
- presses ▶ Play on an answer (that one is read instead);
- starts dictating (so the microphone does not hear the tutor);
- switches Text/Voice;
- starts a new chat;
- starts a practice exercise from the panel;
- closes the tutor panel;
- leaves the course's slides (goes home, to another course, notes, history, review, …).

**VOICE-026 — Things that do not stop the reading.** Reading continues when the student turns slides, opens
another deck of the same course (including by following a slide citation), switches the Read (wide reading)
view, or when the chat is redrawn for any other reason; the answer keeps its place, highlight and pacing.

**VOICE-027 — Following along.** While an answer is read, the part being spoken (or the drawing it describes) is
kept in view as long as the student has not scrolled away from it; scrolling back to it resumes following.

## 4. ▶ Play on a finished answer

**VOICE-028 — ▶ Play under every answer.** Every finished tutor answer has a "▶ Play" control ("Read this answer
aloud"), in both Text and Voice modes, including answers from earlier sessions.

**VOICE-029 — ▶ Play reads the whole answer** from the start, with the highlight (VOICE-020) and drawing
following (VOICE-021); the text is already fully visible and does not re-appear. Its label changes to "■ Stop"
while it reads; pressing it again stops (VOICE-023). When reading ends the label returns to "▶ Play".

**VOICE-030 — One reading at a time.** Pressing ▶ Play on another answer stops the current reading first. Only
one answer's drawing is lit at a time.

**VOICE-031 — ▶ Play survives redraws.** If the chat is redrawn while an answer is being played, its control still
shows "■ Stop" and still stops it.

**VOICE-032 — ▶ Play when voice fails** shows "Voice isn't available right now." every time it fails (unlike the
once-only message of VOICE-016), and the control returns to "▶ Play".

## 5. What is said (spoken text rules)

The tutor writes Markdown with maths, tables and drawings; what is spoken is a speakable version of it.

**VOICE-033 — Spoken lines replace visuals.** The tutor may put an invisible spoken line directly above a table,
formula, block of working, code block or drawing. When reading aloud, that line is said *instead of* the block
under it, and the whole block is highlighted while it is said. Spoken lines are never shown, copied or printed.

**VOICE-034 — Visuals without a spoken line are summarised, never read out.**
- a table → "Have a look at the table."
- a display formula → "The formula's on screen."
- a code block → "The code's on screen."
- two or more lines of worked arithmetic → "The working's on screen."
- a drawing (diagram, SVG, plot) → nothing is said.
- inline maths longer than about 12 characters → "the formula on screen" within its sentence.

**VOICE-035 — Short maths is said in words.** Simple notation is turned into words: a fraction "a over b", "squared"
for a power of two, "to the" for other powers, and common symbols ("times", "at most", "at least", "not equal
to", "about", "infinity", "root of", "plus or minus"). Formatting commands are dropped.

**VOICE-036 — Things never spoken:** hidden answers (collapsed spoilers / details), hidden notes for the hub,
drawing-part references, slide citations (e.g. "[S&D-2 s14]"), link addresses (the link text is said), Markdown
symbols (headings, bullets, emphasis, table bars, back-ticks), HTML tags.

**VOICE-037 — Marked terms are read as plain words** (the term's text, without its markers).

**VOICE-038 — Abbreviations do not end a sentence** ("e.g.", "i.e.", "vs.", "etc.", "Dr.", "Fig."), so a piece is
never cut just after them.

**VOICE-039 — Very long pieces are split**, so no single piece is over about 1,000 characters; a long run without
any sentence end is cut at a comma/semicolon/colon or a space.

**VOICE-040 — Parts referred to are split at their sentences**, so each drawing-part reference lands exactly when
its sentence is spoken.

## 6. Voice and speed

**VOICE-041 — Voice picker.** Six voices are offered: Heart (US, female) — the default — Bella (US, female),
Michael (US, male), Fenrir (US, male), Emma (UK, female), George (UK, male). The picker is shown only once the
voice is ready (its list comes from the hub). The choice is remembered on this browser.

**VOICE-042 — Speed picker.** Speeds offered: 0.85×, 1×, 1.1×, 1.2×, 1.35×; default 1×. Remembered on this
browser.

**VOICE-043 — A change applies to the next piece.** Changing voice or speed during a reading takes effect from the
next piece prepared; nothing is restarted. Pieces already prepared keep the old voice/speed.

**VOICE-044 — Pickers are only reachable while reading.** Both pickers live in the voice row, which is visible only
while an answer is being read (VOICE-022). There is no way to choose a voice or speed before hearing an answer.
(Current behaviour, recorded as found.)

**VOICE-045 — Out-of-range settings are made safe.** An unknown voice falls back to the default voice; a speed is
kept between 0.6× and 1.6× (anything unusable becomes 1×).

## 7. Read-aloud failures

**VOICE-046 — Voice fails during a Voice-mode answer:** the reading stops, the answer shows whole, and "Voice
isn't available; showing the answer without it." is shown (once, VOICE-016). Voice is then treated as unavailable.

**VOICE-047 — Voice fails during ▶ Play:** "Voice isn't available right now." (VOICE-032).

**VOICE-048 — The browser blocks playback** (no recent tap, strict autoplay rules): the reading stops, the answer
shows whole, and the voice row shows the "browser blocked the voice" message (VOICE-022) until the next reading or
Stop. The page tries to prevent this by unlocking audio during the tap that sends a question. [real-device]

**VOICE-049 — An answer that fails to arrive** (tutor error) also ends its reading; the error is shown in the
chat in place of the answer.

**VOICE-050 — Pacing gives up safely.** If the saved answer differs from what streamed in, the whole answer is
shown at once and the reading carries on with the remainder.

**VOICE-051 — An empty piece is never sent for speech** (e.g. a piece that was only a drawing).

## 8. Dictation into the Ask box

**VOICE-052 — Mic button.** Next to the Ask box (in the open tutor panel and in the ask bar under the slide when
the panel is closed) is a microphone button, accessible name "Dictate", tooltip "Dictate: speak your question,
then edit it before sending (hold Space, or Ctrl+Space)". It is present only when the browser can record
(VOICE-077).

**VOICE-053 — Tap to start listening.** Pressing it starts recording:
- the button shows "■", is marked pressed, and looks "recording" (pulsing red); its tooltip becomes "Stop and type
  out what you said (Ctrl+Space)";
- the Ask box becomes read-only and its placeholder reads "Listening… tap ■ or Ctrl+Space to stop" (or
  "Listening… let go of Space to stop" when started by holding Space);
- any reading aloud stops (VOICE-025).
The browser's microphone permission prompt appears on first use. [real-device]

**VOICE-054 — Tap again to stop.** Pressing ■ stops recording; the button shows "…", is disabled, its tooltip and
the box's placeholder read "Writing down what you said…" until the words are ready.

**VOICE-055 — Words go into the box, not to the tutor.** What was heard is inserted into the Ask box where the
cursor was when dictation started (replacing any selected text), with a space added on either side where needed,
the cursor placed after it, and the box focused. Nothing is sent: the student checks/edits and presses Ask. The
existing text before and after stays untouched. [model] for the words themselves.

**VOICE-056 — Nothing heard.** If nothing could be written down (silence, too short, under about 0.3 s), the box
goes back to what it was and "Didn't catch that. Tap 🎙 and try again." is shown.

**VOICE-057 — Errors while writing down** show the hub's message (e.g. "The recording was empty or damaged. Try
again.", a missing-software message, "The hub isn't responding…") and leave the box as it was.

**VOICE-058 — Course words are heard correctly.** Speech recognition is primed with the open deck's title and the
current slide's title (with Whole deck selected, the titles of the deck's slides), so course terms are
recognised. [model]

**VOICE-059 — Tapping ■ before the microphone has started** cancels the dictation quietly (nothing is written,
no message).

**VOICE-060 — Two-minute limit.** A recording stops by itself after 2 minutes and is written down as if Stop had
been pressed.

**VOICE-061 — Microphone lost.** If the microphone stops during recording (unplugged, permission revoked), it is
treated as Stop: what was recorded so far is written down. [real-device]

**VOICE-062 — Sending while listening** drops the recording: pressing Ask (or Enter) while listening sends what is
in the box at that moment and stops the microphone; nothing more is written down.

**VOICE-063 — Hold-to-talk with Space.** With a deck open:
- outside any text field, holding Space for about 0.3 s starts dictation; letting go stops it and writes the
  words down. A quick tap of Space keeps its normal effect (presses the focused button, or scrolls the chat/page;
  Shift+Space scrolls up);
- inside the Ask box, the first press types a space as usual; if the key is held (auto-repeat), that space is
  removed and dictation starts; letting go stops it;
- in other text fields Space always types a space;
- while listening after a tap on the mic, a Space press stops it.
If the tutor panel is closed, the dictation goes into the ask bar's box.

**VOICE-064 — Ctrl+Space anywhere** (including inside the Ask box) with a deck open: a quick press starts
dictation and a second press stops it; holding it (more than ~0.4 s) and letting go stops on release. If no Ask
box with a mic is on screen, the tutor panel is opened first.

**VOICE-065 — No shortcuts without a deck or without recording support.** With no deck open, or when the browser
cannot record, Space and Ctrl+Space do nothing voice-related (Space behaves normally).

**VOICE-066 — A redraw mid-dictation keeps the state.** If the panel or box is redrawn while listening or writing
down, the new box shows the same text, read-only, with the same placeholder, and the mic button the same state.

## 9. Writing down while you talk (streaming) and the fallback

**VOICE-067 — Short wait after Stop.** While the student speaks, the recording is sent to the hub in small parts
and written down at natural pauses (or every ~12 s at most), so after Stop only the last few seconds remain to be
written down. [model] for the cut positions.

**VOICE-068 — Live preview (optional).** The ⋯ menu has a checkbox "Show words while dictating" (off by default,
remembered on this browser). When on, the words written down so far appear in the Ask box while still listening,
between the text that was before and after the cursor; the box stays read-only. A preview never reaches other
devices' copy of the box, and a cancelled dictation removes it. When off, the box does not change until Stop.

**VOICE-069 — Written once.** Audio already written down is not written down again; the final text is the parts
in order, joined by spaces. Each part is primed with the course words and the last few words already written, so
a word split across a pause is still heard correctly. [model]

**VOICE-070 — Fallback to the whole recording.** If streaming fails at any point (the hub does not answer the
start within ~8 s, a part is rejected or not answered within ~8 s, the session expired, writing down failed or
took too long), recording still continues; on Stop the complete recording is sent in one go and written down. The
student sees no difference other than possibly a longer wait.

**VOICE-071 — Time limit on finishing.** The page waits for the streamed result up to 15 s plus 0.1 s per second
recorded; past that it uses the fallback (VOICE-070).

**VOICE-072 — Server-side limits on a dictation session.** A session accepts at most ~130 s of audio; parts must
arrive in order; a part over 1 MB is refused; a finished or cancelled session accepts nothing more; a session that
received nothing for 30 s is discarded when the next dictation starts. A refused part triggers the fallback
(VOICE-070), not an error message.

## 10. Cancelling a dictation

**VOICE-073 — Leaving cancels.** A dictation in progress (listening or writing down) is cancelled — microphone
off, nothing more written down on the hub, the box restored to what it was before, no message — when the student:
- opens another deck (of any course) or any other page (home, course page, notes, history, review…);
- closes the tutor panel;
- starts a new chat;
- starts a practice exercise from the panel.
Turning slides within the same deck does **not** cancel it.

**VOICE-074 — A result that arrives too late is dropped.** If the words come back after the student left the deck,
they are not inserted anywhere.

**VOICE-075 — Cancelled start.** If the dictation is cancelled before the hub has opened its session, the session
is closed as soon as it opens; if the microphone is granted after cancelling, it is released immediately.

**VOICE-076 — Microphone released.** After stopping, cancelling or failing, the microphone is released (the
browser's recording indicator goes off). [real-device]

## 11. When recording is not possible

**VOICE-077 — Unsupported or insecure page: no mic.** The mic button and the dictation shortcuts are absent when
the browser cannot record: no microphone API, no audio-processing support, or the page is not opened securely
(e.g. over a plain Wi-Fi address instead of localhost or the secure link). Everything else works.

**VOICE-078 — Microphone permission denied.** If the student (or the browser) refuses the microphone, dictation is
cancelled, the box is restored and "The microphone is blocked: allow it from the site settings." is shown.

**VOICE-079 — Recording cannot start.** If the browser cannot set up recording (audio processing unavailable or
failing to load), dictation is cancelled and "This browser couldn't start recording. Try Chrome or Edge." is
shown.

## 12. Spoken questions: marking and memory

**VOICE-080 — A dictated question is marked.** A question sent with dictated words in it (even if edited, even if
only partly dictated) is shown in the chat with a microphone mark "🎙 " before it — immediately, after reload, in
history, and on other devices watching the chat. Clearing the box completely removes the dictated status; a typed
question never has the mark.

**VOICE-081 — Dictated status follows the draft.** The "dictated" status travels with the Ask box's shared draft,
so a question dictated on one device and sent from another is still marked (handoff: live sync).

**VOICE-082 — A dictated question is answered like a typed one.** The tutor uses its normal written-answer style
for it (Markdown, maths, drawings, spoken lines for visuals); reading aloud is decided only by the Text/Voice
switch.

**VOICE-083 — The tutor remembers spoken questions.** After a dictated question (asked as an ordinary question) is
answered, the tutor's private notes on the student for that course are updated in the background: questions they
keep asking (with counts and dates), mistakes the tutor corrected, things still shaky, and anything the student
said about themselves. The note-taker is told the question came through speech recognition, so misheard words are
ignored. Typed questions do not update these notes (grill answers do — handoff). [model]

**VOICE-084 — The notes are the student's.** The notes appear on the course page under "Voice tutor: What your
tutor remembers" once they exist, and can be edited. If the student edits them while an update is being made,
their edit wins and the update is discarded. An update that is malformed (missing any of the four sections:
About me; Questions I keep asking; Mistakes I've corrected; Still shaky) is retried once and otherwise discarded.
Failure to update never affects the answer.

## 13. The spoken-question style (former Talk tab; hub only)

The hub still accepts a "spoken question" request (what the Talk tab used to send). No control in the current
interface sends it; these requirements describe the behaviour it still has.

**VOICE-085 — Spoken-question answers are written to be heard** [model]:
- the first sentence answers the question; no preamble, no "Great question";
- plain spoken sentences only — no Markdown, bullets, headings, tables, code, emoji, marked terms or symbols;
- maths said aloud ("x squared plus two x"), no formulas, Greek letters or notation;
- slides referred to as "on slide 14" / "in the elasticity deck"; no textbook or web citations unless asked;
- short: about 60–120 spoken words, one idea at a time, offering the next step if more is needed;
- usually ends with one short thinking question (never "Does that make sense?") unless a fact was asked for;
- a long request (e.g. a full proof) gets the spoken gist and a pointer to typing the question instead;
- wrong statements are corrected kindly and plainly, with the reason.

**VOICE-086 — Mishearing tolerance.** The tutor is told the question came from speech recognition, reads it in the
light of the slides, and asks one short question back if it really cannot tell what was meant. [model]

**VOICE-087 — At most one drawing, early.** A spoken answer draws only when asked to show something or when the
answer is about steps or a structure (not for a "why" question): one drawing, placed right after the first
sentence, tall-and-narrow, a flowchart of at most 10 nodes or a small SVG, its parts revealed as the sentences
naming them are spoken (VOICE-021). A follow-up about the drawing already on screen refers to its parts instead of
drawing again. [model]

**VOICE-088 — Uses what it knows about the student.** The tutor's notes on the student (VOICE-083) and the weak
topics / error log from the student's progress file are given with every spoken question; when the notes show
the question was asked or got wrong before, the answer says so briefly and tries a different angle. [model]

**VOICE-089 — Where the student is.** A spoken question is about the current slide (named with its deck and
title), or, with Whole deck selected, about the whole deck (named with its title and slide range).

**VOICE-090 — The style can be tuned without a restart.** The spoken-answer instructions are read afresh for every
spoken question; editor comments in them are never sent to the tutor.

**VOICE-091 — Spoken questions are kept in the course chat** like any other question, marked with the microphone
mark (VOICE-080), and update the tutor's notes afterwards (VOICE-083).

**VOICE-092 — An empty spoken question is refused** with "Type a question first."

## 14. What persists

**VOICE-093 — Remembered on this browser:** Text/Voice choice; chosen voice; speed; "Show words while dictating".

**VOICE-094 — Saved with the chat:** whether each question was dictated (the 🎙 mark).

**VOICE-095 — Saved in the course:** the tutor's notes on the student (VOICE-083/084).

**VOICE-096 — Never saved:** recordings, partial dictation text, synthesised speech. Every ▶ Play prepares the
speech again. Reloading during a dictation loses it; reloading during a reading stops it.

**VOICE-097 — Saved on the computer once:** the downloaded speech models (outside the study library).

## 15. Untestable or only partly testable

- Quality of recognition, voice naturalness, timing of real models, model download (VOICE-003, 018, 058, 067,
  069) — [model]/[real-device].
- Tutor obeying the spoken style, drawing rules and memory use (VOICE-083–088) — [model]; only the instructions
  given and the shape of the result can be checked.
- Real autoplay blocking, real permission prompts, unplugging a microphone, OS recording indicator (VOICE-048,
  053, 061, 076) — [real-device]; partly simulable.
