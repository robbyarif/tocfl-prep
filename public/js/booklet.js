// Booklet test mode: a full TOCFL mock test (Band A, English directions) in one continuous column.
// Each booklet page appears once, in order, and each question's controls follow the page it is on:
// its picture (cropped from the page), audio (play, pause, seek), transcript or text (with optional
// pinyin and dictionary popups), option buttons (submit), and a check button.
import { escapeHtml, zhHtml, loadPinyin, pinyinAvailable } from './pinyin.js';
import { bindZhClicks, openAt, lookupAt } from './lookup.js';
import { getPinyinPref, setPinyinPref } from './store.js';

const app = () => document.getElementById('app');
const SECTIONS = { L: { label: 'Listening', n: 50 }, R: { label: 'Reading', n: 50 } };
const SPEEDS = [0.75, 1, 1.25];
const PAGE_ASPECT = 841.92 / 595.32; // booklet pages are A4

let dict = null;

// Progress is kept per series in this browser, so you can see which questions are not done yet.
const PROGRESS_KEY = 'tocfl-prep:booklet:v1';
function loadProgress(series) {
  try {
    return (JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}')[series]) || {};
  } catch {
    return {};
  }
}
function saveProgress() {
  try {
    const all = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
    all[run.series] = run.answers;
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: progress lasts for this page only */
  }
}
function clearProgress(series) {
  try {
    const all = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
    delete all[series];
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

let run = null;         // { series, data, flow, answers: {'L3': {letter, checked}}, texts: [{el, text}] }
let currentAudio = null;
let playbackRate = 1;    // shared by every question's audio, set from the header

let translations = {};
async function loadDict() {
  if (!dict) dict = await (await fetch('data/dict.json')).json();
  return dict;
}
// English sentence translations (optional): the switch on a transcript just shows nothing new if missing.
async function loadTranslations() {
  try {
    translations = (await (await fetch('data/translations.json')).json()).lines || {};
  } catch {
    translations = {};
  }
}
const trText = (text) => text.split('\n').map((l) => translations[l.trim()] || l).join('\n');
const enHtml = (text) => escapeHtml(text).replace(/\n/g, '<br>');

// Letters on the answer sheet: reading part 4 has six choices (A-F), part 5 has four.
function letterSet(sec, n) {
  // Listening 41-50 have written options with four choices (A-D).
  if (sec === 'L') return n >= 41 ? ['A', 'B', 'C', 'D'] : ['A', 'B', 'C'];
  if (n >= 41 && n <= 45) return ['A', 'B', 'C', 'D', 'E', 'F'];
  if (n >= 46) return ['A', 'B', 'C', 'D'];
  return ['A', 'B', 'C'];
}

async function loadSeries(series) {
  const res = await fetch(`data/booklet/s${series}.json`);
  if (!res.ok) throw new Error(`booklet ${series}: HTTP ${res.status}`);
  return res.json();
}

// The column: for each section, each page once, followed by the questions placed on it.
// A page is hidden only when every question on it has its own crop (the crop is shown in the question),
// so nothing is repeated and nothing is missing.
function buildFlow(data) {
  const flow = [];
  for (const sec of data.sections) {
    const kinds = sec.pageKinds || [];
    const hidden = new Set();
    for (let p = 0; p < sec.pages.length; p++) {
      // Blank pages are skipped. A page is also hidden when every question on it has its own crop.
      if (kinds[p] === 'blank') hidden.add(p);
      const onPage = sec.items.filter((x) => x.page === p);
      if (onPage.length && onPage.every((x) => x.crop)) hidden.add(p);
    }
    sec.pages.forEach((src, pageIdx) => {
      if (!hidden.has(pageIdx)) flow.push({ type: 'page', sec: sec.skill, src, pageIdx, small: kinds[pageIdx] === 'part' });
      const groups = new Set();
      for (const item of sec.items.filter((x) => x.page === pageIdx).sort((a, b) => a.n - b.n)) {
        // Grouped questions (cloze 41-45) share one block, placed at the first question of the group.
        if (item.group) {
          if (groups.has(item.group)) continue;
          groups.add(item.group);
          flow.push({ type: 'cloze', sec: sec.skill, items: sec.items.filter((x) => x.group === item.group).sort((a, b) => a.n - b.n) });
          continue;
        }
        flow.push({ type: 'q', sec: sec.skill, item });
      }
    });
  }
  return flow;
}

export async function bookletHome() {
  let index = { series: [] };
  try {
    const res = await fetch('data/booklet/index.json');
    if (res.ok) index = await res.json();
  } catch { /* no booklet data yet */ }

  const cards = index.series.length
    ? index.series.map((s) => `
        <div class="card">
          <h2>第${s}輯 · Series ${s}</h2>
          <p class="muted">Band A (入門基礎級) · English directions · 50 listening and 50 reading questions</p>
          <button class="btn primary" type="button" data-series="${s}">Start test</button>
        </div>`).join('')
    : '<p class="muted">No booklet data yet. Run <code>npm run build:booklet</code>.</p>';

  app().innerHTML = `
    <h1>4 · Booklet test</h1>
    <p class="muted">The full mock test booklet in order: listening, then reading. Submit an answer, then check it if you want to see the result.</p>
    ${cards}
    <div class="row" style="margin-top:12px"><a class="btn" href="#/">Back</a></div>`;

  app().querySelectorAll('[data-series]').forEach((b) => b.addEventListener('click', async () => {
    const series = Number(b.dataset.series);
    b.disabled = true;
    try {
      await Promise.all([loadDict(), loadPinyin(), loadTranslations()]);
      const data = await loadSeries(series);
      run = { series, data, flow: buildFlow(data), answers: loadProgress(series), texts: [] };
      show();
    } catch (err) {
      b.disabled = false;
      app().insertAdjacentHTML('beforeend', `<p class="error">${escapeHtml(err.message)}</p>`);
    }
  }));
}

// Grammar particles and pronouns: hidden by the "Hide grammar particles" option of the frequency page.
const PARTICLES = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '們', '也', '和', '就', '都', '不', '有',
  '很', '這', '那', '一', '個', '嗎', '吧', '呢', '啊', '要', '會', '說', '到', '把', '地', '得', '與', '而', '上', '下']);

