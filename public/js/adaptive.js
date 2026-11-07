// Adaptive ("adjust difficulty") logic: a two-level staircase between
// Basic (A) and Advanced (B).
//
//  - Start at Basic.
//  - Two correct answers in a row at Basic move up to Advanced.
//  - Any wrong answer at Advanced moves back down to Basic.
//  - At the end, the estimate is Advanced if at least 3 Advanced items were
//    attempted and at least 70% of them were correct; otherwise Basic.

export function createAdaptiveState() {
  return { level: 'A', streak: 0, history: [] };
}

export function applyAnswer(state, correct) {
  state.history.push({ band: state.level, correct });
  if (correct) {
    state.streak++;
    if (state.level === 'A' && state.streak >= 2) {
      state.level = 'B';
      state.streak = 0;
    }
  } else {
    state.streak = 0;
    if (state.level === 'B') state.level = 'A';
  }
  return state;
}

export function estimateLevel(history) {
  const adv = history.filter((h) => h.band === 'B');
  if (adv.length < 3) return 'A';
  const acc = adv.filter((h) => h.correct).length / adv.length;
  return acc >= 0.7 ? 'B' : 'A';
}

// Picks a random unused question from the requested band, falling back to the other band.
export function pickQuestion(pool, usedIds, level) {
  const unused = pool.filter((q) => !usedIds.has(q.id));
  const same = unused.filter((q) => q.band === level);
  const candidates = same.length ? same : unused;
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
