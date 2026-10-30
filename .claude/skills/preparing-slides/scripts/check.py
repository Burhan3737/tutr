"""Mechanical checks for prepared decks. Exit code 1 if anything fails.

    python check.py <course> <scope> deck          deck.json valid, images and a transcript section for every page
    python check.py <course> <scope> transcripts   every page transcribed: no VISUAL-PENDING, a Type line each
    python check.py <course> <scope> audit         transcripts OK, and every page inside an audit log's range
    python check.py <course> <scope> sorted        deck OK, prepared, filed under a topic course.json lists with
                                                   a Read more (lecture decks); practice decks have no topic

<scope>: a deck tag or folder name, a week ("3" or "Week3": its lecture decks), "practice" (every practice deck),
or "all".

transcripts / audit read the work transcript (.work/<folder>/transcript.md) while a deck is being prepared, else
the deck's own transcript.md. Audit logs: .work/<folder>/audit-p<A>-<B>.md, each ending "pages checked: A-B".
"""
import argparse, re, sys
from pathlib import Path

from slidelib import (COURSE_FILE, DECK_FILE, LECTURE, PRACTICE, TRANSCRIPT, UNSORTED, decks, read_json, safe_tag,
                      sections, select, utf8_stdout, work_dir)


def transcript_path(course, folder):
    w = work_dir(course, folder.name) / TRANSCRIPT
    return w if w.is_file() else folder / TRANSCRIPT


def transcript_problems(course, folder, j, path=None):
    """Sections 1..pages with the deck's tag, none VISUAL-PENDING, each with a Type line.
    Returns (problems, (sections, pending, admin))."""
    path = path or transcript_path(course, folder)
    name = j.get("tag") or folder.name
    if not path.is_file():
        return [f"{name}: no transcript at {path.relative_to(course).as_posix()}"], (0, 0, 0)
    text = path.read_text(encoding="utf-8")
    secs = sections(text)
    problems = []
    nums = [n for n, _, _, _ in secs]
    pages = j.get("pages") if isinstance(j.get("pages"), int) else 0
    if nums != list(range(1, pages + 1)):
        problems.append(f"{name}: {len(nums)} sections for {pages} pages (or out of order)")
    wrong_tag = sorted({m.group("tag") for m in re.finditer(r"^## \[(?P<tag>[^\]]+?) s\d+\]", text, re.M)}
                       - {j.get("tag")})
    if wrong_tag:
        problems.append(f"{name}: sections cite {wrong_tag}, not the deck's tag {j.get('tag')!r}")
    pend = [n for n, _, b, _ in secs if "VISUAL-PENDING" in b]
    if pend:
        problems.append(f"{name}: still VISUAL-PENDING on pages {pend}")
    untyped = [n for n, _, _, t in secs if t is None]
    if untyped:
        problems.append(f"{name}: no Type line on pages {untyped}")
    admin = sum(1 for _, _, _, t in secs if t == "admin")
    return problems, (len(nums), len(pend), admin)


def deck_problems(course, folder, j, all_decks=None):
    """deck.json has every field with the right type, the folder is the tag's file-safe form, every page has an
    image and a transcript section."""
    name = j.get("tag") or folder.name
    p = []
    tag = j.get("tag")
    if not isinstance(tag, str) or not tag.strip():
        p.append(f"{folder.name}: deck.json has no tag")
    elif safe_tag(tag) != folder.name:
        p.append(f"{name}: folder decks/{folder.name} should be decks/{safe_tag(tag)} (the tag's file-safe form)")
    if not isinstance(j.get("title"), str) or not j["title"].strip():
        p.append(f"{name}: title missing")
    role = j.get("role")
    if role not in (LECTURE, PRACTICE):
        p.append(f"{name}: role {role!r} is not {LECTURE!r} or {PRACTICE!r}")
    for k in ("week", "order", "pages"):
        v = j.get(k)
        least = 1 if k == "pages" else 0
        if not isinstance(v, int) or isinstance(v, bool) or v < least:
            p.append(f"{name}: {k} {v!r} is not a whole number >= {least}")
    if not isinstance(j.get("prepared"), bool):
        p.append(f"{name}: prepared {j.get('prepared')!r} is not true/false")
    if not isinstance(j.get("source"), str) or not j["source"].strip():
        p.append(f"{name}: source missing")
    topic = j.get("topic")
    if not isinstance(topic, str):
        p.append(f"{name}: topic {topic!r} is not a string")
    elif role == PRACTICE and topic.strip():
        p.append(f"{name}: a practice deck has no topic (found {topic!r})")
    elif role == LECTURE and not topic.strip():
        p.append(f"{name}: a lecture deck needs a topic ({UNSORTED!r} until it is filed)")
    pages = j.get("pages") if isinstance(j.get("pages"), int) else 0
    missing = [n for n in range(1, pages + 1) if not (folder / f"s{n:03d}.jpg").is_file()]
    if missing:
        p.append(f"{name}: slide images missing for pages {missing}")
    extra = sorted(int(m.group(1)) for f in folder.glob("s*.jpg")
                   if (m := re.fullmatch(r"s(\d+)\.jpg", f.name)) and int(m.group(1)) > pages)
    if extra:
        p.append(f"{name}: images for pages beyond {pages}: {extra}")
    tr = folder / TRANSCRIPT
    if not tr.is_file():
        p.append(f"{name}: no decks/{folder.name}/{TRANSCRIPT}")
    else:
        nums = [n for n, _, _, _ in sections(tr.read_text(encoding="utf-8"))]
        if nums != list(range(1, pages + 1)):
            p.append(f"{name}: decks/{folder.name}/{TRANSCRIPT} has {len(nums)} sections for {pages} pages")
    if all_decks is not None and isinstance(tag, str):
        others = [f.name for f, k in all_decks if k.get("tag") == tag and f != folder]
        if others:
            p.append(f"{name}: tag also claimed by decks/{', decks/'.join(others)}")
    return p


