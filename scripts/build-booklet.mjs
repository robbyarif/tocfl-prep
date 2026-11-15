// Builds the booklet test data (full TOCFL mock test booklets, Band A, English version).
//
//   npm run build:booklet            # series 5 (default)
//   npm run build:booklet -- --series 5
//
// Source: https://tocfl.edu.tw/tocfl/index.php/exam/test/page/1?pressBtn=(%E9%A1%8C%E6%9C%AC)
// Per series N: question booklets ls_mockN_test_BandA_en_t.pdf (listening) and
// rd_mockN_test_BandA_en_t.pdf (reading), answer keys, and the listening audio zip
// https://eapi.sc-top.org.tw/video/A{N}/AE.zip (one MP3 per listening question, plus
// direction and title tracks).
//
// Output: public/data/booklet/index.json and public/data/booklet/s{N}.json, with page images
// and audio under public/data/booklet/s{N}/.

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { createExtractorFromFile } from 'node-unrar-js';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'booklet');
const OUT = path.join(ROOT, 'public', 'data', 'booklet');
const MOCK = 'https://tocfl.edu.tw/tocfl/assets/files/mock';
const EAPI = 'https://eapi.sc-top.org.tw/video';
const RENDER_DPI = 110;

const argv = process.argv.slice(2);
const SERIES = Number(argv.includes('--series') ? argv[argv.indexOf('--series') + 1] : 5);

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function download(url, dest) {
  if (await exists(dest)) return dest;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  console.log(`  downloaded ${path.basename(dest)} (${(buf.length / 1e6).toFixed(1)} MB)`);
  return dest;
}

const text = async (pdf, page) => {
  const args = ['-raw', '-enc', 'UTF-8'];
  if (page) args.push('-f', String(page), '-l', String(page));
  const { stdout } = await execFileP('pdftotext', [...args, pdf, '-']);
  return stdout;
};

// Page layout from PyMuPDF (scripts/booklet_layout.py): where each question number sits.
async function layoutOf(pdf, imageDir) {
  const script = path.join(ROOT, 'scripts', 'booklet_layout.py');
  const args = [script, pdf, ...(imageDir ? [imageDir] : [])];
  const { stdout } = await execFileP('python', args, { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout).pages;
}

async function pageCount(pdf) {
  const { stdout } = await execFileP('pdfinfo', [pdf]);
  return Number(/Pages:\s+(\d+)/.exec(stdout)[1]);
}

// Answers: "1 A 2 B ..." pairs in the answer-key text. Returns { n: letter }.
function parseKey(raw) {
  const out = {};
  for (const m of (raw || '').matchAll(/(?:^|\s)(\d{1,2}) ([A-F])(?=\s|$)/gm)) out[Number(m[1])] = m[2];
  return out;
}

// Pages of each part, from the part headings ("第二部分"). Returns { part number: [page numbers] }.
const CN = ['', '一', '二', '三', '四', '五'];
async function partPages(pdf, count, parts) {
  const start = {};
  for (let p = 1; p <= count; p++) {
    const t = await text(pdf, p);
    for (const k of parts) if (!(k in start) && t.includes(`第${CN[k]}部分`)) start[k] = p;
  }
  const out = {};
  const keys = parts.filter((k) => k in start).sort((a, b) => a - b);
  keys.forEach((k, i) => {
    const end = i + 1 < keys.length ? start[keys[i + 1]] - 1 : count;
    out[k] = Array.from({ length: end - start[k] + 1 }, (_, j) => start[k] + j);
  });
  return out;
}

// Reading part of each question number (see the booklet's part layout).
const READ_PART = (n) => (n <= 15 ? 1 : n <= 30 ? 2 : n <= 40 ? 3 : n <= 45 ? 4 : 5);
const LISTEN_PART = (n) => (n <= 10 ? 1 : null); // only part 1 has pictures in the booklet

// Minimal zip reader for the audio archive (deflate and stored entries).
function unzipEntries(buf) {
  const entries = [];
  const sig = Buffer.from([0x50, 0x4b, 3, 4]);
  let i = 0;
  while ((i = buf.indexOf(sig, i)) >= 0) {
    const method = buf.readUInt16LE(i + 8);
    const csize = buf.readUInt32LE(i + 18);
    const nlen = buf.readUInt16LE(i + 26);
    const elen = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nlen);
    const start = i + 30 + nlen + elen;
    const data = buf.subarray(start, start + csize);
    entries.push({ name, data: method === 8 ? zlib.inflateRawSync(data) : data });
    i = start + csize;
  }
  return entries;
}

