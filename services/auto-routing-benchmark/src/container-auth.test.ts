import { EventEmitter } from 'node:events';
import type { ServerOptions } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deciderCliPrompt } from './cli-runner';
import { DECIDER_CASES, FRONTIER_CASES } from './datasets/decider-cases';

type ContainerChild = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { on: (event: string, listener: () => void) => void; end: (data: string) => void };
  kill: (signal: string) => void;
};

const mocks = vi.hoisted(() => ({
  handler: undefined as undefined | ((req: unknown, res: unknown) => void),
  // The case-inference reverse proxy starts its own server; tests drive it directly.
  proxyHandler: undefined as undefined | ((req: unknown, res: unknown) => void),
  proxyPort: 0,
  listen: vi.fn(),
  sigterm: undefined as undefined | (() => void),
  serverOptions: undefined as undefined | ServerOptions,
  spawn: vi.fn(),
  mkdtemp: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rm: vi.fn(),
  close: vi.fn(),
  exit: vi.fn<typeof process.exit>(),
  kill: vi.fn<typeof process.kill>(),
  children: [] as ContainerChild[],
}));

vi.mock('node:http', () => ({
  createServer: (
    optionsOrHandler: ServerOptions | ((req: unknown, res: unknown) => void),
    maybeHandler?: (req: unknown, res: unknown) => void
  ) => {
    // The runner's own server passes (options, handler); the case-inference proxy passes
    // only a handler and asks the OS for a port.
    if (typeof optionsOrHandler === 'function') {
      mocks.proxyHandler = optionsOrHandler;
      return {
        listen: (_port: number, _host: string, ready: () => void) => {
          mocks.proxyPort = 41000;
          ready();
        },
        address: () => ({ port: mocks.proxyPort }),
        once: vi.fn(),
        close: mocks.close,
      };
    }
    mocks.serverOptions = optionsOrHandler;
    mocks.handler = maybeHandler;
    return { listen: vi.fn(), close: mocks.close };
  },
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: mocks.mkdtemp,
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  rm: mocks.rm,
}));

function createChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { on: vi.fn(), end: vi.fn() },
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

const resultCallback = {
  url: 'https://bench.test/container/case-result',
  execution: {
    runId: 'test-run',
    model: runBody.model,
    variant: runBody.variant,
    rep: 0,
    caseId: 'test-case',
    token: 'test-claim-token',
  },
};

const caseContext = {
  runId: resultCallback.execution.runId,
  model: resultCallback.execution.model,
  variant: resultCallback.execution.variant,
  rep: resultCallback.execution.rep,
  caseId: resultCallback.execution.caseId,
  attemptStartedAt: null,
  retried: false,
};

type ContainerResponse = {
  status: number;
  body: {
    exitCode?: number;
    durationMs?: number;
    stderrTail?: string;
    timedOut?: boolean;
    error?: string;
    stop?: { reason: string; status: number };
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
    destroy: vi.fn((): void => {
      res.emit('close');
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

// Drives the case-inference reverse proxy the container started for a running case.
function proxyRequest(method: string, url: string, body?: string) {
  if (!mocks.proxyHandler) throw new Error('proxy server was not started');
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
    method,
    url,
    headers: {},
  });
  let status = 0;
  const chunks: Buffer[] = [];
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writeHead: vi.fn((code: number) => {
      status = code;
      res.headersSent = true;
    }),
    write: vi.fn((chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      return true;
    }),
    end: vi.fn((payload?: string) => {
      if (typeof payload === 'string' && payload.length > 0) chunks.push(Buffer.from(payload));
      res.emit('result', { status, body: Buffer.concat(chunks).toString('utf8') });
    }),
    destroy: vi.fn(),
  });
  const done = Promise.withResolvers<{ status: number; body: string }>();
  res.once('result', (value: { status: number; body: string }) => done.resolve(value));
  mocks.proxyHandler(req, res);
  return done.promise;
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
  mocks.proxyHandler = undefined;
  mocks.proxyPort = 0;
  mocks.sigterm = undefined;
  mocks.serverOptions = undefined;
  mocks.children = [];
  mocks.spawn.mockReset().mockImplementation(createChild);
  mocks.mkdtemp.mockReset().mockResolvedValue('/tmp/benchmark-auth-test');
  mocks.mkdir.mockReset().mockResolvedValue(undefined);
  mocks.writeFile.mockReset().mockResolvedValue(undefined);
  mocks.rm.mockReset().mockResolvedValue(undefined);
  mocks.close.mockReset();
  mocks.exit.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('/run sends the prompt on stdin and disables automatic ingest while preserving authentication', async () => {
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
  ]);
  const options = mocks.spawn.mock.calls[0][2];
  expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  expect(mocks.children[0].stdin.end).toHaveBeenCalledWith('test prompt');
  expect(options.env.KILO_DISABLE_SESSION_INGEST).toBe('1');
  expect(options.env.KILO_API_URL).toBe('https://example.test');
  expect(options.env.KILO_ORG_ID).toBe('test-org');
  expect(JSON.parse(options.env.KILO_AUTH_CONTENT)).toEqual({
    kilo: { type: 'api', key: 'test-benchmark-token', organizationId: 'test-org' },
  });
  mocks.children[0].emit('close', 0);
  expect((await pending.done).status).toBe(200);
});

