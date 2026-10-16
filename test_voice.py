"""Checks for the Talk (voice) feature. A plain script, no test framework:

    python test_voice.py              # everything (loads the speech models: ~10 s warm, longer the first time)
    python test_voice.py --no-models  # only the checks that need no models and no Claude

Nothing here calls Claude (run_claude is replaced) or touches a real course: chats, memory and state live in a
temporary folder.
"""
import asyncio, io, re, sys, tempfile, threading, time, types, wave
from pathlib import Path

import numpy as np

import library as L
import state as S
import tutor as T
import voice as V

FAILED = []


def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        FAILED.append(name)


class Patch:
    """Set attributes for the length of a with-block, then put them back."""
    def __init__(self, *triples):
        self.triples, self.old = triples, []

    def __enter__(self):
        for obj, name, value in self.triples:
            self.old.append((obj, name, getattr(obj, name)))
            setattr(obj, name, value)

    def __exit__(self, *exc):
        for obj, name, value in reversed(self.old):
            setattr(obj, name, value)


class SyncThread:
    """Runs remember()'s background work at once, so the test can look at the result."""
    def __init__(self, target, daemon=None):
        self.target = target

    def start(self):
        self.target()


# ---------------------------------------------------------------- voice_prompt()

def test_voice_prompt(tmp):
    cdir = tmp / "Course"
    (cdir / "study").mkdir(parents=True)
    f = tmp / "prompt.md"
    f.write_text("<!-- {question} in a comment is dropped -->\nQ: {question}\nW: {where}\nM: {memory}\n"
                 "X: {mistakes}\nBraces stay: {n} {} {{x}} {where_else}\n", encoding="utf-8")
    with Patch((T, "VOICE_PROMPT", f)):
        p = T.voice_prompt(cdir, "[S&D-2 s3]", "what is {n} here?")
    check("voice_prompt: fill-ins replaced", "Q: what is {n} here?" in p and "W: [S&D-2 s3]" in p, p)
    check("voice_prompt: other braces left alone", "Braces stay: {n} {} {{x}} {where_else}" in p, p)
    check("voice_prompt: comments removed", "<!--" not in p and "in a comment" not in p, p)
    check("voice_prompt: no memory file -> placeholder", "M: (nothing yet: this is a new student)" in p, p)
    check("voice_prompt: no progress.md -> placeholder", "X: (none recorded yet)" in p, p)
    T.memory_file(cdir).write_text(T.MEMORY_HEAD + "## About me\n- likes pictures\n", encoding="utf-8")
    with Patch((T, "VOICE_PROMPT", f)):
        p = T.voice_prompt(cdir, "[S&D-2 s3]", "q")
    check("voice_prompt: memory filled in without its title", "M: ## About me\n- likes pictures" in p
          and T.MEMORY_TITLE not in p, p)
    real = T.voice_prompt(cdir, "[S&D-2 s3]", "q")         # the real file: every placeholder is filled
    check("voice_prompt.md: no placeholder left", not re.search(r"\{(where|question|memory|mistakes)\}", real))


# ---------------------------------------------------------------- memory_text()

def test_memory_text(tmp):
    cdir = tmp / "Mem"
    (cdir / "study").mkdir(parents=True)
    f = T.memory_file(cdir)
    check("memory_text: no file -> empty", T.memory_text(cdir) == "")
    f.write_text(T.MEMORY_HEAD + "## About me\n- x\n### a sub-heading\n## Still shaky\n- y\n", encoding="utf-8")
    check("memory_text: header and intro dropped", T.memory_text(cdir).startswith("## About me"), T.memory_text(cdir))
    f.write_text(T.MEMORY_TITLE + "\n\nIntro with ## inside it and\n### Student's own heading\n- z\n## About me\n- x\n",
                 encoding="utf-8")
    got = T.memory_text(cdir)
    check("memory_text: '### ' and a mid-line '## ' aren't the first section", got.startswith("## About me"), got)
    f.write_text("## About me\n- no title: kept whole\n", encoding="utf-8")
    check("memory_text: file without the title kept whole", T.memory_text(cdir).startswith("## About me\n- no title"))
    f.write_bytes(T.MEMORY_HEAD.encode("utf-8") + b"## About me\n- bad byte \xff here\n")
    check("memory_text: invalid UTF-8 doesn't raise", "bad byte" in T.memory_text(cdir))


