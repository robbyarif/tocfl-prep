// App controller: hash routing, home, the two modes, the session loop, results,
// and the review history.
import { loadBank, SKILL_NAME } from './data.js';
import { loadPinyin, escapeHtml } from './pinyin.js';
import { questionCard } from './quiz.js';
import {
  getPinyinPref, setPinyinPref, overallStats,
  loadSessions, saveSession, deleteSession, importSessions,
} from './store.js';
import { createAdaptiveState, applyAnswer, estimateLevel, pickQuestion } from './adaptive.js';

// Official passing scores (通過標準) from tocfl.edu.tw, on the scaled score out of 80.
// Question counts are not published, so a raw "questions to pass" figure cannot be given.
const PASS_SCORES = {
  A: [
    { level: 'A1', name: '入門級', score: 42 },
    { level: 'A2', name: '基礎級', score: 60 },
  ],
  B: [
    { level: 'B1', name: '進階級', score: 48 },
    { level: 'B2', name: '高階級', score: 64 },
  ],
};

const app = document.getElementById('app');
const pinyinBtn = document.getElementById('pinyin-toggle');

let bank = null;
let byId = null;           // question id -> question
let session = null;        // running practice or adaptive session
let currentCard = null;    // question card on screen (refreshed by the pinyin toggle)

const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

const fmtDate = (ms) => new Date(ms).toLocaleString();

// Pass-score banner for the bands in play. Shown at the start and the end of a session.
function passBanner(bands) {
  const rows = bands
    .map((b) => `<li><strong>${escapeHtml(bank.bands[b])}</strong>: ${PASS_SCORES[b]
      .map((p) => `${p.level} ${escapeHtml(p.name)} <strong>${p.score}</strong>`).join(' · ')}</li>`)
    .join('');
  return `
    <div class="card pass">
      <strong>Official pass scores</strong> <span class="muted">(scaled score, out of 80)</span>
      <ul>${rows}</ul>
      <p class="muted">The pass mark is a scaled score, not a number of questions, so it can't be turned into a question count. Your % correct is shown for comparison only.</p>
    </div>`;
}

// ----- pinyin toggle -----
function paintPinyinButton() {
  const on = getPinyinPref();
  pinyinBtn.textContent = `拼音 Pinyin: ${on ? 'on' : 'off'}`;
  pinyinBtn.setAttribute('aria-pressed', String(on));
}
pinyinBtn.addEventListener('click', () => {
  setPinyinPref(!getPinyinPref());
  paintPinyinButton();
  if (currentCard) currentCard.refresh();
});

