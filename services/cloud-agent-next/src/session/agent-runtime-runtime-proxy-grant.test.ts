import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import type { WrapperObservation } from '../agent-sandbox/protocol.js';
import type { Env } from '../types.js';
import type { FencedWrapperDispatchRequest, MessageDeliveryRequest } from '../execution/types.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { RUNTIME_AUTHORIZATION_KEY } from './runtime-authorization-persistence.js';
import { createAgentRuntime } from './agent-runtime.js';
import {
  clearWrapperRuntimeIdentity,
  getWrapperLease,
  getWrapperRuntimeState,
  putWrapperLease,
  reduceWrapperLease,
} from './wrapper-runtime-state.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  getSandbox: vi.fn(),
  ContainerProxy: class ContainerProxy {},
}));

vi.mock('@cloudflare/containers', () => ({}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('../logger.js', () => {
  const logger = {
    setTags: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withFields: vi.fn(),
  };
  logger.withFields.mockReturnValue(logger);
  return {
    logger,
    withLogTags: async (_tags: unknown, fn: () => Promise<void>) => fn(),
    WithLogTags: () => (_target: unknown, _propertyKey: string, descriptor: PropertyDescriptor) =>
      descriptor,
  };
});

vi.mock('drizzle-orm/durable-sqlite', () => ({
  drizzle: vi.fn(() => ({})),
}));

vi.mock('drizzle-orm/durable-sqlite/migrator', () => ({
  migrate: vi.fn(),
}));

vi.mock('../../drizzle/migrations', () => ({
  default: { journal: {}, migrations: {} },
}));

vi.mock('./queries/index.js', () => ({
  createExecutionQueries: vi.fn(() => ({})),
  createEventQueries: vi.fn(() => ({})),
  createLeaseQueries: vi.fn(() => ({})),
}));

vi.mock('../websocket/stream.js', () => ({
  createStreamHandler: vi.fn(),
  getConnectedStreamClientCount: vi.fn(() => 0),
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ api_token_pepper: null, blocked_reason: null }],
        }),
      }),
    }),
  }),
}));

const { CloudAgentSession } = await import('../persistence/CloudAgentSession.js');

const secret = 'test-secret';
const authorizationId = '11111111-1111-4111-8111-111111111111';

type MemoryStorage = Pick<DurableObjectStorage, 'get' | 'put' | 'delete'> & DurableObjectStorage;

function createMemoryStorage(initialEntries?: Array<[string, unknown]>): MemoryStorage {
  const store = new Map(initialEntries ?? []);
  return {
    async get<T = unknown>(key: string) {
      return store.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      store.set(key, value);
    },
    async delete(keys: string | string[]) {
      let deleted = false;
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        deleted = store.delete(key) || deleted;
      }
      return deleted;
    },
  } as MemoryStorage;
}

function authorization(): RuntimeAuthorization {
  const issuedAt = new Date();
  return {
    version: 1,
    id: authorizationId,
    resourceKind: 'cloud-agent-next',
    resourceId: 'agent_runtime',
    userId: 'user_runtime',
    authorizationUserId: 'user_runtime',
    organizationId: 'org_runtime',
    issuedAt: issuedAt.toISOString(),
    delegationExpiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60_000).toISOString(),
    state: 'active',
    bindings: {
      userPepperDigest: 'a'.repeat(64),
      authorizationPepperDigest: 'b'.repeat(64),
      userMembershipId: 'membership_1',
      authorizationUserMembershipId: 'membership_1',
    },
    source: { admissionSource: 'user' },
  };
}

function metadata(token: string): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: 'agent_runtime',
      userId: 'user_runtime',
      orgId: 'org_runtime',
    },
    auth: {
      kiloSessionId: 'kilo_runtime',
      kilocodeToken: token,
    },
    lifecycle: {
      version: 1,
      timestamp: 1,
    },
    workspace: {
      sandboxId: 'ses-abcdef',
      sandboxProvider: 'cloudflare',
      workspacePath: '/workspace/runtime',
      sessionHome: '/home/agent_runtime',
      branchName: 'main',
    },
  };
}

