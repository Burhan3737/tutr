"""How the tutor talks to OpenCode: the OpenCode server API (the API its SDK wraps), no extra packages.

OpenCode is a second engine next to Claude (engine.py), chosen per model: a model id with a provider slash
("opencode/big-pickle", "google/gemini-4-argon") runs here; a plain id ("claude-opus-5-5") goes to Claude.

- One private `opencode serve` process per hub, on a free local port with a generated password (HTTP Basic,
  user "opencode"). It starts on the first OpenCode model list or turn and lives until the hub shuts down.
- A chat is one OpenCode session, kept on the server so a saved chat resumes by its session id. Turns on one
  chat take that chat's lock, so they run one after another, as with the Claude engine.
- The hub's system prompt goes in through a session instruction entry (updated only when its hash changes).
  Alone it is ~100 kB, too long for a command line, and this keeps it out of every user message.
- Tools are confined by the session's permission rules: everything denied, then Read/Grep/Glob allowed (and
  WebSearch/WebFetch when web is on), with external_directory and the student's private files (me/private/)
  denied. The session's working directory is the course folder.
- Answers stream off the shared /api/event SSE feed (text deltas, tool calls, step costs, execution end), with
  polling the message list as a fallback. The final text is read back from the session's messages, so a missed
  delta never truncates a saved answer.
- Structured output (practice, marking, the tutor's memory) is emulated: the prompt asks for one JSON object
  matching the schema, and the reply is parsed (once more if it isn't valid JSON).
- A one-off call (practice, marking, a one-off memory update) uses a temporary session, deleted afterwards.
  Side questions fork the chat's session, so they know the conversation and leave it untouched.
"""
import base64, hashlib, json, os, re, secrets, shutil, socket, subprocess, threading, time, urllib.error, urllib.request
from pathlib import Path

import engine

HERE = Path(__file__).resolve().parent
WORK = HERE / ".cache"
MODELS_FILE = WORK / "opencode-models.json"
INSTRUCTIONS_KEY = "study-hub"
START_TIMEOUT = 30
MODELS_TTL = 86400              # a day: model lists change slowly; a stale list is refreshed in the background
SSE_TIMEOUT = 3600

EngineError = engine.EngineError
TIMEOUT = engine.TIMEOUT
QUEUE_TIMEOUT = engine.QUEUE_TIMEOUT

_NOOP = lambda kind, data: None


# ---------------------------------------------------------------- the server process

_SERVER = None                  # {"base", "auth", "proc", "log"}
_SERVER_LOCK = threading.Lock()
_SHUTDOWN = False


def _exe():
    """The opencode command, or None. On Windows npm installs a .cmd, which needs cmd.exe to run."""
    for name in ("opencode", "opencode.cmd", "opencode.exe"):
        p = shutil.which(name)
        if p:
            return p
    return None


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _log(msg):
    try:
        WORK.mkdir(exist_ok=True)
        with open(WORK / "hub.log", "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + f"opencode: {msg}\n")
    except OSError:
        pass


def _reader(proc, state, ready):
    try:
        for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                state["log"].append(line)
                del state["log"][:-40]
            m = re.search(r"server listening on\s+(https?://\S+)", line)
            if m and not ready.is_set():
                state["base"] = m.group(1).rstrip("/")
                ready.set()
            m = re.search(r"server password[:\s]+(\S+)", line, re.I)
            if m:
                state["password"] = m.group(1)
    except (OSError, ValueError):
        pass
    ready.set()             # the process ended or closed its output: stop waiting


def _ensure_server():
    """The running server, starting it if needed. Raises EngineError when OpenCode can't start."""
    global _SERVER
    with _SERVER_LOCK:
        if _SHUTDOWN:
            raise EngineError("The hub is shutting down.", 503)
        if _SERVER and _SERVER["proc"].poll() is None:
            return _SERVER
        exe = _exe()
        if not exe:
            raise EngineError("OpenCode isn't installed or isn't on PATH. Install it, then restart the hub.", 500)
        password = secrets.token_urlsafe(32)
        port = _free_port()
        cmd = [exe, "serve", "--hostname", "127.0.0.1", "--port", str(port)]
        if os.name == "nt" and exe.lower().endswith((".cmd", ".bat")):
            cmd = ["cmd", "/c"] + cmd
        env = dict(os.environ)
        env["OPENCODE_SERVER_PASSWORD"] = password
        env["OPENCODE_PASSWORD"] = password
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    env=env, creationflags=flags)
        except OSError as e:
            raise EngineError(f"OpenCode couldn't start: {e}", 500)
        state = {"base": f"http://127.0.0.1:{port}", "password": password, "proc": proc, "log": [], "stop": None}
        ready = threading.Event()
        threading.Thread(target=_reader, args=(proc, state, ready), daemon=True, name="opencode-log").start()
        if not ready.wait(START_TIMEOUT) or proc.poll() is not None:
            tail = " | ".join(state["log"][-3:])
            try:
                proc.kill()
            except OSError:
                pass
            raise EngineError("OpenCode didn't start." + (f" {tail[:300]}" if tail else ""), 503)
        state["auth"] = "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode()
        state["stop"] = threading.Event()
        _SERVER = state
        _SESSIONS.clear()
        threading.Thread(target=_listen, args=(state,), daemon=True, name="opencode-events").start()
        _log(f"server up at {state['base']}")
        return state