// Listening transcript per question. The script lists "1. 提問 …" then the choices; a number is
// accepted only when it is the next expected one, so choice lines and examples are not mistaken for items.
function parseTranscripts(raw) {
  const out = {};
  let want = 1;
  let cur = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    const m = t.match(/^(\d{1,2})\.\s*(.*)$/);
    // Speaker markers in dialogues are "男 " / "女 " in the PDF; show them as "男：" / "女：".
    const speaker = (s) => s.replace(/^(男|女)\s+/, '$1：');
    if (m && Number(m[1]) === want) {
      cur = want;
      out[cur] = [speaker(m[2])];
      want++;
    } else if (cur && t && !/^第.*部分/.test(t)) {
      out[cur].push(speaker(t));
    }
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n').trim();
  return out;
}

// Sets each question's page and crop from the number positions. Hits are taken in reading order:
// question n is the first hit after question n-1's hit. The booklet's example comes before question 1
// and can contain two "1" hits (the example question and its answer row), so question 1 is the last
// "1" before question 2's hit.
async function applyCrops(items, layout) {
  const allHits = [];
  layout.forEach((pg, pi) => pg.numbers.forEach((d) => allHits.push({ n: d.n, pi, hit: d, pg })));
  let cursorIdx = -1;
  for (const item of [...items].sort((a, b) => a.n - b.n)) {
    const matches = allHits.map((h, i) => ({ h, i })).filter(({ h, i }) => h.n === item.n && i > cursorIdx);
    let pick = matches[0];
    if (item.n === 1) {
      const two = allHits.findIndex((h, i) => h.n === 2 && i > cursorIdx);
      const before = matches.filter(({ i }) => two < 0 || i < two);
      pick = before.length ? before[before.length - 1] : matches[0];
    }
    if (!pick) continue;
    cursorIdx = pick.i;
    const { pi, hit, pg } = pick.h;
    const next = pg.numbers.find((d) => d.y > hit.y + 1);
    const bottom = next ? next.y - 2 : pg.h - 6;
    item.page = pi;
    item.picture = pi;
    item.crop = { y0: +(Math.max(0, hit.y - 4) / pg.h).toFixed(4), y1: +(bottom / pg.h).toFixed(4) };
  }
}

// Reading 41-45: one shared passage with five blanks, and six options (A-F) under it, on the page
// that has the blank "（41）". The passage is shown as a picture (the top of the page, above the
// options); the options are read from the text layer so they can be shown as text under the passage.
// The crop is for the booklet's layout (the passage text ends about a quarter of the way down).
async function addPassageOptions(items, pdf, count) {
  let page = 0;
  for (let p = 1; p <= count && !page; p++) if ((await text(pdf, p)).includes('（41）')) page = p;
  if (!page) return;
  const lines = (await text(pdf, page)).split('\n').map((l) => l.trim());
  const options = lines.map((l) => /^\(([A-F])\)\s*(\S.*)$/.exec(l))
    .filter(Boolean).map((m) => ({ letter: m[1], text: m[2].trim() })).slice(0, 6);
  if (options.length < 6) return;
  // The passage is the text above the first option line.
  const firstOption = lines.findIndex((l) => /^\(A\)\s*\S/.test(l));
  const passage = joinWrapped(lines.slice(0, firstOption).filter(Boolean));
  const crop = { y0: 0.06, y1: 0.25 };
  for (const item of items.filter((x) => x.n >= 41 && x.n <= 45)) {
    item.page = page - 1;
    item.picture = page - 1;
    item.crop = crop;
    item.options = options;
    item.passage = passage;
    item.group = 'cloze'; // shown as one block: one passage picture, then the questions
  }
}