def test_remember(tmp):
    cdir = tmp / "Rem"
    (cdir / "study").mkdir(parents=True)
    f = T.memory_file(cdir)
    four = "\n".join(f"## {s}\n- (nothing yet)" for s in T.MEMORY_SECTIONS)
    logs, prompts = [], []
    reply = {}

    def fake_run(cdir_, system, prompt, **kw):
        prompts.append(prompt)
        if reply.get("edit"):          # the student saves the file while the update is being written
            time.sleep(0.05)
            f.write_text(T.MEMORY_HEAD + four + "\n- student line\n", encoding="utf-8")
        return {"json": {"changed": reply["changed"], "memory": reply["memory"]}, "text": "", "session": None,
                "ms": 0, "cost": 0}
    shim = types.SimpleNamespace(Thread=SyncThread, Lock=threading.Lock)
    with Patch((T, "run_claude", fake_run), (T, "log", logs.append), (T, "threading", shim)):
        reply.update(changed=True, memory=four + "\n## My own section\n- keep me")
        T.remember(cdir, "S&D-2", 3, "so elasticity is just the slope, right?", "Not quite. It's a ratio of percentage changes because...")
        check("remember: correction hint passed to the model", "opens with a correction" in prompts[-1])
        check("remember: extra student section accepted", "## My own section" in f.read_text(encoding="utf-8"))
        check("remember: no .md.tmp left", not f.with_suffix(".md.tmp").exists())
        T.remember(cdir, "S&D-2", 3, "how is elasticity measured?", "It compares percentage changes...")
        check("remember: no hint for a plain answer", "opens with a correction" not in prompts[-1])
        reply.update(changed=False)
        T.remember(cdir, "S&D-2", 3, "q", "a")
        check("remember: unchanged is logged", any(l.startswith("memory unchanged") for l in logs), logs)
        reply.update(changed=True, memory=four.replace("I've", "I’ve") + "\n- curly")
        T.remember(cdir, "S&D-2", 3, "q", "a")
        check("remember: curly apostrophe in a heading accepted", "- curly" in f.read_text(encoding="utf-8"))
        reply.update(changed=True, memory="## About me\n- only one section")
        n0 = len(prompts)
        T.remember(cdir, "S&D-2", 3, "q", "a")
        check("remember: a summary instead of the notebook is retried once",
              len(prompts) == n0 + 2 and T.MEMORY_RETRY in prompts[-1])
        check("remember: missing sections rejected and logged",
              any(l.startswith("memory rejected: missing sections") for l in logs)
              and "- curly" in f.read_text(encoding="utf-8"), logs)
        reply.update(changed=True, memory=four + "\n- from the model", edit=True)
        T.remember(cdir, "S&D-2", 3, "q", "a")
        text = f.read_text(encoding="utf-8")
        check("remember: student's edit meanwhile wins", "student line" in text and "from the model" not in text, text)
        check("remember: edited-meanwhile skip logged", any(l.startswith("memory skipped: edited meanwhile") for l in logs))
        check("remember: no .md.tmp left after skip", not f.with_suffix(".md.tmp").exists())


# ---------------------------------------------------------------- chat_turn(): overlapping turns