def _http(method, path, body=None, timeout=90, base=None, auth=None):
    """(status, parsed body), or (None, repr(error)) when the connection failed."""
    if base is None:
        srv = _ensure_server()
        base, auth = srv["base"], srv["auth"]
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "Authorization": auth})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except (ValueError, TypeError):
            return e.code, raw
    except Exception as e:
        return None, repr(e)


def _call(method, path, body=None, timeout=90):
    st, payload = _http(method, path, body, timeout)
    if st is None:
        raise EngineError("OpenCode isn't responding. Try again.", 503)
    if st >= 400:
        msg = payload.get("error") if isinstance(payload, dict) else payload
        if isinstance(msg, dict):
            msg = msg.get("message") or msg.get("name")
        msg = str(msg or "")
        raise EngineError(f"OpenCode: {msg[:300]}" if msg else f"OpenCode returned {st}.", 502)
    return payload


def shutdown():
    """Stop the private server, e.g. when the hub stops."""
    global _SERVER, _SHUTDOWN
    _SHUTDOWN = True
    with _SERVER_LOCK:
        srv, _SERVER = _SERVER, None
    if not srv:
        return
    try:
        if srv.get("stop"):
            srv["stop"].set()
        srv["proc"].terminate()
        try:
            srv["proc"].wait(5)
        except subprocess.TimeoutExpired:
            srv["proc"].kill()
    except OSError:
        pass
    _SESSIONS.clear()
    with _TURNS_LOCK:
        for turn in _TURNS.values():
            turn.finish(False, "OpenCode was shut down.")
        _TURNS.clear()


# ---------------------------------------------------------------- the event stream

_TURNS = {}                     # session id -> the turn waiting for that session
_TURNS_LOCK = threading.Lock()


class _Turn:
    def __init__(self, sid, cdir, emit):
        self.sid, self.cdir, self.emit = sid, cdir, emit
        self.done = threading.Event()
        self.ok = None
        self.error = None
        self.cost = 0.0
        self.parts = []
        self.thinking_said = False
        self.started = time.time() * 1000

    def text(self, delta):
        self.parts.append(delta)
        try:
            self.emit("text", delta)
        except Exception:
            pass

    def thinking(self):
        if not self.thinking_said:
            self.thinking_said = True
            try:
                self.emit("status", "Thinking it through")
            except Exception:
                pass

    def tool(self, name, args):
        try:
            self.emit("status", _describe(name, args, self.cdir))
        except Exception:
            pass

    def finish(self, ok, error=None):
        if self.ok is None:
            self.ok, self.error = bool(ok), error
        self.done.set()