// ----- routing -----
function route() {
  const path = (location.hash.replace(/^#/, '') || '/').replace(/\/$/, '') || '/';
  currentCard = null;
  if (path === '/') return home();
  if (path === '/practice') return practiceSetup();
  if (path === '/adaptive') return adaptiveSetup();
  if (path === '/reviews') return reviewsList();
  if (path === '/run') {
    if (!session) { location.hash = '#/'; return; }
    return session.mode === 'practice' ? renderPractice() : renderAdaptive();
  }
  const m = path.match(/^\/review\/(.+)$/);
  if (m) return reviewSession(decodeURIComponent(m[1]));
  location.hash = '#/';
}
window.addEventListener('hashchange', route);

// ----- home -----
function home() {
  const s = overallStats();
  const counts = Object.entries(bank.counts)
    .map(([k, n]) => {
      const [band, skill] = k.split('_');
      return `${bank.bands[band]} ${SKILL_NAME[skill]}: ${n}`;
    })
    .join(' · ');
  const sessions = loadSessions().length;
  app.innerHTML = `
    <h1>TOCFL 模擬試題 Mock questions</h1>
    <p class="stat-line">${escapeHtml(counts)}</p>
    <p class="stat-line">Your answers so far: ${s.total} (${pct(s.correct, s.total)}% correct) · Saved sessions: ${sessions}</p>
    <div class="grid" style="margin-top:16px">
      <a class="card" href="#/practice" style="text-decoration:none;color:inherit">
        <h2>1 · Select difficulty</h2>
        <p class="muted">Choose Basic and/or Advanced, the skills and the question types, then work through them.</p>
      </a>
      <a class="card" href="#/adaptive" style="text-decoration:none;color:inherit">
        <h2>2 · Adjust difficulty</h2>
        <p class="muted">Starts at Basic. Two correct answers in a row move you to Advanced; a wrong answer at Advanced moves you back down. Ends with an estimated level.</p>
      </a>
      <a class="card" href="#/reviews" style="text-decoration:none;color:inherit">
        <h2>3 · Reviews</h2>
        <p class="muted">Open saved sessions to go back over each question, your choice and the answer. Export or import your history as a file.</p>
      </a>
    </div>`;
}

// ----- setup: select difficulty -----
function typeKey(q) { return `${q.band}|${q.skill}|${q.type}`; }

function practiceSetup() {
  const groups = new Map();
  for (const q of bank.questions) {
    if (!q.answer) continue;
    const k = typeKey(q);
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  const typeBoxes = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => {
      const [band, skill, type] = k.split('|');
      return `<label><input type="checkbox" name="type" value="${escapeHtml(k)}" checked>
        ${escapeHtml(bank.bands[band])} · ${SKILL_NAME[skill]} · ${escapeHtml(type)} <span class="muted">(${n})</span></label>`;
    })
    .join('');

  app.innerHTML = `
    <h1>1 · Select difficulty</h1>
    <form class="card" id="setup">
      <div class="field"><span class="label">Band</span>
        <div class="checks">
          <label><input type="checkbox" name="band" value="A" checked> Basic (入門基礎)</label>
          <label><input type="checkbox" name="band" value="B" checked> Advanced (進階高階)</label>
        </div>
      </div>
      <div class="field"><span class="label">Skill</span>
        <div class="checks">
          <label><input type="checkbox" name="skill" value="L" checked> Listening</label>
          <label><input type="checkbox" name="skill" value="R" checked> Reading</label>
        </div>
      </div>
      <div class="field"><span class="label">Question types</span>
        <div class="checks">${typeBoxes}</div>
      </div>
      <div class="field"><span class="label">Number of questions</span>
        <select name="count">
          <option value="10">10</option>
          <option value="20" selected>20</option>
          <option value="50">50</option>
          <option value="all">All matching</option>
        </select>
      </div>
      <p class="error" id="setup-error" hidden></p>
      <div class="row"><button class="btn primary" type="submit">Start</button>
      <a class="btn" href="#/">Back</a></div>
    </form>
    ${passBanner(['A', 'B'])}`;

  document.getElementById('setup').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const bands = f.getAll('band');
    const skills = f.getAll('skill');
    const types = new Set(f.getAll('type'));
    const pool = bank.questions.filter((q) => q.answer && bands.includes(q.band) && skills.includes(q.skill) && types.has(typeKey(q)));
    const err = document.getElementById('setup-error');
    if (!pool.length) {
      err.textContent = 'No questions match these choices.';
      err.hidden = false;
      return;
    }
    const want = f.get('count');
    const queue = shuffle(pool).slice(0, want === 'all' ? pool.length : Number(want));
    const label = `Select difficulty · ${bands.map((b) => bank.bands[b]).join(' + ')} · ${skills.map((s) => SKILL_NAME[s]).join(' + ')} · ${queue.length} questions`;
    session = {
      id: newId(), mode: 'practice', label, startedAt: Date.now(), finished: false,
      bands, queue, index: 0, correct: 0, missed: [], records: [],
    };
    persist();
    location.hash = '#/run';
  });
}

// ----- setup: adjust difficulty -----
function adaptiveSetup() {
  app.innerHTML = `
    <h1>2 · Adjust difficulty</h1>
    <form class="card" id="setup">
      <p class="muted">Starts at Basic. Two correct answers in a row move up to Advanced; a wrong answer at Advanced moves back down. Showing an answer counts as wrong.</p>
      <div class="field"><span class="label">Skill</span>
        <div class="checks">
          <label><input type="checkbox" name="skill" value="L" checked> Listening</label>
          <label><input type="checkbox" name="skill" value="R" checked> Reading</label>
        </div>
      </div>
      <div class="field"><span class="label">Number of questions</span>
        <select name="count">
          <option value="15">15</option>
          <option value="20" selected>20</option>
          <option value="30">30</option>
        </select>
      </div>
      <p class="error" id="setup-error" hidden></p>
      <div class="row"><button class="btn primary" type="submit">Start</button>
      <a class="btn" href="#/">Back</a></div>
    </form>
    ${passBanner(['A', 'B'])}`;

  document.getElementById('setup').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const skills = f.getAll('skill');
    const pool = bank.questions.filter((q) => q.answer && skills.includes(q.skill));
    const err = document.getElementById('setup-error');
    if (!pool.length) {
      err.textContent = 'Select at least one skill.';
      err.hidden = false;
      return;
    }
    const total = Number(f.get('count'));
    session = {
      id: newId(), mode: 'adaptive', pool, state: createAdaptiveState(), used: new Set(),
      total, answered: 0, correct: 0, startedAt: Date.now(), finished: false,
      label: `Adjust difficulty · ${skills.map((s) => SKILL_NAME[s]).join(' + ')} · ${total} questions`,
      records: [],
    };
    persist();
    location.hash = '#/run';
  });
}

