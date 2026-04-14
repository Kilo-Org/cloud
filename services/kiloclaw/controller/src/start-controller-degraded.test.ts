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

async function loadStartControllerWithMocks(options: {
  bootstrapCritical: () => Promise<void>;
  bootstrapNonCritical: () => Promise<{ ok: true } | { ok: false; phase: string; error: string }>;
}) {
  vi.resetModules();

  const httpState: HttpState = { requestHandler: null };

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

  vi.doMock('./supervisor', () => ({
    createSupervisor: () => ({
      getState: () => 'stopped',
      start: async () => undefined,
      shutdown: async () => undefined,
      getStats: () => ({
        state: 'stopped',
        restartCount: 0,
      }),
      signalUsr1: () => false,
    }),
  }));

  vi.doMock('./pairing-cache', () => ({
    createPairingCache: () => ({
      onPairingLogLine: () => undefined,
      start: () => undefined,
      cleanup: () => undefined,
    }),
  }));

  vi.spyOn(process, 'on').mockImplementation(() => process);

  const mod = await import('./index');
  return { startController: mod.startController, httpState };
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