def _listen(state):
    """Read /api/event for as long as this server lives, reconnecting after a drop."""
    stop = state["stop"]
    delay = 0.2
    while not stop.is_set():
        req = urllib.request.Request(state["base"] + "/api/event",
                                     headers={"Authorization": state["auth"], "Accept": "text/event-stream"})
        try:
            with urllib.request.urlopen(req, timeout=SSE_TIMEOUT) as r:
                delay = 0.2
                for raw in r:
                    if stop.is_set():
                        return
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    try:
                        ev = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    if isinstance(ev, dict):
                        _dispatch(ev)
        except Exception:
            if stop.is_set():
                return
            time.sleep(min(delay, 5))
            delay = min(delay * 2, 5)


def _dispatch(ev):
    ty = ev.get("type") or ""
    d = ev.get("data") or {}
    sid = d.get("sessionID")
    if not sid:
        return
    with _TURNS_LOCK:
        turn = _TURNS.get(sid)
    if not turn:
        return
    if ty == "session.text.delta":
        turn.text(str(d.get("delta") or ""))
    elif ty == "session.reasoning.started":
        turn.thinking()
    elif ty == "session.tool.called":
        turn.tool(str(d.get("name") or ""), d.get("input") or {})
    elif ty == "session.step.ended":
        try:
            turn.cost += float(d.get("cost") or 0)
        except (TypeError, ValueError):
            pass
    elif ty == "session.execution.succeeded":
        turn.finish(True)
    elif ty == "session.execution.failed":
        err = d.get("error")
        msg = err.get("message") if isinstance(err, dict) else str(err or "")
        turn.finish(False, f"OpenCode stopped: {msg[:300]}" if msg else "OpenCode stopped before answering. Try again.")
    elif ty == "session.execution.interrupted":
        turn.finish(False, "That answer was stopped. Try again.")


def _describe(name, args, cdir):
    """A short, human status line for an OpenCode tool call (the hub's wording, from engine.describe)."""
    name, args = (name or "").lower(), args or {}
    if name in ("read", "read_file"):
        return engine.describe("Read", {"file_path": args.get("path") or args.get("file_path") or args.get("filePath", "")}, cdir)
    if name in ("grep", "search"):
        return engine.describe("Grep", {"pattern": args.get("pattern") or args.get("query", "")}, cdir)
    if name in ("glob", "find", "list"):
        return engine.describe("Glob", {}, cdir)
    if name in ("websearch", "web_search"):
        return engine.describe("WebSearch", {"query": args.get("query") or args.get("q", "")}, cdir)
    if name in ("webfetch", "fetch", "web_fetch"):
        return engine.describe("WebFetch", {"url": args.get("url", "")}, cdir)
    return str(name or "Working").replace("_", " ").capitalize()


# ---------------------------------------------------------------- sessions

_SESSIONS = {}                  # session id -> {"hash", "model", "web"} last configured
_SESSIONS_LOCK = threading.Lock()
_CHATS = {}                     # chat key -> {"session", "lock"}
_CHATS_LOCK = threading.Lock()

# Never the student's private files (me/private/): denied after the allows (the last matching rule wins), with
# either path separator (Windows paths come with backslashes) and the usual letter cases (the match may be exact).
PRIVATE_PATTERNS = sorted({f"*{me}{sep}{pv}*" for sep in ("/", "\\") for me in ("me", "Me", "ME")
                           for pv in ("private", "Private", "PRIVATE")})
PERMISSIONS = [
    {"action": "*", "resource": "*", "effect": "deny"},
    {"action": "read", "resource": "*", "effect": "allow"},
    {"action": "glob", "resource": "*", "effect": "allow"},
    {"action": "grep", "resource": "*", "effect": "allow"},
    {"action": "external_directory", "resource": "*", "effect": "deny"},
] + [{"action": a, "resource": p, "effect": "deny"} for a in ("read", "glob", "grep") for p in PRIVATE_PATTERNS]
WEB_PERMISSIONS = PERMISSIONS + [{"action": "websearch", "resource": "*", "effect": "allow"},
                                 {"action": "webfetch", "resource": "*", "effect": "allow"}]


def _permissions(web):
    return [dict(r) for r in (WEB_PERMISSIONS if web else PERMISSIONS)]


