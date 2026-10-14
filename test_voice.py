"""Checks for the Talk (voice) feature. A plain script, no test framework:

    python test_voice.py              # everything (loads the speech models: ~10 s warm, longer the first time)
    python test_voice.py --no-models  # only the checks that need no models and no Claude

Nothing here calls Claude (run_claude is replaced) or touches a real course: chats, memory and state live in a
temporary folder.
"""
import io, re, sys, tempfile, threading, time, types, wave
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
                    (S, "chat_for", lambda c, tag: state.get(tag)),
                    (S, "set_chat", lambda c, tag, cid: state.__setitem__(tag, cid)))

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
        chat = T.load_chat(state.get("S&D-2"))
        qs = [m["text"] for m in (chat or {}).get("messages", []) if m["role"] == "q"]
        check("chat_turn: two new overlapping turns -> one chat", len(files) == 1, [f.name for f in files])
        check("chat_turn: both Q/A pairs saved", sorted(qs) == ["Q1", "Q2"] and len(chat["messages"]) == 4, qs)
        check("chat_turn: both turns used the same chat client", calls[0][1] == calls[1][1], calls)
        check("chat_turn: session is the last finished turn's", chat["session"] == "sess-Q1", chat.get("session"))
        check("chat_turn: nothing left pending", not T._PENDING)
        overlapped("Q3", "Q4")
        chat = T.load_chat(state.get("S&D-2"))
        qs = [m["text"] for m in chat["messages"] if m["role"] == "q"]
        check("chat_turn: overlapping turns on an existing chat both saved", sorted(qs[:2]) == ["Q1", "Q2"]
              and sorted(qs[2:]) == ["Q3", "Q4"], qs)
        check("chat_turn: messages pair up", all(m["text"] == f"answer to {q['text']}" for q, m in
                                                 zip(chat["messages"][::2], chat["messages"][1::2])))

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
    test_voice_errors()
    if "--no-models" not in sys.argv:
        test_round_trip()
    print(f"\n{len(FAILED)} failed" + (": " + ", ".join(FAILED) if FAILED else ""))
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
