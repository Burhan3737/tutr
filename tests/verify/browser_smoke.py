"""The web app in a real (headless) browser, on one hub or on two side by side: home, every course page, a slide, the
tutor answering (with a drawing and maths), a notes page, the review page. The model is replaced by a fixed answer.
Needs Playwright with Chromium (pip install playwright; playwright install chromium).

    python tests/verify/browser_smoke.py --code <hub folder> --root <library> --work <scratch folder>
                                         [--old-code <hub folder> --old-root <old-layout library>]

Each hub runs on a copy of its library, in-process on 127.0.0.1 on a free port (server.main() is never called: no
other hub is stopped, no browser window opens). Writes <work>/browser-<name>.json (each page's visible text, console
errors) and screenshots; with --old-*, also compares each page's visible text between the two hubs (the title and
the removed warm-up lines aside) and prints the differences. Exit code 1 on a page error or a failed step.
"""
import argparse, difflib, json, os, re, shutil, subprocess, sys, time
from pathlib import Path

SKIP = shutil.ignore_patterns(".git", "__pycache__", "library", "agentTempWork", ".cache", "tests", "docs", "tools",
                              "example-library", ".claude", "config.json")
ANSWER = ("Here is the idea in one picture.\n\n```mermaid\nflowchart TD\n  A[Start] --> B[Finish]\n```\n\n"
          "And the formula: $$x^2 + 2x + 1 = (x+1)^2$$\n\nSTUB-ANSWER-END")


def serve_child(code, root, port_file):
    os.environ["STUDY_HUB_ROOT"] = root
    sys.path.insert(0, code)
    import server as SV, tutor as T, opencode_engine as OE, voice as V
    OE.known_models = lambda *a, **k: []          # no OpenCode server started for the model list
    V.warm = lambda *a, **k: None                 # no speech models loaded

    def fake(cdir, system, prompt, *, model, emit=None, schema=None, **kw):
        if emit:
            emit("status", "Writing it up")
            for part in re.split(r"(?<=\n)", ANSWER):
                emit("text", part)
        js = {"problem_md": "Find x when 2x = 4.", "solution_md": "x = 2", "final_answer": "2", "hints": ["a", "b"],
              "concept": "c", "slides": "s2", "deck": ""} if schema else None
        return {"text": ANSWER, "json": js, "session": "s", "ms": 1, "cost": 0}
    T.run_model = fake
    T.open_chat = lambda *a, **k: None
    srv = SV.Server(("127.0.0.1", 0), SV.Handler)
    Path(port_file).write_text(str(srv.server_address[1]))
    srv.serve_forever()


def start(name, code, root, work):
    lib, cdir = work / f"{name}-library", work / f"{name}-code"
    for d in (lib, cdir):
        if d.exists():
            shutil.rmtree(d)
    shutil.copytree(root, lib, ignore=shutil.ignore_patterns("__pycache__"))
    code, root = Path(code).resolve(), Path(root).resolve()
    try:                                      # code that lives inside its library goes with the copy
        cdir = lib / code.relative_to(root)
    except ValueError:
        shutil.copytree(code, cdir, ignore=SKIP)
    pf = work / f"{name}.port"
    pf.unlink(missing_ok=True)
    proc = subprocess.Popen([sys.executable, __file__, "--serve", str(cdir), str(lib), str(pf)])
    for _ in range(300):
        if pf.is_file() and pf.read_text():
            return proc, int(pf.read_text())
        time.sleep(0.1)
    proc.kill()
    raise SystemExit(f"{name}: the hub didn't start")


