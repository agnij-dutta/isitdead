import { buildTarget } from './target.js';
import type { Target } from './types.js';

/** Minimal RFC 4180-ish parser: quotes, escaped quotes, commas and newlines in quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== '') && !r[0]?.trim().startsWith('#'));
}

const COLUMNS = ['input', 'name', 'domain', 'github', 'x', 'npm', 'ats'] as const;

/**
 * Header row required. Recognised columns: input, name, domain, github, x
 * (or twitter), npm, ats. A file with a single unnamed column is treated as
 * free-form inputs.
 */
export function targetsFromCsv(text: string): Target[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0]!.map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/^twitter$/, 'x'),
  );
  const known = header.some((h) => (COLUMNS as readonly string[]).includes(h));
  const body = known ? rows.slice(1) : rows;
  return body.map((r) => {
    if (!known) return buildTarget(r[0]!.trim());
    const get = (k: string) => {
      const i = header.indexOf(k);
      return i >= 0 ? r[i]?.trim() || undefined : undefined;
    };
    const x = get('x');
    const npm = get('npm');
    const flags = { name: get('name'), domain: get('domain'), github: get('github'), x, npm, ats: get('ats') };
    const explicit = get('input');
    if (explicit) return buildTarget(explicit, flags);
    // No free-form input: build purely from columns, keep a readable label.
    const t = buildTarget('', flags);
    t.input = flags.domain ?? flags.name ?? (flags.github ? `github:${flags.github}` : x ? `@${x}` : npm ? `npm:${npm}` : '');
    return t;
  });
}
