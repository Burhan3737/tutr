"""Mechanical checks for a week's prepared slides. Exit code 1 if anything fails.

    python check.py <course-folder> <week-number> transcripts
    python check.py <course-folder> <week-number> audit
    python check.py <course-folder> <week-number> sorted

transcripts: every deck in manifest.json has one section per page, none still VISUAL-PENDING,
             every section ends with a Type line.
audit:       transcripts valid and every page of every deck inside some audit log's "pages checked: A-B".
sorted:      every deck of the week has a row in the CLAUDE.md deck table with a Topic, that topic has a
             row in the Topics table, and every slide image exists in study/slides/.
"""
import argparse, json, re, sys
from pathlib import Path

SEC = re.compile(r"^## \[(?P<tag>[^\]]+?) s(?P<n>\d+)\]", re.M)
CITE = re.compile(r"\[(?P<tag>[A-Za-z][\w&.\-]*(?: [\w&.\-]+)?) s(?P<body>\d[^\]]*)\]")


def load(course, week):
    out = course / ".cache" / f"Week{week}"
    mf = out / "manifest.json"
    if not mf.exists():
        sys.exit(f"No manifest at {mf}. Run extract.py first.")
    return out, json.loads(mf.read_text(encoding="utf-8"))


def sections(path):
    text = path.read_text(encoding="utf-8")
    parts = list(SEC.finditer(text))
    res = []
    for i, m in enumerate(parts):
        body = text[m.end(): parts[i + 1].start() if i + 1 < len(parts) else len(text)]
        t = re.search(r"^Type:\s*(\w+)", body, re.M)
        res.append((int(m.group("n")), body, t.group(1).lower() if t else None))
    return res


def pages_in(body):
    """'3', '3–5', '3, 7', 's3–s5' -> set of page numbers."""
    pages = set()
    for piece in re.split(r"[,;]", body):
        m = re.match(r"^\s*s?(\d+)\s*(?:[–—-]\s*s?(\d+))?", piece)
        if m:
            a, b = int(m.group(1)), int(m.group(2) or m.group(1))
            pages.update(range(a, b + 1))
    return pages


def check_transcripts(course, week):
    out, mf = load(course, week)
    problems = []
    for d in mf["decks"]:
        secs = sections(course / d["transcript"])
        nums = [n for n, _, _ in secs]
        if nums != list(range(1, d["pages"] + 1)):
            problems.append(f"{d['stem']}: sections {len(nums)} vs pages {d['pages']} (or out of order)")
        pend = [n for n, b, _ in secs if "VISUAL-PENDING" in b]
        if pend:
            problems.append(f"{d['stem']}: still VISUAL-PENDING on pages {pend}")
        untyped = [n for n, _, t in secs if t is None]
        if untyped:
            problems.append(f"{d['stem']}: no Type line on pages {untyped}")
        admin = sum(1 for _, _, t in secs if t == "admin")
        print(f"{d['stem']:40s} pages={d['pages']:3d} sections={len(nums):3d} pending={len(pend):3d} admin={admin}")
    return problems


def check_audit(course, week):
    """Transcripts still valid, and every page of every deck appears in some audit log's
    'pages checked: A-B' line."""
    problems = check_transcripts(course, week)
    out, mf = load(course, week)
    for d in mf["decks"]:
        covered = set()
        for log in out.glob(f"audit-{d['stem']}-p*.md"):
            for m in re.finditer(r"^pages checked:\s*(\d+)\s*[-–]\s*(\d+)", log.read_text(encoding="utf-8"), re.M):
                covered.update(range(int(m.group(1)), int(m.group(2)) + 1))
        missing = sorted(set(range(1, d["pages"] + 1)) - covered)
        changes = sum(len(re.findall(r"^s\d+ · ", l.read_text(encoding="utf-8"), re.M))
                      for l in out.glob(f"audit-{d['stem']}-p*.md"))
        print(f"{d['stem']:40s} audited={d['pages'] - len(missing):3d}/{d['pages']:3d} fixes={changes}")
        if missing:
            problems.append(f"{d['stem']}: pages not audited {missing}")
    return problems


def safe_tag(tag):
    return re.sub(r"[^A-Za-z0-9-]", "", tag)


def check_sorted(course, week):
    """Every deck filed under a topic that has a Read-more row, and every slide image present."""
    out, mf = load(course, week)
    text = (course / "CLAUDE.md").read_text(encoding="utf-8")
    rows, topics = {}, set()
    for line in text.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        k = next((i for i, c in enumerate(cells) if "`" in c), None)
        if k and len(cells) > k + 1 and re.fullmatch(r"\d+", cells[0] or ""):
            tag = re.findall(r"`([^`]+)`", cells[k])[0]
            rows[tag] = cells[k + 1]
    m = re.search(r"^## Topics\s*$(.*?)(?=^## |\Z)", text, re.M | re.S)
    for line in (m.group(1) if m else "").splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) >= 2 and cells[0] and cells[0] != "Topic" and not set(cells[0]) <= set("-: "):
            topics.add(cells[0])
    problems = []
    for d in mf["decks"]:
        t = rows.get(d["tag"], "")
        if not t:
            problems.append(f"{d['tag']}: no Topic in the CLAUDE.md deck table")
        elif t not in topics:
            problems.append(f"{d['tag']}: topic '{t}' has no row in the Topics table (add it with Read more)")
        missing = [n for n in range(1, d["pages"] + 1)
                   if not (course / "study" / "slides" / f"{safe_tag(d['tag'])}-s{n:03d}.jpg").exists()]
        if missing:
            problems.append(f"{d['tag']}: slide images missing for pages {missing}")
        print(f"{d['tag']:12s} topic={t or '-':30s} images={d['pages'] - len(missing)}/{d['pages']}")
    return problems


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("course")
    ap.add_argument("week", type=int)
    ap.add_argument("what", choices=["transcripts", "audit", "sorted"])
    a = ap.parse_args()
    course = Path(a.course).resolve()
    fn = {"transcripts": check_transcripts, "audit": check_audit, "sorted": check_sorted}[a.what]
    problems = fn(course, a.week)
    print("\nOK" if not problems else "\nFAIL\n- " + "\n- ".join(problems))
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