it.each([
  ['an ordinary case keeps the inherited working directory', {}, '/app'],
  ['an isolated case runs in its own workspace', { isolated: true }, '/tmp/benchmark-auth-test'],
])('/run: %s', async (_kind, isolation, pwd) => {
  vi.stubEnv('PWD', '/app');
  await loadServer();
  const pending = request('/run', { ...runBody, ...isolation });
  await flushServer();
  const options = mocks.spawn.mock.calls[0][2];
  expect(options.cwd).toBe('/tmp/benchmark-auth-test');
  expect(options.env.PWD).toBe(pwd);
  mocks.children[0].emit('close', 0);
  expect((await pending.done).status).toBe(200);
});

it('/run rejects a non-boolean isolation flag', async () => {
  await loadServer();
  expect(await request('/run', { ...runBody, isolated: 'yes' }).done).toEqual({
    status: 400,
    body: { error: 'isolated must be a boolean when provided' },
  });
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it.each([
  [
    'an ordinary case with spaces and quotes',
    DECIDER_CASES.find(c => !c.longContext && c.userPrompt.includes('"')),
  ],
  ['a long-context case over 128 KiB', FRONTIER_CASES.find(c => c.longContext)],
])('/run passes %s to the CLI byte for byte on stdin', async (_kind, benchCase) => {
  if (!benchCase) throw new Error('dataset needs the case');
  const prompt = deciderCliPrompt(benchCase);
  if (benchCase.longContext) expect(Buffer.byteLength(prompt)).toBeGreaterThan(128 * 1024);
  else expect(prompt).toMatch(/ .*"/s);
  await loadServer();
  const pending = request('/run', { ...runBody, prompt });
  await flushServer();
  const child = mocks.children[0];
  if (!child) throw new Error('CLI was not spawned');
  expect(child.stdin.end).toHaveBeenCalledExactlyOnceWith(prompt);
  expect(mocks.spawn.mock.calls[0][1]).not.toContain(prompt);
  child.emit('close', 0);
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
  const { env, stdio } = mocks.spawn.mock.calls[0][2];
  expect(stdio).toEqual(['ignore', 'pipe', 'pipe']);
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
      delivered.push(JSON.parse(init.body as string));
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
  await flushServer();
  expect(running.res.end).not.toHaveBeenCalled();
  expect(queued.res.end).not.toHaveBeenCalled();
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
  await Promise.all([running.done, queued.done]);
  await flushServer();
  await flushServer();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});

it('persists completed output before answering a connected caller', async () => {
  let acknowledge = () => {};
  const acknowledgement = new Promise<void>(resolve => {
    acknowledge = resolve;
  });
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    await acknowledgement;
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fetch);
  await loadServer();
  const pending = request('/run', { ...runBody, resultCallback });
  await flushServer();
  mocks.children[0].emit('close', 0);
  await flushServer();
  expect(fetch).toHaveBeenCalledOnce();
  expect(pending.res.end).not.toHaveBeenCalled();
  expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toMatchObject({
    execution: resultCallback.execution,
    outcome: { kind: 'completed', response: { exitCode: 0 } },
  });
  acknowledge();
  expect((await pending.done).status).toBe(200);
  pending.res.emit('close');
  await flushServer();
  expect(fetch).toHaveBeenCalledOnce();
  expect(console.log).toHaveBeenCalledWith(
    JSON.stringify({
      event: 'benchmark_container_case_accepted',
      ...caseContext,
      outcome: 'pending',
      category: 'queued',
    })
  );
  expect(console.log).toHaveBeenCalledWith(
    JSON.stringify({
      event: 'benchmark_container_case_started',
      ...caseContext,
      outcome: 'running',
      category: 'spawned',
    })
  );
  expect(console.log).toHaveBeenCalledWith(
    JSON.stringify({
      event: 'benchmark_container_case_settled',
      ...caseContext,
      outcome: 'completed',
      category: 'success',
    })
  );
  expect(console.log).toHaveBeenCalledWith(
    JSON.stringify({
      event: 'benchmark_container_result_delivered',
      ...caseContext,
      attempt: 1,
      outcome: 'completed',
      category: 'accepted',
    })
  );
  expect(mocks.spawn).toHaveBeenCalledOnce();
  stopServer();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});

it.each(['close', 'error', 'throw'] as const)(
  'delivers completed output despite response %s without another inference',
  async failure => {
    let acknowledge = () => {};
    const acknowledgement = new Promise<void>(resolve => {
      acknowledge = resolve;
    });
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
      await acknowledgement;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetch);
    await loadServer();
    const pending = request('/run', { ...runBody, resultCallback }, undefined, {
      autoFinish: false,
    });
    const end = pending.res.end.getMockImplementation();
    if (!end) throw new Error('Response writer was not installed');
    if (failure === 'throw') {
      pending.res.end.mockImplementationOnce(payload => {
        end(payload);
        throw new Error('response write failed');
      });
    } else {
      pending.res.emit(failure, new Error('response disconnected'));
    }
    await flushServer();
    mocks.children[0].emit('close', 0);
    await flushServer();
    expect(pending.res.end).not.toHaveBeenCalled();
    await flushServer();
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toMatchObject({
      execution: resultCallback.execution,
      outcome: { kind: 'completed', response: { exitCode: 0 } },
    });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    stopServer();
    expect(mocks.exit).not.toHaveBeenCalled();
    acknowledge();
    expect((await pending.done).status).toBe(200);
    await flushServer();
    expect(pending.res.end).toHaveBeenCalledOnce();
    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
  }
);

it('drains an in-flight callback before answering and exiting on shutdown', async () => {
  let acknowledge = () => {};
  const acknowledgement = new Promise<void>(resolve => {
    acknowledge = resolve;
  });
  const fetch = vi.fn(async () => {
    await acknowledgement;
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fetch);
  await loadServer();
  const pending = request('/run', { ...runBody, resultCallback }, undefined, {
    autoFinish: false,
  });
  await flushServer();
  mocks.children[0].emit('close', 0);
  await flushServer();
  expect(pending.res.end).not.toHaveBeenCalled();
  stopServer();
  expect(fetch).toHaveBeenCalledOnce();
  expect(mocks.exit).not.toHaveBeenCalled();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  acknowledge();
  await pending.done;
  expect(mocks.exit).not.toHaveBeenCalled();
  pending.res.emit('finish');
  await flushServer();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(mocks.spawn).toHaveBeenCalledOnce();
});

it('bounds response completion after persisting output without blocking shutdown', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  await loadServer();
  const pending = request('/run', { ...runBody, resultCallback }, undefined, { autoFinish: false });
  await flushServer();
  mocks.children[0].emit('close', 0);
  await pending.done;
  await flushServer();
  stopServer();
  expect(mocks.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(pending.res.destroy).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});

it.each(['http_error', 'network_error', 'timeout'] as const)(
  'answers after a transient callback %s and keeps delivering without rerunning the CLI',
  async category => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => {
        if (category === 'http_error') return new Response(null, { status: 503 });
        throw Object.assign(new Error('callback unavailable'), {
          name: category === 'timeout' ? 'TimeoutError' : 'TypeError',
        });
      })
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    await loadServer();
    const pending = request('/run', { ...runBody, resultCallback });
    await flushServer();
    mocks.children[0].emit('close', 0);
    await flushServer();
    expect(fetch).toHaveBeenCalledOnce();
    expect((await pending.done).status).toBe(200);
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'benchmark_container_result_delivery_failed',
        ...caseContext,
        attempt: 1,
        outcome: 'completed',
        category,
      })
    );
    stopServer();
    expect(mocks.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'benchmark_container_result_delivery_attempt',
        ...caseContext,
        attempt: 2,
        outcome: 'completed',
        category: 'pending',
      })
    );
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'benchmark_container_result_delivered',
        ...caseContext,
        attempt: 2,
        outcome: 'completed',
        category: 'accepted',
      })
    );
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
  }
);

