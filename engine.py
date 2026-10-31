"""How the tutor talks to Claude: the Claude Agent SDK (claude-agent-sdk), on the machine's Claude Code
login — no API key.

- Chats (Explain / Worked example / Ask / Go deeper) keep one ClaudeSDKClient open per course chat. The
  first question starts it (about 1 s); follow-ups reuse it, so there is no start-up and the topic's
  slides stay in the prompt cache. Clients idle for IDLE_SECONDS are closed (each holds ~200 MB); the
  next question reopens the same conversation with `resume`. `open_chat` starts a chat's client ahead of the
  first question (the Talk tab, while the student is still speaking).
- A course chat spans decks, and each turn's system prompt is its deck's topic: a turn on another topic reopens
  the client (~1 s, and the prompt cache is rebuilt). Turns on one chat hold its turn lock from open to answer,
  so they run one after another and nothing closes a client a turn is using; a warm-up skips a busy chat.
  The answer's timeout starts once the turn holds the lock. A turn cut short (error, timeout, cancel) closes
  its client, so the next one resumes the saved conversation instead of reading the rest of that reply; one
  whose chat was closed (deleted) or the hub shut down meanwhile fails rather than reopening it.
- Side questions fork the course's chat (`fork_session`): they start from a copy of its conversation, so
  they know what was said, and nothing they say is added to the chat itself.
- Practice problems and marking are one-off queries, each with its own JSON schema (output_format).
- Answers stream: text arrives as it's written, and every file or web lookup becomes a status line
  ("Reading the S&D-2 slides…"), via the `emit(kind, data)` callback; so do opening a conversation and
  thinking before the first word.
- Where the wait goes (measured, Haiku 4.5, ~35k-token cached prompt): connecting a client ~1 s; thinking
  before the first text 1–9 s (400–1000 thinking tokens); then output speed, so a turn with a drawing
  (~2,000 tokens) takes 10–20 s in all. The log records first= (ms to the first text) next to ms= (total).
- Confinement is enforced twice: a PreToolUse hook refuses any Read/Grep/Glob whose path or pattern
  leaves the course folder or leads into the student's private files (me/private/, in any letter case), and
  the CLI's default permissions refuse reads outside its working directory anyway. Only WebSearch/WebFetch are pre-approved (they can't read local files).
  Never pre-approve Read/Grep/Glob with allowed_tools.

If the SDK isn't installed, `run` falls back to one `claude -p` process per request (no streaming).
The async work runs on one event loop in a background thread; the HTTP server's request threads
call `run`, which blocks until the answer is complete.
"""
import asyncio, hashlib, json, os, re, subprocess, threading, time
from pathlib import Path

try:
    from claude_agent_sdk import (AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, HookMatcher,
                                  ResultMessage, StreamEvent, ToolUseBlock, query)
    SDK = True
except ImportError:          # pip install -r requirements.txt
    SDK = False

HERE = Path(__file__).resolve().parent
WORK = HERE / ".cache"
PROMPTS = WORK / "prompts"
MAX_TURNS = 25
TIMEOUT = 420           # for the answer itself; a chat turn's wait for the one before it doesn't count
QUEUE_TIMEOUT = 420     # how long a chat turn waits for the one before it
IDLE_SECONDS = 600


class EngineError(Exception):
    def __init__(self, msg, status=502):
        super().__init__(msg)
        self.status = status


# ---------------------------------------------------------------- background event loop

_LOOP = None
_LOOP_LOCK = threading.Lock()


def _loop():
    global _LOOP
    with _LOOP_LOCK:
        if _LOOP is None:
            _LOOP = asyncio.new_event_loop()
            threading.Thread(target=_LOOP.run_forever, daemon=True, name="claude-sdk").start()
            asyncio.run_coroutine_threadsafe(_reaper(), _LOOP)
            _clean_prompt_files()
    return _LOOP


# ---------------------------------------------------------------- system prompt files
# Passed as a file: a ~100 kB prompt is too long for a Windows command line. Named by content hash,
# so an unchanged prompt reuses the same file (and the same prompt cache).

def prompt_file(system):
    PROMPTS.mkdir(parents=True, exist_ok=True)
    p = PROMPTS / f"{hashlib.sha1(system.encode('utf-8')).hexdigest()[:16]}.md"
    if not p.exists():
        p.write_text(system, encoding="utf-8")
    return p


