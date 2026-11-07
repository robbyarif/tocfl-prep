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
  const r = path.match(/^\/resume\/(.+)$/);
  if (r) {
    if (resumeSession(decodeURIComponent(r[1]))) { location.hash = '#/run'; return; }
    app.innerHTML = `<div class="card"><p class="error">This session can't be continued. It may be finished, or it was saved before resuming was supported.</p>
      <a class="btn" href="#/reviews">Back to reviews</a></div>`;
    return;
  }
  const m = path.match(/^\/review\/(.+)$/);
  if (m) return reviewSession(decodeURIComponent(m[1]));
  location.hash = '#/';
}
window.addEventListener('hashchange', route);

// A saved session can be continued if it is unfinished and has what is needed to rebuild it.
// Sessions saved before resuming existed have no queue or level state, so they can't be.
function resumable(s) {
  if (s.finished) return false;
  if (s.mode === 'practice') return Array.isArray(s.queueIds) && s.queueIds.length > 0;
  return !!s.state && Array.isArray(s.skills);
}

// Rebuilds the in-memory session from the saved record. Returns false if it can't.
function resumeSession(id) {
  const s = loadSessions().find((x) => x.id === id);
  if (!s || !resumable(s)) return false;
  const correct = s.records.filter((r) => r.correct).length;
  if (s.mode === 'practice') {
    const queue = s.queueIds.map((x) => byId.get(x)).filter(Boolean);
    if (!queue.length) return false;
    session = {
      id: s.id, mode: 'practice', label: s.label, startedAt: s.startedAt, finished: false,
      bands: s.bands || ['A', 'B'], queue,
      index: Math.max(0, queue.findIndex((q) => !s.records.some((r) => r.id === q.id))),
      correct,
      missed: s.records.filter((r) => !r.correct).map((r) => byId.get(r.id)).filter(Boolean),
      records: s.records.slice(),
    };
  } else {
    const pool = bank.questions.filter((q) => q.answer && s.skills.includes(q.skill));
    session = {
      id: s.id, mode: 'adaptive', label: s.label, startedAt: s.startedAt, finished: false,
      pool, state: s.state, skills: s.skills,
      used: new Set(s.records.map((r) => r.id)),
      total: s.total, answered: s.records.length, correct,
      records: s.records.slice(),
    };
  }
  return true;
}