// Joins lines the PDF wrapped in the middle of a sentence, so a sentence is one line (translation works
// on whole sentences). A line that ends a sentence, or starts an option "(A)" / "（A）", begins a new one.
function joinWrapped(lines) {
  const out = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    const endsSentence = prev === undefined || /[。！？!?」』”"）)：:]$/.test(prev);
    const startsOption = /^[（(][A-F][）)]/.test(l);
    if (endsSentence || startsOption) out.push(l);
    else out[out.length - 1] = prev + l;
  }
  return out.join('\n');
}

// Reading part 5 (46-50): each passage is labelled (一)-(五) above its question. The crop of a question
// runs from its passage label down to the next label (or the bottom of the page when the next label is
// on another page).
function applyPassageCrops(items, layout) {
  const CN = ['', '一', '二', '三', '四', '五'];
  const marks = [];
  layout.forEach((pg, pi) => (pg.markers || []).forEach((m) => marks.push({ ...m, pi, pg })));
  let cursor = -1;
  for (const item of [...items].filter((x) => x.n >= 46 && x.n <= 50).sort((a, b) => a.n - b.n)) {
    const want = CN[item.n - 45];
    const idx = marks.findIndex((m, i) => m.k === want && i > cursor);
    if (idx < 0) continue;
    cursor = idx;
    const { pi, y, pg } = marks[idx];
    const next = marks[idx + 1];
    const bottom = next && next.pi === pi ? next.y - 2 : pg.h - 6;
    item.page = pi;
    item.picture = pi;
    item.crop = { y0: +(Math.max(0, y - 4) / pg.h).toFixed(4), y1: +(bottom / pg.h).toFixed(4) };
  }
}

// Written choices of listening questions (41-50 have them in the booklet, not in the script).
// Each question's choice lines are the （A）… lines between its number line and the next one.
// Added to the transcript only when the script does not already list the choices.
function addWrittenChoices(items, raw) {
  const lines = raw.split('\n').map((l) => l.trim());
  const starts = {};
  let cursor = -1;
  for (const n of [...items].map((x) => x.n).sort((a, b) => a - b)) {
    const hits = [];
    lines.forEach((l, i) => { if (i > cursor && new RegExp(`^${n}[.．]`).test(l)) hits.push(i); });
    const at = n === 1 && hits.length > 1 ? hits[1] : hits[0];
    if (at !== undefined) { starts[n] = at; cursor = at; }
  }
  const sorted = Object.entries(starts).map(([n, i]) => [Number(n), i]).sort((a, b) => a[1] - b[1]);
  // A written choice has Chinese text after its letter; "(A) (B) (C)" placeholders do not.
  const choiceRe = /^[（(][A-F][）)]\s*[㐀-鿿]/;
  sorted.forEach(([n, i], k) => {
    const end = k + 1 < sorted.length ? sorted[k + 1][1] : lines.length;
    const choices = lines.slice(i + 1, end).filter((l) => choiceRe.test(l));
    const item = items.find((x) => x.n === n);
    if (!item || !choices.length) return;
    if (item.transcript && /(^|\n)[（(][A-F][）)]/.test(item.transcript)) return; // already listed
    item.transcript = [item.transcript, choices.join('\n')].filter(Boolean).join('\n');
  });
}

// Booklet page of each question: the last page that starts a line with "n." (the example at the
// start of the booklet also uses a number, so the last occurrence is the real question).
async function questionPages(pdf, count, want) {
  const pages = {};
  for (let p = 1; p <= count; p++) {
    const lines = (await text(pdf, p)).split('\n');
    for (const n of want) {
      if (lines.some((l) => new RegExp(`^${n}[.．]\\s`).test(l.trim()))) pages[n] = p;
    }
  }
  return pages;
}

// The audio file for each listening question. Files: 001 title, 002 directions,
// then questions with the directions tracks inserted before parts 2, 3 and 4.
function listeningFileIndex(n) {
  if (n <= 10) return n + 2;
  if (n <= 28) return n + 3;
  if (n <= 40) return n + 4;
  return n + 5;
}

// Kind of each page, from its text layer: 'blank' (no text at all: skipped in the booklet view),
// 'part' (a part heading such as "第一部分" or "Part One": shown smaller), or 'page'.
async function pageKinds(pdf, count) {
  const kinds = [];
  for (let p = 1; p <= count; p++) {
    const t = (await text(pdf, p)).trim();
    if (!t) kinds.push('blank');
    else if (/第[一二三四五]部分|^Part (One|Two|Three|Four|Five)\b/m.test(t)) kinds.push('part');
    else kinds.push('page');
  }
  return kinds;
}

