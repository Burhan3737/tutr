"""Prepare stage (full transcription) and textbooks. Run add.py first: Prepare works on decks that exist.

    python extract.py prepare <course> <scope> [--force]
    python extract.py finish <course> <tag> [--topic NAME] [--read-more TEXT] [--title TEXT] [--force]
    python extract.py textbooks <course> [--force]

prepare   <scope> = a deck tag or folder, a week ("3" / "Week3": its lecture decks), "practice" or "all".
          For each deck not yet prepared, writes under <course>/.work/<folder>/:
            transcript.md   the work transcript: one "## [<tag> sN] ..." section per page. Text-rich pages are filled
                            from the text layer; every other page is VISUAL-PENDING and must be rewritten by an agent
                            that looks at the PNG.
            png/pNNN.png    renders of the VISUAL-PENDING pages (for transcription)
            work.json       tag, pages, visual pages, the PDF's sha1
          A work transcript in progress is kept unless --force or the PDF changed (sha1). Prepared decks are skipped
          unless --force. The deck the hub shows (decks/<folder>/) is not touched until finish.
          A page needs visual reading when it has under MIN_TEXT characters of text, any embedded image (equations,
          handwriting, charts), heavy vector drawing, or super/subscripts and math fonts.

finish    After transcription and audit pass (check.py ... audit): copies the work transcript to
          decks/<folder>/transcript.md, sets prepared: true, the title (from the transcript's s1 heading unless
          --title) and, for a lecture deck, the topic. A topic course.json doesn't list yet is added to its
          "topics" with --read-more (required for a new topic). On a prepared deck with no work transcript, finish
          only re-files it (topic / title). --force skips the transcript and audit checks.

textbooks For every sources/textbooks/*.pdf writes <course>/textbooks/<book>.txt (full text, page markers
          "===== <book> PAGE n =====") and <book>.toc.md (the PDF's outline, else an APPROXIMATE contents scanned
          from chapter headings). Existing files are kept unless --force or the PDF changed since the last run.
"""
import argparse, re, shutil, sys
from collections import Counter
from pathlib import Path

from slidelib import (COURSE_FILE, DECK_FILE, PRACTICE, TRANSCRIPT, UNSORTED, ensure_course, fitz, read_json,
                      sections, select, sha1, utf8_stdout, work_dir, write_json, write_text)
from check import audit_problems, transcript_problems

MIN_TEXT = 200
HEAVY_DRAWINGS = 20
DPI = 80          # transcription renders
MATH_FONT = re.compile(r"math|symbol|cmmi|cmsy|cmex|stix|mt extra", re.I)


# ---------------------------------------------------------------- prepare

def has_math_layout(page):
    """Superscripts, subscripts and math fonts flatten in the text layer: x^n reads as 'xn'."""
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            spans = [s for s in line["spans"] if s["text"].strip()]
            if not spans:
                continue
            biggest = max(s["size"] for s in spans)
            for s in spans:
                if s["flags"] & 1 or MATH_FONT.search(s["font"]) or s["size"] < 0.8 * biggest:
                    return True
    return False


def needs_visual(page, text):
    return (len(text.strip()) < MIN_TEXT or bool(page.get_images())
            or len(page.get_drawings()) > HEAVY_DRAWINGS or has_math_layout(page))


def prepare(course, folder, j, force=False):
    """Write the deck's work transcript and PNGs. Returns a one-line status."""
    tag, src = j.get("tag"), course / str(j.get("source") or "")
    if j.get("prepared") is True and not force:
        return "already prepared (skipped; --force to redo)"
    if not src.is_file():
        return f"SOURCE MISSING: {j.get('source')!r} (fix deck.json source)"
    h = sha1(src)
    if j.get("sha1") not in (None, h):
        return f"PDF CHANGED since add: run add.py {course.name} {j.get('source')} first"
    work = work_dir(course, folder.name)
    tr = work / TRANSCRIPT
    prev = read_json(work / "work.json") or {}
    with fitz.open(src) as doc:
        visual, out = [], [f"# Transcript: {src.stem} ({tag})", "", f"Source: `{j.get('source')}` · {doc.page_count} pages", ""]
        for i, page in enumerate(doc, 1):
            text = page.get_text()
            first = next((l.strip() for l in text.splitlines() if l.strip()), "")[:80]
            if needs_visual(page, text):
                visual.append(i)
                body = "VISUAL-PENDING\n\nText layer (incomplete — read the PNG):\n\n```text\n" + text.strip() + "\n```"
            else:
                body = re.sub(r"^(## \[)", r" \1", text.strip(), flags=re.M) + "\n\nType: content"
            out.append(f"## [{tag} s{i}] {first}\n\n{body}\n")
        # A work transcript in progress is hours of transcription: keep it unless --force, the PDF changed, or the
        # tag changed while no page of it was transcribed yet.
        untouched = tr.is_file() and tr.read_text(encoding="utf-8").count("VISUAL-PENDING") >= len(visual)
        fresh = (force or not tr.is_file() or prev.get("sha1") != h
                 or (untouched and prev.get("tag") != tag))
        if fresh:
            write_text(tr, "\n".join(out))
            pngdir = work / "png"
            if pngdir.exists():
                shutil.rmtree(pngdir)
            pngdir.mkdir(parents=True)
            for i in visual:
                doc[i - 1].get_pixmap(dpi=DPI).save(pngdir / f"p{i:03d}.png")
            write_json(work / "work.json", {"tag": tag, "pages": doc.page_count, "visual_pages": visual, "sha1": h})
        pages = doc.page_count
    pending = [n for n, _, b, _ in sections(tr.read_text(encoding="utf-8")) if "VISUAL-PENDING" in b]
    return (f"pages={pages:<4d} visual={len(visual):<4d} pending={len(pending):<4d} "
            + ("work transcript written" if fresh else "kept work transcript in progress")
            + (f"  pending pages: {compact(pending)}" if pending else ""))