it.each(['http_error', 'network_error', 'timeout'] as const)(
  'retries callback %s delivery for about five minutes and logs safe execution correlation',
  async category => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const privateValues = [
      runBody.kiloToken,
      runBody.prompt,
      resultCallback.url,
      resultCallback.execution.token,
      'private model output',
      'private raw stderr',
    ];
    const privateDetail = privateValues.join(' ');
    const fetch = vi.fn(async () => {
      if (category === 'http_error') return new Response(privateDetail, { status: 503 });
      throw Object.assign(new Error(privateDetail), {
        name: category === 'timeout' ? 'TimeoutError' : 'TypeError',
      });
    });
    vi.stubGlobal('fetch', fetch);
    await loadServer();
    const pending = request('/run', { ...runBody, resultCallback });
    await flushServer();
    mocks.children[0].stdout.emit('data', Buffer.from(`${privateDetail}\n`));
    mocks.children[0].stderr.emit('data', Buffer.from(privateDetail));
    mocks.children[0].emit('close', 0);
    await flushServer();
    stopServer();
    expect(fetch).toHaveBeenCalledOnce();
    expect((await pending.done).status).toBe(200);
    const retryDelaysMs = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 45_000, 60_000, 60_000];
    for (const [index, delayMs] of retryDelaysMs.entries()) {
      expect(mocks.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(fetch).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(index + 2);
    }
    expect(timeout).toHaveBeenCalledTimes(10);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: 'benchmark_container_result_delivery_exhausted',
        ...caseContext,
        category,
        outcome: 'completed',
        attempt: 10,
        attempts: 10,
      })
    );
    const logged = [...vi.mocked(console.log).mock.calls, ...error.mock.calls].flat().join('\n');
    for (const value of privateValues) expect(logged).not.toContain(value);
    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(mocks.spawn).toHaveBeenCalledOnce();
  }
);

