// Sentence-level English translations for the web app, generated once from public/data.
//
//   npm run translate            # all lines (slow, first run downloads the model)
//   npm run translate -- --limit 50   # quick test
//
// Model: Xenova/opus-mt-zh-en (Helsinki-NLP OPUS-MT), run locally with @huggingface/transformers.
// It is a Simplified-Chinese model, so each line is converted to Simplified first; the
// output is keyed by the original Traditional line, which is what the app looks up.
// Results are cached in .cache/translations.json, so re-runs only translate new lines.
// Machine translation: the app labels it as such.

import { pipeline, env } from '@huggingface/transformers';
import * as OpenCC from 'opencc-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const DATA = path.join(ROOT, 'public', 'data');
const CACHE_FILE = path.join(CACHE, 'translations.json');
const MODEL = 'Xenova/opus-mt-zh-en';

const argv = process.argv.slice(2);
const LIMIT = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : Infinity;

env.cacheDir = path.join(CACHE, 'models');
const toSimp = OpenCC.Converter({ from: 'tw', to: 'cn' });
const HAS_CJK = /[㐀-鿿]/;

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

// Every line the app can display: page text, transcripts, choices and stems.
function collectLines(data) {
  const lines = new Set();
  const add = (text) => {
    for (const l of (text || '').split('\n')) {
      const t = l.trim();
      // Skip OCR fragments: a real line has several Chinese characters.
      if (t && (t.match(/[㐀-鿿]/g) || []).length >= 3) lines.add(t);
    }
  };
  // Picture questions show their text in the scan, not as OCR text, so their page text is skipped.
  const picturePages = new Set(data.questions.filter((q) => q.type === 'Picture Description').map((q) => q.pageId));
  for (const [id, page] of Object.entries(data.pages)) {
    if (!picturePages.has(id)) add(page.text);
    add(page.script);
  }
  for (const q of data.questions) {
    add(q.stem);
    for (const o of q.options || []) add(o.t);
  }
  return [...lines].sort();
}

async function main() {
  await fs.mkdir(CACHE, { recursive: true });
  const data = JSON.parse(await fs.readFile(path.join(DATA, 'questions.json'), 'utf8'));
  const cache = (await exists(CACHE_FILE)) ? JSON.parse(await fs.readFile(CACHE_FILE, 'utf8')) : {};

  const all = collectLines(data);
  const todo = all.filter((l) => !(l in cache)).slice(0, LIMIT);
  const cached = all.filter((l) => l in cache).length;
  console.log(`${all.length} lines to show; ${cached} already translated; ${todo.length} to translate now`);
  if (!todo.length) {
    console.log('Nothing new to translate.');
  } else {
    console.log('Loading model (first run downloads it)...');
    const mt = await pipeline('translation', MODEL, { dtype: 'q8' });
    let done = 0;
    for (const line of todo) {
      const out = await mt(toSimp(line), { max_new_tokens: 200 });
      cache[line] = out[0].translation_text.trim();
      done++;
      if (done % 100 === 0 || done === todo.length) {
        await fs.writeFile(CACHE_FILE, JSON.stringify(cache));
        console.log(`  ${done}/${todo.length}`);
      }
    }
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache));
  }

  // Only lines present in the current data go into the app file.
  const out = {};
  for (const l of all) if (cache[l]) out[l] = cache[l];
  await fs.writeFile(path.join(DATA, 'translations.json'), JSON.stringify({
    model: MODEL,
    note: 'Machine translation (opus-mt-zh-en). Check against the image or audio.',
    lines: out,
  }));
  console.log(`Wrote ${Object.keys(out).length} translated lines to public/data/translations.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
