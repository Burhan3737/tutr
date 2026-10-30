"""Checks for the preparing-slides scripts (add.py, extract.py, check.py) against the hub's reader (library.py).
A plain script:

    python .claude/skills/preparing-slides/tests/test_scripts.py

Builds a made-up course (Demo-Course) with generated PDFs in a temporary folder under the repo's .cache/, runs the
Add and Prepare stages on it, and loads the result with library.py the way the hub does.
"""
import json, os, re, shutil, subprocess, sys, tempfile
from pathlib import Path

import fitz

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
REPO = HERE.parents[3]
FAILED = []


def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        FAILED.append(name)


def run(script, *args):
    r = subprocess.run([sys.executable, str(SCRIPTS / script), *map(str, args)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return r.returncode, r.stdout + r.stderr


def make_pdf(path, pages, outline=None):
    """pages: list of (kind, text). kind 'text' = a text-rich page; 'drawing' = a chart of many lines; 'short'."""
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = fitz.open()
    for kind, text in pages:
        page = doc.new_page(width=720, height=405)
        page.insert_textbox(fitz.Rect(36, 36, 684, 380), text, fontsize=12)
        if kind == "drawing":
            for i in range(30):
                page.draw_line((100 + i * 10, 300), (110 + i * 10, 200 - i * 3))
    if outline:
        doc.set_toc(outline)
    doc.save(path)
    doc.close()


LONG = ("Price elasticity\nThe price elasticity of demand measures how strongly the quantity demanded responds to a "
        "change in price. When demand is elastic, a small rise in price brings a large fall in quantity; when it is "
        "inelastic, quantity barely moves. Goods with close substitutes tend to have elastic demand.")


def hub(lib, code):
    """Run code with the hub's library.py loaded on the given library; returns the JSON it prints."""
    env = dict(os.environ, STUDY_HUB_ROOT=str(lib))
    r = subprocess.run([sys.executable, "-c", "import json, library as L\n" + code], cwd=REPO, env=env,
                       capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        raise RuntimeError(r.stderr)
    return json.loads(r.stdout)


INFO = """
c = L.course_dir("Demo-Course")
info = L.course_info(c)
out = {"topics": info["topics"], "practice": info["practice"], "decks": info["decks"],
       "texts": {t: L.slide_texts(c, t) for t in info["decks"]},
       "images": {t: [bool(L.slide_image(c, t, n)) for n in range(1, d["slides"] + 1)] for t, d in info["decks"].items()}}
print(json.dumps(out))
"""


def main():
    (REPO / ".cache").mkdir(exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="slides-test-", dir=REPO / ".cache"))
    try:
        body(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{len(FAILED)} failed" + (": " + ", ".join(FAILED) if FAILED else ""))
    sys.exit(1 if FAILED else 0)


def body(tmp):
    lib = tmp / "library"
    c = lib / "Demo-Course"
    c.mkdir(parents=True)
    (c / "course.json").write_text(json.dumps({"code": "DEMO101", "title": "Demo Course", "topics": []}), encoding="utf-8")
    w1 = c / "sources" / "Week1" / "Supply_and_Demand_1.pdf"
    make_pdf(w1, [("text", LONG), ("drawing", "Demand curve"), ("short", "Questions?")])
    make_pdf(c / "sources" / "Week2" / "Supply and Demand 2.pdf", [("text", LONG), ("short", "Summary")])
    make_pdf(c / "sources" / "practice" / "HW1.pdf", [("text", "Question 1. Compute the price elasticity."), ("short", "")])

    # ---- Add
    code, out = run("add.py", c, "--list")
    check("add --list shows new PDFs with default tags", code == 0 and out.count("NEW") == 3
          and "tag=Supply-and-Demand-2" in out, out)
    check("add --list writes nothing", not (c / "decks").exists())
    code, out = run("add.py", c, w1, "--tag", "S&D-1", "--title", "Supply and Demand 1")
    check("add one PDF with a tag", code == 0 and (c / "decks" / "SD-1" / "deck.json").is_file(), out)
    code, out = run("add.py", c)
    check("add the rest of sources/", code == 0, out)
    d1 = json.loads((c / "decks" / "SD-1" / "deck.json").read_text(encoding="utf-8"))
    check("deck.json fields", {k: d1.get(k) for k in ("tag", "title", "role", "week", "topic", "order", "pages",
                                                       "prepared", "source")} ==
          {"tag": "S&D-1", "title": "Supply and Demand 1", "role": "lecture", "week": 1, "topic": "Unsorted",
           "order": 0, "pages": 3, "prepared": False, "source": "sources/Week1/Supply_and_Demand_1.pdf"}, d1)
    d2 = json.loads((c / "decks" / "Supply-and-Demand-2" / "deck.json").read_text(encoding="utf-8"))
    check("default tag and title from the file name", d2["tag"] == "Supply-and-Demand-2"
          and d2["title"] == "Supply and Demand 2" and d2["week"] == 2 and d2["order"] == 0, d2)
    hw = json.loads((c / "decks" / "HW1" / "deck.json").read_text(encoding="utf-8"))
    check("practice deck: role, no topic, latest lecture week, next order",
          (hw["role"], hw["topic"], hw["week"], hw["order"]) == ("practice", "", 2, 1), hw)
    check("one image per page", sorted(p.name for p in (c / "decks" / "SD-1").glob("*.jpg")) ==
          ["s001.jpg", "s002.jpg", "s003.jpg"])
    tr = (c / "decks" / "SD-1" / "transcript.md").read_text(encoding="utf-8")
    check("rough transcript sections", re.findall(r"^## \[S&D-1 s(\d+)\]", tr, re.M) == ["1", "2", "3"], tr[:300])
    code, out = run("check.py", c, "all", "deck")
    check("check deck: all OK after add", code == 0, out)
    code, out = run("check.py", c, "all", "sorted")
    check("check sorted fails before Prepare", code == 1 and "not filed under a topic" in out, out)

    h = hub(lib, INFO)
    check("hub lists the decks", set(h["decks"]) == {"S&D-1", "Supply-and-Demand-2", "HW1"}, list(h["decks"]))
    check("hub: unsorted lecture decks under 'Not sorted yet'",
          [t["name"] for t in h["topics"]] == ["Not sorted yet"] and h["topics"][0]["decks"] == ["S&D-1", "Supply-and-Demand-2"],
          h["topics"])
    check("hub: practice list", h["practice"] == ["HW1"], h["practice"])
    s = h["texts"]["S&D-1"]
    check("hub: rough texts are raw, titled from the first line",
          len(s) == 3 and all(x.get("raw") for x in s) and s[0]["title"] == "Price elasticity" and "elastic" in s[0]["md"], s)
    check("hub: every slide image found", all(all(v) for v in h["images"].values()), h["images"])
    check("hub: not prepared", h["decks"]["S&D-1"]["prepared"] is False)

    # ---- idempotent
    mt = (c / "decks" / "SD-1" / "s001.jpg").stat().st_mtime_ns
    code, out = run("add.py", c)
    check("re-run add: unchanged", code == 0 and out.count("unchanged") == 3, out)
    check("re-run add: images not rewritten", (c / "decks" / "SD-1" / "s001.jpg").stat().st_mtime_ns == mt)
    code, out = run("add.py", c, c / "sources" / "Week2" / "Supply and Demand 2.pdf", "--tag", "S&D-1")
    check("a tag owned by another PDF is refused", code == 1 and "already used" in out, out)
    code, out = run("add.py", c, c / "sources" / "Week2" / "Supply and Demand 2.pdf", "--tag", "S&D-2")
    check("re-tag an unprepared deck moves it", code == 0 and (c / "decks" / "SD-2" / "deck.json").is_file()
          and not (c / "decks" / "Supply-and-Demand-2").exists(), out)
    t2 = (c / "decks" / "SD-2" / "transcript.md").read_text(encoding="utf-8")
    check("moved deck's transcript cites the new tag", "## [S&D-2 s1]" in t2 and "Supply-and-Demand-2 s" not in t2)

    code, out = run("add.py", c, c / "sources" / "practice" / "HW1.pdf", "--topic", "Supply and Demand")
    check("--topic is refused for a practice deck", code == 1 and "no topic" in out, out)
    w3 = c / "sources" / "Week3" / "Elasticity.pdf"
    make_pdf(w3, [("text", LONG)])
    code, out = run("add.py", c, w3, "--tag", "S&D-3", "--topic", "Supply and Demand", "--order", "7")
    d3 = json.loads((c / "decks" / "SD-3" / "deck.json").read_text(encoding="utf-8"))
    check("--topic and --order for a lecture deck", code == 0 and (d3["topic"], d3["order"], d3["week"]) ==
          ("Supply and Demand", 7, 3), out)
    shutil.rmtree(c / "decks" / "SD-3")
    shutil.rmtree(w3.parent)

    # ---- Prepare
    code, out = run("extract.py", "prepare", c, "1")
    work = c / ".work" / "SD-1"
    wt = (work / "transcript.md").read_text(encoding="utf-8") if (work / "transcript.md").is_file() else ""
    check("prepare writes the work transcript", code == 0 and "VISUAL-PENDING" in wt, out)
    pngs = sorted(p.name for p in (work / "png").glob("*.png"))
    check("prepare renders the visual pages only", pngs and "p001.png" not in pngs and "p002.png" in pngs, pngs)
    check("prepare leaves the hub's transcript alone", (c / "decks" / "SD-1" / "transcript.md").read_text(encoding="utf-8") == tr)
    code, out = run("check.py", c, "S&D-1", "transcripts")
    check("check transcripts fails while pages are pending", code == 1 and "VISUAL-PENDING" in out, out)
    # Simulate the transcription agents
    def transcribe(m):
        return f"## [S&D-1 s{m.group(1)}] Demand curve\n\nA downward-sloping line.\n\nType: content\n"
    wt = re.sub(r"^## \[S&D-1 s(\d+)\][^\n]*\n\s*VISUAL-PENDING.*?(?=^## \[|\Z)", transcribe, wt, flags=re.M | re.S)
    (work / "transcript.md").write_text(wt, encoding="utf-8")
    code, out = run("extract.py", "prepare", c, "S&D-1")
    check("re-running prepare keeps work in progress", "kept work transcript" in out
          and (work / "transcript.md").read_text(encoding="utf-8") == wt, out)
    code, out = run("check.py", c, "S&D-1", "transcripts")
    check("check transcripts OK", code == 0, out)
    code, out = run("check.py", c, "S&D-1", "audit")
    check("check audit fails without logs", code == 1 and "not audited" in out, out)
    code, out = run("extract.py", "finish", c, "S&D-1", "--topic", "Supply and Demand", "--read-more", "Ch. 2")
    check("finish refuses an unaudited deck", code == 1 and "not audited" in out, out)
    (work / "audit-p1-3.md").write_text("s2 · Missing · axis label → added\npages checked: 1-3\n", encoding="utf-8")
    code, out = run("check.py", c, "S&D-1", "audit")
    check("check audit OK", code == 0 and "fixes=1" in out, out)
    code, out = run("extract.py", "finish", c, "S&D-1")
    check("finish needs a topic", code == 1 and "--topic" in out, out)
    code, out = run("extract.py", "finish", c, "S&D-1", "--topic", "Supply and Demand")
    check("a new topic needs read_more", code == 1 and "--read-more" in out, out)
    code, out = run("extract.py", "finish", c, "S&D-1", "--topic", "Supply and Demand", "--read-more", "Ch. 2")
    check("finish", code == 0, out)
    d1 = json.loads((c / "decks" / "SD-1" / "deck.json").read_text(encoding="utf-8"))
    cj = json.loads((c / "course.json").read_text(encoding="utf-8"))
    check("finish sets prepared, topic, title from s1", (d1["prepared"], d1["topic"], d1["title"]) ==
          (True, "Supply and Demand", "Price elasticity"), d1)
    check("finish adds the topic to course.json, keeping its other keys",
          cj["topics"] == [{"name": "Supply and Demand", "read_more": "Ch. 2"}] and cj["code"] == "DEMO101", cj)
    check("finish publishes the work transcript", (c / "decks" / "SD-1" / "transcript.md").read_text(encoding="utf-8") == wt)
    code, out = run("check.py", c, "S&D-1", "sorted")
    check("check sorted OK", code == 0, out)

    # practice deck: no topic
    run("extract.py", "prepare", c, "practice")
    pw = c / ".work" / "HW1" / "transcript.md"
    pt = re.sub(r"VISUAL-PENDING.*?(?=^## \[|\Z)", "(answer space)\n\nType: exercise\n\n", pw.read_text(encoding="utf-8"),
                flags=re.M | re.S)
    pw.write_text(pt, encoding="utf-8")
    (c / ".work" / "HW1" / "audit-p1-2.md").write_text("pages checked: 1-2\n", encoding="utf-8")
    code, out = run("extract.py", "finish", c, "HW1", "--topic", "Supply and Demand")
    check("a practice deck takes no topic", code == 1, out)
    code, out = run("extract.py", "finish", c, "HW1")
    check("finish a practice deck", code == 0, out)
    code, out = run("check.py", c, "practice", "sorted")
    check("check sorted OK for practice", code == 0, out)

    h = hub(lib, INFO)
    check("hub: prepared deck under its topic, read more from course.json",
          h["topics"][0] == {"name": "Supply and Demand", "read_more": "Ch. 2", "decks": ["S&D-1"]}, h["topics"])
    check("hub: prepared deck's texts are not raw", not any(x.get("raw") for x in h["texts"]["S&D-1"])
          and h["texts"]["S&D-1"][1]["md"] == "A downward-sloping line.", h["texts"]["S&D-1"])
    check("hub: prepared flag and title", h["decks"]["S&D-1"]["prepared"] is True
          and h["decks"]["S&D-1"]["title"] == "Price elasticity")
    check("hub: S&D-2 still unsorted", h["topics"][-1] == {"name": "Not sorted yet", "read_more": "", "decks": ["S&D-2"]},
          h["topics"])

    # ---- a prepared deck is left alone; a changed PDF sends it back
    code, out = run("add.py", c)
    check("re-run add keeps the prepared deck", code == 0 and "kept (prepared)" in out
          and (c / "decks" / "SD-1" / "transcript.md").read_text(encoding="utf-8") == wt, out)
    (c / "decks" / "SD-1" / "s003.jpg").unlink()
    code, out = run("add.py", c, w1)
    check("missing images of a prepared deck are restored", "restored" in out and (c / "decks" / "SD-1" / "s003.jpg").is_file()
          and (c / "decks" / "SD-1" / "transcript.md").read_text(encoding="utf-8") == wt, out)
    make_pdf(w1, [("text", LONG + " Revised."), ("drawing", "Demand curve"), ("short", "Questions?"), ("short", "Extra")])
    code, out = run("add.py", c)
    d1 = json.loads((c / "decks" / "SD-1" / "deck.json").read_text(encoding="utf-8"))
    check("changed PDF: rebuilt, prepared false, topic and title kept",
          (d1["prepared"], d1["pages"], d1["topic"], d1["title"]) == (False, 4, "Supply and Demand", "Price elasticity"), d1)
    check("changed PDF: old transcript kept in .work", any(work.glob("transcript.before-*.md")))
    code, out = run("extract.py", "prepare", c, "S&D-1")
    check("changed PDF: prepare starts a fresh work transcript", "work transcript written" in out
          and "s4]" in (work / "transcript.md").read_text(encoding="utf-8"), out)

    # ---- textbooks
    make_pdf(c / "sources" / "textbooks" / "Demo-Econ.pdf", [("text", "Chapter 1\nMarkets"), ("text", LONG)],
             outline=[[1, "1 Markets", 1], [2, "1.1 Price elasticity", 2]])
    make_pdf(c / "sources" / "textbooks" / "Notes.pdf", [("text", "Chapter 1: Markets\n" + LONG), ("text", "Chapter 2: Prices")])
    code, out = run("extract.py", "textbooks", c)
    txt = (c / "textbooks" / "Demo-Econ.txt").read_text(encoding="utf-8")
    toc = (c / "textbooks" / "Demo-Econ.toc.md").read_text(encoding="utf-8")
    check("textbook text with page markers", code == 0 and "===== Demo-Econ PAGE 2 =====" in txt, out)
    check("textbook contents from the outline", "-   § 1.1 Price elasticity — PDF page 2" in toc, toc)
    ntoc = (c / "textbooks" / "Notes.toc.md").read_text(encoding="utf-8")
    check("textbook contents scanned when there is no outline", "APPROXIMATE" in ntoc
          and "§ Chapter 2: Prices — PDF page 2" in ntoc, ntoc)
    code, out = run("extract.py", "textbooks", c)
    check("textbooks re-run keeps them", out.count("kept") == 2, out)
    h = hub(lib, 'print(json.dumps(L.course_map(L.course_dir("Demo-Course"))))')
    check("hub's course map lists the textbooks", "textbooks/Demo-Econ.toc.md" in h, h)


if __name__ == "__main__":
    main()
