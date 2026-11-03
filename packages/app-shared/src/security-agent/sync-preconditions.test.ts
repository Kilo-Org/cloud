import { describe, expect, it } from 'vitest';

import {
  SECURITY_SYNC_PRECONDITION_CODES,
  securitySyncPreconditionForCode,
} from './sync-preconditions';

describe('securitySyncPreconditionForCode', () => {
  it('maps each wire code onto its precondition', () => {
    expect(securitySyncPreconditionForCode(SECURITY_SYNC_PRECONDITION_CODES.noRepositories)).toBe(
      'noRepositories'
    );
    expect(
      securitySyncPreconditionForCode(SECURITY_SYNC_PRECONDITION_CODES.integrationInactive)
    ).toBe('integrationInactive');
    expect(
      securitySyncPreconditionForCode(SECURITY_SYNC_PRECONDITION_CODES.missingPermission)
    ).toBe('missingPermission');
  });

  it('answers null for a missing or unknown code', () => {
    expect(securitySyncPreconditionForCode(undefined)).toBeNull();
    expect(securitySyncPreconditionForCode('')).toBeNull();
    expect(securitySyncPreconditionForCode('some_other_upstream_failure')).toBeNull();
  });

  it('never resolves an inherited object name as a precondition', () => {
    // A plain-object lookup would return `Object.prototype.constructor` here.
    expect(securitySyncPreconditionForCode('constructor')).toBeNull();
    expect(securitySyncPreconditionForCode('toString')).toBeNull();
    expect(securitySyncPreconditionForCode('__proto__')).toBeNull();
  });
});
