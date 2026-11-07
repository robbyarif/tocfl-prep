# TOCFL prep

A static study app for the official TOCFL mock question bank (模擬試題 / 題庫, https://tocfl.edu.tw/tocfl/index.php/exam/test/page/1?pressBtn=(題庫)). It covers the **Basic (A, 入門基礎)** and **Advanced (B, 進階高階)** bands only.

## Features

- **1 · Select difficulty**: pick the band(s), skill (listening / reading) and question types, then work through them.
- **2 · Adjust difficulty**: starts at Basic. Two correct answers in a row move up to Advanced; a wrong answer at Advanced moves back down. Ends with an estimated level.
- **Pinyin** button (top right) adds pinyin above every Chinese character: question text, choices and transcripts.
- **Listening**: play, **Replay**, playback speed, and **Show transcript** (with pinyin when on).
- **Show answer** reveals the key (counted as incorrect).
- **Hanzi overlay** on question pages: the OCR'd characters are laid over the picture. Tap a word for its pinyin and meanings (CC-CEDICT popup). In the popup, ← / → (or Prev / Next) step through the characters of the same text.
- **3 · Reviews**: every session is saved in the browser as you answer (IDs, your choices, results; no images). Open a session to go back over each question. **Export** saves the history to a JSON file and **Import** merges one in. Clearing the site data in the browser deletes the history, so export it to keep a copy.
- **Official pass scores** are shown at the start and end of a session. They are the scaled scores (out of 80) from tocfl.edu.tw's 通過標準 page: A1 42, A2 60, B1 48, B2 64. The scaled score is not a question count, so the app does not convert your results into one. Source: https://tocfl.edu.tw/tocfl/index.php/test/reading/list/6 (the page is for the reading section; the listening standard is not checked).

## Setup

Requirements: Node.js 20+, and `pdftoppm` on PATH (Poppler, or the copy that ships with MiKTeX).

```
npm install
npm run build:data    # downloads, OCRs and writes public/data/ (slow, several GB of downloads)
npm run dev           # http://localhost:8080
```

`npm run build:data:quick` (20 questions per archive) is a faster test build. `node scripts/build-data.mjs --bands A` builds Basic only.

The build is incremental: downloads, extractions and OCR results are cached in `.cache/`.

## How the data is made

- Every question is a single-page PDF with no text layer, so the text is recovered with Traditional Chinese OCR (tesseract.js, `chi_tra`) at build time. The page image stays the reference.
- OCR mistakes happen (e.g. 雨 and 兩 are often confused), and stray marks on picture pages are filtered out. Check against the image when in doubt.
- Gap-filling and paragraph pages hold several numbered items; each item becomes its own question that shares the page.
- Listening choices are often spoken and not printed, so they show as letters A–D when the text can't be read.
- Dictionary: a subset of [CC-CEDICT](https://cc-cedict.org/) (CC BY-SA 4.0), limited to words that occur in the bank.
- `public/data/` and `.cache/` are git-ignored. The question bank is published for non-commercial study use only; do not redistribute it.

## Files

- `scripts/build-data.mjs`: download, extract, OCR and write `public/data/`.
- `scripts/serve.mjs`: static dev server.
- `public/`: the app (`index.html`, `styles.css`, `js/`).

## Userscript: TOCFL listening replay

A Tampermonkey userscript (`tocfl-listening.user.js`) for the 華測會 CATO TOCFL practice test at `https://cbt.sc-top.org.tw/cato/*`.

## Features

- **Replay button**: adds a "重播 Replay" button under the page heading when a question's listening audio is on the page. Clicking it rewinds to the start and plays the clip again.
- **Pause / Resume button**: toggles playback of the question audio. The label changes to match.
- **Drag to seek**: press or drag on the playback progress bar (`#MediaDurationBar`) to jump to that point. Works on question audio and on the briefing video.
- **Transcript button** ("逐字稿 Transcript"): shows a Traditional Chinese transcript of the question audio. If the question is in your built question bank (`npm run build:data`), its listening script is used and Whisper is not run. Otherwise the audio is transcribed by a Whisper model running on your own machine (see below), so the clip is never sent to an outside service. Each clip is transcribed once and cached in `.cache/transcripts/`. The bank's scripts are OCR'd, so they can contain small errors.
- **Prev / next clip** (⏮ ⏭): on a passage with several questions, step between the passage clip and each question clip. The label shows "Passage n/m" or "Question n/m". Replay, Pause and the transcript button act on the clip shown. Switching clips closes the transcript panel. The choice resets when the site moves to the next item. The buttons are hidden when an item has only one clip.
- **Metrics button** (📊): opens a panel with the test state read from the page's hidden fields: answered count, position, item and passage IDs, θ, b, accuracy, and the test's stop rules and time limit. The panel refreshes while it is open. A **Question bank** row shows whether the clip the buttons control is in your built bank (found, not in bank, or server not running). The correct answer is hidden until you press **Show answer** in the panel; it hides again when the next item loads.

### Transcript server

The transcript button needs a local server. Start it from the project folder before opening the test:

```
npm install
npm run transcribe     # listens on http://127.0.0.1:8787
```

The first transcription downloads the Whisper model (`Xenova/whisper-small`, quantized, about 250 MB) into `.cache/models/`. Each 30-second window takes a few seconds on CPU. Clips longer than 30 seconds are split into windows and joined. Set `TRANSCRIBE_PORT` to use another port; the userscript's `TRANSCRIBE_URL` must match. If the server is not running, the panel says so.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in the Chrome profile you use for the test.
2. Open the Tampermonkey dashboard, create a new script, paste in the contents of `tocfl-listening.user.js`, and save (Ctrl+S).
3. In Chrome's extension settings for Tampermonkey, turn on **Allow User Scripts**. Without this the script is saved and enabled but does not run.
4. Reload the CATO test page.

## Known issues

- Drag-to-seek has been checked in code but not with a real drag. The site may have handlers on the bar that interfere.
- The progress bar's fill is driven by the site and may not match the media's position after a drag. The drag may move the audio while the bar stays stale.
- The Replay button is added only when question audio is on the page, so it does not appear on the briefing screen.

## Decisions (not to revisit without a new reason)

- The script does not change the site's reading countdown (`#TimeCountDown`). This is an official test platform, and changing its timing was declined.
- No OCR overlay on the exam page's images. Declined for the same reason.

## Open ideas

- An OCR tool for user-supplied material (screenshots of study sheets, textbook pages) was offered and remains open.
- A separate, user-controlled practice timer that does not touch the site was offered and remains open.

## Files

- `tocfl-listening.user.js`: the userscript.
- `README.md`: this file.
