import type { SignalResult, Verdict } from './types.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Combine signals into ALIVE / DORMANT / DEAD / UNKNOWN.
 *
 * Each signal carries a weight in 0..1. Rough scale: 1.0 settles the question
 * on its own (all repos archived, a shutdown notice, a parked domain, recent
 * original commits), 0.5 to 0.8 is strong, 0.1 to 0.3 is supporting only
 * (DNS resolves, valid TLS, HTTP 200).
 *
 *   A (alive) = sum of alive weights
 *   G (gone)  = sum of dead weights with kind "gone"  (it no longer exists)
 *   S (stale) = sum of dead weights with kind "stale" (exists, abandoned)
 *   U         = count of errored signals
 *
 * Unknown signals (errors or inconclusive) contribute nothing to A, G or S.
 * A verdict can never be DEAD or DORMANT on errors alone.
 *
 * Rules, first match wins (decisive = A + G + S):
 *   decisive < 0.3                       -> UNKNOWN
 *   G >= 1 and G > A                     -> DEAD
 *   G >= 0.5 and A == 0 and G >= S       -> DEAD
 *   A >= 1 and A >= G + S                -> ALIVE
 *   G + S > A                            -> DORMANT
 *   otherwise                            -> ALIVE (weak)
 *
 * Confidence (0.1 to 0.97):
 *   margin   = |winning side - losing side| / decisive    (how one-sided)
 *   coverage = min(1, decisive / 2.5)                     (how much evidence)
 *   penalty  = max(0.5, 1 - 0.1 * U)                      (each error costs 10%)
 *   confidence = (0.55 * margin + 0.45 * coverage) * penalty
 * capped at 0.97 because public signals can always be wrong (see the name
 * reuse limitation in the README). For UNKNOWN, confidence is a fixed 0.2,
 * or 0.1 when errors were involved: it says how little we know.
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

/** Top decisive signals by weight ("+" alive, "-" dead), then every error ("?"). */
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