def test_chat_turn(tmp):
    cdir = tmp / "Chat"
    (cdir / "study").mkdir(parents=True)
    state = {}
    calls = []

    def fake_run(cdir_, system, prompt, *, chat_key=None, session=None, **kw):
        q = prompt.rsplit("\n", 1)[-1]
        calls.append((q, chat_key))
        time.sleep(DELAYS[q])
        return {"text": f"answer to {q}", "json": None, "session": f"sess-{q}", "ms": 1, "cost": 0}
    DELAYS = {}
    patches = Patch((T, "run_claude", fake_run), (T, "CHATS", tmp / "chats"), (T, "log", lambda m: None),
                    (T, "system_prompt", lambda *a: "SYSTEM"), (T, "deck_where", lambda c, t: f"[{t}]"),
                    (T, "where", lambda c, t, n: f"[{t} s{n}]"),
                    (L, "course_meta", lambda c: ("DEMO", "Test")),
                    (T, "current_chat", lambda c: state.get("chat")),
                    (S, "set_chat", lambda c, cid: state.__setitem__("chat", cid)))

    def overlapped(first, second):
        DELAYS.update({first: 0.6, second: 0.1})      # the first starts first and finishes last
        out = {}
        a = threading.Thread(target=lambda: out.__setitem__(first, T.chat_turn(cdir, "S&D-2", 1, "ask", first, "m", False)))
        b = threading.Thread(target=lambda: out.__setitem__(second, T.chat_turn(cdir, "S&D-2", 1, "ask", second, "m", False)))
        a.start()
        time.sleep(0.15)
        b.start()
        a.join()
        b.join()
        return out

    with patches:
        overlapped("Q1", "Q2")
        files = list((tmp / "chats").glob("*.json"))
        chat = T.load_chat(state.get("chat"))
        qs = [m["text"] for m in (chat or {}).get("messages", []) if m["role"] == "q"]
        check("chat_turn: two new overlapping turns -> one chat", len(files) == 1, [f.name for f in files])
        check("chat_turn: both Q/A pairs saved", sorted(qs) == ["Q1", "Q2"] and len(chat["messages"]) == 4, qs)
        check("chat_turn: both turns used the same chat client", calls[0][1] == calls[1][1], calls)
        check("chat_turn: the client is the course's chat (no deck in the key)", calls[0][1] == ("Chat", chat["id"]), calls)
        check("chat_turn: session is the last finished turn's", chat["session"] == "sess-Q1", chat.get("session"))
        check("chat_turn: nothing left pending", not T._PENDING)
        overlapped("Q3", "Q4")
        chat = T.load_chat(state.get("chat"))
        qs = [m["text"] for m in chat["messages"] if m["role"] == "q"]
        check("chat_turn: overlapping turns on an existing chat both saved", sorted(qs[:2]) == ["Q1", "Q2"]
              and sorted(qs[2:]) == ["Q3", "Q4"], qs)
        check("chat_turn: messages pair up", all(m["text"] == f"answer to {q['text']}" for q, m in
                                                 zip(chat["messages"][::2], chat["messages"][1::2])))
        DELAYS["Q7"] = 0
        other, _ = T.chat_turn(cdir, "S&D-3", 2, "ask", "Q7", "m", False)
        check("chat_turn: another deck of the course continues the same chat", other["id"] == chat["id"]
              and other["deck"] == "S&D-2" and calls[-1][1] == ("Chat", chat["id"]), (other["id"], calls[-1]))
        check("chat_turn: each message records its deck", [m["deck"] for m in other["messages"][-4:]]
              == ["S&D-2", "S&D-2", "S&D-3", "S&D-3"], other["messages"][-4:])

        def boom(*a, **kw):
            raise T.TutorError("no")
        state.clear()
        with Patch((T, "run_claude", boom)):
            try:
                T.chat_turn(cdir, "S&D-2", 1, "ask", "Q5", "m", False)
            except T.TutorError:
                pass
        check("chat_turn: a failed first turn leaves nothing pending", not T._PENDING)
        DELAYS["Q6"] = 0
        chat, _ = T.chat_turn(cdir, "S&D-2", 1, "ask", "Q6", "m", False)
        check("chat_turn: the next turn after a failure starts a chat", [m["text"] for m in chat["messages"]][0] == "Q6")

        def delete_meanwhile(*a, **kw):        # the student deletes the chat while it's answering
            T.chat_file(chat["id"]).unlink()
            return {"text": "late", "json": None, "session": "s", "ms": 1, "cost": 0}
        with Patch((T, "run_claude", delete_meanwhile)):
            try:
                T.chat_turn(cdir, "S&D-2", 1, "ask", "Q8", "m", False)
                status = None
            except T.TutorError as e:
                status = e.status
        check("chat_turn: a chat deleted mid-answer isn't saved again", status == 410
              and not T.chat_file(chat["id"]).exists(), status)