it('stops callback retries on a stale execution without reporting exhaustion', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  await loadServer();
  const pending = request('/run', { ...runBody, resultCallback });
  await flushServer();
  pending.res.emit('close');
  mocks.children[0].emit('close', 0);
  await pending.done;
  await flushServer();
  expect(fetch).toHaveBeenCalledOnce();
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({
      event: 'benchmark_container_result_rejected',
      ...caseContext,
      attempt: 1,
      outcome: 'completed',
      category: 'not_found',
    })
  );
  expect(error).not.toHaveBeenCalled();
  stopServer();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(mocks.spawn).toHaveBeenCalledOnce();
});

it.each(['mkdtemp', 'spawn'] as const)(
  'persists not_started proof for a %s failure before returning its error',
  async failure => {
    let acknowledge = () => {};
    const acknowledgement = new Promise<void>(resolve => {
      acknowledge = resolve;
    });
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
      await acknowledgement;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetch);
    if (failure === 'mkdtemp') {
      mocks.mkdtemp.mockRejectedValueOnce(new Error('case startup failed'));
    } else {
      mocks.spawn.mockImplementationOnce(() => {
        throw new Error('case startup failed');
      });
    }
    await loadServer();
    const pending = request('/run', { ...runBody, resultCallback });
    await flushServer();
    expect(pending.res.end).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({
      execution: resultCallback.execution,
      outcome: { kind: 'not_started' },
    });
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'benchmark_container_case_settled',
        ...caseContext,
        outcome: 'not_started',
        category: failure === 'mkdtemp' ? 'workspace_error' : 'spawn_error',
      })
    );
    expect(mocks.children).toHaveLength(0);
    acknowledge();
    expect(await pending.done).toEqual({
      status: 500,
      body: { error: 'case startup failed' },
    });
    await flushServer();
    stopServer();
    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
  }
);

it('never reports a failure after the case started as not_started', async () => {
  const delivered: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      delivered.push(JSON.parse(init.body as string));
      return new Response(null, { status: 204 });
    })
  );
  await loadServer();
  mocks.spawn.mockImplementationOnce(() => {
    const child = createChild();
    return Object.defineProperty(child, 'stdout', {
      value: {
        on: () => {
          throw new Error('pipe unavailable');
        },
      },
    });
  });
  const pending = request('/run', {
    ...runBody,
    resultCallback: {
      url: 'https://bench.test/container/case-result',
      execution: { runId: 'run', model: 'm', variant: 'high', rep: 0, caseId: 'lost', token: 't' },
    },
  });
  pending.res.emit('close');
  await flushServer();
  expect(await pending.done).toMatchObject({ status: 500, body: { error: 'pipe unavailable' } });
  await flushServer();
  expect(delivered).toEqual([]);
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

it('persists not_started proof when an accepted request body arrives during shutdown', async () => {
  let acknowledge = () => {};
  const acknowledgement = new Promise<void>(resolve => {
    acknowledge = resolve;
  });
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    await acknowledgement;
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fetch);
  await loadServer();
  const stream = new Readable({ read() {} });
  const pending = request('/run', undefined, stream);
  stopServer();
  expect(mocks.exit).not.toHaveBeenCalled();
  stream.push(Buffer.from(JSON.stringify({ ...runBody, resultCallback })));
  stream.push(null);
  await flushServer();
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({
    execution: resultCallback.execution,
    outcome: { kind: 'not_started' },
  });
  expect(pending.res.end).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.exit).not.toHaveBeenCalled();
  acknowledge();
  expect(await pending.done).toEqual({
    status: 503,
    body: { error: 'container is stopping' },
  });
  await flushServer();
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

