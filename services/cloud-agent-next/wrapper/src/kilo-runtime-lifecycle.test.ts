import { describe, expect, it } from 'bun:test';
import type { WrapperKiloClient } from './kilo-api';
import {
  createKiloRuntimeLifecycle,
  type KiloRuntimeLifecycle,
  type KiloRuntimeStartInput,
} from './kilo-runtime-lifecycle';

const WORKSPACE = '/workspace/repo';
const CREATED_SESSION_ID = 'ses_initial';

type SpawnResult = {
  server: { url: string; close: () => void };
  client: unknown;
};

type FakeClient = WrapperKiloClient & {
  readonly getSessionCalls: string[];
  readonly createSessionCalls: string[];
};

type VerifyCall = {
  client: WrapperKiloClient;
  expectedSessionId: string;
  runtime: 'reused' | 'new';
  workspacePath: string;
};

type StartedCall = {
  client: WrapperKiloClient;
  workspacePath: string;
  kiloSessionId: string;
};

function snapshotEnv(env: NodeJS.Dict<string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}

function makeFakeClient(): FakeClient {
  const getSessionCalls: string[] = [];
  const createSessionCalls: string[] = [];
  const base = {
    serverUrl: 'http://127.0.0.1:0',
    getSession: async (sessionId: string) => {
      getSessionCalls.push(sessionId);
      return { id: sessionId };
    },
    createSession: async () => {
      const id = `ses_created_${createSessionCalls.length + 1}`;
      createSessionCalls.push(id);
      return { id };
    },
  };
  return Object.assign(base, { getSessionCalls, createSessionCalls }) as unknown as FakeClient;
}

function createHarness(
  options: {
    autoSpawn?: boolean;
    env?: NodeJS.Dict<string>;
    platform?: string;
    initialSessionId?: string;
    rejectVerifications?: number;
  } = {}
) {
  const captureEnvRecord: NodeJS.Dict<string> = {
    HOME: '/home/test',
    ...(options.env ?? { KILOCODE_TOKEN: 'A' }),
  };
  const inheritedEnvs: Record<string, string>[] = [];
  const logs: string[] = [];
  const events: string[] = [];
  const verifyCalls: VerifyCall[] = [];
  const started: StartedCall[] = [];
  const clients: FakeClient[] = [];
  const pendingSpawns: Array<{
    resolve: (result: SpawnResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  let spawnBehavior: 'auto' | 'manual' | 'reject' = options.autoSpawn === false ? 'manual' : 'auto';
  let rejectNewVerifications = options.rejectVerifications ?? 0;
  let readyCount = 0;
  let teardownCount = 0;
  let kiloSessionId = options.initialSessionId ?? CREATED_SESSION_ID;

  function makeSpawnResult(): SpawnResult {
    const client = makeFakeClient();
    clients.push(client);
    return {
      server: {
        url: `http://127.0.0.1:${4000 + clients.length}`,
        close: () => {
          events.push('closeServer');
        },
      },
      client,
    };
  }

  function createKilo(): Promise<SpawnResult> {
    inheritedEnvs.push(snapshotEnv(captureEnvRecord));
    events.push(`spawn:${inheritedEnvs.length - 1}`);
    const deferred = Promise.withResolvers<SpawnResult>();
    pendingSpawns.push(deferred);
    const behavior = spawnBehavior;
    if (behavior === 'reject') {
      spawnBehavior = 'auto';
      queueMicrotask(() => deferred.reject(new Error('spawn failed')));
    } else if (behavior === 'auto') {
      queueMicrotask(() => deferred.resolve(makeSpawnResult()));
    }
    return deferred.promise;
  }

  const lifecycle: KiloRuntimeLifecycle = createKiloRuntimeLifecycle({
    createKilo,
    bindClient: result => result.client as FakeClient,
    captureEnv: () => captureEnvRecord,
    getPlatform: () => options.platform,
    log: message => {
      logs.push(message);
      events.push(`log:${message}`);
    },
    chdir: () => {
      events.push('chdir');
    },
    assignProcessEnv: env => {
      Object.assign(captureEnvRecord, env);
    },
    isShuttingDown: () => false,
    getKiloSessionId: () => kiloSessionId,
    applyKiloSessionId: sessionId => {
      kiloSessionId = sessionId;
    },
    verifyExistingKiloSession: async (client, expectedSessionId, runtime, workspacePath) => {
      verifyCalls.push({ client, expectedSessionId, runtime, workspacePath });
      events.push(`verify:${runtime}`);
      if (runtime === 'new' && rejectNewVerifications > 0) {
        rejectNewVerifications -= 1;
        throw new Error('runtime session verification failed');
      }
      await client.getSession(expectedSessionId);
    },
    onBeforeSpawnTeardown: async () => {
      teardownCount += 1;
      events.push('teardown');
    },
    onRuntimeStarted: input => {
      started.push(input);
      events.push('started');
    },
    onRuntimeReady: () => {
      readyCount += 1;
      events.push('ready');
    },
    hasLifecycle: () => false,
    hasConnection: () => false,
    startupTimeoutMs: 30_000,
  });

  async function flush(): Promise<void> {
    for (let index = 0; index < 50; index++) await Promise.resolve();
  }

  async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return error;
    }
  }

  async function waitForSpawnCount(count: number): Promise<void> {
    for (let index = 0; index < 100 && pendingSpawns.length < count; index++) {
      await Promise.resolve();
    }
    if (pendingSpawns.length < count) {
      throw new Error(`Expected ${count} spawn requests, saw ${pendingSpawns.length}`);
    }
  }

  return {
    lifecycle,
    captureEnvRecord,
    inheritedEnvs,
    logs,
    events,
    verifyCalls,
    started,
    clients,
    pendingSpawns,
    flush,
    captureRejection,
    waitForSpawnCount,
    resolveSpawn: (index: number) => {
      pendingSpawns[index]?.resolve(makeSpawnResult());
    },
    rejectSpawn: (index: number, error: unknown) => {
      pendingSpawns[index]?.reject(error);
    },
    setSpawnBehavior: (behavior: 'auto' | 'manual' | 'reject') => {
      spawnBehavior = behavior;
    },
    failNextVerification: () => {
      rejectNewVerifications = 1;
    },
    get readyCount() {
      return readyCount;
    },
    get teardownCount() {
      return teardownCount;
    },
    getKiloSessionId: () => kiloSessionId,
  };
}

