import { describe, it, expect } from '@jest/globals';
import { cleanUrl } from './url-utils';

describe('cleanUrl', () => {
  it('preserves balanced parentheses', () => {
    expect(cleanUrl('https://en.wikipedia.org/wiki/Function_(mathematics)')).toEqual({
      url: 'https://en.wikipedia.org/wiki/Function_(mathematics)',
      trailing: '',
    });
  });

  it('removes trailing punctuation after balanced parentheses', () => {
    expect(cleanUrl('https://en.wikipedia.org/wiki/Function_(mathematics).')).toEqual({
      url: 'https://en.wikipedia.org/wiki/Function_(mathematics)',
      trailing: '.',
    });
  });

  it('removes multiple trailing punctuation', () => {
    expect(cleanUrl('https://example.com/path...')).toEqual({
      url: 'https://example.com/path',
      trailing: '...',
    });
  });

  it('removes single unmatched closing parenthesis', () => {
    expect(cleanUrl('https://example.com/path)')).toEqual({
      url: 'https://example.com/path',
      trailing: ')',
    });
  });

  it('removes multiple unmatched closing parentheses', () => {
    expect(cleanUrl('https://example.com/path))')).toEqual({
      url: 'https://example.com/path',
      trailing: '))',
    });
  });

  it('removes dangling parentheses with punctuation', () => {
    expect(cleanUrl('https://example.com/path)).')).toEqual({
      url: 'https://example.com/path',
      trailing: ')).',
    });
  });

  it('preserves URL with multiple balanced parentheses', () => {
    expect(cleanUrl('https://example.com/foo_(bar)_baz_(qux)')).toEqual({
      url: 'https://example.com/foo_(bar)_baz_(qux)',
      trailing: '',
    });
  });

  it('removes only the extra closing parens from unbalanced URL', () => {
    expect(cleanUrl('https://example.com/foo_(bar)))')).toEqual({
      url: 'https://example.com/foo_(bar)',
      trailing: '))',
    });
  });

  it('handles URL with no trailing characters', () => {
    expect(cleanUrl('https://example.com/path')).toEqual({
      url: 'https://example.com/path',
      trailing: '',
    });
  });

  it('strips trailing punctuation without parentheses', () => {
    expect(cleanUrl('https://example.com/path!')).toEqual({
      url: 'https://example.com/path',
      trailing: '!',
    });
    expect(cleanUrl('https://example.com/path?')).toEqual({
      url: 'https://example.com/path',
      trailing: '?',
    });
  });
});