const PARTIAL_EVENT = '{"type":"text","part":{"text":"partial","time":{"end":1}}}';

function paidCallback(attemptStartedAt: number, caseId = resultCallback.execution.caseId) {
  return {
    ...resultCallback,
    execution: { ...resultCallback.execution, caseId, attemptStartedAt },
  };
}

function stubResultDelivery() {
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) => new Response(null, { status: 204 })
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('cancels the running paid case and keeps the output it already produced', async () => {
  const fetch = stubResultDelivery();
  await loadServer();
  const callback = paidCallback(1_000);
  const running = request('/run', { ...runBody, resultCallback: callback });
  await flushServer();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  mocks.children[0].stdout.emit('data', Buffer.from(`${PARTIAL_EVENT}\n`));

  expect(await request('/cancel', { execution: callback.execution }).done).toEqual({
    status: 200,
    body: { cancelled: true, state: 'killed' },
  });
  expect(mocks.kill).toHaveBeenCalledExactlyOnceWith(-12345, 'SIGKILL');
  expect(mocks.children[0].kill).not.toHaveBeenCalled();

  mocks.children[0].emit('close', -1);
  expect(await running.done).toEqual({
    status: 409,
    body: { error: 'case cancelled', cancelled: true },
  });
  expect(fetch).toHaveBeenCalledOnce();
  const delivered = JSON.parse(fetch.mock.calls[0][1].body as string);
  expect(delivered.execution).toEqual(callback.execution);
  expect(delivered.outcome).toMatchObject({
    kind: 'cancelled',
    spawned: true,
    response: { exitCode: -1, stdoutLines: [PARTIAL_EVENT], cancelled: true },
  });
});

it('never starts a case cancelled before it reached the CLI and leaves another generation alone', async () => {
  const fetch = stubResultDelivery();
  await loadServer();
  const runningCallback = paidCallback(1_000);
  const queuedCallback = paidCallback(1_001, 'queued-case');
  const running = request('/run', { ...runBody, resultCallback: runningCallback });
  const queued = request('/run', { ...runBody, resultCallback: queuedCallback });
  await flushServer();
  expect(mocks.spawn).toHaveBeenCalledOnce();

  // A stale generation of the running case's slot must not kill the new one.
  expect(
    await request('/cancel', {
      execution: { ...runningCallback.execution, attemptStartedAt: 999 },
    }).done
  ).toEqual({ status: 200, body: { cancelled: false, state: 'not_running' } });
  expect(mocks.kill).not.toHaveBeenCalled();

  expect(await request('/cancel', { execution: queuedCallback.execution }).done).toEqual({
    status: 200,
    body: { cancelled: true, state: 'dequeued' },
  });

  // The cancelled case still waits behind the running one; it settles without spawning.
  expect(mocks.spawn).toHaveBeenCalledOnce();
  mocks.children[0].emit('close', 0);
  expect((await running.done).status).toBe(200);
  expect(await queued.done).toEqual({
    status: 409,
    body: { error: 'case cancelled', cancelled: true },
  });
  expect(mocks.spawn).toHaveBeenCalledOnce();
  const delivered = new Map(
    fetch.mock.calls.map(([, init]) => {
      const body = JSON.parse(init.body as string);
      return [body.execution.caseId, body] as const;
    })
  );
  expect(delivered.get(queuedCallback.execution.caseId)).toEqual({
    execution: queuedCallback.execution,
    outcome: { kind: 'not_started' },
  });
  expect(delivered.get(runningCallback.execution.caseId)?.outcome.kind).toBe('completed');
});

it('refuses to start a generation whose cancel arrived first', async () => {
  const fetch = stubResultDelivery();
  await loadServer();
  const callback = paidCallback(2_000);

  expect(await request('/cancel', { execution: callback.execution }).done).toEqual({
    status: 200,
    body: { cancelled: false, state: 'not_running' },
  });
  expect(await request('/run', { ...runBody, resultCallback: callback }).done).toEqual({
    status: 409,
    body: { error: 'case cancelled', cancelled: true },
  });

  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({
    execution: callback.execution,
    outcome: { kind: 'not_started' },
  });
});

