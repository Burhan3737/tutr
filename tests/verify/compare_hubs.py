"""Compare two hub runs recorded by hubdrive.py: an older hub on the old course layout against the new hub on the same
data migrated to the library layout. Prints (and writes) every difference left after normalising the intended ones.

    python tests/verify/compare_hubs.py --old old.json --new new.json --out report.md [--rules rules.py]
                                        [--allow-doc-kind NAME ...]

Normalised, and nothing else:
- warm-ups (removed on purpose): `warmup` fields, warm-up review items, the warm-up practice kind, the review count
  that warm-ups took up, the warm-up item ids they used;
- file locations: the old layout's paths in the old run are rewritten to the new layout's (course/WeekN/ notes ->
  me/notes/WeekN/, study/ -> me/, .cache/uploads -> me/uploads, .cache/textbooks -> textbooks, labs/ and
  assignments/ -> me/notes/, each deck's transcript and PDF -> its decks/<folder>/), and "PDF only" -> "slide images
  only";
- ids and times: generated ids are renamed in order of first appearance, timestamps and timings are blanked;
- the visible title (Study Hub -> Tutr) in the static files;
- --rules: a Python file with RULES = [(regex, replacement), ...], applied to every string of BOTH runs (e.g. example
  wording that differs between the two versions of the code, so both runs' prompts read alike);
- --allow-doc-kind: a me/notes/ folder listed only by the new hub (a folder the old layout had no place for).
"""
import argparse, difflib, importlib.util, json, re, sys
from pathlib import Path

PATH_RULES = [
    (r"\.cache/uploads/", "me/uploads/"),
    (r"\.cache/textbooks", "textbooks"),
    (r"(?<![\w.-])study/(progress\.md|tutor-memory\.md|hub-state\.json)", r"me/\1"),
    (r"(?<![\w.-])study/exams/", "me/notes/exams/"),
    (r"(?<![\w./-])course/(Week\d+)/", r"me/notes/\1/"),
    (r"(?<![\w./-])(labs|assignments)/", r"me/notes/\1/"),
    (r"\(no transcript yet: PDF only\)", "(no transcript yet: slide images only)"),
]
TS = [(re.compile(r"\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?\b"), "<time>")]
ID = re.compile(r"\b[0-9a-f]{10,12}\b")
DROP_KEYS = {"warmup", "ms", "cost", "epoch", "warmups_seeded"}


