import { describe, expect, it } from 'vitest';

import { sessionBranchLabel } from '@/lib/session-branch-label';

describe('sessionBranchLabel', () => {
  it('has no label for an absent or empty branch', () => {
    expect(sessionBranchLabel(null)).toBeNull();
    expect(sessionBranchLabel(undefined)).toBeNull();
    expect(sessionBranchLabel('')).toBeNull();
  });

  it('decodes a percent-encoded branch', () => {
    expect(sessionBranchLabel('fix/%E8%AB%8B%E6%B1%82%E6%9B%B8')).toBe('fix/請求書');
  });

  it('leaves a plain branch unchanged', () => {
    expect(sessionBranchLabel('feature/x')).toBe('feature/x');
  });

  it('keeps a malformed escape raw and does not throw', () => {
    expect(sessionBranchLabel('fix/100%')).toBe('fix/100%');
    expect(sessionBranchLabel('fix/%E')).toBe('fix/%E');
    expect(sessionBranchLabel('100%')).toBe('100%');
  });
});