describe('KiloRuntimeLifecycle start', () => {
  it('spawns once on the first start and records the inherited environment', async () => {
    const harness = createHarness();
    await harness.lifecycle.start({
      workspacePath: WORKSPACE,
      expectedSessionId: CREATED_SESSION_ID,
    });

    expect(harness.inheritedEnvs).toHaveLength(1);
    expect(harness.inheritedEnvs[0]).toEqual({
      HOME: '/home/test',
      KILOCODE_TOKEN: 'A',
    });
    expect(harness.started).toHaveLength(1);
    expect(harness.lifecycle.kiloClient).toBeDefined();
    expect(harness.lifecycle.runtimeWorkspacePath).toBe(WORKSPACE);
  });

  it('reuses the live child when the delivered credential changed', async () => {
    const harness = createHarness();
    const start: KiloRuntimeStartInput = {
      workspacePath: WORKSPACE,
      expectedSessionId: CREATED_SESSION_ID,
    };

    await harness.lifecycle.start(start);
    harness.captureEnvRecord.KILOCODE_TOKEN = 'B';
    await harness.lifecycle.start(start);

    expect(harness.inheritedEnvs).toHaveLength(1);
    expect(harness.inheritedEnvs[0]).toEqual({
      HOME: '/home/test',
      KILOCODE_TOKEN: 'A',
    });
    expect(
      harness.logs.some(line => line.includes('reused existing runtime without session rebinding'))
    ).toBe(true);
    expect(harness.readyCount).toBe(2);
  });

  it('reuses the child when the delivered credential is identical', async () => {
    const harness = createHarness();
    const start = () =>
      harness.lifecycle.start({
        workspacePath: WORKSPACE,
        expectedSessionId: CREATED_SESSION_ID,
      });

    await start();
    await start();

    expect(harness.inheritedEnvs).toHaveLength(1);
    expect(
      harness.logs.some(line => line.includes('reused existing runtime without session rebinding'))
    ).toBe(true);
    expect(harness.readyCount).toBe(2);
  });

  it('rebinds the reused session without respawning', async () => {
    const harness = createHarness();
    await harness.lifecycle.start({
      workspacePath: WORKSPACE,
      expectedSessionId: 'ses_old',
    });

    const client = harness.lifecycle.kiloClient;
    await harness.lifecycle.start({
      workspacePath: WORKSPACE,
      expectedSessionId: 'ses_new',
    });

    const reusedCalls = harness.verifyCalls.filter(call => call.runtime === 'reused');
    expect(reusedCalls).toHaveLength(1);
    expect(reusedCalls[0]).toMatchObject({
      client,
      expectedSessionId: 'ses_new',
      workspacePath: WORKSPACE,
    });
    expect(harness.getKiloSessionId()).toBe('ses_new');
    expect(harness.inheritedEnvs).toHaveLength(1);
    expect(harness.logs.some(line => line.includes('reused runtime session rebound'))).toBe(true);
  });

  it('verifies the original session on the restarted child without creating one', async () => {
    const harness = createHarness();
    await harness.lifecycle.start({
      workspacePath: WORKSPACE,
      expectedSessionId: CREATED_SESSION_ID,
    });

    await harness.lifecycle.start({
      workspacePath: WORKSPACE,
      expectedSessionId: CREATED_SESSION_ID,
      forceRestart: true,
    });

    expect(harness.clients).toHaveLength(2);
    expect(harness.clients[1]?.getSessionCalls).toEqual([CREATED_SESSION_ID]);
    expect(harness.clients[1]?.createSessionCalls).toEqual([]);
  });

  it('serializes overlapping starts so createKilo never overlaps', async () => {
    const harness = createHarness({ autoSpawn: false });
    const first = harness.lifecycle.start({
      workspacePath: WORKSPACE,
    });
    await harness.waitForSpawnCount(1);

    const second = harness.lifecycle.start({
      workspacePath: WORKSPACE,
      forceRestart: true,
    });
    await harness.flush();
    expect(harness.inheritedEnvs).toHaveLength(1);

    harness.resolveSpawn(0);
    await first;
    await harness.waitForSpawnCount(2);
    harness.resolveSpawn(1);
    await second;

    expect(harness.inheritedEnvs).toHaveLength(2);
  });
});