# ---------------------------------------------------------------- engine._chat: one course chat, several decks

def test_engine_turns():
    E = T.engine
    events, active, ANSWER = [], [], [0.3]

    class FakeClient:      # a claude process: answering takes ANSWER s; disconnecting one mid-answer breaks it
        def __init__(self, opts):
            self.system, self.resume, self.dead = opts["system"], opts["resume"], False
            events.append(("open", self.system, self.resume))

        async def connect(self):
            await asyncio.sleep(0.05)

        async def query(self, prompt):
            self.prompt = prompt

        async def receive_response(self):
            active.append(self)
            events.append(("start", self.prompt))
            try:
                await asyncio.sleep(ANSWER[0])
            finally:
                active.remove(self)
            if self.dead:
                raise RuntimeError("process killed mid-answer")
            events.append(("end", self.prompt))
            yield types.SimpleNamespace(total_cost_usd=0.0, session_id=f"s-{self.prompt}")

        async def disconnect(self):
            self.dead = True
            events.append(("disconnect", self.system, self in active))

    async def consume(stream, emit, cdir, text_out=True, stats=None):
        res = None
        async for m in stream:
            res = m
        return res

    async def scenario(warm):
        key = ("Course", "abcdef123456")
        turn = lambda system, q: E._chat(key, None, system, q, "m", False, "s-old", lambda k, d: None)
        a = asyncio.ensure_future(turn("topic A", "QA"))
        await asyncio.sleep(0.1)
        if warm:        # the Talk tab opened on deck B while deck A's answer is still coming
            await E._warm(key, None, "topic B", "m", False, "s-old")
        else:
            await turn("topic B", "QB")
        res_a, _ = await a
        await E._close(key)
        return res_a

    def reset():
        events.clear()
        for d in (E._TURNS, E._SESSIONS, E._CHATS, E._EPOCHS):
            d.clear()

    def outcome(coro):
        try:
            return asyncio.run(coro)
        except BaseException as e:
            return e
    opens = lambda: [e for e in events if e[0] == "open"]
    key = ("Course", "abcdef123456")
    turn = lambda q, system="topic A": E._chat(key, None, system, q, "m", False, "s-old", lambda k, d: None)

    async def queued():         # each answer 0.3 s, the timeout 0.5 s: the second waits 0.3 s first
        a = asyncio.ensure_future(turn("QA"))
        await asyncio.sleep(0.05)
        rb = await turn("QB")
        return (await a)[0].session_id, rb[0].session_id

    async def cut_off():        # the answer outlives the timeout; then the next turn
        ANSWER[0] = 0.8
        try:
            await turn("QA")
        except TimeoutError:
            pass
        ANSWER[0] = 0.3
        left = [e for e in events if e[0] == "disconnect"]
        return left, key in E._CHATS, (await turn("QB"))[0].session_id

    async def deleted():        # the chat is deleted (close_chat) mid-answer
        a = asyncio.ensure_future(turn("QA"))
        await asyncio.sleep(0.1)
        await E._kill(key)
        try:
            await a
            first = None
        except E.EngineError as e:
            first = e.status
        return first, len(opens()), (await turn("QB"))[0].session_id

    async def shut():           # the hub stops mid-answer
        a = asyncio.ensure_future(turn("QA"))
        await asyncio.sleep(0.1)
        E._SHUTDOWN = True
        await E._close(key)
        try:
            await a
        except E.EngineError as e:
            return e.status, len(opens())

    with Patch((E, "ClaudeSDKClient", FakeClient), (E, "_consume", consume),
               (E, "_options", lambda cdir, system, model, web, resume=None, fork=False, **kw: {"system": system, "resume": resume})):
        reset()
        try:
            res_a, ok = asyncio.run(scenario(False)), True
        except Exception as e:
            ok, res_a = False, e
        starts = [e for e in events if e[0] in ("start", "end")]
        check("engine: two cross-deck turns 0.1 s apart both answered", ok and res_a.session_id == "s-QA"
              and ("end", "QB") in events, events)
        check("engine: ... one after the other", starts == [("start", "QA"), ("end", "QA"), ("start", "QB"), ("end", "QB")], starts)
        check("engine: ... no busy client disconnected", not any(e[0] == "disconnect" and e[2] for e in events), events)
        check("engine: ... topic B resumes the session topic A's turn ended on",
              [e for e in events if e[0] == "open"] == [("open", "topic A", "s-old"), ("open", "topic B", "s-QA")], events)

        events.clear()
        reset()
        try:
            res_a, ok = asyncio.run(scenario(True)), True
        except Exception as e:
            ok, res_a = False, e
        check("engine: a warm-up during a busy turn leaves it answering", ok and res_a.session_id == "s-QA"
              and not any(e[0] == "disconnect" and e[2] for e in events), events)
        check("engine: ... and opens nothing", [e for e in events if e[0] == "open"] == [("open", "topic A", "s-old")], events)
        with Patch((E, "TIMEOUT", 0.5)):
            r = outcome(queued())
            check("engine: time queued behind another turn doesn't count against the timeout", r == ("s-QA", "s-QB"), r)
            reset()
            r = outcome(cut_off())
            check("engine: a timed-out turn closes its client", isinstance(r, tuple) and len(r[0]) == 1 and not r[1], r)
            check("engine: ... and the next turn answers on a fresh client", isinstance(r, tuple) and r[2] == "s-QB"
                  and len(opens()) == 2, (r, events))
        reset()
        r = outcome(deleted())
        check("engine: a chat closed mid-answer fails (410) without reopening", isinstance(r, tuple) and r[:2] == (410, 1),
              (r, events))
        check("engine: ... and the same id still works afterwards", isinstance(r, tuple) and r[2] == "s-QB", r)
        reset()
        with Patch((E, "_SHUTDOWN", False)):
            r = outcome(shut())
        check("engine: after shutdown a running turn doesn't reopen", r == (410, 1), (r, events))
        reset()


