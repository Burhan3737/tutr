"""Add stage: make new PDFs show up in the Study Hub in seconds (no Claude, no visual reading).

    python add.py <course> --list                      what's new in sources/ (default tags, week, role); writes nothing
    python add.py <course>                             add every PDF in sources/WeekN/ and sources/practice/
    python add.py <course> <pdf> [--tag T] [--title T] [--week N] [--order N] [--topic NAME]
                      [--role lecture|practice] [--force]

For each PDF this writes decks/<safe tag>/:
  sNNN.jpg        every page as an image
  transcript.md   a rough transcript from the PDF's text layer, one "## [<tag> sN] <first line>" section per page
  deck.json       prepared: false, pages, week, order, role, title, source, sha1; topic "Unsorted" for a lecture
                  deck (the hub shows "Not sorted yet"), "" for a practice deck

Defaults: tag = file stem with "_" and spaces turned into "-"; title = file stem with "_"/"-" as spaces;
role = practice for sources/practice/, else lecture; week = N of sources/WeekN/ (a practice deck: the latest lecture
week in the course, 0 if none); order = next free in that week. On a re-run the deck keeps its tag, title, week,
order and topic unless given again. --topic files a lecture deck under a topic straight away (the migration
uses it; the skill leaves it to Prepare).

Idempotent: a deck whose PDF hash is unchanged is left alone (only fields given on the command line are updated).
A prepared deck whose PDF changed goes back to a rough transcript with prepared: false (the old transcript is kept in
.work/<folder>/) so it can be prepared again. --force rebuilds even when nothing changed.
Exit code 1 if any PDF could not be added.
"""
import argparse, re, shutil, sys
from pathlib import Path

from slidelib import (DECK_FILE, LECTURE, PRACTICE, TRANSCRIPT, UNSORTED, WEEK_RE, as_int, decks, ensure_course,
                      fitz, read_json, rel, render_jpgs, safe_tag, sha1, utf8_stdout, work_dir, write_json, write_text)


class AddError(Exception):
    pass


def default_tag(pdf):
    tag = re.sub(r"[\s_]+", "-", Path(pdf).stem)
    tag = re.sub(r"-{2,}", "-", re.sub(r"[\[\]]", "", tag)).strip("-")
    return tag


def default_title(pdf):
    return Path(pdf).stem.replace("_", " ").replace("-", " ")


def check_tag(tag):
    if not tag or re.search(r"[\[\]\n\r]", tag) or tag != tag.strip():
        raise AddError(f"tag {tag!r} is not usable: no brackets, line breaks or surrounding spaces")
    if not safe_tag(tag):
        raise AddError(f"tag {tag!r} has no letters or digits (its folder name would be empty)")


def path_role(course, pdf):
    parts = [p.lower() for p in Path(rel(course, pdf)).parts]
    return PRACTICE if parts[:2] == ["sources", PRACTICE] else LECTURE


def path_week(pdf):
    m = WEEK_RE.match(Path(pdf).parent.name)
    return int(m.group(1)) if m else None


def practice_week(course):
    """The latest lecture week in the course (the old hub's rule for practice decks): from lecture decks and
    sources/WeekN folders holding PDFs; 0 if none."""
    weeks = [as_int(j.get("week")) for _, j in decks(course) if j.get("role") != PRACTICE]
    for d in (course / "sources").glob("*"):
        m = WEEK_RE.match(d.name)
        if m and d.is_dir() and any(d.glob("*.pdf")):
            weeks.append(int(m.group(1)))
    return max(weeks, default=0)


def next_order(course, week, source):
    orders = [as_int(j.get("order")) for _, j in decks(course)
              if as_int(j.get("week")) == week and j.get("source") != source]
    return max(orders) + 1 if orders else 0


def rough_transcript(doc, tag, title_stem, source):
    out = [f"# Transcript: {title_stem} ({tag})", "",
           f"Source: `{source}` · {doc.page_count} pages · rough: the PDF's text layer, not yet prepared", ""]
    for i, page in enumerate(doc, 1):
        text = page.get_text().strip()
        # a text line that looks like a section heading would split the page in two: indent it
        text = re.sub(r"^(## \[)", r" \1", text, flags=re.M)
        first = (text.splitlines() or [""])[0].strip()[:80]
        out += [f"## [{tag} s{i}] {first}".rstrip(), "", text, ""] if text else [f"## [{tag} s{i}]", ""]
    return "\n".join(out)