function runtimeToken(): string {
  return jwt.sign(
    {
      runtimeAuthorization: { id: authorizationId },
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    { algorithm: 'HS256' }
  );
}

function deliveryPlan(messageId: string, token: string): MessageDeliveryRequest {
  return {
    scope: { sessionId: 'agent_runtime', userId: 'user_runtime' },
    turn: {
      type: 'prompt',
      messageId,
      prompt: 'Continue after wrapper restart',
    },
    agent: { mode: 'code', model: 'runtime-model' },
    workspace: {
      sandboxId: 'ses-abcdef',
      metadata: metadata(token),
    },
    wrapper: { kiloSessionId: 'kilo_runtime' },
  };
}

function createSession(storage: MemoryStorage) {
  return new CloudAgentSession(
    {
      id: { name: 'user_runtime:agent_runtime' },
      storage: {
        ...storage,
        sql: {},
        getAlarm: async () => null,
        setAlarm: async () => undefined,
        list: async () => new Map(),
      },
      blockConcurrencyWhile: async () => undefined,
      getWebSockets: () => [],
    } as never,
    { NEXTAUTH_SECRET: secret } as never
  );
}

describe('AgentRuntime credential proxy handle stability across warm reuse and physical binding', () => {
  it('keeps the credential proxy handle stable across a warm sandbox reuse', async () => {
    const token = runtimeToken();
    const storage = createMemoryStorage([
      ['metadata', metadata(token)],
      [RUNTIME_AUTHORIZATION_KEY, authorization()],
      [
        'wrapper_runtime_state',
        {
          wrapperGeneration: 7,
          wrapperConnectionId: 'conn_stale',
          wrapperRunId: 'wr_stale',
        },
      ],
      [
        'wrapper_lease',
        {
          state: 'owns_wrapper',
          nextInstanceGeneration: 2,
          instance: { instanceId: 'instance_old', instanceGeneration: 1 },
        },
      ],
    ]);
    let discovery: WrapperObservation = { status: 'absent' };
    const deliveredPlans: FencedWrapperDispatchRequest[] = [];
    const runtime = createAgentRuntime({
      storage,
      env: { NEXTAUTH_SECRET: secret } as Env,
      getMetadata: async () => metadata(token),
      getOrchestratorOverride: () => ({
        execute: async (plan: FencedWrapperDispatchRequest) => {
          deliveredPlans.push(plan);
          return { kiloSessionId: 'kilo_runtime' };
        },
      }),
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: () => false,
      discoverSessionWrappers: async () => discovery,
    });
    const plan = deliveryPlan('msg_018f1e2d3c4bRuntimeGrant01', token);

    await expect(runtime.send(plan)).resolves.toMatchObject({
      success: true,
      outcome: 'accepted',
    });

    const firstRuntimeState = await getWrapperRuntimeState(storage);
    const firstLease = await getWrapperLease(storage);
    if (firstLease.state !== 'owns_wrapper') {
      throw new Error('expected owned wrapper after cold allocation');
    }
    expect(firstRuntimeState.wrapperGeneration).toBe(firstLease.instance.instanceGeneration);
    const fence1 = deliveredPlans[0]?.wrapper.fence;
    if (!fence1) throw new Error('expected first dispatch fence');
    expect(fence1).toEqual({
      wrapperRunId: firstRuntimeState.wrapperRunId,
      wrapperGeneration: firstLease.instance.instanceGeneration,
      wrapperConnectionId: firstRuntimeState.wrapperConnectionId,
    });

    const session = createSession(storage);
    const handle1 = await session.issueRuntimeCredentialProxyGrant(fence1);
    if (!handle1) throw new Error('expected initial credential proxy handle');

    const keepWarmUntil = Date.now() + 60_000;
    await putWrapperLease(
      storage,
      reduceWrapperLease(firstLease, {
        type: 'retain_warm',
        instanceId: firstLease.instance.instanceId,
        keepWarmUntil,
      })
    );
    const retainedRuntimeState = await getWrapperRuntimeState(storage);
    await clearWrapperRuntimeIdentity(
      storage,
      {
        wrapperGeneration: retainedRuntimeState.wrapperGeneration,
        wrapperConnectionId: retainedRuntimeState.wrapperConnectionId,
      },
      { incrementGeneration: true }
    );
    expect((await getWrapperRuntimeState(storage)).wrapperRunId).toBeUndefined();

    await expect(session.resolveRuntimeCredentialProxyGrant(handle1)).resolves.toMatchObject({
      token,
    });

    discovery = {
      status: 'present',
      observed: [
        {
          representation: 'process',
          id: 'wrapper-warm',
          port: 5_000,
          instanceId: firstLease.instance.instanceId,
          instanceGeneration: firstLease.instance.instanceGeneration,
        },
      ],
    };
    await expect(
      runtime.send(deliveryPlan('msg_018f1e2d3c4bRuntimeGrant02', token))
    ).resolves.toMatchObject({ success: true, outcome: 'accepted' });

    const followUpLease = await getWrapperLease(storage);
    if (followUpLease.state !== 'owns_wrapper') {
      throw new Error('expected warm wrapper lease after follow-up');
    }
    const fence2 = deliveredPlans[1]?.wrapper.fence;
    if (!fence2) throw new Error('expected follow-up dispatch fence');
    expect(followUpLease.instance).toEqual(firstLease.instance);
    expect(fence2.wrapperRunId).not.toBe(fence1.wrapperRunId);
    expect(fence2.wrapperConnectionId).not.toBe(fence1.wrapperConnectionId);

    await expect(session.issueRuntimeCredentialProxyGrant(fence1)).resolves.toBeNull();

    await expect(session.issueRuntimeCredentialProxyGrant(fence2)).resolves.toBe(handle1);
    await expect(session.resolveRuntimeCredentialProxyGrant(handle1)).resolves.toMatchObject({
      token,
    });

    discovery = { status: 'absent' };
    await expect(
      runtime.send(deliveryPlan('msg_018f1e2d3c4bRuntimeGrant03', token))
    ).resolves.toMatchObject({ success: true, outcome: 'accepted' });
    const replacementLease = await getWrapperLease(storage);
    if (replacementLease.state !== 'owns_wrapper') {
      throw new Error('expected replacement wrapper lease');
    }
    expect(replacementLease.instance.instanceId).not.toBe(firstLease.instance.instanceId);
    await expect(session.resolveRuntimeCredentialProxyGrant(handle1)).resolves.toBeNull();
    const fence3 = deliveredPlans[2]?.wrapper.fence;
    if (!fence3) throw new Error('expected replacement dispatch fence');
    const replacementHandle = await session.issueRuntimeCredentialProxyGrant(fence3);
    expect(typeof replacementHandle).toBe('string');
    expect(replacementHandle).not.toBe(handle1);
  });

  it('fails issuance when a replacement physical lease is persisted while the old logical identity remains', async () => {
    const token = runtimeToken();
    const storage = createMemoryStorage([
      ['metadata', metadata(token)],
      [RUNTIME_AUTHORIZATION_KEY, authorization()],
      [
        'wrapper_runtime_state',
        {
          wrapperGeneration: 1,
          wrapperConnectionId: 'conn_old',
          wrapperRunId: 'wr_old',
        },
      ],
      [
        'wrapper_lease',
        {
          state: 'owns_wrapper',
          nextInstanceGeneration: 2,
          instance: { instanceId: 'instance_old', instanceGeneration: 1 },
        },
      ],
    ]);
    const currentLease = await getWrapperLease(storage);
    if (currentLease.state !== 'owns_wrapper') {
      throw new Error('expected owned wrapper lease');
    }
    const released = reduceWrapperLease(currentLease, {
      type: 'owned_absent',
      instanceId: currentLease.instance.instanceId,
    });
    await putWrapperLease(
      storage,
      reduceWrapperLease(released, {
        type: 'allocate',
        instance: { instanceId: 'instance_new', instanceGeneration: 2 },
        startupDeadlineAt: Date.now() + 60_000,
      })
    );

    const session = createSession(storage);
    await expect(
      session.issueRuntimeCredentialProxyGrant({
        wrapperRunId: 'wr_old',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_old',
      })
    ).resolves.toBeNull();
  });
});
