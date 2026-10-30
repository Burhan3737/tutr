"""The live course channel: what every device with a course open sees change as it happens.

- The draft: the Ask box's unsent text and attached photos, one per course. The hub keeps the one real copy: its text, `rev` (one
  more on every accepted change), whether it was dictated (`spoken`) and which device changed it last (`by`). A
  device saves a change with the `rev` its text was built on: a save built on an older rev is refused and
  answered with the newer draft, so a screen showing old text can't overwrite newer words. The device merges
  and tries again. Photos are added and removed one at a time (no version check: they don't overlap), every
  device is told, and sending a question takes the ones it went with.
- Tutor turns: a question being answered in the course's chat, from any device. Its start (the question), its
  status lines and text as they're written, and its end (the chat it was saved in, or the error) go to every
  device; the one that asked recognises its own turn by id. A turn still being answered is kept here with its
  text so far, so a device that connects mid-answer catches up.
- Chat switches: New chat, an older chat opened, the current chat deleted.

Devices hear of these by long polling (server.py: /api/live): every event goes into the course's log with a
number (`seq`), and a device asks for everything after the last number it saw. The request waits here until there
is something (or POLL_SECONDS pass), so a change reaches every device as it happens, and each reply ends, which is
what lets it through links that hold a reply back until it's over (Cloudflare's quick tunnels do). A device that
asks from too far back (the log has moved past it, or the hub restarted: `epoch`) gets a snapshot instead: the
draft and the turns being answered now. Nothing here knows about HTTP, so the hub can move to another server
without touching this.

Drafts are written to disk about a second after the last change, so a half-typed question survives a restart:
either all in one file (`path`), or each course's in its own (`path_for(course)`, the hub's: <course>/me/drafts.json,
read the first time the course is asked about). Either way a file holds {course: draft}.
"""
import collections, json, re, threading, time, uuid
from pathlib import Path

MAX_TEXT = 20_000       # characters: far more than any question
MAX_PHOTOS = 8          # attached to one question
POLL_SECONDS = 25       # a request with nothing new is answered empty after this (well inside tunnels' timeouts)
SAVE_DELAY = 1.0        # seconds after the last change before the drafts are written to disk
LOG_SIZE = 2000         # events kept per course for devices to catch up on (further behind: a snapshot)
CLIENT_ID = re.compile(r"^[A-Za-z0-9]{1,32}$")


class DraftError(ValueError):
    pass


def _blank():
    return {"text": "", "rev": 0, "spoken": False, "by": "", "at": "", "photos": []}


def _id(v):
    return v if isinstance(v, str) and CLIENT_ID.match(v) else ""


