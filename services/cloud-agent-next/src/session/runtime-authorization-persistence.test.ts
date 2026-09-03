import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import { RuntimeAuthorizationRevokedError } from '@kilocode/worker-utils/runtime-authorization';
import {
  getRuntimeAuthorizationStatus,
  renewStoredRuntimeAuthorization,
} from './runtime-authorization-persistence.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';

const authorization = (
  id: string,
  state: 'active' | 'revoked' = 'active'
): RuntimeAuthorization => ({
  version: 1,
  id,
  resourceKind: 'cloud-agent-next',
  resourceId: 'agent_1',
  userId: 'user_1',
  authorizationUserId: 'user_1',
  organizationId: 'org_1',
  issuedAt: '2026-01-01T00:00:00.000Z',
  state,
  bindings: {
    userPepperDigest: 'a'.repeat(64),
    authorizationPepperDigest: 'b'.repeat(64),
    userMembershipId: 'membership_1',
    authorizationUserMembershipId: 'membership_1',
  },
  source: { admissionSource: 'user' },
});

const metadata = (token?: string): SessionMetadata =>
  ({
    metadataSchemaVersion: 2,
    identity: { sessionId: 'agent_1', userId: 'user_1', orgId: 'org_1' },
    auth: token ? { kilocodeToken: token } : {},
    agent: {},
    workspace: {},
    lifecycle: { version: 1, timestamp: 0 },
  }) as SessionMetadata;

describe('runtime authorization persistence', () => {
  it('leaves legacy tokens unchanged and reports legacy without a private record', async () => {
    const stored = metadata('legacy-token');
    const token = await renewStoredRuntimeAuthorization({
      metadata: stored,
      getAuthorization: async () => undefined,
      putAuthorization: async () => {},
      getMetadata: async () => stored,
      putMetadata: async () => {},
      renew: async () => ({ token: 'renewed-token' }),
    });

    expect(token).toBe('legacy-token');
    await expect(
      getRuntimeAuthorizationStatus({ metadata: stored, getAuthorization: async () => undefined })
    ).resolves.toBe('legacy');
  });

  it('does not publish a renewal after a newer authorization replaces the record', async () => {
    let record: RuntimeAuthorization = authorization('00000000-0000-4000-8000-000000000001');
    const writes: SessionMetadata[] = [];
    await expect(
      renewStoredRuntimeAuthorization({
        metadata: metadata(),
        getAuthorization: async () => record,
        putAuthorization: async value => {
          record = value;
        },
        getMetadata: async () => metadata(),
        putMetadata: async value => {
          writes.push(value);
        },
        renew: async () => {
          record = authorization('00000000-0000-4000-8000-000000000002');
          return { token: 'new-token' };
        },
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
    expect(record.id).toBe('00000000-0000-4000-8000-000000000002');
    expect(writes).toEqual([]);
  });

  it('marks only the matching revoked record and never renews it', async () => {
    let record = authorization('00000000-0000-4000-8000-000000000003');
    await expect(
      renewStoredRuntimeAuthorization({
        metadata: metadata(),
        getAuthorization: async () => record,
        putAuthorization: async value => {
          record = value;
        },
        getMetadata: async () => metadata(),
        putMetadata: async () => {},
        renew: async () => {
          throw new RuntimeAuthorizationRevokedError();
        },
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
    expect(record.state).toBe('revoked');
  });

  it('treats modern-token metadata without a valid private record as revoked', async () => {
    const token = jwt.sign(
      { runtimeAuthorization: { id: '00000000-0000-4000-8000-000000000004' } },
      'test-secret'
    );
    await expect(
      renewStoredRuntimeAuthorization({
        metadata: metadata(token),
        getAuthorization: async () => undefined,
        putAuthorization: async () => {},
        getMetadata: async () => metadata(token),
        putMetadata: async () => {},
        renew: async () => ({ token: 'unexpected' }),
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
  });
});