def compact(nums):
    """[1,2,3,7] -> '1-3, 7'."""
    out, nums = [], sorted(nums)
    i = 0
    while i < len(nums):
        k = i
        while k + 1 < len(nums) and nums[k + 1] == nums[k] + 1:
            k += 1
        out.append(f"{nums[i]}-{nums[k]}" if k > i else f"{nums[i]}")
        i = k + 1
    return ", ".join(out)


# ---------------------------------------------------------------- finish

def finish(course, folder, j, topic=None, read_more=None, title=None, force=False):
    """Publish a prepared deck to the hub. Returns (problems, status)."""
    tag = j.get("tag")
    work_tr = work_dir(course, folder.name) / TRANSCRIPT
    refile = not work_tr.is_file() and j.get("prepared") is True
    if not work_tr.is_file() and not refile:
        return [f"{tag}: no work transcript at .work/{folder.name}/{TRANSCRIPT} (run extract.py prepare first)"], ""
    if not refile and not force:
        problems, _ = transcript_problems(course, folder, j, work_tr)
        problems += audit_problems(course, folder, j)[0]
        if problems:
            return problems + [f"{tag}: not finished: fix the above (check.py {course.name} {tag} audit)"], ""

    new = dict(j)
    if j.get("role") == PRACTICE:
        if topic:
            return [f"{tag}: a practice deck has no topic (the hub lists it under Practice)"], ""
        new["topic"] = ""
    else:
        topic = (topic or "").strip() or str(j.get("topic") or "").strip()
        if not topic or topic.lower() == UNSORTED.lower():
            return [f"{tag}: give --topic (the student confirms it first)"], ""
        cj = read_json(course / COURSE_FILE)
        if cj is None:
            ensure_course(course)
            cj = read_json(course / COURSE_FILE)
        topics = [t for t in cj.get("topics") or [] if isinstance(t, dict)]
        hit = next((t for t in topics if str(t.get("name") or "").strip() == topic), None)
        if hit is None:
            if not (read_more or "").strip():
                return [f"{tag}: {topic!r} is a new topic: give --read-more (textbook sections or official docs)"], ""
            topics.append({"name": topic, "read_more": read_more.strip()})
            write_json(course / COURSE_FILE, dict(cj, topics=topics))
        elif (read_more or "").strip() and not str(hit.get("read_more") or "").strip():
            hit["read_more"] = read_more.strip()
            write_json(course / COURSE_FILE, dict(cj, topics=topics))
        new["topic"] = topic
    if not refile:
        text = work_tr.read_text(encoding="utf-8")
        s1 = next((t for n, t, _, _ in sections(text) if n == 1), "")
        new["title"] = title or s1 or j.get("title") or tag
        write_text(folder / TRANSCRIPT, text)
        new["prepared"] = True
    elif title:
        new["title"] = title
    write_json(folder / DECK_FILE, new)
    return [], ("re-filed" if refile else "prepared") + f": title={new['title']!r} topic={new['topic'] or '(practice)'}"


# ---------------------------------------------------------------- textbooks

HEADING = re.compile(r"^(chapter|part|unit|lesson|appendix)\s+([0-9]+|[IVXLC]+|[A-Z])\b[.:]?\s*(.*)$", re.I)


def page_offset(doc):
    """Most common (PDF page - printed page) over pages whose label is a number, or None."""
    diffs = Counter()
    for i in range(doc.page_count):
        try:
            label = doc[i].get_label()
        except Exception:
            return None
        if label and label.isdigit():
            diffs[i + 1 - int(label)] += 1
    return diffs.most_common(1)[0][0] if diffs else None


