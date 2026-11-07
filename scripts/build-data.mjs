// Builds public/data from the official TOCFL mock question bank (模擬試題 / 題庫).
//
// Source: https://tocfl.edu.tw/tocfl/index.php/exam/test/page/1?pressBtn=(題庫)
// Only the Basic (band A) and Advanced (band B) entries are fetched.
//
// What the archives contain (observed):
//   *_T.rar                  one single-page PDF per question page (Qxxxxxxx.pdf / Exxxxxxxx.pdf).
//                            The page is an image with no usable text layer. Gap-filling and
//                            paragraph pages hold several numbered items on one page.
//   *_MP3.rar                one MP3 per listening question, same id
//   *_Listening Script.rar   one PDF per listening question with the transcript (image)
//   *_Answer.xlsx            answer key: 檔案名稱 (id, only on the first row of a page) + 答案 (A-D).
//                            Further rows with an empty id are the next items of the same page.
//
// Text is recovered with Traditional Chinese OCR (tesseract.js, chi_tra) at build time, so the
// web app itself is static and works offline. OCR is imperfect (e.g. 雨/兩), so the page image
// stays the reference, and each page keeps word boxes for the hanzi overlay.
//
// Requirements on PATH: `pdftoppm` (poppler; MiKTeX and Poppler both ship it).
//
// Usage:
//   node scripts/build-data.mjs              # full build (slow: downloads and OCR everything)
//   node scripts/build-data.mjs --limit 5    # first 5 pages per archive (testing)
//   node scripts/build-data.mjs --bands A    # only Basic
// Re-running is incremental: downloads, extractions and OCR results are cached in .cache/.

import { createExtractorFromFile } from 'node-unrar-js';
import XLSX from 'xlsx';
import sharp from 'sharp';
import { createWorker, createScheduler } from 'tesseract.js';
import * as py from 'pinyin-pro';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'data');
const MEDIA = path.join(OUT, 'media');
const BASE = 'https://tocfl.edu.tw/tocfl/assets/files/mock_database/';
const CEDICT_URL = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz';
const WORKERS = 4;
const RENDER_DPI = 200;
const CACHE_VERSION = 3;

// Bands and the question types published for each skill (L = listening, R = reading).
const BANDS = {
  A: {
    name: 'Basic',
    skills: {
      L: ['Picture Description', 'Single-round Dialogue', 'Multiple-round Dialogue', 'Dialogue'],
      R: ['Sentence Comprehension', 'Picture Description', 'Gap Filling', 'Paragraph Completion', 'Reading Comprehension'],
    },
  },
  B: {
    name: 'Advanced',
    skills: {
      L: ['Dialogue', 'Monologue'],
      R: ['Gap Filling', 'Reading Comprehension'],
    },
  },
};

// ---------- CLI ----------
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const LIMIT = flag('--limit') ? Number(flag('--limit')) : Infinity;
const BAND_FILTER = (flag('--bands') || 'A,B').split(',').map((s) => s.trim().toUpperCase());

// ---------- helpers ----------
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const CJK_RUN = /[㐀-鿿]/g;
const cjkCount = (s) => (s.match(CJK_RUN) || []).length;

// Download an archive into .cache/dl. Returns the local path, or null if it is not published.
async function download(name, magic) {
  const dest = path.join(CACHE, 'dl', name);
  if (await exists(dest)) return dest;
  const res = await fetch(BASE + encodeURIComponent(name));
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.subarray(0, magic.length).equals(Buffer.from(magic))) return null; // an HTML error page, not an archive
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  console.log(`  downloaded ${name} (${(buf.length / 1e6).toFixed(1)} MB)`);
  return dest;
}

// Extract a RAR into its own directory (one per archive, so ids never collide).
async function extractRar(file) {
  const dir = path.join(CACHE, 'x', path.basename(file, '.rar'));
  if (await exists(path.join(dir, '.done'))) return dir;
  await fs.mkdir(dir, { recursive: true });
  const ex = await createExtractorFromFile({ filepath: file, targetPath: dir });
  // extract() is lazy: files are only written once the iterator is consumed.
  const { files } = ex.extract();
  const extracted = [...files];
  if (!extracted.length) throw new Error(`No files extracted from ${path.basename(file)}`);
  await fs.writeFile(path.join(dir, '.done'), '');
  return dir;
}

// Map question id -> file path for every file with the given extension in an extracted dir.
async function indexById(dir, ext) {
  const map = new Map();
  if (!dir) return map;
  for (const rel of await fs.readdir(dir, { recursive: true })) {
    const m = path.basename(rel).match(/^([A-Z]\d{8})\.(\w+)$/i);
    if (m && m[2].toLowerCase() === ext) map.set(m[1].toUpperCase(), path.join(dir, rel));
  }
  return map;
}

