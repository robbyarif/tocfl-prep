// Word and grammar analysis: the most used words and grammar points in the listening and the
// reading tests, counted across the question bank and every booklet series (scripts/analyze-words.mjs).
import { escapeHtml, loadPinyin, zhHtml } from './pinyin.js';
import { getPinyinPref } from './store.js';

const app = () => document.getElementById('app');
let data = null; // the analysis, loaded once

// The word or grammar point with pinyin above it (when pinyin is on), linked to its occurrences.
const link = (skill, w, on) => `<a class="an-link" href="#/occurrences/${skill}/${encodeURIComponent(w)}" title="Show every occurrence">${zhHtml(w, on)}</a>`;

function column(title, skill, s, on) {
  const grammar = s.grammar.map((g) => `
        <tr><td class="an-zh">${link(skill, g.k, on)}</td><td>${escapeHtml(g.note)}</td><td class="an-num">${g.c}</td></tr>`).join('');
  const words = s.words.slice(0, 30).map((w, i) => `
        <li><span class="an-rank">${i + 1}</span><span class="an-zh">${link(skill, w.w, on)}</span><span class="an-num">${w.c}×</span><span class="muted an-gloss">${escapeHtml(w.g)}</span></li>`).join('');
  return `
    <section class="an-col">
      <h2>${title}</h2>
      <p class="muted">${s.texts.toLocaleString()} texts counted</p>
      <h3>Grammar points</h3>
      <table class="an-table">
        <thead><tr><th>Point</th><th>Meaning</th><th class="an-num">Count</th></tr></thead>
        <tbody>${grammar}</tbody>
      </table>
      <h3>Most used words</h3>
      <ol class="an-words">${words}</ol>
    </section>`;
}

// Draws the page from the loaded analysis, with pinyin on or off as the preference says.
function paint() {
  const on = getPinyinPref();
  const bank = data.sources.questionBank;
  const booklets = data.sources.booklets.length ? data.sources.booklets.map((s) => `第${s}輯`).join('、') : 'none built';
  app().innerHTML = `
    <h1>Word and grammar analysis</h1>
    <p class="muted">How often each word and grammar point appears across the whole test set: the question bank (${(bank.listening + bank.reading).toLocaleString()} questions) and the booklet series (${booklets}). Listening and reading are counted separately. Click a word to see where it occurs.</p>
    <div class="an-grid">
      ${column('Listening', 'listening', data.listening, on)}
      ${column('Reading', 'reading', data.reading, on)}
    </div>
    <div class="row" style="margin-top:16px"><a class="btn" href="#/">Back</a></div>`;
}

// Called by the global pinyin button, so the page follows the preference.
export function refreshAnalysis() {
  if (data && app().querySelector('.an-grid')) paint();
}

export async function analysisPage() {
  if (!data) {
    try {
      const res = await fetch('data/analysis.json');
      if (res.ok) data = await res.json();
    } catch { /* no analysis yet */ }
  }
  if (!data) {
    app().innerHTML = `
      <h1>Word and grammar analysis</h1>
      <p class="muted">No analysis yet. Run <code>npm run build:analysis</code>.</p>
      <div class="row"><a class="btn" href="#/">Back</a></div>`;
    return;
  }
  await loadPinyin();
  paint();
}
