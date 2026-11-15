// Word and grammar frequency across the whole test set, split into listening and reading.
// Sources: the question bank (public/data/questions.json) and every built booklet series
// (public/data/booklet/index.json). Words: longest dictionary match (public/data/dict.json).
// Grammar: the function words and particles listed in GRAMMAR, counted as they occur.
// Outputs:
//   public/data/analysis.json     the counts and top lists (the analysis page)
//   public/data/occurrences.json  where each listed word or grammar point occurs, with a snippet
//                                 (the occurrences page; loaded only when a word is opened)
//
//   npm run build:analysis

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'public', 'data');
const MAX_WORD = 8;
const TOP_WORDS = 60;
const SNIPPET = 12; // characters of context on each side of an occurrence

// Grammar points and their meaning. Each is counted by its occurrences in the text.
const GRAMMAR = [
  ['了', 'completed action or change'], ['過', 'experience (have done)'], ['著', 'ongoing state'],
  ['正在', 'in progress'], ['已經', 'already'], ['的', 'possessive / noun marker'], ['得', 'degree complement'],
  ['地', 'adverb marker'], ['把', '把 construction (handle something)'], ['被', 'passive (be done to)'],
  ['比', 'comparison (more than)'], ['讓', 'make / let someone do'], ['因為', 'because'], ['所以', 'so, therefore'],
  ['雖然', 'although'], ['但是', 'but'], ['可是', 'but'], ['而且', 'moreover, and also'], ['還是', 'or, still'],
  ['或者', 'or'], ['如果', 'if'], ['就', 'then, just, only'], ['才', 'only then, not until'],
  ['會', 'will, be likely to'], ['能', 'can, be able to'], ['可以', 'may, can'], ['要', 'want to, will'],
  ['應該', 'should'], ['不', 'negation (not)'], ['沒有', 'did not / do not have'], ['很', 'very'], ['最', 'most'],
  ['都', 'all, both'], ['也', 'also, too'], ['還', 'still, more'], ['再', 'again, then'],
  ['嗎', 'yes / no question'], ['呢', 'question particle'], ['吧', 'suggestion particle'], ['啊', 'exclamation particle'],
];
const GRAMMAR_KEYS = new Set(GRAMMAR.map(([k]) => k));
// Speaker labels at the start of a line: "男：" in the booklet, "男 " in the bank scripts.
const SPEAKER = /(^|\n)\s*(男|女)(?:[：:]\s*|\s+)/g;
const CJK_RUN = /[㐀-鿿]+/g;

const dict = JSON.parse(await fs.readFile(path.join(DATA, 'dict.json'), 'utf8'));

// One bucket per skill: word and grammar counts, the occurrences of each, and how many texts were read.
const bucket = () => ({ words: new Map(), grammar: new Map(), occ: new Map(), texts: 0 });
const buckets = { listening: bucket(), reading: bucket() };

// Records one occurrence: where it is (src) and the text around it (the run of Chinese it sits in).
function addOcc(b, key, src, run, i, len) {
  const snip = run.slice(Math.max(0, i - SNIPPET), i + len + SNIPPET);
  const list = b.occ.get(key) || [];
  list.push([src, snip]);
  b.occ.set(key, list);
}

function countText(b, raw, src) {
  if (!raw) return;
  const cleaned = raw.replace(SPEAKER, '$1');
  b.texts++;
  for (const run of cleaned.match(CJK_RUN) || []) {
    // Grammar points: every position in this run where the point occurs.
    for (const [k] of GRAMMAR) {
      let at = run.indexOf(k);
      while (at >= 0) {
        b.grammar.set(k, (b.grammar.get(k) || 0) + 1);
        addOcc(b, k, src, run, at, k.length);
        at = run.indexOf(k, at + k.length);
      }
    }
    // Words: longest dictionary match from left to right.
    let i = 0;
    while (i < run.length) {
      let hit = null;
      for (let n = Math.min(MAX_WORD, run.length - i); n >= 1; n--) {
        const w = run.substr(i, n);
        if (dict[w]) { hit = w; break; }
      }
      if (!hit) { i++; continue; }
      const at = i;
      i += hit.length;
      // Grammar words are counted in the grammar list, not in the word list.
      if (GRAMMAR_KEYS.has(hit)) continue;
      b.words.set(hit, (b.words.get(hit) || 0) + 1);
      addOcc(b, hit, src, run, at, hit.length);
    }
  }
}

