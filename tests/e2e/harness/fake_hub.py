"""Run the hub for end-to-end tests, with every outside dependency replaced by a scripted double.

    python tests/e2e/harness/fake_hub.py --library <library copy> --work <scratch dir> [--phone-url URL] [--port N]

This file is THE ONLY place the end-to-end suite touches the app's internals. Everything else in tests/e2e drives
the app through the browser and over HTTP. When the app is rewritten, re-implement this launcher for the new code
(same command line, same files in --work) and the whole suite should run unchanged. The contract is in
tests/e2e/README.md ("The test double contract").

What is replaced:
  - the AI model (Claude Code / OpenCode engines): answers come from <work>/model-script.json; every call is
    appended to <work>/model-calls.jsonl
  - the OpenCode model catalogue: a fixed two-model list
  - speech: models are "ready" at once; speech-to-text answers from the script (label "stt"); text-to-speech
    returns a short silent WAV; each spoken sentence is logged to <work>/speak-calls.jsonl
  - the hub's own scratch files (log, usage history) go to <work>/cache instead of the repo's .cache

The hub listens on 127.0.0.1 on a free port, written to <work>/port once it is accepting connections.
"""
import argparse, io, json, os, re, sys, threading, time, uuid, wave
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]

ap = argparse.ArgumentParser()
ap.add_argument("--library", required=True)
ap.add_argument("--work", required=True)
ap.add_argument("--phone-url", default=None)
ap.add_argument("--port", type=int, default=0, help="0: any free port")
ap.add_argument("--code", default=str(REPO), help="the hub's code folder (default: this repo)")
args = ap.parse_args()

WORK = Path(args.work).resolve()
WORK.mkdir(parents=True, exist_ok=True)
SCRIPT = WORK / "model-script.json"
CALLS = WORK / "model-calls.jsonl"
SPEAK = WORK / "speak-calls.jsonl"
os.environ["STUDY_HUB_ROOT"] = str(Path(args.library).resolve())
sys.path.insert(0, str(Path(args.code).resolve()))
os.chdir(WORK)

import server as SV          # noqa: E402
import tutor as T            # noqa: E402
import opencode_engine as OE  # noqa: E402
import voice as V            # noqa: E402
import dictation as DI       # noqa: E402

_lock = threading.Lock()
_used = {}      # rule index -> times used
_n = [0]        # model calls so far: makes every default answer (and duration) unique


# ---------------------------------------------------------------- the script

def _rules():
    try:
        return json.loads(SCRIPT.read_text(encoding="utf-8")).get("rules", [])
    except (OSError, ValueError):
        return []


def _pick(label, prompt, system):
    """The first rule that matches this call and still has uses left (and count the use)."""
    with _lock:
        for i, r in enumerate(_rules()):
            m = r.get("match") or {}
            if "label" in m and not re.search(m["label"], label or ""):
                continue
            if "prompt" in m and not re.search(m["prompt"], prompt or "", re.S | re.I):
                continue
            if "system" in m and not re.search(m["system"], system or "", re.S | re.I):
                continue
            key = (i, json.dumps(r, sort_keys=True))
            if r.get("times") is not None and _used.get(key, 0) >= r["times"]:
                continue
            _used[key] = _used.get(key, 0) + 1
            return r.get("reply") or {}
    return None


def _fake_value(name, spec):
    t = spec.get("type")
    if "enum" in spec:
        return spec["enum"][0]
    if t == "boolean":
        return name != "unreadable"
    if t in ("integer", "number"):
        return 1
    if t == "array":
        n = max(spec.get("minItems", 2), 1)
        return [f"Fake {name} {i + 1}" for i in range(n)]
    if t == "object":
        return {k: _fake_value(k, v) for k, v in (spec.get("properties") or {}).items()}
    return f"Fake {name}."


def default_json(schema):
    return {k: _fake_value(k, v) for k, v in (schema.get("properties") or {}).items()}


def _log(path, row):
    with _lock, open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _wait_release(name, timeout=60):
    flag = WORK / f"release-{name}"
    end = time.time() + timeout
    while time.time() < end and not flag.exists():
        time.sleep(0.05)


# ---------------------------------------------------------------- the model double

