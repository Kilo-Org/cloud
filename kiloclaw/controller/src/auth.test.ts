import { describe, expect, it } from 'vitest';
import { timingSafeTokenEqual } from './auth';

describe('timingSafeTokenEqual', () => {
  it('returns true only for exact token match', () => {
    expect(timingSafeTokenEqual('token-1', 'token-1')).toBe(true);
    expect(timingSafeTokenEqual('token-2', 'token-1')).toBe(false);
  });

  it('returns false when token is missing', () => {
    expect(timingSafeTokenEqual(undefined, 'token-1')).toBe(false);
    expect(timingSafeTokenEqual(null, 'token-1')).toBe(false);
  });
});
