"""Study Hub: study your lecture slides, with a tutor that explains, gives worked examples, sets
practice problems, marks your work and brings your mistakes back for review.

    python server.py            # http://127.0.0.1:8765, this machine only
    python server.py --open     # also opens the browser
    python server.py --lan      # also reachable from phones on the same network
    python server.py --tunnel   # also reachable from anywhere, via a Cloudflare quick tunnel

Nothing is configured here. Any top-level folder with a `study/` subfolder is a course; its decks,
topics and exam dates come from its CLAUDE.md and study/progress.md (see library.py). New slides
show up on the next page load. The tutor's prompts are in tutor.py; its calls go to one of two engines,
chosen by the model: the Claude Agent SDK on the Claude Code login (engine.py) or a private OpenCode
server (opencode_engine.py, models like "opencode/big-pickle"). Tutor, practice and marking requests
sent with "stream": true are answered as Server-Sent Events: "status" lines, "text" deltas, then
"done" (or "error"). The log records timing and cost only, never question text.
Devices with the same course open see each other live (drafts.py) by long polling GET /api/live: the course's
Ask-box draft (text and photos), the tutor turns being answered in its chat, and chat switches, each request
answered as soon as something happens; POST /api/draft saves a change to the draft. (Not a long-lived stream:
Cloudflare's quick tunnels hold a reply back until it ends, so a stream would never reach a phone on one.)
"""
import argparse, base64, binascii, http.server, json, os, queue, re, shutil, socketserver, subprocess, sys, threading, time, webbrowser
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import drafts as D
import library as L
import state as S
import tutor as T
import voice as V

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
DRAFTS = D.Drafts(T.WORK / "drafts.json")
PHONE_URL = None    # --lan: the address phones on the same network use; --tunnel: the public Cloudflare link


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
        "topics": [{"name": t["name"], "read_more": t["read_more"], "decks": [_deck_row(info, s, tag) for tag in t["decks"]]}
                   for t in info["topics"]],
        "practice": [_deck_row(info, s, tag) for tag in info["practice"]],
        "resume": S.resume_point(cdir, s),
        "notes": L.class_notes(cdir),
        "docs": L.other_docs(cdir),
    }


def _deck_row(info, s, tag):
    return dict(_deck_public(info["decks"][tag]), state=S.state_word(s["decks"].get(tag, {})),
                last=s["decks"].get(tag, {}).get("last", 1))


def _deck_public(d):
    return {k: d[k] for k in ("tag", "title", "week", "slides", "topic", "order")} | {"prepared": bool(d["transcript"])}


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
    chat_id = T.current_chat(cdir)
    chat = T.load_chat(chat_id) if chat_id else None
    asked = sorted({m["slide"] for m in (chat or {}).get("messages", [])       # older messages carry no deck: the chat's
                    if m.get("slide") and (m["deck"] if isinstance(m.get("deck"), str) else chat.get("deck")) == tag})
    info = L.course_info(cdir)
    topic = next((t for t in info["topics"] if t["name"] == d["topic"]),
                 {"read_more": "", "decks": info["practice"]})       # a practice deck: its siblings are the practice decks
    chats = [c for c in T.course_chats(cdir) if not chat or c["id"] != chat["id"]][:5]
    return {**_deck_public(d), "course": cdir.name, "code": info["code"], "read_more": topic["read_more"], "chats": chats,
            "topic_decks": topic["decks"],
            "slides_text": [{"n": x["n"], "title": x["title"], "md": x["md"], "raw": x.get("raw", False)}
                            for x in L.slide_texts(cdir, tag)],
            "state": s["decks"].get(tag, {}), "chat": chat and T.public_chat(chat), "asked": asked}


# ---------------------------------------------------------------- HTTP