def fake_engine(cdir, system, prompt, *, model, session, fork, schema, web, label, chat_key, emit):
    label = re.sub(r" course=.*$", "", label or "")
    with _lock:
        _n[0] += 1
        n = _n[0]
    _log(CALLS, {"t": time.time(), "label": label, "model": model, "schema": bool(schema), "web": web,
                 "session": session, "fork": fork, "chat_key": list(chat_key) if chat_key else None,
                 "course": cdir.name if cdir else None, "prompt": prompt, "system": system})
    reply = _pick(label, prompt, system)
    if reply is None:
        reply = {}
    if reply.get("wait_for"):
        _wait_release(reply["wait_for"])
    for s in reply.get("status", ["Thinking"]):
        if emit:
            emit("status", s)
    if reply.get("wait_after_status"):      # the status lines show while the reply is held back
        _wait_release(reply["wait_after_status"])
    if reply.get("crash"):                  # not a model error: something unexpected went wrong in the hub
        raise RuntimeError("fake unexpected failure")
    if reply.get("error"):
        raise T.TutorError(reply["error"], reply.get("error_status", 502))
    text = reply.get("text")
    if text is None:
        text = f"Fake answer {n} for {label}.\n\nFAKE-END"
    if emit and not schema or (emit and reply.get("stream_json_text")):
        chunks = reply.get("chunks") or re.split(r"(?<=\n)", text)
        for c in chunks:
            if reply.get("chunk_delay_ms"):
                time.sleep(reply["chunk_delay_ms"] / 1000)
            emit("text", c)
    if reply.get("error_after_text"):       # part of the answer streamed, then the model failed
        raise T.TutorError(reply["error_after_text"], reply.get("error_status", 502))
    js = None
    if schema:
        js = reply.get("json") if reply.get("json") is not None else default_json(schema)
    tokens = reply.get("tokens") or {"in": 1000, "cache_read": 200, "cache_write": 100, "out": 300}
    return {"text": text, "json": js, "session": session or f"fake-{uuid.uuid4().hex[:8]}",
            "ms": reply.get("ms", 1000 + n), "cost": reply.get("cost", 0.0123), "tokens": tokens}


T._run_engine = fake_engine
T.open_chat = lambda *a, **k: None
T.close_chat = lambda *a, **k: None
T.WORK = WORK / "cache"
T.USAGE_FILE = T.WORK / "usage.jsonl"
OE.known_models = lambda *a, **k: [
    {"id": "opencode/fake-big", "label": "Fake Big", "iq": 60, "provider": "OpenCode"},
    {"id": "opencode/fake-small", "label": "Fake Small", "iq": 40, "provider": "OpenCode"},
]
OE.shutdown = lambda *a, **k: None


# ---------------------------------------------------------------- the speech double

def _silent_wav(seconds=0.2, rate=24000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\0\0" * int(rate * seconds))
    return buf.getvalue()


def fake_stt(audio=None, prompt=""):
    reply = _pick("stt", prompt, "") or {}
    _log(CALLS, {"t": time.time(), "label": "stt", "prompt": prompt, "samples": len(audio) if audio is not None else 0})
    if reply.get("error"):
        raise V.VoiceError(reply["error"], reply.get("error_status", 503))
    return reply.get("text", "fake spoken question")


def fake_speak(text, voice=V.DEFAULT_VOICE, speed=1.0):
    _log(SPEAK, {"t": time.time(), "text": text, "voice": voice, "speed": speed})
    return _silent_wav()


V.warm = lambda *a, **k: None
V.downloaded = lambda: True
V.status = lambda: {"ready": True, "loading": False, "error": None, "downloaded": True, "voices": V.VOICES,
                    "default_voice": V.DEFAULT_VOICE}
V.transcribe = lambda wav_bytes, hint="": fake_stt(None, hint)
V.transcribe_audio = fake_stt
V.speak = fake_speak
DI.TRANSCRIBE = fake_stt
DI.SPEECH = lambda audio: [(0, len(audio))] if len(audio) > 1600 else []


# ---------------------------------------------------------------- serve

SV.PHONE_URL = args.phone_url
srv = SV.Server(("127.0.0.1", args.port), SV.Handler)
(WORK / "port").write_text(str(srv.server_address[1]))
print(f"fake hub on http://127.0.0.1:{srv.server_address[1]}/", flush=True)
try:
    srv.serve_forever()
except KeyboardInterrupt:
    pass