def images_complete(folder, pages):
    return pages > 0 and all((folder / f"s{i:03d}.jpg").exists() for i in range(1, pages + 1))


def remove_deck(folder):
    for f in [folder / DECK_FILE, folder / TRANSCRIPT, *folder.glob("s*.jpg")]:
        if f.exists():
            f.unlink()
    try:
        folder.rmdir()
    except OSError:
        pass


def add(course, pdf, tag=None, title=None, week=None, order=None, role=None, topic=None, force=False):
    """Add (or refresh) one PDF as a deck. Returns (status, deck.json dict)."""
    course, pdf = Path(course).resolve(), Path(pdf).resolve()
    if not pdf.is_file():
        raise AddError(f"no such PDF: {pdf}")
    source = rel(course, pdf)
    by_source = next(((f, j) for f, j in decks(course) if j.get("source") == source), None)
    old_folder, old = by_source if by_source else (None, {})
    tag = tag or old.get("tag") or default_tag(pdf)
    check_tag(tag)
    folder = course / "decks" / safe_tag(tag)
    owner = read_json(folder / DECK_FILE)
    if owner is not None and owner.get("source") != source:
        raise AddError(f"tag {tag!r} (folder decks/{folder.name}) is already used by {owner.get('source')!r}: "
                       "choose another tag")
    moving = old_folder is not None and old_folder != folder
    if moving and old.get("prepared") is True and not force:
        raise AddError(f"{source} is already prepared as {old.get('tag')!r}; renaming a prepared deck needs --force "
                       "(its transcript cites the old tag)")

    role = role or old.get("role") or path_role(course, pdf)
    if role not in (LECTURE, PRACTICE):
        raise AddError(f"role must be {LECTURE} or {PRACTICE}, not {role!r}")
    if week is None:
        week = old.get("week") if "week" in old else path_week(pdf)
    if week is None:
        if role != PRACTICE:
            raise AddError(f"{source} is not in a sources/WeekN/ folder: give --week")
        week = practice_week(course)
    week = as_int(week)
    if order is None:
        order = old["order"] if "order" in old and as_int(old.get("week")) == week else next_order(course, week, source)
    if role == PRACTICE:
        if (topic or "").strip():
            raise AddError(f"{source}: a practice deck has no topic (the hub lists it under Practice)")
        topic = ""
    else:
        topic = (topic or "").strip() or (str(old.get("topic") or "").strip()
                                          if old.get("role", LECTURE) == LECTURE else "")
        topic = topic or UNSORTED
    meta = {"tag": tag, "title": title or old.get("title") or default_title(pdf), "role": role, "week": week,
            "topic": topic, "order": as_int(order)}

    h = sha1(pdf)
    pages = as_int(old.get("pages"))
    same = bool(old) and not moving and old.get("tag") == tag and not force
    if same and old.get("prepared") is True and old.get("sha1") in (None, h):
        # Hours of transcription and audit: never touched while the PDF is unchanged (a prepared deck from before
        # hashes were recorded is taken as matching). Missing images are re-rendered.
        status = "kept (prepared)"
        if not images_complete(folder, pages):
            with fitz.open(pdf) as doc:
                render_jpgs(doc, folder, only_missing=True)
            status += ", missing images restored"
        new = dict(old, **meta, sha1=h)
        if new != old:
            write_json(folder / DECK_FILE, new)
        return status, new
    if (same and old.get("sha1") == h and (folder / TRANSCRIPT).is_file() and images_complete(folder, pages)):
        new = dict(old, **meta)
        if new != old:
            write_json(folder / DECK_FILE, new)
        return "unchanged", new

    status = "added"
    if old.get("prepared") is True:
        # The PDF changed under a prepared deck: keep the old transcript where Prepare can see it.
        tr = old_folder / TRANSCRIPT
        if tr.is_file():
            keep = work_dir(course, folder.name) / f"transcript.before-{(old.get('sha1') or 'unknown')[:8]}.md"
            keep.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(tr, keep)
        why = "--force" if old.get("sha1") == h else "the PDF changed"
        status = f"rebuilt ({why}): prepared: false, prepare it again (old transcript kept in .work/{folder.name}/)"
    elif old:
        status = "rebuilt"

    with fitz.open(pdf) as doc:
        if doc.page_count == 0:
            raise AddError(f"{source} has no pages")
        render_jpgs(doc, folder)
        write_text(folder / TRANSCRIPT, rough_transcript(doc, tag, pdf.stem, source))
        new = {**meta, "pages": doc.page_count, "prepared": False, "source": source, "sha1": h}
    write_json(folder / DECK_FILE, new)        # last: the hub lists the deck once it is complete
    if moving:
        remove_deck(old_folder)
        status += f" (moved from decks/{old_folder.name})"
    return status, new


