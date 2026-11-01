import { env, reset, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sealRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { WIPE_LOCATOR_KEY } from '../../src/control-plane/session/session-do.js';
import { cloudAgentChildSessions } from '../../src/control-plane/session/sqlite-schema.js';
import { RUNTIME_AUTHORIZATION_KEY } from '../../src/session/runtime-authorization-persistence.js';
import { sessionDoName } from '../../src/session-identity.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { FakeSandboxPeer } from './helpers/fake-sandbox-peer.js';

type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_child_registry';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'child-registry-test-secret';

function uuid(): string {
  return crypto.randomUUID();
}

function workspaceSessionId(): string {
  return `workspace_${uuid()}`;
}

function kiloSessionId(): string {
  return `ses_${uuid().replaceAll('-', '').slice(0, 26)}`;
}

function b64url(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function runtimeAuthorizedKiloToken(): string {
  const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ runtimeAuthorization: { id: 'ra_1' } }));
  return `${header}.${payload}.sig`;
}

function metadata(input: {
  sessionId: string;
  allowSubagentSessions: boolean;
  orgId?: string | null;
  worktreeId?: string;
  parentCloudAgentSessionId?: string;
}) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: input.sessionId,
      userId: USER_ID,
      ...(input.orgId === undefined ? {} : { orgId: input.orgId }),
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: kiloSessionId(), kilocodeToken: runtimeAuthorizedKiloToken() },
    agent: { mode: 'code', model: 'test/model' },
    allowSubagentSessions: input.allowSubagentSessions,
    ...(input.parentCloudAgentSessionId === undefined
      ? {}
      : { parentCloudAgentSessionId: input.parentCloudAgentSessionId }),
    workspace: {
      sandboxId: 'ses-0123456789abcdef',
      sandboxProvider: 'cloudflare',
      ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

async function registerParent(
  parentSessionId: string,
  allowSubagentSessions: boolean,
  authorization?: { id: string; delegationExpiresAt: string; state?: 'active' | 'revoked' },
  worktreeId?: string,
  parentCloudAgentSessionId?: string
): Promise<DurableObjectStub<SandboxSessionV2>> {
  let seal: string | undefined;
  if (authorization !== undefined) {
    seal = await sealRuntimeAuthorization(
      {
        version: 1,
        id: authorization.id,
        resourceKind: 'cloud-agent-next',
        resourceId: parentSessionId,
        userId: USER_ID,
        authorizationUserId: USER_ID,
        issuedAt: new Date(Date.now() - 60_000).toISOString(),
        delegationExpiresAt: authorization.delegationExpiresAt,
        state: authorization.state ?? 'active',
        bindings: { userPepperDigest: 'null', authorizationPepperDigest: 'null' },
        source: { admissionSource: 'user' },
      },
      SECRET
    );
  }
  const stub = sessions.getByName(sessionDoName(USER_ID, parentSessionId));
  await runInDurableObject(stub, instance => {
    instance.env.NEXTAUTH_SECRET = SECRET;
  });
  const result = await stub.registerSessionFromMetadata({
    metadata: metadata({
      sessionId: parentSessionId,
      allowSubagentSessions,
      ...(worktreeId === undefined ? {} : { worktreeId }),
      ...(parentCloudAgentSessionId === undefined ? {} : { parentCloudAgentSessionId }),
    }),
    sandboxSelection: { provider: 'cloudflare' },
    ...(seal === undefined ? {} : { runtimeAuthorizationSeal: seal }),
  });
  expect(result).toEqual({ success: true });
  return stub;
}

async function childRows(stub: DurableObjectStub<SandboxSessionV2>) {
  return runInDurableObject(stub, (_instance, state) =>
    drizzle(state.storage, { logger: false }).select().from(cloudAgentChildSessions).all()
  );
}

async function rejectionMessage(
  stub: DurableObjectStub<SandboxSessionV2>,
  work: (instance: SandboxSessionV2) => Promise<unknown>
): Promise<string> {
  return runInDurableObject(stub, async instance => {
    try {
      await work(instance);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}

function authority(input: {
  parentSessionId: string;
  ownerId?: string;
  organizationId?: string | null;
  authorizationId: string;
  expiresAt?: number;
}): CloudAgentAuthority {
  return {
    version: 1,
    ownerId: input.ownerId ?? USER_ID,
    parentSessionId: input.parentSessionId,
    organizationId: input.organizationId ?? null,
    authorizationId: input.authorizationId,
    expiresAt: input.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
  };
}

afterEach(async () => {
  await reset();
});

describe('SandboxSessionV2 child registry', () => {
  it('records children idempotently and paginates by child session id', async () => {
    const parentSessionId = workspaceSessionId();
    const stub = await registerParent(parentSessionId, true);
    const first = workspaceSessionId();
    const second = workspaceSessionId();
    const third = workspaceSessionId();

    await stub.recordCloudAgentChildSession({
      cloudAgentSessionId: second,
      initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      worktreeId: `worktree_${second.slice('workspace_'.length)}`,
    });
    await stub.recordCloudAgentChildSession({ cloudAgentSessionId: first });
    await stub.recordCloudAgentChildSession({
      cloudAgentSessionId: second,
      initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
    });
    await stub.recordCloudAgentChildSession({ cloudAgentSessionId: third });

    const expected = [first, second, third].sort();
    const pageOne = await stub.listCloudAgentChildSessions({ limit: 2 });
    expect(pageOne.sessions.map(session => session.cloudAgentSessionId)).toEqual(
      expected.slice(0, 2)
    );
    expect(pageOne.nextCursor).toBe(expected[1]?.slice('workspace_'.length));

    const pageTwo = await stub.listCloudAgentChildSessions({
      limit: 2,
      cursor: pageOne.nextCursor,
    });
    expect(pageTwo.sessions.map(session => session.cloudAgentSessionId)).toEqual(expected.slice(2));
    expect(pageTwo.nextCursor).toBeUndefined();
  });

  it('clears the child registry on a locator-preserving wipe', async () => {
    const parentSessionId = workspaceSessionId();
    const stub = await registerParent(parentSessionId, true);
    const first = workspaceSessionId();
    const second = workspaceSessionId();
    await stub.recordCloudAgentChildSession({
      cloudAgentSessionId: first,
      initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
    });
    await stub.recordCloudAgentChildSession({ cloudAgentSessionId: second });
    expect((await childRows(stub)).map(row => row.child_session_id).sort()).toEqual(
      [first, second].sort()
    );

    const peer = new FakeSandboxPeer();
    peer.getAcceptedHandleIssuerLocator = async () => ({
      scopeId: 'scope_1',
      allocationId: 'allocation_1',
      wrapperInstanceId: 'wrapper_1',
      expiresAt: Date.now() + 60_000,
    });
    await runInDurableObject(stub, instance => {
      instance.sandboxPeerFor = () => peer;
    });

    await stub.deleteSession();

    expect(await childRows(stub)).toEqual([]);
    await expect(stub.listCloudAgentChildSessions({ limit: 10 })).resolves.toEqual({
      sessions: [],
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.get(WIPE_LOCATOR_KEY))
    ).resolves.toMatchObject({
      version: 1,
      sandboxId: 'ses-0123456789abcdef',
      scopeId: 'scope_1',
    });
  });

  it('prunes a deleted child from the parent registry', async () => {
    const parentSessionId = workspaceSessionId();
    const parent = await registerParent(parentSessionId, true);
    const childSessionId = workspaceSessionId();
    const child = await registerParent(
      childSessionId,
      false,
      undefined,
      undefined,
      parentSessionId
    );
    await parent.recordCloudAgentChildSession({ cloudAgentSessionId: childSessionId });
    expect((await childRows(parent)).map(row => row.child_session_id)).toEqual([childSessionId]);

    const peer = new FakeSandboxPeer();
    await runInDurableObject(child, instance => {
      instance.sandboxPeerFor = () => peer;
    });
    await child.deleteSession();

    await expect(child.getSession()).resolves.toEqual({ type: 'session-not-found' });
    expect(await childRows(parent)).toEqual([]);
    await expect(parent.listCloudAgentChildSessions({ limit: 10 })).resolves.toEqual({
      sessions: [],
    });
  });

  it('rejects registry writes when the parent has not opted in', async () => {
    const parentSessionId = workspaceSessionId();
    const stub = await registerParent(parentSessionId, false);
    await expect(
      rejectionMessage(stub, instance =>
        instance.recordCloudAgentChildSession({ cloudAgentSessionId: workspaceSessionId() })
      )
    ).resolves.toContain('child registry denied');
  });

  it('rejects a missing or deleted parent authorization', async () => {
    const missingSessionId = workspaceSessionId();
    const missingStub = await registerParent(missingSessionId, true);
    await expect(
      rejectionMessage(missingStub, instance =>
        instance.assertCloudAgentManagementAuthority(
          authority({ parentSessionId: missingSessionId, authorizationId: uuid() })
        )
      )
    ).resolves.toContain('Cloud Agent parent authority denied');

    const deletedSessionId = workspaceSessionId();
    const authorizationId = uuid();
    const delegationExpiresAt = new Date(Date.now() + 3600_000).toISOString();
    const deletedStub = await registerParent(deletedSessionId, true, {
      id: authorizationId,
      delegationExpiresAt,
    });
    await runInDurableObject(deletedStub, (_instance, state) =>
      state.storage.delete(RUNTIME_AUTHORIZATION_KEY)
    );
    await expect(
      rejectionMessage(deletedStub, instance =>
        instance.assertCloudAgentManagementAuthority(
          authority({
            parentSessionId: deletedSessionId,
            authorizationId,
            expiresAt: Math.floor(Date.parse(delegationExpiresAt) / 1000),
          })
        )
      )
    ).resolves.toContain('Cloud Agent parent authority denied');
  });

  it('rejects a non-anchor parent even with an active authorization', async () => {
    const parentSessionId = workspaceSessionId();
    const authorizationId = uuid();
    const delegationExpiresAt = new Date(Date.now() + 3600_000).toISOString();
    const stub = await registerParent(
      parentSessionId,
      true,
      { id: authorizationId, delegationExpiresAt },
      `worktree_${uuid()}`
    );
    await expect(
      rejectionMessage(stub, instance =>
        instance.assertCloudAgentManagementAuthority(
          authority({
            parentSessionId,
            authorizationId,
            expiresAt: Math.floor(Date.parse(delegationExpiresAt) / 1000),
          })
        )
      )
    ).resolves.toContain('Cloud Agent parent authority denied');
  });

  it('checks the current parent authorization on every management assertion', async () => {
    const parentSessionId = workspaceSessionId();
    const authorizationId = uuid();
    const delegationExpiresAt = new Date(Date.now() + 3600_000).toISOString();
    const stub = await registerParent(parentSessionId, true, {
      id: authorizationId,
      delegationExpiresAt,
    });
    const valid = authority({
      parentSessionId,
      authorizationId,
      expiresAt: Math.floor(Date.parse(delegationExpiresAt) / 1000),
    });
    await expect(stub.assertCloudAgentManagementAuthority(valid)).resolves.toBeUndefined();
    await expect(
      rejectionMessage(stub, instance =>
        instance.assertCloudAgentManagementAuthority({ ...valid, authorizationId: uuid() })
      )
    ).resolves.toContain('parent authority denied');
    await expect(
      rejectionMessage(stub, instance =>
        instance.assertCloudAgentManagementAuthority({ ...valid, ownerId: 'other-user' })
      )
    ).resolves.toContain('parent authority denied');
    await expect(
      rejectionMessage(stub, instance =>
        instance.assertCloudAgentManagementAuthority({ ...valid, organizationId: ORG_ID })
      )
    ).resolves.toContain('parent authority denied');

    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<Record<string, unknown>>(RUNTIME_AUTHORIZATION_KEY)
    );
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put(RUNTIME_AUTHORIZATION_KEY, {
        ...stored,
        delegationExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      })
    );
    await expect(
      rejectionMessage(stub, instance => instance.assertCloudAgentManagementAuthority(valid))
    ).resolves.toContain('parent authority denied');
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put(RUNTIME_AUTHORIZATION_KEY, { ...stored, state: 'revoked' })
    );
    await expect(
      rejectionMessage(stub, instance => instance.assertCloudAgentManagementAuthority(valid))
    ).resolves.toContain('parent authority denied');
  });

  it('denies missing and malformed balance credentials without treating them as transient failures', async () => {
    const parentSessionId = workspaceSessionId();
    const stub = await registerParent(parentSessionId, true);
    const valid = authority({ parentSessionId, authorizationId: uuid() });
    for (const stored of [undefined, { state: 'active' }]) {
      await runInDurableObject(stub, async (_instance, state) => {
        if (stored === undefined) await state.storage.delete(RUNTIME_AUTHORIZATION_KEY);
        else await state.storage.put(RUNTIME_AUTHORIZATION_KEY, stored);
      });
      await expect(
        rejectionMessage(stub, instance => instance.getCloudAgentSpawnRuntimeToken(valid))
      ).resolves.toContain('parent authority denied');
    }
  });
});