it('refuses a second subprocess for the same paid generation without reporting it', async () => {
  const fetch = stubResultDelivery();
  await loadServer();
  const callback = paidCallback(4_000);
  const first = request('/run', { ...runBody, resultCallback: callback });
  const duplicate = request('/run', { ...runBody, resultCallback: callback });
  await flushServer();
  expect(mocks.spawn).toHaveBeenCalledOnce();

  mocks.children[0].emit('close', 0);
  expect((await first.done).status).toBe(200);
  expect(await duplicate.done).toEqual({
    status: 409,
    body: { error: 'case already running', cancelled: true },
  });
  expect(mocks.spawn).toHaveBeenCalledOnce();
  // The duplicate must not report to the callback: a not_started report would clear the
  // ledger row of the call that is actually running.
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(fetch.mock.calls[0][1].body as string).outcome.kind).toBe('completed');
});

it('rejects a malformed inferenceProxy without consuming the generation', async () => {
  // The regression: validation used to run after `createCaseRunJob`, which registers the
  // generation in `activeCases`. The early return then left that entry behind with no
  // release, so the case looked active forever: every later cancel reported 'dequeued' and
  // a legitimate retry was refused as a duplicate. Nothing below may touch job state.
  await loadServer();
  const callback = paidCallback(4_000);

  const malformed = request('/run', {
    ...runBody,
    resultCallback: callback,
    inferenceProxy: { url: 'not a url', authorization: '', invocation: '' },
  });
  await flushServer();

  expect(await malformed.done).toEqual({
    status: 400,
    body: { error: 'inferenceProxy is malformed' },
  });
  // No subprocess started and nothing was reported for this generation.
  expect(mocks.spawn).not.toHaveBeenCalled();

  // The valid replay of the SAME generation must run, which is only possible if the failed
  // envelope left no active entry behind.
  mocks.spawn.mockClear();
  const valid = request('/run', { ...runBody, resultCallback: callback });
  await flushServer();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  mocks.children[0].emit('close', 0);
  expect((await valid.done).status).toBe(200);
});

it('leaves the generation cancellable after a malformed inferenceProxy', async () => {
  // The second half of the leak: a stranded `activeCases` entry with no `stop` made
  // `cancelCase` answer 'dequeued' for a case that never ran, so a pause looked applied
  // while nothing was there to stop.
  await loadServer();
  const callback = paidCallback(4_000);
  const malformed = request('/run', {
    ...runBody,
    resultCallback: callback,
    inferenceProxy: { url: 'not a url', authorization: '', invocation: '' },
  });
  await flushServer();
  await malformed.done;

  const cancel = request('/cancel', { execution: callback.execution });
  await flushServer();
  // Nothing of this generation was ever active, so the cancel is stale, not 'dequeued'.
  // With the leak, the stranded entry would have reported 'dequeued' here.
  expect(await cancel.done).toEqual({
    status: 200,
    body: { state: 'not_running', cancelled: false },
  });
});

it('refuses a cancel without the ledger generation', async () => {
  await loadServer();

  expect(await request('/cancel', { execution: resultCallback.execution }).done).toEqual({
    status: 400,
    body: {
      error: 'execution with runId, model, variant, rep, caseId and attemptStartedAt is required',
    },
  });
});

it('still cancels a running case while the container drains', async () => {
  const fetch = stubResultDelivery();
  await loadServer();
  const callback = paidCallback(3_000);
  const running = request('/run', { ...runBody, resultCallback: callback });
  await flushServer();
  stopServer();

  expect(await request('/cancel', { execution: callback.execution }).done).toEqual({
    status: 200,
    body: { cancelled: true, state: 'killed' },
  });
  mocks.children[0].emit('close', -1);
  // Nothing reached an event, but a child did spawn: the report is a terminal cancellation
  // marker, never not_started, so the worker cannot turn it into a fresh paid attempt.
  expect(await running.done).toEqual({
    status: 409,
    body: { error: 'case cancelled', cancelled: true },
  });
  expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({
    execution: callback.execution,
    outcome: { kind: 'cancelled', spawned: true },
  });
  await flushServer();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});

const caseInferenceProxy = {
  url: 'https://worker.test/case-inference',
  authorization: 'Bearer capability-token',
  invocation: Buffer.from(
    JSON.stringify({
      engineIdentity: 'engine-1',
      runId: 'test-run',
      model: 'test-model',
      variant: 'high',
      caseId: 'test-case',
      repetition: 0,
      generation: 3,
      startedAt: Date.now(),
    })
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, ''),
  invocationHeader: 'x-kilo-benchmark-case',
  catalog: { url: 'https://catalog.test', authorization: 'Bearer bot-token' },
};

