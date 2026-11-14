// ==UserScript==
// @name         TOCFL listening replay
// @namespace    local.tocfl-listening
// @version      0.7.0
// @description  Adds Replay, Pause/Resume, a transcript (via a local Whisper server) with English, pinyin and a dictionary popup, a test metrics panel and drag-to-seek on the progress bar to the 華測會 CATO TOCFL test page.
// @match        https://cbt.sc-top.org.tw/cato/*
// @require      https://cdn.jsdelivr.net/npm/pinyin-pro@3.29.5/dist/index.js
// @match        https://cbt.sc-top.org.tw/sctopm/*
// @match        https://cbt.sc-top.org.tw/sctop2m/*
// @match        https://cbt.sc-top.org.tw/sctop3m/*
// @match        http://cbt.sc-top.org.tw/sctopm/*
// @match        http://cbt.sc-top.org.tw/sctop2m/*
// @match        http://cbt.sc-top.org.tw/sctop3m/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  'use strict';

  const BUTTON_CLASS = 'cato-replay-btn';
  const PAUSE_CLASS = 'cato-pause-btn';
  const TRANSCRIPT_CLASS = 'cato-transcript-btn';
  const PANEL_CLASS = 'cato-transcript';
  const METRICS_CLASS = 'cato-metrics-btn';
  const METRICS_PANEL_CLASS = 'cato-metrics';
  const CLIP_NAV_CLASS = 'cato-clip-nav';
  const TOOLBAR_CLASS = 'cato-toolbar';
  // Distance from the top of the button row to the top of the buttons, in px.
  const TOOLBAR_TOP_PX = 8;
  // Local transcription server (npm run transcribe in the project folder).
  const TRANSCRIBE_URL = 'http://127.0.0.1:8787/transcribe';
  // Question bank lookup on the same server: GET /script?id=<question id>.
  const BANK_URL = 'http://127.0.0.1:8787/script?id=';
  // English translation of the transcript, by a local model on the same server.
  const TRANSLATE_URL = 'http://127.0.0.1:8787/translate';
  const TRANSCRIPT_TOOLS_CLASS = 'cato-transcript-tools';
  const TRANSCRIPT_BODY_CLASS = 'cato-transcript-body';
  const TRANSCRIPT_EN_CLASS = 'cato-transcript-en';
  const TRANSCRIPT_MSG_CLASS = 'cato-transcript-msg';
  const TRANSCRIPT_PY_CLASS = 'cato-transcript-py';
  const TRANSCRIPT_TEXT_CLASS = 'cato-zh';
  const TRANSCRIPT_OPTS_CLASS = 'cato-transcript-opts';
  const POPUP_ID = 'cato-dict-popup';
  // Dictionary (CC-CEDICT subset) served by the same server: word -> [{p, d}].
  const DICT_URL = 'http://127.0.0.1:8787/dict';
  const PINYIN_PREF_KEY = 'cato-pinyin';
  const SERVER_HINT = 'Transcription server not running. Start it with: npm run transcribe';
  // Audio URL -> Promise of transcript text, so each clip is transcribed once.
  const transcriptCache = new Map();

  function srcOf(a) {
    return a.currentSrc || a.src || '';
  }

  // All question-type clips on the page, in page order (a passage clip comes before its questions).
  // The site loads them from /cato/SelectItem/.../*.mp3.
  function questionClips() {
    return [...document.querySelectorAll('audio')].filter(a => /\/SelectItem\/.*\.mp3/i.test(srcOf(a)));
  }

  // The clip the user picked with prev/next, as {item, src}. It is ignored once the item changes.
  let clipSelection = null;

  // The clip the controls act on. A picked clip wins; otherwise prefer the clip named after
  // the current item (LabNo), then the one playing, then the last clip (the question follows its passage).
  function findQuestionAudio() {
    const clips = questionClips();
    if (!clips.length) return null;
    const itemId = currentItemId();
    if (clipSelection && clipSelection.item === itemId) {
      const picked = clips.find(a => srcOf(a) === clipSelection.src);
      if (picked) return picked;
    }
    return clips.find(a => itemId && srcOf(a).includes('/' + itemId + '.mp3')) ||
      clips.find(a => !a.paused) ||
      clips[clips.length - 1];
  }

  // Move the controls to the previous (-1) or next (+1) clip of the current item.
  function stepClip(delta) {
    const clips = questionClips();
    const current = findQuestionAudio();
    const target = clips[clips.indexOf(current) + delta];
    if (!current || !target) return;
    current.pause();
    clipSelection = { item: currentItemId(), src: srcOf(target) };
    syncClipNav();
    syncPauseLabel();
    syncTranscriptControls();
  }

  // Show "Passage n/m" or "Question n/m" with prev/next, only when the item has more than one clip.
  function syncClipNav() {
    const nav = document.querySelector('.' + CLIP_NAV_CLASS);
    if (!nav) return;
    const clips = questionClips();
    nav.style.display = clips.length > 1 ? 'inline-flex' : 'none';
    if (clips.length < 2) return;
    const current = findQuestionAudio();
    const i = clips.indexOf(current);
    const name = srcOf(current).split('/').pop().replace(/\.mp3$/i, '');
    const groupHead = document.getElementById('LabGroupHead');
    const isPassage = !!groupHead && ownText(groupHead) === name;
    nav.querySelector('[data-role="label"]').textContent =
      (isPassage ? 'Passage ' : 'Question ') + (i + 1) + '/' + clips.length;
    nav.querySelector('[data-role="prev"]').disabled = i <= 0;
    nav.querySelector('[data-role="next"]').disabled = i >= clips.length - 1;
  }

  // The active player: the briefing uses a <video>, questions use an <audio>.
  // Prefer the one that is playing, then the question clip, then any loaded one.
  function findMedia() {
    const loaded = [...document.querySelectorAll('audio,video')].filter(m =>
      (m.currentSrc || m.src) && m.readyState > 0 && isFinite(m.duration) && m.duration > 0
    );
    return loaded.find(m => !m.paused) ||
      loaded.find(m => /\/SelectItem\/.*\.mp3/i.test(m.currentSrc || m.src || '')) ||
      loaded[0] || null;
  }

  function replay(audio) {
    try {
      audio.pause();
      audio.currentTime = 0;
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(err => console.warn('[cato-replay] play() failed:', err));
      }
    } catch (err) {
      console.warn('[cato-replay] replay error:', err);
    }
  }

  // Toggle pause/resume on the question audio.
  function togglePause() {
    const audio = findQuestionAudio() || findMedia();
    if (!audio) {
      console.warn('[cato-replay] no question audio on the page');
      return;
    }
    try {
      if (audio.paused) {
        const p = audio.play();
        if (p && typeof p.catch === 'function') {
          p.catch(err => console.warn('[cato-replay] play() failed:', err));
        }
      } else {
        audio.pause();
      }
    } catch (err) {
      console.warn('[cato-replay] pause/resume error:', err);
    }
    syncPauseLabel();
  }

  // Show "Pause" while the question audio is playing, "Resume" otherwise.
  function syncPauseLabel() {
    const btn = document.querySelector('.' + PAUSE_CLASS);
    if (!btn) return;
    const audio = findQuestionAudio();
    const playing = !!audio && !audio.paused;
    btn.textContent = playing ? '⏸' : '▶';
    btn.title = playing ? 'Pause (Space)' : 'Resume (Space)';
  }

  const BUTTON_STYLE = [
    'margin: 0',
    'padding: 6px 14px',
    'font-size: 16px',
    'cursor: pointer',
    'border: 1px solid #888',
    'border-radius: 4px',
    'background: #f5f5f5'
  ].join(';');

  // The question ID is the clip's file name, e.g. .../SelectItem/001/Q00446410.mp3 -> Q00446410.
  function clipId(src) {
    const m = /\/([A-Z]\d{8})\.mp3/i.exec(src || '');
    return m ? m[1].toUpperCase() : null;
  }

  // Question-bank lookup, one request per ID. Resolves to the bank's listening script, or null
  // when the bank has none for that ID. bankStatus keeps the result for the metrics panel.
  const bankCache = new Map();  // question ID -> Promise<string|null>
  const bankStatus = new Map(); // question ID -> 'checking' | 'yes' | 'no' | 'offline'

  function lookupBank(id) {
    if (!bankCache.has(id)) {
      bankStatus.set(id, 'checking');
      const p = new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: BANK_URL + encodeURIComponent(id),
          timeout: 15 * 1000,
          onload: r => {
            let body = null;
            try { body = JSON.parse(r.responseText); } catch (_) {}
            if (r.status === 200 && body && typeof body.text === 'string') resolve(body.text);
            else if (r.status === 404) resolve(null);
            else reject(new Error((body && body.error) || ('HTTP ' + r.status)));
          },
          onerror: () => reject(new Error(SERVER_HINT)),
          ontimeout: () => reject(new Error('question bank lookup timed out'))
        });
      });
      p.then(
        text => bankStatus.set(id, text ? 'yes' : 'no'),
        () => { bankStatus.set(id, 'offline'); bankCache.delete(id); } // retry on the next request
      );
      bankCache.set(id, p);
    }
    return bankCache.get(id);
  }

  // Transcript for a clip: the question bank's listening script when it has one (no Whisper run),
  // otherwise the local Whisper server.
  function transcribeAudio(src) {
    if (!transcriptCache.has(src)) {
      const id = clipId(src);
      const p = (id ? lookupBank(id) : Promise.resolve(null)).then(bankText => {
        if (bankText) return bankText;
        // Download the question mp3 and send it to the local Whisper server.
        return fetch(src, { credentials: 'include' })
          .then(res => {
            if (!res.ok) throw new Error('audio download failed: HTTP ' + res.status);
            return res.blob();
          })
          .then(blob => postForTranscript(blob));
      });
      p.catch(() => transcriptCache.delete(src)); // allow a retry after a failure
      transcriptCache.set(src, p);
    }
    return transcriptCache.get(src);
  }

  function postForTranscript(blob) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: TRANSCRIBE_URL,
        data: blob,
        headers: { 'Content-Type': 'application/octet-stream' },
        timeout: 10 * 60 * 1000,
        onload: r => {
          let body = null;
          try { body = JSON.parse(r.responseText); } catch (_) {}
          if (r.status >= 200 && r.status < 300 && body && typeof body.text === 'string') {
            resolve(body.text);
          } else {
            reject(new Error((body && body.error) || ('HTTP ' + r.status)));
          }
        },
        onerror: () => reject(new Error(SERVER_HINT)),
        ontimeout: () => reject(new Error('transcription timed out'))
      });
    });
  }

  // The transcript shown in the panel: the Chinese text and whether the English view is on.
  const transcriptView = { zh: '', en: false, opts: [] };

  // English for a transcript: the local translation model, through the server.
  function translateOnServer(zh) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: TRANSLATE_URL,
        data: JSON.stringify({ text: zh }),
        headers: { 'Content-Type': 'application/json' },
        timeout: 5 * 60 * 1000,
        onload: r => {
          let body = null;
          try { body = JSON.parse(r.responseText); } catch (_) {}
          if (r.status === 200 && body && typeof body.text === 'string') resolve(body.text);
          else reject(new Error((body && body.error) || ('HTTP ' + r.status)));
        },
        onerror: () => reject(new Error(SERVER_HINT)),
        ontimeout: () => reject(new Error('translation timed out'))
      });
    });
  }

  // Pinyin on/off, remembered in localStorage when the browser allows it (like the booklet).
  const pinyinState = { on: false };
  try { pinyinState.on = localStorage.getItem(PINYIN_PREF_KEY) === '1'; } catch (_) {}
  function setPinyinPref(on) {
    pinyinState.on = on;
    try { localStorage.setItem(PINYIN_PREF_KEY, on ? '1' : '0'); } catch (_) {}
  }
  const pinyinAvailable = () => typeof pinyinPro !== 'undefined' && !!pinyinPro.pinyin;

  const CJK = /[㐀-鿿]/;

  // Chinese text as DOM: one element per character (ruby with pinyin when on). The
  // data-i index is the character's position in the text, used by the dictionary popup.
  function renderZh(body, text, showPinyin) {
    body.textContent = '';
    const readings = showPinyin && pinyinAvailable()
      ? pinyinPro.pinyin(text, { type: 'array', toneType: 'symbol', nonZh: 'removed' })
      : null;
    let k = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n') { body.appendChild(document.createElement('br')); continue; }
      if (CJK.test(ch)) {
        const el = document.createElement(readings ? 'ruby' : 'span');
        el.className = TRANSCRIPT_TEXT_CLASS;
        el.dataset.i = String(i);
        el.textContent = ch;
        if (readings) {
          const rt = document.createElement('rt');
          rt.textContent = readings[k++] || '';
          el.appendChild(rt);
        }
        body.appendChild(el);
      } else {
        body.appendChild(document.createTextNode(ch));
      }
    }
  }

  // Dictionary, loaded once from the local server.
  let dictData = null;
  let dictPromise = null;
  function loadDict() {
    if (dictData) return Promise.resolve(dictData);
    if (!dictPromise) {
      dictPromise = new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: DICT_URL,
          timeout: 30 * 1000,
          onload: r => {
            let body = null;
            try { body = JSON.parse(r.responseText); } catch (_) {}
            if (r.status === 200 && body && typeof body === 'object') resolve(body);
            else reject(new Error((body && body.error) || ('HTTP ' + r.status)));
          },
          onerror: () => reject(new Error(SERVER_HINT)),
          ontimeout: () => reject(new Error('dictionary lookup timed out'))
        });
      });
      dictPromise.then(d => { dictData = d; }, () => { dictPromise = null; });
    }
    return dictPromise;
  }

  // Longest dictionary word starting at text[i] (up to 8 characters), as {word, entries} or null.
  function lookupAt(text, i, dict) {
    const max = Math.min(8, text.length - i);
    for (let n = max; n >= 1; n--) {
      const word = text.substr(i, n);
      if (Object.prototype.hasOwnProperty.call(dict, word)) return { word, entries: dict[word] };
    }
    return null;
  }

  // The popup remembers the text it was opened from, so Prev / Next step through its characters.
  let popupCtx = null; // { text, index }

  function cjkIndexes(text) {
    const out = [];
    for (let i = 0; i < text.length; i++) if (CJK.test(text[i])) out.push(i);
    return out;
  }

  function getPopup() {
    let pop = document.getElementById(POPUP_ID);
    if (!pop) {
      pop = document.createElement('div');
      pop.id = POPUP_ID;
      pop.hidden = true;
      pop.style.cssText = [
        'position: fixed',
        'left: 50%',
        'bottom: 16px',
        'transform: translateX(-50%)',
        'width: min(90vw, 420px)',
        'max-height: 50vh',
        'overflow: auto',
        'z-index: 10001',
        'padding: 12px 14px',
        'border: 1px solid #aaa',
        'border-radius: 6px',
        'background: #fff',
        'box-shadow: 0 6px 20px rgba(0,0,0,0.3)',
        'color: #222',
        'font-size: 16px',
        'line-height: 1.5',
        'user-select: text'
      ].join(';');
      document.body.appendChild(pop);
    }
    return pop;
  }

  function closePopup() {
    const pop = document.getElementById(POPUP_ID);
    if (pop) pop.hidden = true;
    popupCtx = null;
  }

  function renderPopup(dict) {
    const pop = getPopup();
    const { text, index } = popupCtx;
    const found = lookupAt(text, index, dict);
    const idx = cjkIndexes(text);
    const pos = idx.indexOf(index);
    const btnStyle = BUTTON_STYLE.replace('font-size: 16px', 'font-size: 13px').replace('padding: 6px 14px', 'padding: 2px 8px');

    const head = document.createElement('div');
    head.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 6px;';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.textContent = '← Prev';
    prev.style.cssText = btnStyle;
    prev.disabled = pos <= 0;
    prev.addEventListener('click', () => { popupCtx.index = idx[pos - 1]; renderPopup(dict); });
    const next = document.createElement('button');
    next.type = 'button';
    next.textContent = 'Next →';
    next.style.cssText = btnStyle;
    next.disabled = pos < 0 || pos >= idx.length - 1;
    next.addEventListener('click', () => { popupCtx.index = idx[pos + 1]; renderPopup(dict); });
    const counter = document.createElement('span');
    counter.textContent = (pos + 1) + ' / ' + idx.length;
    counter.style.cssText = 'font-size: 13px; color: #555;';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close');
    close.style.cssText = btnStyle + '; margin-left: auto;';
    close.addEventListener('click', closePopup);
    head.append(prev, counter, next, close);

    const word = document.createElement('div');
    word.textContent = found ? found.word : text[index];
    word.style.cssText = 'font-size: 28px; margin: 4px 0;';

    const body = document.createElement('div');
    if (!found) {
      body.textContent = 'No dictionary entry for this character.';
      body.style.color = '#666';
    } else {
      found.entries.forEach((e, n) => {
        if (n > 0) body.appendChild(document.createElement('hr'));
        const reading = document.createElement('div');
        reading.textContent = e.p;
        reading.style.cssText = 'color: #c0392b; font-weight: 600;';
        const def = document.createElement('div');
        def.textContent = e.d;
        body.append(reading, def);
      });
    }
    pop.replaceChildren(head, word, body);
    pop.hidden = false;
  }

  // Open the dictionary popup for the character at `index` in `text`.
  function openDictAt(text, index) {
    popupCtx = { text, index };
    const pop = getPopup();
    pop.hidden = false;
    loadDict().then(dict => {
      if (popupCtx && popupCtx.text === text) renderPopup(dict);
    }).catch(err => {
      pop.replaceChildren();
      const msg = document.createElement('div');
      msg.textContent = '⚠ ' + err.message;
      pop.appendChild(msg);
    });
  }

  // Arrow keys step through the characters while the popup is open; Escape closes it.
  document.addEventListener('keydown', (e) => {
    const pop = document.getElementById(POPUP_ID);
    if (!pop || pop.hidden || !popupCtx) return;
    if (e.key === 'Escape') { closePopup(); return; }
    const idx = cjkIndexes(popupCtx.text);
    const pos = idx.indexOf(popupCtx.index);
    if (e.key === 'ArrowLeft' && pos > 0) { popupCtx.index = idx[pos - 1]; loadDict().then(renderPopup); }
    if (e.key === 'ArrowRight' && pos >= 0 && pos < idx.length - 1) { popupCtx.index = idx[pos + 1]; loadDict().then(renderPopup); }
  });

  // Show the transcript and the answer options in the current view (Chinese or English).
  // The English and Pinyin buttons live in the top toolbar and apply to both blocks.
  function renderTranscript() {
    const panel = document.querySelector('.' + PANEL_CLASS);
    const body = panel && panel.querySelector('.' + TRANSCRIPT_BODY_CLASS);
    const optsBody = panel && panel.querySelector('.' + TRANSCRIPT_OPTS_CLASS);
    const enBtn = document.querySelector('.' + TRANSCRIPT_EN_CLASS);
    const pyBtn = document.querySelector('.' + TRANSCRIPT_PY_CLASS);
    if (enBtn) {
      enBtn.textContent = 'English: ' + (transcriptView.en ? 'on' : 'off');
      enBtn.setAttribute('aria-pressed', String(transcriptView.en));
    }
    if (pyBtn) {
      pyBtn.textContent = 'Pinyin: ' + (pinyinState.on ? 'on' : 'off');
      pyBtn.setAttribute('aria-pressed', String(pinyinState.on));
      pyBtn.disabled = !pinyinAvailable();
      pyBtn.title = pinyinAvailable() ? 'Pinyin (P)' : 'pinyin-pro did not load';
    }
    if (!body || !optsBody) return;
    const { zh, en, opts } = transcriptView;
    const optText = opts.join('\n');
    // The options are shown even before a transcript exists, so they always get pinyin/English too.
    if (!en) {
      if (zh) renderZh(body, zh, pinyinState.on); // otherwise keep the status message (e.g. "Transcribing…")
      if (optText) renderZh(optsBody, optText, pinyinState.on);
      else optsBody.textContent = '';
      return;
    }
    if (zh) {
      body.textContent = 'Translating… (first time can take a minute)';
      translateOnServer(zh).then(text => {
        // Ignore the result if the view or the transcript changed while loading.
        if (!transcriptView.en || transcriptView.zh !== zh) return;
        body.textContent = text;
      }).catch(err => {
        if (transcriptView.zh === zh) body.textContent = '⚠ ' + err.message;
      });
    }
    if (optText) {
      optsBody.textContent = 'Translating…';
      translateOnServer(optText).then(text => {
        if (transcriptView.en && transcriptView.opts.join('\n') === optText) optsBody.textContent = text;
      }).catch(err => {
        if (transcriptView.opts.join('\n') === optText) optsBody.textContent = '⚠ ' + err.message;
      });
    } else {
      optsBody.textContent = '';
    }
  }

  // Show a status message in the panel body (no transcript yet).
  function setTranscriptStatus(panel, message) {
    transcriptView.zh = '';
    panel.querySelector('.' + TRANSCRIPT_BODY_CLASS).textContent = message;
  }

  function setTranscriptText(panel, zh) {
    transcriptView.zh = zh;
    renderTranscript(panel);
  }

  function clearTranscript(panel) {
    transcriptView.zh = '';
    transcriptView.opts = [];
    panel.querySelector('.' + TRANSCRIPT_BODY_CLASS).textContent = '';
    panel.querySelector('.' + TRANSCRIPT_OPTS_CLASS).textContent = '';
  }

  // Build the tools row (English, Copy, Google Translate) and the text body inside the panel.
  function buildTranscriptPanel(panel, row) {
    const tools = document.createElement('div');
    tools.className = TRANSCRIPT_TOOLS_CLASS;
    tools.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 6px;';
    const toolStyle = BUTTON_STYLE.replace('font-size: 16px', 'font-size: 13px').replace('padding: 6px 14px', 'padding: 3px 8px');

    const enBtn = document.createElement('button');
    enBtn.type = 'button';
    enBtn.className = TRANSCRIPT_EN_CLASS;
    enBtn.style.cssText = toolStyle;
    enBtn.addEventListener('click', () => {
      transcriptView.en = !transcriptView.en;
      renderTranscript(panel);
    });

    const pyBtn = document.createElement('button');
    pyBtn.type = 'button';
    pyBtn.className = TRANSCRIPT_PY_CLASS;
    pyBtn.style.cssText = toolStyle;
    pyBtn.addEventListener('click', () => {
      setPinyinPref(!pinyinState.on);
      renderTranscript(panel);
    });

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.style.cssText = toolStyle;
    const msg = document.createElement('span');
    msg.className = TRANSCRIPT_MSG_CLASS;
    msg.style.cssText = 'font-size: 13px; color: #555;';
    copyBtn.addEventListener('click', async () => {
      // Copy plain text only: the Chinese without pinyin, or the English when that view is on.
      const body = panel.querySelector('.' + TRANSCRIPT_BODY_CLASS);
      const plain = transcriptView.en ? body.textContent : transcriptView.zh;
      try {
        await navigator.clipboard.writeText(plain);
        msg.textContent = transcriptView.en ? 'English copied' : 'Chinese copied';
      } catch (_) {
        msg.textContent = 'Copy failed';
      }
      setTimeout(() => { msg.textContent = ''; }, 1600);
    });

    const gtBtn = document.createElement('button');
    gtBtn.type = 'button';
    gtBtn.textContent = '文 → A';
    gtBtn.title = 'Open in Google Translate';
    gtBtn.style.cssText = toolStyle;
    gtBtn.addEventListener('click', () => {
      if (!transcriptView.zh) return;
      // The transcript plus the answer options, so Google Translate sees the whole question.
      const all = [transcriptView.zh, ...transcriptView.opts].join('\n');
      const url = 'https://translate.google.com/?sl=zh-TW&tl=en&text=' +
        encodeURIComponent(all) + '&op=translate';
      window.open(url, '_blank', 'noopener');
    });

    const body = document.createElement('div');
    body.className = TRANSCRIPT_BODY_CLASS;
    body.style.cssText = 'white-space: pre-wrap;';
    // Click a Chinese character to open the dictionary popup for the word at that point.
    body.addEventListener('click', (e) => {
      const z = e.target.closest ? e.target.closest('.' + TRANSCRIPT_TEXT_CLASS) : null;
      if (z && transcriptView.zh && !transcriptView.en) openDictAt(transcriptView.zh, Number(z.dataset.i));
    });

    // The answer options, shown under the transcript with the same pinyin and English views.
    const optsBody = document.createElement('div');
    optsBody.className = TRANSCRIPT_OPTS_CLASS;
    optsBody.style.cssText = 'white-space: pre-wrap; margin-top: 8px; padding-top: 6px; border-top: 1px dashed #bbb;';

    // English and Pinyin sit in the top toolbar; copy and Google Translate stay in the panel.
    row.append(enBtn, pyBtn);
    tools.append(copyBtn, gtBtn, msg);
    panel.append(tools, body, optsBody);
    renderTranscript(panel);
  }

  // The answer options on the page as "A. …" lines (pinyin annotations removed).
  function optionLines() {
    const found = {};
    for (const r of document.querySelectorAll('input[type=radio]')) {
      const cell = r.closest('td') || r.parentElement;
      if (!cell) continue;
      const clone = cell.cloneNode(true);
      clone.querySelectorAll('rt, rp').forEach(n => n.remove());
      const m = /\(\s*([A-D])\s*\)\s*(.+)/.exec(clone.textContent.replace(/\s+/g, ' '));
      // The page also shows an English translation after the Chinese; keep only the Chinese part.
      if (m && !found[m[1]]) found[m[1]] = m[2].split(/\)\s*[A-Za-z]/)[0].replace(/\)\s*$/, '').trim();
    }
    return ['A', 'B', 'C', 'D'].filter(k => found[k]).map(k => `${k}. ${found[k]}`);
  }

  // Show or hide the transcript panel for the current question.
  function toggleTranscript() {
    const audio = findQuestionAudio();
    const panel = document.querySelector('.' + PANEL_CLASS);
    if (!audio || !panel) return;
    const src = audio.currentSrc || audio.src;

    if (!panel.hidden && panel.dataset.src === src) {
      panel.hidden = true;
    } else {
      panel.dataset.src = src;
      panel.hidden = false;
      setTranscriptStatus(panel, 'Transcribing…');
      transcriptView.opts = optionLines();
      transcribeAudio(src)
        .then(text => { if (panel.dataset.src === src) setTranscriptText(panel, text); })
        .catch(err => { if (panel.dataset.src === src) setTranscriptStatus(panel, '⚠ ' + err.message); });
    }
    syncTranscriptControls();
  }

  // Keep the button label in step with the panel, and clear the panel when the question changes.
  function syncTranscriptControls() {
    const panel = document.querySelector('.' + PANEL_CLASS);
    const btn = document.querySelector('.' + TRANSCRIPT_CLASS);
    if (!panel || !btn) return;
    const audio = findQuestionAudio();
    const src = audio ? (audio.currentSrc || audio.src) : null;
    if (panel.dataset.src && panel.dataset.src !== src) {
      panel.hidden = true;
      clearTranscript(panel);
      delete panel.dataset.src;
    }
    btn.textContent = panel.hidden ? '📝' : '✖';
    btn.title = panel.hidden ? 'Transcript (T)' : 'Hide transcript (T)';
    // Keep the overlay just below the button row, wherever the row sits on the page.
    if (!panel.hidden) {
      panel.style.top = (btn.getBoundingClientRect().bottom + 6) + 'px';
    }
  }

  // Test-state fields from the page's hidden #AlertMessageAlert block, with display labels.
  // The correct answer (LabAnswer) is not in this list. It has its own row that stays
  // hidden until the user presses "Show answer".
  const METRIC_FIELDS = [
    ['LabNum', 'Answered'],
    ['LabOrder', 'Position'],
    ['TestNumber', 'Questions'],
    ['LabGroupHead', 'Passage ID'],
    ['LabTheta', 'θ (ability)'],
    ['LabB', 'b (difficulty)'],
    ['LEVEL', 'Level'],
    ['LabAbility', 'Accuracy'],
    ['LabType2_Amount', 'Stop after (questions)'],
    ['LabType2_Ability', 'Stop at ability'],
    ['LabType3_Amount', 'Total questions'],
    ['LabType5_Time', 'Time per question'],
    ['LabStatus', 'Status']
  ];

  // A span's own value is the text before its first child element. The page leaves
  // these spans unclosed, so the following labels end up nested inside them.
  function ownText(el) {
    let out = '';
    for (const n of el.childNodes) {
      if (n.nodeType === Node.ELEMENT_NODE) break;
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
    }
    return out.trim();
  }

  // The question numbers shown on the page, e.g. "5-10)" -> "5–10 (6 questions)", "18)" -> "18".
  function questionRange() {
    const el = document.getElementById('TestNumber');
    if (!el) return 'n/a';
    const text = el.textContent || '';
    const range = /(\d+)\s*-\s*(\d+)/.exec(text);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      return from + '–' + to + ' (' + (to - from + 1) + ' questions)';
    }
    const single = /(\d+)/.exec(text);
    return single ? single[1] : '—';
  }

  // Level from the item's IRT difficulty b (the "B(難度)" value on the page). Items below the
  // cut-off are Basic, the rest Advanced. The cut-off is an assumption to calibrate, not a published figure.
  const LEVEL_B_CUT = 1.0;
  function itemLevel() {
    const el = document.getElementById('LabB');
    const b = el ? parseFloat(ownText(el)) : NaN;
    if (!isFinite(b)) return 'n/a';
    return (b < LEVEL_B_CUT ? 'Basic (A)' : 'Advanced (B)') + ' · b ' + b.toFixed(2);
  }

  function readMetrics() {
    return METRIC_FIELDS.map(([id, label]) => {
      if (id === 'TestNumber') return [label, questionRange()];
      if (id === 'LEVEL') return [label, itemLevel()];
      const el = document.getElementById(id);
      return [label, el ? (ownText(el) || '—') : 'n/a'];
    });
  }

  // The item whose correct answer the user has chosen to reveal (null = hidden).
  let revealedItem = null;

  function currentItemId() {
    const el = document.getElementById('LabNo');
    return el ? ownText(el) : '';
  }

  function answerText() {
    const el = document.getElementById('LabAnswer');
    return el ? ownText(el) : '';
  }

  function toggleMetrics() {
    const panel = document.querySelector('.' + METRICS_PANEL_CLASS);
    if (!panel) return;
    panel.hidden = !panel.hidden;
    syncMetrics();
  }

  const BANK_LABEL = {
    checking: 'checking…',
    yes: 'found (transcript from bank)',
    no: 'not in bank (Whisper)',
    offline: 'server not running'
  };

  // Official CAT pass levels (通過標準) on the TOCFL site, for the live mock test result.
  const CAT_PASS_URL = 'https://tocfl.edu.tw/tocfl/index.php/test/cat/list/3';

  // Answers seen this session: question ID -> {key, student, correct}. Recorded once the
  // student has picked an option and the answer key is on the page.
  const answerLog = new Map();
  function recordAnswer() {
    const id = currentItemId();
    const key = answerText().toUpperCase();
    const checked = document.querySelector('input[type=radio]:checked');
    if (!id || !/^[A-D]$/.test(key) || !checked) return;
    const student = String(checked.value || '').charAt(0).toUpperCase();
    if (!/^[A-D]$/.test(student)) return;
    answerLog.set(id, { key, student, correct: student === key });
  }

  function answerSummary() {
    const n = answerLog.size;
    if (!n) return 'no answers yet';
    const c = [...answerLog.values()].filter(a => a.correct).length;
    return c + ' / ' + n + ' correct (' + Math.round((100 * c) / n) + '%)';
  }

  // Refresh the metrics table while the panel is open; rebuild only when a value changed.
  function syncMetrics() {
    const panel = document.querySelector('.' + METRICS_PANEL_CLASS);
    const btn = document.querySelector('.' + METRICS_CLASS);
    if (!panel || !btn) return;
    btn.textContent = panel.hidden ? '📊' : '✖';
    btn.title = panel.hidden ? 'Test metrics (M)' : 'Hide metrics (M)';
    if (panel.hidden) return;

    panel.style.top = (btn.getBoundingClientRect().bottom + 6) + 'px';
    const rows = readMetrics();
    // Whether the clip the buttons control is in the question bank (its transcript then comes from the bank).
    const clip = findQuestionAudio();
    const bankId = clip ? clipId(srcOf(clip)) : null;
    if (bankId && !bankStatus.has(bankId)) lookupBank(bankId);
    rows.push(['Question bank', BANK_LABEL[bankStatus.get(bankId)] || '—']);
    rows.push(['Correct this session', answerSummary()]);
    const itemId = currentItemId();
    const revealed = !!itemId && revealedItem === itemId;
    const key = JSON.stringify([rows, itemId, revealed ? answerText() : null]);
    if (panel.dataset.key === key) return;
    panel.dataset.key = key;

    const table = document.createElement('table');
    table.style.cssText = 'width: 100%; border-collapse: collapse;';
    for (const [label, value] of rows) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = label;
      th.style.cssText = 'text-align: left; font-weight: normal; color: #555; padding: 3px 12px 3px 0;';
      const td = document.createElement('td');
      td.textContent = value;
      td.style.cssText = 'text-align: right; font-variant-numeric: tabular-nums; padding: 3px 0;';
      tr.append(th, td);
      table.appendChild(tr);
    }
    // Correct-answer row: hidden by default, and hidden again when the item changes.
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = 'Correct answer';
    th.style.cssText = 'text-align: left; font-weight: normal; color: #555; padding: 3px 12px 3px 0;';
    const td = document.createElement('td');
    td.style.cssText = 'text-align: right; padding: 3px 0;';
    if (revealed) {
      td.textContent = answerText() || '—';
    }
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = revealed ? 'Hide' : 'Show answer';
    toggle.style.cssText = 'margin-left: ' + (revealed ? '8px' : '0') + '; font-size: 13px; padding: 2px 8px; cursor: pointer;';
    toggle.addEventListener('click', () => {
      revealedItem = revealed ? null : currentItemId();
      syncMetrics();
    });
    td.appendChild(toggle);
    tr.append(th, td);
    table.appendChild(tr);

    // Footer: link to the official CAT pass levels, for checking the live mock test result.
    const footer = document.createElement('div');
    footer.style.cssText = 'margin-top: 8px; padding-top: 6px; border-top: 1px dashed #bbb; font-size: 13px;';
    const link = document.createElement('a');
    link.href = CAT_PASS_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Official CAT pass levels ↗';
    footer.append(link);

    panel.replaceChildren(table, footer);
  }

  function addButton() {
    // The reading passage is loaded in an iframe. Only the main page and frames that hold a
    // listening clip get a toolbar, so the iframe does not add a second metrics button.
    if (window.top !== window.self && !questionClips().length) return;
    // The toolbar is built on every CATO page, so the metrics button also shows on reading pages.
    if (!document.querySelector('.' + TOOLBAR_CLASS)) {
      const heading = document.querySelector('h1, h2');
      const parent = heading ? heading.parentNode : document.body;
      // Insert after the heading, or at the top of the body if there is no heading.
      const anchorNode = heading ? heading.nextSibling : document.body.firstChild;

      // The wrapper has zero height and the buttons are absolutely positioned in it,
      // so the buttons take no vertical space and nothing below them moves.
      const wrap = document.createElement('div');
      wrap.className = TOOLBAR_CLASS;
      wrap.style.cssText = 'position: relative; height: 0; margin: 0; padding: 0; overflow: visible;';

      const row = document.createElement('div');
      row.style.cssText = [
        'position: absolute',
        'top: ' + TOOLBAR_TOP_PX + 'px',
        'left: 50%',
        'transform: translateX(-50%)',
        'display: flex',
        'gap: 6px',
        'white-space: nowrap',
        'z-index: 9999'
      ].join(';');
      wrap.appendChild(row);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = BUTTON_CLASS;
      btn.textContent = '↻';
      btn.title = 'Replay (R)';
      btn.style.cssText = BUTTON_STYLE;
      // Look the audio up on each click: the site swaps in a new element per question.
      btn.addEventListener('click', () => {
        const current = findQuestionAudio();
        if (current) replay(current);
        else console.warn('[cato-replay] no question audio on the page');
      });
      row.appendChild(btn);

      const pauseBtn = document.createElement('button');
      pauseBtn.type = 'button';
      pauseBtn.className = PAUSE_CLASS;
      pauseBtn.textContent = '⏸';
      pauseBtn.title = 'Pause (Space)';
      pauseBtn.style.cssText = BUTTON_STYLE;
      pauseBtn.addEventListener('click', togglePause);
      row.appendChild(pauseBtn);

      const tBtn = document.createElement('button');
      tBtn.type = 'button';
      tBtn.className = TRANSCRIPT_CLASS;
      tBtn.textContent = '📝';
      tBtn.title = 'Transcript (T)';
      tBtn.style.cssText = BUTTON_STYLE;
      tBtn.addEventListener('click', toggleTranscript);
      row.appendChild(tBtn);

      const mBtn = document.createElement('button');
      mBtn.type = 'button';
      mBtn.className = METRICS_CLASS;
      mBtn.textContent = '📊';
      mBtn.title = 'Test metrics (M)';
      mBtn.style.cssText = BUTTON_STYLE;
      mBtn.addEventListener('click', toggleMetrics);
      row.appendChild(mBtn);

      // Prev / next clip for passages with several questions. Hidden unless the item has more than one clip.
      const nav = document.createElement('span');
      nav.className = CLIP_NAV_CLASS;
      nav.style.cssText = 'display: none; align-items: center; gap: 4px;';
      const navBtn = (role, icon, title, delta) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.role = role;
        b.textContent = icon;
        b.title = title;
        b.style.cssText = BUTTON_STYLE.replace('font-size: 16px', 'font-size: 14px');
        b.addEventListener('click', () => stepClip(delta));
        return b;
      };
      const label = document.createElement('span');
      label.dataset.role = 'label';
      label.style.cssText = 'font-size: 14px; min-width: 9em; text-align: center;';
      nav.append(navBtn('prev', '⏮', 'Previous clip ([)', -1), label, navBtn('next', '⏭', 'Next clip (])', 1));
      row.appendChild(nav);

      // Metrics panel: a fixed overlay on the right, hidden until the button is pressed.
      const mPanel = document.createElement('div');
      mPanel.className = METRICS_PANEL_CLASS;
      mPanel.hidden = true;
      mPanel.style.cssText = [
        'position: fixed',
        'top: 110px',
        'right: 12px',
        'width: min(90vw, 320px)',
        'max-height: 60vh',
        'overflow: auto',
        'z-index: 10000',
        'padding: 10px 12px',
        'border: 1px solid #ccc',
        'border-radius: 4px',
        'background: #fff',
        'box-shadow: 0 4px 16px rgba(0,0,0,0.25)',
        'font-size: 14px',
        'line-height: 1.4',
        'color: #222',
        'user-select: text'
      ].join(';');
      document.body.appendChild(mPanel);

      // The panel is a fixed overlay, so it is placed outside the zero-height wrapper.
      const panel = document.createElement('div');
      panel.className = PANEL_CLASS;
      panel.hidden = true;
      panel.style.cssText = [
        'position: fixed',
        'top: 110px',
        'left: 50%',
        'transform: translateX(-50%)',
        'width: min(90vw, 700px)',
        'max-height: 45vh',
        'overflow: auto',
        'z-index: 10000',
        'padding: 10px 12px',
        'border: 1px solid #ccc',
        'border-radius: 4px',
        'background: #fff',
        'box-shadow: 0 4px 16px rgba(0,0,0,0.25)',
        'font-size: 16px',
        'line-height: 1.8',
        'white-space: pre-wrap',
        'user-select: text'
      ].join(';');

      buildTranscriptPanel(panel, row);
      parent.insertBefore(wrap, anchorNode);
      parent.insertBefore(panel, wrap.nextSibling);
    }
    // Replay, pause and transcript only apply to a listening clip; the metrics button is always shown.
    const hasAudio = !!findQuestionAudio();
    document.querySelectorAll('.' + BUTTON_CLASS + ', .' + PAUSE_CLASS + ', .' + TRANSCRIPT_CLASS + ', .' + TRANSCRIPT_EN_CLASS + ', .' + TRANSCRIPT_PY_CLASS)
      .forEach(el => { el.style.display = hasAudio ? '' : 'none'; });
    syncPauseLabel();
    syncTranscriptControls();
    syncMetrics();
    syncClipNav();
  }

  // Make the playback progress bar seekable: press or drag anywhere on it
  // to jump to that point in the question audio.
  function enableSeek() {
    const bar = document.getElementById('MediaDurationBar');
    if (!bar || bar.dataset.catoSeek) return;
    bar.dataset.catoSeek = '1';
    bar.style.cursor = 'pointer';
    bar.style.touchAction = 'none';

    let dragging = false;

    function seekTo(e) {
      const audio = findMedia();
      if (!audio) return;
      const rect = bar.getBoundingClientRect();
      if (rect.width <= 0) return;
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      audio.currentTime = frac * audio.duration;
      // Move the visual fill right away; the site updates it again on its next tick.
      const fill = bar.querySelector('.ui-progressbar-value');
      if (fill) fill.style.width = (frac * 100) + '%';
    }

    bar.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { bar.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
      seekTo(e);
    });
    bar.addEventListener('pointermove', (e) => { if (dragging) seekTo(e); });
    const stop = () => { dragging = false; };
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
  }

  // Select the visible, enabled answer option with this letter (A–D).
  function chooseOption(letter) {
    const radios = [...document.querySelectorAll('input[type=radio]')]
      .filter(r => r.offsetParent !== null && !r.disabled);
    const match = radios.find(r => {
      const cell = r.closest('td') || r.parentElement;
      const m = cell && /\(\s*([A-D])\s*\)/.exec(cell.textContent);
      return m && m[1] === letter;
    });
    if (!match) return false;
    match.click();
    return true;
  }

  // Keyboard shortcuts, ignored while typing in a field:
  // Space pause/resume, R replay, T transcript, E English, P pinyin, M metrics, [ / ] previous / next clip,
  // N next question (the test's own Next button).
  // Capture phase on window: runs before the page's own key handlers, so a key handled here
  // (e.g. P for pinyin) does not also trigger the page's own shortcut (e.g. play/pause).
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target || {};
    const tag = target.tagName || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || target.isContentEditable) return;
    const popup = document.getElementById(POPUP_ID);
    if (popup && !popup.hidden && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Escape')) return;

    // Click a control if it is on the page and shown (e.g. audio controls are hidden on reading pages).
    const press = (cls) => {
      const el = document.querySelector('.' + cls);
      if (!el || el.style.display === 'none' || el.disabled) return false;
      el.click();
      return true;
    };
    const pressClip = (role) => {
      const nav = document.querySelector('.' + CLIP_NAV_CLASS);
      if (!nav || nav.style.display === 'none') return false;
      const b = nav.querySelector('[data-role="' + role + '"]');
      if (!b || b.disabled) return false;
      b.click();
      return true;
    };

    let handled = false;
    switch (e.key) {
      case ' ':
        // A focused button already handles Space itself, so only act when no button has focus.
        if (tag !== 'BUTTON') handled = press(PAUSE_CLASS);
        break;
      case 'r': case 'R': handled = press(BUTTON_CLASS); break;
      case 't': case 'T': handled = press(TRANSCRIPT_CLASS); break;
      case 'e': case 'E': handled = press(TRANSCRIPT_EN_CLASS); break;
      case 'p': case 'P': handled = press(TRANSCRIPT_PY_CLASS); break;
      case 'm': case 'M': handled = press(METRICS_CLASS); break;
      case '[': handled = pressClip('prev'); break;
      case ']': handled = pressClip('next'); break;
      case 'n': case 'N': {
        // The test's own next-question button (the page's next()). Skipped if it is not shown.
        const nextImg = document.getElementById('imgNext');
        if (nextImg && nextImg.offsetParent !== null) { nextImg.click(); handled = true; }
        break;
      }
      case 'a': case 'A': case 'b': case 'B': case 'c': case 'C': case 'd': case 'D':
        // Select an answer option (does not submit it). Skipped when the option is hidden or disabled.
        handled = chooseOption(e.key.toUpperCase());
        break;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // The site loads each question separately and may remove the button,
  // so keep checking for as long as the page is open.
  function tick() {
    addButton();
    syncPauseLabel();
    syncTranscriptControls();
    recordAnswer();
    syncMetrics();
    syncClipNav();
    enableSeek();
  }
  tick();
  setInterval(tick, 500);
})();
