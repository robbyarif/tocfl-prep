// Renders one question: page image with hanzi overlay, stem with pinyin and
// tap-to-lookup, listening player with replay, transcript, choices, and answer reveal.
//
// Data model: a question (q) belongs to a page (bank.pages[q.pageId]). Several questions
// can share a page (gap filling, paragraph completion), so the image, audio and transcript
// come from the page and the stem and choices come from the question.
import { zhHtml, escapeHtml } from './pinyin.js';
import { openAt, bindZhClicks } from './lookup.js';
import { getPinyinPref, recordAttempt } from './store.js';
import { SKILL_NAME } from './data.js';

const OPTION_RE = /^[（(]\s*([A-D])\s*[)）]/;
const BARE_NUMBER_RE = /^\d+\.?$/;
const SPEEDS = [0.75, 1, 1.25, 1.5];
const CJK = /[㐀-鿿]/;

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

// Page image with OCR word boxes. Boxes are hidden until "Hanzi overlay" is turned on;
// tapping a box opens the dictionary entry for the words starting there.
// With `crop` ({y0, y1}, fractions of the page height) only that band of the page is shown,
// so a gap-filling item appears with its own number, blank and choices from the scan.
function imageBlock(page, bank, crop) {
  const aspect = page.height / page.width;
  const wrap = el('div', crop ? 'page-wrap crop' : 'page-wrap');
  const inner = el('div', 'page-inner');
  const img = el('img');
  img.src = `data/${page.image}`;
  img.loading = 'lazy';
  img.alt = 'Question page';
  inner.appendChild(img);
  wrap.appendChild(inner);
  if (crop) {
    const h = (crop.y1 - crop.y0) * aspect; // band height relative to page width
    wrap.style.aspectRatio = `1 / ${h.toFixed(5)}`;
    inner.style.top = `calc(${-crop.y0} * ${aspect.toFixed(5)} * 100cqw)`;
  }

  const words = page.words || [];
  if (words.length === 0) return { node: wrap, toggle: null };

  const layer = el('div', 'hz-layer');
  const joined = words.map((w) => w.t).join('');
  const offsets = [];
  let acc = 0;
  for (const w of words) { offsets.push(acc); acc += w.t.length; }

  words.forEach((w, j) => {
    if (!CJK.test(w.t)) return;
    const box = el('button', 'hz', escapeHtml(w.t));
    box.type = 'button';
    box.setAttribute('aria-label', `Look up ${w.t}`);
    // Font size in container-width units: box height (normalized) times the page's aspect ratio.
    const heightCqw = w.h * aspect * 100;
    box.style.left = `${w.x * 100}%`;
    box.style.top = `${w.y * 100}%`;
    box.style.width = `${w.w * 100}%`;
    box.style.height = `${w.h * 100}%`;
    box.style.fontSize = `${(heightCqw * 0.8).toFixed(2)}cqw`;
    box.addEventListener('click', () => {
      openAt(joined, offsets[j], bank.dict);
    });
    layer.appendChild(box);
  });

  inner.appendChild(layer);
  const toggle = el('button', 'btn small', 'Hanzi overlay: off');
  toggle.type = 'button';
  toggle.setAttribute('aria-pressed', 'false');
  toggle.addEventListener('click', () => {
    const on = !layer.classList.contains('on');
    layer.classList.toggle('on', on);
    toggle.textContent = `Hanzi overlay: ${on ? 'on' : 'off'}`;
    toggle.setAttribute('aria-pressed', String(on));
  });
  return { node: wrap, toggle };
}

