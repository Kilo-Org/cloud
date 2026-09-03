import { env, runInDurableObject } from 'cloudflare:test';
import type { CloudAgentWorktreeId } from '@kilocode/session-ingest-contracts';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it, vi } from 'vitest';
import { getWorktreeWorkspacePath } from '../../src/workspace';
import { events } from '../../src/db/sqlite-schema';
import {
  generateSandboxCredential,
  hashSandboxCredential,
} from '../../src/sandbox-control/credential';
import type { ProviderAdapter } from '../../src/sandbox-control/provider';
import type { AttachSessionInput, SandboxControl } from '../../src/persistence/SandboxControl';
import { createControlPlaneCredential } from '../../src/sandbox-control/managed-credential';
import { sessionCredentialGrantSchema } from '../../src/sandbox-control/session-credentials';
import {
  loadDeadlines,
  loadSessionCredentialGrants,
  saveDeadlines,
  savePhysicalRecord,
  saveSessionCredentialGrants,
} from '../../src/sandbox-control/durable-state';
import { DEADLINE_MS } from '../../src/sandbox-control/deadlines';
import { WORKTREE_CREDENTIAL_CONTAINMENT } from '../../src/sandbox-control/physical-lifecycle';
import { encodeCloudflareProviderRef } from '../../src/sandbox-control/cloudflare-provider';
import {
  createVercelProviderAdapter,
  type VercelControlRestClient,
} from '../../src/sandbox-control/vercel-provider';
import { parseVercelSandboxRuntimeConfig } from '../../src/agent-sandbox/vercel/vercel-runtime-config';
import type { VercelSandboxSession } from '../../src/agent-sandbox/vercel/vercel-sandbox-rest-client';
import {
  loadWorktreeDeletionJournal,
  WORKTREE_DELETION_PREFIX,
} from '../../src/sandbox-control/worktree-deletion';
import { resolveSandboxExclusivity } from '../../src/sandbox-control/worktree-ownership';
import type { RequestFrame } from '../../src/shared/sandbox-control-protocol';

const userId = 'oauth/google:worktree-integration';
const worktreeId: CloudAgentWorktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const otherWorktreeId: CloudAgentWorktreeId = 'worktree_22222222-2222-4222-8222-222222222222';
const directory = getWorktreeWorkspacePath(undefined, userId, worktreeId);
const otherDirectory = getWorktreeWorkspacePath(undefined, userId, otherWorktreeId);
const kiloId = (index: number) => `ses_${String(index).padStart(26, '0')}`;
const cloudId = (): `workspace_${string}` => `workspace_${crypto.randomUUID()}`;

const vercelConfig = {
  VERCEL_TOKEN: 'fixture-vercel-token',
  VERCEL_TEAM_ID: 'team_test',
  VERCEL_PROJECT_ID: 'prj_test',
  VERCEL_SANDBOX_SNAPSHOT_ID: 'snap_test',
  VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'build_test',
  VERCEL_SANDBOX_RUNTIME: 'node24',
  VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
  VERCEL_SANDBOX_EXTEND_DURATION_MS: '120000',
};

function createDeletionProvider(sandboxId: string) {
  const sessions = new Map<string, VercelSandboxSession>();
  const config = parseVercelSandboxRuntimeConfig(vercelConfig);
  if (!config) throw new Error('Missing Vercel fixture configuration');
  const requireSession = (id: string) => {
    const session = sessions.get(id);
    if (!session) throw new Error('Unknown native fixture session');
    return session;
  };
  const client: VercelControlRestClient = {
    async createSandbox(input) {
      const session: VercelSandboxSession = {
        id: `vsess_${crypto.randomUUID()}`,
        sourceSandboxName: input.name,
        projectId: config.projectId,
        runtime: 'node24',
        status: 'running',
        memory: 2048,
        vcpus: 2,
        region: 'iad1',
        timeout: 300_000,
        requestedAt: Date.now(),
        startedAt: Date.now(),
        cwd: '/',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      sessions.set(session.id, session);
      return {
        sandbox: {
          name: input.name,
          currentSessionId: session.id,
          status: 'running',
          persistent: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          tags: {},
        },
        session,
        routes: [],
        runtime: { sandboxName: input.name, sessionId: session.id },
      };
    },
    async inspectByName() {
      return null;
    },
    async getSession(id) {
      return { session: requireSession(id), routes: [] };
    },
    async executeCommand(sessionId, input) {
      requireSession(sessionId);
      return {
        id: 'cmd_fixture',
        name: input.command,
        args: input.args ?? [],
        cwd: '/',
        sessionId,
        exitCode: null,
        startedAt: Date.now(),
      };
    },
    async updateNetworkPolicy(id, name) {
      const session = requireSession(id);
      expect(name).toBe(session.sourceSandboxName);
      return session;
    },
    async stopSession(id) {
      const session = { ...requireSession(id), status: 'stopped' as const };
      sessions.set(id, session);
      return session;
    },
    async extendSessionTimeout(id) {
      return requireSession(id);
    },
    async readFile() {
      return new Uint8Array();
    },
  };
  let allocationName = sandboxId;
  const adapter = () =>
    createVercelProviderAdapter({ sandboxName: allocationName, config, restClient: client });
  return {
    resumable: false,
    ensureBillingAdmission: (ref, billing) => adapter().ensureBillingAdmission(ref, billing),
    create: intent => {
      allocationName = intent.allocationName ?? sandboxId;
      return adapter().create(intent);
    },
    launch: (ref, launchEnv) => adapter().launch(ref, launchEnv),
    observe: (ref, intent = null) => adapter().observe(ref, intent),
    stop: (ref, intent = null) => adapter().stop(ref, intent),
    ensureLeaseAtLeast: (ref, ms) => adapter().ensureLeaseAtLeast(ref, ms),
    logs: ref => adapter().logs(ref),
    updateNetworkPolicy: vi.fn(async (ref, policy) => {
      const native = adapter();
      if (!native.updateNetworkPolicy) throw new Error('Missing native policy update');
      await native.updateNetworkPolicy(ref, policy);
    }),
  } satisfies ProviderAdapter;
}

async function installDeletionProvider(instance: SandboxControl, provider: ProviderAdapter) {
  await instance.getStatus();
  Object.assign(instance, {
    env: {
      ...instance['env'],
      ...vercelConfig,
      WORKER_URL: 'https://worker.test',
      KILOCODE_BACKEND_BASE_URL: 'https://backend.example.com',
      KILO_OPENROUTER_BASE: 'https://provider.example.com/api/openrouter',
      KILO_SESSION_INGEST_URL: 'https://ingest.example.com',
      GIT_TOKEN_SERVICE: {
        issueKiloSessionCapability: async () => ({
          success: true,
          capability: `kka1.fixture-${crypto.randomUUID()}`,
        }),
      },
    },
    provider,
    createProviderAdapter: () => provider,
    providerKind: 'vercel',
  });
}

async function seedPhysical(
  instance: SandboxControl,
  state: DurableObjectState,
  intentId: string,
  providerRef: string
) {
  await instance.claimCreate(intentId, false, instance.sandboxId, WORKTREE_CREDENTIAL_CONTAINMENT);
  await instance.confirmInstance(providerRef);
  const physical = await instance.getPhysicalRecord();
  if (!physical.createIntent) throw new Error('Missing fixture create intent');
  await savePhysicalRecord(state.storage, {
    ...physical,
    createIntent: {
      ...physical.createIntent,
      createdAt: Date.now() - DEADLINE_MS.createSettle - 1,
    },
  });
}

async function attachGrantedSession(
  instance: SandboxControl,
  state: DurableObjectState,
  input: AttachSessionInput,
  provider: 'cloudflare' | 'vercel' = 'vercel'
) {
  const grants = await loadSessionCredentialGrants(state.storage);
  const scopeId = input.worktreeId ?? input.sessionId;
  const previous = grants.find(grant => grant.scopeId === scopeId);
  const now = Date.now();
  const grant = sessionCredentialGrantSchema.parse({
    version: 1,
    scopeId,
    sandboxId: instance.sandboxId,
    directory: input.directory,
    userId,
    provider,
    ...(provider === 'cloudflare'
      ? { outboundContainerId: `contained:${instance.sandboxId}` }
      : {}),
    members: [
      ...(previous?.members ?? []),
      { sessionId: input.sessionId, kiloSessionId: input.kiloSessionId },
    ],
    kilo: previous?.kilo ?? {
      alias: createControlPlaneCredential(instance.sandboxId, 'kilo'),
      token: 'test-session-token',
      targets: {
        backendBaseUrl: 'https://api.kilo.ai',
        providerBaseUrl: 'https://api.kilo.ai/api/gateway',
        sessionIngestBaseUrl: 'https://api.kilo.ai/api/session-ingest',
      },
      capabilities: {},
    },
    preparedAt: now,
    expiresAt: now + 4 * 60 * 60_000,
  });
  await saveSessionCredentialGrants(state.storage, [
    ...grants.filter(value => value.scopeId !== scopeId),
    grant,
  ]);
  return instance.attachSession(input);
}

function registration(
  sessionId: `workspace_${string}`,
  sandboxId: `usr-${string}` | `ses-${string}`
) {
  return {
    identity: { sessionId, userId },
    auth: { kiloSessionId: kiloId(0), kilocodeToken: 'test-session-token' },
    agent: { mode: 'code', model: 'test-model' },
    workspace: {
      sandboxId,
      sandboxProvider: 'cloudflare' as const,
      workspacePath: directory,
      worktreeId,
    },
  };
}

function nextFrame(socket: WebSocket): Promise<RequestFrame> {
  return new Promise(resolve =>
    socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), {
      once: true,
    })
  );
}