class Drafts:
    def __init__(self, path=None, path_for=None):
        self._path = Path(path) if path else None
        self._path_for = path_for   # course -> its own file (or None: not saved), instead of the one `path`
        self._loaded = set()        # courses whose own file has been read (path_for)
        self._lock = threading.Lock()
        self._drafts = {}           # course -> draft
        self.epoch = uuid.uuid4().hex[:8]       # this run of the hub: a device's numbers from another run mean nothing
        self._seq = 0                           # the last event's number (all courses count on the one counter)
        self._log = {}              # course -> deque of (seq, event, data, client not to tell)
        self._dropped = {}          # course -> the newest seq that fell off its log
        self._wake = {}             # course -> Condition (on self._lock) the course's waiting requests sleep on
        self._seen = {}             # course -> {client id: when it last asked}
        self._turns = {}            # course -> {turn id: the turn being answered, its text so far}
        self._timer = None
        self._load()

    # ------------------------------------------------------------ the drafts

    def get(self, course):
        with self._lock:
            self._ensure(course)
            return self._public(course)

    def save(self, course, client, text, base, spoken=False):
        """Save a device's text, built on draft `base`. Returns (True, draft) when accepted, (False, the newer
        draft) when `base` is out of date. Every other device is told of an accepted change."""
        if not isinstance(text, str):
            raise DraftError("A draft is text.")
        if len(text) > MAX_TEXT:
            raise DraftError("That's too long for a question.")
        client = _id(client)
        try:
            base = int(base)
        except (TypeError, ValueError):
            raise DraftError("A draft needs the version it was built on.")
        with self._lock:
            self._ensure(course)
            d = self._drafts.setdefault(course, _blank())
            if base != d["rev"]:
                return False, self._public(course)
            if text == d["text"] and bool(spoken) == d["spoken"]:
                return True, self._public(course)       # nothing changed: no new rev, nobody told
            d.update(text=text, rev=d["rev"] + 1, spoken=bool(spoken) and bool(text), by=client,
                     at=time.strftime("%Y-%m-%d %H:%M:%S"))
            out = self._public(course)
            self._tell(course, "draft", out, skip=client)
        self._save_soon()
        return True, out

    def _public(self, course):
        d = self._drafts.get(course) or _blank()
        return {k: d[k] for k in ("text", "rev", "spoken", "by")} | {"photos": list(d["photos"])}

    # ------------------------------------------------------------ photos

    def add_photo(self, course, client, photo):
        """Attach a photo (its path in the course folder). Every device is told, the one that added it too: its
        reply and the event carry the same draft. Raises DraftError when the question already has MAX_PHOTOS."""
        with self._lock:
            self._ensure(course)
            d = self._drafts.setdefault(course, _blank())
            if len(d["photos"]) >= MAX_PHOTOS:
                raise DraftError(f"A question can have {MAX_PHOTOS} photos at most.")
            if photo not in d["photos"]:
                d["photos"].append(photo)
            return self._changed(course, client)

    def remove_photo(self, course, client, photo):
        """Take a photo off. Returns (whether it was attached, the draft)."""
        with self._lock:
            self._ensure(course)
            d = self._drafts.setdefault(course, _blank())
            if photo not in d["photos"]:
                return False, self._public(course)
            d["photos"].remove(photo)
            return True, self._changed(course, client)

    def take_photos(self, course, photos):
        """A question is being sent with these photos: the ones still attached come off the draft (every device's
        box empties) and are returned, in the order they were attached."""
        with self._lock:
            self._ensure(course)
            d = self._drafts.get(course)
            want = set(photos) if isinstance(photos, (list, tuple)) else set()
            took = [p for p in (d["photos"] if d else []) if p in want]
            if took:
                d["photos"] = [p for p in d["photos"] if p not in want]
                self._changed(course, "")
        return took

    def _changed(self, course, client):
        """(With the lock held.) The draft's photos changed: a new rev, everyone told; the draft."""
        d = self._drafts[course]
        d.update(rev=d["rev"] + 1, by=_id(client), at=time.strftime("%Y-%m-%d %H:%M:%S"))
        out = self._public(course)
        self._tell(course, "draft", out)
        self._save_soon(locked=True)
        return out

    # ------------------------------------------------------------ tutor turns and chat switches

    def turn_start(self, course, info):
        """A question is being answered in the course's chat. info: what the other devices need to show it (mode,
        question, tag, n, spoken, and `turn`, the asking device's id for it). Returns the turn's id."""
        turn = _id(info.get("turn")) or uuid.uuid4().hex[:16]
        t = dict(info, turn=turn, text="", status="")
        with self._lock:
            self._turns.setdefault(course, {})[turn] = t
            self._tell(course, "turn_start", dict(t))
        return turn

    def turn_event(self, course, turn, kind, data):
        """A status line ("status") or a piece of the answer ("text") as it's written."""
        if kind not in ("status", "text") or not isinstance(data, str):
            return
        with self._lock:
            t = self._turns.get(course, {}).get(turn)
            if t is None:
                return
            if kind == "text":
                t["text"] += data
            else:
                t["status"] = data
            self._tell(course, f"turn_{kind}", {"turn": turn, "text": data})

    def turn_end(self, course, turn, chat=None, error=None):
        """The turn is over: saved in `chat`, or failed with `error`."""
        with self._lock:
            ts = self._turns.get(course, {})
            ts.pop(turn, None)
            if not ts:
                self._turns.pop(course, None)
            if error is None:
                self._tell(course, "turn_done", {"turn": turn, "chat": chat})
            else:
                self._tell(course, "turn_error", {"turn": turn, "error": error})

    def chat_switched(self, course, chat, client=""):
        """The course's current chat changed (None: the next question starts a new one)."""
        with self._lock:
            self._tell(course, "chat", {"chat": chat, "client": _id(client)}, skip=_id(client))

    # ------------------------------------------------------------ listening (long polling)

    def poll(self, course, client, since=None, epoch=None, timeout=None):
        """What a device hasn't heard yet: {"epoch", "seq", "snapshot", "events"}. `since` is the last seq it saw
        (with the `epoch` it got it in). Waits up to `timeout` (default POLL_SECONDS) for something new. events:
        (event, data) pairs, oldest first, with what's out of date folded away (see fold). snapshot: None, or the
        draft and the turns being answered now, when `since` can't be caught up from (first ask, too far behind,
        another run of the hub); then events is empty."""
        client = _id(client)
        timeout = POLL_SECONDS if timeout is None else timeout
        end = time.monotonic() + timeout
        with self._lock:
            self._seen.setdefault(course, {})[client] = time.monotonic()
            if not (epoch == self.epoch and isinstance(since, int) and self._dropped.get(course, 0) <= since <= self._seq):
                self._ensure(course)
                return {"epoch": self.epoch, "seq": self._seq, "events": [], "snapshot": {
                    "draft": self._public(course), "turns": [dict(t) for t in self._turns.get(course, {}).values()]}}
            wake = self._wake.setdefault(course, threading.Condition(self._lock))
            while True:
                new = []
                for seq, kind, data, skip in reversed(self._log.get(course, ())):
                    if seq <= since:
                        break
                    if not (skip and skip == client):
                        new.append((kind, data))
                left = end - time.monotonic()
                if new or left <= 0:
                    self._seen[course][client] = time.monotonic()
                    return {"epoch": self.epoch, "seq": self._seq, "events": fold(new[::-1]), "snapshot": None}
                wake.wait(left)

    def watchers(self, course=None):
        """Devices that asked in about the last poll's time (a waiting request counts from when it was made)."""
        cut = time.monotonic() - POLL_SECONDS - 5
        with self._lock:
            return sum(1 for c, seen in self._seen.items() if course is None or c == course for t in seen.values() if t >= cut)

    def _tell(self, course, kind, data, skip=""):
        """(With the lock held.) Log an event for every device listening to the course, except `skip`'s, and wake
        their waiting requests. The oldest events fall off past LOG_SIZE."""
        self._seq += 1
        log = self._log.setdefault(course, collections.deque())
        log.append((self._seq, kind, data, skip))
        while len(log) > LOG_SIZE:
            self._dropped[course] = log.popleft()[0]
        wake = self._wake.get(course)
        if wake:
            wake.notify_all()

    # ------------------------------------------------------------ on disk

    def _load(self, path=None, only=None):
        """Read drafts from `path` (default: the one file); `only`: just that course's."""
        path = path or self._path
        if not path:
            return
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        for course, d in (data.items() if isinstance(data, dict) else []):
            if only is not None and course != only:
                continue
            if isinstance(d, dict) and isinstance(d.get("text"), str) and isinstance(d.get("rev"), int):
                self._drafts[course] = _blank() | {k: d[k] for k in _blank() if k in d}
                ph = self._drafts[course]["photos"]
                self._drafts[course]["photos"] = [p for p in ph if isinstance(p, str)][:MAX_PHOTOS] if isinstance(ph, list) else []

    def _ensure(self, course):
        """(With the lock held.) A course's own file is read the first time it's asked about (path_for)."""
        if not self._path_for or course in self._loaded:
            return
        self._loaded.add(course)
        if course not in self._drafts:
            path = self._path_for(course)
            if path:
                self._load(path, only=course)

    def _save_soon(self, locked=False):
        if not (self._path or self._path_for):
            return
        if not locked:
            with self._lock:
                return self._save_soon(locked=True)
        if self._timer:
            self._timer.cancel()
        self._timer = threading.Timer(SAVE_DELAY, self.flush)
        self._timer.daemon = True
        self._timer.start()

    def flush(self):
        """Write the drafts now (also called when the hub stops)."""
        if not (self._path or self._path_for):
            return
        with self._lock:
            if self._timer:
                self._timer.cancel()
                self._timer = None
            if self._path:
                files = [(self._path, json.dumps(self._drafts, ensure_ascii=False, indent=1))]
            else:
                files = [(self._path_for(c), json.dumps({c: d}, ensure_ascii=False, indent=1)) for c, d in self._drafts.items()]
        for path, body in files:
            if not path:
                continue
            try:
                path = Path(path)
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".tmp")
                tmp.write_text(body, encoding="utf-8")
                tmp.replace(path)
            except OSError:
                pass        # a draft not written to disk is still live in memory


def fold(items):
    """(event, data) pairs with what's out of date folded away: only the newest draft is kept (each carries the
    whole text and photos), and an answer's text pieces in a row are joined."""
    last_draft = max((i for i, (k, _) in enumerate(items) if k == "draft"), default=-1)
    out = []
    for i, (kind, data) in enumerate(items):
        if kind == "draft" and i != last_draft:
            continue
        if kind == "turn_text" and out and out[-1][0] == "turn_text" and out[-1][1]["turn"] == data["turn"]:
            out[-1] = (kind, {"turn": data["turn"], "text": out[-1][1]["text"] + data["text"]})
            continue
        out.append((kind, data))
    return out
