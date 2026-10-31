"""Checks for the voice features (reading aloud, dictation, voice turns). A plain script, no test framework:

    python tests/test_voice.py              # everything (loads the speech models: ~10 s warm, longer the first time)
    python tests/test_voice.py --no-models  # only the checks that need no models and no Claude

Nothing here calls Claude (run_model is replaced) or touches a real course: chats, memory and state live in a
temporary folder.
"""
import asyncio, base64, io, json, re, sys, tempfile, threading, time, types, wave
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))     # the modules under test live in the repo root

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


def make_course(tmp, name, **facts):
    """A course folder in the test library (tmp): its course.json and an empty me/."""
    cdir = tmp / name
    (cdir / "me").mkdir(parents=True, exist_ok=True)
    (cdir / "course.json").write_text(json.dumps(facts), encoding="utf-8")
    return cdir


class SyncThread:
    """Runs remember()'s background work at once, so the test can look at the result."""
    def __init__(self, target, daemon=None):
        self.target = target

    def start(self):
        self.target()


# ---------------------------------------------------------------- voice_prompt()

def test_voice_prompt(tmp):
    cdir = make_course(tmp, "Course")
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
    cdir = make_course(tmp, "Mem")
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
    cdir = make_course(tmp, "Rem")
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
    with Patch((T, "run_model", fake_run), (T, "log", logs.append), (T, "threading", shim)):
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
    cdir = make_course(tmp, "Chat")
    state = {}
    calls = []

    def fake_run(cdir_, system, prompt, *, chat_key=None, session=None, **kw):
        q = prompt.rsplit("\n", 1)[-1]
        calls.append((q, chat_key))
        time.sleep(DELAYS[q])
        return {"text": f"answer to {q}", "json": None, "session": f"sess-{q}", "ms": 1, "cost": 0}
    DELAYS = {}
    patches = Patch((T, "run_model", fake_run), (T, "log", lambda m: None),
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
        files = list((cdir / "me" / "chats").glob("*.json"))
        chat = T.load_chat(state.get("chat"))
        qs = [m["text"] for m in (chat or {}).get("messages", []) if m["role"] == "q"]
        check("chat_turn: two new overlapping turns -> one chat", len(files) == 1, [f.name for f in files])
        check("chat_turn: the chat is saved in <course>/me/chats", T.chat_file(state.get("chat")) == cdir / "me" / "chats" / f"{state.get('chat')}.json")
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
        with Patch((T, "run_model", boom)):
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
        with Patch((T, "run_model", delete_meanwhile)):
            try:
                T.chat_turn(cdir, "S&D-2", 1, "ask", "Q8", "m", False)
                status = None
            except T.TutorError as e:
                status = e.status
        check("chat_turn: a chat deleted mid-answer isn't saved again", status == 410
              and T.chat_file(chat["id"]) is None, status)


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
            yield types.SimpleNamespace(total_cost_usd=0.0, usage=None, model_usage=None, session_id=f"s-{self.prompt}")

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
        if warm:        # Voice chosen on deck B while deck A's answer is still coming
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


# ---------------------------------------------------------------- chat_turn(): a voice turn's This slide | Whole deck

def test_chat_turn_scope(tmp):
    cdir = make_course(tmp, "Scope")
    state, prompts, remembered = {}, [], []

    def fake_run(cdir_, system, prompt, **kw):
        prompts.append(prompt)
        return {"text": "an answer", "json": None, "session": "s", "ms": 1, "cost": 0}
    f = tmp / "scope-prompt.md"
    f.write_text("W: {where}\nQ: {question}\n", encoding="utf-8")
    patches = Patch((T, "run_model", fake_run), (T, "log", lambda m: None),
                    (T, "VOICE_PROMPT", f), (T, "remember", lambda *a, **kw: remembered.append(a)),
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
    cdir = make_course(tmp, "Slash")
    state, prompts = {}, []

    def fake_run(cdir_, system, prompt, **kw):
        prompts.append(prompt)
        return {"text": "an answer", "json": None, "session": "s", "ms": 1, "cost": 0}
    patches = Patch((T, "run_model", fake_run), (T, "log", lambda m: None),
                    (T, "remember", lambda *a, **kw: None), (T, "system_prompt", lambda *a: "SYSTEM"),
                    (T, "weak_points", lambda c: "(none)"),
                    (T, "deck_where", lambda c, t: f"[{t}] \"Deck title\" (slides 1–9)"),
                    (T, "where", lambda c, t, n: f"[{t} s{n}] \"Slide title\""),
                    (L, "course_meta", lambda c: ("DEMO", "Test")),
                    (T, "current_chat", lambda c: state.get("chat")),
                    (S, "set_chat", lambda c, cid: state.__setitem__("chat", cid)))
    plain = lambda mode: T.CHAT_PROMPTS[mode].format(where="[S&D-1 s4] \"Slide title\"", question="", tag="S&D-1",
                                                     deck="[S&D-1] \"Deck title\" (slides 1–9)",
                                                     style="this course's quizzes and exams",
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


def test_drawing_first_prompts():
    s = T.SYSTEM
    check("prompts: system prompt has the cue rule", "[#id]" in s and "before the text that explains it" in s)
    check("prompts: system prompt has the SVG viewBox rule", "viewBox on the opening <svg> tag" in s and "marker-end" in s)
    check("prompts: spoken-line rule", "[say:" in s and "on its own line" in s)
    check("prompts: spoken lines cover the visual cases", all(w in s for w in ("table", "$$", "code", "drawing", "arithmetic")))
    check("prompts: spoken lines never read cells or symbols", "never read the cells" in s)
    check("prompts: a spoken line replaces everything under it to the next blank line", "up to the next blank line" in s and "directly above" in s)
    check("prompts: the covered block is just the visual, with blank lines around it", "just the visual" in s and "blank line before and after" in s)
    check("prompts: a long inline formula gets its own $$ line, or the line says the whole paragraph",
          "its own $$ line" in s and "whole paragraph" in s)
    check("prompts: no 'stands for nothing on screen' wording", "stands for nothing on screen" not in s)
    ex = T.CHAT_PROMPTS["explain"]
    check("prompts: worked example's drawing comes before its steps",
          0 < ex.index("<one drawing") < ex.index("**Let's work through it:**"))
    late = [m for m, p in T.CHAT_PROMPTS.items() if m != "explain" and "drawing" in p and p.index("drawing") > len(p) // 2
            and m != "map_deck"]
    check("prompts: no other template puts a drawing after its explanation", not late, late)


def test_spoken_flag(tmp):
    cdir = make_course(tmp, "Spoken")
    state, remembered = {}, []

    def fake_run(cdir_, system, prompt, **kw):
        return {"text": "an answer", "json": None, "session": "s", "ms": 1, "cost": 0}
    patches = Patch((T, "run_model", fake_run), (T, "log", lambda m: None),
                    (T, "remember", lambda *a, **kw: remembered.append((a, kw))), (T, "system_prompt", lambda *a: "SYSTEM"),
                    (T, "where", lambda c, t, n: f"[{t} s{n}]"),
                    (L, "course_meta", lambda c: ("DEMO", "Test")),
                    (T, "current_chat", lambda c: state.get("chat")),
                    (S, "set_chat", lambda c, cid: state.__setitem__("chat", cid)))
    with patches:
        chat, _ = T.chat_turn(cdir, "S&D-1", 4, "ask", " said aloud ", "m", False, spoken=True)
        check("spoken: question saved with spoken True", chat["messages"][0].get("spoken") is True, chat["messages"][0])
        check("spoken: ask remembered", len(remembered) == 1 and remembered[0][0][3:] == ("said aloud", "an answer"),
              remembered)
        chat, _ = T.chat_turn(cdir, "S&D-1", 4, "ask", "typed", "m", False)
        check("spoken: typed ask has no spoken key", "spoken" not in chat["messages"][-2], chat["messages"][-2])
        check("spoken: typed ask not remembered", len(remembered) == 1, remembered)


def test_practice_focus(tmp):
    cdir = make_course(tmp, "Practice")
    prompts = []
    problem = {"problem_md": "Find the equilibrium price for Qd = 100 - 2P and Qs = 3P.", "solution_md": "1. Set Qd = Qs", "final_answer": "P = 20",
               "hints": ["h1", "h2"], "concept": "equilibrium", "slides": "S&D-1 s4", "deck": "S&D-1"}

    def fake_run(cdir_, system, prompt, **kw):
        prompts.append(prompt)
        return {"text": "", "json": dict(problem), "session": None, "ms": 1, "cost": 0}
    patches = Patch((T, "run_model", fake_run), (T, "log", lambda m: None),
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
        check("practice: the record is saved in <course>/me/practice", (cdir / "me" / "practice" / f"{rec['id']}.json").is_file())
        check("practice: no assessment_style -> the prompt's own fallback", "- Style: an exam-style question for this course." in prompts[-1])
        T._PRACTICE.pop(rec["id"], None)
        check("practice: found again by its id alone (from the course's folder)", (T.get_practice(rec["id"]) or {}).get("id") == rec["id"])
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


# ---------------------------------------------------------------- runtime data and course facts (library/<course>/me/)

def test_runtime_data(tmp):
    style = "a short scenario question about a market, answered in 2-3 sentences"
    cdir = make_course(tmp, "Demo-Course", code="DEMO101", title="Demo Course", assessment_style=style)
    bare = make_course(tmp, "Bare")
    check("course facts: code and title from course.json", L.course_meta(cdir) == ("DEMO101", "Demo Course"))
    check("course facts: no code or title -> the folder name for both", L.course_meta(bare) == ("Bare", "Bare"))
    check("course facts: assessment_style from course.json", L.course_style(cdir) == style)
    check("course facts: no assessment_style -> empty", L.course_style(bare) == "")
    (bare / "course.json").write_text(json.dumps({"assessment_style": "  "}), encoding="utf-8")
    check("course facts: a blank assessment_style counts as none", L.course_style(bare) == "")
    check("style: _papers_text falls back to its own text", "question style: exam-style questions)" in
          T._papers_text(bare, {"papers": []}))
    check("style: _papers_text uses the course's style", f"question style: {style})" in T._papers_text(cdir, {"papers": []}))

    prompts = []
    def fake_run(cdir_, system, prompt, **kw):
        prompts.append(prompt)
        return {"text": "an answer", "json": {"problem_md": "p", "solution_md": "s", "final_answer": "f", "hints": ["a", "b"],
                                              "concept": "c", "slides": "S&D-1 s1", "deck": "S&D-1"},
                "session": "s", "ms": 1, "cost": 0}
    state = {}
    with Patch((T, "run_model", fake_run), (T, "log", lambda m: None), (T, "system_prompt", lambda *a: "SYSTEM"),
               (T, "where", lambda c, t, n: f"[{t} s{n}]"), (T, "deck_where", lambda c, t: f"[{t}]"),
               (T, "remember", lambda *a, **kw: None),
               (L, "deck", lambda c, t: {"tag": t, "title": "D", "slides": 3} if t == "S&D-1" else None),
               (T, "current_chat", lambda c: state.get("chat")),
               (S, "set_chat", lambda c, cid: state.__setitem__("chat", cid))):
        T.chat_turn(cdir, "S&D-1", 1, "quiz", "", "m", False)
        check("style: a chat prompt uses the course's style", f"for this course's assessments ({style})" in prompts[-1], prompts[-1][:300])
        state.clear()
        T.chat_turn(bare, "S&D-1", 1, "quiz", "", "m", False)
        check("style: a chat prompt falls back to its own text", "for this course's assessments (this course's quizzes and exams)"
              in prompts[-1], prompts[-1][:300])
        rec = T._generate(cdir, {"kind": "try", "tag": "S&D-1", "n": 1}, "m", False)
        check("style: a practice prompt uses the course's style", f"- Style: {style}." in prompts[-1])
        check("runtime: chats under each course's me/chats", any((cdir / "me" / "chats").glob("*.json"))
              and any((bare / "me" / "chats").glob("*.json")))
        check("runtime: the chat list spans every course", {c["course"] for c in T.list_chats()} >= {"Demo-Course", "Bare"})
        png = "data:image/png;base64," + base64.b64encode(bytes.fromhex("89504e470d0a1a0a") + b"fake").decode()
        T.add_photo(cdir, rec["id"], png)
        photo = T.get_practice(rec["id"])["photos"][0]
        check("runtime: a photo is saved in <course>/me/uploads", photo.startswith("me/uploads/") and (cdir / photo).is_file(), photo)
        check("runtime: and counts as an upload", T.is_upload(cdir, photo) and not T.is_upload(cdir, "me/hub-state.json"))
    stray_chat = {"id": "abcabcabcabc", "course": "Demo-Course", "deck": "S&D-1", "messages": []}
    (bare / "me" / "chats" / "abcabcabcabc.json").write_text(json.dumps(stray_chat), encoding="utf-8")
    T.update_chat("abcabcabcabc", title="Renamed")
    check("runtime: a chat is saved back where it was found, never copied into another course",
          json.loads((bare / "me" / "chats" / "abcabcabcabc.json").read_text(encoding="utf-8"))["title"] == "Renamed"
          and not (cdir / "me" / "chats" / "abcabcabcabc.json").exists())
    S.mark_solved(cdir, "S&D-1")
    check("runtime: hub state in <course>/me/hub-state.json", (cdir / "me" / "hub-state.json").is_file())
    (cdir / "me" / "progress.md").write_text("# Progress" + chr(10), encoding="utf-8")
    S.mark_solved(cdir, "S&D-1")
    text = (cdir / "me" / "progress.md").read_text(encoding="utf-8")
    check("runtime: saved mistakes mirrored into me/progress.md", S.START in text and "`me/hub-state.json`" in text)
    check("runtime: the tutor's notes live in <course>/me/", T.memory_file(cdir) == cdir / "me" / "tutor-memory.md")
    stray = [p for p in tmp.rglob("*") if p.is_file() and len(p.relative_to(tmp).parts) > 1
             and p.relative_to(tmp).parts[1] not in ("course.json", "me")]
    check("runtime: nothing written outside the courses' me/ folders", not stray, stray)


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
    check("transcribe_audio: < 0.3 s -> ''", V.transcribe_audio(np.zeros(4000, np.float32)) == "")
    check("whisper runs on 6 threads", V.WHISPER_THREADS == 6)


# ---------------------------------------------------------------- dictation written down while you talk (dictation.py)

def tone(s):
    t = np.arange(round(s * 16000)) / 16000
    return (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)


def quiet(s):
    return np.zeros(round(s * 16000), np.float32)


def pcm(x):
    return (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()


def feed(d, x, seq=0, step=0.3, sync=None):
    """Send x to a dictation in step-second chunks, as the browser does; returns the next seq. sync: run after each
    chunk (to let the worker take a piece before the next is cut, so no two pieces share a call)."""
    n = round(step * 16000)
    for i in range(0, len(x), n):
        d.add(pcm(x[i:i + n]), seq)
        seq += 1
        if sync:
            sync()
    return seq


def cuts(d):
    """The pieces d cuts, in seconds, as they're queued (whatever the worker then joins into one call)."""
    out, put = [], d._q.put

    def rec(item, *a, **kw):
        if isinstance(item, np.ndarray):
            out.append(len(item) / 16000)
        put(item, *a, **kw)
    d._q.put = rec
    return out


def taken(w, pieces):
    """A sync for feed(): wait until the worker has called Whisper for every piece cut so far."""
    return lambda: until(lambda: len(w.calls) >= len(pieces), 2)


def fake_speech(a):
    """Speech = runs where the signal isn't silent (a tone's zero crossings don't split a run)."""
    on = np.flatnonzero(np.abs(a) > 0.01)
    if not len(on):
        return []
    br = np.flatnonzero(np.diff(on) > 1600)
    return list(zip(np.r_[on[0], on[br + 1]].tolist(), np.r_[on[br] + 1, on[-1] + 1].tolist()))


class FakeWhisper:
    """Records (seconds, prompt) per call and answers p1, p2…; gate: an Event every call waits on."""
    def __init__(self, reply=None, gate=None):
        self.calls, self.reply, self.gate = [], reply, gate

    def __call__(self, audio, prompt=""):
        self.calls.append((len(audio) / 16000, prompt))
        if self.gate:
            self.gate.wait(5)
        n = len(self.calls)
        return self.reply(n) if self.reply else f"p{n}"


def until(cond, s=1.0):
    end = time.time() + s
    while not cond() and time.time() < end:
        time.sleep(0.01)
    return cond()


def status_of(fn):
    try:
        fn()
    except V.VoiceError as e:
        return e.status
    return None


THREE = np.r_[tone(5), quiet(1), tone(5), quiet(1), tone(2)]       # three pieces: two cut at pauses, one at finish
FOUR = np.r_[tone(5), quiet(1), tone(5), quiet(1), tone(5), quiet(1), tone(5), quiet(1)]


def test_dictation():
    import dictation as D
    with Patch((D, "SPEECH", fake_speech)):
        w = FakeWhisper()
        with Patch((D, "TRANSCRIBE", w)):
            d = D.Dictation()
            feed(d, np.r_[tone(5), quiet(0.8)])
            until(lambda: w.calls)
            check("dictation: pause sends the piece before it", len(w.calls) == 1 and 5.0 <= w.calls[0][0] <= 5.4, w.calls)
            d.cancel()

        w = FakeWhisper()
        with Patch((D, "TRANSCRIBE", w)):
            d = D.Dictation()
            seq = feed(d, np.r_[tone(2), quiet(0.8)])
            time.sleep(0.2)
            waited = not w.calls
            feed(d, np.r_[tone(3), quiet(0.8)], seq)
            until(lambda: w.calls)
            check("dictation: short pause-separated bits wait", waited and len(w.calls) == 1 and 5.0 <= w.calls[0][0] <= 6.4, w.calls)
            d.cancel()

        w = FakeWhisper()
        with Patch((D, "TRANSCRIBE", w)):
            d = D.Dictation()
            feed(d, tone(20))
            until(lambda: w.calls)
            check("dictation: no pause: cut by 12 s", w.calls and all(c[0] <= 12.0 for c in w.calls), w.calls)
            d.cancel()

        w = FakeWhisper()
        with Patch((D, "TRANSCRIBE", w)):
            d = D.Dictation()
            small = cuts(d)
            feed(d, THREE, sync=taken(w, small))
            check("dictation: finish returns the pieces in order", d.finish() == "p1 p2 p3", w.calls)

        w = FakeWhisper()
        with Patch((D, "TRANSCRIBE", w)):
            d = D.Dictation()
            big = cuts(d)
            feed(d, THREE, step=len(THREE) / 16000)
            d.finish()
            check("dictation: big chunk cuts like small ones",
                  len(big) == len(small) == 3 and all(abs(a - b) <= 0.05 for a, b in zip(small, big)), f"{small} vs {big}")

        w = FakeWhisper()
        with Patch((D, "TRANSCRIBE", w)):
            d = D.Dictation("Price elasticity")
            feed(d, FOUR[:round(12 * 16000)], sync=taken(w, cuts(d)))
            until(lambda: len(w.calls) >= 2)
            p = w.calls[1][1] if len(w.calls) > 1 else ""
            check("dictation: prompt carries hint and text so far", "Price elasticity" in p and p.endswith("p1"), w.calls)
            d.cancel()

        forty = " ".join(f"w{i}" for i in range(1, 41))
        for n_words, want in ((D.CONTEXT_WORDS, "Price elasticity " + " ".join(f"w{i}" for i in range(41 - D.CONTEXT_WORDS, 41))),
                              (0, "Price elasticity")):
            w = FakeWhisper(reply=lambda n: forty if n == 1 else f"p{n}")
            with Patch((D, "TRANSCRIBE", w), (D, "CONTEXT_WORDS", n_words)):
                d = D.Dictation("Price elasticity")
                feed(d, FOUR[:round(12 * 16000)], sync=taken(w, cuts(d)))
                until(lambda: len(w.calls) >= 2)
                p = w.calls[1][1] if len(w.calls) > 1 else None
                name = "context is the last whole words" if n_words else "CONTEXT_WORDS = 0 sends the hint alone"
                check(f"dictation: {name}", p == want, repr(p))
                d.cancel()

        w = FakeWhisper()
        with Patch((D, "TRANSCRIBE", w)):
            d = D.Dictation()
            feed(d, np.r_[tone(5), quiet(5), tone(5)], sync=taken(w, cuts(d)))
            d.finish()
            check("dictation: long silence is never transcribed", len(w.calls) == 2 and all(c[0] <= 6 for c in w.calls), w.calls)

        w = FakeWhisper()
        with Patch((D, "TRANSCRIBE", w)):
            d = D.Dictation()
            feed(d, quiet(4))
            check("dictation: silence only", d.finish() == "" and not w.calls, w.calls)

            d = D.Dictation()
            check("dictation: seq out of order -> 409", status_of(lambda: d.add(pcm(quiet(0.3)), 1)) == 409)
            check("dictation: odd bytes -> 400", status_of(lambda: d.add(b"\0\0\0", 0)) == 400)
            check("dictation: over 130 s -> 413", status_of(lambda: feed(d, quiet(131), step=1)) == 413)
            d.cancel()

        gate = threading.Event()
        w = FakeWhisper(gate=gate)
        with Patch((D, "TRANSCRIBE", w)):
            d = D.Dictation()
            seq = feed(d, FOUR[:round(6 * 16000)])
            started = until(lambda: w.calls) and len(w.calls) == 1     # the worker is busy with the first piece
            feed(d, FOUR[round(6 * 16000):], seq)
            gate.set()
            text = d.finish()
            check("dictation: a busy worker merges what queued up",
                  started and len(w.calls) == 2 and 15 <= w.calls[1][0] <= D.MAX_CALL_S and text == "p1 p2", f"{w.calls} {text!r}")

        gate = threading.Event()
        w = FakeWhisper(gate=gate)
        with Patch((D, "TRANSCRIBE", w)):
            sid = D.start("")
            d = D.get(sid)
            feed(d, FOUR[:round(12 * 16000)])
            until(lambda: w.calls)
            d.cancel()
            gate.set()
            time.sleep(0.3)
            check("dictation: cancel: nothing transcribed after", len(w.calls) <= 1 and status_of(lambda: D.get(sid)) == 404, w.calls)

        def boom(audio, prompt=""):
            raise RuntimeError("model fell over")
        with Patch((D, "TRANSCRIBE", boom)):
            d = D.Dictation()
            feed(d, THREE)
            check("dictation: a failed piece -> finish 503", status_of(d.finish) == 503)

        with Patch((D, "IDLE_S", 0)):
            a = D.start("")
            b = D.start("")
            check("dictation: idle session expires", status_of(lambda: D.get(a)) == 404 and D.get(b) is not None)
            D.drop(b)

        def finishing(d):
            """finish() on a thread, while the gated fake holds the worker; -> (thread, box with "text" or "status")."""
            box = {}

            def run():
                try:
                    box["text"] = d.finish()
                except V.VoiceError as e:
                    box["status"] = e.status
            t = threading.Thread(target=run, daemon=True)
            t.start()
            return t, box

        gate = threading.Event()
        w = FakeWhisper(gate=gate)
        with Patch((D, "TRANSCRIBE", w)):
            sid = D.start("")
            d = D.get(sid)
            feed(d, THREE)
            t, box = finishing(d)
            until(lambda: d.finishing and w.calls)
            with Patch((D, "IDLE_S", 0)):
                other = D.start("")         # its sweep finds sid idle, but it is being finished
            gate.set()
            t.join(5)
            check("dictation: the idle sweep leaves a finishing session alone",
                  not d.cancelled and box.get("text", "").startswith("p1"), f"{box} {w.calls}")
            D.drop(other)

        gate = threading.Event()
        w = FakeWhisper(gate=gate)
        with Patch((D, "TRANSCRIBE", w)):
            d = D.Dictation()
            feed(d, THREE)
            t, box = finishing(d)
            until(lambda: d.finishing and w.calls)
            d.cancel()
            gate.set()
            t.join(5)
            check("dictation: cancelled during finish -> 503", box == {"status": 503}, box)

        gate = threading.Event()
        w = FakeWhisper(gate=gate)
        with Patch((D, "TRANSCRIBE", w)):
            d = D.Dictation()
            feed(d, THREE)
            until(lambda: w.calls)
            check("dictation: finish timeout -> 503", status_of(lambda: d.finish(timeout=0.2)) == 503)
            gate.set()


def test_dictation_http():
    import http.client, json
    import dictation as D
    import server

    def post(path, body, ctype="application/json"):
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        c.request("POST", path, body if isinstance(body, bytes) else json.dumps(body), {"Content-Type": ctype})
        r = c.getresponse()
        out = r.status, json.loads(r.read() or b"{}")
        c.close()
        return out

    def chunk(sid, seq, data):
        return post(f"/api/voice/dictate/chunk?id={sid}&seq={seq}", data, "application/octet-stream")

    srv = server.Server(("127.0.0.1", 0), server.Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    w = FakeWhisper()
    try:
        with Patch((D, "SPEECH", fake_speech), (D, "TRANSCRIBE", w), (server.V, "warm", lambda: None)):
            st, r = post("/api/voice/dictate/start", {"course": "nope", "tag": "", "n": 1, "scope": "slide"})
            sid = r.get("id")
            check("http dictate: start -> id", st == 200 and isinstance(sid, str) and len(sid) >= 8, r)
            first = THREE[:round(6 * 16000)]
            st, r = chunk(sid, 0, pcm(first))
            until(lambda: len(w.calls) == 1)        # (so the next piece isn't joined to this one in one call)
            check("http dictate: chunk -> 200 with text", st == 200 and isinstance(r.get("text"), str), (st, r))
            st, r = chunk(sid, 5, pcm(quiet(0.3)))
            check("http dictate: chunk wrong seq -> 409", st == 409 and r.get("error"), (st, r))
            st, r = chunk("nope", 0, pcm(quiet(0.3)))
            check("http dictate: chunk unknown id -> 404", st == 404 and r.get("error"), (st, r))
            st, r = chunk(sid, 1, b"\0" * 2_000_000)
            check("http dictate: chunk 2 MB -> 413", st == 413 and r.get("error"), (st, r))
            st, r = chunk(sid, 1, pcm(THREE[len(first):]))
            until(lambda: len(w.calls) == 2)
            st, r = post("/api/voice/dictate/finish", {"id": sid})
            check("http dictate: finish -> joined text", st == 200 and r.get("text") == "p1 p2 p3", (st, r, w.calls))
            st, r = post("/api/voice/dictate/finish", {"id": sid})
            check("http dictate: finished id -> 404", st == 404, (st, r))
            st, r = post("/api/voice/dictate/cancel", {"id": "nope"})
            check("http dictate: cancel unknown id -> ok", st == 200 and r == {"ok": True}, (st, r))
            buf = io.BytesIO()
            with wave.open(buf, "wb") as f:
                f.setnchannels(1)
                f.setsampwidth(2)
                f.setframerate(16000)
                f.writeframes(pcm(quiet(0.2)))      # under 0.3 s: answered without loading the models
            st, r = post("/api/voice/transcribe", {"course": "nope", "audio": base64.b64encode(buf.getvalue()).decode()})
            check("http dictate: transcribe route still works", st == 200 and r == {"text": ""}, (st, r))
    finally:
        srv.shutdown()
        srv.server_close()

    with tempfile.TemporaryDirectory() as lib, Patch((L, "ROOT", Path(lib))):     # a demo course with one deck
        c = make_course(Path(lib), "Demo-Course", code="DEMO101", title="Demo Course")
        tag = "S&D-1"
        deck = c / "decks" / L.safe_tag(tag)
        deck.mkdir(parents=True)
        (deck / "deck.json").write_text(json.dumps({"tag": tag, "title": "Supply and Demand 1", "role": "lecture", "week": 1,
                                                    "topic": "Supply and Demand", "order": 0, "pages": 60, "prepared": True}), encoding="utf-8")
        (deck / "transcript.md").write_text("".join(f"## [{tag} s{n}] Price elasticity, part {n}\n\nText {n}.\n\n"
                                                    for n in range(1, 61)), encoding="utf-8")
        d = L.deck(c, tag)
        s = next((x for x in L.slide_texts(c, tag) if x["title"] and x["title"] != d["title"]), None)
        got = server._voice_hint({"course": c.name, "tag": tag, "n": s["n"], "scope": "slide"})
        want = f"{d['title']}. {s['title']}"
        check("voice hint: slide scope is the deck title. the slide title", got == want, f"{got!r} vs {want!r}")
        got = server._voice_hint({"course": c.name, "tag": tag, "n": 1, "scope": "deck"})
        check("voice hint: deck scope fits ~600 chars and ends with the deck title",
              got.endswith(d["title"]) and len(got) <= 600 + len(". " + d["title"]) and "part 60" in got, f"{len(got)} {got[-80:]!r}")
        check("voice hint: unknown course -> ''", server._voice_hint({"course": "nope", "tag": tag}) == "")


def test_stream_round_trip():
    """Kokoro says two sentences with a pause between; they're streamed in at real-time pace like the browser does."""
    import dictation as D
    one = "Demand falls as the price rises, and supply rises with it, until the two curves meet."
    two = "That meeting point is the equilibrium price, where the amount bought equals the amount sold."
    hint = "Supply and Demand. Price elasticity"
    clips = []
    for s in (one, two):
        with wave.open(io.BytesIO(to_16k_mono(V.speak(s, "af_heart", 1.0)))) as w:
            clips.append(np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768)
    audio = np.r_[clips[0], np.zeros(16000, np.float32), clips[1]]
    d = D.Dictation(hint)
    n = round(0.3 * 16000)
    for seq, i in enumerate(range(0, len(audio), n)):
        d.add(pcm(audio[i:i + n]), seq)
        time.sleep(0.3)
    t0 = time.time()
    heard = d.finish()
    t1 = time.time()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm(audio))
    t2 = time.time()
    V.transcribe(buf.getvalue(), hint)
    t3 = time.time()
    exp, got = words(one + " " + two), words(heard)
    overlap = sum(min(exp.count(x), got.count(x)) for x in set(exp)) / len(exp)
    print(f"      heard: {heard}\n      overlap {overlap:.0%}  ({len(audio) / 16000:.1f} s clip: finish {t1 - t0:.1f}s "
          f"after the last chunk; the whole clip in one transcribe() {t3 - t2:.1f}s)")
    check("stream round trip: >= 80% of the words heard back", overlap >= 0.8, f"{overlap:.0%}")
    check("stream round trip: finish() < 5 s after the last chunk", t1 - t0 < 5, f"{t1 - t0:.1f}s")


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
    with tempfile.TemporaryDirectory() as d, Patch((L, "ROOT", Path(d))):     # the temp folder is the library
        tmp = Path(d)
        test_voice_prompt(tmp)
        test_memory_text(tmp)
        test_remember(tmp)
        test_chat_turn(tmp)
        test_engine_turns()
        test_chat_turn_scope(tmp)
        test_slash_extra(tmp)
        test_drawing_first_prompts()
        test_spoken_flag(tmp)
        test_practice_focus(tmp)
        test_runtime_data(tmp)
    test_voice_errors()
    test_dictation()
    test_dictation_http()
    if "--no-models" not in sys.argv:
        test_round_trip()
        test_stream_round_trip()
    print(f"\n{len(FAILED)} failed" + (": " + ", ".join(FAILED) if FAILED else ""))
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