def check_deck(course, chosen):
    problems, everything = [], decks(course)
    for folder, j in chosen:
        dp = deck_problems(course, folder, j, everything)
        problems += dp
        print(f"{str(j.get('tag')):14s} {str(j.get('role')):8s} W{j.get('week')!s:<3s} pages={j.get('pages')!s:<4s} "
              f"prepared={str(j.get('prepared')).lower():5s} topic={j.get('topic') or '-'}  {'OK' if not dp else 'FAIL'}")
    return problems


def check_transcripts(course, chosen):
    problems = []
    for folder, j in chosen:
        tp, (n, pend, admin) = transcript_problems(course, folder, j)
        problems += tp
        print(f"{str(j.get('tag')):14s} pages={j.get('pages')!s:<4s} sections={n:<4d} pending={pend:<4d} admin={admin}"
              f"  ({transcript_path(course, folder).relative_to(course).as_posix()})")
    return problems


def audit_coverage(course, folder):
    """(pages covered by the deck's audit logs, number of logged fixes)."""
    covered, fixes = set(), 0
    for log in work_dir(course, folder.name).glob("audit-p*.md"):
        text = log.read_text(encoding="utf-8")
        for m in re.finditer(r"^pages checked:\s*(\d+)\s*[-–]\s*(\d+)", text, re.M):
            covered.update(range(int(m.group(1)), int(m.group(2)) + 1))
        fixes += len(re.findall(r"^s\d+ · ", text, re.M))
    return covered, fixes


def audit_problems(course, folder, j):
    pages = j.get("pages") if isinstance(j.get("pages"), int) else 0
    covered, fixes = audit_coverage(course, folder)
    missing = sorted(set(range(1, pages + 1)) - covered)
    return ([f"{j.get('tag')}: pages not audited {missing}"] if missing else []), (pages - len(missing), pages, fixes)


def check_audit(course, chosen):
    problems = check_transcripts(course, chosen)
    for folder, j in chosen:
        ap, (done, pages, fixes) = audit_problems(course, folder, j)
        problems += ap
        print(f"{str(j.get('tag')):14s} audited={done}/{pages} fixes={fixes}")
    return problems


def course_topics(course):
    """{topic name: read_more} from course.json."""
    cj = read_json(course / COURSE_FILE) or {}
    return {str(t.get("name") or "").strip(): str(t.get("read_more") or "").strip()
            for t in cj.get("topics") or [] if isinstance(t, dict)}


def check_sorted(course, chosen):
    problems, everything = [], decks(course)
    if read_json(course / COURSE_FILE) is None:
        problems.append(f"no readable {COURSE_FILE}: the hub won't list this course")
    topics = course_topics(course)
    for folder, j in chosen:
        name = j.get("tag") or folder.name
        dp = deck_problems(course, folder, j, everything)
        if j.get("prepared") is not True:
            dp.append(f"{name}: prepared is not true (finish it: extract.py finish)")
        tr = folder / TRANSCRIPT
        if tr.is_file() and "VISUAL-PENDING" in tr.read_text(encoding="utf-8"):
            dp.append(f"{name}: decks/{folder.name}/{TRANSCRIPT} still has VISUAL-PENDING pages")
        t = str(j.get("topic") or "").strip()
        if j.get("role") == LECTURE and t:
            if t.lower() == UNSORTED.lower():
                dp.append(f"{name}: not filed under a topic yet (topic {UNSORTED!r})")
            elif t not in topics:
                dp.append(f"{name}: topic {t!r} is not in {COURSE_FILE} topics (add it with its read_more)")
            elif not topics[t]:
                dp.append(f"{name}: topic {t!r} has no read_more in {COURSE_FILE}")
        problems += dp
        shown = t or ("(practice)" if j.get("role") == PRACTICE else "-")
        print(f"{str(name):14s} topic={shown:30s} {'OK' if not dp else 'FAIL'}")
    return problems


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("course")
    ap.add_argument("scope", help="deck tag or folder, week number, 'practice' or 'all'")
    ap.add_argument("what", choices=["deck", "transcripts", "audit", "sorted"])
    a = ap.parse_args()
    course = Path(a.course).resolve()
    chosen = select(course, a.scope)
    problems = []
    if not chosen:
        problems.append(f"no deck matches {a.scope!r} in {course / 'decks'}")
    if a.scope.lower() == "all":       # the hub silently skips a deck.json it can't read: say so here
        problems += [f"{f.parent.name}: {DECK_FILE} is not valid JSON"
                     for f in sorted((course / "decks").glob(f"*/{DECK_FILE}")) if read_json(f) is None]
    fn = {"deck": check_deck, "transcripts": check_transcripts, "audit": check_audit, "sorted": check_sorted}[a.what]
    problems += fn(course, chosen) if chosen else []
    print("\nOK" if not problems else "\nFAIL\n- " + "\n- ".join(problems))
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