// ----- saving the session as it goes -----
function persist() {
  if (session) {
    saveSession({
      id: session.id,
      mode: session.mode,
      label: session.label,
      startedAt: session.startedAt,
      finished: session.finished,
      records: session.records,
    });
  }
}

function recordResult(q, res) {
  session.records.push({ id: q.id, letter: res.letter, correct: res.correct, revealed: !!res.revealed, t: Date.now() });
  persist();
}

// ----- running a session -----
function questionScreen(q, { header, banner, onAnswer, isLast }) {
  const wrap = document.createElement('section');
  if (banner) wrap.insertAdjacentHTML('beforeend', banner);
  const top = document.createElement('p');
  top.className = 'progress';
  top.textContent = header;
  wrap.appendChild(top);

  const card = questionCard(q, bank, (res) => {
    recordResult(q, res);
    onAnswer(res.correct);
    const next = document.createElement('button');
    next.className = 'btn primary';
    next.type = 'button';
    next.textContent = isLast ? 'See results' : 'Next →';
    next.addEventListener('click', () => session.advance());
    wrap.appendChild(next);
    next.focus();
  });
  wrap.appendChild(card);
  currentCard = card;
  return wrap;
}

function renderPractice() {
  if (session.index >= session.queue.length) return renderResults();
  const total = session.queue.length;
  const q = session.queue[session.index];
  const screen = questionScreen(q, {
    header: `Question ${session.index + 1} of ${total} · ${session.correct} correct so far`,
    banner: session.index === 0 ? passBanner(session.bands) : '',
    isLast: session.index === total - 1,
    onAnswer(correct) {
      if (correct) session.correct++; else session.missed.push(q);
    },
  });
  session.advance = () => { session.index++; renderPractice(); };
  app.replaceChildren(screen);
  window.scrollTo(0, 0);
}

function renderAdaptive() {
  if (session.answered >= session.total) return renderResults();
  const q = pickQuestion(session.pool, session.used, session.state.level);
  if (!q) return renderResults();
  session.used.add(q.id);
  const level = session.state.level === 'B' ? bank.bands.B : bank.bands.A;
  const screen = questionScreen(q, {
    header: `Question ${session.answered + 1} of ${session.total} · Level: ${level} · ${session.correct} correct`,
    banner: session.answered === 0 ? passBanner(['A', 'B']) : '',
    isLast: session.answered === session.total - 1,
    onAnswer(correct) {
      applyAnswer(session.state, correct);
      session.answered++;
      if (correct) session.correct++;
    },
  });
  session.advance = () => renderAdaptive();
  app.replaceChildren(screen);
  window.scrollTo(0, 0);
}

function renderResults() {
  const s = session;
  let html;
  if (s.mode === 'practice') {
    const n = s.index;
    html = `
      <h1>Results</h1>
      <div class="card results">
        <p class="muted">${escapeHtml(s.label)}</p>
        <div class="big">${s.correct} / ${n}</div>
        <p>${pct(s.correct, n)}% correct</p>
        ${s.missed.length ? `<h2>Missed</h2><ul class="missed">${s.missed.map((q) =>
          `<li>${escapeHtml(bank.bands[q.band])} · ${SKILL_NAME[q.skill]} · ${escapeHtml(q.type)} <span class="mono">${escapeHtml(q.id)}</span></li>`).join('')}</ul>` : ''}
      </div>
      ${passBanner(s.bands)}`;
    s.finished = true;
  } else {
    const level = estimateLevel(s.state.history);
    const adv = s.state.history.filter((h) => h.band === 'B');
    const advCorrect = adv.filter((h) => h.correct).length;
    html = `
      <h1>Results</h1>
      <div class="card results">
        <p class="muted">${escapeHtml(s.label)}</p>
        <div class="big">${escapeHtml(bank.bands[level])}</div>
        <p>Estimated level. Overall ${s.correct} / ${s.answered} correct (${pct(s.correct, s.answered)}%).</p>
        <p class="muted">Advanced questions: ${advCorrect} / ${adv.length} correct${adv.length < 3 ? ' (need at least 3 to estimate Advanced)' : ''}.</p>
      </div>
      ${passBanner(['A', 'B'])}`;
    s.finished = true;
  }
  html += `<div class="row"><a class="btn primary" href="#/${s.mode === 'practice' ? 'practice' : 'adaptive'}">Try again</a>
           <a class="btn" href="#/reviews">Reviews</a>
           <a class="btn" href="#/">Home</a></div>`;
  persist();
  session = null;
  currentCard = null;
  app.innerHTML = html;
  window.scrollTo(0, 0);
}