async function connectControl(sandboxId: string, credential: string, wrapperInstanceId?: string) {
  const control = env.SANDBOX_CONTROL.getByName(sandboxId);
  const response = await control.fetch(
    new Request('https://worker.test/control', {
      headers: { Upgrade: 'websocket', Authorization: `Bearer ${credential}` },
    })
  );
  if (!response.webSocket) throw new Error('Expected wrapper websocket');
  const socket = response.webSocket;
  socket.accept();
  const providerInstanceId = (await control.getPhysicalRecord()).providerRef;
  const hello = nextFrame(socket);
  socket.send(
    JSON.stringify({
      type: 'request',
      requestId: 'hello',
      operation: 'sandbox.hello',
      payload: {
        protocolVersion: 1,
        providerInstanceId,
        ...(wrapperInstanceId ? { wrapperInstanceId } : {}),
      },
    })
  );
  await hello;
  const status = await nextFrame(socket);
  socket.send(
    JSON.stringify({ type: 'response', requestId: status.requestId, ok: true, result: {} })
  );
  return socket;
}

function reply(socket: WebSocket, frame: RequestFrame, result: unknown, ok = true) {
  socket.send(
    JSON.stringify({
      type: 'response',
      requestId: frame.requestId,
      ok,
      result,
      ...(ok ? {} : { error: { code: 'not_ready', message: 'Retry cleanup', retryable: true } }),
    })
  );
}