// Question bank: the question text and options, and each listening page's script once.
const bank = JSON.parse(await fs.readFile(path.join(DATA, 'questions.json'), 'utf8'));
const seenScripts = new Set();
const bankCount = { listening: 0, reading: 0 };
for (const q of bank.questions) {
  const skill = q.skill === 'L' ? 'listening' : 'reading';
  const b = buckets[skill];
  const src = `bank:${q.id}`;
  bankCount[skill]++;
  countText(b, q.stem, src);
  for (const o of q.options || []) countText(b, o.t, src);
  const page = bank.pages[q.pageId];
  if (skill === 'listening' && page && page.script && !seenScripts.has(q.pageId)) {
    seenScripts.add(q.pageId);
    countText(b, page.script, src);
  }
}

// Booklet series: transcripts (listening), question text, passages and options. A cloze passage
// is shared by its questions, so it is counted once.
let booklets = [];
try {
  const index = JSON.parse(await fs.readFile(path.join(DATA, 'booklet', 'index.json'), 'utf8'));
  booklets = index.series;
} catch { /* no booklet data */ }
const seenPassages = new Set();
for (const s of booklets) {
  const d = JSON.parse(await fs.readFile(path.join(DATA, 'booklet', `s${s}.json`), 'utf8'));
  for (const sec of d.sections) {
    const b = buckets[sec.skill === 'L' ? 'listening' : 'reading'];
    for (const item of sec.items) {
      const src = `s${s}:${sec.skill}${item.n}`;
      countText(b, item.transcript, src);
      countText(b, item.text, src);
      for (const o of item.options || []) countText(b, o.text, src);
      if (item.passage && !seenPassages.has(`${s}:${item.passage}`)) {
        seenPassages.add(`${s}:${item.passage}`);
        countText(b, item.passage, src);
      }
    }
  }
}

// The top words (with pinyin and a short meaning) and the grammar points that occur, most used first.
function summarize(b) {
  const words = [...b.words.entries()].sort((a, c) => c[1] - a[1]).slice(0, TOP_WORDS).map(([w, c]) => {
    const e = dict[w][0];
    return { w, c, p: e.p, g: e.d.split(';')[0].slice(0, 60) };
  });
  const grammar = GRAMMAR.map(([k, note]) => ({ k, note, c: b.grammar.get(k) || 0 }))
    .filter((x) => x.c > 0).sort((a, c) => c.c - a.c);
  return { texts: b.texts, words, grammar };
}

// Occurrences of every listed word and grammar point, per skill.
function occurrencesOf(b, summary) {
  const out = {};
  for (const w of [...summary.words.map((x) => x.w), ...summary.grammar.map((x) => x.k)]) {
    out[w] = b.occ.get(w) || [];
  }
  return out;
}

const summaries = { listening: summarize(buckets.listening), reading: summarize(buckets.reading) };
const out = {
  generatedAt: new Date().toISOString(),
  sources: { questionBank: bankCount, booklets },
  listening: summaries.listening,
  reading: summaries.reading,
};
await fs.writeFile(path.join(DATA, 'analysis.json'), JSON.stringify(out));
await fs.writeFile(path.join(DATA, 'occurrences.json'), JSON.stringify({
  listening: occurrencesOf(buckets.listening, summaries.listening),
  reading: occurrencesOf(buckets.reading, summaries.reading),
}));
console.log(`listening: ${out.listening.texts} texts; reading: ${out.reading.texts} texts`);
console.log('Wrote public/data/analysis.json and public/data/occurrences.json');