it('sends inference to the worker case route with the capability and never the CLI token', async () => {
  const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await loadServer();
  const running = request('/run', { ...runBody, inferenceProxy: caseInferenceProxy });
  await flushServer();
  const env = mocks.spawn.mock.calls[0][2].env;
  expect(env.KILO_API_URL).toBe('http://127.0.0.1:41000');
  expect(JSON.parse(env.KILO_AUTH_CONTENT).kilo.key).toBe('benchmark-proxy');
  expect(env.KILO_AUTH_CONTENT).not.toContain(runBody.kiloToken);

  const inference = proxyRequest(
    'POST',
    '/api/gateway/v1/chat/completions',
    '{"model":"test-model"}'
  );
  await flushServer();
  const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
  expect(String(target)).toBe('https://worker.test/case-inference/chat/completions');
  expect(init.headers).toMatchObject({
    authorization: 'Bearer capability-token',
    'x-kilo-benchmark-case': caseInferenceProxy.invocation,
  });
  const modelRequestId = (init.headers as Record<string, string>)[
    'x-kilo-benchmark-model-request-id'
  ];
  expect(modelRequestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  expect(init.redirect).toBe('manual');
  expect(JSON.stringify(init.headers)).not.toContain('test-benchmark-token');

  expect(await inference).toEqual({ status: 200, body: '{}' });
  mocks.children[0].emit('close', 0);
  await running.done;
});

it('strips a CLI-supplied model request id and mints one per outbound call', async () => {
  const ids: string[] = [];
  const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
    ids.push((init.headers as Record<string, string>)['x-kilo-benchmark-model-request-id']);
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  await loadServer();
  const running = request('/run', { ...runBody, inferenceProxy: caseInferenceProxy });
  await flushServer();

  const cliSupplied = Object.assign(Readable.from([Buffer.from('{}')]), {
    method: 'POST',
    url: '/api/gateway/v1/responses',
    headers: { 'x-kilo-benchmark-model-request-id': '11111111-1111-4111-8111-111111111111' },
  });
  const first = Promise.withResolvers<{ status: number; body: string }>();
  // The proxy's own responder cannot set request headers, so drive its handler directly.
  mocks.proxyHandler?.(cliSupplied, {
    headersSent: false,
    writeHead: () => {},
    write: () => true,
    end: () => first.resolve({ status: 200, body: '' }),
    destroy: () => {},
    once: () => {},
    emit: () => {},
  });
  await first.promise;
  await flushServer();

  expect(ids[0]).not.toBe('11111111-1111-4111-8111-111111111111');
  expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  mocks.children[0].emit('close', 0);
  await running.done;
});

it('revokes only that case generation after an ambiguous transport failure', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('network lost'))
    .mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await loadServer();
  const first = request('/run', { ...runBody, inferenceProxy: caseInferenceProxy });
  await flushServer();

  expect(await proxyRequest('POST', '/api/gateway/v1/responses', '{}')).toEqual({
    status: 502,
    body: JSON.stringify({ error: 'benchmark upstream unreachable' }),
  });
  // The CLI retries the request itself; the next attempt must not open a second paid
  // attempt for the same case, so the proxy refuses it locally.
  expect(await proxyRequest('POST', '/api/gateway/v1/responses', '{}')).toEqual({
    status: 503,
    body: JSON.stringify({ error: 'benchmark case grant revoked' }),
  });
  expect(fetch).toHaveBeenCalledOnce();

  mocks.children[0].emit('close', 0);
  await first.done;

  // A later case on the same slot installs its own envelope and is served normally.
  const second = request('/run', {
    ...runBody,
    inferenceProxy: { ...caseInferenceProxy, authorization: 'Bearer next-capability' },
  });
  await flushServer();
  expect(await proxyRequest('POST', '/api/gateway/v1/responses', '{}')).toEqual({
    status: 200,
    body: '{}',
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  mocks.children[1].emit('close', 0);
  await second.done;
});

it('forwards only the exact catalog read route and never inference with the bot token', async () => {
  const fetch = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await loadServer();
  const running = request('/run', { ...runBody, inferenceProxy: caseInferenceProxy });
  await flushServer();

  const catalog = proxyRequest('GET', '/api/openrouter/models');
  await flushServer();
  const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
  expect(String(target)).toBe('https://catalog.test/api/openrouter/models');
  expect(init.headers).toMatchObject({ authorization: 'Bearer bot-token' });
  expect(await catalog).toEqual({ status: 200, body: '{"data":[]}' });

  mocks.children[0].emit('close', 0);
  await running.done;
});

it('reports a Worker stop after a valid billed call as a trusted stop, not from text', async () => {
  const fetch = vi
    .fn()
    // A normal admitted call the CLI billed and used.
    .mockResolvedValueOnce(
      new Response('data: {"type":"response.completed"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-kilo-benchmark-admission': 'admitted' },
      })
    )
    // Then the Worker refuses the next call because the payer paused: the marker is the only
    // trusted signal, and the provider text in the body is irrelevant.
    .mockResolvedValueOnce(
      new Response('{"error":"paused earlier","stop":"no_payer","error":{"reason":"paused"}}', {
        status: 409,
        headers: {
          'content-type': 'application/json',
          'x-kilo-benchmark-admission': 'refused',
          'x-kilo-benchmark-stop': 'paused',
        },
      })
    );
  vi.stubGlobal('fetch', fetch);
  await loadServer();
  const running = request('/run', { ...runBody, inferenceProxy: caseInferenceProxy });
  await flushServer();

  expect(await proxyRequest('POST', '/api/gateway/v1/responses', '{}')).toEqual({
    status: 200,
    body: 'data: {"type":"response.completed"}\n\n',
  });
  expect(await proxyRequest('POST', '/api/gateway/v1/responses', '{}')).toEqual({
    status: 409,
    body: '{"error":"paused earlier","stop":"no_payer","error":{"reason":"paused"}}',
  });

  mocks.children[0].emit('close', 0);
  const result = await running.done;
  expect(result.body).toMatchObject({ stop: { reason: 'paused', status: 409 } });
  expect(result.body).not.toHaveProperty('cancelled');
});