def scanned_toc(doc):
    """Chapter-like headings among the first lines of each page: [(level, title, page)]."""
    seen, out = set(), []
    for i, page in enumerate(doc, 1):
        lines = [l.strip() for l in page.get_text().splitlines() if l.strip()][:4]
        for k, line in enumerate(lines):
            m = HEADING.match(line)
            if not m or len(line) > 90:
                continue
            key = (m.group(1).lower(), m.group(2).upper())
            if key in seen:
                break
            seen.add(key)
            rest = m.group(3).strip() or (lines[k + 1] if k + 1 < len(lines) else "")
            out.append((1, f"{m.group(1).title()} {m.group(2)}: {rest}".rstrip(": "), i))
            break
    return out


def textbook(course, pdf, force=False, record=None):
    name = pdf.stem
    out = course / "textbooks"
    txt, toc = out / f"{name}.txt", out / f"{name}.toc.md"
    h = sha1(pdf)
    known = (record or {}).get(name)
    if txt.is_file() and toc.is_file() and not force and known in (None, h):
        return h, "kept"
    with fitz.open(pdf) as doc:
        write_text(txt, "".join(f"===== {name} PAGE {i} =====\n{page.get_text().strip()}\n\n"
                                for i, page in enumerate(doc, 1)))
        outline = doc.get_toc(simple=True)
        approximate = not outline
        title = str((doc.metadata or {}).get("title") or "").strip() or name.replace("_", " ").replace("-", " ")
        lines = [f"# {title} — contents", ""]
        if approximate:
            lines += ["Note: no embedded TOC; this table of contents is APPROXIMATE (scanned for chapter/section "
                      "headings).", ""]
            outline = scanned_toc(doc)
        lines += [f'Search the text in {name}.txt; page markers are "===== {name} PAGE n =====".', ""]
        off = page_offset(doc)
        if off is not None:
            lines += [f"Printed-page offset hint: printed page = PDF page − {off}", ""]
        lines += [f"- {'  ' * (lvl - 1)}§ {t.strip()} — PDF page {p}" for lvl, t, p in outline if p > 0]
        write_text(toc, "\n".join(lines) + "\n")
        pages = doc.page_count
    entries = sum(1 for l in lines if l.startswith("- "))
    return h, f"written: {pages} pages, {entries} contents entries" + (" (APPROXIMATE contents)" if approximate else "")


# ---------------------------------------------------------------- CLI

def main():
    utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare", help="write work transcripts and PNGs for decks to transcribe")
    p.add_argument("course")
    p.add_argument("scope", help="deck tag or folder, week number, 'practice' or 'all'")
    p.add_argument("--force", action="store_true")
    f = sub.add_parser("finish", help="publish a transcribed, audited deck to the hub and file it under a topic")
    f.add_argument("course")
    f.add_argument("tag")
    f.add_argument("--topic")
    f.add_argument("--read-more", dest="read_more")
    f.add_argument("--title")
    f.add_argument("--force", action="store_true", help="skip the transcript and audit checks")
    t = sub.add_parser("textbooks", help="extract textbook text and contents")
    t.add_argument("course")
    t.add_argument("--force", action="store_true")
    a = ap.parse_args()
    course = Path(a.course).resolve()
    if not course.is_dir():
        sys.exit(f"No course folder at {course}")

    if a.cmd == "prepare":
        chosen = select(course, a.scope)
        if not chosen:
            sys.exit(f"No deck matches {a.scope!r}: add the PDFs first (add.py {course.name})")
        for folder, j in chosen:
            print(f"{str(j.get('tag')):14s} {prepare(course, folder, j, a.force)}")
            print(f"{'':14s} work: .work/{folder.name}/{TRANSCRIPT} · PNGs: .work/{folder.name}/png/ · "
                  f"images: decks/{folder.name}/sNNN.jpg")
    elif a.cmd == "finish":
        hit = [x for x in select(course, a.tag) if x[1].get("tag") == a.tag or x[0].name == a.tag]
        if len(hit) != 1:
            sys.exit(f"No single deck with tag {a.tag!r}")
        problems, status = finish(course, *hit[0], topic=a.topic, read_more=a.read_more, title=a.title, force=a.force)
        print(f"{a.tag}: {status}" if not problems else "FAIL\n- " + "\n- ".join(problems))
        sys.exit(1 if problems else 0)
    else:
        src = sorted((course / "sources" / "textbooks").glob("*.pdf"))
        if not src:
            sys.exit(f"No PDFs in {course / 'sources' / 'textbooks'}")
        rec_file = course / ".work" / "textbooks.json"     # PDF hashes from the last run
        record = read_json(rec_file) or {}
        for pdf in src:
            h, status = textbook(course, pdf, a.force, record)
            record[pdf.stem] = h
            print(f"{pdf.stem:30s} {status}")
        write_json(rec_file, record)


if __name__ == "__main__":
    main()
