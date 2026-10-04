/**
 * Every signal carries one of exactly three states.
 *
 *   alive   : positive evidence the thing is alive
 *   dead    : positive evidence the thing is gone or abandoned
 *   unknown : we could not tell. Either the check errored (rate limit, 5xx,
 *             timeout, unexpected redirect) or the evidence was inconclusive.
 *
 * An error is never an absence. A signal is only "dead" when an endpoint
 * answered cleanly and the answer was negative.
 */
export type SignalState = 'alive' | 'dead' | 'unknown';

/** For dead signals: "gone" = it no longer exists; "stale" = exists but abandoned. */
export type DeadKind = 'gone' | 'stale';

/** For unknown signals: "error" = the check failed; "inconclusive" = it worked but proved nothing. */
export type UnknownReason = 'error' | 'inconclusive';

export type SignalName =
  'dns' | 'http' | 'hosting' | 'content' | 'tls' | 'github' | 'npm' | 'x-profile' | 'x-activity' | 'jobs' | 'wayback';

export interface Confirmation {
  /** Number of serial re-check attempts made. */
  attempts: number;
  originalState: SignalState;
  originalSummary: string;
  /**
   * confirmed     : negative re-checked serially and still negative
   * flipped-alive : negative was wrong; serial re-check says alive
   * unconfirmed   : negative could not be re-checked cleanly; downgraded to unknown
   * recovered     : an errored signal got a clean answer on retry
   * still-error   : an errored signal kept erroring
   * refreshed     : was inconclusive only because a sibling check failed
   *                 (e.g. no page to read); filled in from the serial re-check
   */
  outcome: 'confirmed' | 'flipped-alive' | 'unconfirmed' | 'recovered' | 'still-error' | 'refreshed';
}

export interface SignalResult {
  signal: SignalName;
  state: SignalState;
  kind?: DeadKind;
  unknownReason?: UnknownReason;
  /** 0..1 strength of this signal in the verdict. 0 means informational only. */
  weight: number;
  /** One human-readable line. */
  summary: string;
  /** Raw facts backing the summary. */
  evidence: Record<string, unknown>;
  /** Endpoint that was queried, when there is one. */
  source?: string;
  /** ISO timestamp of when the check ran. */
  checkedAt: string;
  confirmation?: Confirmation;
}

export interface Target {
  /** What the user typed. */
  input: string;
  name?: string;
  /** True when the name was guessed from a domain or handle. */
  nameDerived?: boolean;
  domain?: string;
  github?: string;
  x?: string;
  npm?: string;
  /** Explicit ATS board slug. */
  ats?: string;
}

export type VerdictLabel = 'ALIVE' | 'DORMANT' | 'DEAD' | 'UNKNOWN';

export interface Verdict {
  verdict: VerdictLabel;
  /** 0..1 */
  confidence: number;
  why: string[];
  scores: { alive: number; gone: number; stale: number; unknownErrors: number };
}

export interface Report {
  target: Target;
  verdict: Verdict;
  signals: SignalResult[];
  startedAt: string;
  finishedAt: string;
  tool: { name: 'isitdead'; version: string };
}
