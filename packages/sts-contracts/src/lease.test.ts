import { describe, expect, it } from 'vitest';
import {
  LEASE_GRANT_MAX_TTL_SECONDS,
  LeaseRequestSchema,
  LeaseResultSchema,
  LeaseRevokeRequestSchema,
} from './lease';

describe('lease contracts', () => {
  it('accepts replica-read, a lifetime from 5 minutes to a day, and nothing else', () => {
    expect(LeaseRequestSchema.parse({ grant: 'replica-read' })).toEqual({ grant: 'replica-read' });
    expect(LeaseRequestSchema.parse({ grant: 'replica-read', ttlSeconds: 3600 })).toEqual({
      grant: 'replica-read',
      ttlSeconds: 3600,
    });
    for (const bad of [
      { grant: 'admin' },
      { grant: 'ci-migration' },
      { grant: 'replica-read', ttlSeconds: 299 },
      { grant: 'replica-read', ttlSeconds: 86_401 },
      { grant: 'replica-read', ttlSeconds: 600.5 },
      { grant: 'replica-read', host: 'db.example.invalid' },
    ]) {
      expect(LeaseRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(LeaseRevokeRequestSchema.safeParse({ leaseId: 'not-a-uuid' }).success).toBe(false);
  });

  it('caps replica-read at 8 hours (design 4.5)', () => {
    expect(LEASE_GRANT_MAX_TTL_SECONDS).toEqual({ 'replica-read': 28_800 });
  });

  it('issues a lease without a connection target', () => {
    const issued = {
      status: 'ok',
      leaseId: crypto.randomUUID(),
      grant: 'replica-read',
      username: 'lease_user',
      password: 'synthetic',
      expiresAt: new Date().toISOString(),
      ttlSeconds: 3600,
      clamped: false,
    };
    expect(LeaseResultSchema.parse(issued)).toEqual(issued);
    expect(LeaseResultSchema.safeParse({ ...issued, host: 'db.example.invalid' }).success).toBe(
      false
    );
  });
});