def _clean_prompt_files():
    cutoff = time.time() - 86400
    for p in PROMPTS.glob("*.md") if PROMPTS.exists() else []:
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------- confinement

GLOB_CHARS = re.compile(r"[*?\[{]")


def _resolve(root, value):
    """The path (or the fixed prefix of a glob pattern) a tool call would read, resolved; None if it can't be."""
    m = GLOB_CHARS.search(value)
    fixed = value
    if m:       # "../x/**/*.md" -> "../x"; "*.md" -> "" (the working directory)
        head = value[:m.start()]
        fixed = head.rsplit("/", 1)[0] if "/" in head else ""
    try:
        p = Path(fixed)
        return (p if p.is_absolute() else root / p).resolve()
    except (ValueError, OSError):
        return None


def _within(p, folder):
    """Is p folder or inside it? Compared in the filesystem's case rules (Windows: ME/Private is me/private)."""
    try:
        return p is not None and os.path.normcase(os.path.commonpath([str(p), str(folder)])) == os.path.normcase(str(folder))
    except ValueError:
        return False


def _inside(root, value):
    """Does a path (or the fixed prefix of a glob pattern) stay inside root?"""
    return _within(_resolve(root, value), root)


def _private(root, value):
    """Does a path (or the fixed prefix of a glob pattern) lead into the student's private files (me/private/)?"""
    return _within(_resolve(root, value), root / "me" / "private")


def _confine(root):
    root = Path(root).resolve()

    async def hook(inp, tool_use_id, ctx):
        args = inp.get("tool_input") or {}
        for key in ("file_path", "path", "pattern"):
            v = args.get(key)
            if not v or (key == "pattern" and inp.get("tool_name") == "Grep"):   # a Grep pattern is a regex, not a path
                continue
            v = str(v).replace("\\", "/")
            if not _inside(root, v):
                return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                               "permissionDecisionReason": "Only this course's files can be read."}}
            if _private(root, v):
                return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                               "permissionDecisionReason": "The student's private files can't be read."}}
        return {}
    return hook


def _options(cdir, system, model, web, *, resume=None, fork=False, schema=None, partial=True):
    tools = ["Read", "Grep", "Glob"] + (["WebSearch", "WebFetch"] if web else [])
    return ClaudeAgentOptions(
        model=model, cwd=str(cdir), tools=tools, allowed_tools=["WebSearch", "WebFetch"] if web else [],
        max_turns=MAX_TURNS, strict_mcp_config=True, setting_sources=["local"],
        system_prompt={"type": "file", "path": str(prompt_file(system))},
        include_partial_messages=partial, resume=resume, fork_session=bool(fork and resume),
        output_format={"type": "json_schema", "schema": schema} if schema else None,
        extra_args={"disable-slash-commands": None},
        hooks={"PreToolUse": [HookMatcher(matcher="Read|Grep|Glob", hooks=[_confine(cdir)])]},
        stderr=lambda line: None)


# ---------------------------------------------------------------- status lines

def describe(name, args, cdir):
    """A short, human status line for a tool call."""
    args = args or {}
    if name == "WebSearch":
        return f"Searching the web: {str(args.get('query', ''))[:60]}"
    if name == "WebFetch":
        m = re.match(r"https?://(?:www\.)?([^/]+)", str(args.get("url", "")))
        return f"Reading {m.group(1) if m else 'a web page'}"
    if name == "Grep":
        return f"Searching the course for “{str(args.get('pattern', ''))[:40]}”"
    if name == "Glob":
        return "Looking through the course files"
    if name == "Read":
        p = str(args.get("file_path", "")).replace("\\", "/")
        m = re.search(r"(?:^|/)decks/([^/]+)/transcript\.md$", p)
        if m:
            return f"Reading the {m.group(1)} slides"
        m = re.search(r"(?:^|/)textbooks/([^/.]+)", p)
        if m:
            return f"Looking in {m.group(1)}"
        if re.search(r"(?:^|/)me/notes/Week\d+/", p):
            return "Reading your class notes"
        if "/uploads/" in p:
            return "Looking at your photo"
        return f"Reading {p.rsplit('/', 1)[-1]}"
    if name == "StructuredOutput":
        return "Writing it up"
    return name


