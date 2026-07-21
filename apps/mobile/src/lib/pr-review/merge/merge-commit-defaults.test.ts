import { describe, expect, it } from 'vitest';

import {
  defaultCommitMessage,
  defaultCommitTitle,
} from '@/lib/pr-review/merge/merge-commit-defaults';

describe('defaultCommitTitle', () => {
  it('returns the PR title with the number appended', () => {
    expect(defaultCommitTitle('Add feature', 42)).toBe('Add feature (#42)');
  });
});

describe('defaultCommitMessage', () => {
  it('returns the PR body when it is non-empty', () => {
    expect(defaultCommitMessage('Description line')).toBe('Description line');
  });

  it('returns an empty string when the body is null', () => {
    expect(defaultCommitMessage(null)).toBe('');
  });

  it('returns an empty string when the body is whitespace only', () => {
    expect(defaultCommitMessage('   ')).toBe('');
  });

  it('returns the body after trimming surrounding whitespace', () => {
    expect(defaultCommitMessage('  meaningful body  ')).toBe('  meaningful body  ');
  });
});