// ----- reviews -----
function reviewsList() {
  const sessions = loadSessions();
  const rows = sessions.map((s) => {
    const correct = s.records.filter((r) => r.correct).length;
    const total = s.records.length;
    return `
      <li class="card review-row">
        <div><strong>${escapeHtml(s.label || s.mode)}</strong>
          ${s.finished ? '' : '<span class="tag">in progress</span>'}</div>
        <div class="muted">${escapeHtml(fmtDate(s.startedAt))} · ${correct} / ${total} correct (${pct(correct, total)}%)</div>
        <div class="row">
          <a class="btn small" href="#/review/${encodeURIComponent(s.id)}">Open</a>
          <button class="btn small" type="button" data-del="${escapeHtml(s.id)}">Delete</button>
        </div>
      </li>`;
  }).join('');

  app.innerHTML = `
    <h1>3 · Reviews</h1>
    <div class="row" style="margin-bottom:12px">
      <button class="btn" id="export" type="button">Export history (.json)</button>
      <label class="btn" style="cursor:pointer">Import history
        <input id="import" type="file" accept="application/json,.json" hidden>
      </label>
      <a class="btn" href="#/">Back</a>
    </div>
    <p class="error" id="import-msg" hidden></p>
    ${sessions.length ? `<ul class="review-list">${rows}</ul>` : '<p class="muted">No saved sessions yet. Finish or start a session and it will appear here.</p>'}`;

  app.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Delete this saved session? This cannot be undone.')) return;
    deleteSession(b.dataset.del);
    reviewsList();
  }));

  document.getElementById('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), sessions }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tocfl-history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById('import').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    const msg = document.getElementById('import-msg');
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data.sessions;
      if (!Array.isArray(list)) throw new Error('No sessions found in this file.');
      const added = importSessions(list);
      msg.textContent = `Imported ${added} session(s).`;
      msg.className = 'feedback good';
      msg.hidden = false;
      reviewsList();
    } catch (err) {
      msg.textContent = `Could not import: ${err.message}`;
      msg.className = 'error';
      msg.hidden = false;
    }
  });
}

function reviewSession(id) {
  const s = loadSessions().find((x) => x.id === id);
  if (!s) {
    app.innerHTML = `<p class="muted">That session was not found.</p><a class="btn" href="#/reviews">Back to reviews</a>`;
    return;
  }
  const correct = s.records.filter((r) => r.correct).length;
  const header = `
    <h1>Review</h1>
    <div class="card results">
      <p class="muted">${escapeHtml(s.label || s.mode)} · ${escapeHtml(fmtDate(s.startedAt))}</p>
      <div class="big">${correct} / ${s.records.length}</div>
      <p>${pct(correct, s.records.length)}% correct${s.finished ? '' : ' · session not finished'}</p>
    </div>
    <div class="row" style="margin-bottom:12px"><a class="btn" href="#/reviews">Back to reviews</a></div>`;
  const wrap = document.createElement('section');
  wrap.innerHTML = header;
  s.records.forEach((rec, i) => {
    const q = byId.get(rec.id);
    const item = document.createElement('div');
    if (!q) {
      item.innerHTML = `<p class="muted">Question ${i + 1} (${escapeHtml(rec.id)}) is not in the current question bank.</p>`;
    } else {
      item.appendChild(el('p', 'progress', `Question ${i + 1} of ${s.records.length}`));
      item.appendChild(questionCard(q, bank, null, {
        correct: rec.correct,
        letter: rec.letter,
        revealed: rec.revealed,
      }));
    }
    wrap.appendChild(item);
  });
  currentCard = null;
  app.replaceChildren(wrap);
  window.scrollTo(0, 0);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ----- boot -----
paintPinyinButton();
loadBank()
  .then((b) => {
    bank = b;
    byId = new Map(bank.questions.map((q) => [q.id, q]));
    route();
    // pinyin-pro loads from the CDN; the app works without it.
    return loadPinyin();
  })
  .then(() => { if (currentCard) currentCard.refresh(); })
  .catch((err) => {
    console.error(err);
    app.innerHTML = `<div class="card"><p class="error">Could not load the question bank.
Run <code>npm run build:data</code> to generate <code>public/data/</code>, then reload.

${escapeHtml(String(err.message || err))}</p></div>`;
  });