// Counts the Chinese in every question, transcript, passage and option of the test.
// Words: longest dictionary match from left to right (the same matching as the dictionary popup);
// characters that are not in the dictionary are skipped. Characters: every Chinese character.
function countFrequency(data, mode, skipParticles) {
  const counts = new Map();
  const add = (w) => { if (!(skipParticles && PARTICLES.has(w))) counts.set(w, (counts.get(w) || 0) + 1); };
  for (const sec of data.sections) {
    for (const item of sec.items) {
      const texts = [item.transcript, item.text, ...(item.options || []).map((o) => o.text)];
      for (const raw of texts) {
        if (!raw) continue;
        // Speaker labels (男：／女：) are not part of the test content.
        const cleaned = raw.replace(/(男|女)：/g, '');
        for (const run of cleaned.match(/[㐀-鿿]+/g) || []) {
          if (mode === 'chars') {
            for (const ch of run) add(ch);
          } else {
            let i = 0;
            while (i < run.length) {
              const found = lookupAt(run, i, dict);
              if (found) { add(found.word); i += found.word.length; } else i++;
            }
          }
        }
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// The word-frequency page: the most used words (or characters) in the test, most used first.
function wordsHtml() {
  const mode = run.freqMode || 'words';
  const ranked = countFrequency(run.data, mode, !!run.freqSkip);
  const total = ranked.reduce((s, [, c]) => s + c, 0);
  const rows = ranked.slice(0, 100).map(([w, c], i) => {
    const entry = dict[w] && dict[w][0];
    const gloss = entry ? entry.d.split(';')[0] : '';
    return `<li class="freq-row">
        <span class="freq-rank">${i + 1}</span>
        <button class="freq-word" type="button" data-word="${escapeHtml(w)}">${zhHtml(w, getPinyinPref())}</button>
        <span class="freq-count">${c}×</span>
        <span class="freq-def muted">${escapeHtml(gloss)}</span>
      </li>`;
  }).join('');
  return `
    <section class="freq">
      <h1>Most used ${mode === 'words' ? 'words' : 'characters'} · 第${run.series}輯</h1>
      <p class="muted">Counted from every question, transcript, passage and option in this test. Click a word for its meaning.</p>
      <div class="freq-tools">
        <button class="btn small${mode === 'words' ? ' primary' : ''}" type="button" data-fmode="words">Words</button>
        <button class="btn small${mode === 'chars' ? ' primary' : ''}" type="button" data-fmode="chars">Characters</button>
        <label class="muted"><input type="checkbox" id="freq-skip"${run.freqSkip ? ' checked' : ''}> Hide grammar particles</label>
        <span class="muted">${ranked.length} distinct · ${total} occurrences</span>
      </div>
      <ol class="freq-list">${rows}</ol>
    </section>`;
}

function show() {
  const total = Object.keys(run.answers).length;
  run.texts = [];
  const parts = run.flow.map((entry) => (entry.type === 'page'
    ? `<img class="booklet-page${entry.small ? ' small' : ''}" src="data/booklet/${escapeHtml(entry.src)}" loading="lazy" alt="${SECTIONS[entry.sec].label} booklet page ${entry.pageIdx + 1}">`
    : entry.type === 'cloze' ? clozeHtml(entry.sec, entry.items) : questionBlock(entry.sec, entry.item)));

  app().innerHTML = `
    <div class="booklet-head">
      <strong>第${run.series}輯 · Band A</strong>
      <span class="muted booklet-count">answered ${total} of 100</span>
      <button class="btn small" type="button" id="pinyin">拼音 Pinyin: ${getPinyinPref() ? 'on' : 'off'}</button>
      <label class="muted speed-label">Speed
        <select id="speed" aria-label="Playback speed">${SPEEDS.map((s) => `<option value="${s}"${s === playbackRate ? ' selected' : ''}>${s}×</option>`).join('')}</select>
      </label>
      <button class="btn small" type="button" id="finish">Finish and see results</button>
      <button class="btn small" type="button" id="reset">Reset progress</button>
      <button class="btn small" type="button" id="freq-view">${run.view === 'words' ? 'Back to test' : 'Word frequency'}</button>
      <div class="booklet-nav" style="width:100%">${navChips()}</div>
    </div>
    ${run.view === 'words' ? wordsHtml() : `<div class="booklet-flow">${parts.join('')}</div>`}
    <div class="row" style="margin:16px 0"><button class="btn primary" type="button" id="finish2">Finish and see results</button></div>`;

  wire();
  window.scrollTo(0, 0);
}

// The picture for a question: its crop of the page, or nothing (the page is in the column).
function pictureHtml(sec, item) {
  if (!item.crop) return '';
  const page = run.data.sections.find((x) => x.skill === sec).pages[item.page];
  const { y0, y1 } = item.crop;
  const h = (y1 - y0) * PAGE_ASPECT;
  const key = `${sec}${item.n}`;
  // OCR overlay (reading 21-30): the words the OCR found, drawn over the picture. Boxes are page fractions;
  // inside the crop their top and height are relative to the crop.
  const boxes = item.ocrBoxes || [];
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  const layer = boxes.length ? `
      <div class="ocr-layer" data-ocr="${key}" hidden>
        ${boxes.map((b) => `<span class="ocr-box" data-w="${escapeHtml(b.t)}" title="${escapeHtml(b.t)} (${b.c}%)" style="left:${pct(b.x0)};top:${pct((b.y0 - y0) / (y1 - y0))};width:${pct(b.x1 - b.x0)};height:${pct((b.y1 - b.y0) / (y1 - y0))}"></span>`).join('')}
      </div>` : '';
  const ocrButton = boxes.length ? `<button class="btn small ocr-btn" type="button" data-ocrbtn="${key}">Show OCR</button>` : '';
  return `
    ${ocrButton}
    <div class="page-wrap crop booklet-crop" style="aspect-ratio: 1 / ${h.toFixed(5)}">
      <div class="page-inner" style="top: calc(${-y0} * ${PAGE_ASPECT.toFixed(5)} * 100cqw)">
        <img src="data/booklet/${escapeHtml(page)}" loading="lazy" alt="Question ${item.n} picture">
      </div>${layer}
    </div>`;
}

// The Show text / Show transcript button and its panel (tools: English, copy, Google Translate).
function textBlockHtml(key, isL) {
  return `
    <button class="btn small" type="button" data-tr="${key}">${isL ? 'Show transcript' : 'Show text'}</button>
    <div class="transcript" data-trpanel="${key}" hidden>
      <div class="tr-tools">
        <button class="btn small" type="button" data-en="${key}" aria-pressed="false">English: off</button>
        <button class="btn small" type="button" data-copy="${key}">Copy</button>
        <button class="btn small gt-btn" type="button" data-gt="${key}" title="Open in Google Translate" aria-label="Open in Google Translate">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="3" width="13" height="13" rx="2" fill="#4285F4"/><text x="7.5" y="13" font-size="9" fill="#fff" text-anchor="middle" font-family="sans-serif" font-weight="700">文</text><rect x="10" y="8" width="13" height="13" rx="2" fill="#34A853"/><text x="16.5" y="18" font-size="10" fill="#fff" text-anchor="middle" font-family="sans-serif" font-weight="700">A</text></svg>
        </button>
        <span class="muted tr-msg" data-msg="${key}"></span>
      </div>
      <div class="tr-body"></div>
    </div>`;
}

// Cloze (reading 41-45): one passage picture with the Show text button beside it, then each question
// with its options (letter button and text). Each question keeps its own answer and check.
function clozeHtml(sec, items) {
  const first = items[0];
  const key = `${sec}${first.n}`;
  const text = first.passage || '';
  const picture = pictureHtml(sec, first);
  const questions = items.map((item) => {
    const qkey = `${sec}${item.n}`;
    const st = run.answers[qkey] || {};
    const pick = (o) => `<button class="choice${st.letter === o.letter ? ' picked' : ''}${st.checked ? checkedClass(o.letter, st, item) : ''}" type="button" data-pick="${qkey}" data-letter="${o.letter}"${st.checked ? ' disabled' : ''}>${o.letter}</button>`;
    return `
      <section class="cloze-q" id="q-${qkey}" data-key="${qkey}">
        <div class="tags"><span class="tag">Reading ${item.n}</span></div>
        <div class="choices choices-text">
          ${item.options.map((o) => `<div class="opt-row">${pick(o)}<div class="opt-body" data-otext="${escapeHtml(o.text)}"></div></div>`).join('')}
        </div>
        <div class="row">
          <button class="btn" type="button" data-check="${qkey}"${st.letter && !st.checked ? '' : ' disabled'}>Check answer</button>
          <span class="feedback" data-result="${qkey}">${resultText(qkey, st)}</span>
        </div>
      </section>`;
  }).join('');
  return `
    <section class="bq cloze-group" data-key="${key}" data-text="${escapeHtml(text)}">
      <div class="tags"><span class="tag">Reading ${first.n}–${items[items.length - 1].n} · passage</span></div>
      <div class="bq-grid">
        <div class="bq-left">${picture}</div>
        <div class="bq-right">${text ? textBlockHtml(key, false) : ''}</div>
      </div>
      <div class="cloze-questions">${questions}</div>
    </section>`;
}

function questionBlock(sec, item) {
  const key = `${sec}${item.n}`;
  const st = run.answers[key] || {};
  const letters = letterSet(sec, item.n);
  const isL = sec === 'L';
  const audio = isL && item.audio ? `
    <div class="player">
      <button class="btn primary" type="button" data-play="${key}">▶ Play</button>
      <button class="btn" type="button" data-replay="${key}">⟲ Replay</button>
      <input class="seek" type="range" min="0" max="1000" value="0" step="1" data-seek="${key}" aria-label="Playback position">
      <span class="muted mono time" data-time="${key}">0:00 / 0:00</span>
      <audio preload="metadata" src="data/booklet/${escapeHtml(item.audio)}" data-audio="${key}"></audio>
    </div>` : '';
  // Listening: the official transcript. Reading: the question text. Both have pinyin and dictionary popups.
  const text = isL ? item.transcript : item.text;
  const textBlock = text ? textBlockHtml(key, isL) : '';

  const picture = pictureHtml(sec, item);
  const pick = (k) => `<button class="choice${st.letter === k ? ' picked' : ''}${st.checked ? checkedClass(k, st, item) : ''}" type="button" data-pick="${key}" data-letter="${k}"${st.checked ? ' disabled' : ''}>${k}</button>`;
  // Cloze (reading 41-45): the passage first, then each option with its text under the passage.
  // The letter picks the answer; the text is Chinese with pinyin and the dictionary popup.
  const optionRows = item.options ? `
          <div class="choices choices-text">
            ${item.options.map((o) => `<div class="opt-row">${pick(o.letter)}<div class="opt-body" data-opt="${key}-${o.letter}" data-otext="${escapeHtml(o.text)}"></div></div>`).join('')}
          </div>` : `
          <div class="choices">
            ${letters.map(pick).join('')}
          </div>`;
  // Side by side: the question picture on the left, the audio, transcript and answer buttons on the right.
  // Cloze questions stack instead: the passage on top, the options below.
  return `
    <section class="bq" id="q-${key}" data-key="${key}" data-text="${escapeHtml(text || '')}">
      <div class="tags"><span class="tag">${isL ? 'Listening' : 'Reading'} ${item.n}</span></div>
      <div class="bq-grid${item.options ? ' stacked' : ''}${picture ? '' : ' no-pic'}">
        <div class="bq-left">${picture}</div>
        <div class="bq-right">
          ${audio}
          ${textBlock}
          ${optionRows}
          <div class="row">
            <button class="btn" type="button" data-check="${key}"${st.letter && !st.checked ? '' : ' disabled'}>Check answer</button>
            <span class="feedback" data-result="${key}">${resultText(key, st)}</span>
          </div>
        </div>
      </div>
    </section>`;
}

// Green for the correct letter; red for a wrong choice of yours.
function checkedClass(k, st, item) {
  if (k === item.answer) return ' correct';
  if (k === st.letter) return ' wrong';
  return '';
}

function resultText(key, st) {
  if (!st.checked) return st.letter ? `Selected: ${st.letter} (not checked yet)` : '';
  const item = findItem(key);
  if (!item) return '';
  return st.letter === item.answer
    ? `✓ Correct (${item.answer})`
    : `✗ Your answer ${st.letter}. Correct: ${item.answer}`;
}

function findItem(key) {
  const sec = key[0];
  const n = Number(key.slice(1));
  return run.data.sections.find((x) => x.skill === sec).items.find((x) => x.n === n);
}

// Renders the question text with pinyin (when on); Chinese characters open the dictionary popup.
function renderText(panel, text) {
  const body = panel.querySelector('.tr-body');
  const en = panel.dataset.en === '1';
  body.innerHTML = en ? enHtml(trText(text)) : zhHtml(text, getPinyinPref());
  const toggle = panel.querySelector('[data-en]');
  if (toggle) {
    toggle.textContent = `English: ${en ? 'on' : 'off'}`;
    toggle.setAttribute('aria-pressed', String(en));
  }
}

function wire() {
  // Pinyin: turns ruby on for every open text panel, and remembers the choice.
  const pyBtn = document.getElementById('pinyin');
  const paintPy = () => {
    const on = getPinyinPref() && pinyinAvailable();
    pyBtn.textContent = `拼音 Pinyin: ${on ? 'on' : 'off'}`;
    pyBtn.setAttribute('aria-pressed', String(on));
  };
  paintPy();
  // Cloze option texts (reading 41-45): Chinese with pinyin when on; a Chinese character opens the dictionary.
  const paintOptions = () => {
    app().querySelectorAll('.opt-body').forEach((body) => {
      body.innerHTML = zhHtml(body.dataset.otext, getPinyinPref());
      if (!body.dataset.bound) {
        body.dataset.bound = '1';
        bindZhClicks(body, body.dataset.otext, dict);
      }
    });
  };
  paintOptions();
  pyBtn.addEventListener('click', () => {
    setPinyinPref(!getPinyinPref());
    paintPy();
    paintOptions();
    app().querySelectorAll('[data-trpanel]:not([hidden])').forEach((panel) => {
      renderText(panel, panel.closest('.bq').dataset.text);
    });
  });

  // Show OCR: draws the OCR word boxes over the picture; a box opens the dictionary popup for its word.
  app().querySelectorAll('[data-ocrbtn]').forEach((b) => b.addEventListener('click', () => {
    const layer = app().querySelector(`[data-ocr="${b.dataset.ocrbtn}"]`);
    layer.hidden = !layer.hidden;
    b.textContent = layer.hidden ? 'Show OCR' : 'Hide OCR';
  }));
  app().querySelectorAll('.ocr-box').forEach((bx) => bx.addEventListener('click', () => {
    openAt(bx.dataset.w, 0, dict);
  }));

  // Word-frequency page: switch between the test and the page, words or characters, and the particle filter.
  document.getElementById('freq-view').addEventListener('click', () => {
    run.view = run.view === 'words' ? 'test' : 'words';
    show();
  });
  app().querySelectorAll('[data-fmode]').forEach((b) => b.addEventListener('click', () => {
    run.freqMode = b.dataset.fmode;
    show();
  }));
  document.getElementById('freq-skip')?.addEventListener('change', (ev) => {
    run.freqSkip = ev.target.checked;
    show();
  });
  // A word in the list opens the dictionary popup for it.
  app().querySelectorAll('[data-word]').forEach((b) => b.addEventListener('click', () => {
    const w = b.dataset.word;
    openAt(w, 0, dict);
  }));

  // Playback speed: one control in the header, applied to every question's audio.
  document.getElementById('speed').addEventListener('change', (ev) => {
    playbackRate = Number(ev.target.value);
    app().querySelectorAll('audio[data-audio]').forEach((a) => { a.playbackRate = playbackRate; });
  });

  // Options submit the answer; the answer then locks until the question is checked.
  // Choose an option to select it, choose the same option again to clear it. Check answer records it;
  // after checking the answer is locked.
  app().querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.pick;
    const current = run.answers[key];
    if (current && current.checked) return;
    const block = document.getElementById(`q-${key}`);
    if (current && current.letter === b.dataset.letter) {
      delete run.answers[key];
    } else {
      run.answers[key] = { letter: b.dataset.letter, checked: false };
    }
    const st = run.answers[key] || {};
    block.querySelectorAll('[data-pick]').forEach((x) => x.classList.toggle('picked', x.dataset.letter === st.letter));
    block.querySelector('[data-check]').disabled = !st.letter;
    block.querySelector(`[data-result="${key}"]`).textContent = resultText(key, st);
    saveProgress();
    refreshCount();
  }));

  app().querySelectorAll('[data-check]').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.check;
    const st = run.answers[key];
    if (!st) return;
    st.checked = true;
    const block = document.getElementById(`q-${key}`);
    const item = findItem(key);
    block.querySelectorAll('[data-pick]').forEach((x) => {
      x.disabled = true; // locked once checked
      if (x.dataset.letter === item.answer) x.classList.add('correct');
      if (x.dataset.letter === st.letter && st.letter !== item.answer) x.classList.add('wrong');
    });
    block.querySelector(`[data-result="${key}"]`).textContent = resultText(key, st);
    b.disabled = true;
    saveProgress();
    refreshCount();
  }));

  bindNav();
  document.getElementById('reset').addEventListener('click', () => {
    if (!confirm(`Reset all answers for series ${run.series}? This cannot be undone.`)) return;
    run.answers = {};
    clearProgress(run.series);
    show();
  });

  app().querySelectorAll('[data-tr]').forEach((b) => b.addEventListener('click', () => {
    const block = b.closest('.bq');
    const panel = block.querySelector(`[data-trpanel="${b.dataset.tr}"]`);
    panel.hidden = !panel.hidden;
    const isL = block.dataset.key.startsWith('L');
    b.textContent = panel.hidden ? (isL ? 'Show transcript' : 'Show text') : (isL ? 'Hide transcript' : 'Hide text');
    if (!panel.hidden) {
      renderText(panel, block.dataset.text);
      // Chinese in the panel opens the dictionary popup (bindZhClicks is attached once per panel).
      if (!panel.dataset.bound) {
        panel.dataset.bound = '1';
        bindZhClicks(panel, block.dataset.text, dict);
        // English switch: the same text, translated line by line.
        panel.querySelector('[data-en]').addEventListener('click', () => {
          panel.dataset.en = panel.dataset.en === '1' ? '' : '1';
          renderText(panel, block.dataset.text);
        });
        // Google Translate: opens the plain Chinese transcript in a new tab (source Traditional Chinese, target English).
        panel.querySelector('[data-gt]').addEventListener('click', () => {
          const url = `https://translate.google.com/?sl=zh-TW&tl=en&text=${encodeURIComponent(block.dataset.text)}&op=translate`;
          window.open(url, '_blank', 'noopener');
        });
        // Copy: plain text only (no pinyin, no duplicate). Copies the English when the English view is on.
        panel.querySelector('[data-copy]').addEventListener('click', async () => {
          const en = panel.dataset.en === '1';
          const plain = en ? trText(block.dataset.text) : block.dataset.text;
          const msg = panel.querySelector('.tr-msg');
          try {
            await navigator.clipboard.writeText(plain);
            msg.textContent = en ? 'English copied' : 'Chinese copied';
          } catch {
            msg.textContent = 'Copy failed';
          }
          setTimeout(() => { msg.textContent = ''; }, 1600);
        });
      }
    }
  }));

  // Audio: one clip plays at a time. Play/pause, replay, speed, and a draggable seek bar.
  app().querySelectorAll('[data-audio]').forEach((audio) => {
    const key = audio.dataset.audio;
    const playBtn = app().querySelector(`[data-play="${key}"]`);
    const seek = app().querySelector(`[data-seek="${key}"]`);
    const time = app().querySelector(`[data-time="${key}"]`);
    audio.playbackRate = playbackRate;
    const fmt = (s) => (isFinite(s) && s >= 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
    let scrubbing = false;

    playBtn.addEventListener('click', () => {
      if (audio.paused) {
        if (currentAudio && currentAudio !== audio) currentAudio.pause();
        currentAudio = audio;
        audio.play().catch(() => {});
      } else {
        audio.pause();
      }
    });
    audio.addEventListener('play', () => { playBtn.textContent = '❚❚ Pause'; });
    audio.addEventListener('pause', () => { playBtn.textContent = '▶ Play'; });
    audio.addEventListener('ended', () => { playBtn.textContent = '▶ Play'; });
    app().querySelector(`[data-replay="${key}"]`).addEventListener('click', () => {
      if (currentAudio && currentAudio !== audio) currentAudio.pause();
      currentAudio = audio;
      audio.currentTime = 0;
      audio.play().catch(() => {});
    });
    audio.addEventListener('loadedmetadata', () => { time.textContent = `0:00 / ${fmt(audio.duration)}`; });
    audio.addEventListener('timeupdate', () => {
      if (scrubbing || !audio.duration) return;
      seek.value = String(Math.round((1000 * audio.currentTime) / audio.duration));
      time.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
    });
    seek.addEventListener('input', () => {
      scrubbing = true;
      if (audio.duration) time.textContent = `${fmt((audio.duration * Number(seek.value)) / 1000)} / ${fmt(audio.duration)}`;
    });
    seek.addEventListener('change', () => {
      if (audio.duration) audio.currentTime = (audio.duration * Number(seek.value)) / 1000;
      scrubbing = false;
    });
  });

  app().querySelectorAll('#finish, #finish2').forEach((b) => b.addEventListener('click', results));
}

