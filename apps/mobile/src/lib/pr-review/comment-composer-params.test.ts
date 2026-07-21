import { describe, expect, it } from 'vitest';

import { parseComposerParams } from '@/lib/pr-review/comment-composer-params';

function valid(overrides: Record<string, unknown> = {}) {
  return {
    owner: 'kilocode',
    repo: 'kilo',
    number: '42',
    path: 'src/lib.ts',
    side: 'RIGHT',
    line: '7',
    ...overrides,
  };
}

describe('parseComposerParams', () => {
  it('returns parsed params for the happy path', () => {
    expect(parseComposerParams(valid())).toEqual({
      owner: 'kilocode',
      repo: 'kilo',
      number: 42,
      path: 'src/lib.ts',
      side: 'RIGHT',
      line: 7,
    });
  });

  it('parses optional startLine when present and <= line', () => {
    expect(parseComposerParams(valid({ startLine: '5' }))).toEqual(
      expect.objectContaining({ startLine: 5 })
    );
  });

  it('rejects a missing owner', () => {
    expect(parseComposerParams(valid({ owner: undefined }))).toBeNull();
  });

  it('rejects a missing repo', () => {
    expect(parseComposerParams(valid({ repo: undefined }))).toBeNull();
  });

  it('rejects a non-positive number', () => {
    expect(parseComposerParams(valid({ number: '0' }))).toBeNull();
    expect(parseComposerParams(valid({ number: '-1' }))).toBeNull();
    expect(parseComposerParams(valid({ number: 'abc' }))).toBeNull();
  });

  it('rejects an empty path', () => {
    expect(parseComposerParams(valid({ path: '' }))).toBeNull();
  });

  it('rejects an invalid side', () => {
    expect(parseComposerParams(valid({ side: 'MIDDLE' }))).toBeNull();
    expect(parseComposerParams(valid({ side: undefined }))).toBeNull();
  });

  it('rejects a non-positive line', () => {
    expect(parseComposerParams(valid({ line: '0' }))).toBeNull();
    expect(parseComposerParams(valid({ line: '-3' }))).toBeNull();
    expect(parseComposerParams(valid({ line: 'abc' }))).toBeNull();
  });

  it('rejects startLine greater than line', () => {
    expect(parseComposerParams(valid({ line: '5', startLine: '6' }))).toBeNull();
  });

  it('rejects a non-positive startLine', () => {
    expect(parseComposerParams(valid({ startLine: '0' }))).toBeNull();
    expect(parseComposerParams(valid({ startLine: '-1' }))).toBeNull();
  });
});