async function renderPages(pdf, outDir, prefix, count) {
  await fs.mkdir(outDir, { recursive: true });
  const names = [];
  for (let p = 1; p <= count; p++) {
    const base = path.join(outDir, `${prefix}_p${String(p).padStart(2, '0')}`);
    await execFileP('pdftoppm', ['-r', String(RENDER_DPI), '-jpeg', '-jpegopt', 'quality=82', '-singlefile', '-f', String(p), '-l', String(p), pdf, base]);
    names.push(path.relative(OUT, base + '.jpg').split(path.sep).join('/'));
  }
  return names;
}

// ---------- Pictures with Chinese text (reading 21-30) ----------
// The Chinese in these pictures (notices, signs, timetables, flyers) is an image, not text. Each picture is
// read with OCR (chi_tra). Word boxes are stored on the question (item.ocrBoxes, as fractions of the page)
// so the booklet can draw them over the picture. The text is the OCR lines, or the checked text in
// data/booklet-image-text.json (keyed "s5:R21") when there is one.
const PICTURE_TEXT_FILE = path.join(ROOT, 'data', 'booklet-image-text.json');
const ANSWER_FIXES_FILE = path.join(ROOT, 'data', 'booklet-answer-fixes.json');
const CJK_SPACE = /([^\x00-\x7f])\s+(?=[^\x00-\x7f])/g;
const tidy = (t) => t.replace(CJK_SPACE, '$1').replace(/\s+/g, ' ').trim();

// The picture of a question: the largest embedded image whose middle lies inside the question's crop.
function pictureOf(layout, item) {
  const pg = layout[item.page];
  if (!pg || !item.crop) return null;
  const top = item.crop.y0 * pg.h;
  const bottom = item.crop.y1 * pg.h;
  const inside = (pg.images || []).filter((im) => {
    const mid = (im.y0 + im.y1) / 2;
    return im.file && mid >= top && mid <= bottom;
  });
  inside.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  return inside[0] ?? null;
}

// OCR of one picture (cached). Returns { lines, words, confidence }; word boxes are fractions of the picture.
async function ocrPicture(worker, dir, file, cacheDir) {
  const cacheFile = path.join(cacheDir, 'ocr', `${file}.json`);
  if (await exists(cacheFile)) return JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  const src = path.join(dir, file);
  const meta = await sharp(src).metadata();
  // Upscaled 3x: small print is read much better.
  const W = meta.width * 3;
  const H = meta.height * 3;
  const buf = await sharp(src)
    .flatten({ background: '#ffffff' }).greyscale()
    .resize({ width: W, height: H, kernel: 'lanczos3' }).normalise().png().toBuffer();
  const r = await worker.recognize(buf, {}, { text: true, blocks: true });
  const words = [];
  for (const b of r.data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) {
    const t = tidy(w.text);
    if (!t) continue;
    const { x0, y0, x1, y1 } = w.bbox;
    words.push({
      t, c: Math.round(w.confidence),
      x0: +(x0 / W).toFixed(4), y0: +(y0 / H).toFixed(4), x1: +(x1 / W).toFixed(4), y1: +(y1 / H).toFixed(4),
    });
  }
  const result = { lines: r.data.text.split('\n').map(tidy).filter(Boolean), words, confidence: r.data.confidence };
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(result));
  return result;
}

// Word boxes from picture fractions to page fractions (the booklet draws them on the page crop).
function toPageBoxes(words, im, pg) {
  const w = im.x1 - im.x0;
  const h = im.y1 - im.y0;
  return words.map((k) => ({
    t: k.t, c: k.c,
    x0: +((im.x0 + k.x0 * w) / pg.w).toFixed(4), y0: +((im.y0 + k.y0 * h) / pg.h).toFixed(4),
    x1: +((im.x0 + k.x1 * w) / pg.w).toFixed(4), y1: +((im.y0 + k.y1 * h) / pg.h).toFixed(4),
  }));
}

