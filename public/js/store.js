// Per-browser preferences and attempt counts. Wrapped in try/catch because
// localStorage can be unavailable (private windows, blocked site data).
const KEY = 'tocfl-prep:v1';

let state = { prefs: { pinyin: false }, attempts: {} };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (saved) state = { prefs: { pinyin: false }, attempts: {}, ...saved };
} catch {
  /* ignore: start fresh */
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export const getPinyinPref = () => !!state.prefs.pinyin;

export function setPinyinPref(on) {
  state.prefs.pinyin = !!on;
  save();
}

export function recordAttempt(id, correct) {
  const a = state.attempts[id] || (state.attempts[id] = { c: 0, w: 0 });
  if (correct) a.c++; else a.w++;
  save();
}

// ----- session history -----
// Each session is stored as a small record: IDs, choices and results (no images or audio).
// Records are looked up in questions.json when reviewed, so they stay small.
const SESSIONS_KEY = 'tocfl-prep:sessions:v1';

export function loadSessions() {
  try {
    const list = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeSessions(list) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false; // storage full or blocked; the session still works in memory
  }
}

// Inserts or replaces a session by id, newest first.
export function saveSession(session) {
  const list = loadSessions();
  const i = list.findIndex((s) => s.id === session.id);
  if (i >= 0) list[i] = session; else list.unshift(session);
  return writeSessions(list);
}

export function deleteSession(id) {
  return writeSessions(loadSessions().filter((s) => s.id !== id));
}

// Merges sessions from an export file. Existing sessions with the same id are kept as they are.
export function importSessions(incoming) {
  const list = loadSessions();
  const known = new Set(list.map((s) => s.id));
  let added = 0;
  for (const s of incoming) {
    if (s && s.id && !known.has(s.id)) { list.push(s); known.add(s.id); added++; }
  }
  list.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  writeSessions(list);
  return added;
}

export function overallStats() {
  let correct = 0, wrong = 0;
  for (const a of Object.values(state.attempts)) { correct += a.c; wrong += a.w; }
  return { correct, total: correct + wrong };
}
