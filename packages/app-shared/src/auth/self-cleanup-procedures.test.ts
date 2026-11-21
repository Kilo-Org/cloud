import { describe, expect, it } from 'vitest';

import { isSelfCleanupProcedure, SELF_CLEANUP_PROCEDURES } from './self-cleanup-procedures';

describe('isSelfCleanupProcedure', () => {
  it('accepts every listed procedure', () => {
    for (const path of SELF_CLEANUP_PROCEDURES) {
      expect(isSelfCleanupProcedure(path)).toBe(true);
    }
  });

  it('accepts a listed procedure that carries the request query string', () => {
    expect(isSelfCleanupProcedure('user.unregisterPushToken?batch=1&input=%7B%7D')).toBe(true);
  });

  it('rejects a path that is not listed', () => {
    expect(isSelfCleanupProcedure('user.getMe')).toBe(false);
    expect(isSelfCleanupProcedure('user.unregisterPushTokenAll')).toBe(false);
    expect(isSelfCleanupProcedure('')).toBe(false);
  });
});