def _int(v, default=1):
    """A slide number or similar from a request; garbage -> the default instead of an error."""
    try:
        return int(v or default)
    except (TypeError, ValueError, OverflowError):
        return default


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

    def _live(self, c, qs):
        """One long poll of the course's live channel (drafts.py): waits until there's news for this device, then
        answers with it. A snapshot also says which chat is the course's now, for a device catching up."""
        try:
            since = int(qs["since"]) if qs.get("since") else None
        except ValueError:
            since = None
        out = DRAFTS.poll(c.name, qs.get("client", ""), since, qs.get("epoch"))
        if out["snapshot"] is not None:
            out["snapshot"]["chat"] = T.current_chat(c)
        try:
            self._json(out)
        except OSError:         # the device went away while it waited (tab closed, phone asleep, network gone)
            pass

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
        if path == "/api/drill/setup":     # the exam drill's setup dialog: decks by topic, papers, a default range
            c = self._course(qs.get("course"))
            return self._json(T.drill_setup(c) if c else {"error": "Unknown course."}, 200 if c else 404)
        if path == "/api/upload":          # a photo attached in the Ask box, or sent with a question
            c = self._course(qs.get("course"))
            rel = qs.get("path", "")
            ok = c and T.is_upload(c, rel)
            return self._file(c / rel, {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}[rel.rsplit(".", 1)[-1]],
                              cache=True) if ok else self._json({"error": "No such photo."}, 404)
        if path == "/api/practice":
            rec = T.get_practice(qs.get("id"))
            return self._json(T.public_problem(rec) | {"photos": len(rec.get("photos", []))}) if rec else \
                self._json({"error": "That problem has expired."}, 404)
        if path == "/api/models":       # Claude Code's models, then OpenCode's, each with an intelligence score
            return self._json(T.model_catalog())
        if path == "/api/phone":
            return self._json({"url": PHONE_URL if self._local() else None})
        if path == "/api/live":
            c = self._course(qs.get("course"))
            return self._live(c, qs) if c else self._json({"error": "Unknown course."}, 404)
        if path == "/api/chats":
            return self._json(T.list_chats())
        if path == "/api/chat":
            ch = T.load_chat(qs.get("id"))
            return self._json(T.public_chat(ch)) if ch else self._json({"error": "That chat no longer exists."}, 404)
        if path == "/api/voice/status":
            return self._json(V.status())
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
        except V.VoiceError as e:       # 400: a bad recording or request; 503: the models aren't available
            return self._json({"error": str(e)}, e.status)
        except ConnectionError:         # the browser went away (e.g. stopped an answer's audio): nothing to answer
            return
        except Exception as e:          # answer rather than drop the connection
            T.log(f"{path} failed: {type(e).__name__}: {str(e)[:300]}")
            try:
                return self._json({"error": "Something went wrong. Try again."}, 500)
            except OSError:
                pass

    def _post(self, path, req):
        model = req.get("model") if T.valid_model(req.get("model")) else T.DEFAULT_MODEL
        web = not req.get("slides_only")
        if path == "/api/voice/warm":        # Voice chosen (or dictation started): load the speech models now
            V.warm()
            c = self._course(req.get("course"))
            if c and L.deck(c, str(req.get("tag") or "")):     # and open the course's conversation, if it says which deck
                T.warm_chat(c, str(req["tag"]), model, web)
            return self._json(V.status())
        if path == "/api/voice/speak":       # one sentence of an answer -> WAV
            text = str(req.get("text") or "").strip()[:1200]
            if not text:
                return self._json({"error": "Nothing to say."}, 400)
            data = V.speak(text, str(req.get("voice") or ""), req.get("speed"))
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path == "/api/voice/transcribe":  # the recording, as 16 kHz mono WAV in base64 -> text
            try:
                audio = base64.b64decode(str(req.get("audio") or "").split(",")[-1], validate=True)
            except (binascii.Error, ValueError):
                return self._json({"error": "The recording didn't arrive. Try again."}, 400)
            c = self._course(req.get("course"))
            tag = str(req.get("tag", ""))
            d = L.deck(c, tag) if c else None
            hint = ""
            if d:           # the deck's and slide's titles (every slide's, for Whole deck), so course terms are heard right
                slides = L.slide_texts(c, tag)
                if req.get("scope") == "deck":
                    titles = [t for t in dict.fromkeys(x["title"] for x in slides if x["title"]) if t != d["title"]]
                    keep = []       # Whisper only keeps the end of its prompt: the last titles that fit in ~600 chars
                    while titles and len(". ".join([titles[-1]] + keep)) <= 600:
                        keep.insert(0, titles.pop())
                    hint = ". ".join(keep + [d["title"]])
                else:
                    s = next((x for x in slides if x["n"] == _int(req.get("n"))), None)
                    hint = ". ".join(x for x in (d["title"], s and s["title"]) if x)
            return self._json({"text": V.transcribe(audio, hint)})
        if path == "/api/chat/delete":
            f = T.chat_file(str(req.get("id", "")))
            if f and f.exists():
                ch = T.load_chat(req.get("id"))
                if ch and ch.get("course"):
                    T.close_chat((ch["course"], ch["id"]))
                    c = self._course(ch["course"])
                    if c and T.current_chat(c) == ch["id"]:
                        S.set_chat(c, None)
                        DRAFTS.chat_switched(c.name, None, req.get("client"))
                f.unlink()
            return self._json({"ok": True})
        if path == "/api/chat/update":       # rename and/or star
            return self._json(T.update_chat(str(req.get("id", "")), req.get("title"), req.get("starred")))
        if path == "/api/chat/open":         # make a saved chat the course's current one
            ch = T.load_chat(str(req.get("id", "")))
            c = self._course(ch["course"]) if ch else None
            if not c or not ch.get("deck"):
                return self._json({"error": "That chat can't be continued."}, 404)
            S.set_chat(c, ch["id"])
            DRAFTS.chat_switched(c.name, ch["id"], req.get("client"))
            return self._json({"course": ch["course"], "deck": ch["deck"]})
        if path == "/api/client-log":        # a drawing that failed in the browser (visuals.js)
            clip = lambda k, n: json.dumps(str(req.get(k) or "")[:n], ensure_ascii=False)
            kind = "".join(ch for ch in str(req.get("kind") or "") if ch.isalnum())[:20] or "?"
            T.log(f"client:{kind} where={clip('where', 200)} "
                  f"error={clip('error', 500)} src={clip('src', 4000)}")
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
                if req.get("prefetch") and rec["kind"] in ("try", "deck", "mixed") and not rec.get("focus"):
                    T.prefetch(c, {"kind": rec["kind"], "tag": rec["tag"], "n": rec["n"], "topics": req.get("topics")}, model, web)
                return out
            return self._answer(req, work)
        c = self._course(req.get("course"))
        if not c:
            return self._json({"error": "Unknown course."}, 404)
        if path == "/api/chat/new":          # the next question in this course starts a fresh conversation
            S.set_chat(c, None)
            DRAFTS.chat_switched(c.name, None, req.get("client"))
            return self._json({"ok": True})
        if path == "/api/draft":            # a change to the Ask box's unsent text (drafts.py)
            try:
                ok, d = DRAFTS.save(c.name, req.get("client"), req.get("text"), req.get("base"), req.get("spoken") is True)
            except D.DraftError as e:
                return self._json({"error": str(e)}, 400)
            return self._json({"ok": ok, **d})
        if path == "/api/draft/photo":      # attach a photo to the Ask box: it shows on every device (drafts.py)
            if len(DRAFTS.get(c.name)["photos"]) >= D.MAX_PHOTOS:
                return self._json({"error": f"A question can have {D.MAX_PHOTOS} photos at most."}, 400)
            rel = T.save_ask_photo(c, req.get("data", ""))
            try:
                return self._json(DRAFTS.add_photo(c.name, req.get("client"), rel))
            except D.DraftError as e:       # (another device's photo got there first)
                (c / rel).unlink(missing_ok=True)
                return self._json({"error": str(e)}, 400)
        if path == "/api/draft/photo/remove":
            rel = str(req.get("path", ""))
            gone, d = DRAFTS.remove_photo(c.name, req.get("client"), rel)
            if gone and T.is_upload(c, rel):        # never sent with a question: nothing else refers to it
                (c / rel).unlink(missing_ok=True)
            return self._json(d)
        if path == "/api/seen":
            ds = S.mark_seen(c, str(req.get("tag", "")), _int(req.get("n")))
            return self._json({"state": ds} if ds else {"error": "Unknown deck."}, 200 if ds else 404)
        if path == "/api/tutor":
            tag = str(req.get("tag", ""))
            if not L.deck(c, tag):
                return self._json({"error": "Open a deck first."}, 400)
            mode = str(req.get("mode", "ask"))
            q = str(req.get("question") or "")
            photos = req.get("photos") if isinstance(req.get("photos"), list) else []
            if mode in ("ask", "brush", "voice", "grill_reply") and not q.strip() and not photos:
                return self._json({"error": "Type a question first."}, 400)
            drill = None
            if mode == "drill":
                d = req.get("drill") or {}
                drill = T.drill_config(c, d.get("decks"), d.get("papers"), d.get("focus"))
            n, spoken = _int(req.get("n")), req.get("spoken") is True
            def work(emit):
                # The photos attached in the Ask box go with this question: they come off the box on every device
                # (back on if the turn fails).
                sent = DRAFTS.take_photos(c.name, photos)
                # The other devices with this course open watch the turn too: the question, then the answer as it's
                # written (drafts.py). The asking device knows the turn by the id it sent.
                turn = DRAFTS.turn_start(c.name, {"turn": req.get("turn"), "mode": mode, "question": q, "tag": tag,
                                                  "n": n, "spoken": spoken, "whole": req.get("scope") == "deck", "photos": sent})
                def both(kind, data):
                    DRAFTS.turn_event(c.name, turn, kind, data)
                    if emit:
                        emit(kind, data)
                try:
                    chat, msg = T.chat_turn(c, tag, n, mode, q, model, web, both,
                                            whole_deck=req.get("scope") == "deck", spoken=spoken, drill=drill, photos=sent)
                except Exception as e:
                    DRAFTS.turn_end(c.name, turn, error=str(e) if isinstance(e, T.TutorError) else "Something went wrong. Try again.")
                    for rel in sent:
                        try:
                            DRAFTS.add_photo(c.name, "", rel)
                        except D.DraftError:
                            break
                    raise
                DRAFTS.turn_end(c.name, turn, chat=chat["id"])
                return {"chat": chat["id"], "message": msg, "drill": chat.get("drill")}
            return self._answer(req, work)
        if path == "/api/side":              # a side question about a term or a selection (forks the chat)
            tag = str(req.get("tag", ""))
            if not L.deck(c, tag):
                return self._json({"error": "Open a deck first."}, 400)
            side, q = req.get("side") or None, str(req.get("question") or "")
            if side and not q.strip():
                return self._json({"error": "Type a question first."}, 400)
            def work(emit):
                sid, msg = T.side_turn(c, tag, _int(req.get("n")), side and str(side), str(req.get("chat") or ""),
                                       str(req.get("anchor") or ""), str(req.get("para") or ""), q, model, web, emit)
                return {"side": sid, "message": msg}
            return self._answer(req, work)
        if path == "/api/side/close":
            T.side_close(str(req.get("side") or ""))
            return self._json({"ok": True})
        if path == "/api/practice/new":
            kind = str(req.get("kind", "try"))
            if kind not in T.TASKS:
                return self._json({"error": "Unknown practice kind."}, 400)
            r = {"kind": kind, "tag": req.get("tag"), "n": req.get("n"), "example_md": req.get("example_md", ""),
                 "review_id": req.get("review_id"), "topics": req.get("topics"), "focus": str(req.get("focus") or "")}
            return self._answer(req, lambda emit: T.public_problem(T.new_problem(c, r, model, web, emit)))
        if path == "/api/review/note":
            r = S.set_note(c, str(req.get("id", "")), str(req.get("note", "")))
            return self._json({"ok": bool(r)})
        return self._json({"error": "Not found."}, 404)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    # Every listening device asks again the moment it's answered (long polling, drafts.py): many at once overflow
    # the default queue of 5 waiting connections, and Windows retries a refused one only after 1-3 s.
    request_queue_size = 128
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