# ---------------------------------------------------------------- chat_turn(): Talk's This slide | Whole deck

def test_chat_turn_scope(tmp):
    cdir = tmp / "Scope"
    (cdir / "study").mkdir(parents=True)
    state, prompts, remembered = {}, [], []

    def fake_run(cdir_, system, prompt, **kw):
        prompts.append(prompt)
        return {"text": "an answer", "json": None, "session": "s", "ms": 1, "cost": 0}
    f = tmp / "scope-prompt.md"
    f.write_text("W: {where}\nQ: {question}\n", encoding="utf-8")
    patches = Patch((T, "run_claude", fake_run), (T, "CHATS", tmp / "scope-chats"), (T, "log", lambda m: None),
                    (T, "VOICE_PROMPT", f), (T, "remember", lambda *a: remembered.append(a)),
                    (T, "system_prompt", lambda *a: "SYSTEM"),
                    (T, "deck_where", lambda c, t: f"[{t}] \"Deck title\" (slides 1–9)"),
                    (T, "where", lambda c, t, n: f"[{t} s{n}] \"Slide title\""),
                    (L, "course_meta", lambda c: ("DEMO", "Test")),
                    (T, "current_chat", lambda c: state.get("chat")),
                    (S, "set_chat", lambda c, cid: state.__setitem__("chat", cid)))
    with patches:
        chat, _ = T.chat_turn(cdir, "S&D-1", 4, "voice", "what is this deck about", "m", False, whole_deck=True)
        q = chat["messages"][0]
        check("chat_turn scope: whole deck -> 'the whole deck [' in the prompt",
              "W: the whole deck [S&D-1] \"Deck title\"" in prompts[-1] and "slide [" not in prompts[-1], prompts[-1])
        check("chat_turn scope: whole deck -> new chat's title ends with the tag", chat["title"].endswith(" · S&D-1"),
              chat["title"])
        check("chat_turn scope: whole deck -> q message has whole True", q.get("whole") is True and q["deck"] == "S&D-1"
              and q["slide"] == 4, q)
        check("chat_turn scope: voice turn still remembered", len(remembered) == 1)

        state.clear()
        chat, _ = T.chat_turn(cdir, "S&D-1", 4, "voice", "what is this slide", "m", False)
        q = chat["messages"][0]
        check("chat_turn scope: this slide -> 'slide [TAG sN]' unchanged", "W: slide [S&D-1 s4] \"Slide title\"" in prompts[-1]
              and "whole deck" not in prompts[-1], prompts[-1])
        check("chat_turn scope: this slide -> title ends with sN", chat["title"].endswith(" · s4"), chat["title"])
        check("chat_turn scope: this slide -> no whole key", "whole" not in q, q)
        chat, _ = T.chat_turn(cdir, "S&D-1", 5, "voice", "and the deck?", "m", False, whole_deck=True)
        check("chat_turn scope: existing chat keeps its title, deck q appended",
              chat["title"].endswith(" · s4") and chat["messages"][-2].get("whole") is True, chat["messages"][-2])

        state.clear()
        chat, _ = T.chat_turn(cdir, "S&D-1", 4, "ask", "a typed question", "m", False, whole_deck=True)
        q = chat["messages"][0]
        check("chat_turn scope: whole_deck ignored for non-voice modes", "whole" not in q
              and chat["title"].endswith(" · s4") and "whole deck" not in prompts[-1], (q, chat["title"]))


