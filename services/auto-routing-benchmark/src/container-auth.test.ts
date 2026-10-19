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

it('only suppresses recovery after the response finishes successfully', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  await loadServer();
  const pending = request('/run', { ...runBody, resultCallback }, undefined, {
    autoFinish: false,
  });
  await flushServer();
  mocks.children[0].emit('close', 0);
  expect((await pending.done).status).toBe(200);
  await flushServer();
  expect(fetch).not.toHaveBeenCalled();
  pending.res.emit('finish');
  pending.res.emit('close');
  await flushServer();
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  stopServer();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});

it.each(['close', 'error', 'throw'] as const)(
  'recovers a response write that ends in %s without another inference',
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
    pending.res.end.mockImplementationOnce(payload => {
      end(payload);
      if (failure === 'throw') throw new Error('response write failed');
      pending.res.emit(failure, new Error('response disconnected'));
    });
    await flushServer();
    mocks.children[0].emit('close', 0);
    expect((await pending.done).status).toBe(200);
    await flushServer();
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toMatchObject({
      execution: resultCallback.execution,
      outcome: { kind: 'completed', response: { exitCode: 0 } },
    });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(pending.res.end).toHaveBeenCalledOnce();
    stopServer();
    pending.res.emit('finish');
    pending.res.emit('close');
    expect(mocks.exit).not.toHaveBeenCalled();
    acknowledge();
    await flushServer();
    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
  }
);

it('drains a callback when shutdown starts before the response finishes', async () => {
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
  await pending.done;
  stopServer();
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.exit).not.toHaveBeenCalled();
  pending.res.emit('finish');
  await flushServer();
  expect(fetch).toHaveBeenCalledOnce();
  expect(mocks.exit).not.toHaveBeenCalled();
  acknowledge();
  await flushServer();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(mocks.spawn).toHaveBeenCalledOnce();
});

it('recovers a response that never finishes without blocking shutdown indefinitely', async () => {
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
  'bounds callback %s retries and logs only the failure category before shutdown',
  async category => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const privateDetail = [
      runBody.kiloToken,
      runBody.prompt,
      resultCallback.url,
      resultCallback.execution.runId,
      resultCallback.execution.token,
      'private model output',
    ].join(' ');
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
    pending.res.emit('close');
    mocks.children[0].stdout.emit('data', Buffer.from(`${privateDetail}\n`));
    mocks.children[0].stderr.emit('data', Buffer.from(privateDetail));
    mocks.children[0].emit('close', 0);
    await pending.done;
    await flushServer();
    stopServer();
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(timeout).toHaveBeenCalledTimes(3);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: 'benchmark_container_result_delivery_exhausted',
        category,
        attempts: 3,
      })
    );
    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
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
    JSON.stringify({ event: 'benchmark_container_result_rejected', category: 'not_found' })
  );
  expect(error).not.toHaveBeenCalled();
  stopServer();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(mocks.spawn).toHaveBeenCalledOnce();
});

it('releases an unstarted execution even when its error response finishes', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  mocks.mkdtemp.mockRejectedValueOnce(new Error('workspace unavailable'));
  await loadServer();
  expect(await request('/run', { ...runBody, resultCallback }).done).toEqual({
    status: 500,
    body: { error: 'workspace unavailable' },
  });
  await flushServer();
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({
    execution: resultCallback.execution,
    outcome: { kind: 'not_started' },
  });
  expect(mocks.spawn).not.toHaveBeenCalled();
  stopServer();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});

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
