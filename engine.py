"""How the tutor talks to Claude: the Claude Agent SDK (claude-agent-sdk), on the machine's Claude Code
login — no API key.

- Chats (Explain / Worked example / Ask / Go deeper) keep one ClaudeSDKClient open per deck. The
  first question starts it (about 1 s); follow-ups reuse it, so there is no start-up and the topic's
  slides stay in the prompt cache. Clients idle for IDLE_SECONDS are closed (each holds ~200 MB); the
  next question reopens the same conversation with `resume`. `open_chat` starts a deck's client ahead of the
  first question (the Talk tab, while the student is still speaking).
- Side questions fork the deck's chat (`fork_session`): they start from a copy of its conversation, so
  they know what was said, and nothing they say is added to the chat itself.
- Practice problems and marking are one-off queries, each with its own JSON schema (output_format).
- Answers stream: text arrives as it's written, and every file or web lookup becomes a status line
  ("Reading the S&D-2 slides…"), via the `emit(kind, data)` callback; so do opening a conversation and
  thinking before the first word.
- Where the wait goes (measured, Haiku 4.5, ~35k-token cached prompt): connecting a client ~1 s; thinking
  before the first text 1–9 s (400–1000 thinking tokens); then output speed, so a turn with a drawing
  (~2,000 tokens) takes 10–20 s in all. The log records first= (ms to the first text) next to ms= (total).
- Confinement is enforced twice: a PreToolUse hook refuses any Read/Grep/Glob whose path or pattern
  leaves the course folder, and the CLI's default permissions refuse reads outside its working
  directory anyway. Only WebSearch/WebFetch are pre-approved (they can't read local files).
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
TIMEOUT = 420
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


def _inside(root, value):
    """Does a path (or the fixed prefix of a glob pattern) stay inside root?"""
    m = GLOB_CHARS.search(value)
    fixed = value
    if m:       # "../x/**/*.md" -> "../x"; "*.md" -> "" (the working directory)
        head = value[:m.start()]
        fixed = head.rsplit("/", 1)[0] if "/" in head else ""
    try:
        p = Path(fixed)
        p = (p if p.is_absolute() else root / p).resolve()
        return os.path.commonpath([str(p), str(root)]) == str(root)
    except (ValueError, OSError):
        return False


def _confine(root):
    root = Path(root).resolve()

    async def hook(inp, tool_use_id, ctx):
        args = inp.get("tool_input") or {}
        for key in ("file_path", "path", "pattern"):
            v = args.get(key)
            if not v or (key == "pattern" and inp.get("tool_name") == "Grep"):   # a Grep pattern is a regex, not a path
                continue
            if not _inside(root, str(v).replace("\\", "/")):
                return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                               "permissionDecisionReason": "Only this course's files can be read."}}
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
        m = re.search(r"\.cache/Week\d+/([^/]+)\.transcript\.md$", p)
        if m:
            return f"Reading the {m.group(1)} slides"
        m = re.search(r"\.cache/textbooks/([^/.]+)", p)
        if m:
            return f"Looking in {m.group(1)}"
        if re.search(r"course/Week\d+/notes", p):
            return "Reading your class notes"
        if "/uploads/" in p:
            return "Looking at your photo"
        return f"Reading {p.rsplit('/', 1)[-1]}"
    if name == "StructuredOutput":
        return "Writing it up"
    return name


async def _consume(stream, emit, cdir, text_out=True, stats=None):
    result, thinking = None, False
    stats = stats if stats is not None else {}
    async for msg in stream:
        if isinstance(msg, StreamEvent):
            ev = msg.event or {}
            if ev.get("type") == "content_block_start" and (ev.get("content_block") or {}).get("type") == "thinking":
                if not thinking and "first" not in stats:
                    emit("status", "Thinking it through")
                thinking = True
            if text_out and ev.get("type") == "content_block_delta" and (ev.get("delta") or {}).get("type") == "text_delta":
                stats.setdefault("first", time.time())
                emit("text", ev["delta"]["text"])
        elif isinstance(msg, AssistantMessage):
            for b in msg.content:
                if isinstance(b, ToolUseBlock):
                    emit("status", describe(b.name, b.input, cdir))
        elif isinstance(msg, ResultMessage):
            result = msg
    if result is None:
        raise EngineError("Claude stopped before answering. Try again.")
    return result


# ---------------------------------------------------------------- chats (one open client per deck)

class _Chat:
    def __init__(self, client, sig):
        self.client, self.sig = client, sig
        self.lock = asyncio.Lock()
        self.last = time.time()
        self.seen_cost = 0.0


_CHATS = {}
_OPENING = {}       # key -> asyncio.Lock: two turns (or a warm-up and a turn) on one chat share one client


async def _open(key, cdir, system, model, web, session, fork=False, emit=None):
    """The chat's open client, started (or restarted, if its prompt, model or web setting changed) if needed."""
    sig = (hashlib.sha1(system.encode("utf-8")).hexdigest(), model, web)
    async with _OPENING.setdefault(key, asyncio.Lock()):
        c = _CHATS.get(key)
        if c and c.sig != sig:      # the slides, model or web setting changed: reopen the same conversation
            await _close(key)
            c = None
        if c is None:
            if emit:
                emit("status", "Opening the deck's conversation")
            client = ClaudeSDKClient(_options(cdir, system, model, web, resume=session, fork=fork))
            await client.connect()
            c = _CHATS[key] = _Chat(client, sig)
        c.last = time.time()
        return c


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
            if time.time() - c.last > IDLE_SECONDS and not c.lock.locked():
                await _close(key)
        for key, lock in list(_OPENING.items()):
            if key not in _CHATS and not lock.locked():
                _OPENING.pop(key, None)