def _ref(model):
    """'provider/id' -> {"providerID": provider, "id": id}."""
    provider, _, mid = str(model or "").partition("/")
    if not provider or not mid:
        raise EngineError(f"Not an OpenCode model id: {model}", 400)
    return {"providerID": provider, "id": mid}


def _chat(key):
    with _CHATS_LOCK:
        rec = _CHATS.get(key)
        if rec is None:
            rec = _CHATS[key] = {"session": None, "lock": threading.Lock()}
        return rec


def _exists(sid):
    st, _ = _http("GET", f"/api/session/{sid}", timeout=20)
    return st == 200


def _configure(sid, system, ref, web):
    """Bring a session's prompt, model and permissions in line, touching only what changed."""
    with _SESSIONS_LOCK:
        cfg = _SESSIONS.setdefault(sid, {})
    digest = hashlib.sha1((system or "").encode("utf-8")).hexdigest()
    if system is not None and cfg.get("hash") != digest:
        _call("PUT", f"/api/experimental/session/{sid}/instructions/entries/{INSTRUCTIONS_KEY}", {"value": system})
        cfg["hash"] = digest
    if cfg.get("model") != ref:
        _call("POST", f"/api/session/{sid}/model", {"model": ref})
        cfg["model"] = ref
    if cfg.get("web") != bool(web):
        _call("PATCH", f"/api/session/{sid}", {"permissions": _permissions(web)})
        cfg["web"] = bool(web)


def _prepare(cdir, system, ref, web, *, session=None, fork=False, title="Study Hub"):
    """The session to use: an existing one (forked if asked), or a new one. Raises EngineError."""
    _ensure_server()
    sid = session
    if fork and sid:
        if not _exists(sid):
            raise EngineError("That conversation can no longer be continued. Ask again.", 410)
        data = _call("POST", f"/api/session/{sid}/fork", {})
        new = (data or {}).get("data") or {}
        new_sid = new.get("id")
        if not new_sid:
            raise EngineError("OpenCode couldn't copy the conversation. Try again.", 502)
        with _SESSIONS_LOCK:
            _SESSIONS[new_sid] = dict(_SESSIONS.get(sid, {}))
        sid = new_sid
    elif sid and not _exists(sid):
        sid = None                       # gone (or from another engine): start fresh
    if not sid:
        body = {"title": title[:80],
                "location": {"directory": str(Path(cdir).resolve())},
                "model": ref,
                "permissions": _permissions(web)}
        data = _call("POST", "/api/session", body)
        sid = ((data or {}).get("data") or {}).get("id")
        if not sid:
            raise EngineError("OpenCode couldn't start that conversation. Try again.", 502)
        with _SESSIONS_LOCK:
            _SESSIONS[sid] = {"model": ref, "web": bool(web)}
    else:
        _configure(sid, system, ref, web)
        return sid
    _configure(sid, system, ref, web)
    return sid


# ---------------------------------------------------------------- one turn

SCHEMA_SUFFIX = """

Return your answer as one JSON object and nothing else: no Markdown fences, no text before or after it. It must
match this JSON Schema exactly (every required property present):

"""


def _json_from(text):
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j <= i:
        raise ValueError("no JSON object")
    return json.loads(t[i:j + 1])


def _messages(sid):
    data = _call("GET", f"/api/session/{sid}/message")
    return ((data or {}).get("data") or [])


def _poll_idle(turn):
    """Fallback when an execution-ended event was missed: is a new idle message there?"""
    try:
        msgs = _messages(turn.sid)
    except EngineError:
        return
    for m in msgs:
        if m.get("type") == "idle" and float((m.get("time") or {}).get("created") or 0) >= turn.started - 500:
            turn.finish(m.get("outcome") == "succeeded",
                        None if m.get("outcome") == "succeeded" else "OpenCode stopped before answering. Try again.")
            return


