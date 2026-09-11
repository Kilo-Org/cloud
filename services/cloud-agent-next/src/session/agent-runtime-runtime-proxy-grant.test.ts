import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import type { AgentSandbox } from '../agent-sandbox/protocol.js';
import type { Env } from '../types.js';
import type { FencedWrapperDispatchRequest } from '../execution/types.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { RUNTIME_AUTHORIZATION_KEY } from './runtime-authorization-persistence.js';
import { createAgentRuntime } from './agent-runtime.js';
import { getWrapperLease, getWrapperRuntimeState } from './wrapper-runtime-state.js';

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

describe('AgentRuntime restart credential proxy grant', () => {
  it('issues a runtime credential proxy grant after allocating a replacement wrapper', async () => {
    const token = jwt.sign(
      {
        runtimeAuthorization: { id: authorizationId },
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      secret,
      { algorithm: 'HS256' }
    );
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
      createAgentSandbox: () =>
        ({
          discoverSessionWrappers: async () => ({ status: 'absent' }),
        }) as unknown as AgentSandbox,
    });

    await expect(
      runtime.send({
        scope: { sessionId: 'agent_runtime', userId: 'user_runtime' },
        turn: {
          type: 'prompt',
          messageId: 'msg_018f1e2d3c4bRuntimeGrant01',
          prompt: 'Continue after wrapper restart',
        },
        agent: { mode: 'code', model: 'runtime-model' },
        workspace: {
          sandboxId: 'ses-abcdef',
          metadata: metadata(token),
        },
        wrapper: { kiloSessionId: 'kilo_runtime' },
      })
    ).resolves.toMatchObject({ success: true, outcome: 'accepted' });

    const runtimeState = await getWrapperRuntimeState(storage);
    const physicalLease = await getWrapperLease(storage);
    if (physicalLease.state !== 'owns_wrapper') {
      throw new Error('expected owned wrapper after restart allocation');
    }
    expect(runtimeState.wrapperGeneration).toBe(physicalLease.instance.instanceGeneration);
    const fence = deliveredPlans[0]?.wrapper.fence;
    expect(fence).toEqual({
      wrapperRunId: runtimeState.wrapperRunId,
      wrapperGeneration: physicalLease.instance.instanceGeneration,
      wrapperConnectionId: runtimeState.wrapperConnectionId,
    });

    const session = new CloudAgentSession(
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
    if (!fence) throw new Error('expected dispatch fence');
    await expect(session.issueRuntimeCredentialProxyGrant(fence)).resolves.toEqual(
      expect.any(String)
    );
  });
});
