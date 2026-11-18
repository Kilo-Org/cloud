import { env, reset, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sealRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import type { CloudAgentWorkspaceDO } from '../../src/control-plane/workspace/workspace-do.js';
import { cloudAgentChildSessions } from '../../src/control-plane/session/sqlite-schema.js';
import { RUNTIME_AUTHORIZATION_KEY } from '../../src/session/runtime-authorization-persistence.js';
import { sessionDoName } from '../../src/session-identity.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { FakeSandboxPeer } from './helpers/fake-sandbox-peer.js';

type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
type WorkspaceNamespace = DurableObjectNamespace<CloudAgentWorkspaceDO>;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;
const workspaces = (env as unknown as { CLOUD_AGENT_WORKSPACE: WorkspaceNamespace })
  .CLOUD_AGENT_WORKSPACE;

const USER_ID = 'user_workspace_authority';
// The Worker's own secret, so a local .dev.vars override does not matter.
const SECRET = (env as unknown as { NEXTAUTH_SECRET: string }).NEXTAUTH_SECRET;

function uuid(): string {
  return crypto.randomUUID();
}

function workspaceSessionId(): string {
  return `workspace_${uuid()}`;
}

function worktreeFor(sessionId: string): string {
  return sessionId.replace('workspace_', 'worktree_');
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

function authorization(
  resourceId: string,
  overrides: Partial<RuntimeAuthorization> = {}
): RuntimeAuthorization {
  return {
    version: 1,
    id: uuid(),
    resourceKind: 'cloud-agent-next',
    resourceId,
    userId: USER_ID,
    authorizationUserId: USER_ID,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    delegationExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    state: 'active',
    bindings: { userPepperDigest: 'null', authorizationPepperDigest: 'null' },
    source: { admissionSource: 'user' },
    ...overrides,
  };
}

async function registerChat(input: {
  sessionId: string;
  allowSubagentSessions: boolean;
  worktreeId?: string;
  parentCloudAgentSessionId?: string;
  authorization?: RuntimeAuthorization;
}): Promise<DurableObjectStub<SandboxSessionV2>> {
  const stub = sessions.getByName(sessionDoName(USER_ID, input.sessionId));
  const result = await stub.registerSessionFromMetadata({
    metadata: parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: {
        sessionId: input.sessionId,
        userId: USER_ID,
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
        sandboxProvider: 'cloudflare-containers',
        ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
      },
      lifecycle: { version: 1, timestamp: 1 },
    }),
    sandboxSelection: { provider: 'cloudflare-containers' },
    ...(input.authorization === undefined
      ? {}
      : { runtimeAuthorizationSeal: await sealRuntimeAuthorization(input.authorization, SECRET) }),
  });
  expect(result).toEqual({ success: true });
  await runInDurableObject(stub, instance => {
    instance.sandboxPeerFor = () => new FakeSandboxPeer();
  });
  return stub;
}

function workspaceStub(sessionId: string): DurableObjectStub<CloudAgentWorkspaceDO> {
  return workspaces.getByName(sessionDoName(USER_ID, sessionId));
}

async function legacyChildRows(stub: DurableObjectStub<SandboxSessionV2>, children: string[]) {
  await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    for (const child of children) {
      db.insert(cloudAgentChildSessions)
        .values({
          child_session_id: child,
          initial_message_id: null,
          worktree_id: null,
          created_at: 1,
        })
        .run();
    }
  });
}

afterEach(async () => {
  await reset();
});