# ---------------------------------------------------------------- slash commands: a mode with the student's words

def test_slash_extra(tmp):
    cdir = tmp / "Slash"
    (cdir / "study").mkdir(parents=True)
    state, prompts = {}, []

    def fake_run(cdir_, system, prompt, **kw):
        prompts.append(prompt)
        return {"text": "an answer", "json": None, "session": "s", "ms": 1, "cost": 0}
    patches = Patch((T, "run_claude", fake_run), (T, "CHATS", tmp / "slash-chats"), (T, "log", lambda m: None),
                    (T, "remember", lambda *a, **kw: None), (T, "system_prompt", lambda *a: "SYSTEM"),
                    (T, "weak_points", lambda c: "(none)"),
                    (T, "deck_where", lambda c, t: f"[{t}] \"Deck title\" (slides 1–9)"),
                    (T, "where", lambda c, t, n: f"[{t} s{n}] \"Slide title\""),
                    (L, "course_meta", lambda c: ("DEMO", "Test")),
                    (T, "current_chat", lambda c: state.get("chat")),
                    (S, "set_chat", lambda c, cid: state.__setitem__("chat", cid)))
    plain = lambda mode: T.CHAT_PROMPTS[mode].format(where="[S&D-1 s4] \"Slide title\"", question="", tag="S&D-1",
                                                     deck="[S&D-1] \"Deck title\" (slides 1–9)",
                                                     style=T.STYLE.get("DEMO", "this course's quizzes and exams"),
                                                     mistakes="(none)")
    last_q = lambda chat: chat["messages"][-2]["text"]
    with patches:
        chat, _ = T.chat_turn(cdir, "S&D-1", 4, "explain", "  focus on the equilibrium step ", "m", False)
        check("slash: explain + words -> prompt ends with EXTRA",
              prompts[-1] == plain("explain") + T.EXTRA.format(extra="focus on the equilibrium step"), prompts[-1][-300:])
        check("slash: explain + words -> label 'Explain simply: …'",
              last_q(chat) == "Explain simply: focus on the equilibrium step", last_q(chat))
        check("slash: explain + words -> new chat title uses the label",
              chat["title"].startswith("Explain simply: focus on the equilibrium step"), chat["title"])
        chat, _ = T.chat_turn(cdir, "S&D-1", 4, "explain", "   ", "m", False)
        check("slash: explain without words -> prompt unchanged", prompts[-1] == plain("explain"), prompts[-1][-300:])
        check("slash: explain without words -> label 'Explain simply'", last_q(chat) == "Explain simply", last_q(chat))
        for mode, q in (("ask", "what is elasticity?"), ("brush", "percentage change"), ("grill_reply", "it is a ratio")):
            chat, _ = T.chat_turn(cdir, "S&D-1", 4, mode, q, "m", False)
            check(f"slash: {mode} -> no EXTRA", "The student added this to the request" not in prompts[-1]
                  and q in prompts[-1], prompts[-1][-300:])
        msgs = T.load_chat(state["chat"])["messages"]
        check("slash: brush / grill_reply labels unchanged", msgs[-4]["text"] == "Brush up: percentage change"
              and msgs[-2]["text"] == "it is a ratio", [m["text"] for m in msgs[-6::2]])
        chat, _ = T.chat_turn(cdir, "S&D-1", 4, "explain_deck", "use a farmers' market", "m", False)
        check("slash: explain_deck label", last_q(chat) == "Explain simply · whole deck: use a farmers' market", last_q(chat))
        chat, _ = T.chat_turn(cdir, "S&D-1", 4, "explain", "what's {n} and {} and {{x}} {where}?", "m", False)
        check("slash: braces in the words kept literally", prompts[-1].endswith(
              T.EXTRA.format(extra="what's {n} and {} and {{x}} {where}?")) and "{n} and {} and {{x}} {where}?" in prompts[-1],
              prompts[-1][-300:])
        check("slash: braces in the label kept", last_q(chat) == "Explain simply: what's {n} and {} and {{x}} {where}?")
        for mode in ("grill_end", "deeper"):
            chat, _ = T.chat_turn(cdir, "S&D-1", 4, mode, "keep it short", "m", False)
            check(f"slash: {mode} + words -> EXTRA appended and labelled",
                  prompts[-1].endswith(T.EXTRA.format(extra="keep it short"))
                  and last_q(chat) == f"{T.MODE_LABELS[mode]}: keep it short", (last_q(chat), prompts[-1][-200:]))