// Answer key -> Map(id -> [answers in item order]).
// The id is only on the first row of a page; the rows below it are its further items.
async function loadAnswers(file) {
  const map = new Map();
  if (!file) return map;
  const wb = XLSX.read(await fs.readFile(file), { type: 'buffer' });
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
    const h = rows.findIndex((r) => r.includes('檔案名稱'));
    if (h < 0) continue;
    const idCol = rows[h].indexOf('檔案名稱');
    const ansCol = rows[h].indexOf('答案');
    let current = null;
    for (const r of rows.slice(h + 1)) {
      const id = String(r[idCol] ?? '').trim().toUpperCase();
      let ans = String(r[ansCol] ?? '').trim().toUpperCase();
      if (/^[1-4]$/.test(ans)) ans = 'ABCD'[Number(ans) - 1];
      if (/^[A-Z]\d{8}$/.test(id)) {
        current = id;
        if (!map.has(id)) map.set(id, []);
      }
      if (current && /^[A-D]$/.test(ans)) map.get(current).push(ans);
    }
  }
  return map;
}

// Drops the spaces tesseract puts between CJK characters and tidies the rest.
function cleanText(t) {
  return t
    .split('\n')
    .map((l) => l
      .replace(/([^\x00-\x7f])\s+(?=[^\x00-\x7f])/g, '$1')
      .replace(/\s+:/g, ':')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n');
}

// OCR noise on picture pages shows up as single characters or symbols. Keep lines with real
// Chinese text, lettered choices and numbered items.
function keepUsefulLines(text) {
  return text
    .split('\n')
    .filter((l) => cjkCount(l) >= 3 || /^[（(]\s*[A-D]/.test(l) || /^\d+[.．]/.test(l))
    .join('\n');
}

// Lettered choices in order of appearance: "（A）她知道今天會下大雨" -> { k: 'A', t: '她知道今天會下大雨' }.
function parseOptions(text) {
  const opts = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^[（(]\s*([A-D])\s*[)）]\s*(.+)$/);
    if (m) opts.push({ k: m[1], t: m[2].trim() });
  }
  return opts;
}

// Splits a page's choices into one group per item: each group starts at an "A".
function splitGroups(opts) {
  const groups = [];
  for (const o of opts) {
    if (o.k === 'A' || groups.length === 0) groups.push([]);
    groups[groups.length - 1].push(o);
  }
  return groups;
}

// A choice list is usable only if it has 2-4 distinct letters.
function usableOptions(opts) {
  const letters = opts.map((o) => o.k);
  return opts.length >= 2 && opts.length <= 4 && new Set(letters).size === letters.length;
}

// ---------- OCR ----------
let scheduler;
async function startOcr() {
  scheduler = createScheduler();
  for (let i = 0; i < WORKERS; i++) {
    scheduler.addWorker(await createWorker('chi_tra', 1, { cachePath: path.join(CACHE, 'tessdata') }));
  }
}
async function stopOcr() { await scheduler.terminate(); }

// Render page 1 of a PDF, trim the white margin, and OCR it.
// Returns { jpeg, width, height, text, words } with word boxes normalized to 0..1.
async function processPdf(pdf, tmpBase) {
  await execFileP('pdftoppm', ['-r', String(RENDER_DPI), '-png', '-singlefile', '-f', '1', '-l', '1', pdf, tmpBase]);
  const png = sharp(tmpBase + '.png');
  let out;
  try {
    out = await png.clone().trim({ threshold: 30 }).jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
  } catch {
    out = await png.clone().jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
  }
  await fs.rm(tmpBase + '.png', { force: true });
  const { data: jpeg, info: { width, height } } = out;
  if (width < 20 || height < 20) return { jpeg, width, height, text: '', words: [] }; // blank page

  const r = await scheduler.addJob('recognize', jpeg, {}, { text: true, blocks: true });
  const words = [];
  for (const b of r.data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) {
    const t = cleanText(w.text);
    if (!t) continue;
    const { x0, y0, x1, y1 } = w.bbox;
    words.push({
      t,
      x: +(x0 / width).toFixed(4),
      y: +(y0 / height).toFixed(4),
      w: +((x1 - x0) / width).toFixed(4),
      h: +((y1 - y0) / height).toFixed(4),
    });
  }
  return { jpeg, width, height, text: cleanText(r.data.text), words };
}

