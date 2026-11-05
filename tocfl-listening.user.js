// ==UserScript==
// @name         TOCFL listening replay
// @namespace    local.tocfl-listening
// @version      0.1.0
// @description  Adds a Replay button and drag-to-seek on the progress bar to the 華測會 CATO TOCFL test page for listening audio.
// @match        https://cbt.sc-top.org.tw/cato/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const BUTTON_CLASS = 'cato-replay-btn';

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

  function addButton() {
    if (document.querySelector('.' + BUTTON_CLASS)) return;
    if (!findQuestionAudio()) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BUTTON_CLASS;
    btn.textContent = '重播 Replay';
    btn.style.cssText = [
      'margin: 8px 0',
      'padding: 6px 14px',
      'font-size: 16px',
      'cursor: pointer',
      'border: 1px solid #888',
      'border-radius: 4px',
      'background: #f5f5f5'
    ].join(';');
    // Look the audio up on each click: the site swaps in a new element per question.
    btn.addEventListener('click', () => {
      const current = findQuestionAudio();
      if (current) replay(current);
      else console.warn('[cato-replay] no question audio on the page');
    });

    const heading = document.querySelector('h1, h2');
    (heading ? heading.parentNode : document.body).insertBefore(
      btn,
      heading ? heading.nextSibling : document.body.firstChild
    );
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
    enableSeek();
  }
  tick();
  setInterval(tick, 500);
})();