// Reads the pictures of the questions in `items` (reading 21-30) and puts their text before the options.
// Low-confidence and checked pictures are listed in ocr-review.txt for the check.
async function addPictureText(items, layout, dir, cacheDir, series) {
  const todo = items.filter((x) => x.n >= 21 && x.n <= 30);
  if (!todo.length) return;
  const overrides = (await exists(PICTURE_TEXT_FILE)) ? JSON.parse(await fs.readFile(PICTURE_TEXT_FILE, 'utf8')) : {};
  const worker = await createWorker('chi_tra', 1, { cachePath: path.join(cacheDir, 'tessdata') });
  await worker.setParameters({ tessedit_pageseg_mode: '6' });
  const review = [];
  try {
    for (const item of todo) {
      const im = pictureOf(layout, item);
      if (!im) continue;
      const key = `s${series}:R${item.n}`;
      const ocr = await ocrPicture(worker, dir, im.file, cacheDir);
      const checked = overrides[key];
      const text = checked ?? ocr.lines.join('\n');
      item.pictureText = text;
      item.ocrBoxes = toPageBoxes(ocr.words, im, layout[item.page]);
      if (checked || ocr.confidence < 75) {
        review.push(`${key} (${im.file}) confidence ${Math.round(ocr.confidence)}${checked ? ' [checked]' : ''}\n${ocr.lines.join('\n')}`);
      }
      item.text = [text, item.text].filter(Boolean).join('\n');
    }
  } finally {
    await worker.terminate();
  }
  await fs.writeFile(path.join(cacheDir, 'ocr-review.txt'), review.join('\n\n'));
}

// Series 2-3 name their tracks "{part}-{NN}.mp3" (NN = question number); the zips of series 4-5 use
// "001.mp3" … by listeningFileIndex. This maps the first form to the second, so one lookup serves both.
function toZipName(name) {
  const m = /^\d-(\d{2})\.mp3$/i.exec(name);
  return m ? `${String(listeningFileIndex(Number(m[1]))).padStart(3, '0')}.mp3` : name;
}

// Audio files of the series by file name (001.mp3 …). The zip from the online-audio host is used when it
// exists (series 4 and 5); otherwise the Band A mp3 archive from the booklet site (series 2 and 3,
// mock{N}_BandA_mp3_en.rar), extracted with node-unrar-js (extract() is lazy: consume it before reading).
async function audioFiles(cacheDir) {
  const zipUrl = `${EAPI}/A${SERIES}/AE.zip`;
  const zipPath = path.join(cacheDir, 'AE.zip');
  let hasZip = await exists(zipPath);
  if (!hasZip) {
    try { hasZip = (await fetch(zipUrl, { method: 'HEAD' })).ok; } catch { hasZip = false; }
  }
  if (hasZip) {
    const zip = await download(zipUrl, zipPath);
    return new Map(unzipEntries(await fs.readFile(zip)).map((e) => [path.basename(e.name), e.data]));
  }
  const archive = await download(`${MOCK}/mock${SERIES}_BandA_mp3_en.rar`, path.join(cacheDir, 'mock_mp3_en.rar'));
  const head = await fs.readFile(archive);
  // The booklet site's archive is named .rar but can be a zip (starts with "PK"); a real rar is read by node-unrar-js.
  if (head.subarray(0, 2).toString() === 'PK') {
    return new Map(unzipEntries(head).filter((e) => /\.mp3$/i.test(e.name)).map((e) => [toZipName(path.basename(e.name)), e.data]));
  }
  const dir = path.join(cacheDir, 'mp3');
  await fs.mkdir(dir, { recursive: true });
  const ex = await createExtractorFromFile({ filepath: archive, targetPath: dir });
  [...ex.extract().files];
  const byName = new Map();
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.toLowerCase().endsWith('.mp3')) byName.set(toZipName(e.name), await fs.readFile(p));
    }
  };
  await walk(dir);
  return byName;
}

