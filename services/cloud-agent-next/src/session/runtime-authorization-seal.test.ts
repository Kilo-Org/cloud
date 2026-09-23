import { sealRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import { describe, expect, it, vi } from 'vitest';
import { parseSessionMetadata } from '../persistence/session-metadata.js';
import {
  loadRecoverableRuntimeAuthorization,
  replaceStoredRuntimeAuthorization,
  unsealActiveRuntimeAuthorization,
} from './runtime-authorization-seal.js';

const secret = 'unit-test-runtime-authorization-secret';
const identity = {
  sessionId: '33333333-3333-4333-8333-333333333333',
  userId: '44444444-4444-4444-8444-444444444444',
  orgId: '11111111-1111-4111-8111-111111111111',
};

function authorization(state: 'active' | 'revoked' = 'active'): RuntimeAuthorization {
  return {
    version: 1,
    id: '22222222-2222-4222-8222-222222222222',
    resourceKind: 'cloud-agent-next',
    resourceId: identity.sessionId,
    userId: identity.userId,
    authorizationUserId: identity.userId,
    organizationId: identity.orgId,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    delegationExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    state,
    bindings: {
      userPepperDigest: 'a'.repeat(64),
      authorizationPepperDigest: 'b'.repeat(64),
      userMembershipId: 'membership_1',
      authorizationUserMembershipId: 'membership_1',
    },
    source: { admissionSource: 'user' },
  };
}

function metadata(userId = identity.userId) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: { ...identity, userId },
    auth: {},
    lifecycle: { version: 1, timestamp: 1 },
  });
}

describe('unsealActiveRuntimeAuthorization', () => {
  it('reports a missing secret binding', async () => {
    const result = await unsealActiveRuntimeAuthorization({
      secretBinding: undefined,
      seal: 'sealed',
      identity,
    });

    expect(result).toEqual({ status: 'missing_secret' });
  });

  it('rejects a seal bound to another session', async () => {
    const seal = await sealRuntimeAuthorization(authorization(), secret);

    const result = await unsealActiveRuntimeAuthorization({
      secretBinding: secret,
      seal,
      identity: { ...identity, sessionId: '55555555-5555-4555-8555-555555555555' },
    });

    expect(result).toEqual({ status: 'invalid_seal' });
  });

  it('rejects a seal that is not a token', async () => {
    const result = await unsealActiveRuntimeAuthorization({
      secretBinding: secret,
      seal: 'not-a-sealed-authorization',
      identity,
    });

    expect(result).toEqual({ status: 'invalid_seal' });
  });

  it('reports a revoked authorization as inactive', async () => {
    const seal = await sealRuntimeAuthorization(authorization('revoked'), secret);

    const result = await unsealActiveRuntimeAuthorization({
      secretBinding: secret,
      seal,
      identity,
    });

    expect(result).toEqual({ status: 'fresh_authorization_inactive' });
  });

  it('returns an active authorization for its owning session', async () => {
    const value = authorization();
    const seal = await sealRuntimeAuthorization(value, secret);

    const result = await unsealActiveRuntimeAuthorization({
      secretBinding: secret,
      seal,
      identity,
    });

    expect(result).toEqual({ status: 'active', authorization: value });
  });
});

describe('loadRecoverableRuntimeAuthorization', () => {
  const request = { ownerId: identity.userId, runtimeAuthorizationSeal: 'sealed' };

  it('denies recovery without stored metadata', async () => {
    const result = await loadRecoverableRuntimeAuthorization(
      request,
      undefined,
      identity.sessionId,
      secret
    );

    expect(result).toEqual({ status: 'denied' });
  });

  it('denies recovery for a different owner', async () => {
    const result = await loadRecoverableRuntimeAuthorization(
      request,
      metadata('66666666-6666-4666-8666-666666666666'),
      identity.sessionId,
      secret
    );

    expect(result).toEqual({ status: 'denied' });
  });

  it('denies recovery for an unusable seal', async () => {
    const result = await loadRecoverableRuntimeAuthorization(
      request,
      metadata(),
      identity.sessionId,
      secret
    );

    expect(result).toEqual({ status: 'denied' });
  });

  it('returns the stored metadata and authorization with a bound deny reporter', async () => {
    const value = authorization();
    const seal = await sealRuntimeAuthorization(value, secret);

    const result = await loadRecoverableRuntimeAuthorization(
      { ...request, runtimeAuthorizationSeal: seal },
      metadata(),
      identity.sessionId,
      secret
    );

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected a ready prelude');
    expect(result.metadata.identity.userId).toBe(identity.userId);
    expect(result.authorization).toEqual(value);
    expect(result.deny('authorization_state_changed')).toEqual({ status: 'denied' });
  });
});

describe('replaceStoredRuntimeAuthorization', () => {
  const stored = async () => authorization();

  it('rejects a missing or foreign owner before unsealing', async () => {
    const writeStored = vi.fn();

    await expect(
      replaceStoredRuntimeAuthorization(
        {
          ownerId: identity.userId,
          expectedOldId: '22222222-2222-4222-8222-222222222222',
          runtimeAuthorizationSeal: 'x',
        },
        metadata('66666666-6666-4666-8666-666666666666'),
        secret,
        stored,
        writeStored
      )
    ).resolves.toBe(false);
    expect(writeStored).not.toHaveBeenCalled();
  });

  it('rejects a stored authorization that is not the expected one', async () => {
    const value = authorization();
    const seal = await sealRuntimeAuthorization(value, secret);
    const writeStored = vi.fn();

    await expect(
      replaceStoredRuntimeAuthorization(
        {
          ownerId: identity.userId,
          expectedOldId: '77777777-7777-4777-8777-777777777777',
          runtimeAuthorizationSeal: seal,
        },
        metadata(),
        secret,
        stored,
        writeStored
      )
    ).resolves.toBe(false);
    expect(writeStored).not.toHaveBeenCalled();
  });

  it('writes the freshly unsealed authorization', async () => {
    const value = authorization();
    const seal = await sealRuntimeAuthorization(value, secret);
    const writeStored = vi.fn();

    await expect(
      replaceStoredRuntimeAuthorization(
        {
          ownerId: identity.userId,
          expectedOldId: '22222222-2222-4222-8222-222222222222',
          runtimeAuthorizationSeal: seal,
        },
        metadata(),
        secret,
        stored,
        writeStored
      )
    ).resolves.toBe(true);
    expect(writeStored).toHaveBeenCalledWith(value);
  });
});
