"""Study Hub: study your lecture slides, with a tutor that explains, gives worked examples, sets
practice problems, marks your work and brings your mistakes back for review.

    python server.py            # http://127.0.0.1:8765, this machine only
    python server.py --open     # also opens the browser
    python server.py --lan      # also reachable from phones on the same network

Nothing is configured here. Any top-level folder with a `study/` subfolder is a course; its decks,
topics and exam dates come from its CLAUDE.md and study/progress.md (see library.py). New slides
show up on the next page load. The tutor's prompts are in tutor.py; its calls go through the Claude
Agent SDK on the Claude Code login (engine.py). Tutor, practice and marking requests sent with
"stream": true are answered as Server-Sent Events: "status" lines, "text" deltas, then "done" (or
"error"). The log records timing and cost only, never question text.
"""
import argparse, http.server, json, os, queue, socketserver, sys, threading, webbrowser
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import library as L
import state as S
import tutor as T

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
PHONE_URL = None    # set in --lan mode: the address phones on the same network use


# ---------------------------------------------------------------- views

def course_summary(cdir):
    info = L.course_info(cdir)
    s = S.load(cdir)
    due = S.due_reviews(cdir, s)
    return {
        "id": cdir.name, "code": info["code"], "title": info["title"],
        "next": L.next_assessment(cdir),
        "reviews": {"count": len(due), "warmup": sum(1 for r in due if r["warmup"]),
                    "minutes": max(1, round(len(due) * 1.5)) if due else 0},
        "topics": [{"name": t["name"], "read_more": t["read_more"],
                    "decks": [dict(_deck_public(info["decks"][tag]), state=S.state_word(s["decks"].get(tag, {})),
                                   last=s["decks"].get(tag, {}).get("last", 1))
                              for tag in t["decks"]]}
                   for t in info["topics"]],
        "resume": S.resume_point(cdir, s),
        "notes": L.class_notes(cdir),
        "docs": L.other_docs(cdir),
    }


def _deck_public(d):
    return {k: d[k] for k in ("tag", "title", "week", "slides", "topic")} | {"prepared": bool(d["transcript"])}


def home():
    courses = [course_summary(c) for c in L.course_dirs()]
    dated = [c for c in courses if c["next"] and c["next"].get("days") is not None]
    suggested = min(dated, key=lambda c: c["next"]["days"])["id"] if dated else (courses[0]["id"] if courses else None)
    return {"courses": courses, "suggested": suggested}


def deck_view(cdir, tag):
    d = L.deck(cdir, tag)
    if not d:
        return None
    s = S.load(cdir)
    chat = T.load_chat(s["chats"].get(tag)) if s["chats"].get(tag) else None
    asked = sorted({m["slide"] for m in (chat or {}).get("messages", []) if m.get("slide")})
    info = L.course_info(cdir)
    topic = next(t for t in info["topics"] if t["name"] == d["topic"])
    return {**_deck_public(d), "course": cdir.name, "code": info["code"], "read_more": topic["read_more"],
            "topic_decks": topic["decks"],
            "slides_text": [{"n": x["n"], "title": x["title"], "md": x["md"], "raw": x.get("raw", False)}
                            for x in L.slide_texts(cdir, tag)],
            "state": s["decks"].get(tag, {}), "chat": chat and T.public_chat(chat), "asked": asked}


