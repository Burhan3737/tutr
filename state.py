"""What the Study Hub remembers per course, in `<course>/me/hub-state.json`:

- decks:   which slides were seen, where the student stopped, read (reached the end) and solved
           (a problem from the deck answered correctly with no hint)
- reviews: saved mistakes, brought back on a 1 → 3 → 7 → 14 → 30 day schedule
- chat:    the course's current tutor chat, whichever deck is open (`chats`, the old pointer per deck, is
           kept but no longer used)

The open review items are also mirrored into `me/progress.md` (between hub markers) so that
mocks and cheat sheets made in Claude Code can see them.
"""
import datetime as dt, json, re, threading, uuid

import library as L

INTERVALS = [1, 3, 7, 14, 30]
DAILY_CAP = 5          # reviews per course per day
_LOCK = threading.RLock()


def today():
    return dt.date.today().isoformat()


def _path(cdir):
    return L.me_dir(cdir) / "hub-state.json"


def load(cdir):
    with _LOCK:
        p = _path(cdir)
        try:
            s = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            s = {}
        s.setdefault("v", 1)
        s.setdefault("decks", {})
        s.setdefault("reviews", [])
        s.setdefault("chats", {})
        return s


def save(cdir, s):
    with _LOCK:
        p = _path(cdir)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(s, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(p)
        _mirror_progress(cdir, s)


def _item(**kw):
    base = {"id": uuid.uuid4().hex[:10], "deck": None, "slides": "", "concept": "", "problem_md": "",
            "mistake": "", "note": "", "step": 0, "due": today(), "created": today(), "last": None}
    base.update(kw)
    return base


# ---------------------------------------------------------------- decks

def deck_state(s, tag):
    return s["decks"].setdefault(tag, {"seen": [], "last": 1, "read": False, "solved": False})


def mark_seen(cdir, tag, n):
    d = L.deck(cdir, tag)
    if not d:
        return None
    with _LOCK:
        s = load(cdir)
        ds = deck_state(s, tag)
        if n not in ds["seen"]:
            ds["seen"].append(n)
        ds["last"] = n
        if n >= d["slides"] or len(ds["seen"]) >= d["slides"]:
            ds["read"] = True
        s["resume"] = {"deck": tag, "slide": n}
        save(cdir, s)
        return ds


def state_word(ds):
    return "solved" if ds.get("solved") else "read" if ds.get("read") else "started" if ds.get("seen") else "new"


def mark_solved(cdir, tag):
    with _LOCK:
        s = load(cdir)
        deck_state(s, tag)["solved"] = True
        save(cdir, s)


def resume_point(cdir, s):
    """Where 'Continue' goes: the last slide viewed, unless that deck is done — then the next deck
    in lecture order that isn't read yet."""
    order = L.deck_order(cdir)
    r = s.get("resume")
    if r and L.deck(cdir, r["deck"]):
        ds = s["decks"].get(r["deck"], {})
        if not ds.get("read"):
            return r
    for d in order:
        ds = s["decks"].get(d["tag"], {})
        if not ds.get("read"):
            return {"deck": d["tag"], "slide": ds.get("last", 1)}
    return r or ({"deck": order[0]["tag"], "slide": 1} if order else None)


# ---------------------------------------------------------------- reviews

def _live(r):
    """Open items only. Old warm-up items (`"warmup": true`) stay in the file but are ignored everywhere."""
    return not r.get("retired") and not r.get("warmup")


def due_reviews(cdir, s=None):
    """Due items for today, within the daily caps (answered-today items count against the caps)."""
    s = s or load(cdir)
    t = today()
    done_today = [r for r in s["reviews"] if _live(r) and r.get("last") == t]
    left = max(0, DAILY_CAP - len(done_today))
    due = sorted((r for r in s["reviews"] if _live(r) and r["due"] <= t and r.get("last") != t),
                 key=lambda r: (r["due"], r["created"]))
    return due[:left]


def add_mistake(cdir, *, deck, slides, concept, problem_md, mistake, note=""):
    with _LOCK:
        s = load(cdir)
        item = _item(deck=deck, slides=slides, concept=concept, problem_md=problem_md, mistake=mistake, note=note,
                     due=(dt.date.today() + dt.timedelta(days=1)).isoformat())
        s["reviews"].append(item)
        save(cdir, s)
        return item


def review_result(cdir, rid, *, correct, hinted, mistake=""):
    """Correct with no hint moves the item one step along the schedule; anything else starts it over."""
    with _LOCK:
        s = load(cdir)
        r = next((x for x in s["reviews"] if x["id"] == rid), None)
        if not r:
            return None
        r["last"] = today()
        if correct and not hinted:
            r["step"] += 1
            if r["step"] >= len(INTERVALS):
                r["retired"] = True
            else:
                r["due"] = (dt.date.today() + dt.timedelta(days=INTERVALS[r["step"]])).isoformat()
        else:
            r["step"] = 0
            r["due"] = (dt.date.today() + dt.timedelta(days=1)).isoformat()
            if mistake:
                r["mistake"] = mistake
        save(cdir, s)
        return r


def set_note(cdir, rid, note):
    with _LOCK:
        s = load(cdir)
        r = next((x for x in s["reviews"] if x["id"] == rid), None)
        if r:
            r["note"] = note.strip()[:300]
            save(cdir, s)
        return r


def get_review(cdir, rid):
    """A saved mistake by id (an old warm-up item is ignored, as everywhere: practising it would bring warm-ups back)."""
    return next((x for x in load(cdir)["reviews"] if x["id"] == rid and not x.get("warmup")), None)


# ---------------------------------------------------------------- the course's chat

def chat_for(cdir):
    return load(cdir).get("chat")


def set_chat(cdir, chat_id):
    with _LOCK:
        s = load(cdir)
        s["chat"] = chat_id
        save(cdir, s)


# ---------------------------------------------------------------- mirror into progress.md

START, END = "<!-- study-hub:start -->", "<!-- study-hub:end -->"


def _mirror_progress(cdir, s):
    prog = L.me_dir(cdir) / "progress.md"
    if not prog.exists():
        return
    items = [r for r in s["reviews"] if _live(r)]
    lines = [START, "## Mistakes saved in the Study Hub", "",
             "Written by the Study Hub from `me/hub-state.json`; don't edit by hand. Use it for mocks and cheat sheets.", ""]
    if items:
        lines += ["| Saved | Where | Concept | Mistake | Clue noted | Step | Next due |", "|---|---|---|---|---|---|---|"]
        for r in sorted(items, key=lambda r: r["created"]):
            cell = lambda x: str(x or "").replace("|", "/").replace("\n", " ")
            lines.append(f"| {r['created']} | {cell(r['slides'] or r['deck'])} | {cell(r['concept'])} | {cell(r['mistake'])} | "
                         f"{cell(r['note'])} | {r['step'] + 1}/{len(INTERVALS)} | {r['due']} |")
    else:
        lines.append("None yet.")
    lines.append(END)
    block = "\n".join(lines)
    text = prog.read_text(encoding="utf-8")
    if START in text and END in text:
        text = re.sub(re.escape(START) + r".*?" + re.escape(END), lambda m: block, text, flags=re.S)
    else:
        text = text.rstrip() + "\n\n" + block + "\n"
    prog.write_text(text, encoding="utf-8")