// ---------- per-page record (one page = one PDF, may hold several items) ----------
async function buildPage({ id, band, skill, type, answers, pdfPage, pdfScript, mp3 }) {
  const cacheFile = path.join(CACHE, 'pages', `${id}.json`);
  const sig = JSON.stringify({ v: CACHE_VERSION, band, skill, type, answers, hasPdf: !!pdfPage, hasScript: !!pdfScript, hasMp3: !!mp3 });
  if (await exists(cacheFile)) {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (cached.sig === sig) return cached.page;
  }

  const tmp = path.join(CACHE, 'tmp');
  await fs.mkdir(tmp, { recursive: true });
  await fs.mkdir(MEDIA, { recursive: true });
  const page = { id, image: null, audio: null, width: 0, height: 0, text: '', words: [], script: null, options: [] };

  if (pdfPage) {
    const q = await processPdf(pdfPage, path.join(tmp, id + '-q'));
    await fs.writeFile(path.join(MEDIA, `${id}.jpg`), q.jpeg);
    page.image = `media/${id}.jpg`;
    page.width = q.width;
    page.height = q.height;
    page.text = keepUsefulLines(q.text);
    page.words = q.words;
    page.options = parseOptions(page.text);
  }
  if (pdfScript) {
    const s = await processPdf(pdfScript, path.join(tmp, id + '-s'));
    page.script = s.text;
    if (page.options.length === 0) page.options = parseOptions(s.text);
  }
  if (mp3) {
    await fs.copyFile(mp3, path.join(MEDIA, `${id}.mp3`));
    page.audio = `media/${id}.mp3`;
  }

  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify({ sig, page }));
  return page;
}

// Vertical band (0..1 of page height) of each numbered item on a multi-item page, found from
// the number tokens' word boxes. Returns null unless every number is found in reading order;
// the client then shows the whole page instead of a crop.
function itemBands(words, n) {
  const tops = [];
  let after = 0;
  for (let k = 1; k <= n; k++) {
    const re = new RegExp(`^${k}[.．]?$|^${k}[.．]`);
    const w = words.find((x) => x.y >= after && re.test(x.t));
    if (!w) return null;
    tops.push(w.y);
    after = w.y + 0.001;
  }
  return tops.map((y0, k) => ({
    y0: Math.max(0, +(y0 - 0.004).toFixed(4)),
    y1: +(k + 1 < n ? tops[k + 1] - 0.004 : 1).toFixed(4),
  }));
}

// Turns one page into one question per answered item.
function expandItems(page, meta) {
  const n = page.answers.length;
  const groups = splitGroups(page.options);
  const bands = n > 1 && groups.length === n ? itemBands(page.words || [], n) : null;
  const items = [];
  page.answers.forEach((answer, k) => {
    let options = [];
    let stem = null;
    if (n === 1) {
      options = usableOptions(page.options) ? page.options : [];
    } else if (groups.length === n) {
      // One choice set per numbered item (gap filling).
      options = usableOptions(groups[k]) ? groups[k] : [];
      const line = page.text.split('\n').find((l) => new RegExp(`^${k + 1}[.．]\\s*(.+)$`).test(l));
      stem = line ? line.replace(new RegExp(`^${k + 1}[.．]\\s*`), '') : null;
    } else {
      // One shared choice list for all blanks (paragraph completion); the passage is the stem.
      options = usableOptions(page.options) ? page.options : [];
    }
    items.push({
      id: n === 1 ? meta.id : `${meta.id}-${k + 1}`,
      pageId: meta.id,
      band: meta.band,
      skill: meta.skill,
      type: meta.type,
      answer,
      item: n > 1 ? k + 1 : null,
      count: n,
      stem,
      options,
      crop: bands ? bands[k] : null,
    });
  });
  return items;
}

// ---------- CC-CEDICT subset ----------
async function buildDictionary(corpus) {
  // Every run of up to 8 CJK characters that appears in the bank.
  const used = new Set();
  for (const text of corpus) {
    for (const run of text.match(/[㐀-鿿]+/g) || []) {
      for (let i = 0; i < run.length; i++) {
        for (let n = 1; n <= 8 && i + n <= run.length; n++) used.add(run.slice(i, i + n));
      }
    }
  }
  const cacheFile = path.join(CACHE, 'dl', 'cedict.txt.gz');
  if (!(await exists(cacheFile))) {
    const res = await fetch(CEDICT_URL);
    if (!res.ok) throw new Error(`CC-CEDICT download failed: HTTP ${res.status}`);
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, Buffer.from(await res.arrayBuffer()));
  }
  const text = zlib.gunzipSync(await fs.readFile(cacheFile)).toString('utf8');
  const dict = {};
  const lineRe = /^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+\/(.+)\/\s*$/;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = line.match(lineRe);
    if (!m || !used.has(m[1])) continue;
    (dict[m[1]] ||= []).push({
      p: py.convert(m[3], { toneType: 'symbol' }),
      d: m[4].split('/').filter(Boolean).join('; '),
    });
  }
  for (const k of Object.keys(dict)) dict[k] = dict[k].slice(0, 4);
  return dict;
}

