import { EventEmitter } from 'node:events';
import type { ServerOptions } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type ContainerChild = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal: string) => void;
};

const mocks = vi.hoisted(() => ({
  handler: undefined as undefined | ((req: unknown, res: unknown) => void),
  sigterm: undefined as undefined | (() => void),
  serverOptions: undefined as undefined | ServerOptions,
  spawn: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  close: vi.fn(),
  exit: vi.fn<typeof process.exit>(),
  kill: vi.fn<typeof process.kill>(),
  children: [] as ContainerChild[],
}));

vi.mock('node:http', () => ({
  createServer: (options: ServerOptions, handler: typeof mocks.handler) => {
    mocks.serverOptions = options;
    mocks.handler = handler;
    return { listen: vi.fn(), close: mocks.close };
  },
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: mocks.mkdtemp,
  rm: mocks.rm,
}));

function createChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  mocks.children.push(child);
  return child;
}

const runBody = {
  model: 'test-model',
  prompt: 'test prompt',
  kiloToken: 'test-benchmark-token',
  kiloApiUrl: 'https://example.test',
  orgId: 'test-org',
  variant: 'high',
};

type ContainerResponse = {
  status: number;
  body: {
    exitCode?: number;
    durationMs?: number;
    stderrTail?: string;
    timedOut?: boolean;
    error?: string;
  };
};

function request(
  url: string,
  body?: unknown,
  stream?: Readable,
  { autoFinish = true }: { autoFinish?: boolean } = {}
) {
  const req = Object.assign(
    stream ?? Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    { method: 'POST', url }
  );
  let status = 0;
  const res = Object.assign(new EventEmitter(), {
    writeHead: vi.fn((code: number) => {
      status = code;
    }),
    end: vi.fn((payload: string) => {
      res.emit('result', { status, body: JSON.parse(payload) });
      if (autoFinish) res.emit('finish');
    }),
  });
  const done = new Promise<ContainerResponse>(resolve => res.once('result', resolve));
  if (!mocks.handler) throw new Error('Container handler was not installed');
  mocks.handler(req, res);
  return { req, res, done };
}

async function loadServer() {
  const serverPath = '../container/server.mjs';
  // Each test imports fresh module state to exercise process startup and shutdown.
  await import(serverPath);
}

async function flushServer() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function stopServer() {
  if (!mocks.sigterm) throw new Error('SIGTERM handler was not installed');
  mocks.sigterm();
}

beforeEach(() => {
  vi.resetModules();
  mocks.handler = undefined;
  mocks.sigterm = undefined;
  mocks.serverOptions = undefined;
  mocks.children = [];
  mocks.spawn.mockReset().mockImplementation(createChild);
  mocks.mkdtemp.mockReset().mockResolvedValue('/tmp/benchmark-auth-test');
  mocks.rm.mockReset().mockResolvedValue(undefined);
  mocks.close.mockReset();
  mocks.exit.mockReset();
  vi.spyOn(process, 'exit').mockImplementation(mocks.exit);
  mocks.kill.mockReset().mockReturnValue(true);
  vi.spyOn(process, 'kill').mockImplementation(mocks.kill);
  const originalOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event === 'SIGTERM') {
      mocks.sigterm = listener;
      return process;
    }
    return originalOn(event, listener);
  });
});

