// Live drafts, the pure part: merging two devices' edits to the Ask box and keeping the cursor in place when
// the text changes under it. No page access, so test_drafts.py can run it in Node. The syncing is in app.js.
"use strict";

// The one edit that turns `a` into `b`: the unchanged start and end, and the part between them.
// Returns { at, end, ins }: a.slice(at, end) was replaced by ins.
function draftEdit(a, b) {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { at: p, end: a.length - s, ins: b.slice(p, b.length - s) };
}

// Both devices changed `base`: this one to `mine`, the hub's newer copy to `theirs`. When the two edits touch
// different parts of the text, both are kept. When they overlap, the hub's copy wins (it was saved first).
function draftMerge(base, mine, theirs) {
  if (mine === base) return theirs;
  if (theirs === base || theirs === mine) return mine;
  const m = draftEdit(base, mine), t = draftEdit(base, theirs);
  if (m.end <= t.at && !(m.at === m.end && t.at === t.end && m.at === t.at && t.at === base.length))
    return base.slice(0, m.at) + m.ins + base.slice(m.end, t.at) + t.ins + base.slice(t.end);
  if (t.end <= m.at)            // (both typed at the very end: theirs first, then mine)
    return base.slice(0, t.at) + t.ins + base.slice(t.end, m.at) + m.ins + base.slice(m.end);
  return theirs;
}

// Where cursor position `pos` in `before` belongs in `after`: unmoved before the change, shifted after it,
// at the end of the new text when it was inside the part that changed.
function draftCaret(before, after, pos) {
  const e = draftEdit(before, after);
  if (pos <= e.at) return pos;
  if (pos >= e.end) return pos + after.length - before.length;
  return e.at + e.ins.length;
}

if (typeof module !== "undefined") module.exports = { draftEdit, draftMerge, draftCaret };