// English text (no pinyin, no lookup: the lookup dictionary is for Chinese).
function enHtml(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// Transcript panel content. Machine transcripts (Whisper) are labelled as such.
function transcriptHtml(page) {
  const note = page.scriptSource === 'machine'
    ? '<p class="muted note">Machine transcript (Whisper): may contain errors.</p>'
    : '';
  return note + zhHtml(page.script, getPinyinPref());
}

// Question text without choice lines and bare numbers (used when the item has no own stem).
function pageStem(text) {
  return (text || '')
    .split('\n')
    .filter((l) => !OPTION_RE.test(l.trim()) && !BARE_NUMBER_RE.test(l.trim()))
    .join('\n');
}

// Builds the card. `onAnswer(correct)` is called once when the question is answered.
// `card.refresh()` re-renders the Chinese text (used by the global pinyin toggle)
// without losing the answer state.
// `prior` ({correct, letter, revealed}) shows a question that was already answered, for review.
// In that case nothing is recorded and onAnswer may be null.
export function questionCard(q, bank, onAnswer, prior = null) {
  const page = bank.pages[q.pageId] || {};
  const root = el('article', 'card');
  const renderers = [];
  let answered = false;

  // Chinese or English view. English is a sentence-level machine translation, line by line.
  const tr = bank.translations || {};
  const trText = (text) => text.split('\n').map((l) => tr[l.trim()] || l).join('\n');
  const view = { en: false };
  const textHtml = (text) => (view.en ? enHtml(trText(text)) : zhHtml(text, getPinyinPref()));
  const scriptHtml = () => (view.en ? enHtml(trText(page.script)) : transcriptHtml(page));
  const hasEnglish = [q.stem, page.script, ...(q.options || []).map((o) => o.t)]
    .some((t) => t && trText(t) !== t);

  // Tags
  const tags = el('div', 'tags');
  tags.innerHTML = [
    `<span class="tag band-${q.band}">${escapeHtml(bank.bands[q.band] || q.band)}</span>`,
    `<span class="tag">${escapeHtml(SKILL_NAME[q.skill] || q.skill)}</span>`,
    `<span class="tag">${escapeHtml(q.type)}</span>`,
    q.item ? `<span class="tag">Item ${q.item} of ${q.count}</span>` : '',
    `<span class="tag mono">${escapeHtml(q.id)}</span>`,
  ].join('');
  root.appendChild(tags);

  // Page image
  if (page.image) {
    const block = imageBlock(page, bank, q.crop);
    root.appendChild(block.node);
    if (block.toggle) {
      const row = el('div', 'row');
      row.appendChild(block.toggle);
      root.appendChild(row);
    }
  }

  // Listening player
  if (page.audio) {
    const audio = el('audio');
    audio.src = `data/${page.audio}`;
    audio.preload = 'metadata';
    audio.setAttribute('aria-label', 'Listening question audio');

    const player = el('div', 'player');
    const play = el('button', 'btn primary', '▶ Play');
    play.type = 'button';
    play.addEventListener('click', () => {
      if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    });
    audio.addEventListener('play', () => { play.textContent = '❚❚ Pause'; });
    audio.addEventListener('pause', () => { play.textContent = '▶ Play'; });
    audio.addEventListener('ended', () => { play.textContent = '▶ Play'; });

    const replay = el('button', 'btn', '⟲ Replay');
    replay.type = 'button';
    replay.addEventListener('click', () => {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    });

    const speed = el('select');
    speed.setAttribute('aria-label', 'Playback speed');
    for (const s of SPEEDS) {
      const opt = el('option', null, `${s}×`);
      opt.value = String(s);
      if (s === 1) opt.selected = true;
      speed.appendChild(opt);
    }
    speed.addEventListener('change', () => { audio.playbackRate = Number(speed.value); });

    // Seek bar: drag to any point, with elapsed / total time.
    const seek = el('input', 'seek');
    seek.type = 'range';
    seek.min = '0';
    seek.max = '1000';
    seek.step = '1';
    seek.value = '0';
    seek.setAttribute('aria-label', 'Playback position');
    const time = el('span', 'muted mono time', '0:00 / 0:00');
    const fmt = (s) => {
      if (!isFinite(s) || s < 0) return '0:00';
      return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    };
    let scrubbing = false;
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

    player.append(play, replay, speed, seek, time, audio);
    root.appendChild(player);
  }

  // Stem: the item's own sentence, or the page text when the item has none.
  // A cropped item is shown as its scan, which already has the sentence and blank.
  const stemText = q.crop ? null : (q.stem || pageStem(page.text));
  if (stemText) {
    const stem = el('div', 'stem');
    renderers.push(() => { stem.innerHTML = textHtml(stemText); });
    bindZhClicks(stem, stemText, bank.dict);
    root.appendChild(stem);
  }

  // Choices: parsed choice text when available, otherwise letters only (listening choices are spoken).
  const choicesEl = el('div', 'choices');
  // Show every letter up to the highest one OCR found, so a missed line still gets a button.
  const hasText = Array.isArray(q.options) && q.options.length >= 2;
  const highest = hasText ? Math.max(...q.options.map((o) => o.k.charCodeAt(0) - 65)) : 3;
  const letters = 'ABCD'.slice(0, Math.max(highest + 1, 2)).split('');
  const buttons = {};
  for (const k of letters) {
    const opt = hasText ? q.options.find((o) => o.k === k) : null;
    const b = el('button', 'choice');
    b.type = 'button';
    b.dataset.letter = k;
    const label = el('span');
    b.appendChild(label);
    if (opt) {
      renderers.push(() => {
        label.innerHTML = `<strong>${k}.</strong> ${textHtml(opt.t)}`;
      });
      bindZhClicks(label, opt.t, bank.dict);
    } else {
      label.innerHTML = `<strong>${k}</strong>`;
    }
    b.addEventListener('click', (ev) => {
      // A tap on a Chinese character looks it up; it must not count as an answer.
      if (ev.target.closest('.zh')) return;
      choose(k);
    });
    buttons[k] = b;
    choicesEl.appendChild(b);
  }
  root.appendChild(choicesEl);

  // Transcript (listening scripts are per page)
  let transcriptPanel = null;
  let transcriptBtn = null;
  if (page.script) {
    transcriptBtn = el('button', 'btn', 'Show transcript');
    transcriptBtn.type = 'button';
    transcriptPanel = el('div', 'transcript');
    transcriptPanel.hidden = true;
    renderers.push(() => {
      if (!transcriptPanel.hidden) transcriptPanel.innerHTML = scriptHtml();
    });
    bindZhClicks(transcriptPanel, page.script, bank.dict);
    transcriptBtn.addEventListener('click', () => {
      transcriptPanel.hidden = !transcriptPanel.hidden;
      transcriptBtn.textContent = transcriptPanel.hidden ? 'Show transcript' : 'Hide transcript';
      if (!transcriptPanel.hidden) transcriptPanel.innerHTML = scriptHtml();
    });
  }

  // Actions
  const actions = el('div', 'row');
  const reveal = el('button', 'btn', 'Show answer');
  reveal.type = 'button';
  reveal.addEventListener('click', () => {
    if (answered) return;
    finish(false, null, true);
  });
  actions.appendChild(reveal);
  if (transcriptBtn) actions.appendChild(transcriptBtn);
  if (hasEnglish) {
    const enBtn = el('button', 'btn small', 'English: off');
    enBtn.type = 'button';
    enBtn.setAttribute('aria-pressed', 'false');
    enBtn.title = 'Machine translation of the text, line by line';
    enBtn.addEventListener('click', () => {
      view.en = !view.en;
      enBtn.textContent = `English: ${view.en ? 'on' : 'off'}`;
      enBtn.setAttribute('aria-pressed', String(view.en));
      renderers.forEach((fn) => fn());
    });
    actions.appendChild(enBtn);
  }

  const feedback = el('p', 'feedback');
  feedback.setAttribute('aria-live', 'polite');

  root.append(actions);
  if (transcriptPanel) root.appendChild(transcriptPanel);
  root.appendChild(feedback);

  // Shows the outcome on the card: marks the choices and the feedback line.
  function showOutcome({ correct, letter, revealed }) {
    answered = true;
    for (const b of Object.values(buttons)) b.disabled = true;
    reveal.disabled = true;
    if (buttons[q.answer]) buttons[q.answer].classList.add('correct');
    if (!correct && letter && letter !== q.answer && buttons[letter]) {
      buttons[letter].classList.add('wrong');
    }
    if (correct) {
      feedback.className = 'feedback good';
      feedback.textContent = '✓ Correct';
    } else {
      feedback.className = 'feedback bad';
      feedback.textContent = revealed
        ? `Answer: ${q.answer} (counted as incorrect)`
        : `✗ Incorrect. Answer: ${q.answer}`;
    }
  }

  // `letter` is the choice made, or null when the answer was revealed.
  function finish(correct, letter, revealed) {
    if (answered) return;
    showOutcome({ correct, letter, revealed });
    recordAttempt(q.id, correct);
    if (onAnswer) onAnswer({ correct, letter, revealed });
  }

  function choose(letter) {
    if (answered) return;
    finish(letter === q.answer, letter, false);
  }

  root.refresh = () => renderers.forEach((fn) => fn());
  renderers.forEach((fn) => fn());
  if (prior) showOutcome(prior);
  return root;
}