def test_practice_focus(tmp):
    cdir = tmp / "Practice"
    (cdir / "study").mkdir(parents=True)
    prompts = []
    problem = {"problem_md": "Find the equilibrium price for Qd = 100 - 2P and Qs = 3P.", "solution_md": "1. Set Qd = Qs", "final_answer": "P = 20",
               "hints": ["h1", "h2"], "concept": "equilibrium", "slides": "S&D-1 s4", "deck": "S&D-1"}

    def fake_run(cdir_, system, prompt, **kw):
        prompts.append(prompt)
        return {"text": "", "json": dict(problem), "session": None, "ms": 1, "cost": 0}
    patches = Patch((T, "run_claude", fake_run), (T, "PRACTICE_DIR", tmp / "practice"), (T, "log", lambda m: None),
                    (T, "system_prompt", lambda *a: "SYSTEM"), (T, "where", lambda c, t, n: f"[{t} s{n}]"),
                    (L, "deck", lambda c, t: {"title": "D", "slides": 9} if t == "S&D-1" else None),
                    (L, "course_info", lambda c: {"code": "DEMO", "topics": []}))
    with patches:
        req = {"kind": "try", "tag": "S&D-1", "n": 4, "focus": "  harder, with {worked} numbers  "}
        rec = T._generate(cdir, req, "m", False)
        check("practice focus: in the prompt", 'The student asked for this problem: "harder, with {worked} numbers"'
              in prompts[-1], prompts[-1][-300:])
        check("practice focus: on the record", rec["focus"] == "harder, with {worked} numbers", rec.get("focus"))
        check("practice focus: public_problem works", T.public_problem(rec)["problem_md"] == problem["problem_md"])
        rec = T._generate(cdir, {"kind": "try", "tag": "S&D-1", "n": 4}, "m", False)
        check("practice no focus: no focus line", "The student asked for this problem" not in prompts[-1]
              and rec["focus"] == "")

        ready = threading.Event(); ready.set()
        pre = {"id": "prefetched01", "n": 4}
        key = T._prefetch_key(cdir, {"kind": "try", "tag": "S&D-1"}, "m", False)
        T._PREFETCH[key] = {"event": ready, "rec": pre}
        try:
            got = T.new_problem(cdir, {"kind": "try", "tag": "S&D-1", "n": 4, "focus": "with a price ceiling"}, "m", False)
            check("new_problem focus: prefetched problem not taken", got is not pre and got["focus"] == "with a price ceiling")
            check("new_problem focus: prefetched problem left for later", T._PREFETCH.get(key, {}).get("rec") is pre)
            got = T.new_problem(cdir, {"kind": "try", "tag": "S&D-1", "n": 4}, "m", False)
            check("new_problem no focus: prefetched problem taken", got is pre)
        finally:
            T._PREFETCH.pop(key, None)


