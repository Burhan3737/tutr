"""Drive one hub in-process and record everything it shows, sends to the model and writes. No model is called.

    python tests/verify/hubdrive.py --code <hub code folder> --root <library folder> --out run.json [--no-images]

Used by tests/verify/compare_hubs.py to compare two hubs (an older layout against a migrated library) on copies of
the same data. It works with any version of the hub that has server.py (Handler, Server, DRAFTS) and tutor.py
(run_model, open_chat): the model call is replaced by a recorder that answers with fixed text / JSON, the speech and
OpenCode catalogues are stubbed, background work runs inline and ids are made deterministic.

The hub is served on 127.0.0.1 on a free port, in this process only: server.main() is never called, so no other hub
is stopped and no browser is opened. Everything the hub writes lands in --root (and in --code/.cache): run it on
disposable copies.

Output (JSON): {"view": first look at every read endpoint, "actions": the scripted actions and their replies,
"view_after": the read endpoints again after the actions, "calls": every model call (system prompt, prompt, options),
"hints": the dictation hint for every slide in both scopes, "system_prompts": the tutor's system prompt for every
deck (web and slides only), "status_lines": the status line each deck's transcript read shows, "decks": each deck's
paths (for mapping one layout's paths onto the other's), "writes_by_views": files the first look wrote,
"writes": files the actions wrote, with their contents}.
"""
import argparse, hashlib, itertools, json, os, sys, threading, time, types, urllib.parse, urllib.request
import uuid
from pathlib import Path

TINY_JPEG = ("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////////////////"
             "//////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=")


def snapshot(root):
    """relpath -> (size, sha1) of every file under root (no __pycache__)."""
    out = {}
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in files:
            p = Path(dirpath) / f
            try:
                data = p.read_bytes()
            except OSError:
                continue
            out[p.relative_to(root).as_posix()] = (len(data), hashlib.sha1(data).hexdigest())
    return out


def changes(root, before, after):
    """Files added, changed or removed between two snapshots, with the text of the added/changed ones."""
    out = {}
    for rel in sorted(set(before) | set(after)):
        if before.get(rel) == after.get(rel):
            continue
        if rel not in after:
            out[rel] = {"state": "removed"}
            continue
        entry = {"state": "added" if rel not in before else "changed", "sha1": after[rel][1], "size": after[rel][0]}
        p = Path(root) / rel
        if p.suffix.lower() in (".json", ".md", ".txt", ".log") and after[rel][0] < 5_000_000:
            entry["text"] = p.read_text(encoding="utf-8", errors="replace")
        out[rel] = entry
    return out


