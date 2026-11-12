import { createExecutionContext, env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionSyncAuthorization } from '../../src/session-sync-authorization.js';
import {
  createRuntimeProxyGrant,
  issueRuntimeCredentialProxyHandle,
} from '../../src/runtime-credential-proxy.js';
import { getSandboxSessionStub } from '../../src/sandbox-session/session-stub.js';
import type { Env } from '../../src/types.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function fixture() {
  const bindings = env as Env;
  const userId = 'synthetic-sync-owner';
  const sessionId = `workspace_${crypto.randomUUID()}`;
  const kiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '')}`;
  const grant = createRuntimeProxyGrant({
    plane: 'control',
    authorizationId: crypto.randomUUID(),
    sessionId,
    kiloSessionId,
    userId,
    mode: 'contained',
    allocationId: crypto.randomUUID(),
    providerInstanceId: 'synthetic-provider',
    connectionId: 'synthetic-connection',
    wrapperInstanceId: 'synthetic-wrapper',
    leaseExpiresAt: Date.now() + 60_000,
    state: 'active',
  });
  const handle = await issueRuntimeCredentialProxyHandle(bindings, grant);
  const stub = getSandboxSessionStub(bindings, userId, sessionId);
  await runInDurableObject(stub, instance => {
    vi.spyOn(
      Object.getPrototypeOf(instance),
      'resolveRuntimeCredentialProxyGrant'
    ).mockResolvedValue({
      token: 'synthetic-backing-token-never-returned',
      runtimeAuthorization: {
        userId,
        authorizationId: grant.authorizationId,
        resourceId: sessionId,
      },
    });
  });
  return {
    bindings,
    handle,
    stub,
    userId,
    kiloSessionId,
    service: new SessionSyncAuthorization(createExecutionContext(), bindings),
  };
}

describe('Session Sync binding-only authorization', () => {
  it('returns the current owner, but no backing credential', async () => {
    const f = await fixture();
    expect(
      await f.service.authorizeUpload({ handle: f.handle, sessionID: f.kiloSessionId })
    ).toEqual({ userID: f.userId, expiresAt: expect.any(Number) });
  });
  it('rejects a signed handle after its current runtime grant is revoked', async () => {
    const f = await fixture();
    await runInDurableObject(f.stub, instance => {
      vi.spyOn(
        Object.getPrototypeOf(instance),
        'resolveRuntimeCredentialProxyGrant'
      ).mockResolvedValue(null);
    });
    expect(
      await f.service.authorizeUpload({ handle: f.handle, sessionID: f.kiloSessionId })
    ).toBeNull();
  });
  it('rejects forged handles and caller-supplied identity fields', async () => {
    const f = await fixture();
    expect(await f.service.authorizeUpload({ handle: 'synthetic-invalid-handle' })).toBeNull();
    expect(
      await f.service.authorizeUpload({ handle: f.handle, userId: 'synthetic-other-owner' })
    ).toBeNull();
  });
});