# ---------------------------------------------------------------- usage: each answer's tokens and cost
# A result's `usage` is that turn's, but the main model's only. `model_usage` (every model, Claude Code's own small
# calls too) and `total_cost_usd` are the process's running totals, and a process that resumes a session starts
# from that session's saved totals (the last cost-state line in its transcript). So an answer's tokens and cost
# are the totals after it minus the totals before it: for a chat just (re)opened, the resumed session's saved ones.

TOKEN_KEYS = ("in", "cache_read", "cache_write", "out")
ZERO_TOTALS = {"cost": 0.0, "models": {}}


def tokens(usage):
    """Token counts from a usage report: fresh input, cache reads, cache writes, output (thinking included)."""
    u = usage or {}
    n = lambda k: int(u.get(k) or 0)
    return {"in": n("input_tokens"), "cache_read": n("cache_read_input_tokens"),
            "cache_write": n("cache_creation_input_tokens"), "out": n("output_tokens")}


def tokens_text(t):
    if not t:
        return "tokens=unknown"
    return f"in={t['in']} cache_read={t['cache_read']} cache_write={t['cache_write']} out={t['out']}"


def _totals(model_usage, cost):
    """Running totals from a result's (or a cost-state line's) per-model usage and total cost."""
    models = {}
    for name, m in (model_usage or {}).items():
        n = lambda k: int((m.get(k) if isinstance(m, dict) else getattr(m, k, 0)) or 0)
        models[name] = {"in": n("inputTokens"), "cache_read": n("cacheReadInputTokens"),
                        "cache_write": n("cacheCreationInputTokens"), "out": n("outputTokens")}
    return {"cost": float(cost or 0), "models": models}


def _saved_totals(cdir, session):
    """The totals a process resuming `session` starts from: the last cost-state line in its transcript."""
    if not session:
        return ZERO_TOTALS
    root = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"
    path = root / re.sub(r"[^A-Za-z0-9]", "-", str(cdir)) / f"{session}.jsonl"
    if not path.exists():       # (a long folder name is shortened differently)
        path = next(root.glob(f"*/{session}.jsonl"), None)
    found = ZERO_TOTALS
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if '"cost-state"' in line:
                    o = json.loads(line)
                    if o.get("type") == "cost-state":
                        found = _totals(o.get("modelUsage"), o.get("totalCostUSD"))
    except (OSError, TypeError, ValueError, AttributeError):
        pass
    return found


def _turn_usage(now, before, usage):
    """An answer's {"cost", "tokens"}: the totals `now` minus those `before` it. The turn's own `usage` (main model)
    checks the start: if the process didn't start from `before` after all (a fork may not), it started from zero."""
    main = tokens(usage)

    def delta(b):
        d = dict.fromkeys(TOKEN_KEYS, 0)
        for name, t in now["models"].items():
            for k in TOKEN_KEYS:
                d[k] += t[k] - b["models"].get(name, {}).get(k, 0)
        return d
    fits = [(sum(d.values()), d, b) for b in (before, ZERO_TOTALS) for d in [delta(b)]
            if all(d[k] >= main[k] for k in TOKEN_KEYS)]
    if not fits:                # no per-model totals to go on: the main model's own count
        cost = now["cost"] - before["cost"]
        return {"cost": cost if cost >= 0 else now["cost"], "tokens": main}
    _, d, b = min(fits, key=lambda f: f[0])
    return {"cost": max(0.0, now["cost"] - b["cost"]), "tokens": d}


def _seen(stats, mid, usage):
    """Note a reply's usage as it streams (the same reply is reported more than once, its output growing)."""
    if not mid or not usage:
        return
    t, cur = tokens(usage), stats.setdefault("msgs", {}).setdefault(mid, dict.fromkeys(TOKEN_KEYS, 0))
    for k in TOKEN_KEYS:
        cur[k] = max(cur[k], t[k])


def _partial(stats):
    """What an answer that failed had used so far: the replies that came back (cost unknown)."""
    t = dict.fromkeys(TOKEN_KEYS, 0)
    for m in stats.pop("msgs", {}).values():
        for k in TOKEN_KEYS:
            t[k] += m[k]
    return {"cost": None, "tokens": t}


def _failed(err, stats, last=None):
    """Attach to an EngineError what each failed attempt used, for the usage counts."""
    err.usage = stats.get("failed", []) + [last or _partial(stats)]
    return err


