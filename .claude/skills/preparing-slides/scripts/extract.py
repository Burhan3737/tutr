"""Prepare a week's source decks for transcription.

    python extract.py <course-folder> <week-number | practice> [--force]

For every PDF in <course>/course/Week<N>/ (or course/practice/: homework and practice exams) this writes,
under <course>/.cache/Week<N>/ (or .cache/practice/):
  <stem>.transcript.md   one "## [<tag> sN] ..." section per page. Text-rich pages are filled
                          from the text layer; every other page is marked VISUAL-PENDING and
                          must be rewritten by an agent that looks at the PNG.
  png/<stem>/pNNN.png    renders of the VISUAL-PENDING pages only (for transcription)
  manifest.json          decks, tags, page counts, which pages need visual reading, slide image names
and under <course>/study/slides/:
  <tag-safe>-sNNN.jpg    every page, shown by the Study Hub's slide viewer (tag with symbols removed,
                          e.g. S&D-2 -> SD-2-s014.jpg)

A page needs visual reading when it has under MIN_TEXT characters of text, any embedded
image (equations, handwriting, charts) or heavy vector drawing. Existing transcripts are
never overwritten unless --force is given or the PDF's content (SHA-1) changed since the last run.
Deck tags come from the deck table in <course>/CLAUDE.md (| Week | Deck | Tag | Topic |); decks
without a row get their file stem as tag and are listed as missing so the table can be updated.
"""
import argparse, hashlib, json, os, re, sys
from pathlib import Path

try:
    import fitz
except ImportError:
    sys.exit("PyMuPDF is required: pip install pymupdf")

MIN_TEXT = 200
HEAVY_DRAWINGS = 20
DPI = 80          # transcription renders
SLIDE_DPI = 90    # slide images for the viewer


def safe_tag(tag):
    return re.sub(r"[^A-Za-z0-9-]", "", tag)


def deck_tags(course):
    tags = {}
    cm = course / "CLAUDE.md"
    if not cm.exists():
        return tags
    for line in cm.read_text(encoding="utf-8").splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        # the tag is the first cell with a `code` span; the deck is the cell before it
        k = next((i for i, c in enumerate(cells) if "`" in c), None)
        if len(cells) < 3 or not k:
            continue
        deck, found = cells[k - 1], re.findall(r"`([^`]+)`", cells[k])
        rng = re.match(r"^(.*?)(\d+)\s*(?:…|\.\.\.)\s*(\d+)$", deck)
        if rng and len(found) == 2 and re.match(r"^(.*?)(\d+)$", found[0]):
            prefix = re.match(r"^(.*?)(\d+)$", found[0]).group(1)
            for i in range(int(rng.group(2)), int(rng.group(3)) + 1):
                tags[f"{rng.group(1)}{i}"] = f"{prefix}{i}"
        elif found:
            tags[deck] = found[0]
    return tags


MATH_FONT = re.compile(r"math|symbol|cmmi|cmsy|cmex|stix|mt extra", re.I)


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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("course")
    ap.add_argument("week", help="week number, or 'practice' for course/practice/")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    course = Path(a.course).resolve()
    folder = f"Week{a.week}" if a.week.isdigit() else a.week
    src = course / "course" / folder
    out = course / ".cache" / folder
    tags = deck_tags(course)
    # Source order = the order decks are listed in the CLAUDE.md "Deck tags" table (lecture order);
    # decks not in the table follow, alphabetically.
    listed = list(tags)
    pdfs = sorted(src.glob("*.pdf"), key=lambda p: (listed.index(p.stem) if p.stem in tags else len(listed), p.stem))
    if not pdfs:
        sys.exit(f"No PDFs in {src}")
    out.mkdir(parents=True, exist_ok=True)
    manifest = {"course": course.name, "week": a.week, "decks": [], "missing_tags": []}
    try:
        prev = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        prev = {}

    for pdf in pdfs:
        tag = tags.get(pdf.stem)
        if tag is None:
            tag = pdf.stem
            manifest["missing_tags"].append(pdf.stem)
        tr = out / f"{pdf.stem}.transcript.md"
        doc = fitz.open(pdf)
        visual, sections = [], []
        for i, page in enumerate(doc, 1):
            text = page.get_text()
            first = next((l.strip() for l in text.splitlines() if l.strip()), "")[:80]
            if needs_visual(page, text):
                visual.append(i)
                body = "VISUAL-PENDING\n\nText layer (incomplete — read the PNG):\n\n```text\n" + text.strip() + "\n```"
            else:
                body = text.strip() + "\n\nType: content"
            sections.append(f"## [{tag} s{i}] {first}\n\n{body}\n")
        # An existing transcript is hours of transcription and audit: keep it unless --force, or the PDF's
        # content changed since the last run (by hash; file times change on copy/checkout and mean nothing).
        sha = hashlib.sha1(pdf.read_bytes()).hexdigest()
        old = next((x for x in prev.get("decks", []) if x.get("stem") == pdf.stem), {})
        # A deck whose tag changed (e.g. a row was just added to CLAUDE.md) is rebuilt too, but only while no
        # page of it has been transcribed yet — so adding a row never needs --force, which hits every deck.
        untouched = tr.exists() and tr.read_text(encoding="utf-8").count("VISUAL-PENDING") >= len(visual)
        fresh = (a.force or not tr.exists() or (old.get("sha1") not in (None, sha))
                 or (untouched and old.get("tag") not in (None, tag)))
        if fresh:
            tr.write_text(f"# Transcript: {pdf.stem} ({tag})\n\nSource: `{pdf.relative_to(course).as_posix()}` · {doc.page_count} pages\n\n"
                          + "\n".join(sections), encoding="utf-8")
            pngdir = out / "png" / pdf.stem
            pngdir.mkdir(parents=True, exist_ok=True)
            for i in visual:
                doc[i - 1].get_pixmap(dpi=DPI).save(pngdir / f"p{i:03d}.png")
        sdir = course / "study" / "slides"
        sdir.mkdir(parents=True, exist_ok=True)
        names = []
        for i, page in enumerate(doc, 1):
            img = sdir / f"{safe_tag(tag)}-s{i:03d}.jpg"
            names.append(f"study/slides/{img.name}")
            if a.force or fresh or not img.exists():
                page.get_pixmap(dpi=SLIDE_DPI).save(img, jpg_quality=80)
        pending = len(re.findall(r"^## \[[^\]]+\][^\n]*\n\s*VISUAL-PENDING", tr.read_text(encoding="utf-8"), re.M))
        manifest["decks"].append({"stem": pdf.stem, "tag": tag, "pdf": pdf.relative_to(course).as_posix(),
                                  "pages": doc.page_count, "visual_pages": visual, "pending": pending,
                                  "transcript": tr.relative_to(course).as_posix(), "rewritten": fresh, "sha1": sha,
                                  "slide_images": names})
        print(f"{pdf.stem:40s} tag={tag:12s} pages={doc.page_count:3d} visual={len(visual):3d} pending={pending:3d}"
              + ("" if fresh else "  (kept existing transcript)"))

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    if manifest["missing_tags"]:
        print("\nNo deck tag in CLAUDE.md for: " + ", ".join(manifest["missing_tags"])
              + "\nAdd rows to the course CLAUDE.md deck table (Week | Deck | Tag | Topic), then re-run (without --force:\n"
              "it would overwrite every finished transcript in this week).")


if __name__ == "__main__":
    main()
