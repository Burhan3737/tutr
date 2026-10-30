"""Old hub vs new hub, end to end: copy both libraries (and the hubs' code) to a work folder, drive each hub there
with hubdrive.py (in parallel), then compare the two runs with compare_hubs.py. The originals are never written.

    python tests/verify/verify_hubs.py --old-code <old hub folder> --old-root <old-layout library>
                                       --new-code <new hub folder> --new-root <migrated library>
                                       --work <scratch folder> [--rules rules.py] [--allow-doc-kind NAME ...]
                                       [--no-images]

Writes <work>/old.json, <work>/new.json and <work>/report.md (every difference left after normalising the intended
ones; see compare_hubs.py).
"""
import argparse, shutil, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKIP = shutil.ignore_patterns(".git", "__pycache__", "library", "agentTempWork", ".cache", "tests", "docs", "tools",
                              "example-library", ".claude", "config.json")


def fresh_copy(src, dst):
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__"))


def place(code, root, work, name):
    """Copy the library; the code goes with it when it lives inside the library, else into its own folder."""
    code, root = Path(code).resolve(), Path(root).resolve()
    lib = work / f"{name}-library"
    fresh_copy(root, lib)
    try:
        return lib / code.relative_to(root), lib
    except ValueError:
        dst = work / f"{name}-code"
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(code, dst, ignore=SKIP)
        return dst, lib


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for a in ("--old-code", "--old-root", "--new-code", "--new-root", "--work"):
        ap.add_argument(a, required=True)
    ap.add_argument("--rules")
    ap.add_argument("--allow-doc-kind", action="append", default=[])
    ap.add_argument("--no-images", action="store_true")
    args = ap.parse_args()
    work = Path(args.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    runs = []
    for name, code, root in (("old", args.old_code, args.old_root), ("new", args.new_code, args.new_root)):
        c, lib = place(code, root, work, name)
        cmd = [sys.executable, str(HERE / "hubdrive.py"), "--code", str(c), "--root", str(lib), "--out", str(work / f"{name}.json")]
        if args.no_images:
            cmd.append("--no-images")
        print(f"{name}: {c} on {lib}")
        runs.append((name, subprocess.Popen(cmd)))
    failed = [name for name, p in runs if p.wait() != 0]
    if failed:
        sys.exit(f"hubdrive failed for: {', '.join(failed)}")
    cmd = [sys.executable, str(HERE / "compare_hubs.py"), "--old", str(work / "old.json"), "--new", str(work / "new.json"),
           "--out", str(work / "report.md")]
    if args.rules:
        cmd += ["--rules", args.rules]
    for k in args.allow_doc_kind:
        cmd += ["--allow-doc-kind", k]
    sys.exit(subprocess.call(cmd))


if __name__ == "__main__":
    main()
