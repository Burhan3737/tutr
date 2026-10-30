"""Shared helpers for the preparing-slides scripts: the library format the Study Hub reads (library.py).

A course folder holds:
  course.json                    {"code", "title", "assessment_style", "topics": [{"name", "read_more"}]}
  sources/WeekN/*.pdf            lecture decks as downloaded
  sources/practice/*.pdf         homework and practice exams
  sources/textbooks/*.pdf        textbooks
  decks/<safe tag>/deck.json     {"tag", "title", "role", "week", "topic", "order", "pages", "prepared", "source",
                                  "sha1"}  (sha1: the source PDF's hash, used by these scripts only)
  decks/<safe tag>/transcript.md one "## [<tag> sN] <title>" section per page
  decks/<safe tag>/sNNN.jpg      one image per page
  textbooks/<book>.txt, .toc.md  tutor-searchable textbook text
  .work/                         disposable working files (PNGs, scratch, audits, work transcripts)
"""
import hashlib, json, os, re, sys
from pathlib import Path

try:
    import fitz
except ImportError:
    sys.exit("PyMuPDF is required: pip install pymupdf")

COURSE_FILE = "course.json"
DECK_FILE = "deck.json"
TRANSCRIPT = "transcript.md"
LECTURE, PRACTICE = "lecture", "practice"
UNSORTED = "Unsorted"          # lecture topic written by Add; the hub shows it as "Not sorted yet"
SLIDE_DPI = 90                 # slide images for the viewer
WEEK_RE = re.compile(r"^Week(\d+)$", re.I)
SEC_RE = re.compile(r"^## \[(?P<tag>[^\]]+?) s(?P<n>\d+)\]", re.M)


def utf8_stdout():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass


def safe_tag(tag):
    """File-name form of a citation tag, e.g. 'S&D-2' -> 'SD-2' (same rule as the hub's library.safe_tag)."""
    return re.sub(r"[^A-Za-z0-9-]", "", tag)


def sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_text(path, text):
    """Write atomically, so the hub never reads a half-written file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def read_json(path):
    try:
        v = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return v if isinstance(v, dict) else None


def write_json(path, obj):
    write_text(path, json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


def rel(course, path):
    """A path relative to the course folder (posix), or the absolute path when it lies outside it."""
    path = Path(path).resolve()
    try:
        return path.relative_to(course).as_posix()
    except ValueError:
        return path.as_posix()


def decks(course):
    """[(folder Path, deck.json dict)] for every readable deck of the course."""
    out = []
    for f in sorted((course / "decks").glob(f"*/{DECK_FILE}")):
        j = read_json(f)
        if j is not None:
            out.append((f.parent, j))
    return out


def as_int(v, default=0):
    if isinstance(v, bool):
        return default
    if isinstance(v, (int, float)):
        return int(v)
    m = re.match(r"\s*(\d+)", str(v or ""))
    return int(m.group(1)) if m else default


def ensure_course(course):
    """A course needs course.json for the hub to list it; create a minimal one when it's missing."""
    cf = course / COURSE_FILE
    if not cf.exists():
        write_json(cf, {"code": course.name, "title": course.name, "assessment_style": "", "topics": []})
        print(f"Created a minimal {cf.name} (code and title = folder name): fill in code, title and assessment_style.")


def select(course, scope):
    """Decks named by a scope: 'all', a week ('3' or 'Week3': its lecture decks), 'practice' (every practice deck),
    or a deck tag / folder name. Returns [(folder, deck.json)] in lecture order."""
    found = decks(course)
    s = scope.strip()
    m = WEEK_RE.match(s) or re.fullmatch(r"(\d+)", s)
    if s.lower() == "all":
        hit = found
    elif s.lower() == PRACTICE:
        hit = [(f, j) for f, j in found if j.get("role") == PRACTICE]
    elif m:
        n = int(m.group(1))
        hit = [(f, j) for f, j in found if j.get("role") != PRACTICE and as_int(j.get("week")) == n]
    else:
        hit = [(f, j) for f, j in found if j.get("tag") == s or f.name == s or f.name == safe_tag(s)]
    return sorted(hit, key=lambda x: (as_int(x[1].get("week")), as_int(x[1].get("order")), x[0].name))


def sections(text):
    """[(n, title, body, type or None)] for every '## [tag sN] title' section."""
    parts = list(SEC_RE.finditer(text))
    res = []
    for i, m in enumerate(parts):
        line_end = text.find("\n", m.end())
        line_end = len(text) if line_end < 0 else line_end
        title = text[m.end():line_end].strip()
        body = text[line_end: parts[i + 1].start() if i + 1 < len(parts) else len(text)]
        t = re.search(r"^Type:\s*(\w+)", body, re.M)
        res.append((int(m.group("n")), title, body, t.group(1).lower() if t else None))
    return res


def work_dir(course, folder_name):
    return course / ".work" / folder_name


def render_jpgs(doc, folder, only_missing=False):
    """decks/<folder>/sNNN.jpg for every page; removes images of pages the PDF no longer has."""
    folder.mkdir(parents=True, exist_ok=True)
    for i, page in enumerate(doc, 1):
        img = folder / f"s{i:03d}.jpg"
        if not (only_missing and img.exists()):
            page.get_pixmap(dpi=SLIDE_DPI).save(img, jpg_quality=80)
    for img in folder.glob("s*.jpg"):
        m = re.fullmatch(r"s(\d+)\.jpg", img.name)
        if m and int(m.group(1)) > doc.page_count:
            img.unlink()