def visit(page, name, port, work):
    base = f"http://127.0.0.1:{port}/"
    errors, out = [], {"pages": {}, "steps": {}}
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

    def shot(key, url, wait=None):
        page.goto(url)
        page.wait_for_load_state("networkidle")
        if wait:
            page.wait_for_function(wait, timeout=20000)
        page.wait_for_timeout(700)                # the page settles (the last view's text is gone)
        out["pages"][key] = page.inner_text("main")
        page.screenshot(path=str(work / f"{name}-{re.sub(r'[^A-Za-z0-9]+', '_', key)}.png"))

    shot("home", base, "document.querySelector('main') && document.querySelector('main').innerText.length > 20")
    out["steps"]["title"] = page.title()
    home = page.evaluate("fetch('/api/home').then(r => r.json())")
    for c in home["courses"]:
        cid = c["id"]
        shot(f"course {cid}", f"{base}#c={cid}", "document.querySelector('main').innerText.length > 20")
        if c["notes"]:
            shot(f"notes {cid}", f"{base}#c={cid}&notes={c['notes'][0]['path']}",
                 "document.querySelector('main').innerText.length > 5")
    c = home["courses"][0]
    deck = next(d for t in c["topics"] for d in t["decks"] if d["slides"] >= 2)
    shot("slide", f"{base}#c={c['id']}&d={deck['tag']}&s=2",
         "[...document.images].some(i => i.src.includes('/api/slide') && i.complete && i.naturalWidth > 0)")
    out["steps"]["slide image loaded"] = True
    page.keyboard.press("ArrowRight")
    page.wait_for_function("location.hash.endsWith('s=3')", timeout=10000)
    out["steps"]["next slide by arrow key"] = True
    opener = page.get_by_role("button", name="Open the tutor")
    if opener.count():
        opener.first.click()
    page.get_by_role("button", name="Explain simply").first.click()
    page.wait_for_function("document.body.innerText.includes('STUB-ANSWER-END')", timeout=30000)
    page.wait_for_timeout(1500)
    out["steps"]["tutor answer shown"] = True
    out["steps"]["drawing rendered (svg in the answer)"] = page.evaluate(
        "[...document.querySelectorAll('svg')].some(s => s.closest('[class*=answer], [class*=msg], [class*=chat]'))")
    out["steps"]["maths rendered (KaTeX)"] = page.evaluate("document.querySelectorAll('.katex').length > 0")
    page.screenshot(path=str(work / f"{name}-tutor.png"))
    shot("reviews", f"{base}#review={c['id']}", "document.querySelector('main').innerText.length > 5")
    out["errors"] = errors
    return out


def norm(text):
    text = text.replace("Study Hub", "Tutr")
    return "\n".join(l for l in text.splitlines() if "Warm-up" not in l)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--serve":
        return serve_child(*sys.argv[2:5])
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for a in ("--code", "--root", "--work"):
        ap.add_argument(a, required=True)
    ap.add_argument("--old-code")
    ap.add_argument("--old-root")
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright
    work = Path(args.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    hubs = [("new", args.code, args.root)] + ([("old", args.old_code, args.old_root)] if args.old_code else [])
    results, procs, bad = {}, [], []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for name, code, root in hubs:
                proc, port = start(name, code, root, work)
                procs.append(proc)
                page = browser.new_page(viewport={"width": 1400, "height": 900})
                try:
                    results[name] = visit(page, name, port, work)
                except Exception as e:
                    results[name] = {"failed": f"{type(e).__name__}: {e}"}
                    page.screenshot(path=str(work / f"{name}-failure.png"))
                (work / f"browser-{name}.json").write_text(json.dumps(results[name], ensure_ascii=False, indent=1),
                                                           encoding="utf-8")
                r = results[name]
                print(f"{name}: " + ("FAILED " + r["failed"] if "failed" in r else
                                     f"{len(r['pages'])} pages, steps {r['steps']}, {len(r['errors'])} console errors"))
                for e in r.get("errors", []):
                    print(f"  console: {e[:300]}")
                if "failed" in r or r.get("errors") or not all(r.get("steps", {}).values()):
                    bad.append(name)
            browser.close()
    finally:
        for proc in procs:
            proc.kill()
    if "old" in results and "pages" in results["old"] and "pages" in results.get("new", {}):
        a, b = results["old"]["pages"], results["new"]["pages"]
        for key in sorted(set(a) | set(b)):
            ta, tb = norm(a.get(key, "<missing>")), norm(b.get(key, "<missing>"))
            if ta != tb:
                print(f"--- page text differs: {key}")
                print("\n".join(difflib.unified_diff(ta.splitlines(), tb.splitlines(), "old", "new", n=0, lineterm=""))[:3000])
            else:
                print(f"same page text: {key}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
