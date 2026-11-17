# Practice by topic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A whole-deck "Practice by topic" mode that walks a deck topic by topic in one fixed format, advancing on "done".

**Architecture:** Two new tutor modes (`practice`, `practice_reply`) in `tutor.py`, modelled on Exam drill: the
opening turn starts its own chat and emits a hidden plan line the hub stores on `chat["practice"]`; each "done"
turn is told exactly which topic comes next. `server.py` accepts the modes; `static/app.js` adds the button, the
`/practice` command and reply routing.

**Tech Stack:** Python 3.12 stdlib (server, tutor), vanilla JS (static/app.js). Tests: plain scripts in `tests/`.

**Spec:** `docs/superpowers/specs/2026-11-16-practice-by-topic-design.md`

## Global Constraints
- Name "Practice by topic"; command `/practice`; chat title `Practice by topic · <tag>`.
- Always the whole open deck; always its own new chat; web off for every practice turn.
- Output format is the spec's "The format" section, verbatim in the prompt, with problem (f2) from the CP-610 chat as the exemplar.
- No commits unless the user asks (user's global rule).

## Review Focus
- "Done" written loosely ("Done.", "done!", "next", "next topic", " DONE ") must advance; "done with step 2 but why…" must not. → Task 1 tests.
- "done" after the last topic must not invent Topic k+1. → Task 1 test.
- Plan line missing or broken JSON: the turn still saves, the text shows no raw `<!--practice`. → Task 1 test.
- Opening another deck mid-session must not change the practice chat's system prompt. → Task 1 test.
- A normal Ask typed while a practice is open in the panel goes as `practice_reply`, not a new chat. → Task 3 manual check.

---

### Task 1: Practice modes in tutor.py

**Files:**
- Modify: `tutor.py` (new block after the drill section, ~line 835; `chat_system`; `chat_turn`; `MODE_LABELS`)
- Test: `tests/test_practice.py` (new, plain-script style like `tests/test_drafts.py`, with `run_model` patched)

**Interfaces:**
- Produces:
  - `PRACTICE_MODES = {"practice", "practice_reply"}`
  - `PRACTICE_TAG` regex for `<!--practice {...}-->`
  - `is_done(text: str) -> bool`
  - `_practice_record(chat: dict, text: str) -> str` (stores topics on first turn, strips tag)
  - `_practice_prompt(cdir, chat, mode, question) -> str`
  - `chat_turn(..., mode="practice")` creates a new chat with `chat["practice"] = {"deck": tag, "topics": [], "at": 0, "started": now}`; forces `web=False`.
  - `chat_system` returns `system_prompt(cdir, chat["practice"]["deck"], False)` for a practice chat.

- [ ] **Step 1: Write failing tests** in `tests/test_practice.py`:
  - `is_done`: True for "done", "Done.", " DONE ", "done!", "next", "next topic"; False for "done with step 2, but why divide by n?", "", "not done".
  - `_practice_record` with text `"…\n<!--practice {\"topics\":[{\"name\":\"Overview\",\"slides\":\"s2–s5\",\"problems\":[]},{\"name\":\"Text Foundations\",\"slides\":\"s7–s12\",\"problems\":[\"(a) BPE, s9\"]}]}-->\n"` → returns text without `<!--practice`, chat topics has 2 entries, `at == 0`.
  - Broken JSON tag → tag stripped, topics stay `[]`, no exception.
  - `_practice_prompt(..., "practice_reply", "done")` with at=0 of 2 topics → contains "Topic 1: Text Foundations", "s7–s12", "(a) BPE, s9"; and after the turn `at == 1`.
  - At the last topic, "done" prompt contains "every topic" close instruction and no "Topic 2".
  - Non-done question prompt contains "don't move on" and the current topic name; `at` unchanged.
  - `chat_turn` end-to-end on the demo library (`example-library`, copied to a temp dir; `run_model` patched to return a fixed text with a plan tag): mode "practice" creates a new chat (≠ previous current chat), title starts "Practice by topic · ", saved message text has no tag, `web` passed to run_model is False; `chat_system` for that chat equals `system_prompt(cdir, "<practice deck>", False)` even when called with another tag.

- [ ] **Step 2: Run** `python tests/test_practice.py` — expected: fails (names undefined).

- [ ] **Step 3: Implement** in `tutor.py`:
  - `PRACTICE_FORMAT`: the spec's format, verbatim, plus exemplar problem (f2) from `library/CP-610_Data_Analysis/me/chats/396b80eaf39c.json` message 23 (generic: slide tag written as `[<TAG> sN]`).
  - `PRACTICE_RULES`: slides only; every row/problem slide-tagged; each worked example on a slide is its own problem (two on one slide → (a), (a2)); none skipped; "Your turn" uses only slide formulas, same structure, new numbers; hidden answer shows every step.
  - `PRACTICE_PROMPTS["practice"]`: make the plan for `{deck}`, then Topic 0/1 in the format, end with the hidden line `<!--practice {"topics":[{"name","slides","problems":[...]}]}-->` (exactly one, valid JSON).
  - `PRACTICE_PROMPTS["practice_reply"]` for done → "Now Topic {k}: {name}, slides {slides}, problems {list}" or the last-topic close; for anything else → answer inside the current topic, don't move on, end with the "Say **done**" line. Each includes a short format reminder.
  - Advance `at` only after a successful done turn is saved (inside the save lock); record in `chat_turn` next to `_drill_record`.
  - `MODE_LABELS["practice"] = "Practice by topic"`; `practice_reply` label is the student's words (add to `QUESTION_MODES`).
  - Unknown-mode check in `chat_turn` accepts `PRACTICE_MODES`; `practice_reply` without `chat.practice` → `TutorError("No practice is running in this chat. Start one with Practice by topic.", 400)`.

- [ ] **Step 4: Run** `python tests/test_practice.py` — expected: all `ok`, exit 0. Also `python tests/test_layout.py` still passes.

### Task 2: Server accepts the modes

**Files:** Modify `server.py:459-497` (`/api/tutor`).

**Interfaces:** Consumes Task 1's `chat_turn`. Produces: response JSON adds `"practice": chat.get("practice")`.

- [ ] **Step 1: Add test** to `tests/test_practice.py`: POST `/api/tutor` with mode `practice_reply` and empty question → 400 "Type a question first."
- [ ] **Step 2: Implement:** add `"practice_reply"` to the empty-question check; include `practice` in the returned dict.
- [ ] **Step 3: Run** `python tests/test_practice.py` — expected: pass.

### Task 3: The app: button, command, reply routing

**Files:** Modify `static/app.js` (panel links ~line 955, `SLASH` ~1519, `MODE_LABEL` ~1553, `askText`, `replyMode`/`composeHint` ~1577, `tutorAsk` ~2344 and ~2433, chat bar ~896, message foot ~1670).

**Interfaces:** Consumes `r.practice` from Task 2.

- [ ] **Step 1: Implement:**
  - Button "Practice by topic" (title: "Topic by topic through the whole deck: the concepts, then every problem solved with one for you to try") → `tutorAsk("practice")`.
  - `SLASH`: `{ cmd: "practice", mode: "practice", hint: "Practice by topic · whole deck" }`.
  - `MODE_LABEL.practice = "Practice by topic"`; `askText` treats `practice_reply` like `grill_reply`.
  - `PRACTICE_MODES = ["practice", "practice_reply"]`; `practicing()` like `drilling()` using `chat.practice`; `replyMode` → `"practice_reply"`; `composeHint` → `"done, or ask about this topic"`.
  - `tutorAsk`: `practice` starts its own chat (same branch as drill); store `r.practice` on the chat.
  - Chat bar: `Topic {at+1} of {topics.length}` when `chat.practice`. Foot under the last practice answer: a "Done › next topic" link sending `tutorAsk("practice_reply", "done")`, hidden after the last topic.
- [ ] **Step 2: Verify** with `node --check static/app.js` — expected: no output.
- [ ] **Step 3: Verify in the browser** (`tests/verify/browser_smoke.py`-style Playwright script in `.agentTempWork`): on the demo library the button and `/practice` appear; with the tutor stubbed, a practice turn opens a new chat and the hint reads "done, or ask about this topic".

### Task 4: Live check of the format

- [ ] **Step 1:** `.agentTempWork/practice_live.py`: run `chat_turn` for real on CP-610 `Ch4` (practice, done, a question, done) and on one CP-600 deck (practice, done), saving outputs.
- [ ] **Step 2:** A checker in the same script asserts per answer: `#### Topic k · … concepts` heading, table header `| # | Question | Answer | Slide |`, every problem has `**Q:**`, `**Your turn:**`, `<details><summary>Answer</summary>`, a slide tag, and the "Say **done**" last line; the question turn kept the topic number. Expected: all pass on both decks. Delete the test chats afterwards.
