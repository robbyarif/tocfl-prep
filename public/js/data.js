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
      // Optional: the app works without English translations.
      fetchJson('data/translations.json').catch(() => ({ lines: {} })),
    ]).then(([q, dict, tr]) => {
      // A question is playable only if its page (picture or audio) is in the source. Some
      // answer keys list questions whose PDF TOCFL does not publish; those are left out of
      // sessions. allQuestions keeps them so saved sessions can still be reviewed.
      const playable = (x) => {
        const page = q.pages[x.pageId] || {};
        return !!(page.image || page.audio);
      };
      const questions = q.questions.filter(playable);
      const counts = {};
      for (const x of questions) {
        const key = `${x.band}_${x.skill}`;
        counts[key] = (counts[key] || 0) + 1;
      }
      return {
        questions,
        allQuestions: q.questions,
        pages: q.pages,
        bands: q.bands,
        counts,
        excluded: q.questions.length - questions.length,
        dict,
        translations: tr.lines || {},
        generatedAt: q.generatedAt,
      };
    });
  }
  return bankPromise;
}

export const SKILL_NAME = { L: 'Listening', R: 'Reading' };
