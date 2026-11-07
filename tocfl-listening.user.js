// ==UserScript==
// @name         TOCFL listening replay
// @namespace    local.tocfl-listening
// @version      0.3.0
// @description  Adds Replay, Pause/Resume, a transcript (via a local Whisper server) and drag-to-seek on the progress bar to the 華測會 CATO TOCFL test page for listening audio.
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
  const TOOLBAR_CLASS = 'cato-toolbar';
  // Distance from the top of the button row to the top of the buttons, in px.
  const TOOLBAR_TOP_PX = 8;
  // Local transcription server (npm run transcribe in the project folder).
  const TRANSCRIBE_URL = 'http://127.0.0.1:8787/transcribe';
  const SERVER_HINT = 'Transcription server not running. Start it with: npm run transcribe';
  // Audio URL -> Promise of transcript text, so each clip is transcribed once.
  const transcriptCache = new Map();

  // Find the question audio: the site loads it from /cato/SelectItem/.../*.mp3
  function findQuestionAudio() {
    return [...document.querySelectorAll('audio')].find(a =>
      /\/SelectItem\/.*\.mp3/i.test(a.currentSrc || a.src || '')
    ) || null;
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

  // Download the question mp3 and send it to the local Whisper server.
  function transcribeAudio(src) {
    if (!transcriptCache.has(src)) {
      const p = fetch(src, { credentials: 'include' })
        .then(res => {
          if (!res.ok) throw new Error('audio download failed: HTTP ' + res.status);
          return res.blob();
        })
        .then(blob => postForTranscript(blob));
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

  function addButton() {
    if (!findQuestionAudio()) return;

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
    syncPauseLabel();
    syncTranscriptControls();
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
    enableSeek();
  }
  tick();
  setInterval(tick, 500);
})();
