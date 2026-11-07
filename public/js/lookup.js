// Dictionary lookup (CC-CEDICT subset) and the meaning popup.
// The popup remembers the text it was opened from, so Prev / Next (buttons or the
// ← → arrow keys) step through the Chinese characters of that same text.
import { escapeHtml } from './pinyin.js';

const MAX_WORD = 8;
const CJK = /[㐀-鿿]/;

// Longest dictionary word starting at text[i]. Returns { word, entries } or null.
export function lookupAt(text, i, dict) {
  const max = Math.min(MAX_WORD, text.length - i);
  for (let n = max; n >= 1; n--) {
    const word = text.substr(i, n);
    if (dict[word]) return { word, entries: dict[word] };
  }
  return null;
}

const popupEl = document.getElementById('popup');
let ctx = null; // { text, index, dict } for the popup on screen

function prevCjk(text, index) {
  for (let i = index - 1; i >= 0; i--) if (CJK.test(text[i])) return i;
  return -1;
}

function nextCjk(text, index) {
  for (let i = index + 1; i < text.length; i++) if (CJK.test(text[i])) return i;
  return -1;
}

function render() {
  const { text, index, dict } = ctx;
  const found = lookupAt(text, index, dict);
  const headword = found ? found.word : text[index];
  const body = found
    ? found.entries.map((e) => `<div class="reading">${escapeHtml(e.p)}</div><div class="def">${escapeHtml(e.d)}</div>`).join('<hr>')
    : `<div class="def muted">No dictionary entry for this character.</div>`;

  // Position among the Chinese characters of this text, e.g. "3 / 12".
  let total = 0, position = 0;
  for (let i = 0; i < text.length; i++) {
    if (CJK.test(text[i])) {
      total++;
      if (i <= index) position = total;
    }
  }
  const hasPrev = prevCjk(text, index) >= 0;
  const hasNext = nextCjk(text, index) >= 0;

  popupEl.innerHTML = `
    <button class="btn small close" type="button" aria-label="Close">✕</button>
    <div class="popup-nav">
      <button class="btn small" type="button" data-nav="prev" ${hasPrev ? '' : 'disabled'} aria-label="Previous character">← Prev</button>
      <span class="muted">${position} / ${total}</span>
      <button class="btn small" type="button" data-nav="next" ${hasNext ? '' : 'disabled'} aria-label="Next character">Next →</button>
    </div>
    <div class="word">${escapeHtml(headword)}</div>
    ${body}`;
  popupEl.hidden = false;

  popupEl.querySelector('.close').onclick = closePopup;
  popupEl.querySelector('[data-nav="prev"]').onclick = () => step(-1);
  popupEl.querySelector('[data-nav="next"]').onclick = () => step(1);
}

function step(dir) {
  if (!ctx) return;
  const j = dir < 0 ? prevCjk(ctx.text, ctx.index) : nextCjk(ctx.text, ctx.index);
  if (j < 0) return;
  ctx.index = j;
  render();
}

function closePopup() {
  popupEl.hidden = true;
  ctx = null;
}

// Opens the popup for the character at text[index].
export function openAt(text, index, dict) {
  ctx = { text, index, dict };
  render();
}

// Keyboard: ← / → step through characters, Escape closes, while the popup is open.
document.addEventListener('keydown', (ev) => {
  if (!ctx || popupEl.hidden) return;
  if (ev.key === 'ArrowLeft') { ev.preventDefault(); step(-1); }
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); step(1); }
  else if (ev.key === 'Escape') { closePopup(); }
});

// Clicks on any <span/ruby class="zh" data-i> inside `root` open the popup at that character.
export function bindZhClicks(root, text, dict) {
  root.addEventListener('click', (ev) => {
    const el = ev.target.closest('.zh');
    if (!el || !root.contains(el)) return;
    openAt(text, Number(el.dataset.i), dict);
  });
}
