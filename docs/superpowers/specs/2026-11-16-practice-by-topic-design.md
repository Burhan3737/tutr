# Practice by topic — design

## Intent
A whole-deck exam-prep mode that walks a deck topic by topic: first every concept question the slides answer,
then every numerical problem the slides work, each solved on the page and followed by a similar one for the
student with a hidden worked answer. The format is the one reached by hand in the CP-610 chat "ch 4 mid2 prep"
(`me/chats/396b80eaf39c.json`, messages 19–27). It must come out the same every time, in any course.

## Goals
- One fixed output format (below), every turn, every deck, every course.
- Nothing outside the slides; every item carries its slide tag; no worked example on a slide is missed.
- The student types **done** to move to the next topic; anything else is answered inside the current topic.

## Non-goals
- No marking of the student's answers (they check against the hidden answer themselves).
- No multi-deck range (Exam drill covers that).

## Anti-goals
- A format that drifts between turns or decks (headings, columns, problem layout changing).
- Topics skipped, repeated, or problems from the plan silently dropped.
- Formulas or facts from outside the slides.

## Approaches considered
1. **Prompt template + exemplar, plan kept by the hub (chosen).** The template and one real problem from the
   chat go into the prompt verbatim; turn 1 emits a hidden plan line that the hub stores on the chat, and each
   "done" turn is told exactly which topic, slides and problems come next. Keeps streaming, [[terms]], [say: …].
2. Structured JSON output rendered by the app: rigid layout, but loses streaming, terms and narration; much more
   work. Fallback only if (1) still drifts.
3. Prompt only, model remembers the plan: cheapest, but long decks drift and skip topics.

## Decided
- Name **Practice by topic**, command `/practice`, button in the tutor panel beside Grill me / Exam drill.
- Always the whole open deck. Starts **its own chat** (like Exam drill), titled `Practice by topic · <tag>`.
- Slides only: the turn runs with web off whatever the toggle says.

## The format (verbatim in the prompt)
Turn 1: one line, then the plan table `| # | Topic | Slides | Numerical problems | Concept / MCQ areas |`
(problems listed as `(a) name, sN`; *formula only* where the slide gives only a formula), then the first topic.

Each topic:
1. `#### Topic k · <Name>: concepts`, a [say: …] line, the table `| # | Question | Answer | Slide |`, rows k.1, k.2…
   (topics with no problems stop here).
2. `---`, `#### Topic k · problems`, then per problem, separated by `---`:
   - `**Problem (<id>): <name>** [<TAG> sN]`
   - `**Q:**` the full question with every given value; numbered parts.
   - Numbered bold steps: formula first, then substitution; one-line idea note; final result bold.
   - `**Your turn:**` a similar problem: same structure, new numbers, only slide formulas.
   - `<details><summary>Answer</summary>` … every step, same shape … `</details>`
3. Last line: `Say **done** when you've finished, and we'll move on to Topic k+1: <Name>.` (or, after the last
   topic, a one-line close).

## How it works
- `chat["practice"] = {"deck", "topics": [{"name","slides","problems":[…]}], "at": <index of topic shown>, "started"}`.
- Turn 1 (`practice`) ends with a hidden `<!--practice {"topics": [...]}-->` line; the hub strips it and stores
  the topics; `at` = 0.
- `practice_reply`: the student's words. If they're a "done" (done / next / next topic, any case or punctuation),
  the hub advances `at` and the prompt names the topic exactly (name, slides, problem list). Otherwise the prompt
  says: answer within Topic `at`, don't move on, end with the "Say **done**" line.
- After the last topic, "done" gets a short close and the session is over.
- The system prompt is pinned to the practice deck, so opening another deck doesn't change it.
- Unreadable plan line: logged; later turns fall back to "the next topic of your plan".

## Left to the builder
Exact wording of prompts beyond the template; chat-bar status text ("Topic 3 of 6"); foot button wording.
