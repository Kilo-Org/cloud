import { describe, expect, it } from 'vitest';
import {
  LEASE_GRANT_MAX_TTL_SECONDS,
  LeaseRequestSchema,
  LeaseResultSchema,
  LeaseRevokeRequestSchema,
  STS_LEASE_HTTP_PATH,
  STS_LEASE_REVOKE_HTTP_PATH,
  leaseResultHttpStatus,
  leaseRevokeResultHttpStatus,
} from './lease';

describe('lease contracts', () => {
  it('accepts the two grants, a lifetime from 5 minutes to a day, and nothing else', () => {
    expect(LeaseRequestSchema.parse({ grant: 'replica-read' })).toEqual({ grant: 'replica-read' });
    expect(LeaseRequestSchema.parse({ grant: 'ci-migration', ttlSeconds: 3600 })).toEqual({
      grant: 'ci-migration',
      ttlSeconds: 3600,
    });
    for (const bad of [
      { grant: 'admin' },
      { grant: 'replica-read', ttlSeconds: 299 },
      { grant: 'replica-read', ttlSeconds: 86_401 },
      { grant: 'replica-read', ttlSeconds: 600.5 },
      { grant: 'replica-read', host: 'db.example.invalid' },
    ]) {
      expect(LeaseRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(LeaseRevokeRequestSchema.safeParse({ leaseId: 'not-a-uuid' }).success).toBe(false);
  });

  it('caps replica-read at 8 hours and ci-migration at 1 hour (design 4.5)', () => {
    expect(LEASE_GRANT_MAX_TTL_SECONDS).toEqual({ 'replica-read': 28_800, 'ci-migration': 3600 });
  });

  it('maps every answer to its HTTP status', () => {
    const leaseId = crypto.randomUUID();
    const issued = LeaseResultSchema.parse({
      status: 'ok',
      leaseId,
      grant: 'ci-migration',
      username: 'lease_user',
      password: 'synthetic',
      expiresAt: new Date().toISOString(),
      ttlSeconds: 3600,
      clamped: false,
      host: 'db.example.invalid',
      port: 5432,
      database: 'postgres',
    });
    expect(leaseResultHttpStatus(issued)).toBe(200);
    expect(leaseResultHttpStatus({ status: 'invalid_request' })).toBe(400);
    expect(leaseResultHttpStatus({ status: 'denied', reason: 'identity_rejected' })).toBe(401);
    expect(leaseResultHttpStatus({ status: 'denied', reason: 'grant_not_allowed' })).toBe(403);
    expect(
      leaseResultHttpStatus({ status: 'limited', reason: 'too_many_active', retryAfterSeconds: 5 })
    ).toBe(429);
    expect(leaseResultHttpStatus({ status: 'unavailable', retryAfterSeconds: 30 })).toBe(503);
    expect(leaseRevokeResultHttpStatus({ status: 'revoked', leaseId })).toBe(200);
    expect(leaseRevokeResultHttpStatus({ status: 'not_found' })).toBe(404);
    expect(STS_LEASE_HTTP_PATH).toBe('/v1/lease');
    expect(STS_LEASE_REVOKE_HTTP_PATH).toBe('/v1/lease/revoke');
  });
});