describe('workspace authority adoption', () => {
  it('adopts the creating chat authorization and its legacy child registry once', async () => {
    const root = workspaceSessionId();
    const stored = authorization(root);
    const rootStub = await registerChat({
      sessionId: root,
      allowSubagentSessions: true,
      worktreeId: worktreeFor(root),
      authorization: stored,
    });
    const children = [workspaceSessionId(), workspaceSessionId()].sort();
    await legacyChildRows(rootStub, children);

    const workspace = workspaceStub(root);
    await expect(workspace.describe()).resolves.toEqual({
      state: 'active',
      authorizationId: stored.id,
      worktreeId: worktreeFor(root),
      organizationId: null,
    });
    const page = await workspace.listChildren({ limit: 10 });
    expect(page.sessions.map(entry => entry.cloudAgentSessionId)).toEqual(children);
  });

  it.each([
    ['a chat without launch permission', { allowSubagentSessions: false }],
    [
      'a chat without a runtime authorization',
      { allowSubagentSessions: true, noAuthorization: true },
    ],
  ])('does not establish a workspace from %s', async (_name, options) => {
    const root = workspaceSessionId();
    await registerChat({
      sessionId: root,
      allowSubagentSessions: options.allowSubagentSessions,
      worktreeId: worktreeFor(root),
      ...('noAuthorization' in options ? {} : { authorization: authorization(root) }),
    });
    await expect(workspaceStub(root).describe()).resolves.toMatchObject({
      state: 'unestablished',
    });
  });

  it('never adopts a sibling chat as the workspace', async () => {
    const root = workspaceSessionId();
    const sibling = workspaceSessionId();
    await registerChat({
      sessionId: sibling,
      allowSubagentSessions: true,
      worktreeId: worktreeFor(root),
      authorization: authorization(sibling),
    });
    await expect(workspaceStub(root).describe()).resolves.toMatchObject({
      state: 'unestablished',
    });
    await expect(workspaceStub(sibling).describe()).resolves.toMatchObject({
      state: 'unestablished',
    });
  });

  it('keeps an expired or revoked creating chat authorization unavailable', async () => {
    for (const overrides of [
      {
        issuedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
        delegationExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      { state: 'revoked' as const },
    ]) {
      const root = workspaceSessionId();
      const active = authorization(root);
      const rootStub = await registerChat({
        sessionId: root,
        allowSubagentSessions: true,
        worktreeId: worktreeFor(root),
        authorization: active,
      });
      await runInDurableObject(rootStub, (_instance, state) =>
        state.storage.put(RUNTIME_AUTHORIZATION_KEY, { ...active, ...overrides })
      );
      const workspace = workspaceStub(root);
      await expect(
        workspace.issueMcpGrant({
          workspaceSessionId: root,
          worktreeId: worktreeFor(root),
          ownerId: USER_ID,
          organizationId: null,
        })
      ).resolves.toBeUndefined();
      await expect(workspace.describe()).resolves.toMatchObject({
        state: overrides.state === 'revoked' ? 'revoked' : 'expired',
      });
    }
  });
});

describe('workspace authority lifecycle', () => {
  it('survives deletion of the chat that created it', async () => {
    const root = workspaceSessionId();
    const stored = authorization(root);
    const rootStub = await registerChat({
      sessionId: root,
      allowSubagentSessions: true,
      worktreeId: worktreeFor(root),
      authorization: stored,
    });
    await legacyChildRows(rootStub, [workspaceSessionId()]);
    await rootStub.deleteSession();
    await expect(rootStub.getSession()).resolves.toEqual({ type: 'session-not-found' });
    await expect(
      runInDurableObject(rootStub, (_instance, state) =>
        state.storage.get(RUNTIME_AUTHORIZATION_KEY)
      )
    ).resolves.toBeUndefined();

    const workspace = workspaceStub(root);
    await expect(workspace.describe()).resolves.toMatchObject({
      state: 'active',
      authorizationId: stored.id,
    });
    expect((await workspace.listChildren({ limit: 10 })).sessions).toHaveLength(1);
  });

  it('ends the authority of a session without a worktree when that session is deleted', async () => {
    const root = workspaceSessionId();
    const rootStub = await registerChat({
      sessionId: root,
      allowSubagentSessions: true,
      authorization: authorization(root),
    });
    await expect(workspaceStub(root).describe()).resolves.toMatchObject({ state: 'active' });
    await rootStub.deleteSession();
    await expect(workspaceStub(root).describe()).resolves.toMatchObject({ state: 'deleted' });
  });

  it('prunes a deleted direct child from the workspace registry', async () => {
    const root = workspaceSessionId();
    await registerChat({
      sessionId: root,
      allowSubagentSessions: true,
      worktreeId: worktreeFor(root),
      authorization: authorization(root),
    });
    const child = workspaceSessionId();
    const childStub = await registerChat({
      sessionId: child,
      allowSubagentSessions: false,
      worktreeId: worktreeFor(child),
      parentCloudAgentSessionId: root,
    });
    const workspace = workspaceStub(root);
    await workspace.recordChild({ cloudAgentSessionId: child });
    expect((await workspace.listChildren({ limit: 10 })).sessions).toEqual([
      { cloudAgentSessionId: child },
    ]);
    await childStub.deleteSession();
    await expect(workspace.listChildren({ limit: 10 })).resolves.toEqual({ sessions: [] });
  });

  it("renews only an expired authority, and only from the owner's delegation for this workspace", async () => {
    const root = workspaceSessionId();
    const active = authorization(root);
    const expired = {
      ...active,
      issuedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      delegationExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    const rootStub = await registerChat({
      sessionId: root,
      allowSubagentSessions: true,
      worktreeId: worktreeFor(root),
      authorization: active,
    });
    await runInDurableObject(rootStub, (_instance, state) =>
      state.storage.put(RUNTIME_AUTHORIZATION_KEY, expired)
    );
    const workspace = workspaceStub(root);
    await expect(workspace.describe()).resolves.toMatchObject({ state: 'expired' });
    const sibling = workspaceSessionId();
    await expect(
      workspace.reauthorize({
        expectedAuthorizationId: expired.id,
        runtimeAuthorizationSeal: await sealRuntimeAuthorization(authorization(sibling), SECRET),
      })
    ).resolves.toEqual({ status: 'denied' });
    const fresh = authorization(root);
    await expect(
      workspace.reauthorize({
        expectedAuthorizationId: expired.id,
        runtimeAuthorizationSeal: await sealRuntimeAuthorization(fresh, SECRET),
      })
    ).resolves.toEqual({ status: 'renewed' });
    await expect(workspace.describe()).resolves.toMatchObject({
      state: 'active',
      authorizationId: fresh.id,
    });
  });

  it('denies everything after the workspace is deleted, even while its creating chat exists', async () => {
    const root = workspaceSessionId();
    await registerChat({
      sessionId: root,
      allowSubagentSessions: true,
      worktreeId: worktreeFor(root),
      authorization: authorization(root),
    });
    const workspace = workspaceStub(root);
    await workspace.markDeleted();
    await expect(workspace.describe()).resolves.toMatchObject({ state: 'deleted' });
    await expect(
      workspace.issueMcpGrant({
        workspaceSessionId: root,
        worktreeId: worktreeFor(root),
        ownerId: USER_ID,
        organizationId: null,
      })
    ).resolves.toBeUndefined();
  });
});
