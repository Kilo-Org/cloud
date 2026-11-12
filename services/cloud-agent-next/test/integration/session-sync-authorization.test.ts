import { createExecutionContext, env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { SessionSyncAuthorization } from '../../src/session-sync-authorization.js';
import {
  createRuntimeProxyGrant,
  issueRuntimeCredentialProxyHandle,
} from '../../src/runtime-credential-proxy.js';
import { getSandboxSessionStub } from '../../src/sandbox-session/session-stub.js';
import type { Env } from '../../src/types.js';
import type { ScopeGrantView } from '../../src/control-plane/sandbox/scope-view.js';

const { getPgDb } = vi.hoisted(() => ({ getPgDb: vi.fn() }));
vi.mock('../../src/db/pg.js', () => ({ getPgDb }));

type Statement = { sql: string; params: unknown[] };

/** Answers the caller-first owner lookup, then the owned-root lookup. */
function postgres(input: { owner?: string; roots?: [string, string][] }) {
  const statements: Statement[] = [];
  getPgDb.mockReturnValue(
    drizzle(async (sql, params) => {
      statements.push({ sql, params });
      if (statements.length === 1) return { rows: input.owner ? [[input.owner]] : [] };
      return { rows: input.roots ?? [] };
    })
  );
  return statements;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function fixture(scopeView?: ScopeGrantView) {
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
      ...(scopeView ? { scopeView } : {}),
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

describe('Session Sync descendant authorization', () => {
  const childId = 'ses_syntheticchild';
  const memberRoot = 'ses_syntheticmember';
  const memberCloudSessionId = `workspace_${crypto.randomUUID()}`;

  async function spyDescendant(f: Awaited<ReturnType<typeof fixture>>, owned: boolean) {
    const calls: [string, string][] = [];
    await runInDurableObject(f.stub, instance => {
      vi.spyOn(Object.getPrototypeOf(instance), 'hasSessionSyncDescendant').mockImplementation(
        async (root: unknown, child: unknown) => {
          calls.push([String(root), String(child)]);
          return owned;
        }
      );
    });
    return calls;
  }

  it('keeps the handle root when the scope view is empty', async () => {
    const f = await fixture({
      scopeId: 'synthetic-scope',
      expectedOrganizationId: null,
      memberRootKiloSessionIds: [],
    });
    expect(
      await f.service.authorizeUpload({ handle: f.handle, sessionID: f.kiloSessionId })
    ).toEqual({ userID: f.userId, expiresAt: expect.any(Number) });
  });

  it('checks a descendant against the handle root and every scope member', async () => {
    const f = await fixture({
      scopeId: 'synthetic-scope',
      expectedOrganizationId: null,
      memberRootKiloSessionIds: [memberRoot],
    });
    const statements = postgres({ roots: [[memberCloudSessionId, memberRoot]] });
    const calls = await spyDescendant(f, true);
    expect(await f.service.authorizeUpload({ handle: f.handle, sessionID: childId })).toEqual({
      userID: f.userId,
      expiresAt: expect.any(Number),
    });
    expect(statements).toHaveLength(2);
    expect(statements[0].params).toEqual([childId, f.userId, 1]);
    expect(statements[1].params).toEqual([f.userId, f.kiloSessionId, memberRoot]);
    expect(calls).toEqual([[memberRoot, childId]]);
  });

  it('rejects a session that another user owns before it reads runtime lineage', async () => {
    const f = await fixture();
    postgres({ owner: 'synthetic-other-owner', roots: [[memberCloudSessionId, f.kiloSessionId]] });
    const calls = await spyDescendant(f, true);
    expect(await f.service.authorizeUpload({ handle: f.handle, sessionID: childId })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('keeps authorizing an owned session when another user adds a row for its ID', async () => {
    const f = await fixture();
    // The lookup orders the caller's row first, so the database returns it before the foreign row.
    const statements = postgres({
      owner: f.userId,
      roots: [[memberCloudSessionId, f.kiloSessionId]],
    });
    const calls = await spyDescendant(f, true);
    expect(await f.service.authorizeUpload({ handle: f.handle, sessionID: childId })).toEqual({
      userID: f.userId,
      expiresAt: expect.any(Number),
    });
    expect(statements[0].sql).toMatch(/order by .*"kilo_user_id" = \$2.* desc/i);
    expect(calls).toEqual([[f.kiloSessionId, childId]]);
  });

  it('asks the uploader to retry while descendant lineage is not stored yet', async () => {
    const f = await fixture();
    postgres({ roots: [[memberCloudSessionId, f.kiloSessionId]] });
    await spyDescendant(f, false);
    await expect(
      f.service.authorizeUpload({ handle: f.handle, sessionID: childId })
    ).rejects.toThrow('Native session ownership is not available');
  });
});