def _answer(sid, prompt, cdir, emit):
    """Send one prompt and wait for the answer. Returns (text, cost, tokens)."""
    turn = _Turn(sid, cdir, emit)
    with _TURNS_LOCK:
        _TURNS[sid] = turn
    since = time.time() * 1000
    try:
        _call("POST", f"/api/session/{sid}/prompt", {"text": prompt})
        deadline = time.time() + TIMEOUT
        polled = time.time()
        while not turn.done.is_set():
            if time.time() >= deadline:
                _http("POST", f"/api/session/{sid}/interrupt", timeout=10)
                raise EngineError("That took too long. Try again.", 504)
            turn.done.wait(0.5)
            if turn.done.is_set():
                break
            if time.time() - polled >= 3:
                polled = time.time()
                _poll_idle(turn)
        if not turn.ok:
            raise EngineError(turn.error or "OpenCode stopped before answering. Try again.", 502)
        streamed, cost = "".join(turn.parts), turn.cost
        final, read_cost, tokens = _read_back(sid, since)      # the deltas are only a live view; this is the answer
        if read_cost:
            cost = read_cost
        return (final or streamed), cost, tokens
    finally:
        with _TURNS_LOCK:
            if _TURNS.get(sid) is turn:
                _TURNS.pop(sid, None)


def _read_back(sid, since):
    """The turn's final text, cost and token counts from the session's messages (newest-first from the server)."""
    tokens = {"in": 0, "cache_read": 0, "cache_write": 0, "out": 0}
    try:
        msgs = _messages(sid)
    except EngineError:
        return "", 0.0, tokens
    got = [m for m in msgs if m.get("type") == "assistant"
           and float((m.get("time") or {}).get("created") or 0) >= since - 500]
    got.sort(key=lambda m: float((m.get("time") or {}).get("created") or 0))
    text = "".join(str(b.get("text") or "") for m in got for b in (m.get("content") or [])
                   if b.get("type") == "text")
    cost = 0.0
    for m in got:
        try:
            cost += float(m.get("cost") or 0)
            t = m.get("tokens") or {}
            cache = t.get("cache") or {}
            tokens["in"] += int(t.get("input") or 0)
            tokens["cache_read"] += int(cache.get("read") or 0)
            tokens["cache_write"] += int(cache.get("write") or 0)
            tokens["out"] += int(t.get("output") or 0) + int(t.get("reasoning") or 0)
        except (TypeError, ValueError, AttributeError):
            pass
    return text.strip(), cost, tokens


# ---------------------------------------------------------------- the public calls (the same shape as engine.py)

def run(cdir, system, prompt, *, model, web=True, schema=None, chat_key=None, session=None, fork=False, emit=None,
        log=None, label=""):
    """Ask an OpenCode model. chat_key set -> that chat's session; otherwise a one-off query.
    fork -> start from a copy of `session` (a side question): the original conversation is left untouched.
    Returns {"text", "json", "session", "ms", "cost", "tokens", "failed"}; raises EngineError, with .usage: what the
    failed answer used."""
    emit = emit or _NOOP
    log = log or _log
    t0 = time.time()
    ref = _ref(model)
    rec = None
    held = False
    ephemeral = session is None and not chat_key
    given_session = session
    if chat_key:
        rec = _chat(chat_key)
        if not rec["lock"].acquire(blocking=False):
            emit("status", "Waiting for the last answer to finish")
            if not rec["lock"].acquire(timeout=QUEUE_TIMEOUT):
                raise EngineError("That chat is still answering. Try again in a moment.", 503)
        held = True
        if session is None:
            session = rec.get("session")
    sid = None
    try:
        emit("status", "Opening the conversation")
        sid = _prepare(cdir, system, ref, web, session=session, fork=fork,
                       title=f"Study Hub · {getattr(cdir, 'name', 'course')}")
        if rec is not None:
            rec["session"] = sid
        if schema:
            text, cost, tokens = _answer(sid, prompt + SCHEMA_SUFFIX + json.dumps(schema, ensure_ascii=False), cdir, emit)
            try:
                obj = _json_from(text)
            except (ValueError, TypeError):
                retry = ("Your last reply could not be read as JSON. Answer the same request again, returning only "
                         "one JSON object matching the schema, with no Markdown fences and no other text.")
                text, cost2, tokens2 = _answer(sid, retry, cdir, emit)
                cost += cost2
                tokens = {k: tokens[k] + tokens2[k] for k in tokens}
                try:
                    obj = _json_from(text)
                except (ValueError, TypeError):
                    raise EngineError("OpenCode didn't return the required JSON. Try again.", 502)
        else:
            text, cost, tokens = _answer(sid, prompt, cdir, emit)
            obj = None
        if not (text or "").strip():
            raise EngineError("OpenCode stopped before answering. Try again.", 502)
        ms = int((time.time() - t0) * 1000)
        log(f"{label} {model} ms={ms} cost={cost:.4f} {engine.tokens_text(tokens)}")
        return {"text": text, "json": obj, "session": sid, "ms": ms, "cost": cost, "tokens": tokens, "failed": []}
    except EngineError as e:
        raise _failed(e, sid, t0)
    except Exception as e:
        log(f"{label} failed: {type(e).__name__}: {str(e)[:300]}")
        raise _failed(EngineError("OpenCode couldn't answer. Try again.", 502), sid, t0)
    finally:
        if ephemeral and sid:
            _http("DELETE", f"/api/session/{sid}", timeout=20)
        if held and rec is not None:
            rec["lock"].release()