afterEach(async () => {
  mocks.spawn.mockImplementation(() => {
    throw new Error('test cleanup');
  });
  for (const child of mocks.children) child.emit('close', 0);
  await flushServer();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('/run disables automatic ingest while preserving API/gateway authentication', async () => {
  await loadServer();
  const pending = request('/run', runBody);
  await flushServer();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(mocks.spawn.mock.calls[0][0]).toBe('kilo');
  expect(mocks.spawn.mock.calls[0][1]).toEqual([
    'run',
    '--format',
    'json',
    '--auto',
    '-m',
    'kilo/test-model',
    '--variant',
    'high',
    'test prompt',
  ]);
  const options = mocks.spawn.mock.calls[0][2];
  expect(options.env.KILO_DISABLE_SESSION_INGEST).toBe('1');
  expect(options.env.KILO_API_URL).toBe('https://example.test');
  expect(options.env.KILO_ORG_ID).toBe('test-org');
  expect(JSON.parse(options.env.KILO_AUTH_CONTENT)).toEqual({
    kilo: { type: 'api', key: 'test-benchmark-token', organizationId: 'test-org' },
  });
  mocks.children[0].emit('close', 0);
  expect((await pending.done).status).toBe(200);
});

it('/warmup only initializes the local database once, including concurrent callers', async () => {
  vi.stubEnv('KILO_AUTH_CONTENT', 'inherited-auth');
  vi.stubEnv('KILO_API_URL', 'https://inherited-provider.test');
  vi.stubEnv('KILO_ORG_ID', 'inherited-org');
  await loadServer();
  const first = request('/warmup', runBody);
  const second = request('/warmup');
  await flushServer();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(mocks.spawn.mock.calls[0][0]).toBe('kilo');
  expect(mocks.spawn.mock.calls[0][1]).toEqual(['db', 'path']);
  const { env } = mocks.spawn.mock.calls[0][2];
  expect(env.KILO_DISABLE_SESSION_INGEST).toBe('1');
  expect(env.KILO_AUTH_CONTENT).toBeUndefined();
  expect(env.KILO_API_URL).toBeUndefined();
  expect(env.KILO_ORG_ID).toBeUndefined();
  mocks.children[0].emit('close', 0);
  const result = await first.done;
  expect(result).toEqual({
    status: 200,
    body: { exitCode: 0, durationMs: expect.any(Number) },
  });
  expect(await second.done).toEqual(result);
  expect(await request('/warmup').done).toEqual(result);
  expect(mocks.spawn).toHaveBeenCalledOnce();
});

it('retries a failed database initialization instead of caching its failure', async () => {
  await loadServer();
  const first = request('/warmup');
  await flushServer();
  mocks.children[0].emit('close', 1);
  expect((await first.done).body.exitCode).toBe(1);
  const retry = request('/warmup');
  await flushServer();
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
  mocks.children[1].emit('close', 0);
  expect((await retry.done).body.exitCode).toBe(0);
  expect((await request('/warmup').done).body.exitCode).toBe(0);
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
});

it.each(['mkdtemp', 'spawn'] as const)(
  'settles a warmup %s rejection and lets the next request retry',
  async failure => {
    await loadServer();
    if (failure === 'mkdtemp') {
      mocks.mkdtemp.mockRejectedValueOnce(new Error('initialization failed'));
    } else {
      mocks.spawn.mockImplementationOnce(() => {
        throw new Error('initialization failed');
      });
    }
    expect(await request('/warmup').done).toEqual({
      status: 500,
      body: { error: 'initialization failed' },
    });
    if (failure === 'spawn') {
      expect(mocks.rm).toHaveBeenCalledWith('/tmp/benchmark-auth-test', {
        recursive: true,
        force: true,
      });
    }
    const retry = request('/warmup');
    await flushServer();
    expect(mocks.children).toHaveLength(1);
    mocks.children[0].emit('close', 0);
    expect((await retry.done).body.exitCode).toBe(0);
  }
);

it.each(['mkdtemp', 'spawn'] as const)(
  'settles a case %s rejection and refuses a queued case once shutdown begins',
  async failure => {
    await loadServer();
    if (failure === 'mkdtemp') {
      mocks.mkdtemp.mockRejectedValueOnce(new Error('case startup failed'));
    } else {
      mocks.spawn.mockImplementationOnce(() => {
        throw new Error('case startup failed');
      });
    }
    const first = request('/run', runBody);
    const second = request('/run', runBody);
    const third = request('/run', runBody);
    expect(await first.done).toEqual({
      status: 500,
      body: { error: 'case startup failed' },
    });
    await flushServer();
    expect(mocks.children).toHaveLength(1);
    stopServer();
    expect(mocks.exit).not.toHaveBeenCalled();
    mocks.children[0].emit('close', 0);
    expect((await second.done).body.exitCode).toBe(0);
    expect(await third.done).toEqual({ status: 503, body: { error: 'container is stopping' } });
    await flushServer();
    expect(mocks.children).toHaveLength(1);
    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
  }
);

it('settles an asynchronous spawn error once and redacts case authentication', async () => {
  await loadServer();
  const pending = request('/run', runBody);
  await flushServer();
  mocks.children[0].emit('error', new Error(`cannot spawn: ${runBody.kiloToken}`));
  mocks.children[0].emit('close', -1);
  expect(await pending.done).toMatchObject({
    status: 200,
    body: {
      exitCode: -1,
      stderrTail: '\nspawn error: cannot spawn: [redacted]',
      timedOut: false,
    },
  });
  expect(pending.res.end).toHaveBeenCalledOnce();
  expect(mocks.rm).toHaveBeenCalledOnce();
});

it('keeps local warmup and real cases in the same serialized CLI lane', async () => {
  await loadServer();
  const warmup = request('/warmup');
  const run = request('/run', runBody);
  await flushServer();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(mocks.spawn.mock.calls[0][1]).toEqual(['db', 'path']);
  mocks.children[0].emit('close', 0);
  await warmup.done;
  await flushServer();
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
  expect(mocks.spawn.mock.calls[1][1][0]).toBe('run');
  mocks.children[1].emit('close', 0);
  await run.done;
});

it('exits cleanly on idle SIGTERM without registering a real signal listener', async () => {
  const listeners = process.listeners('SIGTERM');
  await loadServer();
  expect(process.listeners('SIGTERM')).toEqual(listeners);
  stopServer();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(await request('/warmup').done).toEqual({
    status: 503,
    body: { error: 'container is stopping' },
  });
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('finishes the running case after SIGTERM and never starts a queued one', async () => {
  await loadServer();
  const first = request('/run', runBody);
  const second = request('/run', runBody);
  await flushServer();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  first.res.emit('close');
  second.res.emit('close');
  stopServer();
  expect(mocks.exit).not.toHaveBeenCalled();
  expect((await request('/run', runBody).done).status).toBe(503);
  expect((await request('/warmup').done).status).toBe(503);
  mocks.children[0].emit('close', 0);
  await first.done;
  expect((await second.done).status).toBe(503);
  await flushServer();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});

it('delivers rollout-orphaned outcomes to the worker before exiting', async () => {
  const delivered: unknown[] = [];
  let releaseDelivery = () => {};
  const deliveryGate = new Promise<void>(resolve => {
    releaseDelivery = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      delivered.push(JSON.parse(String(init.body)));
      await deliveryGate;
      return new Response(null, { status: 204 });
    })
  );
  const callback = (caseId: string) => ({
    url: 'https://bench.test/container/case-result',
    execution: { runId: 'run', model: 'm', variant: 'high', rep: 0, caseId, token: 't' },
  });
  await loadServer();
  const running = request('/run', { ...runBody, resultCallback: callback('running') });
  const queued = request('/run', { ...runBody, resultCallback: callback('queued') });
  await flushServer();
  running.res.emit('close');
  queued.res.emit('close');
  stopServer();
  mocks.children[0].stdout.emit(
    'data',
    Buffer.from('{"type":"text","part":{"text":"42","time":{"end":1}}}\n')
  );
  mocks.children[0].emit('close', 0);
  await running.done;
  await queued.done;
  await flushServer();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(delivered).toEqual([
    {
      execution: callback('running').execution,
      outcome: {
        kind: 'completed',
        response: {
          exitCode: 0,
          durationMs: expect.any(Number),
          stdoutLines: ['{"type":"text","part":{"text":"42","time":{"end":1}}}'],
          stderrTail: '',
          timedOut: false,
        },
      },
    },
    { execution: callback('queued').execution, outcome: { kind: 'not_started' } },
  ]);
  expect(mocks.exit).not.toHaveBeenCalled();
  releaseDelivery();
  await flushServer();
  await flushServer();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});

it('waits for the shared local warmup during SIGTERM', async () => {
  await loadServer();
  const first = request('/warmup');
  const second = request('/warmup');
  await flushServer();
  stopServer();
  expect(mocks.exit).not.toHaveBeenCalled();
  mocks.children[0].emit('close', 0);
  await Promise.all([first.done, second.done]);
  await flushServer();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});

it('finishes a late-body shutdown response before exiting with no CLI work', async () => {
  await loadServer();
  expect(mocks.serverOptions).toMatchObject({
    requestTimeout: 30_000,
    headersTimeout: 10_000,
    connectionsCheckingInterval: 1_000,
  });
  const stream = new Readable({ read() {} });
  const pending = request('/run', undefined, stream, { autoFinish: false });
  stopServer();
  expect(mocks.exit).not.toHaveBeenCalled();
  stream.push(Buffer.from(JSON.stringify(runBody)));
  stream.push(null);
  expect(await pending.done).toEqual({
    status: 503,
    body: { error: 'container is stopping' },
  });
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.exit).not.toHaveBeenCalled();
  pending.res.emit('finish');
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
  pending.res.emit('close');
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});

it('releases a disconnected HTTP request without waiting for its pending body', async () => {
  await loadServer();
  const stream = new Readable({ read() {} });
  const pending = request('/run', undefined, stream);
  stopServer();
  expect(mocks.exit).not.toHaveBeenCalled();
  pending.res.emit('close');
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
  stream.push(null);
  await pending.done;
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});

it('rejects a request whose body finishes after shutdown begins', async () => {
  await loadServer();
  const active = request('/run', runBody);
  await flushServer();
  const stream = new Readable({ read() {} });
  const pending = request('/run', undefined, stream);
  stopServer();
  stream.push(Buffer.from(JSON.stringify(runBody)));
  stream.push(null);
  expect((await pending.done).status).toBe(503);
  expect(mocks.spawn).toHaveBeenCalledOnce();
  mocks.children[0].emit('close', 0);
  await active.done;
  await flushServer();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});

it('keeps the case timeout and bounds shutdown if the child never closes its pipes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await loadServer();
  const pending = request('/run', runBody);
  await flushServer();
  stopServer();
  await vi.advanceTimersByTimeAsync(179_999);
  expect(mocks.kill).not.toHaveBeenCalled();
  expect(mocks.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.kill).toHaveBeenCalledExactlyOnceWith(-12345, 'SIGKILL');
  expect(mocks.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await pending.done).toMatchObject({
    status: 200,
    body: { exitCode: -1, timedOut: true },
  });
  await flushServer();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});
