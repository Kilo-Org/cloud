import { describe, expect, it } from 'vitest';

import { isSelfCleanupProcedureCall, SELF_CLEANUP_PROCEDURES } from './self-cleanup-procedures';

describe('isSelfCleanupProcedureCall', () => {
  it('accepts every listed procedure as the mutation it is declared as', () => {
    for (const entry of SELF_CLEANUP_PROCEDURES) {
      expect(entry.type).toBe('mutation');
      expect(isSelfCleanupProcedureCall({ path: entry.path, type: entry.type })).toBe(true);
    }
  });

  it('accepts a listed procedure that carries the request query string', () => {
    expect(
      isSelfCleanupProcedureCall({
        path: 'user.unregisterPushToken?batch=1&input=%7B%7D',
        type: 'mutation',
      })
    ).toBe(true);
  });

  // The exemption is for self-scoped writes: the same path as a read must not
  // be admitted, or a query added to the shared list would reach a refused
  // account.
  it('rejects a listed path arriving as a query', () => {
    for (const entry of SELF_CLEANUP_PROCEDURES) {
      expect(isSelfCleanupProcedureCall({ path: entry.path, type: 'query' })).toBe(false);
    }
  });

  it('rejects a listed path whose call kind is missing', () => {
    for (const entry of SELF_CLEANUP_PROCEDURES) {
      expect(isSelfCleanupProcedureCall({ path: entry.path })).toBe(false);
    }
  });

  it('rejects a path that is not listed', () => {
    expect(isSelfCleanupProcedureCall({ path: 'user.getMe', type: 'mutation' })).toBe(false);
    expect(
      isSelfCleanupProcedureCall({ path: 'user.unregisterPushTokenAll', type: 'mutation' })
    ).toBe(false);
    expect(isSelfCleanupProcedureCall({ path: '', type: 'mutation' })).toBe(false);
  });
});