describe('worktree deletion in Durable Objects', () => {
  it('retains never-run child lineage for cold deletion when scoped publication fails', async () => {
    const sessionId = cloudId();
    const sandboxId = `ses-${crypto.randomUUID().replaceAll('-', '')}` as const;
    const stub = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);
    await runInDurableObject(stub, async (instance, state) => {
      const ingest = instance['env'].SESSION_INGEST;
      const secret = instance['env'].INTERNAL_API_SECRET_PROD;
      Object.assign(instance['env'], {
        SESSION_INGEST: { fetch: async () => new Response(null, { status: 503 }) },
        INTERNAL_API_SECRET_PROD: { get: async () => 'test-internal' },
      });
      try {
        await instance.registerSession(registration(sessionId, sandboxId));
        for (const [id, parentID, type] of [
          [kiloId(1), kiloId(0), 'session.created'],
          [kiloId(2), kiloId(1), 'session.updated'],
        ]) {
          await instance.receiveSandboxControlEvent({
            identity: { directory, kiloSessionId: id, rootKiloSessionId: kiloId(0) },
            payload: { type, properties: { sessionID: id, info: { id, parentID, directory } } },
          });
        }
        await instance.beginWorktreeDeletion({
          worktreeId,
          kiloSessionId: kiloId(0),
          ownerId: userId,
        });
        await expect(instance.getWorktreeChildSessions(worktreeId)).resolves.toEqual([
          { sessionId: kiloId(1), parentSessionId: kiloId(0) },
          { sessionId: kiloId(2), parentSessionId: kiloId(1) },
        ]);
        expect((await state.storage.get('session_messages')) ?? []).toEqual([]);
        await instance.finishWorktreeDeletion(worktreeId);
        await expect(instance.getWorktreeChildSessions(worktreeId)).resolves.toEqual([]);
      } finally {
        await state.storage.deleteAlarm();
        Object.assign(instance['env'], {
          SESSION_INGEST: ingest,
          INTERNAL_API_SECRET_PROD: secret,
        });
      }
    });
  });

  it('rejects contradictory session identities and foreign directories before retaining child evidence', async () => {
    const sessionId = cloudId();
    const sandboxId = `ses-${crypto.randomUUID().replaceAll('-', '')}` as const;
    const stub = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);
    await stub.registerSession(registration(sessionId, sandboxId));
    for (const input of [
      {
        identity: { directory, kiloSessionId: kiloId(0), rootKiloSessionId: kiloId(0) },
        payload: {
          type: 'session.created',
          properties: {
            sessionID: kiloId(0),
            info: { id: kiloId(1), parentID: kiloId(0), directory },
          },
        },
      },
      {
        identity: { directory, kiloSessionId: kiloId(1), rootKiloSessionId: kiloId(0) },
        payload: {
          type: 'session.created',
          properties: {
            sessionID: kiloId(1),
            info: { id: kiloId(1), parentID: kiloId(0), directory: otherDirectory },
          },
        },
      },
    ]) {
      await expect(stub.receiveSandboxControlEvent(input)).resolves.toEqual({ applied: false });
    }
    await stub.beginWorktreeDeletion({ worktreeId, kiloSessionId: kiloId(0), ownerId: userId });
    await expect(stub.getWorktreeChildSessions(worktreeId)).resolves.toEqual([]);
    await stub.finishWorktreeDeletion(worktreeId);
  });

  it.each([true, false])(
    'uses persisted legacy routing while public metadata is hidden by deletion (shared: %s)',
    async shared => {
      const sandboxId = `usr-${crypto.randomUUID().replaceAll('-', '').padEnd(48, '0')}`;
      const otherSandboxId = `usr-${'d'.repeat(48)}`;
      const legacyId = `agent_${crypto.randomUUID()}`;
      const legacy = env.CLOUD_AGENT_SESSION.getByName(`${userId}:${legacyId}`);
      await runInDurableObject(legacy, async (instance, state) => {
        await state.storage.put({
          metadata: {
            metadataSchemaVersion: 2,
            identity: { sessionId: legacyId, userId },
            auth: { kiloSessionId: kiloId(1) },
            workspace: { sandboxId: shared ? sandboxId : otherSandboxId },
            lifecycle: { timestamp: 1, version: 1 },
          },
          session_deletion_intent: { reason: 'explicit', startedAt: Date.now() },
        });
        await expect(instance.getMetadata()).resolves.toBeNull();
      });
      const control = env.SANDBOX_CONTROL.getByName(sandboxId);
      await runInDurableObject(control, async instance => {
        const original = instance['env'].SESSION_INGEST;
        Object.assign(instance['env'], {
          SESSION_INGEST: {
            canDestroyCloudAgentWorktreeSandbox: async () => ({
              kind: 'unresolved',
              owners: [
                {
                  worktreeId: null,
                  organizationId: null,
                  allocationLocation: {
                    sandboxId: shared ? otherSandboxId : sandboxId,
                    provider: 'cloudflare',
                  },
                  sessions: [{ sessionId: kiloId(1), cloudAgentSessionId: legacyId }],
                },
              ],
            }),
          },
        });
        try {
          await expect(
            resolveSandboxExclusivity(instance['env'], {
              worktreeId,
              kiloUserId: userId,
              location: { sandboxId, provider: 'cloudflare' },
            })
          ).resolves.toBe(!shared);
        } finally {
          Object.assign(instance['env'], { SESSION_INGEST: original });
        }
      });
    }
  );

  it.each(['cloudflare', 'vercel'] as const)(
    'completes an ownership-only %s allocation from fenced empty creation history without provider access',
    async providerKind => {
      const sessionId = cloudId();
      const session = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);
      const sandboxId: `ses-${string}` = `ses-${crypto.randomUUID().replaceAll('-', '')}`;
      const control = env.SANDBOX_CONTROL.getByName(sandboxId);
      await expect(
        session.beginWorktreeDeletion({ worktreeId, kiloSessionId: kiloId(0), ownerId: userId })
      ).resolves.toBeNull();
      await runInDurableObject(control, async (instance, state) => {
        const memory = createDeletionProvider(sandboxId);
        const create = vi.fn(memory.create.bind(memory));
        const stop = vi.fn(memory.stop.bind(memory));
        const provider = { ...memory, create, stop };
        Object.assign(instance, { provider, createProviderAdapter: () => provider });
        const original = instance['env'].SESSION_INGEST;
        const token = instance['env'].VERCEL_TOKEN;
        Object.assign(instance['env'], {
          VERCEL_TOKEN: undefined,
          SESSION_INGEST: {
            canDestroyCloudAgentWorktreeSandbox: async () => ({ kind: 'exclusive' }),
          },
        });
        try {
          const input = {
            worktreeId,
            kiloUserId: userId,
            location: { sandboxId, provider: providerKind },
            sessionIds: [kiloId(0)],
          };
          await expect(instance.deleteWorktreeResources(input)).resolves.toEqual({
            deleted: true,
            sessionIds: [kiloId(0)],
          });
          expect(await state.storage.get('owner_id')).toBeUndefined();
          await expect(instance.deleteWorktreeResources(input)).resolves.toEqual({
            deleted: true,
            sessionIds: [kiloId(0)],
          });
          expect(create).not.toHaveBeenCalled();
          expect(stop).not.toHaveBeenCalled();
          expect(await state.storage.get('physical_record')).toBeUndefined();
          expect(await state.storage.get('owner_id')).toBe(userId);
          expect(await state.storage.getAlarm()).toBeNull();
          await expect(
            instance.ensureReady({ ownerId: userId, sessionId, worktreeId, allowCreate: true })
          ).rejects.toThrow('worktree_deleting');
        } finally {
          await state.storage.deleteAlarm();
          Object.assign(instance['env'], { SESSION_INGEST: original, VERCEL_TOKEN: token });
        }
      });
      await session.finishWorktreeDeletion(worktreeId);
      await expect(
        session.beginWorktreeDeletion({ worktreeId, kiloSessionId: kiloId(0), ownerId: userId })
      ).resolves.toBeNull();
      await expect(
        session.registerSession(registration(sessionId, sandboxId))
      ).resolves.toMatchObject({ success: false });
    }
  );

  it('does not block a never-started allocation on unrelated unavailable legacy history or touch its provider', async () => {
    const sandboxId = `usr-${crypto.randomUUID().replaceAll('-', '').padEnd(48, '0')}`;
    const legacyId = `agent_${crypto.randomUUID()}`;
    const control = env.SANDBOX_CONTROL.getByName(sandboxId);
    await runInDurableObject(control, async (instance, state) => {
      expect(await instance.getPhysicalRecord()).toEqual({
        state: 'stopped',
        providerRef: null,
        createIntent: null,
        stopTombstone: null,
        resumable: false,
      });
      expect(await instance.listRoutes()).toEqual([]);
      expect(state.getWebSockets()).toEqual([]);
      let legacyRunning = true;
      const provider: ProviderAdapter = {
        resumable: false,
        ensureBillingAdmission: async () => undefined,
        launch: async () => undefined,
        create: async () => ({ providerRef: sandboxId }),
        observe: async () => ({ status: legacyRunning ? 'active' : 'terminal' }),
        stop: async () => {
          legacyRunning = false;
          return 'terminal';
        },
        ensureLeaseAtLeast: async () => undefined,
        logs: async () => '',
      };
      Object.assign(instance, { provider, createProviderAdapter: () => provider });
      const original = instance['env'].SESSION_INGEST;
      Object.assign(instance['env'], {
        SESSION_INGEST: {
          canDestroyCloudAgentWorktreeSandbox: async () => ({
            kind: 'unresolved',
            owners: [
              {
                worktreeId: null,
                organizationId: null,
                sessions: [{ sessionId: kiloId(1), cloudAgentSessionId: legacyId }],
              },
            ],
          }),
        },
      });
      try {
        const input = {
          worktreeId,
          kiloUserId: userId,
          location: { sandboxId, provider: 'cloudflare' as const },
          sessionIds: [kiloId(0)],
        };
        await expect(instance.deleteWorktreeResources(input)).resolves.toEqual({
          deleted: true,
          sessionIds: [kiloId(0)],
        });
        await expect(instance.deleteWorktreeResources(input)).resolves.toMatchObject({
          deleted: true,
        });
        expect(legacyRunning).toBe(true);
        expect(await state.storage.get('physical_record')).toBeUndefined();
      } finally {
        await state.storage.deleteAlarm();
        Object.assign(instance['env'], { SESSION_INGEST: original });
      }
    });
  });

  it('destroys the last physical runtime when concurrent worktree deletions both retain pending PostgreSQL rows', async () => {
    const sandboxId = `usr-${crypto.randomUUID().replaceAll('-', '')}`;
    const control = env.SANDBOX_CONTROL.getByName(sandboxId);
    await runInDurableObject(control, async (instance, state) => {
      const provider = createDeletionProvider(sandboxId);
      const created = await provider.create({
        intentId: 'last-two-worktrees',
        createdAt: Date.now() - DEADLINE_MS.createSettle - 1,
      });
      if (!('providerRef' in created)) throw new Error('Expected memory instance');
      const cleaned = new Set<string>();
      const pending = [worktreeId, otherWorktreeId];
      const original = instance['env'].SESSION_INGEST;
      Object.assign(instance['env'], {
        SESSION_INGEST: {
          canDestroyCloudAgentWorktreeSandbox: async (input: {
            worktreeId: string;
            releasedWorktreeIds?: string[];
          }) => ({
            kind: pending.some(
              id => id !== input.worktreeId && !input.releasedWorktreeIds?.includes(id)
            )
              ? 'shared'
              : 'exclusive',
          }),
        },
      });
      await installDeletionProvider(instance, provider);
      Object.assign(instance, {
        socketHandler: {
          hasHandshakenSocket: () => true,
          closeAll: () => undefined,
          sendRequest: async (request: {
            operation: string;
            payload: { worktreeId: string; sessionIds: string[] };
          }) => {
            if (request.operation === 'worktree.delete') cleaned.add(request.payload.worktreeId);
            return {
              type: 'response',
              requestId: 'cleanup',
              ok: true,
              result:
                request.operation === 'worktree.prepareDeletion'
                  ? { prepared: true, sessionIds: request.payload.sessionIds }
                  : { deleted: true, sessionIds: request.payload.sessionIds },
            };
          },
        },
      });
      try {
        await instance.initializeOwner(userId);
        await seedPhysical(instance, state, 'last-two-worktrees', created.providerRef);
        await attachGrantedSession(instance, state, {
          sessionId: cloudId(),
          kiloSessionId: kiloId(0),
          directory,
          ownerId: userId,
          worktreeId,
        });
        await attachGrantedSession(instance, state, {
          sessionId: cloudId(),
          kiloSessionId: kiloId(1),
          directory: otherDirectory,
          ownerId: userId,
          worktreeId: otherWorktreeId,
        });
        const grants = await loadSessionCredentialGrants(state.storage);
        const location = { sandboxId, provider: 'vercel' as const };
        await Promise.all([
          instance.deleteWorktreeResources({
            worktreeId,
            kiloUserId: userId,
            location,
            sessionIds: [kiloId(0)],
          }),
          instance.deleteWorktreeResources({
            worktreeId: otherWorktreeId,
            kiloUserId: userId,
            location,
            sessionIds: [kiloId(1)],
          }),
        ]);
        expect(await provider.observe(created.providerRef)).toMatchObject({ status: 'terminal' });
        expect(cleaned.has(worktreeId)).toBe(true);
        expect(provider.updateNetworkPolicy).toHaveBeenCalledWith(
          created.providerRef,
          expect.any(Object)
        );
        const revokedPolicy = JSON.stringify(provider.updateNetworkPolicy.mock.calls[0]?.[1]);
        expect(revokedPolicy).not.toContain(grants[0].kilo.alias);
        expect(revokedPolicy).toContain(grants[1].kilo.alias);
        expect(await loadSessionCredentialGrants(state.storage)).toEqual([]);
        expect(await state.storage.get('physical_record')).toBeUndefined();
        expect(await loadWorktreeDeletionJournal(state.storage, worktreeId)).toMatchObject({
          destroyed: true,
          completed: true,
        });
        expect(await loadWorktreeDeletionJournal(state.storage, otherWorktreeId)).toMatchObject({
          destroyed: true,
          completed: true,
        });
      } finally {
        await state.storage.deleteAlarm();
        Object.assign(instance['env'], { SESSION_INGEST: original });
      }
    });
  });

  it('resolves an unrelated legacy runtime from original metadata before destroying the exclusive target', async () => {
    const sandboxId = `usr-${crypto.randomUUID().replaceAll('-', '').padEnd(48, '0')}`;
    const otherSandboxId = `usr-${'c'.repeat(48)}`;
    const legacyId = 'agent_44444444-4444-4444-8444-444444444444';
    const control = env.SANDBOX_CONTROL.getByName(sandboxId);
    await runInDurableObject(control, async (instance, state) => {
      const providerRef = encodeCloudflareProviderRef({
        sandboxId,
        instanceId: 'unrelated-legacy',
        containment: true,
      });
      const running = new Set([providerRef, otherSandboxId]);
      const provider: ProviderAdapter = {
        resumable: false,
        ensureBillingAdmission: async () => undefined,
        launch: async () => undefined,
        create: async () => ({ providerRef: sandboxId }),
        stop: async ref => {
          if (ref) running.delete(ref);
          return 'terminal';
        },
        observe: async ref => ({ status: ref && running.has(ref) ? 'active' : 'terminal' }),
        ensureLeaseAtLeast: async () => undefined,
        logs: async () => '',
      };
      const originalIngest = instance['env'].SESSION_INGEST;
      const originalLegacy = instance['env'].CLOUD_AGENT_SESSION;
      Object.assign(instance, { provider, createProviderAdapter: () => provider });
      Object.assign(instance['env'], {
        SESSION_INGEST: {
          canDestroyCloudAgentWorktreeSandbox: async () => ({
            kind: 'unresolved',
            owners: [
              {
                worktreeId: null,
                organizationId: null,
                sessions: [{ sessionId: kiloId(1), cloudAgentSessionId: legacyId }],
              },
            ],
          }),
        },
        CLOUD_AGENT_SESSION: {
          idFromName: (name: string) => name,
          get: () => ({
            getRuntimeLocation: async () => ({
              cloudAgentSessionId: legacyId,
              kiloUserId: userId,
              organizationId: null,
              sessionId: kiloId(1),
              worktreeId: null,
              location: { sandboxId: otherSandboxId, provider: 'cloudflare' },
            }),
          }),
        },
      });
      try {
        await instance.initializeOwner(userId);
        await seedPhysical(instance, state, 'unrelated-legacy', providerRef);
        await instance.deleteWorktreeResources({
          worktreeId,
          kiloUserId: userId,
          location: { sandboxId, provider: 'cloudflare' },
          sessionIds: [kiloId(0)],
        });
        expect([...running]).toEqual([otherSandboxId]);
        expect(await state.storage.get('physical_record')).toBeUndefined();
      } finally {
        await state.storage.deleteAlarm();
        Object.assign(instance['env'], {
          SESSION_INGEST: originalIngest,
          CLOUD_AGENT_SESSION: originalLegacy,
        });
      }
    });
  });

  it('rechecks ownership after scoped cleanup and retains its receipt until exclusive teardown is confirmed', async () => {
    const sandboxId = `usr-${crypto.randomUUID().replaceAll('-', '')}`;
    const control = env.SANDBOX_CONTROL.getByName(sandboxId);
    await runInDurableObject(control, async (instance, state) => {
      const memory = createDeletionProvider(sandboxId);
      const created = await memory.create({
        intentId: 'scoped-then-exclusive',
        createdAt: Date.now() - DEADLINE_MS.createSettle - 1,
      });
      if (!('providerRef' in created)) throw new Error('Expected instance');
      let shared = true;
      let mayStop = false;
      let scopedCleanups = 0;
      const provider: ProviderAdapter = {
        ...memory,
        stop: ref => (mayStop ? memory.stop(ref) : Promise.resolve('retryable')),
      };
      const original = instance['env'].SESSION_INGEST;
      Object.assign(instance['env'], {
        SESSION_INGEST: {
          canDestroyCloudAgentWorktreeSandbox: async () => ({
            kind: shared ? 'shared' : 'exclusive',
          }),
        },
      });
      await installDeletionProvider(instance, provider);
      Object.assign(instance, {
        socketHandler: {
          hasHandshakenSocket: () => true,
          closeAll: () => undefined,
          sendRequest: async (request: {
            operation: string;
            payload: { sessionIds: string[] };
          }) => {
            if (request.operation === 'worktree.delete') {
              shared = false;
              scopedCleanups++;
            }
            return {
              type: 'response',
              requestId: 'cleanup',
              ok: true,
              result:
                request.operation === 'worktree.prepareDeletion'
                  ? { prepared: true, sessionIds: request.payload.sessionIds }
                  : { deleted: true, sessionIds: request.payload.sessionIds },
            };
          },
        },
      });
      try {
        await instance.initializeOwner(userId);
        await seedPhysical(instance, state, 'scoped-then-exclusive', created.providerRef);
        const input = {
          worktreeId,
          kiloUserId: userId,
          location: { sandboxId, provider: 'vercel' as const },
          sessionIds: [kiloId(0)],
        };
        await expect(instance.deleteWorktreeResources(input)).rejects.toThrow('unconfirmed');
        expect(await loadWorktreeDeletionJournal(state.storage, worktreeId)).toMatchObject({
          resourcesCleaned: true,
          destroyed: false,
          completed: false,
        });
        expect((await instance.getPhysicalRecord()).providerRef).toBe(created.providerRef);
        shared = true;
        await expect(
          instance.deleteWorktreeResources({
            ...input,
            worktreeId: otherWorktreeId,
            sessionIds: [kiloId(1)],
          })
        ).rejects.toThrow('worktree_teardown_in_progress');
        expect(await state.storage.get('exclusive_worktree_deletion')).toBe(worktreeId);
        await instance.alarm();
        expect((await instance.getPhysicalRecord()).providerRef).toBe(created.providerRef);
        mayStop = true;
        await instance.deleteWorktreeResources(input);
        expect(await memory.observe(created.providerRef)).toMatchObject({ status: 'terminal' });
        expect(scopedCleanups).toBe(1);
      } finally {
        await state.storage.deleteAlarm();
        Object.assign(instance['env'], { SESSION_INGEST: original });
      }
    });
  });

  it('retains the exhausted stop budget and cleanup alarm under the exclusive fence until observation confirms death', async () => {
    const sandboxId = `ses-${crypto.randomUUID().replaceAll('-', '')}`;
    const control = env.SANDBOX_CONTROL.getByName(sandboxId);
    await runInDurableObject(control, async (instance, state) => {
      const native = createDeletionProvider(sandboxId);
      const created = await native.create({
        intentId: 'exhausted-deletion',
        createdAt: Date.now(),
      });
      if (!('providerRef' in created)) throw new Error('Missing native fixture allocation');
      const stop = vi.fn<ProviderAdapter['stop']>(async () => 'retryable');
      const observe = vi.fn(native.observe.bind(native));
      await installDeletionProvider(instance, { ...native, stop, observe });
      const original = instance['env'].SESSION_INGEST;
      Object.assign(instance['env'], {
        SESSION_INGEST: {
          canDestroyCloudAgentWorktreeSandbox: async () => ({ kind: 'exclusive' }),
        },
      });
      const input = {
        worktreeId,
        kiloUserId: userId,
        location: { sandboxId, provider: 'vercel' as const },
        sessionIds: [kiloId(0)],
      };
      try {
        await instance.initializeOwner(userId);
        await seedPhysical(instance, state, 'exhausted-deletion', created.providerRef);
        const receipts = [
          {
            id: crypto.randomUUID(),
            deadlineAt: Date.now() + 60_000,
            allocation: { kind: 'intent', id: 'exhausted-deletion' },
          },
        ];
        await state.storage.put('acquisition_receipts', receipts);
        for (let attempt = 1; attempt <= DEADLINE_MS.stopAttemptLadder.length; attempt++) {
          await expect(instance.deleteWorktreeResources(input)).rejects.toThrow('unconfirmed');
          expect((await instance.getPhysicalRecord()).stopTombstone?.attempts).toBe(attempt);
        }
        const exhausted = await instance.getPhysicalRecord();
        expect(exhausted.state).toBe('unknown');
        expect(stop).toHaveBeenCalledTimes(DEADLINE_MS.stopAttemptLadder.length);
        expect(await state.storage.get('exclusive_worktree_deletion')).toBe(worktreeId);
        const deadlines = await loadDeadlines(state.storage);
        expect(deadlines.reconciliation).toEqual(expect.any(Number));
        expect(await state.storage.getAlarm()).toBe(deadlines.reconciliation);
        await saveDeadlines(state.storage, { ...deadlines, reconciliation: Date.now() });
        await instance.alarm();
        expect(observe).toHaveBeenCalledWith(created.providerRef, exhausted.createIntent);
        expect(await instance.getPhysicalRecord()).toEqual(exhausted);
        await expect(instance.deleteWorktreeResources(input)).rejects.toThrow('unconfirmed');
        expect(stop).toHaveBeenCalledTimes(DEADLINE_MS.stopAttemptLadder.length);
        expect((await instance.getPhysicalRecord()).stopTombstone).toEqual(exhausted.stopTombstone);
        expect(await state.storage.getAlarm()).not.toBeNull();
        await native.stop(created.providerRef);
        await expect(instance.deleteWorktreeResources(input)).resolves.toEqual({
          deleted: true,
          sessionIds: [kiloId(0)],
        });
        expect(stop).toHaveBeenCalledTimes(DEADLINE_MS.stopAttemptLadder.length);
        expect(await state.storage.get('physical_record')).toBeUndefined();
        expect(await state.storage.get('provider_locator')).toBeUndefined();
        expect(await state.storage.get('acquisition_receipts')).toEqual(receipts);
        expect(await loadWorktreeDeletionJournal(state.storage, worktreeId)).toMatchObject({
          completed: true,
          destroyed: true,
        });
        expect(await state.storage.getAlarm()).toBeNull();
      } finally {
        await state.storage.deleteAlarm();
        Object.assign(instance['env'], { SESSION_INGEST: original });
      }
    });
  });

  it('closes streams, terminalizes messages, removes transcript state and alarms, and rejects late writes and registration', async () => {
    const sessionId = cloudId();
    const sandboxId = `usr-${crypto.randomUUID().replaceAll('-', '').padEnd(48, '0')}` as const;
    const stub = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);
    await stub.registerSession(registration(sessionId, sandboxId));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('session_messages', [{ messageId: 'msg_active', state: 'accepted' }]);
      await state.storage.setAlarm(Date.now() + 60_000);
      drizzle(state.storage)
        .insert(events)
        .values({
          execution_id: '',
          session_id: sessionId,
          stream_event_type: 'kilocode',
          payload: 'private transcript',
          timestamp: Date.now(),
        })
        .run();
    });
    const response = await stub.fetch(
      new Request('https://worker.test/stream?replay=false', { headers: { Upgrade: 'websocket' } })
    );
    if (!response.webSocket) throw new Error('Expected session stream');
    response.webSocket.accept();
    const closed = new Promise<number>(resolve =>
      response.webSocket?.addEventListener('close', event => resolve(event.code), { once: true })
    );
    await stub.beginWorktreeDeletion({ worktreeId, kiloSessionId: kiloId(0), ownerId: userId });
    await expect(stub.getRuntimeLocation()).resolves.toMatchObject({
      kiloUserId: userId,
      worktreeId,
      location: { sandboxId, provider: 'cloudflare' },
    });
    await expect(closed).resolves.toBe(1001);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('session_messages')).toMatchObject([{ state: 'cancelled' }]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
    await stub.finishWorktreeDeletion(worktreeId);
    await expect(stub.getRuntimeLocation()).resolves.toBeNull();
    await expect(stub.getMetadata()).resolves.toBeNull();
    await expect(stub.registerSession(registration(sessionId, sandboxId))).resolves.toMatchObject({
      success: false,
    });
    await expect(
      stub.receiveSandboxControlEvent({
        identity: { directory, kiloSessionId: kiloId(0) },
        payload: { type: 'session.updated', properties: { title: 'late private data' } },
      })
    ).resolves.toEqual({ applied: false });
    await runInDurableObject(stub, async (instance, state) => {
      await instance.alarm();
      expect(drizzle(state.storage).select().from(events).all()).toEqual([]);
      expect([...(await state.storage.list()).keys()].sort()).toEqual([
        'deleted_worktree',
        'deletion_completed',
        'session_lifecycle_fence',
      ]);
      expect(await state.storage.get('session_lifecycle_fence')).toMatchObject({
        state: 'deleted',
      });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('cleans a recovered ownership-only allocation without registering a session or starting a runtime', async () => {
    const sessionId = cloudId();
    const session = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);
    const sandboxId = `ses-${crypto.randomUUID().replaceAll('-', '')}`;
    const control = env.SANDBOX_CONTROL.getByName(sandboxId);
    await expect(
      session.beginWorktreeDeletion({ worktreeId, kiloSessionId: kiloId(0), ownerId: userId })
    ).resolves.toBeNull();
    await runInDurableObject(control, async (instance, state) => {
      const provider = createDeletionProvider(sandboxId);
      const create = vi.fn(provider.create.bind(provider));
      await installDeletionProvider(instance, { ...provider, create });
      const original = instance['env'].SESSION_INGEST;
      Object.assign(instance['env'], {
        SESSION_INGEST: {
          canDestroyCloudAgentWorktreeSandbox: async () => ({ kind: 'exclusive' }),
        },
      });
      try {
        const input = {
          worktreeId,
          kiloUserId: userId,
          location: { sandboxId, provider: 'vercel' as const },
          sessionIds: [kiloId(0)],
        };
        await expect(instance.deleteWorktreeResources(input)).resolves.toMatchObject({
          deleted: true,
        });
        await expect(instance.deleteWorktreeResources(input)).resolves.toMatchObject({
          deleted: true,
        });
        expect(create).not.toHaveBeenCalled();
        expect(await state.storage.get('physical_record')).toBeUndefined();
        expect(await state.storage.getAlarm()).toBeNull();
      } finally {
        Object.assign(instance['env'], { SESSION_INGEST: original });
      }
    });
    await session.finishWorktreeDeletion(worktreeId);
    await expect(
      session.beginWorktreeDeletion({ worktreeId, kiloSessionId: kiloId(0), ownerId: userId })
    ).resolves.toBeNull();
    await expect(session.getMetadata()).resolves.toBeNull();
  });

  it('does not reattach after deletion overtakes an in-flight ensureReady', async () => {
    const sessionId = cloudId();
    const sandboxId = `usr-${crypto.randomUUID().replaceAll('-', '').padEnd(48, '0')}` as const;
    const stub = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);
    await runInDurableObject(stub, async (instance, state) => {
      const started = Promise.withResolvers<void>();
      const ready = Promise.withResolvers<{ physical: 'running'; connection: 'ready' }>();
      const attach = vi.fn();
      const request = vi.fn();
      const original = instance['env'].SANDBOX_CONTROL;
      const validation = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => Response.json({ valid: true }));
      const deletionInput = {
        worktreeId,
        kiloSessionId: kiloId(0),
        ownerId: userId,
      };
      Object.assign(instance['env'], {
        SANDBOX_CONTROL: {
          getByName: () => ({
            getStatus: async () => ({ physical: 'stopped', connection: 'disconnected' }),
            ensureReady: () => {
              started.resolve();
              return ready.promise;
            },
            attachSession: attach,
            request,
          }),
        },
      });
      try {
        await instance.registerSession(registration(sessionId, sandboxId));
        await expect(
          instance.admitSubmittedMessage({ userId, turn: { type: 'prompt', prompt: 'start' } })
        ).resolves.toMatchObject({ success: true });
        await started.promise;
        await instance.beginWorktreeDeletion(deletionInput);
        ready.resolve({ physical: 'running', connection: 'ready' });
        await instance.finishWorktreeDeletion(worktreeId);
        expect(attach).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        expect(await state.storage.get('session_messages')).toBeUndefined();
        expect(await state.storage.getAlarm()).toBeNull();
      } finally {
        try {
          await instance.beginWorktreeDeletion(deletionInput);
        } finally {
          ready.resolve({ physical: 'running', connection: 'ready' });
          Object.assign(instance['env'], { SANDBOX_CONTROL: original });
          validation.mockRestore();
        }
        await instance.finishWorktreeDeletion(worktreeId);
      }
    });
  });

  it.each([false, true])(
    'keeps an unrelated accepted root waiting on a question healthy during deletion=%s',
    async duringDeletion => {
      const sandboxId = `usr-${crypto.randomUUID().replaceAll('-', '').padEnd(48, '0')}` as const;
      const root = cloudId();
      const sibling = cloudId();
      const wrapperInstanceId = crypto.randomUUID();
      const credential = generateSandboxCredential();
      const control = env.SANDBOX_CONTROL.getByName(sandboxId);
      const session = env.SANDBOX_SESSION.getByName(`${userId}:${sibling}`);
      const siblingIdentity = {
        sessionId: sibling,
        kiloSessionId: kiloId(99),
        directory: otherDirectory,
      };
      const question = { id: 'question_sibling', sessionID: kiloId(99), questions: [] };
      const providerRef = encodeCloudflareProviderRef({
        sandboxId,
        instanceId: 'shared-sync',
        containment: true,
      });
      const stop = vi.fn<ProviderAdapter['stop']>(async () => 'terminal');
      const create = vi.fn<ProviderAdapter['create']>(async () => {
        throw new Error('Read-only synchronization must not allocate');
      });
      const provider: ProviderAdapter = {
        resumable: false,
        ensureBillingAdmission: async () => undefined,
        create,
        launch: async () => {
          throw new Error('Read-only synchronization must not launch');
        },
        observe: async () => ({
          status: stop.mock.calls.length ? 'terminal' : 'active',
          providerRef,
        }),
        stop,
        ensureLeaseAtLeast: async () => undefined,
        logs: async () => '',
      };
      const registered = registration(sibling, sandboxId);
      await session.registerSession({
        ...registered,
        auth: { ...registered.auth, kiloSessionId: siblingIdentity.kiloSessionId },
        workspace: {
          ...registered.workspace,
          worktreeId: otherWorktreeId,
          workspacePath: otherDirectory,
        },
      });
      await runInDurableObject(session, async (_instance, state) => {
        const acceptedAt = Date.now() - DEADLINE_MS.acceptedOverdue - 1_000;
        await state.storage.put('session_messages', [
          {
            messageId: 'msg_waiting_for_answer',
            prompt: 'Wait for my answer',
            state: 'accepted',
            acceptedAt,
            lastActivityAt: acceptedAt,
            wrapperInstanceId,
          },
        ]);
      });
      await runInDurableObject(control, async (instance, state) => {
        Object.assign(instance, { provider, createProviderAdapter: () => provider });
        await instance.initializeOwner(userId);
        await seedPhysical(instance, state, 'shared-sync', providerRef);
        for (const route of [
          { sessionId: root, kiloSessionId: kiloId(0), directory, worktreeId },
          { ...siblingIdentity, worktreeId: otherWorktreeId },
        ]) {
          await attachGrantedSession(instance, state, { ...route, ownerId: userId }, 'cloudflare');
        }
      });
      await control.setWrapperCredentialHash(await hashSandboxCredential(credential));
      const socket = await connectControl(sandboxId, credential, wrapperInstanceId);
      const requests: RequestFrame[] = [];
      socket.addEventListener('message', event => {
        const frame = JSON.parse(String(event.data)) as RequestFrame;
        requests.push(frame);
        reply(
          socket,
          frame,
          frame.operation === 'session.sync'
            ? { status: { type: 'idle' }, questions: [question], permissions: [] }
            : frame.operation === 'worktree.prepareDeletion'
              ? { prepared: true, sessionIds: [kiloId(0)] }
              : { deleted: true, sessionIds: [kiloId(0)] }
        );
      });
      socket.send(
        JSON.stringify({
          type: 'event',
          event: 'sandbox.ready',
          payload: { kiloReady: true, globalFeedAttached: true },
        })
      );
      try {
        await vi.waitFor(async () => {
          expect(await control.getStatus()).toMatchObject({
            connection: 'ready',
            wrapperInstanceId,
          });
        });
        await runInDurableObject(control, async (instance, state) => {
          const siblingSession = instance['env'].SANDBOX_SESSION.getByName(`${userId}:${sibling}`);
          const leaseStarted = Promise.withResolvers<void>();
          const releaseLease = Promise.withResolvers<void>();
          provider.ensureLeaseAtLeast = async () => {
            leaseStarted.resolve();
            await releaseLease.promise;
          };
          let heartbeat: Promise<void> | undefined;
          let deletion: ReturnType<SandboxControl['deleteWorktreeResources']> | undefined;
          try {
            if (duringDeletion) {
              const wrapper = state.getWebSockets('sandbox-control')[0];
              if (!wrapper) throw new Error('Missing connected wrapper');
              heartbeat = instance.webSocketMessage(
                wrapper,
                JSON.stringify({
                  type: 'event',
                  event: 'sandbox.heartbeat',
                  payload: {
                    state: 'active',
                    kilo: { ready: true },
                    sessions: [
                      {
                        kiloSessionId: kiloId(99),
                        state: 'active',
                        idleForMs: 0,
                        waitingOn: 'input',
                      },
                    ],
                  },
                })
              );
              await leaseStarted.promise;
              deletion = instance.deleteWorktreeResources({
                worktreeId,
                kiloUserId: userId,
                location: { sandboxId, provider: 'cloudflare' },
                sessionIds: [kiloId(0)],
              });
              await vi.waitFor(async () => {
                expect(await state.storage.get('exclusive_worktree_deletion')).toBe(worktreeId);
              });
              for (const identity of [
                { sessionId: root, kiloSessionId: kiloId(0), directory },
                { ...siblingIdentity, sessionId: cloudId(), kiloSessionId: kiloId(100) },
                { ...siblingIdentity, kiloSessionId: kiloId(0) },
                { ...siblingIdentity, directory },
              ]) {
                await expect(
                  instance.request({
                    operation: 'session.sync',
                    session: identity,
                    expectedWrapperInstanceId: wrapperInstanceId,
                    payload: {},
                  })
                ).rejects.toThrow('worktree_deleting');
              }
              await expect(
                instance.request({
                  operation: 'session.sync',
                  session: siblingIdentity,
                  expectedWrapperInstanceId: crypto.randomUUID(),
                  payload: {},
                })
              ).rejects.toThrow('Sandbox wrapper runtime changed');
              for (const operation of ['session.attach', 'session.prompt'] as const) {
                await expect(
                  instance.request({
                    operation,
                    session: siblingIdentity,
                    expectedWrapperInstanceId: wrapperInstanceId,
                    payload: {},
                  })
                ).rejects.toThrow('worktree_deleting');
              }
              await expect(
                instance.attachSession({
                  ...siblingIdentity,
                  ownerId: userId,
                  worktreeId: otherWorktreeId,
                })
              ).rejects.toThrow('worktree_deleting');
              await expect(
                instance.ensureReady({
                  ownerId: userId,
                  sessionId: sibling,
                  worktreeId: otherWorktreeId,
                  allowCreate: true,
                })
              ).rejects.toThrow('worktree_deleting');
              await expect(instance.claimCreate('blocked-allocation')).rejects.toThrow(
                'worktree_deleting'
              );
              const journal = await loadWorktreeDeletionJournal(state.storage, worktreeId);
              if (!journal) throw new Error('Missing deletion journal');
              await state.storage.put(`${WORKTREE_DELETION_PREFIX}${worktreeId}`, {
                ...journal,
                exclusiveTeardown: true,
              });
              try {
                await expect(
                  instance.request({
                    operation: 'session.sync',
                    session: siblingIdentity,
                    expectedWrapperInstanceId: wrapperInstanceId,
                    payload: {},
                  })
                ).rejects.toThrow('worktree_deleting');
              } finally {
                await state.storage.put(`${WORKTREE_DELETION_PREFIX}${worktreeId}`, journal);
              }
            }
            const deadlines = await loadDeadlines(state.storage);
            await runInDurableObject(siblingSession, async (siblingInstance, siblingState) => {
              await siblingInstance.alarm();
              expect(await siblingState.storage.get('session_messages')).toMatchObject([
                { messageId: 'msg_waiting_for_answer', state: 'accepted', wrapperInstanceId },
              ]);
              expect(await siblingState.storage.get('session_pending_interactions')).toMatchObject({
                questions: [question],
                permissions: [],
              });
              expect(await siblingState.storage.get('pending_runtime_cleanup')).toBeUndefined();
            });
            expect(requests).toEqual([
              expect.objectContaining({ operation: 'session.sync', session: siblingIdentity }),
            ]);
            expect(await loadDeadlines(state.storage)).toEqual(deadlines);
            expect(await instance.getStatus()).toMatchObject({
              physical: 'running',
              connection: 'ready',
              wrapperInstanceId,
            });
            releaseLease.resolve();
            await heartbeat;
            await deletion;
            if (duringDeletion) {
              await expect(
                instance.request({
                  operation: 'session.sync',
                  session: { sessionId: root, kiloSessionId: kiloId(0), directory },
                  expectedWrapperInstanceId: wrapperInstanceId,
                  payload: {},
                })
              ).rejects.toThrow('worktree_deleting');
            }
            expect(stop).not.toHaveBeenCalled();
            expect(create).not.toHaveBeenCalled();
            expect((await instance.getPhysicalRecord()).providerRef).toBe(providerRef);
            expect(await instance.listRoutes()).toEqual(
              duringDeletion
                ? [expect.objectContaining(siblingIdentity)]
                : [
                    expect.objectContaining({ sessionId: root }),
                    expect.objectContaining(siblingIdentity),
                  ]
            );
          } finally {
            releaseLease.resolve();
            await heartbeat;
            await deletion;
            await state.storage.deleteAlarm();
            await runInDurableObject(siblingSession, (_instance, siblingState) =>
              siblingState.storage.deleteAlarm()
            );
          }
        });
      } finally {
        socket.close();
      }
    }
  );

  it('journals discovered descendants before cleanup and preserves unrelated shared routes on partial failure and retry', async () => {
    const sandboxId = `usr-${crypto.randomUUID().replaceAll('-', '')}`;
    const control = env.SANDBOX_CONTROL.getByName(sandboxId);
    const credential = generateSandboxCredential();
    const root = cloudId();
    const other = cloudId();
    await control.initializeOwner(userId);
    const providerRef = encodeCloudflareProviderRef({
      sandboxId,
      instanceId: 'shared-test',
      containment: true,
    });
    await runInDurableObject(control, async (instance, state) => {
      const provider: ProviderAdapter = {
        resumable: false,
        ensureBillingAdmission: async () => undefined,
        create: async () => {
          throw new Error('Shared cleanup must not allocate');
        },
        launch: async () => {
          throw new Error('Shared cleanup must not launch');
        },
        observe: async () => ({ status: 'active', providerRef }),
        stop: async () => {
          throw new Error('Shared cleanup must not stop siblings');
        },
        ensureLeaseAtLeast: async () => undefined,
        logs: async () => '',
      };
      Object.assign(instance, { provider, createProviderAdapter: () => provider });
      await seedPhysical(instance, state, 'shared-test', providerRef);
      await attachGrantedSession(
        instance,
        state,
        {
          sessionId: root,
          kiloSessionId: kiloId(0),
          directory,
          ownerId: userId,
          worktreeId,
        },
        'cloudflare'
      );
      await attachGrantedSession(
        instance,
        state,
        {
          sessionId: other,
          kiloSessionId: kiloId(99),
          directory: otherDirectory,
          ownerId: userId,
          worktreeId: otherWorktreeId,
        },
        'cloudflare'
      );
    });
    await control.setWrapperCredentialHash(await hashSandboxCredential(credential));
    const socket = await connectControl(sandboxId, credential);
    const input = {
      worktreeId,
      kiloUserId: userId,
      location: { sandboxId, provider: 'cloudflare' as const },
      sessionIds: [kiloId(0), kiloId(1)],
    };
    const preparedFrame = nextFrame(socket);
    const first = control.deleteWorktreeResources(input).then(
      () => undefined,
      error => error
    );
    const prepare = await preparedFrame;
    expect(prepare.operation).toBe('worktree.prepareDeletion');
    await runInDurableObject(control, async (_instance, state) => {
      const grants = await loadSessionCredentialGrants(state.storage);
      expect(grants.map(grant => grant.scopeId)).toEqual([otherWorktreeId]);
      expect(grants[0]?.members).toEqual([{ sessionId: other, kiloSessionId: kiloId(99) }]);
    });
    const deletionFrame = nextFrame(socket);
    reply(socket, prepare, { prepared: true, sessionIds: [...input.sessionIds, kiloId(2)] });
    const deletion = await deletionFrame;
    expect(deletion.operation).toBe('worktree.delete');
    await runInDurableObject(control, async (_instance, state) => {
      expect((await loadWorktreeDeletionJournal(state.storage, worktreeId))?.sessionIds).toContain(
        kiloId(2)
      );
    });
    reply(socket, deletion, undefined, false);
    expect(await first).toBeInstanceOf(Error);
    expect(await control.listRoutes()).toHaveLength(2);
    const lateAttach = await runInDurableObject(control, (instance, state) =>
      attachGrantedSession(
        instance,
        state,
        {
          sessionId: cloudId(),
          kiloSessionId: kiloId(3),
          directory,
          ownerId: userId,
          worktreeId,
        },
        'cloudflare'
      )
    ).then(
      () => null,
      error => error
    );
    expect(String(lateAttach)).toContain('worktree_deleting');
    await runInDurableObject(control, (instance, state) =>
      attachGrantedSession(
        instance,
        state,
        {
          sessionId: cloudId(),
          kiloSessionId: kiloId(100),
          directory: otherDirectory,
          ownerId: userId,
          worktreeId: otherWorktreeId,
        },
        'cloudflare'
      )
    );
    const retryFrame = nextFrame(socket);
    const retry = control.deleteWorktreeResources(input);
    const prepareAgain = await retryFrame;
    const finalFrame = nextFrame(socket);
    reply(socket, prepareAgain, { prepared: true, sessionIds: [...input.sessionIds, kiloId(2)] });
    const final = await finalFrame;
    reply(socket, final, { deleted: true, sessionIds: [...input.sessionIds, kiloId(2)] });
    await expect(retry).resolves.toEqual({
      deleted: true,
      sessionIds: [...input.sessionIds, kiloId(2)],
    });
    expect((await control.listRoutes()).map(route => route.worktreeId)).toEqual([
      otherWorktreeId,
      otherWorktreeId,
    ]);
    expect(await control.getOwner()).toBe(userId);
    expect((await control.getPhysicalRecord()).providerRef).toBe(providerRef);
    socket.close();
  });

  it.each(['ses', 'usr'])(
    'keeps %s provider locators until confirmed teardown and preserves a later unrelated runtime on retry',
    async prefix => {
      const sessionId = cloudId();
      const sandboxId = `${prefix}-${crypto.randomUUID().replaceAll('-', '')}` as
        | `ses-${string}`
        | `usr-${string}`;
      const control = env.SANDBOX_CONTROL.getByName(sandboxId);
      await runInDurableObject(control, async (instance, state) => {
        const memory = createDeletionProvider(sandboxId);
        const created = await memory.create({
          intentId: 'exclusive',
          createdAt: Date.now() - DEADLINE_MS.createSettle - 1,
        });
        if (!('providerRef' in created)) throw new Error('Expected memory provider instance');
        let mayStop = false;
        const provider: ProviderAdapter = {
          ...memory,
          stop: ref => (mayStop ? memory.stop(ref) : Promise.resolve('retryable')),
        };
        await installDeletionProvider(instance, provider);
        const original = instance['env'].SESSION_INGEST;
        Object.assign(instance['env'], {
          SESSION_INGEST: {
            canDestroyCloudAgentWorktreeSandbox: async () => ({ kind: 'exclusive' }),
          },
        });
        try {
          await instance.initializeOwner(userId);
          await seedPhysical(instance, state, 'exclusive', created.providerRef);
          const locator = await state.storage.get('provider_locator');
          expect(locator).toMatchObject({
            teamId: vercelConfig.VERCEL_TEAM_ID,
            projectId: vercelConfig.VERCEL_PROJECT_ID,
            snapshotId: vercelConfig.VERCEL_SANDBOX_SNAPSHOT_ID,
            runtimeBuildId: vercelConfig.VERCEL_SANDBOX_RUNTIME_BUILD_ID,
            runtime: 'node24',
          });
          await instance.setWrapperCredentialHash(
            await hashSandboxCredential(generateSandboxCredential())
          );
          const pair = new WebSocketPair();
          state.acceptWebSocket(pair[1], ['sandbox-control']);
          pair[0].accept();
          pair[1].serializeAttachment({
            handshakeComplete: true,
            acceptedAt: Date.now(),
            protocolVersion: 1,
            providerInstanceId: created.providerRef,
          });
          const closed = new Promise<void>(resolve =>
            pair[0].addEventListener('close', () => resolve(), { once: true })
          );
          const input = {
            worktreeId,
            kiloUserId: userId,
            location: { sandboxId, provider: 'vercel' as const },
            sessionIds: [kiloId(0)],
          };
          await expect(instance.deleteWorktreeResources(input)).rejects.toThrow('unconfirmed');
          expect((await instance.getPhysicalRecord()).providerRef).toBe(created.providerRef);
          expect(await state.storage.get('provider_locator')).toEqual(locator);
          expect(await state.storage.get('exclusive_worktree_deletion')).toBe(worktreeId);
          await expect(
            instance.ensureReady({ ownerId: userId, sessionId, allowCreate: true })
          ).rejects.toThrow('worktree_deleting');
          mayStop = true;
          await expect(instance.deleteWorktreeResources(input)).resolves.toMatchObject({
            deleted: true,
          });
          await closed;
          expect(await memory.observe(created.providerRef)).toMatchObject({ status: 'terminal' });
          expect(await state.storage.get('wrapper_credential_hash')).toBeUndefined();
          expect(await state.storage.get('owner_id')).toBeUndefined();
          expect(await state.storage.get('provider_locator')).toBeUndefined();
          expect(await state.storage.get('physical_record')).toBeUndefined();
          expect(await state.storage.getAlarm()).toBeNull();
          expect(await loadWorktreeDeletionJournal(state.storage, worktreeId)).toMatchObject({
            resourcesCleaned: true,
            destroyed: true,
            completed: true,
          });
          const workerUrl = instance['env'].WORKER_URL;
          Object.assign(instance['env'], { WORKER_URL: 'https://worker.test' });
          try {
            if (prefix === 'ses') {
              await env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`).registerSession({
                ...registration(sessionId, sandboxId),
                workspace: {
                  sandboxId,
                  sandboxProvider: 'vercel',
                  workspacePath: otherDirectory,
                  worktreeId: otherWorktreeId,
                },
              });
              await instance.ensureReady({
                ownerId: userId,
                sessionId,
                provider: 'vercel',
                allowCreate: true,
                worktreeId: otherWorktreeId,
              });
            } else {
              const replacement = await provider.create({
                intentId: 'legacy-replacement',
                createdAt: Date.now() - DEADLINE_MS.createSettle - 1,
              });
              if (!('providerRef' in replacement))
                throw new Error('Expected legacy fixture runtime');
              await instance.initializeOwner(userId);
              await seedPhysical(instance, state, 'legacy-replacement', replacement.providerRef);
              await instance.setWrapperCredentialHash(
                await hashSandboxCredential(generateSandboxCredential())
              );
            }
            const replacement = await instance.getPhysicalRecord();
            const credential = await state.storage.get('wrapper_credential_hash');
            expect(await memory.observe(replacement.providerRef)).toMatchObject({
              status: 'active',
            });
            await instance.deleteWorktreeResources(input);
            expect((await instance.getPhysicalRecord()).providerRef).toBe(replacement.providerRef);
            expect(await state.storage.get('wrapper_credential_hash')).toBe(credential);
            expect(await instance.getOwner()).toBe(userId);
            await state.storage.deleteAlarm();
          } finally {
            Object.assign(instance['env'], { WORKER_URL: workerUrl });
          }
        } finally {
          Object.assign(instance['env'], { SESSION_INGEST: original });
        }
      });
    }
  );

  it('fences admission and waits for a late provider create before destroying its exact returned instance', async () => {
    const sandboxId = `ses-${crypto.randomUUID().replaceAll('-', '')}` as const;
    const sessionId = cloudId();
    await env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`).registerSession({
      ...registration(sessionId, sandboxId),
      workspace: { ...registration(sessionId, sandboxId).workspace, sandboxProvider: 'vercel' },
    });
    const control = env.SANDBOX_CONTROL.getByName(sandboxId);
    await runInDurableObject(control, async (instance, state) => {
      const memory = createDeletionProvider(sandboxId);
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let stoppedRef: string | null = null;
      const provider: ProviderAdapter = {
        ...memory,
        create: async intent => {
          started.resolve();
          await release.promise;
          return memory.create(intent);
        },
        stop: async ref => {
          stoppedRef = ref;
          return memory.stop(ref);
        },
      };
      await installDeletionProvider(instance, provider);
      const original = instance['env'].SESSION_INGEST;
      const workerUrl = instance['env'].WORKER_URL;
      Object.assign(instance['env'], {
        WORKER_URL: 'https://worker.test',
        SESSION_INGEST: {
          canDestroyCloudAgentWorktreeSandbox: async () => ({ kind: 'exclusive' }),
        },
      });
      try {
        const ready = instance.ensureReady({
          ownerId: userId,
          sessionId,
          provider: 'vercel',
          allowCreate: true,
          worktreeId,
        });
        await started.promise;
        let complete = false;
        const deletion = instance
          .deleteWorktreeResources({
            worktreeId,
            kiloUserId: userId,
            location: { sandboxId, provider: 'vercel' },
            sessionIds: [kiloId(0)],
          })
          .then(result => {
            complete = true;
            return result;
          });
        await state.storage.sync();
        await Promise.resolve();
        expect(complete).toBe(false);
        expect(stoppedRef).toBeNull();
        const clock = vi
          .spyOn(Date, 'now')
          .mockReturnValue(Date.now() + DEADLINE_MS.createSettle + 1);
        try {
          release.resolve();
          await ready;
          await deletion;
        } finally {
          clock.mockRestore();
        }
        expect(stoppedRef).toContain('vsess_');
        expect(await memory.observe(stoppedRef)).toMatchObject({ status: 'terminal' });
        expect(await state.storage.getAlarm()).toBeNull();
        expect(await state.storage.get('physical_record')).toBeUndefined();
      } finally {
        Object.assign(instance['env'], { SESSION_INGEST: original, WORKER_URL: workerUrl });
      }
    });
  });
});
