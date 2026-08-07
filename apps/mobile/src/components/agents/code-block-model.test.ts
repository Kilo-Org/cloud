import { describe, expect, it } from 'vitest';

import { normalizeFenceLanguage, tokenizeCodeLines } from './code-block-model';

describe('normalizeFenceLanguage', () => {
  it('returns null for undefined, empty, and whitespace-only info strings', () => {
    expect(normalizeFenceLanguage(undefined)).toBeNull();
    expect(normalizeFenceLanguage('')).toBeNull();
    expect(normalizeFenceLanguage('   ')).toBeNull();
    expect(normalizeFenceLanguage('\t\n ')).toBeNull();
  });

  it('takes only the first word of the info string', () => {
    expect(normalizeFenceLanguage('TS extra')).toBe('ts');
    expect(normalizeFenceLanguage('python3.11 with mocks')).toBe('python3.11');
  });

  it('lower-cases the resolved language', () => {
    expect(normalizeFenceLanguage('TypeScript')).toBe('typescript');
    expect(normalizeFenceLanguage('PYTHON')).toBe('python');
    expect(normalizeFenceLanguage('  Ruby  ')).toBe('ruby');
  });

  it('passes single-word languages through unchanged', () => {
    expect(normalizeFenceLanguage('ts')).toBe('ts');
    expect(normalizeFenceLanguage('diff')).toBe('diff');
  });
});

describe('tokenizeCodeLines', () => {
  it('returns one token line per source line', () => {
    const tokens = tokenizeCodeLines('a\nb\nc', null);
    expect(tokens).toHaveLength(3);
    expect(tokens[0]).toEqual([{ text: 'a', className: null }]);
    expect(tokens[1]).toEqual([{ text: 'b', className: null }]);
    expect(tokens[2]).toEqual([{ text: 'c', className: null }]);
  });

  it('passes plain text through for a null language', () => {
    const tokens = tokenizeCodeLines('const x = 1;', null);
    expect(tokens).toEqual([[{ text: 'const x = 1;', className: null }]]);
  });

  it('returns one empty token line for empty code', () => {
    expect(tokenizeCodeLines('', null)).toEqual([[{ text: '', className: null }]]);
  });

  it('highlights a TypeScript keyword with a non-null className', () => {
    const [firstLine] = tokenizeCodeLines('const x = 1;', 'typescript');
    expect(firstLine).toBeDefined();
    expect(firstLine?.some(token => token.className !== null)).toBe(true);
    const keywordToken = firstLine?.find(token => token.className === 'keyword');
    expect(keywordToken?.text).toBe('const');
  });
});