// ---------- main ----------
async function main() {
  const started = Date.now();
  await fs.mkdir(CACHE, { recursive: true });
  await fs.mkdir(MEDIA, { recursive: true });

  const missing = [];
  const jobs = [];

  for (const band of Object.keys(BANDS).filter((b) => BAND_FILTER.includes(b))) {
    for (const skill of ['L', 'R']) {
      for (const type of BANDS[band].skills[skill]) {
        const label = `${band}_${skill}_${type}`;
        console.log(`\n[${label}]`);
        const ansFile = await download(`${label}_Answer.xlsx`, 'PK');
        if (!ansFile) missing.push(`${label}_Answer.xlsx`);
        const answers = await loadAnswers(ansFile);

        const tFile = await download(`${label}_T.rar`, 'Rar!');
        if (!tFile) missing.push(`${label}_T.rar`);
        const pages = await indexById(tFile ? await extractRar(tFile) : null, 'pdf');

        let mp3s = new Map(), scripts = new Map();
        if (skill === 'L') {
          const mFile = await download(`${label}_MP3.rar`, 'Rar!');
          if (!mFile) missing.push(`${label}_MP3.rar`);
          mp3s = await indexById(mFile ? await extractRar(mFile) : null, 'mp3');
          const sFile = await download(`${label}_Listening Script.rar`, 'Rar!');
          if (!sFile) missing.push(`${label}_Listening Script.rar`);
          scripts = await indexById(sFile ? await extractRar(sFile) : null, 'pdf');
        }

        // Pages that have an answer key or any media. Pages without a key are kept, but
        // their items are skipped below.
        const ids = [...new Set([...pages.keys(), ...mp3s.keys(), ...answers.keys()])].sort().slice(0, LIMIT);
        console.log(`  ${ids.length} pages, ${ids.reduce((n, id) => n + (answers.get(id) || []).length, 0)} items with answers`);
        for (const id of ids) {
          jobs.push({
            id, band, skill, type,
            answers: answers.get(id) || [],
            pdfPage: pages.get(id) || null,
            pdfScript: scripts.get(id) || null,
            mp3: mp3s.get(id) || null,
          });
        }
      }
    }
  }

  console.log(`\nOCR and rendering ${jobs.length} pages with ${WORKERS} workers...`);
  await startOcr();
  let done = 0;
  const pageRecords = await mapLimit(jobs, WORKERS, async (job) => {
    const page = await buildPage(job);
    done++;
    if (done % 25 === 0 || done === jobs.length) console.log(`  ${done}/${jobs.length}`);
    return { job, page };
  });
  await stopOcr();

  // Expand pages into questions. Pages with no answer key are skipped.
  const pages = {};
  const questions = [];
  for (const { job, page } of pageRecords) {
    if (job.answers.length === 0) continue;
    const { answers, ...meta } = job;
    pages[page.id] = {
      image: page.image,
      audio: page.audio,
      width: page.width,
      height: page.height,
      text: page.text,
      words: page.words,
      script: page.script,
    };
    questions.push(...expandItems({ ...page, answers }, meta));
  }
  questions.sort((a, b) => a.id.localeCompare(b.id));

  const corpus = [];
  for (const p of Object.values(pages)) corpus.push(p.text, p.script || '');
  for (const q of questions) {
    if (q.stem) corpus.push(q.stem);
    for (const o of q.options) corpus.push(o.t);
  }
  console.log('\nBuilding dictionary subset from CC-CEDICT...');
  const dict = await buildDictionary(corpus);

  const counts = questions.reduce((acc, q) => {
    const key = `${q.band}_${q.skill}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  await fs.writeFile(path.join(OUT, 'questions.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'https://tocfl.edu.tw/tocfl/index.php/exam/test/page/1?pressBtn=(題庫)',
    bands: Object.fromEntries(Object.entries(BANDS).map(([k, v]) => [k, v.name])),
    counts,
    pages,
    questions,
  }));
  await fs.writeFile(path.join(OUT, 'dict.json'), JSON.stringify(dict));

  console.log(`\nDone in ${((Date.now() - started) / 60000).toFixed(1)} min: ${questions.length} questions on ${Object.keys(pages).length} pages, ${Object.keys(dict).length} dictionary headwords.`);
  if (missing.length) console.log(`Not published / not found (skipped):\n  ${missing.join('\n  ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