def _failed(err, sid, t0):
    """Attach to an EngineError what the failed answer used (its replies so far), for the usage counts."""
    _, cost, tokens = _read_back(sid, t0 * 1000) if sid else ("", 0.0, dict.fromkeys(engine.TOKEN_KEYS, 0))
    err.usage = [{"cost": cost, "tokens": tokens}]
    return err


def open_chat(chat_key, cdir, system, *, model, web=True, session=None, log=None):
    """Start a chat's session now, without sending anything (no turn, no cost), so the first question doesn't
    wait for it. Skipped while a turn holds the chat. Returns at once; a failure only means the first question
    creates it as usual."""
    def work():
        rec = _chat(chat_key)
        if not rec["lock"].acquire(blocking=False):
            return
        try:
            sid = _prepare(cdir, system, _ref(model), web, session=session,
                           title=f"Study Hub · {getattr(cdir, 'name', 'course')}")
            rec["session"] = sid
        except Exception as e:
            if log:
                log(f"warm failed: {type(e).__name__}: {str(e)[:200]}")
        finally:
            rec["lock"].release()
    threading.Thread(target=work, daemon=True, name="opencode-warm").start()


def close_chat(chat_key):
    """Forget a chat's session. Saved chats keep their session on the server (it resumes by id); a side
    question's throwaway session is deleted."""
    with _CHATS_LOCK:
        rec = _CHATS.pop(chat_key, None)
    if rec and isinstance(chat_key, tuple) and str(chat_key[1]).startswith("side-") and rec.get("session"):
        _http("DELETE", f"/api/session/{rec['session']}", timeout=20)


# ---------------------------------------------------------------- models

# Intelligence scores, 0–99 (higher = more capable). A judgement, not a benchmark: the point is to tell the
# student which model to trust with a hard derivation and which one is fine for a quick question.
SCORES = {
    "google/gemini-4-argon": 95,
    "google/gemini-pro-latest": 94,
    "google/gemini-3.1-pro-preview": 93,
    "google/gemini-2.5-pro": 86,
    "google/gemini-3.8-flash": 84,
    "google/gemini-flash-latest": 84,
    "google/gemini-3.7-flash": 82,
    "opencode/big-pickle": 81,
    "opencode/nemotron-3-ultra-free": 80,
    "google/gemini-3.6-flash": 79,
    "opencode/deepseek-v4.1-flash-free": 79,
    "google/gemini-3.5-flash": 77,
    "opencode/glm-5.3-flash-free": 77,
    "opencode/minimax-m3.1-flash-free": 75,
    "google/gemini-3-flash-preview": 74,
    "opencode/mimo-v2.6-flash-free": 73,
    "google/gemini-2.5-flash": 72,
    "opencode/nemotron-3.5-super-vl-free": 71,
    "google/gemini-flash-lite-latest": 68,
    "opencode/nemotron-3.5-lightning-free": 68,
    "opencode/longcat-2.5-preview-free": 66,
    "google/gemini-3.5-flash-lite": 64,
    "google/gemini-3.1-flash-lite": 63,
    "google/gemma-4-31b-it": 62,
    "google/gemini-2.5-flash-lite": 60,
    "opencode/beam-free": 58,
    "google/gemma-4-26b-a4b-it": 57,
    "ollama/devstral-small-2": 52,
}