def start_tunnel(port, found):
    """Run `cloudflared tunnel --url` for the hub; call found(link) once it prints its trycloudflare.com
    link, or found(None) if it exits without one. No account or router setup; anyone with the link can
    open the hub. Returns the process, or None when cloudflared isn't installed."""
    exe = shutil.which("cloudflared") or next((str(p) for p in (
        Path(os.environ.get("ProgramFiles(x86)", "")) / "cloudflared" / "cloudflared.exe",
        Path(os.environ.get("ProgramFiles", "")) / "cloudflared" / "cloudflared.exe") if p.is_file()), None)
    if not exe:
        return None
    proc = subprocess.Popen([exe, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                            errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def watch():        # cloudflared logs to stderr; the link is in one of the first lines
        link = None
        for line in proc.stderr:
            m = link is None and re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if m:
                link = m.group(0) + "/"
                found(link)
        if link is None:
            found(None)
    threading.Thread(target=watch, daemon=True).start()
    return proc


def _is_hub(port):
    """True when a Study Hub answers on this port of this computer."""
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1) as r:
            return b"<title>Study Hub</title>" in r.read(4096)
    except OSError:
        return False


def _port_pid(port):
    """The process listening on a local port, or None."""
    try:
        if os.name == "nt":
            out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True, timeout=10).stdout
            for line in out.splitlines():
                f = line.split()
                if len(f) == 5 and f[3] == "LISTENING" and f[1].rsplit(":", 1)[-1] == str(port):
                    return int(f[4])
        else:
            out = subprocess.run(["lsof", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"], capture_output=True, text=True, timeout=10).stdout
            return int(out.split()[0]) if out.split() else None
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def _hub_window(pid):
    """On Windows, the start.bat window a hub runs in (so closing it leaves no window behind), else the hub itself."""
    if os.name != "nt":
        return pid
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command",
                              f"$p = Get-CimInstance Win32_Process -Filter 'ProcessId={pid}'; "
                              "$w = Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.ParentProcessId)\"; "
                              "if ($w -and $w.CommandLine -like '*start.bat*') { $w.ProcessId }"],
                             capture_output=True, text=True, timeout=15).stdout.strip()
        return int(out) if out else pid
    except (OSError, ValueError, subprocess.SubprocessError):
        return pid