# ---------------------------------------------------------------- the voice models

def to_16k_mono(wav_bytes):
    with wave.open(io.BytesIO(wav_bytes)) as w:
        rate, ch = w.getframerate(), w.getnchannels()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32)
    x = x.reshape(-1, ch).mean(axis=1)
    y = np.interp(np.arange(0, len(x), rate / 16000), np.arange(len(x)), x)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(np.clip(y, -32768, 32767).astype("<i2").tobytes())
    return buf.getvalue()


def words(t):
    return re.findall(r"[a-z0-9]+", t.lower())


def test_voice_errors():
    def status_of(fn):
        try:
            fn()
        except V.VoiceError as e:
            return e.status
        return None
    check("transcribe: garbage -> 400", status_of(lambda: V.transcribe(b"not a wav")) == 400)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\0" * 64000)
    check("transcribe: stereo -> 400", status_of(lambda: V.transcribe(buf.getvalue())) == 400)
    check("VoiceError defaults to 503", V.VoiceError("x").status == 503)


def test_round_trip():
    sentence = ("Demand falls as the price rises, and supply rises with it, until the two curves meet. "
                "That meeting point is the equilibrium price, where the amount bought equals the amount sold.")
    t0 = time.time()
    V.warm()
    check("warm: status shows loading at once", V.status()["loading"] or V.status()["ready"], V.status())
    wav = V.speak(sentence, "af_heart", 1.0)
    t1 = time.time()
    heard = V.transcribe(to_16k_mono(wav), "Supply and Demand. Price elasticity")
    t2 = time.time()
    exp, got = words(sentence), words(heard)
    overlap = sum(min(exp.count(w), got.count(w)) for w in set(exp)) / len(exp)
    print(f"      said:  {sentence}\n      heard: {heard}\n      overlap {overlap:.0%}  "
          f"(load+speak {t1 - t0:.1f}s, transcribe {t2 - t1:.1f}s)")
    check("round trip: >= 80% of the words heard back", overlap >= 0.8, f"{overlap:.0%}")
    check("speak: garbage speed falls back to normal", len(V.speak("Hello.", "nope", "fast")) > 1000)
    check("speak: NaN speed falls back to normal", len(V.speak("Hello.", "af_heart", float("nan"))) > 1000)


def main():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        test_voice_prompt(tmp)
        test_memory_text(tmp)
        test_remember(tmp)
        test_chat_turn(tmp)
        test_engine_turns()
        test_chat_turn_scope(tmp)
        test_slash_extra(tmp)
        test_practice_focus(tmp)
    test_voice_errors()
    if "--no-models" not in sys.argv:
        test_round_trip()
    print(f"\n{len(FAILED)} failed" + (": " + ", ".join(FAILED) if FAILED else ""))
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