async function main() {
  const s = `s${SERIES}`;
  const cacheDir = path.join(CACHE, s);
  const outDir = path.join(OUT, s);
  console.log(`Series ${SERIES}: downloading`);

  const lsPdf = await download(`${MOCK}/ls_mock${SERIES}_test_BandA_en_t.pdf`, path.join(cacheDir, 'ls.pdf'));
  const rdPdf = await download(`${MOCK}/rd_mock${SERIES}_test_BandA_en_t.pdf`, path.join(cacheDir, 'rd.pdf'));
  const lsAns = await download(`${MOCK}/ls_mock${SERIES}_test_BandA_answer.pdf`, path.join(cacheDir, 'ls_answer.pdf'));
  const rdAns = await download(`${MOCK}/rd_mock${SERIES}_test_BandA_answer.pdf`, path.join(cacheDir, 'rd_answer.pdf'));
  const lsScript = await download(`${MOCK}/ls_mock${SERIES}_test_BandA_listen.pdf`, path.join(cacheDir, 'ls_listen.pdf'));

  // Answers the text layer loses (a digit missing in the PDF text, checked on the page): data/booklet-answer-fixes.json.
  const fixes = (await exists(ANSWER_FIXES_FILE)) ? JSON.parse(await fs.readFile(ANSWER_FIXES_FILE, 'utf8')) : {};
  const listenKeys = { ...parseKey(await text(lsAns)), ...(fixes[`s${SERIES}`]?.listening || {}) };
  const readKeys = { ...parseKey(await text(rdAns)), ...(fixes[`s${SERIES}`]?.reading || {}) };
  console.log(`  answer keys: ${Object.keys(listenKeys).length} listening, ${Object.keys(readKeys).length} reading`);

  // Audio: extract the question tracks.
  const audioDir = path.join(outDir, 'audio');
  await fs.mkdir(audioDir, { recursive: true });
  const byName = await audioFiles(cacheDir);

  // Pages.
  const lsCount = await pageCount(lsPdf);
  const rdCount = await pageCount(rdPdf);
  const listenNums = Object.keys(listenKeys).map(Number);
  const readNums = Object.keys(readKeys).map(Number);
  const listenPages = await questionPages(lsPdf, lsCount, listenNums);
  const readPages = await questionPages(rdPdf, rdCount, readNums);
  const lsImages = await renderPages(lsPdf, outDir, 'listen', lsCount);
  const rdImages = await renderPages(rdPdf, outDir, 'read', rdCount);
  const lsKinds = await pageKinds(lsPdf, lsCount);
  const rdKinds = await pageKinds(rdPdf, rdCount);

  for (const n of listenNums) {
    const file = `${String(listeningFileIndex(n)).padStart(3, '0')}.mp3`;
    if (byName.has(file)) await fs.writeFile(path.join(audioDir, file), byName.get(file));
  }
  // Each item is placed after one booklet page (index into the section's page list):
  //  - its own page when its number is printed on a page;
  //  - otherwise the first page of its part (part 2 pictures and the part 4 paragraph have no numbers);
  //  - listening items without pictures go after the last listening page (they are audio only).
  const lsParts = await partPages(lsPdf, lsCount, [1, 2, 3, 4]);
  const rdParts = await partPages(rdPdf, rdCount, [1, 2, 3, 4, 5]);
  const placeOf = (n, own, parts, partOf, count) => {
    if (own) return own - 1;
    const part = partOf(n);
    if (part && parts[part]) return parts[part][0] - 1;
    return count - 1;
  };
  const transcripts = parseTranscripts(await text(lsScript));
  const listening = listenNums.sort((a, b) => a - b).map((n) => {
    const file = `${String(listeningFileIndex(n)).padStart(3, '0')}.mp3`;
    const page = placeOf(n, listenPages[n], lsParts, LISTEN_PART, lsCount);
    return {
      n,
      answer: listenKeys[n],
      page,
      // Part 1 questions have a picture on their page; the audio-only questions have none.
      picture: LISTEN_PART(n) ? page : null,
      audio: byName.has(file) ? `${s}/audio/${file}` : null,
      transcript: transcripts[n] || null,
    };
  });
  const reading = readNums.sort((a, b) => a - b).map((n) => ({
    n,
    answer: readKeys[n],
    page: placeOf(n, readPages[n], rdParts, READ_PART, rdCount),
    picture: placeOf(n, readPages[n], rdParts, READ_PART, rdCount),
  }));

  // Reading question text from the booklet's text layer: each question runs from its last "n."
  // line to the next question's last "n." line (the example at the start also uses a number).
  const rdLines = (await text(rdPdf)).split('\n').map((l) => l.trim());
  // First "n." line after the previous question's start (passages can contain numbered lines too).
  // Question 1 also appears in the example, so its second occurrence is the real one.
  const findLine = (n, after) => {
    const hits = [];
    rdLines.forEach((l, i) => { if (i > after && new RegExp(`^${n}[.．]`).test(l)) hits.push(i); });
    return n === 1 && hits.length > 1 ? hits[1] : (hits[0] ?? -1);
  };
  const starts = {};
  let cursor = -1;
  const partTwo = rdLines.findIndex((l) => /^第二部分/.test(l));
  for (const n of [...readNums].sort((a, b) => a - b)) {
    // Part two's numbers are out of order in the text layer (the 30 flyer comes before 28), so these are
    // found by their place in the part rather than by the running cursor.
    if (n >= 21 && n <= 30 && partTwo >= 0) {
      const at = findLine(n, partTwo);
      if (at >= 0) { starts[n] = at; cursor = Math.max(cursor, at); }
      continue;
    }
    const at = findLine(n, cursor);
    if (at >= 0) { starts[n] = at; cursor = at; }
  }
  // Reading part 5 (46-50): the passage comes before its question, under a label (一)-(五). The
  // question's text starts at that label, so the passage is included.
  const passageLabel = (n) => ['', '一', '二', '三', '四', '五'][n - 45];
  const beginOf = (n, i) => {
    if (n < 46 || n > 50) return i;
    for (let j = i; j >= 0; j--) if (rdLines[j] === `(${passageLabel(n)})`) return j;
    return i;
  };
  const startsSorted = Object.entries(starts).map(([n, i]) => [Number(n), beginOf(Number(n), i)]).sort((a, b) => a[1] - b[1]);
  // Stop at the next part's heading or directions (English or Chinese), which follow the last question.
  const boundary = /^(Part |Directions|說明|例題|你會看到|第.*部分)/;
  startsSorted.forEach(([n, i], k) => {
    const end = k + 1 < startsSorted.length ? startsSorted[k + 1][1] : rdLines.length;
    const lines = [];
    for (const raw of rdLines.slice(i, end)) {
      const l = raw.replace(/^\d+[.．]\s*/, '').trim();
      if (!l || /^\([一二三四五六七八九十]+\)$/.test(l)) continue;
      if (lines.length && boundary.test(l)) break;
      lines.push(l);
    }
    const item = reading.find((x) => x.n === n);
    if (item && lines.length) item.text = joinWrapped(lines);
  });

  // Crop each question from its number down to the next number on the page (both booklets).
  await applyCrops(listening, await layoutOf(lsPdf));
  const imgDir = path.join(cacheDir, 'img');
  const rdLayout = await layoutOf(rdPdf, imgDir);
  await applyCrops(reading, rdLayout);
  applyPassageCrops(reading, rdLayout);
  await addPassageOptions(reading, rdPdf, rdCount);
  await addPictureText(reading, rdLayout, imgDir, cacheDir, SERIES);

  addWrittenChoices(listening, await text(lsPdf));

  await fs.mkdir(OUT, { recursive: true });
  const data = { series: SERIES, title: `模擬試題第${SERIES}輯 Band A (入門基礎級)`, lang: 'English (中英)', sections: [
    { skill: 'L', title: 'Listening', pages: lsImages, pageKinds: lsKinds, items: listening },
    { skill: 'R', title: 'Reading', pages: rdImages, pageKinds: rdKinds, items: reading },
  ] };
  await fs.writeFile(path.join(OUT, `${s}.json`), JSON.stringify(data, null, 1));

  // Index of the series that are built.
  const indexFile = path.join(OUT, 'index.json');
  const index = (await exists(indexFile)) ? JSON.parse(await fs.readFile(indexFile, 'utf8')) : { series: [] };
  index.series = [...new Set([...index.series, SERIES])].sort((a, b) => a - b);
  await fs.writeFile(indexFile, JSON.stringify(index, null, 1));

  const missing = [...listening, ...reading].filter((x) => x.page == null).length;
  console.log(`Done: ${listening.length} listening (${listening.filter((x) => x.audio).length} with audio), ${reading.length} reading; ${missing} without a page.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