async def _consume(stream, emit, cdir, text_out=True, stats=None):
    result, thinking = None, False
    stats = stats if stats is not None else {}
    async for msg in stream:
        if isinstance(msg, StreamEvent):
            ev = msg.event or {}
            if ev.get("type") == "message_start":
                stats["cur"] = (ev.get("message") or {}).get("id")
                _seen(stats, stats["cur"], (ev.get("message") or {}).get("usage"))
            elif ev.get("type") == "message_delta":
                _seen(stats, stats.get("cur"), ev.get("usage"))
            if ev.get("type") == "content_block_start" and (ev.get("content_block") or {}).get("type") == "thinking":
                if not thinking and "first" not in stats:
                    emit("status", "Thinking it through")
                thinking = True
            if text_out and ev.get("type") == "content_block_delta" and (ev.get("delta") or {}).get("type") == "text_delta":
                stats.setdefault("first", time.time())
                emit("text", ev["delta"]["text"])
        elif isinstance(msg, AssistantMessage):
            _seen(stats, msg.message_id, msg.usage)
            for b in msg.content:
                if isinstance(b, ToolUseBlock):
                    emit("status", describe(b.name, b.input, cdir))
        elif isinstance(msg, ResultMessage):
            result = msg
    if result is None:
        raise EngineError("Claude stopped before answering. Try again.")
    return result


# ---------------------------------------------------------------- chats (one open client per course chat)

class _Chat:
    def __init__(self, client, sig, totals):
        self.client, self.sig = client, sig
        self.last = time.time()
        self.totals = totals        # the process's running totals so far (a resumed one starts from its session's)


_CHATS = {}
_TURNS = {}         # key -> asyncio.Lock held for a whole turn (open → answer, the retry too) or a warm-up's open;
                    # it outlives the clients, so a reopen never closes a client another turn is using
_SESSIONS = {}      # key -> the session its last turn ended on: a turn that waited behind it resumes that one
_EPOCHS = {}        # key -> times close_chat closed it: a turn started before a close mustn't reopen the chat
_SHUTDOWN = False


def _turn_lock(key):
    return _TURNS.setdefault(key, asyncio.Lock())


async def _open(key, cdir, system, model, web, session, fork=False, emit=None):
    """The chat's open client, started (or restarted, if its prompt, model or web setting changed) if needed.
    Only with the key's turn lock held."""
    sig = (hashlib.sha1(system.encode("utf-8")).hexdigest(), model, web)
    c = _CHATS.get(key)
    if c and c.sig != sig:      # the slides, model or web setting changed: reopen the same conversation
        await _close(key)
        c = None
    if c is None:
        if emit:
            emit("status", "Opening the conversation")
        resume = session if fork else _SESSIONS.get(key) or session
        totals = await asyncio.to_thread(_saved_totals, cdir, resume)
        client = ClaudeSDKClient(_options(cdir, system, model, web, resume=resume, fork=fork))
        await client.connect()
        c = _CHATS[key] = _Chat(client, sig, totals)
    c.last = time.time()
    return c


async def _warm(key, cdir, system, model, web, session):
    lock = _turn_lock(key)
    if lock.locked() or _SHUTDOWN:      # a turn is answering (or opening): never close or reopen its client under it
        return
    async with lock:
        await _open(key, cdir, system, model, web, session)


async def _close(key):
    c = _CHATS.pop(key, None)
    if c:
        try:
            await c.client.disconnect()
        except Exception:
            pass


async def _reaper():
    while True:
        await asyncio.sleep(60)
        for key, c in list(_CHATS.items()):
            lock = _TURNS.get(key)
            if time.time() - c.last > IDLE_SECONDS and not (lock and lock.locked()):
                await _close(key)
        for key, lock in list(_TURNS.items()):      # (_waiters: a turn about to take the lock just released)
            if key not in _CHATS and not lock.locked() and not getattr(lock, "_waiters", None):
                _TURNS.pop(key, None)
                _SESSIONS.pop(key, None)
                _EPOCHS.pop(key, None)


