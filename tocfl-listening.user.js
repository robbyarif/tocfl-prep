// ==UserScript==
// @name         TOCFL listening replay
// @namespace    local.tocfl-listening
// @version      0.6.0
// @description  Adds Replay, Pause/Resume, a transcript (via a local Whisper server), a test metrics panel and drag-to-seek on the progress bar to the 華測會 CATO TOCFL test page for listening audio.
// @match        https://cbt.sc-top.org.tw/cato/*
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
    btn.title = playing ? 'Pause' : 'Resume';
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
      panel.textContent = 'Transcribing…';
      transcribeAudio(src)
        .then(text => { if (panel.dataset.src === src) panel.textContent = text; })
        .catch(err => { if (panel.dataset.src === src) panel.textContent = '⚠ ' + err.message; });
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
      panel.textContent = '';
      delete panel.dataset.src;
    }
    btn.textContent = panel.hidden ? '📝' : '✖';
    btn.title = panel.hidden ? 'Transcript' : 'Hide transcript';
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

  function readMetrics() {
    return METRIC_FIELDS.map(([id, label]) => {
      if (id === 'TestNumber') return [label, questionRange()];
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

  // Refresh the metrics table while the panel is open; rebuild only when a value changed.
  function syncMetrics() {
    const panel = document.querySelector('.' + METRICS_PANEL_CLASS);
    const btn = document.querySelector('.' + METRICS_CLASS);
    if (!panel || !btn) return;
    btn.textContent = panel.hidden ? '📊' : '✖';
    btn.title = panel.hidden ? 'Test metrics' : 'Hide metrics';
    if (panel.hidden) return;

    panel.style.top = (btn.getBoundingClientRect().bottom + 6) + 'px';
    const rows = readMetrics();
    // Whether the clip the buttons control is in the question bank (its transcript then comes from the bank).
    const clip = findQuestionAudio();
    const bankId = clip ? clipId(srcOf(clip)) : null;
    if (bankId && !bankStatus.has(bankId)) lookupBank(bankId);
    rows.push(['Question bank', BANK_LABEL[bankStatus.get(bankId)] || '—']);
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

    panel.replaceChildren(table);
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
      btn.title = 'Replay';
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
      pauseBtn.title = 'Pause';
      pauseBtn.style.cssText = BUTTON_STYLE;
      pauseBtn.addEventListener('click', togglePause);
      row.appendChild(pauseBtn);

      const tBtn = document.createElement('button');
      tBtn.type = 'button';
      tBtn.className = TRANSCRIPT_CLASS;
      tBtn.textContent = '📝';
      tBtn.title = 'Transcript';
      tBtn.style.cssText = BUTTON_STYLE;
      tBtn.addEventListener('click', toggleTranscript);
      row.appendChild(tBtn);

      const mBtn = document.createElement('button');
      mBtn.type = 'button';
      mBtn.className = METRICS_CLASS;
      mBtn.textContent = '📊';
      mBtn.title = 'Test metrics';
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
      nav.append(navBtn('prev', '⏮', 'Previous clip', -1), label, navBtn('next', '⏭', 'Next clip', 1));
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

      parent.insertBefore(wrap, anchorNode);
      parent.insertBefore(panel, wrap.nextSibling);
    }
    // Replay, pause and transcript only apply to a listening clip; the metrics button is always shown.
    const hasAudio = !!findQuestionAudio();
    document.querySelectorAll('.' + BUTTON_CLASS + ', .' + PAUSE_CLASS + ', .' + TRANSCRIPT_CLASS)
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

  // The site loads each question separately and may remove the button,
  // so keep checking for as long as the page is open.
  function tick() {
    addButton();
    syncPauseLabel();
    syncTranscriptControls();
    syncMetrics();
    syncClipNav();
    enableSeek();
  }
  tick();
  setInterval(tick, 500);
})();