it('never trusts a stop marker carried by an admitted upstream reply', async () => {
  const fetch = vi.fn(
    async () =>
      new Response('{"error":{"reason":"paused"}}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-kilo-benchmark-admission': 'admitted',
          'x-kilo-benchmark-stop': 'no_payer',
        },
      })
  );
  vi.stubGlobal('fetch', fetch);
  await loadServer();
  const running = request('/run', { ...runBody, inferenceProxy: caseInferenceProxy });
  await flushServer();

  await proxyRequest('POST', '/api/gateway/v1/responses', '{}');
  mocks.children[0].emit('close', 0);

  const result = await running.done;
  expect(result.body).not.toHaveProperty('stop');
  expect(result.body).toMatchObject({ exitCode: 0 });
});

it.each([
  ['infra_unavailable', 503],
  ['model_permanently_failed', 402],
] as const)('carries the agreed %s stop without inventing usage', async (reason, status) => {
  const fetch = vi
    .fn()
    // This attempt billed: the CLI emitted a step_finish with a real cost before the Worker
    // refused the next call, so the result's cost must stay truthful for the caller.
    .mockResolvedValueOnce(
      new Response('data: {"type":"response.completed"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-kilo-benchmark-admission': 'admitted' },
      })
    )
    .mockResolvedValueOnce(
      new Response(`{"error":{"code":"${reason}"}}`, {
        status,
        headers: {
          'content-type': 'application/json',
          'x-kilo-benchmark-admission': 'refused',
          'x-kilo-benchmark-stop': reason,
        },
      })
    );
  vi.stubGlobal('fetch', fetch);
  await loadServer();
  const running = request('/run', { ...runBody, inferenceProxy: caseInferenceProxy });
  await flushServer();

  await proxyRequest('POST', '/api/gateway/v1/responses', '{}');
  expect(await proxyRequest('POST', '/api/gateway/v1/responses', '{}')).toMatchObject({ status });
  mocks.children[0].emit('close', 0);

  const result = await running.done;
  expect(result.body).toMatchObject({ stop: { reason, status } });
  // The stop is metadata, not a cost rewrite: the CLI's own usage fields are untouched.
  expect(result.body).not.toHaveProperty('cancelled');
});

it.each([
  ['an alternate inference spelling', 'POST', '/api/gateway/v1/chat/completions/'],
  ['an unknown setup path', 'POST', '/api/setup/keys'],
  [
    'a catalog path with a foreign query',
    'GET',
    '/api/openrouter/models?redirect=https://evil.test',
  ],
  ['a catalog path with a write method', 'POST', '/api/openrouter/models'],
])('refuses %s locally, so no credential can reach it', async (_kind, method, url) => {
  const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await loadServer();
  const running = request('/run', { ...runBody, inferenceProxy: caseInferenceProxy });
  await flushServer();

  expect(await proxyRequest(method, url, '{}')).toEqual({
    status: 404,
    body: JSON.stringify({ error: 'benchmark proxy route not allowed' }),
  });
  expect(fetch).not.toHaveBeenCalled();

  mocks.children[0].emit('close', 0);
  await running.done;
});
