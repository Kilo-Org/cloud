import { describe, expect, it } from 'vitest';
import {
  createRuntimeProxyGrant,
  issueRuntimeCredentialProxyHandle,
} from '../../runtime-credential-proxy.js';
import { parseSessionMetadata } from '../../persistence/session-metadata.js';
import { getSessionSyncLiveRootGrantProof } from './session-sync-live-root-grant.js';
import type { ControlPlaneSessionRegistration } from './session-do.js';

async function fixture() {
  const now = Date.now();
  const env = { NEXTAUTH_SECRET: 'synthetic-local-proof-signing-secret' };
  const sessionId = 'workspace_syntheticroot';
  const kiloSessionId = `ses_${'a'.repeat(26)}`;
  const fence = {
    plane: 'control' as const,
    allocationId: 'synthetic-allocation',
    providerInstanceId: 'synthetic-provider',
    connectionId: 'synthetic-connection',
    wrapperInstanceId: 'synthetic-wrapper',
  };
  const authorization = {
    version: 1,
    id: crypto.randomUUID(),
    resourceKind: 'cloud-agent-next',
    resourceId: sessionId,
    userId: 'synthetic-owner',
    authorizationUserId: 'synthetic-owner',
    issuedAt: new Date(now - 1000).toISOString(),
    delegationExpiresAt: new Date(now + 3_600_000).toISOString(),
    state: 'active',
    bindings: { userPepperDigest: 'null', authorizationPepperDigest: 'null' },
    source: { admissionSource: 'user' },
  };
  const grant = createRuntimeProxyGrant({
    ...fence,
    authorizationId: authorization.id,
    sessionId,
    kiloSessionId,
    userId: authorization.userId,
    mode: 'contained',
    leaseExpiresAt: now + 300_000,
    state: 'active',
  });
  const handle = await issueRuntimeCredentialProxyHandle(env, grant);
  const metadata = parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: { sessionId, userId: authorization.userId },
    auth: { kiloSessionId, kilocodeToken: 'synthetic-token' },
    agent: { mode: 'code', model: 'synthetic/model' },
    workspace: { sandboxId: `ses-${'a'.repeat(48)}` },
    lifecycle: { version: 1, timestamp: 1 },
  });
  const registration = {
    sandboxId: `ses-${'a'.repeat(48)}`,
    spec: { sessionId, kiloSessionId, directory: '/workspace/app' },
    credentials: { userId: authorization.userId, kiloSessionId, scopeId: sessionId },
  } as ControlPlaneSessionRegistration;
  const request = {
    ownerId: authorization.userId,
    sessionId,
    kiloSessionId,
    sandboxId: registration.sandboxId,
    directory: registration.spec.directory,
    scopeId: sessionId,
    fence,
    handle,
  };
  const state = { metadata, registration, authorization, grant };
  return { request, env, ...state, readState: async () => state };
}

describe('local-only Session Sync root proof', () => {
  it('proves a stored private grant without a peer, callback, renewal, or token result', async () => {
    const f = await fixture();
    const proof = await getSessionSyncLiveRootGrantProof(f);
    expect(proof).toEqual({
      type: 'allowed',
      ...f.request,
      handle: undefined,
      expiresAt: expect.any(Number),
    });
    expect(Object.keys(proof)).not.toContain('handle');
    expect(JSON.stringify(proof)).not.toContain('synthetic-token');
  });

  it.each([
    'nonce',
    'root',
    'authorization',
    'revoked',
    'expired',
    'allocation',
    'provider',
    'wrapper',
    'scope',
    'registration',
    'tenant',
  ])('denies a mismatched %s', async mismatch => {
    const f = await fixture();
    if (mismatch === 'nonce') f.grant.nonce = 'b'.repeat(43);
    if (mismatch === 'root') f.grant.kiloSessionId = `ses_${'b'.repeat(26)}`;
    if (mismatch === 'authorization') f.authorization.id = crypto.randomUUID();
    if (mismatch === 'revoked') f.authorization.state = 'revoked';
    if (mismatch === 'expired')
      Object.assign(f.authorization, {
        issuedAt: new Date(Date.now() - 3_600_000).toISOString(),
        delegationExpiresAt: new Date(Date.now() - 100).toISOString(),
      });
    if (mismatch === 'allocation') f.request.fence.allocationId = 'synthetic-old-allocation';
    if (mismatch === 'provider') f.request.fence.providerInstanceId = 'synthetic-old-provider';
    if (mismatch === 'wrapper') f.request.fence.wrapperInstanceId = 'synthetic-old-wrapper';
    if (mismatch === 'scope') f.request.scopeId = 'synthetic-other-scope';
    if (mismatch === 'registration') f.registration.spec.directory = '/workspace/other';
    if (mismatch === 'tenant')
      Object.assign(f.request, { organizationId: 'synthetic-other-tenant' });
    expect(await getSessionSyncLiveRootGrantProof(f)).toEqual({ type: 'denied' });
  });

  it('keeps same-wrapper socket reconnect compatible', async () => {
    const f = await fixture();
    f.request.fence.connectionId = 'synthetic-reconnected-socket';
    expect(await getSessionSyncLiveRootGrantProof(f)).toMatchObject({ type: 'allowed' });
  });
});
