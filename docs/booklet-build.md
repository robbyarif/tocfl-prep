# Building a booklet series (from series 5)

How the booklet test data is built from the official TOCFL mock test booklets (Band A), what
each step relies on, and what to check. Series 5 is the reference; series 2–4 are not built yet.

## Commands

```
node scripts/build-booklet.mjs --series 5    # downloads (cached), builds public/data/booklet/s5.json and pages
npm run translate                            # English for new booklet lines (opus-mt-zh-en, offline after first run)
npm run build:analysis                       # word and grammar analysis (uses booklet and question bank)
```

Run them in this order. The build writes `public/data/booklet/index.json` with the list of series.
`npm run build:booklet` runs the same build script without the `--series` option (default 5).

## Source files

Per series N, the official site (`MOCK` in the script) gives:

- `ls_mock{N}_test_BandA_en_t.pdf` — listening booklet (English directions, Chinese text layer)
- `rd_mock{N}_test_BandA_en_t.pdf` — reading booklet
- `ls_mock{N}_test_BandA_answer.pdf`, `rd_mock{N}_test_BandA_answer.pdf` — answer keys
- Listening audio archive. Check the name for each series: series 5 used a zip (`AE.zip`), series 4
  in the cache is `s4_mp3_en.rar`. Extraction needs `node-unrar-js` for rar and the zip reader in the script.
- Listening scripts/transcripts: from the listening PDF text (speaker markers).

Everything is cached under `.cache/booklet/s{N}/`. Re-running is fast.

## What the build does (in order)

1. **Page text and page kinds.** `pdftotext -raw -enc UTF-8` per page.
   - `blank`: no text at all. Skipped in the booklet view.
   - `part`: contains a part heading (`第一部分` … `第五部分` or `Part One` … `Part Five`). Shown smaller.
   - `page`: everything else.
2. **Page images.** `pdftoppm -r 110 -jpeg`, named `listen_pNN.jpg` / `read_pNN.jpg`.
3. **Layout (PyMuPDF, `scripts/booklet_layout.py`).** For each page:
   - `numbers`: words `n` or `n.` with x0 < 0.2 × page width (question numbers at the left margin).
   - `markers`: words `(一)` … `(五)` at the left margin (reading part 5 passage labels).
4. **Answer keys.** `parseKey` reads `n X` pairs (A–F) from the answer PDFs.
5. **Listening transcripts and audio.** Transcripts from the listening text; audio is matched to
   questions by the archive's file order (`listeningFileIndex`). Speaker markers `男 ` / `女 ` become
   `男：` / `女：`.
6. **Question pages and crops (`applyCrops`).** Hits are taken in reading order. Question n is the
   first `n` hit after question n−1's hit. Crop = from the number line to the next number on the page.
   - Listening 1: the example also has a "1", so take the second hit.
   - Reading 1: the example has two "1" hits (question and its answer row). Take the last "1" before
     the first "2".
7. **Reading part 4 (41–45, cloze) — `addPassageOptions`.** One shared passage per part; the page
   is the one containing `（41）`. Options A–F are read from the text layer (`(A) …` lines). The
   passage text is the text above the first option. All five items get `passage`, `options`,
   `group: 'cloze'`. The crop is fixed at 6%–25% of the page (passage only, options are shown as text).
   **Check this crop for each series.**
8. **Reading part 5 (46–50) — `applyPassageCrops`.** Each passage is above its question under a
   label (一)–(五). Crop = from the label to the next label (or the page bottom if the next label is on
   another page). Item text starts at the label so the passage is included.
9. **Pictures with Chinese (reading 21–30) — `addPictureText`.** The Chinese in these pictures (notices, signs, timetables, flyers) is an image. Each picture is extracted (`booklet_layout.py` with an image directory), OCR'd with tesseract.js `chi_tra` (3× upscale, cached in `.cache/booklet/s{N}/ocr/`), and the word boxes are stored as `item.ocrBoxes` for the **Show OCR** overlay. The text is the checked text in `data/booklet-image-text.json` (key `s{N}:R{n}`) when present, otherwise the OCR lines; it is put before the options. Check `.cache/booklet/s{N}/ocr-review.txt` (low confidence or checked entries) against the pictures and write the corrected text to `data/booklet-image-text.json`. Part two numbers are out of order in the text layer, so they are found by place in the part.
10. **Reading question text.** From the number line to the next question's start (the part 5 label
   for 46–50). Lines are joined with `joinWrapped`: a line that does not end a sentence is joined to
   the previous one, and option lines `(A)`/`（A）` start a new line.
11. **Listening written options (41–50).** `addWrittenChoices` takes `（A）…` lines with Chinese text
    between the number lines and adds them to the transcript (only when the script has no options).
12. **Output.** `public/data/booklet/s{N}.json` with `sections` (`L`, `R`), each with `pages`,
    `pageKinds` and `items`; each item: `n`, `answer`, `page`, `picture`, `crop`, `audio`,
    `transcript` / `text`, `options`, `passage`, `group`.

## Letter sets (what the app shows)

