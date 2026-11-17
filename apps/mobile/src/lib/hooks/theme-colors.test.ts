import { describe, expect, it } from 'vitest';

import { formatObject, TOKEN_KEYS } from '../../../scripts/generate-theme-colors.mjs';

const PRIMARY = '--primary';

/** A declaration for every token, so a test can replace the one value it checks. */
function declarationsWith(cssVar: string, value: string): Record<string, string> {
  const declarations: Record<string, string> = {};
  for (const entry of TOKEN_KEYS) {
    const name = entry[1];
    if (name !== undefined) {
      declarations[name] = '#000000';
    }
  }
  declarations[cssVar] = value;
  return declarations;
}

/**
 * Reads the rendered object back as the app reads it. Dropping the one
 * TypeScript `as const` assertion leaves the plain object literal the app gets
 * the colours from, so a check here sees every value exactly as the app does.
 */
function readRendered(source: string): Record<string, string> {
  const body = source.replace(' as const;', '');
  // The evaluator is part of the check: only real evaluation shows the value
  // the emitted module declares.
  // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- the evaluator is the property under test
  const render = new Function(`return ${body}`) as () => Record<string, string>;
  const colors = render();
  expect(Object.keys(colors)).toHaveLength(TOKEN_KEYS.length);
  return colors;
}

describe('formatObject', () => {
  it('renders the current palette values unchanged', () => {
    const source = formatObject(declarationsWith(PRIMARY, '#4F5A10'));
    expect(source).toContain(`primary: '#4F5A10',`);
    expect(readRendered(source).primary).toBe('#4F5A10');
  });

  it('renders one value line per token', () => {
    const source = formatObject(declarationsWith(PRIMARY, '#4F5A10'));
    expect(source.split('\n')).toHaveLength(TOKEN_KEYS.length + 2);
  });

  it.each([
    ['single quote', String.raw`rgba(20, 15, 10, 0.09) 'washed'`],
    ['backslash', String.raw`a\b`],
    // A template cannot end in a bare backslash, so this one keeps its escapes.
    ['trailing backslash', 'end\\'],
    ['newline', 'line1\nline2'],
    ['carriage return and newline', 'a\r\nb'],
    ['tab', 'a\tb'],
    ['NUL', 'a\u0000b'],
    ['double quote', 'a"b'],
    ['lone surrogate', '\uD800'],
  ])('keeps a %s in the value as data', (_name, value) => {
    const source = formatObject(declarationsWith(PRIMARY, value));
    expect(readRendered(source).primary).toBe(value);
  });
});