# ---------------------------------------------------------------- HTTP

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def log_message(self, fmt, *args):
        pass

    def _local(self):
        return self.client_address[0] in ("127.0.0.1", "::1")

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path, ctype, cache=False):
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if cache:
            self.send_header("Cache-Control", "max-age=3600")
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        if not any(h.lower().startswith(b"cache-control") for h in getattr(self, "_headers_buffer", [])):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _event(self, kind, data):
        try:
            self.wfile.write(f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8"))
            self.wfile.flush()
            return True
        except OSError:         # the browser went away; the work still finishes (and the chat is saved)
            return False

    def _sse(self, work):
        """Run work(emit) on a worker thread and relay what it emits as Server-Sent Events."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.end_headers()
        q, box = queue.Queue(), {}

        def runner():
            try:
                box["out"] = work(lambda kind, data: q.put((kind, data)))
            except T.TutorError as e:
                box["err"] = str(e)
            except Exception as e:
                T.log(f"stream failed: {type(e).__name__}: {str(e)[:300]}")
                box["err"] = "Something went wrong. Try again."
            finally:
                q.put(None)
        threading.Thread(target=runner, daemon=True).start()
        alive = True
        while (item := q.get()) is not None:
            if alive:
                alive = self._event(*item)
        if alive:
            self._event("error", {"error": box["err"]}) if "err" in box else self._event("done", box.get("out"))

    def _answer(self, req, work):
        """Stream when the browser asked for it; otherwise one JSON reply."""
        if req.get("stream"):
            return self._sse(work)
        return self._json(work(None))

    def _course(self, cid):
        return L.course_dir(cid or "")

    def do_GET(self):
        u = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            return self._get(u.path, qs)
        except T.TutorError as e:
            return self._json({"error": str(e)}, e.status)

    def _get(self, path, qs):
        if path == "/api/home":
            return self._json(home())
        if path == "/api/course":
            c = self._course(qs.get("id"))
            return self._json(course_summary(c)) if c else self._json({"error": "Unknown course."}, 404)
        if path == "/api/deck":
            c = self._course(qs.get("course"))
            v = deck_view(c, qs.get("tag", "")) if c else None
            return self._json(v) if v else self._json({"error": "Unknown deck."}, 404)
        if path == "/api/slide":
            c = self._course(qs.get("course"))
            try:
                n = int(qs.get("n", 0))
            except ValueError:
                n = 0
            p = L.slide_image(c, qs.get("tag", ""), n) if c else None
            return self._file(p, "image/jpeg", cache=True) if p else self._json({"error": "No such slide."}, 404)
        if path == "/api/note":
            c = self._course(qs.get("course"))
            ok = c and L.readable_doc(c, qs.get("path", ""))
            return self._file(c / qs["path"], "text/markdown; charset=utf-8") if ok else self._json({"error": "Not found."}, 404)
        if path == "/api/search":
            return self._json(L.search(qs.get("q", "")))
        if path == "/api/reviews":
            c = self._course(qs.get("course"))
            return self._json([{k: r[k] for k in ("id", "concept", "warmup", "deck", "slides", "mistake")}
                               for r in S.due_reviews(c)] if c else [])
        if path == "/api/practice":
            rec = T.get_practice(qs.get("id"))
            return self._json(T.public_problem(rec) | {"photos": len(rec.get("photos", []))}) if rec else \
                self._json({"error": "That problem has expired."}, 404)
        if path == "/api/models":
            return self._json({"default": T.DEFAULT_MODEL, "models": [{"id": k, "label": v} for k, v in T.MODELS.items()]})
        if path == "/api/phone":
            return self._json({"url": PHONE_URL if self._local() else None})
        if path == "/api/chats":
            return self._json(T.list_chats())
        if path == "/api/chat":
            ch = T.load_chat(qs.get("id"))
            return self._json(T.public_chat(ch)) if ch else self._json({"error": "That chat no longer exists."}, 404)
        return super().do_GET()

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n > 20_000_000:
                return None
            return json.loads(self.rfile.read(n) or b"{}")
        except (json.JSONDecodeError, ValueError):
            return None

    def do_POST(self):
        path = urlparse(self.path).path
        req = self._body()
        if req is None:
            return self._json({"error": "Bad request."}, 400)
        try:
            return self._post(path, req)
        except T.TutorError as e:
            return self._json({"error": str(e)}, e.status)

    def _post(self, path, req):
        model = req.get("model") if req.get("model") in T.MODELS else T.DEFAULT_MODEL
        web = not req.get("slides_only")
        if path == "/api/chat/delete":
            f = T.chat_file(str(req.get("id", "")))
            if f and f.exists():
                ch = T.load_chat(req.get("id"))
                if ch and ch.get("deck"):
                    T.engine.close_chat((ch["course"], ch["deck"], ch["id"]))
                    c = self._course(ch["course"])
                    if c and S.chat_for(c, ch["deck"]) == ch["id"]:
                        S.set_chat(c, ch["deck"], None)
                f.unlink()
            return self._json({"ok": True})
        if path == "/api/practice/hint":
            return self._json(T.hint(str(req.get("id", ""))))
        if path == "/api/practice/photo":
            rec = T.get_practice(str(req.get("id", "")))
            c = self._course(rec["course"]) if rec else None
            if not c:
                return self._json({"error": "That problem has expired."}, 404)
            return self._json(T.add_photo(c, rec["id"], req.get("data", "")))
        if path == "/api/practice/check":
            rec = T.get_practice(str(req.get("id", "")))
            c = self._course(rec["course"]) if rec else None
            if not c:
                return self._json({"error": "That problem has expired. Start a new one."}, 404)
            def work(emit):
                out = T.check(c, rec["id"], str(req.get("answer", "")), model, web, emit)
                if req.get("prefetch") and rec["kind"] in ("try", "deck", "mixed"):
                    T.prefetch(c, {"kind": rec["kind"], "tag": rec["tag"], "n": rec["n"], "topics": req.get("topics")}, model, web)
                return out
            return self._answer(req, work)
        c = self._course(req.get("course"))
        if not c:
            return self._json({"error": "Unknown course."}, 404)
        if path == "/api/seen":
            ds = S.mark_seen(c, str(req.get("tag", "")), int(req.get("n") or 1))
            return self._json({"state": ds} if ds else {"error": "Unknown deck."}, 200 if ds else 404)
        if path == "/api/tutor":
            tag = str(req.get("tag", ""))
            if not L.deck(c, tag):
                return self._json({"error": "Open a deck first."}, 400)
            mode = str(req.get("mode", "ask"))
            q = str(req.get("question") or "")
            if mode in ("ask", "brush") and not q.strip():
                return self._json({"error": "Type a question first."}, 400)
            def work(emit):
                chat, msg = T.chat_turn(c, tag, int(req.get("n") or 1), mode, q, model, web, emit)
                return {"chat": chat["id"], "message": msg}
            return self._answer(req, work)
        if path == "/api/practice/new":
            kind = str(req.get("kind", "try"))
            if kind not in T.TASKS:
                return self._json({"error": "Unknown practice kind."}, 400)
            r = {"kind": kind, "tag": req.get("tag"), "n": req.get("n"), "example_md": req.get("example_md", ""),
                 "review_id": req.get("review_id"), "topics": req.get("topics")}
            return self._answer(req, lambda emit: T.public_problem(T.new_problem(c, r, model, web, emit)))
        if path == "/api/review/note":
            r = S.set_note(c, str(req.get("id", "")), str(req.get("note", "")))
            return self._json({"ok": bool(r)})
        return self._json({"error": "Not found."}, 404)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    # On Windows, SO_REUSEADDR lets a second hub bind the same port silently and steal requests;
    # SO_EXCLUSIVEADDRUSE makes a second start fail loudly instead.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt":
            import socket
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def lan_ip():
    """This computer's address on the local network (no traffic is sent)."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--lan", action="store_true", help="also reachable from phones/tablets (anyone) on the same network")
    ap.add_argument("--open", action="store_true", help="open the browser")
    args = ap.parse_args()
    global PHONE_URL
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    url = f"http://127.0.0.1:{args.port}/"
    if args.lan:
        PHONE_URL = f"http://{lan_ip()}:{args.port}/"
    try:
        srv = Server((host, args.port), Handler)
    except OSError:
        print(f"Port {args.port} is already in use — the Study Hub is probably already running.\n"
              f"Open {url} in your browser, or close the other window first.")
        if args.open:
            webbrowser.open(url)
        sys.exit(1)
    print(f"Study Hub is running on this computer: {url}")
    if args.lan:
        print(f"\nOn your phone or tablet (same Wi-Fi), open:\n\n    {PHONE_URL}\n\n"
              "or scan the QR code in the Study Hub's ⋯ menu → Open on your phone.\n"
              "Anyone on this network can open it. If Windows Firewall asks, allow Python on private networks.")
    print("\nKeep this window open while you study. Close it (or press Ctrl+C) to stop the hub.")
    T.log(f"start host={host} port={args.port}")
    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        T.engine.shutdown()


if __name__ == "__main__":
    main()
