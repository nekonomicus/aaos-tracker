// FSRS-6 spaced-repetition scheduler (Free Spaced Repetition Scheduler, open-spaced-repetition).
// Memory model: stability S (days until recall probability drops to 90%), difficulty D (1–10),
// retrievability R = (1 + F·t/S)^-decay. Default parameters are the published FSRS-6 defaults.
// Verified against ts-fsrs 5.x `next_state` (see README).
(function (root) {
  'use strict';

  const W = [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
    1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
  ];
  const S_MIN = 0.001;
  const S_MAX = 36500;
  const DECAY = -W[20];
  const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;
  const DAY = 86400000;
  const MIN = 60000;

  const STATE = { New: 0, Learning: 1, Review: 2, Relearning: 3 };
  const GRADE = { Again: 1, Hard: 2, Good: 3, Easy: 4 };

  const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

  function retrievability(elapsedDays, s) {
    return Math.pow(1 + (FACTOR * elapsedDays) / s, DECAY);
  }
  const initStability = (g) => clamp(W[g - 1], S_MIN, S_MAX);
  const initDifficultyRaw = (g) => W[4] - Math.exp((g - 1) * W[5]) + 1;
  const initDifficulty = (g) => clamp(initDifficultyRaw(g), 1, 10);

  function nextDifficulty(d, g) {
    const delta = -W[6] * (g - 3);
    const damped = d + (delta * (10 - d)) / 9;
    return clamp(W[7] * initDifficultyRaw(4) + (1 - W[7]) * damped, 1, 10);
  }
  function recallStability(d, s, r, g) {
    const hard = g === 2 ? W[15] : 1;
    const easy = g === 4 ? W[16] : 1;
    const inc = Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hard * easy;
    return clamp(s * (1 + inc), S_MIN, S_MAX);
  }
  function forgetStability(d, s, r) {
    const long = clamp(W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]), S_MIN, S_MAX);
    return clamp(s / Math.exp(W[17] * W[18]), S_MIN, long);
  }
  function shortTermStability(s, g) {
    let sinc = Math.pow(s, -W[19]) * Math.exp(W[17] * (g - 3 + W[18]));
    if (g >= 2) sinc = Math.max(sinc, 1);
    return clamp(s * sinc, S_MIN, S_MAX);
  }

  /** Memory transition. mem = {s, d} or null for a brand-new card; t = elapsed whole days. */
  function nextMemory(mem, t, g) {
    if (!mem || !mem.s) return { s: initStability(g), d: initDifficulty(g) };
    const r = retrievability(t, mem.s);
    let s;
    if (t === 0) s = shortTermStability(mem.s, g);
    else if (g === 1) s = forgetStability(mem.d, mem.s, r);
    else s = recallStability(mem.d, mem.s, r, g);
    return { s, d: nextDifficulty(mem.d, g) };
  }

  /** Interval in days for a desired retention rr, before rounding/fuzz. */
  const rawInterval = (s, rr) => (s / FACTOR) * (Math.pow(rr, 1 / DECAY) - 1);

  // Fuzz spreads reviews so cards learned together don't stay clumped together (same ranges as FSRS reference).
  const FUZZ = [[2.5, 7, 0.15], [7, 20, 0.1], [20, Infinity, 0.05]];
  function fuzzed(ivl, rand, maxIvl) {
    if (ivl < 2.5) return Math.round(ivl);
    let delta = 1;
    for (const [a, b, f] of FUZZ) delta += f * Math.max(Math.min(ivl, b) - a, 0);
    const lo = Math.max(2, Math.round(ivl - delta));
    const hi = Math.min(Math.round(ivl + delta), maxIvl);
    return Math.min(Math.floor(rand * (hi - lo + 1) + lo), Math.max(hi, 1));
  }

  // Day boundary at 04:00 local time, so a late-night session still counts as "today".
  const ROLLOVER_H = 4;
  function dayIndex(ms) {
    const d = new Date(ms - ROLLOVER_H * 3600000);
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
  }
  function startOfDay(idx) {
    const d = new Date(idx * DAY);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), ROLLOVER_H).getTime();
  }

  /**
   * Schedule one review.
   * card: {st, s, d, due, last, step, reps, lapses} (missing/undefined fields = new card)
   * opts: {rr, maxIvl, learn:[ms...], relearn:[ms...], rand}
   * Returns a new card object (does not mutate).
   */
  function schedule(card, g, now, opts) {
    const o = Object.assign({ rr: 0.9, maxIvl: S_MAX, learn: [1 * MIN, 10 * MIN], relearn: [10 * MIN], rand: Math.random() }, opts);
    const c = Object.assign({ st: STATE.New, s: 0, d: 0, due: now, last: 0, step: 0, reps: 0, lapses: 0 }, card);
    const t = c.last ? Math.max(0, dayIndex(now) - dayIndex(c.last)) : 0;
    const mem = c.st === STATE.New ? nextMemory(null, 0, g) : nextMemory({ s: c.s, d: c.d }, t, g);
    const out = Object.assign({}, c, mem, { last: now, reps: c.reps + 1 });
    const today = dayIndex(now);
    const ivlDays = (s, floor) => {
      let ivl = Math.max(1, Math.round(rawInterval(s, o.rr)));
      if (o.maxIvl < S_MAX && ivl >= o.maxIvl) {
        // Hits the exam cap: spread these cards over the last week instead of piling them on one day.
        return Math.max(1, o.maxIvl - Math.floor(o.rand * Math.min(7, o.maxIvl)));
      }
      ivl = fuzzed(ivl, o.rand, o.maxIvl);
      return clamp(Math.max(ivl, floor || 1), 1, Math.max(1, o.maxIvl));
    };
    const toReview = (ivl) => Object.assign(out, { st: STATE.Review, step: 0, ivl, due: startOfDay(today + ivl) });

    if (c.st === STATE.Review) {
      if (g === 1) {
        out.lapses = c.lapses + 1;
        return Object.assign(out, { st: STATE.Relearning, step: 0, ivl: 0, due: now + o.relearn[0] });
      }
      // Keep Hard ≤ Good < Easy, as the reference scheduler does.
      const sHard = nextMemory({ s: c.s, d: c.d }, t, 2).s;
      const sGood = nextMemory({ s: c.s, d: c.d }, t, 3).s;
      const sEasy = nextMemory({ s: c.s, d: c.d }, t, 4).s;
      let hard = Math.min(ivlDays(sHard), ivlDays(sGood));
      let good = Math.max(ivlDays(sGood), hard + 1);
      let easy = Math.max(ivlDays(sEasy), good + 1);
      const cap = Math.max(1, o.maxIvl);
      [hard, good, easy] = [Math.min(hard, cap), Math.min(good, cap), Math.min(easy, cap)];
      return toReview(g === 2 ? hard : g === 3 ? good : easy);
    }

    // New, Learning, Relearning: short learning steps before (re)graduating.
    const steps = c.st === STATE.Relearning ? o.relearn : o.learn;
    const learnState = c.st === STATE.Relearning ? STATE.Relearning : STATE.Learning;
    const step = c.st === STATE.New ? 0 : c.step;
    if (g === 1) return Object.assign(out, { st: learnState, step: 0, ivl: 0, due: now + steps[0] });
    if (g === 2) {
      const wait = step === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2 : step === 0 ? steps[0] * 1.5 : steps[Math.min(step, steps.length - 1)];
      return Object.assign(out, { st: learnState, step, ivl: 0, due: now + wait });
    }
    if (g === 3 && step + 1 < steps.length) return Object.assign(out, { st: learnState, step: step + 1, ivl: 0, due: now + steps[step + 1] });
    if (g === 3) return toReview(ivlDays(out.s));
    const goodIvl = ivlDays(nextMemory(c.st === STATE.New ? null : { s: c.s, d: c.d }, t, 3).s);
    return toReview(Math.max(ivlDays(out.s), Math.min(goodIvl + 1, Math.max(1, o.maxIvl))));
  }

  /** Current probability of recall for a scheduled card (1 for learning cards reviewed today). */
  function recall(card, now) {
    if (!card || !card.s || card.st === STATE.New) return 0;
    const t = Math.max(0, (now - card.last) / DAY);
    return retrievability(t, card.s);
  }

  root.FSRS = { W, STATE, GRADE, DAY, MIN, schedule, nextMemory, retrievability, recall, rawInterval, dayIndex, startOfDay };
})(typeof window !== 'undefined' ? window : globalThis);