describe('KiloRuntimeLifecycle failures', () => {
  it('does not publish a client when createKilo fails', async () => {
    const harness = createHarness({ autoSpawn: false });
    const first = harness.lifecycle.start({
      workspacePath: WORKSPACE,
    });
    await harness.waitForSpawnCount(1);
    harness.rejectSpawn(0, new Error('spawn failed'));

    const spawnError = await harness.captureRejection(first);
    expect((spawnError as Error).message).toContain('Failed to start Kilo server');
    expect(harness.lifecycle.kiloClient).toBeUndefined();

    harness.setSpawnBehavior('auto');
    await harness.lifecycle.start({
      workspacePath: WORKSPACE,
    });

    expect(harness.inheritedEnvs).toHaveLength(2);
    expect(harness.lifecycle.kiloClient).toBeDefined();
  });

  it('does not publish a client when session verification fails, and reaps the orphan later', async () => {
    const harness = createHarness();
    harness.failNextVerification();

    const verificationError = await harness.captureRejection(
      harness.lifecycle.start({
        workspacePath: WORKSPACE,
        expectedSessionId: CREATED_SESSION_ID,
      })
    );
    expect((verificationError as Error).message).toContain('runtime session verification failed');
    expect(harness.lifecycle.kiloClient).toBeUndefined();

    await harness.lifecycle.start({
      workspacePath: WORKSPACE,
      expectedSessionId: CREATED_SESSION_ID,
    });

    expect(harness.inheritedEnvs).toHaveLength(2);
    expect(harness.events.filter(event => event === 'closeServer')).toHaveLength(1);
    expect(harness.lifecycle.kiloClient).toBeDefined();
  });
});