// Chips for all 100 questions: grey = not practiced yet, blue = submitted, green/red = checked.
function statusOf(key) {
  const st = run.answers[key];
  if (!st || !st.letter) return 'todo';
  if (!st.checked) return 'submitted';
  return st.letter === findItem(key).answer ? 'right' : 'wrong';
}

function navChips() {
  const rows = run.data.sections.map((sec) => {
    const chips = sec.items.map((item) => {
      const key = `${sec.skill}${item.n}`;
      return `<button type="button" class="chip ${statusOf(key)}" data-jump="${key}" title="${sec.skill === 'L' ? 'Listening' : 'Reading'} ${item.n}">${sec.skill}${item.n}</button>`;
    }).join('');
    return `<div class="nav-row"><span class="muted nav-label">${sec.title}</span>${chips}</div>`;
  }).join('');
  return rows;
}

function refreshCount() {
  const head = app().querySelector('.booklet-count');
  if (head) head.textContent = `answered ${Object.keys(run.answers).filter((k) => run.answers[k].letter).length} of 100`;
  const nav = app().querySelector('.booklet-nav');
  if (nav) nav.innerHTML = navChips();
  bindNav();
}

function bindNav() {
  app().querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
    document.getElementById(`q-${b.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}

function results() {
  if (currentAudio) currentAudio.pause();
  const { data, answers, series } = run;
  const rows = [];
  const score = {};
  for (const sec of data.sections) {
    for (const item of sec.items) {
      const key = `${sec.skill}${item.n}`;
      const mine = answers[key] ? answers[key].letter : null;
      const ok = mine === item.answer;
      score[sec.skill] = score[sec.skill] || { correct: 0, total: 0, answered: 0 };
      score[sec.skill].total++;
      if (mine) score[sec.skill].answered++;
      if (ok) score[sec.skill].correct++;
      rows.push({ sec: sec.skill, n: item.n, mine, answer: item.answer, ok });
    }
  }
  const total = rows.filter((r) => r.ok).length;
  const sectionLines = data.sections.map((s) => {
    const sc = score[s.skill] || { correct: 0, total: 0, answered: 0 };
    return `<div class="big">${escapeHtml(s.title)}: ${sc.correct} / ${sc.total}</div>
      <p class="muted">${sc.answered} answered</p>`;
  }).join('');

  app().innerHTML = `
    <h1>Booklet results · 第${series}輯</h1>
    <div class="card results">
      <div class="big">${total} / ${rows.length}</div>
      ${sectionLines}
    </div>
    <h2>Questions</h2>
    <ul class="booklet-review">${rows.map((r) => `
      <li class="${r.mine ? (r.ok ? 'ok' : 'bad') : ''}">${r.sec}${r.n}: your answer ${r.mine || '—'} · answer ${r.answer} ${r.mine ? (r.ok ? '✓' : '✗') : '(not answered)'}</li>`).join('')}
    </ul>
    <div class="row"><a class="btn" href="#/booklet">Booklet home</a><a class="btn" href="#/">Home</a></div>`;
  run = null;
  currentAudio = null;
  window.scrollTo(0, 0);
}