def stop_other_hubs(first, count=20):
    """Close every Study Hub already running on this computer (its window, and its Cloudflare tunnel with it), so there
    is only ever one. Two hubs each keep their own live channel (drafts.py): devices on different ones never see each
    other's typing or answers. Returns the ports they were on."""
    stopped = []
    for port in range(first, first + count):
        pid = _is_hub(port) and _port_pid(port)
        if not pid or pid == os.getpid():
            continue
        target = _hub_window(pid)
        if os.name == "nt":
            ok = subprocess.run(["taskkill", "/PID", str(target), "/T", "/F"], capture_output=True).returncode == 0
        else:
            try:
                os.kill(target, 15)
                ok = True
            except OSError:
                ok = False
        if ok:
            stopped.append(port)
    end = time.time() + 5           # until their ports are free
    while stopped and time.time() < end and any(_port_pid(p) for p in stopped):
        time.sleep(0.2)
    return stopped


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--lan", action="store_true", help="also reachable from phones/tablets (anyone) on the same network")
    ap.add_argument("--tunnel", action="store_true",
                    help="also reachable from anywhere through a Cloudflare quick tunnel (anyone with the link)")
    ap.add_argument("--open", action="store_true", help="open the browser")
    args = ap.parse_args()
    sys.stdout.reconfigure(errors="replace")    # the ⋯ and → below can't be encoded on some consoles
    global PHONE_URL
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    srv, wanted = None, args.port
    old = stop_other_hubs(wanted)
    if old:
        print(f"Closed the Study Hub that was already running (port {', '.join(map(str, old))}): only one runs at a time,\n"
              "so every device sees the same live chat. Open the link below on your devices.\n")
    for args.port in range(wanted, wanted + 20):     # port taken (another app): try the next one
        try:
            srv = Server((host, args.port), Handler)
            break
        except OSError:
            continue
    if not srv:
        print(f"Ports {wanted}-{wanted + 19} are all in use. Close some other Study Hub windows and try again.")
        sys.exit(1)
    url = f"http://127.0.0.1:{args.port}/"
    if args.lan:
        PHONE_URL = f"http://{lan_ip()}:{args.port}/"
    if args.port != wanted:
        print(f"Port {wanted} is already in use (another Study Hub window?), so this one uses port {args.port}.")
    print(f"Study Hub is running on this computer: {url}")
    if args.lan:
        print(f"\nOn your phone or tablet (same Wi-Fi), open:\n\n    {PHONE_URL}\n\n"
              "or scan the QR code in the Study Hub's ⋯ menu → Open on your phone.\n"
              "Anyone on this network can open it. If Windows Firewall asks, allow Python on private networks.")
    tunnel, ready = None, threading.Event()
    if args.tunnel:
        def found(link):
            global PHONE_URL
            PHONE_URL = link
            ready.set()
            if link:
                print(f"\nFrom anywhere (any Wi-Fi or mobile data), open:\n\n    {link}\n\n"
                      "or scan the QR code in the Study Hub's ⋯ menu → Open on your phone.\n"
                      "Anyone with this link can open the hub, so don't share it. It changes every time the hub starts.")
            else:
                print("\nThe Cloudflare tunnel didn't start (no internet?), so the hub works on this computer only.")
        print("\nStarting the Cloudflare tunnel...")
        tunnel = start_tunnel(args.port, found)
        if not tunnel:
            print("cloudflared isn't installed, so there's no link for other networks. Install it with\n"
                  "    winget install --id Cloudflare.cloudflared\nthen start the hub again.")
    if not tunnel:
        ready.set()
    print("\nKeep this window open while you study. Close it (or press Ctrl+C) to stop the hub.")
    T.log(f"start host={host} port={args.port} tunnel={bool(tunnel)}")
    # Models already on disk load in the background now (a few seconds), so reading aloud and dictation are ready when
    # first used. A first-ever download still waits until voice is used.
    threading.Thread(target=lambda: V.downloaded() and V.warm(), daemon=True).start()
    if args.open:       # with a tunnel, wait for its link so the page loads with "Open on your phone" in the menu
        threading.Thread(target=lambda: (ready.wait(30), webbrowser.open(url)), daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if tunnel:
            tunnel.terminate()
        DRAFTS.flush()
        T.shutdown()


if __name__ == "__main__":
    main()
