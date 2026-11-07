// Loads the bank produced by `npm run build:data`.
let bankPromise = null;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export function loadBank() {
  if (!bankPromise) {
    bankPromise = Promise.all([
      fetchJson('data/questions.json'),
      fetchJson('data/dict.json'),
    ]).then(([q, dict]) => ({
      questions: q.questions,
      pages: q.pages,
      bands: q.bands,
      counts: q.counts,
      dict,
      generatedAt: q.generatedAt,
    }));
  }
  return bankPromise;
}

export const SKILL_NAME = { L: 'Listening', R: 'Reading' };
