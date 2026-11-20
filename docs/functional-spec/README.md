# Functional specification: Tutr as it behaves today

What the app does, written as a user (or someone watching the screen and the library folder) sees it, with no
reference to how the code is built. It is the baseline for the rewrite: the new app should do everything here, and
the end-to-end suite in [`tests/e2e/`](../../tests/e2e/README.md) checks it. Each requirement has a stable ID; each
test's title starts with the ID(s) it pins, so a failing test points straight at the requirement it guards.

| Document | Area | IDs | Requirements |
|---|---|---|---|
| [01-navigation-and-library.md](01-navigation-and-library.md) | the library on disk, home, course page, deck viewer, notes, search, the ⋯ menu (Usage, model, phone link), layout, errors, start-up | `NAV` | 83 |
| [02-tutor-and-chats.md](02-tutor-and-chats.md) | the tutor panel, streaming and errors, rendering (Markdown, maths, drawings), chats, side questions, photos, the live Ask-box draft and multi-device sync, the tutor's memory, model and sources | `TUT` `STR` `ERR` `REN` `DRW` `CHAT` `SIDE` `PHOTO` `DRAFT` `LIVE` `MEM` `MODEL` | 119 |
| [03-practice-reviews-drills.md](03-practice-reviews-drills.md) | practice problems, hints, marking, the review queue and its schedule, study sessions, the exam drill, Practice by topic, practice decks | `PRAC` `REV` `SESS` `DRILL` `TOPIC` `DECK` | 79 |
| [04-voice.md](04-voice.md) | Text / Voice answers, reading aloud, ▶ Play, dictation, spoken questions | `VOICE` | 97 |

The library's file format ([`docs/library-format.md`](../library-format.md)) is part of the contract too: the files
named in these documents (`course.json`, `deck.json`, `me/progress.md`, `me/chats/`, `me/practice/`,
`me/hub-state.json`, `me/drafts.json`, `me/tutor-memory.md`, `me/uploads/`, ...) are what the user owns and what
the rewrite must keep reading and writing compatibly.

## Conventions

- **[MODEL]** / **[model-dependent]**: the visible outcome depends on what the AI returns. Tests check how the app
  handles a scripted answer, not the quality of a real one.
- **Pinned as-is**: behaviour that is odd but is how the app works today. The tests hold it in place; change it in
  the rewrite only on purpose, and update the test and the requirement together.
- **Currently broken**: the requirement states the intended behaviour, which the current app fails. Its test is
  marked `test.fail(...)`: the suite stays green now, and the test reports "expected to fail, but passed" as soon as
  the rewrite fixes it — then remove the mark.

## Known defects in the current app

Found while mapping and testing (November 2026). Tests marked `test.fail` pin the intended behaviour; the others
are pinned as-is or noted only.

| Where | Defect | Test status |
|---|---|---|
| ⋯ menu → History | Does nothing (a script error): the History dialog was lost in the change that added the Usage panel. With it went the only on-screen way to delete a chat, see more than five earlier chats, or rename/star a chat that isn't the current one. | `test.fail` (NAV-092, CHAT) |
| Search box | Escape in the search box also closes the next open thing (⋯ menu, zoom, Text panel). | `test.fail` (NAV-079) |
| Unknown course in a deck link | `#c=<unknown>&d=<deck>` usually says "Unknown course." but about one time in ten "Unknown deck." (two requests race; the last error shown wins). | test accepts either (NAV-096) |
| Review page | "Your note from last time" never appears: the note isn't sent to the page. | `test.fail` (REV-015) |
| Exam drill over HTTP | A blank drill answer is accepted instead of refused (the UI never sends one). | `test.fail` (DRILL-007) |
| New chat during an answer | The answer is saved into the old chat; devices then show the old chat while no chat is current. | `test.fail` (CHAT) |
| Failed question | Its text isn't put back in the Ask box. | `test.fail` (ERR) |
| Side questions | A follow-up typed while the side answer streams is dropped; clicking **Read** closes an open side question (the R key doesn't). | `test.fail` (SIDE) |
| Error messages | Not shown in red as specified (ERR-001, LIVE-004, SIDE-008). | `test.fail` |
| Practice | After an unreadable photo, "Check again" brings back Check but not Hint. | pinned as-is (PRAC-033) |
| Exam drill setup | The default range comes from a starred older drill rather than the newest. | pinned as-is (DRILL-003) |
| Practice by topic | If the tutor's plan line can't be read, "done" never moves on and the session never ends. | pinned as-is (TOPIC-007) |
| Voice | The first question asked in Voice from the closed ask bar after loading isn't read aloud ("still loading"); after one speech failure Voice stays off silently until the panel is redrawn; the real reason voice is unavailable is never shown. | pinned as-is |
| `me/progress.md` | Viewing a slide for the first time rewrites it (adds the "Mistakes saved in the Study Hub" block); if the file ends with "## Error log" that block lands inside it and is then read as an error-log entry (and sent to the tutor). | pinned as-is |
| Dates | Deadline dates have no year, so around New Year a January date counts as past. | tests skip near New Year |
| Rendering | A drawing's named parts don't wait hidden until described (only the highlight follows); a drawing left unclosed at the end of an answer shows its source. Folding during/just after streaming is sometimes undone; a page reloaded mid-answer can show an empty chat. | noted (timing-dependent) |
| Misc | Home says "1 topics"; prefetched practice problems that are never used pile up in `me/practice/`; a lecture deck whose topic is literally "Practice" is listed as a practice deck; identical answers (same text and duration) are not shown twice. | pinned as-is |

## Not covered by end-to-end tests

Listed at the top of each spec file with the reason. In short: the quality of what the AI writes; the real
speech models (download, warm-up, voice quality); the hub's own start-up (port fallback, closing an older hub, the
Cloudflare tunnel, `--lan`); and things only visible as speed or animation (preloading, the pen drawing,
scroll-follow while reading).
