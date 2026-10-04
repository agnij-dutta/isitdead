import type { SignalResult, Verdict } from './types.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Combine signals into ALIVE / DORMANT / DEAD / UNKNOWN.
 *
 *   alive  = sum of alive weights
 *   gone   = sum of dead weights where the thing no longer exists
 *   stale  = sum of dead weights where it exists but is abandoned
 *
 * Unknown signals (errors or inconclusive) contribute nothing, and errors
 * lower confidence. A verdict can never be DEAD on errors alone.
 */
export function decide(signals: SignalResult[]): Verdict {
  let A = 0,
    G = 0,
    S = 0,
    U = 0;
  for (const s of signals) {
    if (s.state === 'alive') A += s.weight;
    else if (s.state === 'dead' && s.kind === 'gone') G += s.weight;
    else if (s.state === 'dead') S += s.weight;
    else if (s.unknownReason === 'error') U++;
  }
  const decisive = A + G + S;
  const scores = { alive: round2(A), gone: round2(G), stale: round2(S), unknownErrors: U };
  const why = explain(signals);

  if (decisive < 0.3) {
    return { verdict: 'UNKNOWN', confidence: round2(U ? 0.1 : 0.2), why: why.length ? why : ['no decisive signals'], scores };
  }

  let verdict: Verdict['verdict'];
  let margin: number;
  if ((G >= 1 && G > A) || (G >= 0.5 && A === 0 && G >= S)) {
    verdict = 'DEAD';
    margin = (G + S - A) / decisive;
  } else if (A >= 1 && A >= G + S) {
    verdict = 'ALIVE';
    margin = (A - G - S) / decisive;
  } else if (G + S > A) {
    verdict = 'DORMANT';
    margin = (G + S - A) / decisive;
  } else {
    verdict = 'ALIVE';
    margin = (A - G - S) / decisive;
  }
  const coverage = Math.min(1, decisive / 2.5);
  const errorPenalty = Math.max(0.5, 1 - 0.1 * U);
  const confidence = Math.min(0.97, Math.max(0.1, (0.55 * Math.max(0, margin) + 0.45 * coverage) * errorPenalty));
  return { verdict, confidence: round2(confidence), why, scores };
}

function explain(signals: SignalResult[]): string[] {
  const decisive = signals
    .filter((s) => s.state !== 'unknown' && s.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6)
    .map((s) => `${s.state === 'alive' ? '+' : '-'} ${s.signal}: ${s.summary}${flipNote(s)}`);
  const errors = signals.filter((s) => s.state === 'unknown' && s.unknownReason === 'error').map((s) => `? ${s.signal}: ${s.summary}`);
  return [...decisive, ...errors];
}

function flipNote(s: SignalResult): string {
  const c = s.confirmation;
  if (!c) return '';
  if (c.outcome === 'flipped-alive') return ` [was "${c.originalState}" in the parallel pass; flipped on serial re-check]`;
  if (c.outcome === 'confirmed') return ` [confirmed serially, ${c.attempts} attempt(s)]`;
  return '';
}
