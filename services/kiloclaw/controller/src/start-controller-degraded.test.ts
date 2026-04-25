import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

type HttpState = {
  requestHandler: ((req: unknown, res: unknown) => void) | null;
};

type DispatchResult = {
  status: number;
  body: string;
  headers: Record<string, string | number | readonly string[]>;
};

class MockServerResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string | number | readonly string[]> = {};
  body = '';

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ) {
    this.body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    callback();
  }
}

function createRequest(pathname: string, headers: Record<string, string> = {}): Readable {
  const req = new Readable({ read() {} }) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = 'GET';
  req.url = pathname;
  req.headers = { host: 'localhost:18789', ...headers };
  req.push(null);
  return req;
}

async function dispatch(
  httpState: HttpState,
  pathname: string,
  headers: Record<string, string> = {}
) {
  if (!httpState.requestHandler) {
    throw new Error('request handler was not initialized');
  }

  const req = createRequest(pathname, headers);
  const res = new MockServerResponse();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`request timeout for ${pathname}`)), 2000);
    res.on('finish', () => {
      clearTimeout(timer);
      resolve();
    });
    httpState.requestHandler?.(req, res);
  });

  return {
    status: res.statusCode,
    body: res.body,
    headers: res.headers,
  } satisfies DispatchResult;
}

type PipelockMock = {
  isPipelockEnabled?: (env: unknown) => boolean;
  ensurePipelockCa?: () => void;
  ensurePipelockCaBundle?: () => void;
  ensurePipelockConfig?: (env: unknown) => void;
  getOpenClawProxyEnv?: (env: unknown) => Record<string, string>;
  getPipelockChildEnv?: (env: unknown) => Record<string, string | undefined>;
  getPipelockSupervisorOptions?: (env: unknown) => { command: string; args: string[] } | null;
  waitForPipelockReady?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  waitForSupervisorAlive?: (supervisor: unknown, timeoutMs: number) => Promise<boolean>;
};

type SupervisorCreateOptions = {
  command?: string;
  args: string[];
  env?: Record<string, string | undefined>;
};