def load_rules(path):
    if not path:
        return []
    spec = importlib.util.spec_from_file_location("verify_rules", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return [(re.compile(a, re.M), b) for a, b in mod.RULES]


class AltStr(str):
    """An old-run string with the path rules applied; .alt is the same string without them. Stored content (a chat's
    text, the student's notes) is never rewritten by the migration, so it may match either way."""
    alt = None


class Norm:
    def __init__(self, old_run, new_run, rules):
        self.rules = rules
        self.ids = [{}, {}]
        self.old_paths = []
        for key, d in old_run["decks"].items():         # each deck's old transcript/PDF -> the new run's folder
            n = new_run["decks"].get(key)
            if not n:
                continue
            course = key.split(" ", 1)[0]
            folder = f"decks/{n['folder']}/"
            if d.get("transcript") and n.get("transcript"):
                self.old_paths.append((d["transcript"], n["transcript"]))
            if d.get("pdf"):
                self.old_paths.append((f"{d['pdf']} (no transcript yet: PDF only)", f"{folder} (no transcript yet: slide images only)"))
                self.old_paths.append((d["pdf"], folder))
        self.old_paths.sort(key=lambda x: -len(x[0]))
        self.path_rules = [(re.compile(a), b) for a, b in PATH_RULES]
        # The old hub's warm-up practice problems (its "warmup" kind, gone on purpose): one fixed name, so the ids
        # after them still pair up
        self.warm_ids = {a["reply"]["json"]["id"] for a in old_run.get("actions", [])
                         if (a.get("body") or {}).get("kind") == "warmup" and isinstance((a["reply"].get("json") or {}).get("id"), str)}
        self.ids[0].update({w: "<warm-up practice>" for w in self.warm_ids})

    def text(self, s, side):
        if side == 0:
            raw = self._common(s, side)
            for a, b in self.old_paths:
                s = s.replace(a, b)
            for a, b in self.path_rules:
                s = a.sub(b, s)
            s = self._common(s, side)
            if s != raw:
                s = AltStr(s)
                s.alt = raw
            return s
        return self._common(s, side)

    def _common(self, s, side):
        for a, b in self.rules:
            s = a.sub(b, s)
        for a, b in TS:
            s = a.sub(b, s)
        ids = self.ids[side]

        def name(m):
            v = m.group(0)
            if not re.search(r"[0-9]", v):
                return v
            if v not in ids:
                ids[v] = f"<id{sum(1 for x in ids.values() if x.startswith('<id')) + 1}>"
            return ids[v]
        return ID.sub(name, s)

    def value(self, v, side):
        if isinstance(v, str):
            return self.text(v, side)
        if isinstance(v, list):
            return [self.value(x, side) for x in v if not (isinstance(x, dict) and x.get("warmup") is True)]
        if isinstance(v, dict):
            return {str(self.text(k, side)): self.value(x, side) for k, x in v.items() if k not in DROP_KEYS}
        return v


def diff(a, b, path="", out=None, limit=4000):
    out = [] if out is None else out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in list(a) + [k for k in b if k not in a]:
            if k not in b:
                out.append((f"{path}/{k}", "only old", _short(a[k]), ""))
            elif k not in a:
                out.append((f"{path}/{k}", "only new", "", _short(b[k])))
            else:
                diff(a[k], b[k], f"{path}/{k}", out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append((path, f"length {len(a)} vs {len(b)}", _short(a), _short(b)))
        for i, (x, y) in enumerate(zip(a, b)):
            diff(x, y, f"{path}[{i}]", out)
    elif a != b and not _alt_equal(a, b):
        if isinstance(a, str) and isinstance(b, str) and ("\n" in a or len(a) > 200):
            ud = "\n".join(difflib.unified_diff(a.splitlines(), b.splitlines(), "old", "new", n=1, lineterm=""))
            out.append((path, "text", ud[:limit], ""))
        else:
            out.append((path, "value", _short(a), _short(b)))
    return out


def _alt_equal(a, b):
    """An old string matches when it equals the new one with or without the path rules, line by line (a file the hub
    rewrites can hold the student's own lines, never rewritten, next to the hub's own, which name the new paths)."""
    if not isinstance(a, AltStr) or not isinstance(b, str):
        return False
    if a.alt == b:
        return True
    la, lr, lb = a.splitlines(), a.alt.splitlines(), b.splitlines()
    return len(la) == len(lr) == len(lb) and all(y in (x, r) for x, r, y in zip(la, lr, lb))


def static_files(old, new, norm):
    """Text diff of the web app's files as each hub serves them (static/ next to each hub's server.py)."""
    out = []
    for name in ("app.js", "index.html", "style.css", "visuals.js", "drafts.js", "pcm-worklet.js"):
        a, b = (Path(r["code"]) / "static" / name for r in (old, new))
        if not (a.is_file() and b.is_file()):
            out.append(f"- {name}: missing on one side")
            continue
        ta, tb = (norm._common(p.read_text(encoding="utf-8").replace("\r\n", "\n").replace("Study Hub", "Tutr"), 0)
                  for p in (a, b))
        if ta != tb:
            ud = "\n".join(difflib.unified_diff(ta.splitlines(), tb.splitlines(), f"old {name}", f"new {name}", n=0,
                                                lineterm=""))
            out.append("```diff\n" + ud + "\n```")
    return out


def _short(v, n=300):
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + "…"


# ---------------------------------------------------------------- written files

def logical_writes(run, norm, side):
    """{logical name: normalised content} of the files the actions wrote, so the old layout's locations meet the new."""
    out = {}
    for rel, e in run["writes"].items():
        if rel.endswith((".log", ".tmp")) or "/voice/" in rel or "/render/" in rel or any(w in rel for w in norm.warm_ids):
            continue
        text = e.get("text")
        content = None
        if text is not None and rel.endswith(".json"):
            try:
                content = json.loads(text)
            except ValueError:
                content = text
        elif text is not None:
            content = text
        name = rel
        m = re.search(r"(?:^|/)(chats|practice)/([^/]+\.json)$", rel)
        if m and isinstance(content, dict):
            name = f"{content.get('course', '?')}/me/{m.group(1)}/{m.group(2)}"
        if rel.endswith("drafts.json") and isinstance(content, dict):
            for course, d in content.items():
                out[norm.text(f"{course}/me/drafts.json", side)] = norm.value({course: d}, side)
            continue
        if content is None:
            content = {"state": e["state"], "sha1": e.get("sha1")}
        out[norm.text(name, side)] = norm.value(content, side)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--old", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--rules")
    ap.add_argument("--allow-doc-kind", action="append", default=[])
    args = ap.parse_args()
    old = json.loads(Path(args.old).read_text(encoding="utf-8"))
    new = json.loads(Path(args.new).read_text(encoding="utf-8"))
    norm = Norm(old, new, load_rules(args.rules))
    report, totals = [], {}

    def section(title, pairs):
        found, warm = [], []
        for key, (a, b) in pairs.items():
            for d in diff(a, b, key):
                (warm if "warm-up" in d[0] else found).append(d)
        totals[title] = (len(pairs), len(found), len(warm))
        report.append(f"## {title}: {len(pairs)} compared, {len(found)} unexpected differences"
                      + (f" (+ {len(warm)} from the removed warm-ups, listed last)" if warm else "") + "\n")
        for p, kind, x, y in found + [("(warm-up) " + w[0],) + tuple(w[1:]) for w in warm]:
            report.append(f"- `{p}` ({kind})")
            if kind == "text":
                report.append("```diff\n" + x + "\n```")
            else:
                report.append(f"  - old: `{x}`\n  - new: `{y}`")
        report.append("")
        return found

    # ---- Layer 2: what the hubs show
    def views(run, side, allow=()):
        v = {}
        for k, x in run.items():
            k2 = norm.text(k, side)
            if k.startswith("static "):
                continue
            if side == 1 and any(f"/{kind}/" in k2 for kind in allow) and k2.startswith("doc "):
                continue
            v[k2] = norm.value(x, side)
        return v

    def fix_course(c, allow):
        """The new hub's summary of a course with the allowed extra doc groups taken out."""
        if isinstance(c, dict) and "docs" in c:
            c = dict(c, docs=[g for g in c["docs"] if g.get("kind") not in allow])
        return c

    for name, ka in (("view", "view"), ("view after actions", "view_after")):
        allow = set(args.allow_doc_kind)
        va, vb = views(old[ka], 0), views(new[ka], 1, allow)
        for v in (vb,):
            for k in list(v):
                if k.startswith("course ") and isinstance(v[k], dict) and isinstance(v[k].get("json"), dict):
                    v[k]["json"] = fix_course(v[k]["json"], allow)
                if k == "home" and isinstance(v[k].get("json"), dict):
                    v[k]["json"]["courses"] = [fix_course(c, allow) for c in v[k]["json"]["courses"]]
        # warm-ups: the old count and minutes included them
        for k in list(va):
            if (k.startswith("course ") or k == "home") and isinstance(va[k].get("json"), dict):
                cs = va[k]["json"]["courses"] if k == "home" else [va[k]["json"]]
                raw = old[ka][k]["json"]["courses"] if k == "home" else [old[ka][k]["json"]]
                for c, r in zip(cs, raw):
                    w = (r.get("reviews") or {}).get("warmup", 0)
                    if w and "reviews" in c:
                        cnt = c["reviews"]["count"] - w
                        c["reviews"] = {"count": cnt, "minutes": max(1, round(cnt * 1.5)) if cnt else 0}
        keys = sorted(set(va) | set(vb))
        pairs = {k: (va.get(k, "<missing>"), vb.get(k, "<missing>")) for k in keys}
        section(f"Layer 2 — {name}", pairs)
        if ka == "view":
            static = {k: (old[ka][k], new[ka][k]) for k in old[ka] if k.startswith("static ") and k in new[ka]}
            report.append("Static files served, byte for byte: " + ", ".join(
                f"{k[7:]} {'same' if a.get('sha1') == b.get('sha1') else 'different'}" for k, (a, b) in static.items()) + "\n")

    # ---- Layer 3: what the tutor is sent
    def calls(run, side):
        out = []
        for c in run["calls"]:
            if side == 0 and c["label"] == "practice:warmup":
                continue
            out.append(norm.value(c, side))
        return out
    ca, cb = calls(old, 0), calls(new, 1)
    pairs = {f"call {i + 1} {(ca[i] if i < len(ca) else cb[i])['label']}": (ca[i] if i < len(ca) else "<missing>",
                                                                             cb[i] if i < len(cb) else "<missing>")
             for i in range(max(len(ca), len(cb)))}
    section("Layer 3 — model calls (system prompt + prompt + options)", pairs)
    section("Layer 3 — warmed chats (open_chat)", {f"open {i + 1}": (norm.value(a, 0), norm.value(b, 1))
                                                    for i, (a, b) in enumerate(zip(old.get("opened", []), new.get("opened", [])))}
            | ({"count": (len(old.get("opened", [])), len(new.get("opened", [])))}))
    for k in ("system_prompts", "course_maps", "hints", "status_lines"):
        a, b = norm.value(old[k], 0), norm.value(new[k], 1)
        section(f"Layer 3 — {k}", {key: (a.get(key, "<missing>"), b.get(key, "<missing>")) for key in sorted(set(a) | set(b))})

    # ---- Layer 4: what the hubs write
    def acts(run, side):
        return {f"{i:03d} {a['name']} {a['body'].get('course', '') if isinstance(a['body'], dict) else ''}":
                norm.value(a["reply"], side) for i, a in enumerate(run["actions"])}
    aa, ab = acts(old, 0), acts(new, 1)
    section("Layer 4 — action replies", {k: (aa.get(k, "<missing>"), ab.get(k, "<missing>")) for k in sorted(set(aa) | set(ab))})
    wa, wb = logical_writes(old, norm, 0), logical_writes(new, norm, 1)
    section("Layer 4 — files written (by logical location)", {k: (wa.get(k, "<missing>"), wb.get(k, "<missing>"))
                                                               for k in sorted(set(wa) | set(wb))})
    section("Layer 2 — files written by merely looking", {"writes_by_views": (norm.value(old["writes_by_views"], 0),
                                                                              norm.value(new["writes_by_views"], 1))})

    head = ["# Old hub vs new hub\n", f"old: {old['code']} on {old['root']}", f"new: {new['code']} on {new['root']}", "",
            "| Section | Compared | Unexpected differences | Warm-up differences |", "|---|---|---|---|"]
    head += [f"| {t} | {n} | {d} | {w} |" for t, (n, d, w) in totals.items()]
    head += ["", "## Static files (the web app), after line endings, the title and --rules", ""] + \
        (static_files(old, new, norm) or ["identical"])
    Path(args.out).write_text("\n".join(head + [""] + report), encoding="utf-8")
    sys.stdout.reconfigure(errors="replace")
    print("\n".join(h for h in head if h.startswith("|")))
    print(f"report: {args.out}")
    return sum(d for _, d, _ in totals.values())


if __name__ == "__main__":
    main()