| Items | Letters |
| --- | --- |
| Listening 1–40 | A–C (picture choices) |
| Listening 41–50 | A–D (written options) |
| Reading 1–40 | A–C (sentence/picture choices) |
| Reading 41–45 | A–F (cloze, shared passage) |
| Reading 46–50 | A–D |

The app's `letterSet()` in `public/js/booklet.js` must match this table. Check it when a series differs.

## Frontend behaviour built on this data

- `buildFlow()`: each page once, in order. Blank pages are skipped. A page is hidden when every
  question on it has its own crop. Part pages are shown at about half width.
- Cloze items 41–45 share one block (`clozeHtml`): one passage picture, a Show text button beside it,
  then each question with its options (letter button and text).
- Picture questions (21–30): the picture, then the text (picture text, then options). **Show OCR** toggles
  the OCR word boxes drawn over the picture (`ocrBoxes`, page fractions, positioned inside the crop); clicking
  a box opens the dictionary popup for that word. Overlay positions are checked in data, not yet in the browser.
- Options and transcripts: pinyin (global button) and dictionary popup on Chinese characters.
- Progress is saved per series in `localStorage` (`tocfl-prep:booklet:v1`).

## Translation

`scripts/translate-data.mjs` translates every booklet line that has Chinese: transcript, text and
`passage`. Lines are cached in `.cache/translations.json`. Lines that are not in the cache show as Chinese
in the English view. After each build, run `npm run translate` and check that no lines are missing.

Machine translation is rough. Expect odd word choices (for example 舞會 → "prom"). Passages especially
need a hand check.

## Verification checklist for a new series

Run this after the build:

- [ ] 50 listening and 50 reading items; "0 without a page" in the build output.
- [ ] Every listening item has an `audio` file and a `transcript`.
- [ ] Every item has an `answer` (A–F). Reading 41–45 have an `answer` in A–F.
- [ ] `pageKinds` has one entry per page; the first pages (example) are blank or part pages.
- [ ] Listening 1 and reading 1 `page`/`crop` are the real question (not the example). Open them in the app.
- [ ] Reading 41–45: `passage` is set, 6 `options`, the passage crop shows the passage (not an options block).
- [ ] Reading 46–50: each `crop` starts at its own passage label (一)–(五). Check 46 and 50 in the app.
- [ ] Listening 41–50: 4 options in the app (A–D).
- [ ] Reading 21–30: each picture text is checked (`data/booklet-image-text.json`) and Show OCR boxes sit on the picture.
- [ ] Reading 46–50 text starts with its passage; no next-passage text appears.
- [ ] `npm run translate` leaves no missing booklet lines (script in the translation step).
- [ ] `npm run build:analysis` runs; the new series is listed in `analysis.json` `sources.booklets`.

## Known pitfalls (seen in series 5)

- **Example page numbers.** Every part starts with an example that repeats numbers. Use the rules
  in steps 6 and 7 instead of "first hit".
- **Blank page text.** Some pages have no text layer at all. Use the page image or `pageKinds`, not the text.
- **Pictures hold text.** Reading 21–30 notices, signs, timetables and flyers are images, not text. The
  text layer only has the A–C options. Their Chinese comes from OCR plus a hand check (see step 9).
- **Part two numbers are out of order.** In the text layer, 30 (the flyer) comes before 28 and 29. Finding
  numbers in numeric order runs question 27 into 30's options and leaves 30 empty. Find them by place in the part.
- **Embedded pictures use indexed colour.** `booklet_layout.py` converts them to RGB before saving PNG; otherwise saving fails.
- **Small print in pictures.** OCR of small print and vertical headings (timetable 29) is unreliable. Read the
  low-confidence entries in `ocr-review.txt` against the picture, and keep the checked text in `data/booklet-image-text.json`.
- **Speaker markers.** Booklet uses `男 ` / `女 ` without a colon; the build turns them into `男：`.
- **Wrapped lines.** The PDFs break lines mid-sentence. Join them before translating.
- **Passage above question.** Reading 46–50 passages come before their numbers, so
  "number to next number" crops show the next passage.
- **Layout shift in the app.** Booklet page images are lazy-loaded. Pages use an A4 aspect ratio
  (`aspect-ratio: 595.32 / 841.92`) and `scroll-margin-top` so navigator jumps land on the right question.
- **Stale translations.** A new passage line has no translation until `npm run translate` runs.

## Files involved

- `scripts/build-booklet.mjs` — the build (steps above)
- `scripts/booklet_layout.py` — PyMuPDF numbers and markers
- `scripts/translate-data.mjs` — translation of booklet lines
- `scripts/analyze-words.mjs` — word and grammar analysis
- `data/booklet-image-text.json` — checked text of reading 21–30 pictures (overrides OCR; keyed `s{N}:R{n}`)
- `.cache/booklet/s{N}/img/` (extracted pictures), `.cache/booklet/s{N}/ocr/` (OCR cache), `.cache/booklet/s{N}/ocr-review.txt` (generated, git-ignored)
- `public/js/booklet.js` — booklet page (flow, cloze, letter sets, progress, word frequency)
- `public/js/analysis.js`, `public/js/occurrences.js` — analysis and occurrence pages
- `public/data/booklet/` — generated (git-ignored)