async def _chat(key, cdir, system, prompt, model, web, session, emit, fork=False, stats=None):
    for attempt in (1, 2):
        c = await _open(key, cdir, system, model, web, session, fork, emit)
        try:
            async with c.lock:
                await c.client.query(prompt)
                res = await _consume(c.client.receive_response(), emit, cdir, stats=stats)
            c.last = time.time()
            total = res.total_cost_usd or 0.0
            cost, c.seen_cost = max(0.0, total - c.seen_cost), total      # the client reports a running total
            session = res.session_id or session
            return res, cost
        except EngineError:
            raise
        except Exception:
            await _close(key)       # the CLI process died: start again from the saved conversation
            if attempt == 2:
                raise


async def _one_shot(cdir, system, prompt, model, web, schema, emit):
    res = await _consume(query(prompt=prompt, options=_options(cdir, system, model, web, schema=schema, partial=False)),
                         emit, cdir, text_out=False)       # (no partial messages: no thinking status either)
    return res, res.total_cost_usd or 0.0


# ---------------------------------------------------------------- the one entry point

def run(cdir, system, prompt, *, model, web=True, schema=None, chat_key=None, session=None, fork=False, emit=None,
        log=None, label=""):
    """Ask Claude. chat_key set → a turn in that chat's open client; otherwise a one-off query.
    fork → start from a copy of `session` (a side question): the original conversation is left untouched.
    Returns {"text", "json", "session", "ms", "cost"}; raises EngineError."""
    emit = emit or (lambda kind, data: None)
    t0 = time.time()
    if not SDK:
        return _run_cli(cdir, system, prompt, model=model, web=web, schema=schema, session=session, fork=fork, log=log,
                        label=label)
    stats = {}
    coro = (_chat(chat_key, cdir, system, prompt, model, web, session, emit, fork, stats) if chat_key
            else _one_shot(cdir, system, prompt, model, web, schema, emit))
    fut = asyncio.run_coroutine_threadsafe(asyncio.wait_for(coro, TIMEOUT), _loop())
    try:
        res, cost = fut.result(TIMEOUT + 15)
    except EngineError:
        raise
    except (asyncio.TimeoutError, TimeoutError):
        fut.cancel()
        raise EngineError("That took too long. Try again.", 504)
    except Exception as e:
        if log:
            log(f"{label} failed: {type(e).__name__}: {str(e)[:300]}")
        if "CLINotFound" in type(e).__name__:
            raise EngineError("Claude Code isn't installed or isn't on PATH. Install it, then restart the hub.", 500)
        raise EngineError("Claude didn't answer. Check that Claude Code is signed in, then try again.")
    ms = int((time.time() - t0) * 1000)
    if res.is_error or res.subtype not in ("success", None):
        if log:
            log(f"{label} error: subtype={res.subtype} {str(res.result)[:200]!r}")
        if res.subtype == "error_max_turns":
            raise EngineError("Claude ran out of look-up steps. Try a narrower question.")
        raise EngineError("Claude reported an error. Try again in a moment.")
    if schema and not isinstance(res.structured_output, dict):
        raise EngineError("Claude's answer came back in the wrong shape. Try again.")
    if log:
        first = f" first={int((stats['first'] - t0) * 1000)}" if "first" in stats else ""
        log(f"{label} engine=sdk model={model} turns={res.num_turns} denied={len(res.permission_denials or [])} "
            f"ms={ms}{first} cost={cost:.4f}")
    return {"text": res.result or "", "json": res.structured_output, "session": res.session_id, "ms": ms, "cost": cost}


def shutdown():
    """Close every open conversation (each is a claude process), e.g. when the hub stops."""
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
    wait for it. Returns at once; a failure only means the first question opens it as usual."""
    if not SDK:
        return
    fut = asyncio.run_coroutine_threadsafe(_open(chat_key, cdir, system, model, web, session), _loop())

    def done(f):
        e = None if f.cancelled() else f.exception()
        if e and log:
            log(f"warm failed: {type(e).__name__}: {str(e)[:200]}")
    fut.add_done_callback(done)


def close_chat(chat_key):
    if SDK and _LOOP is not None:
        asyncio.run_coroutine_threadsafe(_close(chat_key), _LOOP)


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
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8",
                              timeout=TIMEOUT, cwd=str(cdir))
    except FileNotFoundError:
        raise EngineError("The claude command isn't on PATH. Install Claude Code, then restart the hub.", 500)
    except subprocess.TimeoutExpired:
        raise EngineError("That took too long. Try again.", 504)
    ms = int((time.time() - t0) * 1000)
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        if log:
            log(f"{label} failed: {(proc.stderr or proc.stdout)[-300:]!r}")
        raise EngineError("Claude didn't answer. Check that Claude Code is signed in, then try again.")
    if data.get("subtype") == "error_max_turns":
        raise EngineError("Claude ran out of look-up steps. Try a narrower question.")
    if data.get("is_error"):
        raise EngineError("Claude reported an error. Try again in a moment.")
    if schema and not isinstance(data.get("structured_output"), dict):
        raise EngineError("Claude's answer came back in the wrong shape. Try again.")
    cost = data.get("total_cost_usd") or 0
    if log:
        log(f"{label} engine=cli model={model} turns={data.get('num_turns')} "
            f"denied={len(data.get('permission_denials') or [])} ms={ms} cost={cost:.4f}")
    return {"text": data.get("result", ""), "json": data.get("structured_output"), "session": data.get("session_id"),
            "ms": ms, "cost": cost}