# Used until the live list arrives (and whenever the server can't be reached). Kept in step with the models
# the hub was built against.
STATIC_MODELS = [
    {"id": "opencode/big-pickle", "label": "Big Pickle", "provider": "OpenCode", "iq": 81},
    {"id": "opencode/nemotron-3-ultra-free", "label": "Nemotron 3 Ultra Free", "provider": "OpenCode", "iq": 80},
    {"id": "opencode/deepseek-v4.1-flash-free", "label": "DeepSeek V4.1 Flash Free", "provider": "OpenCode", "iq": 79},
    {"id": "opencode/glm-5.3-flash-free", "label": "GLM-5.3-Flash Free", "provider": "OpenCode", "iq": 77},
    {"id": "opencode/minimax-m3.1-flash-free", "label": "MiniMax M3.1 Flash Free", "provider": "OpenCode", "iq": 75},
    {"id": "opencode/mimo-v2.6-flash-free", "label": "MiMo-V2.6-Flash Free", "provider": "OpenCode", "iq": 73},
    {"id": "opencode/nemotron-3.5-super-vl-free", "label": "Nemotron 3.5 Super VL Free", "provider": "OpenCode", "iq": 71},
    {"id": "opencode/nemotron-3.5-lightning-free", "label": "Nemotron 3.5 Lightning Free", "provider": "OpenCode", "iq": 68},
    {"id": "opencode/longcat-2.5-preview-free", "label": "LongCat 2.5 Preview Free", "provider": "OpenCode", "iq": 66},
    {"id": "opencode/beam-free", "label": "Beam Free", "provider": "OpenCode", "iq": 58},
    {"id": "google/gemini-4-argon", "label": "Gemini 4 Argon", "provider": "Google", "iq": 95},
    {"id": "google/gemini-pro-latest", "label": "Gemini Pro Latest", "provider": "Google", "iq": 94},
    {"id": "google/gemini-3.1-pro-preview", "label": "Gemini 3.1 Pro Preview", "provider": "Google", "iq": 93},
    {"id": "google/gemini-2.5-pro", "label": "Gemini 2.5 Pro", "provider": "Google", "iq": 86},
    {"id": "google/gemini-3.8-flash", "label": "Gemini 3.8 Flash", "provider": "Google", "iq": 84},
    {"id": "google/gemini-flash-latest", "label": "Gemini Flash Latest", "provider": "Google", "iq": 84},
    {"id": "google/gemini-3.7-flash", "label": "Gemini 3.7 Flash", "provider": "Google", "iq": 82},
    {"id": "google/gemini-3.6-flash", "label": "Gemini 3.6 Flash", "provider": "Google", "iq": 79},
    {"id": "google/gemini-3.5-flash", "label": "Gemini 3.5 Flash", "provider": "Google", "iq": 77},
    {"id": "google/gemini-3-flash-preview", "label": "Gemini 3 Flash Preview", "provider": "Google", "iq": 74},
    {"id": "google/gemini-2.5-flash", "label": "Gemini 2.5 Flash", "provider": "Google", "iq": 72},
    {"id": "google/gemini-flash-lite-latest", "label": "Gemini Flash-Lite Latest", "provider": "Google", "iq": 68},
    {"id": "google/gemini-3.5-flash-lite", "label": "Gemini 3.5 Flash Lite", "provider": "Google", "iq": 64},
    {"id": "google/gemini-3.1-flash-lite", "label": "Gemini 3.1 Flash Lite", "provider": "Google", "iq": 63},
    {"id": "google/gemma-4-31b-it", "label": "Gemma 4 31B IT", "provider": "Google", "iq": 62},
    {"id": "google/gemini-2.5-flash-lite", "label": "Gemini 2.5 Flash-Lite", "provider": "Google", "iq": 60},
    {"id": "google/gemma-4-26b-a4b-it", "label": "Gemma 4 26B A4B IT", "provider": "Google", "iq": 57},
    {"id": "ollama/devstral-small-2", "label": "devstral-small-2", "provider": "Ollama", "iq": 52},
]