describe('KiloRuntimeLifecycle updateEnvironment', () => {
  it.each(['KILOCODE_TOKEN', 'GH_TOKEN'])(
    'restarts the devcontainer child with refreshed %s and retains its session',
    async name => {
      const harness = createHarness({ platform: 'devcontainer', env: { [name]: 'A' } });
      await harness.lifecycle.start({
        workspacePath: WORKSPACE,
        expectedSessionId: CREATED_SESSION_ID,
      });
      expect(harness.inheritedEnvs).toHaveLength(1);
      const readyBefore = harness.readyCount;
      const teardownBefore = harness.teardownCount;

      await harness.lifecycle.updateEnvironment({ [name]: 'B' });

      expect(harness.captureEnvRecord[name]).toBe('B');
      expect(harness.inheritedEnvs).toEqual([
        { HOME: '/home/test', [name]: 'A' },
        { HOME: '/home/test', [name]: 'B' },
      ]);
      expect(harness.events.filter(event => event === 'closeServer')).toHaveLength(1);
      expect(harness.clients[1]?.getSessionCalls).toEqual([CREATED_SESSION_ID]);
      expect(harness.clients[1]?.createSessionCalls).toEqual([]);
      expect(harness.getKiloSessionId()).toBe(CREATED_SESSION_ID);
      expect(harness.teardownCount).toBe(teardownBefore + 1);
      expect(harness.readyCount).toBe(readyBefore + 1);
    }
  );

  it('is silent for an identical environment update', async () => {
    const harness = createHarness();
    await harness.lifecycle.start({
      workspacePath: WORKSPACE,
    });
    const readyBefore = harness.readyCount;
    const teardownBefore = harness.teardownCount;

    await harness.lifecycle.updateEnvironment({ KILOCODE_TOKEN: 'A' });

    expect(harness.inheritedEnvs).toHaveLength(1);
    expect(harness.teardownCount).toBe(teardownBefore);
    expect(harness.readyCount).toBe(readyBefore);
  });

  it('starts from the last runtime workspace when no client exists', async () => {
    const harness = createHarness();
    await harness.lifecycle.start({
      workspacePath: WORKSPACE,
    });

    harness.setSpawnBehavior('reject');
    await harness.captureRejection(harness.lifecycle.restart());

    expect(harness.lifecycle.kiloClient).toBeUndefined();

    const spawnsBeforeUpdate = harness.inheritedEnvs.length;
    await harness.lifecycle.updateEnvironment({ KILOCODE_TOKEN: 'A' });

    expect(harness.inheritedEnvs).toHaveLength(spawnsBeforeUpdate + 1);
    const latestSpawnEnv = harness.inheritedEnvs[spawnsBeforeUpdate];
    expect(latestSpawnEnv?.KILOCODE_TOKEN).toBe('A');
  });

  it('returns without spawning when no runtime workspace is known', async () => {
    const harness = createHarness();
    await harness.lifecycle.updateEnvironment({ KILOCODE_TOKEN: 'A' });
    expect(harness.inheritedEnvs).toHaveLength(0);
  });
});

describe('KiloRuntimeLifecycle ordering', () => {
  it('tears down the previous runtime before closing its server', async () => {
    const harness = createHarness();
    await harness.lifecycle.start({
      workspacePath: WORKSPACE,
    });
    harness.events.length = 0;

    await harness.lifecycle.restart();

    const teardownIndex = harness.events.indexOf('teardown');
    const closeIndex = harness.events.indexOf('closeServer');
    expect(teardownIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(teardownIndex);
  });

  it('publishes the runtime before logging readiness and signals ready last', async () => {
    const harness = createHarness();
    await harness.lifecycle.start({
      workspacePath: WORKSPACE,
    });

    const startedIndex = harness.events.indexOf('started');
    const readyLogIndex = harness.events.findIndex(event =>
      event.includes('startKiloRuntime runtime ready')
    );
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(readyLogIndex).toBeGreaterThan(startedIndex);
    expect(harness.events.at(-1)).toBe('ready');
  });

  it('logs the injected platform rather than re-deriving it', async () => {
    const harness = createHarness({ platform: 'devcontainer' });
    await harness.lifecycle.start({
      workspacePath: WORKSPACE,
    });

    expect(
      harness.logs.some(
        line =>
          line.includes('startKiloRuntime runtime ready') && line.includes('platform=devcontainer')
      )
    ).toBe(true);
  });
});
