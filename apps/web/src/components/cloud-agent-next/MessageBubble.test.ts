import { describe, it, expect } from '@jest/globals';
import LinkifyIt from 'linkify-it';

const linkify = new LinkifyIt();

describe('linkify-it URL matching', () => {
  it('preserves balanced parentheses', () => {
    const matches = linkify.match('https://en.wikipedia.org/wiki/Function_(mathematics)');
    expect(matches).toHaveLength(1);
    expect(matches?.[0].url).toBe('https://en.wikipedia.org/wiki/Function_(mathematics)');
    expect(matches?.[0].text).toBe('https://en.wikipedia.org/wiki/Function_(mathematics)');
  });

  it('removes trailing punctuation after balanced parentheses', () => {
    const matches = linkify.match('Check https://en.wikipedia.org/wiki/Function_(mathematics).');
    expect(matches).toHaveLength(1);
    expect(matches?.[0].url).toBe('https://en.wikipedia.org/wiki/Function_(mathematics)');
  });

  it('removes single unmatched closing parenthesis', () => {
    const matches = linkify.match('See (https://example.com/path)');
    expect(matches).toHaveLength(1);
    expect(matches?.[0].url).toBe('https://example.com/path');
  });

  it('removes multiple unmatched closing parentheses', () => {
    const matches = linkify.match('((https://example.com/path))');
    expect(matches).toHaveLength(1);
    expect(matches?.[0].url).toBe('https://example.com/path');
  });

  it('preserves URL with multiple balanced parentheses', () => {
    const matches = linkify.match('https://example.com/foo_(bar)_baz_(qux)');
    expect(matches).toHaveLength(1);
    expect(matches?.[0].url).toBe('https://example.com/foo_(bar)_baz_(qux)');
  });

  it('handles URL with no trailing characters', () => {
    const matches = linkify.match('https://example.com/path');
    expect(matches).toHaveLength(1);
    expect(matches?.[0].url).toBe('https://example.com/path');
  });

  it('handles multiple URLs in text', () => {
    const matches = linkify.match('First: https://foo.com and second: https://bar.com/path');
    expect(matches).toHaveLength(2);
    expect(matches?.[0].url).toBe('https://foo.com');
    expect(matches?.[1].url).toBe('https://bar.com/path');
  });

  it('returns null for text without URLs', () => {
    const matches = linkify.match('No URLs here');
    expect(matches).toBeNull();
  });

  it('matches http and https URLs', () => {
    const matches = linkify.match('http://example.com and https://example.com');
    expect(matches).toHaveLength(2);
  });
});