BAD = ("embedding", "image", "lyria", "computer-use", "live", "tts", "whisper", "transcribe", "moderation",
       "rerank", "deep-research", "customtools")
_MODELS = None
_MODELS_AT = 0.0
_MODELS_LOCK = threading.Lock()
_REFRESHING = False


def _provider_name(pid):
    return {"opencode": "OpenCode", "google": "Google", "ollama": "Ollama", "anthropic": "Anthropic",
            "openai": "OpenAI"}.get(pid, str(pid).replace("-", " ").title())


def _score(pid, mid, name):
    key = f"{pid}/{mid}"
    if key in SCORES:
        return SCORES[key]
    # Unknown (a new model): a rough read of the name, so it still gets a number rather than a blank.
    n = f" {mid} {name} ".lower()
    s = 55
    for word, add in (("opus", 20), ("sonnet", 12), ("pro", 10), ("ultra", 9), ("haiku", 2),
                      ("flash", -3), ("mini", -6), ("lite", -8), ("small", -9), ("free", -2)):
        if word in n:
            s += add
    m = re.search(r"(?:^|[^0-9])(\d+)(?:\.(\d+))?", mid)
    if m:
        major, minor = int(m.group(1)), int(m.group(2) or 0)
        s += max(-6, min(8, (major - 2) * 2 + minor))
    return max(20, min(90, s))


def _fetch_models():
    data = _call("GET", "/api/model", timeout=30)
    rows = []
    for m in (data or {}).get("data") or []:
        mid, pid = str(m.get("id") or ""), str(m.get("providerID") or "")
        caps = m.get("capabilities") or {}
        if not mid or not pid or not m.get("enabled") or "text" not in (caps.get("output") or []):
            continue
        if any(b in mid for b in BAD):
            continue
        name = str(m.get("name") or mid)
        rows.append({"id": f"{pid}/{mid}", "label": name, "provider": _provider_name(pid),
                     "iq": _score(pid, mid, name)})
    rows.sort(key=lambda r: (-r["iq"], r["label"]))
    return rows


def _save_models(rows):
    try:
        WORK.mkdir(exist_ok=True)
        tmp = MODELS_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"at": time.time(), "models": rows}, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, MODELS_FILE)
    except OSError:
        pass


def _refresh():
    global _MODELS, _MODELS_AT, _REFRESHING
    try:
        rows = _fetch_models()
        if rows:
            with _MODELS_LOCK:
                _MODELS, _MODELS_AT = rows, time.time()
            _save_models(rows)
    except Exception as e:
        _log(f"model refresh failed: {type(e).__name__}: {str(e)[:200]}")
    finally:
        with _MODELS_LOCK:
            _REFRESHING = False


def _refresh_async():
    global _REFRESHING
    with _MODELS_LOCK:
        if _REFRESHING:
            return
        _REFRESHING = True
    threading.Thread(target=_refresh, daemon=True, name="opencode-models").start()


def known_models():
    """OpenCode's chat models with an intelligence score, cheapest to read (a cache or the curated list) and
    refreshed in the background. Empty when OpenCode isn't installed."""
    global _MODELS, _MODELS_AT
    if not _exe():
        return []
    with _MODELS_LOCK:
        if _MODELS is None:
            try:
                cached = json.loads(MODELS_FILE.read_text(encoding="utf-8"))
                _MODELS = [m for m in cached.get("models") or [] if m.get("id") and m.get("label")]
                _MODELS_AT = float(cached.get("at") or 0)
            except (OSError, ValueError, TypeError, AttributeError):
                _MODELS = [dict(m) for m in STATIC_MODELS]
                _MODELS_AT = 0.0
        stale = time.time() - _MODELS_AT > MODELS_TTL
        rows = [dict(m) for m in _MODELS]
    if stale:
        _refresh_async()
    return rows