// ----- home -----
function home() {
  const s = overallStats();
  const counts = Object.entries(bank.counts)
    .map(([k, n]) => {
      const [band, skill] = k.split('_');
      return `${bank.bands[band]} ${SKILL_NAME[skill]}: ${n}`;
    })
    .join(' · ');
  const saved = loadSessions();
  const unfinished = saved.find(resumable);
  app.innerHTML = `
    <h1>TOCFL 模擬試題 Mock questions</h1>
    <p class="stat-line">${escapeHtml(counts)}</p>
    <p class="stat-line">Your answers so far: ${s.total} (${pct(s.correct, s.total)}% correct) · Saved sessions: ${saved.length}</p>
    ${unfinished ? `<div class="card" style="margin-top:12px"><strong>Unfinished session</strong><br>
      <span class="muted">${escapeHtml(unfinished.label || unfinished.mode)} · ${unfinished.records.length} answered</span>
      <div class="row" style="margin-top:8px"><a class="btn primary" href="#/resume/${encodeURIComponent(unfinished.id)}">Continue</a></div></div>` : ''}
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
      total, answered: 0, correct: 0, startedAt: Date.now(), finished: false, skills,
      label: `Adjust difficulty · ${skills.map((s) => SKILL_NAME[s]).join(' + ')} · ${total} questions`,
      records: [],
    };
    persist();
    location.hash = '#/run';
  });
}

// ----- saving the session as it goes -----
// Saves the session so it can be reviewed and, if unfinished, continued.
function persist() {
  if (!session) return;
  const saved = {
    id: session.id,
    mode: session.mode,
    label: session.label,
    startedAt: session.startedAt,
    finished: session.finished,
    records: session.records,
  };
  if (session.mode === 'practice') {
    saved.bands = session.bands;
    saved.queueIds = session.queue.map((q) => q.id);
  } else {
    saved.skills = session.skills;
    saved.total = session.total;
    saved.state = session.state;
  }
  saveSession(saved);
}

function recordResult(q, res) {
  session.records.push({ id: q.id, letter: res.letter, correct: res.correct, revealed: !!res.revealed, t: Date.now() });
  persist();
}

// ----- running a session -----
// One question on screen. `prior` shows an already-answered question read-only.
// `nextLabel` is a string or a function returning the label for the button after answering.
function questionScreen(q, { header, banner, nav, onAnswer, isLast, prior = null, nextLabel = null }) {
  const wrap = document.createElement('section');
  if (banner) wrap.insertAdjacentHTML('beforeend', banner);
  if (nav) wrap.appendChild(nav);
  const top = document.createElement('p');
  top.className = 'progress';
  const headerText = () => (typeof header === 'function' ? header() : header);
  top.textContent = headerText();
  wrap.appendChild(top);

  const addNext = () => {
    const label = typeof nextLabel === 'function' ? nextLabel()
      : (nextLabel || (isLast ? 'See results' : 'Next →'));
    const next = document.createElement('button');
    next.className = 'btn primary';
    next.type = 'button';
    next.textContent = label;
    next.addEventListener('click', () => session.advance());
    wrap.appendChild(next);
    next.focus();
  };

  const card = questionCard(q, bank, prior ? null : (res) => {
    recordResult(q, res);
    onAnswer(res.correct);
    top.textContent = headerText();
    addNext();
  }, prior);
  wrap.appendChild(card);
  if (prior) addNext();
  currentCard = card;
  return wrap;
}

// The next unanswered question after position i (wrapping), or i if all are answered.
function nextUnansweredFrom(i, answered) {
  const total = session.queue.length;
  for (let k = 1; k <= total; k++) {
    const j = (i + k) % total;
    if (!answered.has(session.queue[j].id)) return j;
  }
  return i;
}

// Number chips for every question in the practice session. Click one to jump to it.
function practiceNav(answered) {
  const nav = document.createElement('nav');
  nav.className = 'review-index';
  nav.innerHTML = session.queue.map((q, i) => {
    const r = answered.get(q.id);
    const cls = ['chip', r ? (r.correct ? 'ok' : 'bad') : '', i === session.index ? 'current' : ''].join(' ');
    return `<button type="button" class="${cls}" data-jump="${i}" aria-label="Question ${i + 1}">${i + 1}</button>`;
  }).join('');
  nav.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
    session.index = Number(b.dataset.jump);
    renderPractice();
  }));
  const finish = document.createElement('button');
  finish.type = 'button';
  finish.className = 'btn small';
  finish.textContent = 'Finish & see results';
  finish.addEventListener('click', () => renderResults());
  nav.appendChild(finish);
  return nav;
}

function renderPractice() {
  const total = session.queue.length;
  const answered = new Map(session.records.map((r) => [r.id, r]));
  const q = session.queue[session.index];
  const prior = answered.get(q.id);
  const screen = questionScreen(q, {
    header: () => {
      const done = session.records.length;
      const right = session.records.filter((r) => r.correct).length;
      return `Question ${session.index + 1} of ${total} · ${done} answered · ${right} correct`;
    },
    banner: session.index === 0 ? passBanner(session.bands) : '',
    nav: practiceNav(answered),
    prior: prior ? { correct: prior.correct, letter: prior.letter, revealed: prior.revealed } : null,
    nextLabel: () => (session.records.length >= total ? 'See results' : 'Next →'),
    onAnswer() {},
  });
  session.advance = () => {
    if (session.records.length >= total) return renderResults();
    session.index = nextUnansweredFrom(session.index, new Map(session.records.map((r) => [r.id, r])));
    renderPractice();
  };
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
  if (s.mode === 'practice') {
    // Practice results come from the answers given, not from the position in the queue.
    s.correct = s.records.filter((r) => r.correct).length;
    s.missed = s.records.filter((r) => !r.correct).map((r) => byId.get(r.id)).filter(Boolean);
    s.index = s.records.length;
  }
  let html;
  if (s.mode === 'practice') {
    const n = s.index;
    html = `
      <h1>Results</h1>
      <div class="card results">
        <p class="muted">${escapeHtml(s.label)}</p>
        <div class="big">${s.correct} / ${n}</div>
        <p>${pct(s.correct, n)}% correct${s.queue.length > n ? ` · ${s.queue.length - n} not answered` : ''}</p>
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
          ${resumable(s) ? `<a class="btn small primary" href="#/resume/${encodeURIComponent(s.id)}">Continue</a>` : ''}
          <a class="btn small" href="#/review/${encodeURIComponent(s.id)}">Review</a>
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
  const wrap = document.createElement('section');
  wrap.innerHTML = `
    <h1>Review</h1>
    <div class="card results">
      <p class="muted">${escapeHtml(s.label || s.mode)} · ${escapeHtml(fmtDate(s.startedAt))}</p>
      <div class="big">${correct} / ${s.records.length}</div>
      <p>${pct(correct, s.records.length)}% correct${s.finished ? '' : ' · session not finished'}</p>
      ${resumable(s) ? `<a class="btn primary" href="#/resume/${encodeURIComponent(s.id)}">Continue this session</a>` : ''}
    </div>
    <div class="row review-tools">
      <label><input type="checkbox" id="only-wrong"> Show only wrong answers</label>
      <a class="btn" href="#/reviews">Back to reviews</a>
    </div>
    <nav class="review-index">${s.records.map((r, i) =>
      `<button type="button" class="chip ${r.correct ? 'ok' : 'bad'}" data-jump="${i}" aria-label="Question ${i + 1}">${i + 1}</button>`).join('')}</nav>`;

  s.records.forEach((rec, i) => {
    const q = byId.get(rec.id);
    const item = document.createElement('div');
    item.className = 'review-item';
    item.id = `q${i}`;
    item.dataset.correct = String(!!rec.correct);
    if (!q) {
      item.innerHTML = `<p class="muted">Question ${i + 1} (${escapeHtml(rec.id)}) is not in the current question bank.</p>`;
    } else {
      const yourAnswer = rec.revealed ? 'answer shown' : `your answer: ${rec.letter || '—'}`;
      item.appendChild(el('p', 'progress', `Question ${i + 1} of ${s.records.length} · ${yourAnswer} · ${rec.correct ? 'correct' : 'wrong'}`));
      item.appendChild(questionCard(q, bank, null, {
        correct: rec.correct,
        letter: rec.letter,
        revealed: rec.revealed,
      }));
    }
    wrap.appendChild(item);
  });

  wrap.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
    document.getElementById(`q${b.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  const onlyWrong = wrap.querySelector('#only-wrong');
  onlyWrong.addEventListener('change', () => {
    wrap.querySelectorAll('.review-item').forEach((it) => {
      it.hidden = onlyWrong.checked && it.dataset.correct === 'true';
    });
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
