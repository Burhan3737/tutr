# Agent prompts

Fill every `{…}`. Agents write files and report counts only — never paste content back.
Absolute paths; `{C}` = course folder, `{F}` = the deck's folder name (its tag's file-safe form, e.g. `SD-2`),
`{tag}` = the deck's tag, `{S}` = this skill's folder.
Every agent: scratch files only under `{C}/.work/{F}/scratch/<your-part>/`; no package installs;
write files with the Write/Edit tools, not shell heredocs (they mangle `\\`).
Agents edit only the work transcript `{C}/.work/{F}/transcript.md` — never `{C}/decks/` (the hub shows it;
`extract.py finish` publishes the work transcript there).

## 1. Transcribe (≤ 45 visual pages per agent, all in parallel)

> Transcribe lecture pages faithfully. Equations, diagrams and handwriting are images, so view every
> listed PNG with the Read tool.
>
> File: `{C}/.work/{F}/transcript.md`. Your pages: {page list}. Each is a section
> `## [{tag} sN] …` whose body says VISUAL-PENDING above the page's partial text layer. Image for page N:
> `{C}/.work/{F}/png/pNNN.png`. Other agents may be editing other pages of the same file:
> change only your pages, with the Edit tool, one section at a time.
>
> For each page, replace everything after its `## [{tag} sN]` line (up to the next `## [`) with: the real
> slide title on the heading line; all text verbatim; every equation in KaTeX (`$…$`, `$$…$$`);
> code in fenced blocks; tables as Markdown tables; diagrams, traces and charts described precisely
> enough to redraw; handwriting prefixed `Handwritten:`. End with `Type: content`, `Type: exercise` or
> `Type: admin` (admin = title, agenda-only, reading lists, references, logistics, navigation, blank —
> nothing teachable).
>
> Faithful only — no explanation or added knowledge. Illegible → `[illegible]`, never guess. If the page
> seems wrong (index typo, sign error, code that can't run), transcribe it as shown and add
> `Possible erratum: <what and why>`.
>
> Report only: pages done, count by Type, every Possible erratum (page + one line).

## 1b. Audit the transcription (fresh agents — never the transcriber; ≤ 60 pages each, in parallel)

> Check a lecture transcript against the page images, page by page, for completeness and accuracy.
> Transcript: `{C}/.work/{F}/transcript.md`, your pages: {page list}. Page images:
> `{C}/decks/{F}/sNNN.jpg` (read them; never change anything in `{C}/decks/`). Other agents may be auditing
> other pages of the same file: change only your pages, with the Edit tool.
>
> For EVERY page in your list — including pages typed `admin` and pages that came from the text layer —
> open the image with the Read tool and compare it with that page's section. Enlarge small handwriting
> by cropping (save crops only under `{C}/.work/{F}/scratch/audit/`). Look for:
> - **Missing**: any text, bullet, formula, table row/cell, code line, label, arrow annotation,
>   handwritten mark or diagram detail on the image that the section doesn't have.
> - **Misread**: wrong symbol, sign, exponent, subscript, number, word, code token or colour attribution.
> - **Wrong type**: `admin` on a page that has anything teachable, or the reverse.
> Fix each one in place, keeping the transcript's format (verbatim; KaTeX; `Handwritten:`; `Possible
> erratum:` for slide errors — a faithful copy of a slide error is not a transcription error).
>
> Write a log to `{C}/.work/{F}/audit-p{first}-{last}.md`: one line per change —
> `s{N} · Missing|Misread|Wrong type · what was wrong → what it is now` — and a final line
> `pages checked: {first}-{last}` (the range you actually opened and compared). Report only: pages checked,
> changes by category, pages you could not read.
