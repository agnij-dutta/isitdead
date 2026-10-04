import type { Target } from './types.js';

export interface TargetFlags {
  name?: string;
  domain?: string;
  github?: string;
  x?: string;
  npm?: string;
  ats?: string;
}

const clean = (s?: string) => (s && s.trim() ? s.trim() : undefined);

function hostOf(s: string): string | undefined {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    return u.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Parse one free-form input into a target. Accepts:
 *   stripe.com, https://stripe.com/x     -> domain
 *   github.com/stripe, github:stripe      -> GitHub org/user
 *   @stripe, x.com/stripe, twitter.com/x  -> X handle
 *   npm:left-pad, npmjs.com/package/x     -> npm package
 *   "Acme Advisory AG"                    -> name
 */
export function parseInput(input: string): Partial<Target> {
  const s = input.trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^github:(.+)$/i))) return { github: m[1] };
  if ((m = s.match(/^npm:(.+)$/i))) return { npm: m[1] };
  if ((m = s.match(/^(?:x|twitter):@?(.+)$/i))) return { x: m[1] };
  if ((m = s.match(/^@([A-Za-z0-9_]{1,15})$/))) return { x: m[1] };
  if ((m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)/i))) return { github: m[1] };
  if ((m = s.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})/i))) return { x: m[1] };
  if ((m = s.match(/^(?:https?:\/\/)?(?:www\.)?npmjs\.com\/package\/((?:@[^/]+\/)?[^/?#\s]+)/i))) return { npm: m[1] };
  if (!/\s/.test(s) && /\.[a-z]{2,}$/i.test(s.replace(/^[a-z]+:\/\//i, '').replace(/[/?#:].*$/, ''))) {
    const host = hostOf(s);
    if (host) return { domain: host };
  }
  return { name: s };
}

export function buildTarget(input: string, flags: TargetFlags = {}): Target {
  const parsed = input ? parseInput(input) : {};
  const t: Target = {
    input,
    name: clean(flags.name) ?? parsed.name,
    domain: clean(flags.domain) ? hostOf(flags.domain!) : parsed.domain,
    github: clean(flags.github)?.replace(/^.*github\.com\//i, '').replace(/\/.*$/, '') ?? parsed.github,
    x: clean(flags.x)?.replace(/^.*(x|twitter)\.com\//i, '').replace(/^@/, '').replace(/\/.*$/, '') ?? parsed.x?.replace(/^@/, ''),
    npm: clean(flags.npm) ?? parsed.npm,
    ats: clean(flags.ats),
  };
  if (!t.name) {
    const fromDomain = t.domain?.replace(/^www\./, '').split('.')[0];
    const derived = fromDomain ?? t.github ?? t.x ?? t.npm?.replace(/^@[^/]+\//, '');
    if (derived) {
      t.name = derived;
      t.nameDerived = true;
    }
  }
  for (const k of Object.keys(t) as Array<keyof Target>) if (t[k] === undefined) delete t[k];
  return t;
}

export function describeTarget(t: Target): string {
  const parts: string[] = [];
  if (t.domain) parts.push(t.domain);
  if (t.github) parts.push(`github:${t.github}`);
  if (t.x) parts.push(`@${t.x}`);
  if (t.npm) parts.push(`npm:${t.npm}`);
  const head = t.name && !t.nameDerived ? t.name : (parts.shift() ?? t.input);
  return parts.length ? `${head} (${parts.join(', ')})` : head;
}
