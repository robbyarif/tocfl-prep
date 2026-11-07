// Pinyin rendering. pinyin-pro is loaded from jsDelivr on first use.
// If the CDN is unreachable the app still works; pinyin simply stays off.
const PINYIN_URL = 'https://cdn.jsdelivr.net/npm/pinyin-pro@3.29.5/dist/index.mjs';

let lib = null;

export async function loadPinyin() {
  if (!lib) {
    try {
      lib = await import(PINYIN_URL);
    } catch (err) {
      console.warn('pinyin-pro could not be loaded:', err);
      lib = null;
    }
  }
  return lib;
}

export const pinyinAvailable = () => lib !== null;

const CJK = /[㐀-鿿]/;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Renders text with one <ruby> per Chinese character (when pinyin is on)
// or one clickable span per character (when off). `data-i` is the UTF-16
// index of the character, used for dictionary lookup.
export function zhHtml(text, showPinyin) {
  const readings = showPinyin && lib
    ? lib.pinyin(text, { type: 'array', toneType: 'symbol', nonZh: 'removed' })
    : null;
  let k = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') { out += '<br>'; continue; }
    if (CJK.test(ch)) {
      if (readings) {
        out += `<ruby class="zh" data-i="${i}">${escapeHtml(ch)}<rt>${escapeHtml(readings[k++] || '')}</rt></ruby>`;
      } else {
        out += `<span class="zh" data-i="${i}">${escapeHtml(ch)}</span>`;
      }
    } else {
      out += escapeHtml(ch);
    }
  }
  return out;
}
