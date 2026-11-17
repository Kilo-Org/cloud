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
import { getSandboxControlStub } from '../../src/sandbox-control/stub.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { sandboxSessionSyncLiveRequestSchema } from '../../src/control-plane/sandbox/session-sync-live-authority.js';
import { cloudAgentSyncLiveResultSchema } from '@kilocode/worker-utils/cloud-agent-session-sync';

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
    sessionId,
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

describe('binding-only hosted live identity and persisted cohort', () => {
  async function liveFixture() {
    const member = {
      sessionId: `workspace_${crypto.randomUUID()}`,
      kiloSessionId: `ses_${'b'.repeat(26)}`,
    };
    const f = await fixture({
      scopeId: 'synthetic-live-scope',
      expectedOrganizationId: null,
      memberRootKiloSessionIds: [member.kiloSessionId],
      members: [member],
    });
    const sandboxId = `ses-${'a'.repeat(48)}`;
    const memberStub = getSandboxSessionStub(f.bindings, f.userId, member.sessionId);
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: { userId: f.userId, sessionId: member.sessionId },
      auth: { kiloSessionId: member.kiloSessionId, kilocodeToken: 'synthetic-hidden-token' },
      agent: { mode: 'code', model: 'synthetic/model' },
      workspace: { sandboxId, workspacePath: '/workspace/synthetic', chat: { transport: 'relay' } },
      lifecycle: { version: 1, timestamp: 1 },
    });
    await runInDurableObject(memberStub, instance => {
      Object.assign(instance, { metadata });
      vi.spyOn(Object.getPrototypeOf(instance), 'hasSessionSyncDescendant').mockImplementation(
        async (root, child) => root === member.kiloSessionId && child === 'ses_syntheticchild'
      );
    });
    const sandbox = getSandboxControlStub(f.bindings, sandboxId);
    const requests: unknown[] = [];
    await runInDurableObject(sandbox, instance => {
      vi.spyOn(Object.getPrototypeOf(instance), 'authorizeSessionSyncLive').mockImplementation(
        async input => {
          requests.push(input);
          const request = sandboxSessionSyncLiveRequestSchema.parse(input);
          return cloudAgentSyncLiveResultSchema.parse({
            type: 'allowed',
            authorization: {
              userID: request.ownerId,
              workload: 'cloud-agent',
              host: { cloudAgentSessionId: request.sessionId },
              native: {
                sessionID: request.nativeSessionId,
                rootSessionID: request.kiloSessionId,
                kind: request.nativeSessionId === request.kiloSessionId ? 'root' : 'descendant',
              },
              liveIdentity: {
                allocationId: 'synthetic-allocation',
                providerInstanceId: 'synthetic-provider',
              },
              expiresAt: Date.now() + 60_000,
            },
          });
        }
      );
    });
    return { ...f, member, memberStub, metadata, sandbox, requests };
  }

  it('maps each requested root to its actual Cloud member rather than the handle issuer', async () => {
    const f = await liveFixture();
    expect(
      await f.service.authorizeLive({
        type: 'handle',
        handle: f.handle,
        sessionID: f.member.kiloSessionId,
      })
    ).toMatchObject({
      type: 'allowed',
      authorization: {
        host: { cloudAgentSessionId: f.member.sessionId },
        native: { kind: 'root' },
      },
    });
    expect(f.member.sessionId).not.toBe(f.sessionId);
    expect(JSON.stringify(f.requests)).not.toContain('synthetic-hidden-token');
    expect(
      await f.service.authorizeUpload({ handle: f.handle, sessionID: f.member.kiloSessionId })
    ).toMatchObject({ userID: f.userId, host: { cloudAgentSessionId: f.member.sessionId } });
  });

  it('maps a stored descendant to its own root host and never identifies it as a root', async () => {
    const f = await liveFixture();
    postgres({ owner: f.userId });
    expect(
      await f.service.authorizeLive({
        type: 'handle',
        handle: f.handle,
        sessionID: 'ses_syntheticchild',
      })
    ).toMatchObject({
      type: 'allowed',
      authorization: {
        host: { cloudAgentSessionId: f.member.sessionId },
        native: {
          kind: 'descendant',
          sessionID: 'ses_syntheticchild',
          rootSessionID: f.member.kiloSessionId,
        },
      },
    });
  });

  it('uses a current scope member for session-less presence and cannot bypass a stream choice', async () => {
    const f = await liveFixture();
    expect(await f.service.authorizeLive({ type: 'handle', handle: f.handle })).toMatchObject({
      type: 'allowed',
    });
    await runInDurableObject(f.memberStub, instance => {
      Object.assign(instance, {
        metadata: {
          ...f.metadata,
          workspace: { ...f.metadata.workspace, chat: { transport: 'stream' } },
        },
      });
    });
    expect(await f.service.authorizeLive({ type: 'handle', handle: f.handle })).toEqual({
      type: 'denied',
      code: 'hosted_live_not_enabled',
    });
    expect(
      await f.service.authorizeLive({
        type: 'handle',
        handle: f.handle,
        chat: { transport: 'relay' },
      })
    ).toEqual({ type: 'denied', code: 'invalid_credential' });
  });

  it('rechecks only verified ticket identity and propagates a bounded adoption outage', async () => {
    const f = await liveFixture();
    const minted = await f.service.authorizeLive({ type: 'handle', handle: f.handle });
    if (minted.type !== 'allowed') throw new Error('Expected hosted identity');
    const { expiresAt: _expiresAt, ...identity } = minted.authorization;
    const input = { type: 'ticket', ...identity };
    expect(await f.service.authorizeLive(input)).toMatchObject({ type: 'allowed' });
    expect(await f.service.authorizeLive({ ...input, handle: f.handle })).toEqual({
      type: 'denied',
      code: 'invalid_credential',
    });
    await runInDurableObject(f.sandbox, instance => {
      vi.spyOn(Object.getPrototypeOf(instance), 'authorizeSessionSyncLive').mockResolvedValue({
        type: 'unavailable',
        code: 'auth_unavailable',
      });
    });
    expect(await f.service.authorizeLive(input)).toEqual({
      type: 'unavailable',
      code: 'auth_unavailable',
    });
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
      members: [],
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
      members: [{ sessionId: memberCloudSessionId, kiloSessionId: memberRoot }],
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
