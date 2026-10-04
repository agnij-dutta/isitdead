import type { BatchResult, CheckResult, ConfirmStats } from './engine.js';
import { describeTarget } from './target.js';
import type { SignalResult, VerdictLabel } from './types.js';

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
const VERDICT_COLOR: Record<VerdictLabel, string> = { ALIVE: '32;1', DORMANT: '33;1', DEAD: '31;1', UNKNOWN: '90;1' };

function stateTag(s: SignalResult): string {
  if (s.state === 'alive') return c('32', 'ALIVE  ');
  if (s.state === 'dead') return c('31', s.kind === 'stale' ? 'STALE  ' : 'DEAD   ');
  return c('90', s.unknownReason === 'error' ? 'ERROR  ' : 'UNCLEAR');
}

function confirmNote(s: SignalResult): string {
  const k = s.confirmation;
  if (!k) return '';
  switch (k.outcome) {
    case 'confirmed':
      return c('90', `  (negative confirmed serially, ${k.attempts} attempt(s))`);
    case 'flipped-alive':
      return c('35', `  (FLIPPED: parallel pass said ${k.originalState}; serial re-check says alive)`);
    case 'unconfirmed':
      return c('35', `  (downgraded from dead: could not re-confirm)`);
    case 'recovered':
      return c('90', `  (errored in parallel pass, recovered on retry ${k.attempts})`);
    case 'refreshed':
      return c('90', `  (filled in on serial re-check)`);
    case 'still-error':
      return c('90', `  (still erroring after ${k.attempts} retries)`);
  }
}

export function formatCheck(r: CheckResult): string {
  const { report, stats, discoveryVerdict } = r;
  const v = report.verdict;
  const lines: string[] = [];
  lines.push(
    `${c('1', describeTarget(report.target))}  ${c(VERDICT_COLOR[v.verdict], v.verdict)}  confidence ${Math.round(v.confidence * 100)}%`,
  );
  lines.push('');
  lines.push('Why:');
  for (const w of v.why) lines.push(`  ${w}`);
  lines.push('');
  lines.push('Signals:');
  const width = Math.max(...report.signals.map((s) => s.signal.length), 4);
  for (const s of report.signals) {
    lines.push(`  ${stateTag(s)} ${s.signal.padEnd(width)}  ${s.summary}${confirmNote(s)}`);
    const src = s.source ? `${s.source}  ` : '';
    lines.push(c('90', `  ${' '.repeat(8)}${' '.repeat(width)}  ${src}@ ${s.checkedAt}`));
  }
  if (stats.negatives || stats.errors) {
    lines.push('');
    lines.push(c('90', confirmLine(stats)));
    if (discoveryVerdict.verdict !== v.verdict) {
      lines.push(c('35', `Without serial re-confirmation this would have read ${discoveryVerdict.verdict}.`));
    }
  }
  return lines.join('\n');
}

export function confirmLine(s: ConfirmStats): string {
  const parts = [
    `${s.negatives} negative(s) re-checked serially: ${s.confirmed} confirmed, ${s.flippedAlive} flipped to alive, ${s.unconfirmed} downgraded to unknown`,
  ];
  if (s.errors) parts.push(`${s.errors} errored signal(s) retried: ${s.recovered} recovered, ${s.stillError} still erroring`);
  return parts.join('. ') + '.';
}

export function formatBatch(b: BatchResult): string {
  const lines: string[] = [];
  const rows = b.results.map((r) => {
    const v = r.report.verdict;
    const top = v.why[0] ?? '';
    const changed = r.discoveryVerdict.verdict !== v.verdict ? ` (parallel pass said ${r.discoveryVerdict.verdict})` : '';
    return { name: describeTarget(r.report.target), verdict: v.verdict, conf: `${Math.round(v.confidence * 100)}%`, top: top + changed };
  });
  const w = Math.min(48, Math.max(...rows.map((r) => r.name.length), 6));
  lines.push(`${'TARGET'.padEnd(w)}  VERDICT  CONF  TOP REASON`);
  for (const r of rows) {
    const name = r.name.length > w ? r.name.slice(0, w - 1) + '~' : r.name;
    lines.push(
      `${name.padEnd(w)}  ${c(VERDICT_COLOR[r.verdict as VerdictLabel], r.verdict.padEnd(7))}  ${r.conf.padStart(4)}  ${r.top.slice(0, 140)}`,
    );
  }
  const s = b.stats;
  lines.push('');
  lines.push(c('1', 'Error vs absence report'));
  lines.push(
    `  Discovery: ${b.results.length} targets at concurrency ${b.concurrency}, ${b.requests} network requests (cache hits excluded)`,
  );
  lines.push(`  Negatives in the parallel pass: ${s.negatives}`);
  lines.push(`    confirmed dead on serial re-check:   ${s.confirmed}`);
  lines.push(`    ${c('35', `flipped to alive on serial re-check:  ${s.flippedAlive}`)}`);
  lines.push(`    downgraded to unknown (re-check errored): ${s.unconfirmed}`);
  const fp = s.negatives ? Math.round(((s.flippedAlive + s.unconfirmed) / s.negatives) * 100) : 0;
  lines.push(`  Parallel-pass false-negative rate: ${fp}% of negatives did not survive confirmation`);
  lines.push(`  Errored signals retried: ${s.errors} (${s.recovered} recovered, ${s.stillError} still erroring, none counted as dead)`);
  lines.push(`  Verdicts changed by confirmation: ${b.verdictsChanged} (${b.verdictsRescued} would have been wrongly reported DEAD)`);
  return lines.join('\n');
}