async function loadStartControllerWithMocks(options: {
  bootstrapCritical: () => Promise<void>;
  bootstrapNonCritical: () => Promise<{ ok: true } | { ok: false; phase: string; error: string }>;
  pipelock?: PipelockMock;
  /** Spied-on supervisor start callback. Every createSupervisor() in the
   *  SUT routes through this, so tests can count pipelock vs gateway starts. */
  supervisorStart?: () => Promise<void>;
}) {
  vi.resetModules();

  const httpState: HttpState = { requestHandler: null };
  const supervisorCreates: SupervisorCreateOptions[] = [];

  vi.doMock('node:http', () => {
    return {
      default: {
        createServer: (handler: (req: unknown, res: unknown) => void) => {
          httpState.requestHandler = handler;
          return {
            on: () => undefined,
            listen: (_port: number, _host: string, cb: () => void) => cb(),
            close: (cb: () => void) => cb(),
          };
        },
      },
    };
  });

  vi.doMock('./bootstrap', () => ({
    bootstrapCritical: options.bootstrapCritical,
    bootstrapNonCritical: options.bootstrapNonCritical,
  }));

  const start = options.supervisorStart ?? (async () => undefined);
  vi.doMock('./supervisor', () => ({
    createSupervisor: (supervisorOptions: SupervisorCreateOptions) => {
      supervisorCreates.push(supervisorOptions);
      return {
        getState: () => 'stopped',
        start,
        shutdown: async () => undefined,
        getStats: () => ({
          state: 'stopped',
          restartCount: 0,
        }),
        signalUsr1: () => false,
      };
    },
  }));

  vi.doMock('./pairing-cache', () => ({
    createPairingCache: () => ({
      onPairingLogLine: () => undefined,
      start: () => undefined,
      cleanup: () => undefined,
    }),
  }));

  if (options.pipelock) {
    const p = options.pipelock;
    vi.doMock('./pipelock', () => ({
      PIPELOCK_LISTEN_HOST: '127.0.0.1',
      PIPELOCK_LISTEN_PORT: 8888,
      isPipelockEnabled: p.isPipelockEnabled ?? (() => false),
      ensurePipelockCa:
        p.ensurePipelockCa ??
        (() => {
          /* no-op */
        }),
      ensurePipelockCaBundle:
        p.ensurePipelockCaBundle ??
        (() => {
          /* no-op */
        }),
      ensurePipelockConfig:
        p.ensurePipelockConfig ??
        (() => {
          /* no-op */
        }),
      getOpenClawProxyEnv: p.getOpenClawProxyEnv ?? (() => ({})),
      getPipelockChildEnv: p.getPipelockChildEnv ?? (() => ({ PATH: '/usr/bin' })),
      getPipelockSupervisorOptions:
        p.getPipelockSupervisorOptions ?? (() => ({ command: 'pipelock', args: ['run'] })),
      waitForPipelockReady: p.waitForPipelockReady ?? (async () => true),
      waitForSupervisorAlive: p.waitForSupervisorAlive ?? (async () => true),
    }));
  }

  vi.spyOn(process, 'on').mockImplementation(() => process);

  const mod = await import('./index');
  return { startController: mod.startController, httpState, supervisorCreates };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('startController degraded behavior', () => {
  it('keeps C&C routes available after non-critical bootstrap failure', async () => {
    const { startController, httpState } = await loadStartControllerWithMocks({
      bootstrapCritical: async () => undefined,
      bootstrapNonCritical: async () => ({
        ok: false,
        phase: 'doctor',
        error: 'doctor exited 1',
      }),
    });

    const env = {
      OPENCLAW_GATEWAY_TOKEN: 'test-token',
      KILOCLAW_HOOKS_TOKEN: 'test-hooks-token',
      KILOCLAW_GATEWAY_ARGS: '["--port","3001"]',
    } as unknown as NodeJS.ProcessEnv;

    await startController(env);

    const [health, filesTree, cliRunStatus, proxy] = await Promise.all([
      dispatch(httpState, '/_kilo/health'),
      dispatch(httpState, '/_kilo/files/tree', {
        authorization: 'Bearer test-token',
      }),
      dispatch(httpState, '/_kilo/cli-run/status', {
        authorization: 'Bearer test-token',
      }),
      dispatch(httpState, '/'),
    ]);

    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({
      status: 'ok',
      state: 'degraded',
      error: 'Startup failed during doctor',
    });
    expect(filesTree.status).toBe(200);
    expect(cliRunStatus.status).toBe(200);
    expect(proxy.status).toBe(503);
    expect(JSON.parse(proxy.body)).toEqual({ error: 'Gateway not ready' });
  });

  it('keeps inline-only health behavior when critical bootstrap fails', async () => {
    const bootstrapNonCritical = vi.fn(async () => ({ ok: true }) as const);
    const { startController, httpState } = await loadStartControllerWithMocks({
      bootstrapCritical: async () => {
        throw new Error('decrypt failed');
      },
      bootstrapNonCritical,
    });

    const env = {
      OPENCLAW_GATEWAY_TOKEN: 'test-token',
      KILOCLAW_HOOKS_TOKEN: 'test-hooks-token',
      KILOCLAW_GATEWAY_ARGS: '["--port","3001"]',
    } as unknown as NodeJS.ProcessEnv;

    await startController(env);

    const [health, filesTree] = await Promise.all([
      dispatch(httpState, '/_kilo/health'),
      dispatch(httpState, '/_kilo/files/tree', {
        authorization: 'Bearer test-token',
      }),
    ]);

    expect(bootstrapNonCritical).not.toHaveBeenCalled();
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({
      status: 'ok',
      state: 'degraded',
      error: 'Startup failed during bootstrap',
    });
    expect(filesTree.status).toBe(503);
    expect(JSON.parse(filesTree.body)).toEqual({ error: 'Service starting', state: 'degraded' });
  });
});

describe('startController pipelock integration', () => {
  const env = {
    OPENCLAW_GATEWAY_TOKEN: 'test-token',
    KILOCLAW_HOOKS_TOKEN: 'test-hooks-token',
    KILOCLAW_GATEWAY_ARGS: '["--port","3001"]',
    KILOCLAW_PIPELOCK_ENABLED: '1',
  } as unknown as NodeJS.ProcessEnv;

  it('does not invoke pipelock setup when the flag is unset (backward compat)', async () => {
    const ensureCaSpy = vi.fn();
    const ensureConfigSpy = vi.fn();
    const { startController, httpState } = await loadStartControllerWithMocks({
      bootstrapCritical: async () => undefined,
      bootstrapNonCritical: async () => ({ ok: true }) as const,
      pipelock: {
        isPipelockEnabled: () => false,
        ensurePipelockCa: ensureCaSpy,
        ensurePipelockConfig: ensureConfigSpy,
      },
    });

    const unsetEnv = {
      OPENCLAW_GATEWAY_TOKEN: 'test-token',
      KILOCLAW_HOOKS_TOKEN: 'test-hooks-token',
      KILOCLAW_GATEWAY_ARGS: '["--port","3001"]',
    } as unknown as NodeJS.ProcessEnv;

    await startController(unsetEnv);

    expect(ensureCaSpy).not.toHaveBeenCalled();
    expect(ensureConfigSpy).not.toHaveBeenCalled();

    const health = await dispatch(httpState, '/_kilo/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: 'ok', state: 'ready' });
  });

  it('degrades to pipelock-init when ensurePipelockCa throws, without starting OpenClaw', async () => {
    const supervisorStartSpy = vi.fn(async () => undefined);
    const { startController, httpState } = await loadStartControllerWithMocks({
      bootstrapCritical: async () => undefined,
      bootstrapNonCritical: async () => ({ ok: true }) as const,
      supervisorStart: supervisorStartSpy,
      pipelock: {
        isPipelockEnabled: () => true,
        ensurePipelockCa: () => {
          throw new Error('CA generation failed');
        },
      },
    });

    await startController(env);

    // Health response proves degraded state surfaced via the public error
    // label. OpenClaw's supervisor.start() must NOT have been called because
    // Phase 7 (pipelock) returned before Phase 8 (gateway start).
    const health = await dispatch(httpState, '/_kilo/health');
    expect(JSON.parse(health.body)).toEqual({
      status: 'ok',
      state: 'degraded',
      error: 'Startup failed during pipelock-init',
    });
    expect(supervisorStartSpy).not.toHaveBeenCalled();
  });

  it('degrades to pipelock-listen when the proxy never reports healthy', async () => {
    const supervisorStartSpy = vi.fn(async () => undefined);
    const { startController, httpState } = await loadStartControllerWithMocks({
      bootstrapCritical: async () => undefined,
      bootstrapNonCritical: async () => ({ ok: true }) as const,
      supervisorStart: supervisorStartSpy,
      pipelock: {
        isPipelockEnabled: () => true,
        waitForPipelockReady: async () => false,
      },
    });

    await startController(env);

    const health = await dispatch(httpState, '/_kilo/health');
    expect(JSON.parse(health.body)).toEqual({
      status: 'ok',
      state: 'degraded',
      error: 'Startup failed during pipelock-listen',
    });
    // Pipelock supervisor was started (1 call), but the OpenClaw supervisor
    // was not -- the Pipelock health timeout blocks Phase 8. Gateway start
    // would be call #2 if it happened.
    expect(supervisorStartSpy).toHaveBeenCalledTimes(1);
  });

  it('proceeds to ready when pipelock initializes cleanly', async () => {
    const supervisorStartSpy = vi.fn(async () => undefined);
    const { startController, httpState } = await loadStartControllerWithMocks({
      bootstrapCritical: async () => undefined,
      bootstrapNonCritical: async () => ({ ok: true }) as const,
      supervisorStart: supervisorStartSpy,
      pipelock: {
        isPipelockEnabled: () => true,
        waitForPipelockReady: async () => true,
      },
    });

    await startController(env);

    const health = await dispatch(httpState, '/_kilo/health');
    expect(JSON.parse(health.body)).toEqual({ status: 'ok', state: 'ready' });
    // Two supervisor.start() calls: pipelock first, then OpenClaw.
    expect(supervisorStartSpy).toHaveBeenCalledTimes(2);
  });

  it('injects proxy env only into the OpenClaw supervisor child, and a scrubbed allowlist into the Pipelock child', async () => {
    const { startController, supervisorCreates } = await loadStartControllerWithMocks({
      bootstrapCritical: async () => undefined,
      bootstrapNonCritical: async () => ({ ok: true }) as const,
      pipelock: {
        isPipelockEnabled: () => true,
        getOpenClawProxyEnv: () => ({
          HTTPS_PROXY: 'http://127.0.0.1:8888',
          NODE_EXTRA_CA_CERTS: '/root/.pipelock/ca.pem',
        }),
        // Mirror the real allowlist shape: PATH only, no secrets, no proxy.
        getPipelockChildEnv: () => ({ PATH: '/usr/local/bin:/usr/bin' }),
        waitForPipelockReady: async () => true,
      },
    });

    await startController(env);

    expect(supervisorCreates).toHaveLength(2);

    // OpenClaw (gateway) supervisor: gets proxy env injection.
    expect(supervisorCreates[0].command).toBeUndefined();
    expect(supervisorCreates[0].args[0]).toBe('gateway');
    expect(supervisorCreates[0].env?.HTTPS_PROXY).toBe('http://127.0.0.1:8888');
    expect(supervisorCreates[0].env?.NODE_EXTRA_CA_CERTS).toBe('/root/.pipelock/ca.pem');

    // Pipelock supervisor: gets the scrubbed allowlist env, NEVER agent
    // secrets and NEVER proxy env (would recurse). This is the capability
    // separation invariant — protect at all costs.
    expect(supervisorCreates[1].command).toBe('pipelock');
    expect(supervisorCreates[1].args).toEqual(['run']);
    expect(supervisorCreates[1].env).toBeDefined();
    expect(supervisorCreates[1].env?.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(supervisorCreates[1].env?.HTTPS_PROXY).toBeUndefined();
    expect(supervisorCreates[1].env?.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(supervisorCreates[1].env?.KILOCODE_API_KEY).toBeUndefined();
    expect(supervisorCreates[1].env?.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
  });

  it('degrades to pipelock-start when the supervisor child fails to spawn (binary missing)', async () => {
    const supervisorStartSpy = vi.fn(async () => undefined);
    const { startController, httpState, supervisorCreates } = await loadStartControllerWithMocks({
      bootstrapCritical: async () => undefined,
      bootstrapNonCritical: async () => ({ ok: true }) as const,
      supervisorStart: supervisorStartSpy,
      pipelock: {
        isPipelockEnabled: () => true,
        // supervisor.start() resolves before the kernel reports ENOENT via
        // the asynchronous 'error' event. waitForSupervisorAlive observes
        // the state machine flip to 'crashed' and surfaces it as a fast
        // pipelock-start label instead of a 30s pipelock-listen wait.
        waitForSupervisorAlive: async () => false,
      },
    });

    await startController(env);

    const health = await dispatch(httpState, '/_kilo/health');
    expect(JSON.parse(health.body)).toEqual({
      status: 'ok',
      state: 'degraded',
      error: 'Startup failed during pipelock-start',
    });

    // Both supervisors are created (gateway in Phase 4, pipelock in Phase 7).
    // Pipelock.start() runs but its spawn fails. Critically, OpenClaw's
    // supervisor.start() must NOT have been invoked: pipelock-start short-
    // circuits Phase 8 before the gateway is ever told to run.
    expect(supervisorCreates).toHaveLength(2);
    expect(supervisorCreates[1].command).toBe('pipelock');
    // Pipelock attempted start, gateway did not. The shutdown call from the
    // failure path also routes through this spy, which is harmless: we count
    // start() invocations specifically.
    expect(supervisorStartSpy).toHaveBeenCalledTimes(1);
  });
});