def source_pdfs(course):
    """Every PDF in sources/WeekN/ (by week, then name) followed by sources/practice/."""
    def natural(p):
        return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.name)]
    src = course / "sources"
    weeks = sorted((d for d in src.glob("*") if d.is_dir() and WEEK_RE.match(d.name)),
                   key=lambda d: int(WEEK_RE.match(d.name).group(1)))
    out = [p for d in weeks for p in sorted(d.glob("*.pdf"), key=natural)]
    return out + sorted((src / PRACTICE).glob("*.pdf"), key=natural)


def list_new(course):
    known = {j.get("source"): (f, j) for f, j in decks(course)}
    pdfs = source_pdfs(course)
    if not pdfs:
        print(f"No PDFs in {course / 'sources'}/WeekN/ or sources/practice/")
    for pdf in pdfs:
        source = rel(course, pdf)
        hit = known.get(source)
        if hit:
            j = hit[1]
            state = "prepared" if j.get("prepared") is True else "added"
            if j.get("sha1") not in (None, sha1(pdf)):
                state += ", PDF changed"
            print(f"{state:22s} {source:50s} tag={j.get('tag')}")
        else:
            role = path_role(course, pdf)
            week = path_week(pdf)
            print(f"{'NEW':22s} {source:50s} tag={default_tag(pdf)} (default) role={role} "
                  f"week={week if week is not None else 'latest lecture week'}")


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("course", help="the course folder (holds course.json, sources/, decks/)")
    ap.add_argument("pdfs", nargs="*", help="PDFs to add (default: every PDF in sources/WeekN/ and sources/practice/)")
    ap.add_argument("--list", action="store_true", help="show what is new; write nothing")
    ap.add_argument("--tag")
    ap.add_argument("--title")
    ap.add_argument("--week", type=int)
    ap.add_argument("--order", type=int)
    ap.add_argument("--topic", help="lecture decks only (default: kept, or Unsorted)")
    ap.add_argument("--role", choices=[LECTURE, PRACTICE])
    ap.add_argument("--force", action="store_true", help="rebuild even when nothing changed")
    a = ap.parse_args()
    course = Path(a.course).resolve()
    if not course.is_dir():
        sys.exit(f"No course folder at {course}")
    if a.list:
        list_new(course)
        return
    one = {k: v for k, v in dict(tag=a.tag, title=a.title, week=a.week, order=a.order, topic=a.topic).items() if v is not None}
    pdfs = [Path(p) for p in a.pdfs] or source_pdfs(course)
    if one and len(pdfs) != 1:
        sys.exit("--tag, --title, --week, --order and --topic apply to one PDF: name exactly one")
    if not pdfs:
        sys.exit(f"No PDFs in {course / 'sources'}/WeekN/ or sources/practice/")
    ensure_course(course)
    failed = 0
    for pdf in pdfs:
        try:
            status, d = add(course, pdf, role=a.role, force=a.force, **one)
            print(f"{d['tag']:14s} {d['role']:8s} W{d['week']:<3d} order={d['order']:<3d} pages={d['pages']:<4d} "
                  f"{rel(course, pdf)}  {status}")
        except AddError as e:
            failed += 1
            print(f"FAILED {pdf}: {e}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