async def _chat(key, cdir, system, prompt, model, web, session, emit, fork=False, stats=None):
    epoch = _EPOCHS.get(key, 0)
    lock = _turn_lock(key)
    if lock.locked():
        emit("status", "Waiting for the last answer to finish")
    try:
        await asyncio.wait_for(lock.acquire(), QUEUE_TIMEOUT)
    except (asyncio.TimeoutError, TimeoutError):
        raise EngineError("The last answer in this chat is still coming. Try again in a moment.", 504)
    try:
        async with asyncio.timeout(TIMEOUT):
            for attempt in (1, 2):
                if _SHUTDOWN or _EPOCHS.get(key, 0) != epoch:
                    raise EngineError("That chat was closed.", 410)
                c = await _open(key, cdir, system, model, web, session, fork, emit)
                try:
                    await c.client.query(prompt)
                    res = await _consume(c.client.receive_response(), emit, cdir, stats=stats)
                except BaseException as e:      # died, timed out or cancelled: never leave a reply half read
                    await _close(key)           # (the next turn starts again from the saved conversation)
                    if attempt == 2 or not isinstance(e, Exception) or isinstance(e, EngineError):
                        raise
                    if stats is not None:
                        stats.setdefault("failed", []).append(_partial(stats))
                    continue
                c.last = time.time()
                now = _totals(res.model_usage, res.total_cost_usd)
                used, c.totals = _turn_usage(now, c.totals, res.usage), now
                if res.session_id:
                    _SESSIONS[key] = res.session_id
                return res, used
    finally:
        lock.release()


async def _one_shot(cdir, system, prompt, model, web, schema, emit, stats):
    res = await _consume(query(prompt=prompt, options=_options(cdir, system, model, web, schema=schema, partial=False)),
                         emit, cdir, text_out=False, stats=stats)  # (no partial messages: no thinking status either)
    return res, _turn_usage(_totals(res.model_usage, res.total_cost_usd), ZERO_TOTALS, res.usage)


# ---------------------------------------------------------------- the one entry point

def run(cdir, system, prompt, *, model, web=True, schema=None, chat_key=None, session=None, fork=False, emit=None,
        log=None, label=""):
    """Ask Claude. chat_key set → a turn in that chat's open client; otherwise a one-off query.
    fork → start from a copy of `session` (a side question): the original conversation is left untouched.
    Returns {"text", "json", "session", "ms", "cost", "tokens", "failed"} ("failed": what earlier attempts that
    failed had used); raises EngineError, with .usage: what each failed attempt used."""
    emit = emit or (lambda kind, data: None)
    t0 = time.time()
    if not SDK:
        return _run_cli(cdir, system, prompt, model=model, web=web, schema=schema, session=session, fork=fork, log=log,
                        label=label)
    stats = {}
    coro = (_chat(chat_key, cdir, system, prompt, model, web, session, emit, fork, stats) if chat_key     # (times itself)
            else asyncio.wait_for(_one_shot(cdir, system, prompt, model, web, schema, emit, stats), TIMEOUT))
    fut = asyncio.run_coroutine_threadsafe(coro, _loop())
    try:
        res, used = fut.result(QUEUE_TIMEOUT + TIMEOUT + 30)
    except EngineError as e:
        raise _failed(e, stats)
    except (asyncio.TimeoutError, TimeoutError):
        fut.cancel()
        raise _failed(EngineError("That took too long. Try again.", 504), stats)
    except Exception as e:
        if log:
            log(f"{label} failed: {type(e).__name__}: {str(e)[:300]}")
        if "CLINotFound" in type(e).__name__:
            raise EngineError("Claude Code isn't installed or isn't on PATH. Install it, then restart the hub.", 500)
        raise _failed(EngineError("Claude didn't answer. Check that Claude Code is signed in, then try again."), stats)
    ms = int((time.time() - t0) * 1000)
    if res.is_error or res.subtype not in ("success", None):
        if log:
            log(f"{label} error: subtype={res.subtype} {str(res.result)[:200]!r} cost={used['cost']:.4f} "
                f"{tokens_text(used['tokens'])}")
        if res.subtype == "error_max_turns":
            raise _failed(EngineError("Claude ran out of look-up steps. Try a narrower question."), stats, used)
        raise _failed(EngineError("Claude reported an error. Try again in a moment."), stats, used)
    if schema and not isinstance(res.structured_output, dict):
        raise _failed(EngineError("Claude's answer came back in the wrong shape. Try again."), stats, used)
    if log:
        first = f" first={int((stats['first'] - t0) * 1000)}" if "first" in stats else ""
        log(f"{label} engine=sdk model={model} turns={res.num_turns} denied={len(res.permission_denials or [])} "
            f"ms={ms}{first} cost={used['cost']:.4f} {tokens_text(used['tokens'])}")
    return {"text": res.result or "", "json": res.structured_output, "session": res.session_id, "ms": ms,
            "cost": used["cost"], "tokens": used["tokens"], "failed": stats.get("failed", [])}


