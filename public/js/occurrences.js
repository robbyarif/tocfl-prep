// Where one word or grammar point occurs in the test set: each occurrence with its source and a snippet.
// Reads public/data/occurrences.json (scripts/analyze-words.mjs), loaded only when a word is opened.
import { escapeHtml, loadPinyin, zhHtml } from './pinyin.js';
import { getPinyinPref } from './store.js';

const app = () => document.getElementById('app');
const SHOW_FIRST = 200;
let cache = null;
let view = null; // { skill, word, list, shown } for the page on screen

async function load() {
  if (cache) return cache;
  const res = await fetch('data/occurrences.json');
  if (!res.ok) throw new Error(`occurrences: HTTP ${res.status}`);
  cache = await res.json();
  return cache;
}

// "bank:E00147800" -> question bank question; "s5:L12" -> booklet series 5, listening question 12.
function sourceLabel(src) {
  if (src.startsWith('bank:')) return `Question bank · ${src.slice(5)}`;
  const m = /^s(\d+):([LR])(\d+)$/.exec(src);
  if (!m) return src;
  return `第${m[1]}輯 · ${m[2] === 'L' ? 'Listening' : 'Reading'} ${m[3]}`;
}

// The snippet with pinyin (when on) and the word highlighted.
function highlight(snippet, word, on) {
  return snippet.split(word).map((part) => zhHtml(part, on)).join(`<mark>${zhHtml(word, on)}</mark>`);
}

function rows(list, word, from, to, on) {
  return list.slice(from, to).map(([src, snip]) => `
      <li><span class="occ-src">${escapeHtml(sourceLabel(src))}</span><span class="occ-text zh">${highlight(snip, word, on)}</span></li>`).join('');
}

// Draws the list of occurrences shown so far, with pinyin on or off as the preference says.
function paint() {
  const { skill, word, list, shown } = view;
  const on = getPinyinPref();
  const label = skill === 'listening' ? 'Listening' : 'Reading';
  app().innerHTML = `
    <h1><span class="zh">${zhHtml(word, on)}</span> · ${label}</h1>
    <p class="muted">${list.length.toLocaleString()} occurrences in the ${label.toLowerCase()} tests. Each line is the Chinese around the occurrence, with its source.</p>
    <ol class="occ-list" id="occ-list">${rows(list, word, 0, shown, on)}</ol>
    ${list.length > shown ? `<button class="btn" type="button" id="occ-more">Show all ${list.length.toLocaleString()}</button>` : ''}
    <div class="row" style="margin-top:16px"><a class="btn" href="#/analysis">Back to analysis</a></div>`;
  document.getElementById('occ-more')?.addEventListener('click', () => {
    view.shown = list.length;
    paint();
  });
}

// Called by the global pinyin button, so the page follows the preference.
export function refreshOccurrences() {
  if (view && app().querySelector('.occ-list')) paint();
}

export async function occurrencesPage(skill, word) {
  const label = skill === 'listening' ? 'Listening' : 'Reading';
  app().innerHTML = `<h1>${escapeHtml(word)} · ${label}</h1><p class="muted">Loading…</p>`;
  let all;
  try {
    all = await load();
    await loadPinyin();
  } catch (err) {
    app().innerHTML = `<h1>${escapeHtml(word)}</h1><p class="error">${escapeHtml(err.message)}</p><div class="row"><a class="btn" href="#/analysis">Back to analysis</a></div>`;
    return;
  }
  const list = (all[skill] && all[skill][word]) || [];
  view = { skill, word, list, shown: Math.min(SHOW_FIRST, list.length) };
  paint();
}