class SyncThread:
    """threading.Thread that runs its target at start(): the tutor's background work (memory notes, prefetch)
    finishes before the request that started it answers, so every run sees the same order."""
    def __init__(self, target=None, args=(), kwargs=None, daemon=None, name=None):
        self._t, self._a, self._k = target, args, kwargs or {}

    def start(self):
        if self._t:
            self._t(*self._a, **self._k)

    def join(self, timeout=None):
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--code", required=True, help="folder with the hub's server.py")
    ap.add_argument("--root", required=True, help="the library (folder holding the course folders)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--no-images", action="store_true", help="skip hashing every slide image")
    ap.add_argument("--no-actions", action="store_true", help="only the read endpoints")
    args = ap.parse_args()
    code, root = Path(args.code).resolve(), Path(args.root).resolve()
    os.environ["STUDY_HUB_ROOT"] = str(root)
    sys.path.insert(0, str(code))

    counter = itertools.count(1)
    uuid.uuid4 = lambda: uuid.UUID(int=next(counter) << 88)        # hex: the number first, so [:10] and [:12] differ

    # One clock reading for every timestamp the hub writes (chat "updated", practice "created", ...): two runs at
    # different times then sort and name things the same way. Dates (review due days) stay real.
    fixed = time.localtime(time.mktime(time.strptime(time.strftime("%Y-%m-%d") + " 12:00", "%Y-%m-%d %H:%M")))
    real_strftime = time.strftime
    time.strftime = lambda fmt, t=None: real_strftime(fmt, fixed if t is None else t)

    before0 = snapshot(root)
    import server as SV
    import tutor as T
    import library as L
    import state as S
    import engine as E
    import opencode_engine as OE
    import voice as V

    T.threading = types.SimpleNamespace(**{k: getattr(threading, k) for k in dir(threading) if not k.startswith("_")})
    T.threading.Thread = SyncThread
    OE.known_models = lambda *a, **k: [{"id": "opencode/demo-model", "label": "Demo model", "iq": 50, "provider": "OpenCode"}]
    V.status = lambda: {"ready": False, "downloaded": False, "stub": True}
    V.warm = lambda *a, **k: None           # never download or load the speech models

    calls, ctx = [], {"drill_deck": "", "drill_q": 0}
    schema_name = lambda s: next((n for n in ("PROBLEM_SCHEMA", "MARK_SCHEMA", "MEMORY_SCHEMA")
                                  if s is not None and s is getattr(T, n, None)), None if s is None else "other")

    def fake_run(cdir, system, prompt, *, model, session=None, fork=False, schema=None, web=True, label="",
                 chat_key=None, emit=None):
        i = len(calls) + 1
        sn = schema_name(schema)
        calls.append({"n": i, "course": cdir.name, "label": label, "model": model, "session": session, "fork": bool(fork),
                      "schema": sn, "web": web, "chat_key": list(chat_key) if chat_key else None,
                      "system": system, "prompt": prompt})
        out = {"text": "", "json": None, "session": f"sess-{i}", "ms": 1, "cost": 0.0}
        if sn == "PROBLEM_SCHEMA":
            out["json"] = {"problem_md": f"Problem {i}: find x.", "solution_md": "1. Set it up.\n2. Solve it.",
                           "final_answer": "x = 2", "hints": ["What is given?", "Write the first equation."],
                           "concept": f"concept {i}", "slides": "s2", "deck": ctx.get("deck", "")}
        elif sn == "MARK_SCHEMA":
            out["json"] = {"correct": False, "unreadable": False, "verdict": "Method right, a slip in step 2.",
                           "mistake": "Setup", "feedback_md": "Step 2 should be x = 2.", "concept_missed": "the setup"}
        elif sn == "MEMORY_SCHEMA":
            out["json"] = {"changed": True, "memory": "## About me\n- studies daily\n\n## Questions I keep asking\n"
                                                      f"- question {i}\n\n## Mistakes I've corrected\n\n## Still shaky\n"}
        else:
            out["text"] = f"Answer {i}: here is the explanation. [[a term]]"
            if label.startswith("chat:drill") and label != "chat:drill":
                ctx["drill_q"] += 1
                line = {"q": str(ctx["drill_q"]), "phase": "1", "deck": ctx["drill_deck"], "slides": "s2",
                        "concept": f"drill concept {ctx['drill_q']}", "problem": f"Drill problem {ctx['drill_q']}",
                        "marks": "1/3", "outcome": "hinted", "mistake": "Setup"}
                out["text"] += "\n\n<!-- drill " + json.dumps(line) + " -->"
        if emit:
            emit("status", "Writing it up")
            if out["text"]:
                emit("text", out["text"])
        return out

    opened = []
    T.run_model = fake_run
    T.open_chat = lambda chat_key, cdir, system, **kw: opened.append({"chat_key": list(chat_key), "system": system,
                                                                       "model": kw.get("model"), "web": kw.get("web")})

    srv = SV.Server(("127.0.0.1", 0), SV.Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def http(method, path, body=None, raw=False):
        data = None if body is None else json.dumps(body).encode("utf-8")
        rq = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method,
                                    headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(rq, timeout=120) as r:
                status, ctype, payload = r.status, r.headers.get("Content-Type", ""), r.read()
        except urllib.error.HTTPError as e:
            status, ctype, payload = e.code, e.headers.get("Content-Type", ""), e.read()
        if raw or not ctype.startswith("application/json"):
            return {"status": status, "type": ctype, "sha1": hashlib.sha1(payload).hexdigest(), "bytes": len(payload),
                    **({"text": payload.decode("utf-8", "replace")} if ctype.startswith("text/") and not raw else {})}
        return {"status": status, "json": json.loads(payload or b"null")}

    q = lambda **kw: urllib.parse.urlencode(kw)
    get = lambda _url, **kw: http("GET", _url + ("?" + q(**kw) if kw else ""))
    post = lambda _url, body: http("POST", _url, body)

    def practice_ids():
        files = []
        if hasattr(T, "practice_dir"):
            files = [f for c in L.course_dirs() for f in T.practice_dir(c).glob("*.json")]
        elif hasattr(T, "PRACTICE_DIR"):
            files = list(T.PRACTICE_DIR.glob("*.json"))
        return sorted(f.stem for f in files)

    def view(images):
        v = {}
        home = get("/api/home")
        v["home"] = home
        for path in ("/api/chats", "/api/models", "/api/phone", "/api/voice/status"):
            v[path] = get(path)
        for f in ("/", "/app.js", "/style.css", "/visuals.js", "/drafts.js", "/pcm-worklet.js", "/index.html"):
            v["static " + f] = http("GET", f, raw=True)
        v["probe unknown course"] = get("/api/course", id="no-such-course")
        searches = set()
        for c in home["json"]["courses"]:
            cid = c["id"]
            v[f"course {cid}"] = get("/api/course", id=cid)
            v[f"course/chat {cid}"] = get("/api/course/chat", course=cid)
            v[f"reviews {cid}"] = get("/api/reviews", course=cid)
            v[f"drill/setup {cid}"] = get("/api/drill/setup", course=cid)
            live = get("/api/live", course=cid, client="verify")
            v[f"live {cid}"] = live
            for name, path in [("CLAUDE.md", "CLAUDE.md"), ("course.json", "course.json"),
                               ("private", "me/private/x.md"), ("traversal", "../CLAUDE.md")]:
                v[f"probe note {cid} {name}"] = get("/api/note", course=cid, path=path)
            v[f"probe deck {cid}"] = get("/api/deck", course=cid, tag="no-such-deck")
            course = v[f"course {cid}"]["json"]
            tags = [d["tag"] for t in course["topics"] for d in t["decks"]] + [d["tag"] for d in course["practice"]]
            for tag in tags:
                dv = get("/api/deck", course=cid, tag=tag)
                v[f"deck {cid} {tag}"] = dv
                n = dv["json"].get("slides", 0)
                for i in sorted({0, n + 1} | (set(range(1, n + 1)) if images else {1})):
                    v[f"slide {cid} {tag} {i}"] = http("GET", "/api/slide?" + q(course=cid, tag=tag, n=i), raw=True)
                titles = [s["title"] for s in dv["json"].get("slides_text", []) if len(s["title"]) > 3]
                if titles:
                    searches.add(titles[min(1, len(titles) - 1)][:30])
            for n_ in course["notes"]:
                v[f"note {cid} {n_['path']}"] = get("/api/note", course=cid, path=n_["path"])
            for g in course["docs"]:
                for f in g["files"]:
                    v[f"doc {cid} {f['path']}"] = get("/api/note", course=cid, path=f["path"])
        for s in sorted(searches)[:12] + ["the", "zz", "a"]:
            v[f"search {s}"] = get("/api/search", q=s)
        uploads = set()
        for ch in v["/api/chats"]["json"]:
            full = get("/api/chat", id=ch["id"])
            v[f"chat {ch['id']}"] = full
            for m in (full.get("json") or {}).get("messages", []):
                for p in m.get("photos", []) or []:
                    uploads.add((ch.get("course"), p))
        v["probe chat"] = get("/api/chat", id="000000000000")
        for pid in practice_ids():
            pr = get("/api/practice", id=pid)
            v[f"practice {pid}"] = pr
        rec_photos = []
        for pid in practice_ids():
            rec = T.get_practice(pid)
            for p in (rec or {}).get("photos", []):
                uploads.add((rec.get("course"), p))
        for cid, p in sorted(uploads, key=str):
            if cid:
                v[f"upload {cid} {p}"] = http("GET", "/api/upload?" + q(course=cid, path=p), raw=True)
        return v

    out = {"code": str(code), "root": str(root)}
    out["view"] = view(not args.no_images)
    after_view = snapshot(root)
    out["writes_by_views"] = changes(root, before0, after_view)

    # Per-deck facts, the system prompt of every deck, status lines, dictation hints
    out["decks"], out["system_prompts"], out["status_lines"], out["hints"], out["course_maps"] = {}, {}, {}, {}, {}
    for c in L.course_dirs():
        info = L.course_info(c)
        out["course_maps"][c.name] = L.course_map(c)
        for tag, d in info["decks"].items():
            out["decks"][f"{c.name} {tag}"] = {k: d.get(k) for k in ("transcript", "pdf", "folder", "stem", "slides")}
            for web in (True, False):
                out["system_prompts"][f"{c.name} {tag} web={web}"] = T.system_prompt(c, tag, web)
            if d.get("transcript"):
                p = (c / d["transcript"]).as_posix()
                out["status_lines"][f"{c.name} {tag}"] = E.describe("Read", {"file_path": p}, c)
            for s in L.slide_texts(c, tag):
                for scope in ("slide", "deck"):
                    if scope == "deck" and s["n"] > 1:
                        continue
                    out["hints"][f"{c.name} {tag} {s['n']} {scope}"] = SV._voice_hint(
                        {"course": c.name, "tag": tag, "n": s["n"], "scope": scope})
        for t in info["topics"]:
            out["system_prompts"][f"{c.name} topic_context {t['name']}"] = L.topic_context(c, t["name"])
    new_layout = hasattr(L, "me_dir")    # the status lines for the other files the tutor reads, in this hub's layout
    for c in L.course_dirs()[:1]:
        for name, (o, n) in {"class notes": ("course/Week1/notes.md", "me/notes/Week1/notes.md"),
                             "photo": (".cache/uploads/x.jpg", "me/uploads/x.jpg"),
                             "textbook": (".cache/textbooks/Book.txt", "textbooks/Book.txt"),
                             "course facts": ("CLAUDE.md", "CLAUDE.md"),
                             "progress": ("study/progress.md", "me/progress.md")}.items():
            p = (c / (n if new_layout else o)).as_posix()
            out["status_lines"][f"{c.name} file {name}"] = E.describe("Read", {"file_path": p}, c)

    if args.no_actions:
        out["calls"] = calls
        Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        return

    acts = []

    def act(name, method, path, body=None):
        r = post(path, body) if method == "POST" else get(path, **(body or {}))
        acts.append({"name": name, "method": method, "path": path, "body": body, "reply": r})
        return r.get("json") or {}

    for c in out["view"]["home"]["json"]["courses"]:
        cid = c["id"]
        course = out["view"][f"course {cid}"]["json"]
        lecture = [d for t in course["topics"] for d in t["decks"] if d["slides"] >= 2]
        practice = course["practice"]
        if not lecture:
            continue
        D = lecture[0]["tag"]
        D2 = lecture[1]["tag"] if len(lecture) > 1 else D
        P = practice[0]["tag"] if practice else None
        ctx["deck"] = D
        base = {"course": cid, "tag": D, "n": 2}
        act("seen 1", "POST", "/api/seen", {"course": cid, "tag": D, "n": 1})
        act("seen 2", "POST", "/api/seen", {"course": cid, "tag": D, "n": 2})
        act("seen last D2", "POST", "/api/seen", {"course": cid, "tag": D2, "n": lecture[min(1, len(lecture) - 1)]["slides"]})
        act("chat new", "POST", "/api/chat/new", {"course": cid, "client": "verify"})
        act("warm", "POST", "/api/voice/warm", {"course": cid, "tag": D})
        for mode in ("explain", "example", "deeper", "quiz", "before"):
            act(f"tutor {mode}", "POST", "/api/tutor", dict(base, mode=mode))
        act("tutor explain extra", "POST", "/api/tutor", dict(base, mode="explain", question="use a small example"))
        act("tutor ask", "POST", "/api/tutor", dict(base, mode="ask", question="What does this slide say?"))
        act("tutor ask empty", "POST", "/api/tutor", dict(base, mode="ask", question=""))
        act("tutor brush", "POST", "/api/tutor", dict(base, mode="brush", question="the main idea"))
        act("tutor ask spoken", "POST", "/api/tutor", dict(base, mode="ask", question="actually what is this", spoken=True))
        act("tutor voice", "POST", "/api/tutor", dict(base, mode="voice", question="why is this true"))
        act("tutor voice whole", "POST", "/api/tutor", dict(base, mode="voice", question="what is the deck about", scope="deck"))
        for mode in ("explain_deck", "example_deck", "quiz_deck", "map_deck", "before_deck", "cheatsheet_deck"):
            act(f"tutor {mode}", "POST", "/api/tutor", dict(base, mode=mode))
        for g in ("grill", "grill_deck"):
            act(f"tutor {g}", "POST", "/api/tutor", dict(base, mode=g))
            act(f"tutor {g} reply", "POST", "/api/tutor", dict(base, mode="grill_reply", question="my answer is this"))
            act(f"tutor {g} end", "POST", "/api/tutor", dict(base, mode="grill_end"))
        act("tutor explain slides only", "POST", "/api/tutor", dict(base, mode="explain", slides_only=True))
        act("tutor ask slides only", "POST", "/api/tutor", dict(base, mode="ask", question="and this?", slides_only=True))
        act("tutor ask opencode", "POST", "/api/tutor", dict(base, mode="ask", question="once more", model="opencode/demo-model"))
        act("tutor unknown mode", "POST", "/api/tutor", dict(base, mode="nope"))
        act("tutor unknown deck", "POST", "/api/tutor", dict(base, tag="no-such-deck", mode="explain"))
        # The Ask box: a draft, photos, a question sent with a photo
        rev = ((get("/api/live", course=cid, client="verify").get("json") or {}).get("snapshot") or {}).get("draft", {}).get("rev", 0)
        act("draft", "POST", "/api/draft", {"course": cid, "client": "verify", "text": "half a question", "base": rev})
        ph = act("draft photo", "POST", "/api/draft/photo", {"course": cid, "client": "verify", "data": TINY_JPEG})
        ph2 = act("draft photo 2", "POST", "/api/draft/photo", {"course": cid, "client": "verify", "data": TINY_JPEG})
        photos = [p["path"] if isinstance(p, dict) else p for p in ph2.get("photos", [])]
        if len(photos) > 1:
            act("draft photo remove", "POST", "/api/draft/photo/remove", {"course": cid, "client": "verify", "path": photos[1]})
        act("tutor ask photo", "POST", "/api/tutor", dict(base, mode="ask", question="is my working right?", photos=photos[:1]))
        act("live after", "GET", "/api/live", {"course": cid, "client": "verify2"})
        # Side questions
        chat_id = act("course chat", "GET", "/api/course/chat", {"course": cid}).get("chat", {}) or {}
        side = act("side term", "POST", "/api/side", dict(base, chat=chat_id.get("id", ""), anchor="a term",
                                                          para="Answer: here is the explanation. a term"))
        act("side follow-up", "POST", "/api/side", dict(base, side=side.get("side"), question="say more"))
        act("side close", "POST", "/api/side/close", {"course": cid, "side": side.get("side")})
        act("side selection", "POST", "/api/side", dict(base, chat=chat_id.get("id", ""), anchor="here is the explanation",
                                                        question="what does this mean?"))
        # Exam drill
        setup = act("drill setup", "GET", "/api/drill/setup", {"course": cid})
        ctx["drill_deck"] = D
        drill = {"decks": [D, D2], "papers": [P] if P else [], "focus": ""}
        act("tutor drill", "POST", "/api/tutor", dict(base, mode="drill", drill=drill))
        for m in ("drill_reply", "drill_hint", "drill_reveal", "drill_skip", "drill_end"):
            act(f"tutor {m}", "POST", "/api/tutor", dict(base, mode=m, question="my working" if m == "drill_reply" else ""))
        act("tutor drill focus", "POST", "/api/tutor", dict(base, mode="drill", drill=dict(drill, focus="Only the definitions.")))
        drill_chat = (act("course chat after drill", "GET", "/api/course/chat", {"course": cid}).get("chat") or {}).get("id")
        act("drill setup after", "GET", "/api/drill/setup", {"course": cid})
        # Practice
        p1 = act("practice try", "POST", "/api/practice/new", {"course": cid, "kind": "try", "tag": D, "n": 2})
        for i in range(3):
            act(f"practice hint {i + 1}", "POST", "/api/practice/hint", {"id": p1.get("id")})
        act("practice photo", "POST", "/api/practice/photo", {"id": p1.get("id"), "data": TINY_JPEG})
        chk = act("practice check", "POST", "/api/practice/check", {"id": p1.get("id"), "answer": "x = 3"})
        act("practice get", "GET", "/api/practice", {"id": p1.get("id")})
        act("practice deck", "POST", "/api/practice/new", {"course": cid, "kind": "deck", "tag": D})
        pm = act("practice mixed", "POST", "/api/practice/new", {"course": cid, "kind": "mixed", "tag": D})
        act("practice mixed check", "POST", "/api/practice/check", {"id": pm.get("id"), "answer": "x = 1"})
        act("practice yourturn", "POST", "/api/practice/new", {"course": cid, "kind": "yourturn", "tag": D, "n": 2,
                                                                "example_md": "Worked: 2x = 4, so x = 2."})
        act("practice try slides only", "POST", "/api/practice/new", {"course": cid, "kind": "try", "tag": D, "n": 1,
                                                                       "slides_only": True})
        act("practice try focus", "POST", "/api/practice/new", {"course": cid, "kind": "try", "tag": D, "n": 1,
                                                                 "focus": "a harder one"})
        rid = chk.get("review_id")
        if rid:
            pr = act("practice review", "POST", "/api/practice/new", {"course": cid, "kind": "review", "review_id": rid})
            act("practice review check", "POST", "/api/practice/check", {"id": pr.get("id"), "answer": "x = 2"})
            act("review note", "POST", "/api/review/note", {"course": cid, "id": rid, "note": "remember the setup"})
        act("reviews", "GET", "/api/reviews", {"course": cid})
        # Chats: rename, star, open an older one, delete the drill chat, a new chat
        cur = (act("course chat now", "GET", "/api/course/chat", {"course": cid}).get("chat") or {}).get("id")
        act("chat rename", "POST", "/api/chat/update", {"id": cur, "title": "Renamed chat"})
        act("chat star", "POST", "/api/chat/update", {"id": cur, "starred": True})
        older = act("course chat list", "GET", "/api/course/chat", {"course": cid}).get("chats") or []
        if older:
            act("chat open older", "POST", "/api/chat/open", {"id": older[0]["id"], "client": "verify"})
        first_chat = next((a["reply"]["json"]["chat"] for a in acts
                           if a["name"] == "tutor explain" and a["body"]["course"] == cid and a["reply"].get("json")), None)
        act("chat open first", "POST", "/api/chat/open", {"id": first_chat, "client": "verify"})
        if drill_chat:
            act("chat delete drill", "POST", "/api/chat/delete", {"id": drill_chat, "client": "verify"})
        act("chat new end", "POST", "/api/chat/new", {"course": cid, "client": "verify"})

    for c in out["view"]["home"]["json"]["courses"]:     # last: on a hub that still has warm-ups, it takes an id
        act("practice warm-up kind", "POST", "/api/practice/new", {"course": c["id"], "kind": "warmup"})
    act("client log", "POST", "/api/client-log", {"kind": "mermaid", "where": "verify", "error": "x", "src": "y"})
    SV.DRAFTS.flush()
    out["actions"] = acts
    out["opened"] = opened
    out["calls"] = calls
    out["view_after"] = view(False)
    SV.DRAFTS.flush()
    out["writes"] = changes(root, after_view, snapshot(root))
    srv.shutdown()
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(out['view'])} views, {len(acts)} actions, {len(calls)} model calls, {len(out['writes'])} files written")


if __name__ == "__main__":
    main()
