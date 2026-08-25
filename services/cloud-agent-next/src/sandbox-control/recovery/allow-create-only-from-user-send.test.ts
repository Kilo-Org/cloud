import { describe, expect, it } from 'vitest';
import { nextEnsureReadyStep } from '../ensure-ready.js';

describe('allowCreate', () => {
  it('creates only from stopped when the caller is a user send', () => {
    expect(nextEnsureReadyStep('stopped', true)).toBe('create');
    expect(nextEnsureReadyStep('stopped', false)).toBe('return');
    expect(nextEnsureReadyStep('failed', true)).toBe('release-failed');
    expect(nextEnsureReadyStep('unknown', true)).toBe('observe-unknown');
    expect(nextEnsureReadyStep('creating', true)).toBe('return');
    expect(nextEnsureReadyStep('running', true)).toBe('return');
  });
});
