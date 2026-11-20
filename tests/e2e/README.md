# Tutr end-to-end workflow suite

The behavioural baseline for the rewrite. Every user-facing workflow of the app is pinned here as a Playwright test,
and described in plain language in [`docs/functional-spec/`](../../docs/functional-spec/). When the app is rebuilt,
this suite should pass against the new code unchanged; a failing test means a workflow was lost or changed.

## Running

```
cd tests/e2e
npm install                 # once
npx playwright test         # everything (desktop + mobile projects)
npx playwright test specs/02-tutor            # one area
npx playwright test --headed --workers 1      # watch it
npm run report              # the HTML report of the last run
```

Needs Python 3.12 with the app's requirements (the hub runs for real) and Node 22. Chromium comes with Playwright
(`npx playwright install chromium` if it's missing). Set `PYTHON` to use another interpreter.

Each test starts **its own hub** on a fresh copy of a library under `.runs/hubs/` (kept when the test fails, deleted
when it passes), so tests never share state and never touch your real library, `.cache/` or a running Tutr.

## Layout

| Path | What |
|---|---|
| `specs/NN-area/*.spec.ts` | the workflows, one folder per area of the functional spec; test titles start with the requirement ID they pin (`NAV-003 ...`) |
| `fixtures/hub.ts` | the `hub` fixture: starts the hub, scripts the model double, reads the library on disk |
| `harness/fake_hub.py` | the launcher: the hub with the AI model and speech models replaced by doubles |
| `libraries/` | extra fixture libraries (the default is the repo's `example-library/`) |

## The test double contract

The suite is black-box: it talks to the app only through the browser, over HTTP, and by reading/writing the library
folder (whose format, `docs/library-format.md`, is part of the product). The **one** exception is
`harness/fake_hub.py`, which starts the app with its outside dependencies replaced. **A rewrite must provide an
equivalent launcher**; nothing else in the suite needs to change.

The launcher is run as

```
python harness/fake_hub.py --library <library folder> --work <scratch folder> [--phone-url <url>] [--port <n>]
```

(or any executable named by `TUTR_E2E_LAUNCHER`, taking the same arguments) and must:

1. Serve the app on `127.0.0.1` on a free port (or `--port`, when given) and write the port number to `<work>/port` once it accepts
   connections.
2. Read the library from `--library`, and keep every other file it writes (logs, usage history, caches) inside
   `<work>`.
3. Never call a real AI model. Every model call is answered from `<work>/model-script.json`, re-read on every call:

   ```json
   {"rules": [
     {"match": {"label": "^chat:explain$", "prompt": "regex on the prompt", "system": "regex on the system prompt"},
      "times": 1,
      "reply": {"text": "Markdown answer", "json": {"...": "structured output"}, "status": ["Reading the slide"],
                "chunks": ["streamed ", "in pieces"], "chunk_delay_ms": 50, "wait_for": "release-name",
                "error": "message (the call fails)", "error_status": 502, "cost": 0.01, "ms": 1200,
                "tokens": {"in": 1000, "cache_read": 0, "cache_write": 0, "out": 300}}}
   ]}
   ```

   The first rule whose `match` fields all match (and that still has `times` left) answers. With no matching rule:
   text `Fake answer <n> for <label>.\n\nFAKE-END` (n counts the calls, so no two answers are alike: the app drops
   an answer identical in text and duration to one already shown), a duration of `1000 + n` ms, and for structured calls an object with every schema property filled
   (strings `Fake <name>.`, booleans `true` except `unreadable`, enums their first value, arrays of
   `minItems` strings). `wait_for: name` holds the reply until the file `<work>/release-<name>` exists (before any status line);
   `wait_after_status: name` holds it after the status lines are shown. `error_after_text` streams the text, then
   fails with that message. `crash: true` fails with an unexpected (non-model) error. `stream_json_text: true`
   also streams the text of a structured call. Streaming
   calls emit each `status` line, then the text in `chunks` (default: line by line).
4. Log every model call as one JSON line in `<work>/model-calls.jsonl`:
   `{label, model, schema, web, session, fork, chat_key, course, prompt, system}`.
   **Labels** (what the call is for) are part of the contract the tests match on:
   `chat:<mode>` (a tutor turn; mode such as `explain`, `example`, `ask`, `grill_deck`, `drill`, `practice`, ...),
   `side` (a side question), `practice:<kind>` (generating a practice problem), `check` (marking an answer),
   `memory` (updating the tutor's notes about the student), `stt` (speech to text).
5. Report the speech models as downloaded and ready; answer speech-to-text from the script (label `stt`, reply
   `text`, or `error`); answer text-to-speech with a short silent WAV, logging each request as a JSON line
   `{text, voice, speed}` in `<work>/speak-calls.jsonl`.
6. Offer two extra OpenCode models in the model list: `opencode/fake-big` ("Fake Big") and `opencode/fake-small`
   ("Fake Small").
7. With `--phone-url`, show that URL as the "open on your phone" link.

## Writing a test

```ts
import { test, expect } from '../../fixtures/hub';

test('CHAT-004 an answer streams in and is kept in the chat', async ({ page, hub }) => {
  await hub.script([{ match: { label: '^chat:explain$' }, reply: { text: 'Prices **rise**.' } }]);
  await page.goto('/#c=Demo-Course&d=S%26D-1&s=1');
  // ... drive the UI by visible labels and roles ...
  expect(await hub.calls('^chat:explain$')).toHaveLength(1);
  expect(hub.list('me/chats')).toHaveLength(1);    // what was saved, in the library's data format
});
```

- Start from state on disk with `test.use({ seed: seedWith((hub) => hub.write('Demo-Course/me/...', '...')) })`
  (`seedWith` from `fixtures/hub.ts`; a bare function in `test.use` is taken by Playwright for a fixture).
- Counters of scripted rules (`times`) start again after `hub.restart()`.
- `me/progress.md` and other files the hub writes have the platform's line endings: normalise `\r\n` before
  comparing.
- `hub.restart()` restarts the app on the same data (persistence across restarts); the port changes, so navigate
  with `hub.url + '/#...'` afterwards. `hub.restart({ samePort: true })` keeps the port, so open pages reconnect.
- Prefer visible text, roles and labels over CSS classes: the rewrite will change the markup, not the words.
  Where a test can only find something by a class or id, it says so in a comment, so the rewrite knows to keep a
  hook or update that one locator.
