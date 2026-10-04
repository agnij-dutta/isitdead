import { describe, expect, it } from 'vitest';
import { parseCsv, targetsFromCsv } from '../src/csv.js';
import { nameVariants } from '../src/patterns.js';
import { buildTarget, parseInput } from '../src/target.js';

describe('parseInput', () => {
  it.each([
    ['stripe.com', { domain: 'stripe.com' }],
    ['https://www.stripe.com/pricing', { domain: 'www.stripe.com' }],
    ['github.com/stripe', { github: 'stripe' }],
    ['https://github.com/atom/atom', { github: 'atom' }],
    ['github:vercel', { github: 'vercel' }],
    ['@stripe', { x: 'stripe' }],
    ['https://x.com/stripe', { x: 'stripe' }],
    ['twitter.com/jack', { x: 'jack' }],
    ['npm:left-pad', { npm: 'left-pad' }],
    ['https://www.npmjs.com/package/@scope/pkg', { npm: '@scope/pkg' }],
    ['Acme Advisory AG', { name: 'Acme Advisory AG' }],
  ])('%s', (input, expected) => {
    expect(parseInput(input)).toEqual(expected);
  });

  it('derives a name from the domain and marks it derived', () => {
    expect(buildTarget('linear.app')).toMatchObject({ name: 'linear', nameDerived: true, domain: 'linear.app' });
  });

  it('flags override and combine', () => {
    expect(buildTarget('stripe.com', { github: 'https://github.com/stripe', x: '@stripe', name: 'Stripe' })).toMatchObject({
      domain: 'stripe.com',
      github: 'stripe',
      x: 'stripe',
      name: 'Stripe',
    });
  });
});

describe('csv', () => {
  it('parses quotes and commas', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });

  it('builds targets from named columns and skips comments', () => {
    const t = targetsFromCsv('name,domain,github,x\n# comment\nStripe,stripe.com,stripe,stripe\n,,atom,\n');
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ name: 'Stripe', domain: 'stripe.com', github: 'stripe', x: 'stripe' });
    expect(t[1]).toMatchObject({ github: 'atom', name: 'atom', nameDerived: true });
  });

  it('single headerless column of free-form inputs', () => {
    const t = targetsFromCsv('stripe.com\n@vercel\nnpm:request\n');
    expect(t.map((x) => x.domain ?? x.x ?? x.npm)).toEqual(['stripe.com', 'vercel', 'request']);
  });
});

describe('nameVariants', () => {
  it('strips legal suffixes and compacts', () => {
    const v = nameVariants('Helvetia Advisory AG');
    expect(v).toContain('helvetia advisory');
    expect(v).toContain('helvetiaadvisory');
    expect(v).toContain('helvetia-advisory');
  });
});