def shutdown():
    """Close every open conversation (each is a claude process), e.g. when the hub stops."""
    global _SHUTDOWN
    _SHUTDOWN = True        # a turn still running mustn't reopen one
    if SDK and _LOOP is not None:
        async def _all():
            for key in list(_CHATS):
                await _close(key)
        try:
            asyncio.run_coroutine_threadsafe(_all(), _LOOP).result(10)
        except Exception:
            pass


def open_chat(chat_key, cdir, system, *, model, web=True, session=None, log=None):
    """Start a chat's client now, without sending anything (no turn, no cost), so the first question doesn't
    wait for it. Skipped while a turn holds the chat. Returns at once; a failure only means the first question
    opens it as usual."""
    if not SDK:
        return
    fut = asyncio.run_coroutine_threadsafe(_warm(chat_key, cdir, system, model, web, session), _loop())

    def done(f):
        e = None if f.cancelled() else f.exception()
        if e and log:
            log(f"warm failed: {type(e).__name__}: {str(e)[:200]}")
    fut.add_done_callback(done)


async def _kill(key):
    _EPOCHS[key] = _EPOCHS.get(key, 0) + 1      # first, so a turn it cuts off doesn't retry
    await _close(key)


def close_chat(chat_key):
    """Close a chat for good (deleted, or a side question closed): a turn on it now fails instead of reopening it.
    A turn started afterwards (the same id opened again) runs as usual."""
    if SDK and _LOOP is not None:
        asyncio.run_coroutine_threadsafe(_kill(chat_key), _LOOP)


# ---------------------------------------------------------------- fallback: one CLI process per request

def _run_cli(cdir, system, prompt, *, model, web, schema, session, log, label, fork=False):
    tools = "Read,Grep,Glob" + (",WebSearch,WebFetch" if web else "")
    cmd = ["claude", "-p", "--output-format", "json", "--model", model, "--tools", tools,
           "--max-turns", str(MAX_TURNS), "--strict-mcp-config", "--disable-slash-commands",
           "--setting-sources", "local", "--system-prompt-file", str(prompt_file(system))]
    if web:
        cmd += ["--allowedTools", "WebSearch", "WebFetch"]
    if session:
        cmd += ["--resume", session] + (["--fork-session"] if fork else [])
    if schema:
        cmd += ["--json-schema", json.dumps(schema)]
    unknown = {"cost": None, "tokens": None}
    before = _saved_totals(cdir, session)
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8",
                              timeout=TIMEOUT, cwd=str(cdir))
    except FileNotFoundError:
        raise EngineError("The claude command isn't on PATH. Install Claude Code, then restart the hub.", 500)
    except subprocess.TimeoutExpired:
        raise _failed(EngineError("That took too long. Try again.", 504), {}, unknown)
    ms = int((time.time() - t0) * 1000)
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        if log:
            log(f"{label} failed: {(proc.stderr or proc.stdout)[-300:]!r}")
        raise _failed(EngineError("Claude didn't answer. Check that Claude Code is signed in, then try again."), {},
                      unknown)
    used = _turn_usage(_totals(data.get("modelUsage"), data.get("total_cost_usd")), before, data.get("usage"))
    if data.get("subtype") == "error_max_turns":
        raise _failed(EngineError("Claude ran out of look-up steps. Try a narrower question."), {}, used)
    if data.get("is_error"):
        raise _failed(EngineError("Claude reported an error. Try again in a moment."), {}, used)
    if schema and not isinstance(data.get("structured_output"), dict):
        raise _failed(EngineError("Claude's answer came back in the wrong shape. Try again."), {}, used)
    if log:
        log(f"{label} engine=cli model={model} turns={data.get('num_turns')} "
            f"denied={len(data.get('permission_denials') or [])} ms={ms} cost={used['cost']:.4f} "
            f"{tokens_text(used['tokens'])}")
    return {"text": data.get("result", ""), "json": data.get("structured_output"), "session": data.get("session_id"),
            "ms": ms, "cost": used["cost"], "tokens": used["tokens"], "failed": []}
