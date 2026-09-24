import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { E2BProviderError } from '../byoc/e2b-errors.js';
import { launchE2BWrapper } from './e2b-envd.js';
import { createE2BControlAdapter } from './e2b-provider.js';
import {
  e2bTestConfig,
  e2bTestRef,
  e2bTestSandbox,
  E2B_TEST_BINDING,
  E2B_TEST_INTENT_ID,
  E2B_TEST_ENVD_TOKEN,
  E2B_TEST_KEY,
  E2B_TEST_NOW,
  E2B_TEST_PHYSICAL_ID,
  E2B_TEST_RELEASE,
  E2B_TEST_SANDBOX_ID,
} from './e2b-test-fixtures.js';

const startEvent = { event: { start: { pid: 42 } } };
const keepaliveEvent = { event: { keepalive: {} } };
const contentType = { 'Content-Type': 'application/connect+json' };

function rawFrame(payload: Uint8Array, flags = 0): Uint8Array {
  const frame = new Uint8Array(5 + payload.byteLength);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.byteLength);
  frame.set(payload, 5);
  return frame;
}

function frame(value: unknown, flags = 0): Uint8Array {
  return rawFrame(new TextEncoder().encode(JSON.stringify(value)), flags);
}

function concatenate(...chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function streamResponse(chunks: Uint8Array[], close = false, cancel = vi.fn()): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (close) controller.close();
      },
      cancel,
    }),
    { headers: contentType }
  );
}

function launch(overrides: Partial<Parameters<typeof launchE2BWrapper>[0]> = {}) {
  return launchE2BWrapper({
    apiKey: E2B_TEST_KEY,
    sandbox: e2bTestSandbox(e2bTestConfig()),
    runtimeBuildId: E2B_TEST_RELEASE.runtimeBuildId,
    providerRef: e2bTestRef(),
    env: { SANDBOX_CONTROL_CREDENTIAL: 'test-only-callhome-secret; $(not-interpolated)' },
    deadlineAt: E2B_TEST_NOW + 60_000,
    ...overrides,
  });
}

function bootstrapTransport(
  options: {
    manifest?: () => Response | Promise<Response>;
    start?: (request: Request) => Response | Promise<Response>;
  } = {}
) {
  const requests: Request[] = [];
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      requests.push(request.clone());
      const url = new URL(request.url);
      if (url.origin === 'https://api.e2b.app') return Response.json(e2bTestSandbox(e2bTestConfig()));
      if (url.origin !== 'https://sandbox.e2b.app') throw new Error('Unexpected test origin');
      if (url.pathname === '/files')
        return (
          options.manifest?.() ?? Response.json({ runtimeBuildId: E2B_TEST_RELEASE.runtimeBuildId })
        );
      if (url.pathname === '/process.Process/Start')
        return options.start?.(request) ?? streamResponse([frame(startEvent)], false, cancel);
      throw new Error('Unexpected test request');
    })
  );
  return { requests, cancel };
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(E2B_TEST_NOW);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('Uncontrolled requests are forbidden'))
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('E2B native envd launch', () => {
  it('sends the fixed command and separate env only to the fixed origin, then disconnects without Kill', async () => {
    const { requests, cancel } = bootstrapTransport();
    await expect(launch()).resolves.toBeUndefined();
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/files'],
      ['POST', '/process.Process/Start'],
    ]);
    expect(new URL(requests[0].url).searchParams.get('path')).toBe(
      '/opt/kilo/runtime-manifest.json'
    );
    for (const request of requests) {
      expect(request.redirect).toBe('manual');
      expect(request.signal.aborted).toBe(true);
      expect(request.headers.get('X-Access-Token')).toBe(E2B_TEST_ENVD_TOKEN);
      expect(request.headers.get('E2b-Sandbox-Id')).toBe(E2B_TEST_PHYSICAL_ID);
      expect(request.headers.get('E2b-Sandbox-Port')).toBe('49983');
      expect(Array.from(request.headers.values()).join(' ')).not.toContain(E2B_TEST_KEY);
    }
    expect(requests[1].headers.get('Connect-Protocol-Version')).toBe('1');
    expect(requests[1].headers.get('Connect-Timeout-Ms')).toBeNull();
    const bytes = new Uint8Array(await requests[1].arrayBuffer());
    expect(bytes[0]).toBe(0);
    expect(new DataView(bytes.buffer).getUint32(1)).toBe(bytes.byteLength - 5);
    const body = new TextDecoder().decode(bytes.subarray(5));
    expect(JSON.parse(body)).toEqual({
      process: {
        cmd: '/bin/bash',
        args: [
          '-l',
          '-c',
          'exec bun /opt/kilo/kilocode-control-wrapper.js >> /tmp/kilocode-control-wrapper.log 2>&1',
        ],
        cwd: '/',
        envs: {
          SANDBOX_CONTROL_CREDENTIAL: 'test-only-callhome-secret; $(not-interpolated)',
          PROVIDER_INSTANCE_ID: e2bTestRef(),
          WRAPPER_LOG_PATH: '/tmp/kilocode-control-wrapper.log',
        },
      },
      stdin: false,
    });
    expect(body).not.toContain(E2B_TEST_KEY);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('uses freshly resolved credentials on separate provider launch operations', async () => {
    const { requests, cancel } = bootstrapTransport();
    const resolveApiKey = vi
      .fn()
      .mockResolvedValueOnce('test-only-first-key')
      .mockResolvedValueOnce('test-only-second-key');
    const provider = createE2BControlAdapter({
      binding: E2B_TEST_BINDING,
      sandboxId: E2B_TEST_SANDBOX_ID,
      config: e2bTestConfig(), intentId: E2B_TEST_INTENT_ID,
      resolveApiKey,
    });
    await provider.launch(e2bTestRef(), {});
    await provider.launch(e2bTestRef(), {});
    expect(resolveApiKey).toHaveBeenCalledTimes(2);
    const management = requests.filter(
      request => new URL(request.url).origin === 'https://api.e2b.app'
    );
    expect(management.map(request => request.headers.get('X-API-Key'))).toEqual([
      'test-only-first-key',
      'test-only-second-key',
    ]);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it.each([
    { state: 'paused' },
    { metadata: { ...e2bTestSandbox(e2bTestConfig()).metadata, operationId: 'wrong-operation' } },
    { templateID: 'wrong-template' },
    { envdAccessToken: null },
    { lifecycle: { onTimeout: 'kill', autoResume: true } },
    { network: { allowPublicTraffic: true } },
  ])('refuses unowned, paused, or insecure resources before envd I/O %#', async patch => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...e2bTestSandbox(e2bTestConfig()), ...patch }))
    );
    const provider = createE2BControlAdapter({
      binding: E2B_TEST_BINDING,
      sandboxId: E2B_TEST_SANDBOX_ID,
      config: e2bTestConfig(), intentId: E2B_TEST_INTENT_ID,
      resolveApiKey: async () => E2B_TEST_KEY,
    });
    await expect(provider.launch(e2bTestRef(), {})).rejects.toBeInstanceOf(E2BProviderError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each<Record<string, string>>([
    { E2B_API_KEY: E2B_TEST_KEY },
    { e2b_api_key: 'test-only-other-key' },
    { DEBUG_VALUE: `prefix-${E2B_TEST_KEY}` },
    { OVERSIZED: 'x'.repeat(64 * 1024 + 1) },
    { ENCODED_OVERSIZED: '\u0000'.repeat(16 * 1024) },
  ])('rejects account credentials or oversized guest data before I/O %#', async env => {
    await expect(launch({ env })).rejects.toMatchObject({ code: 'byoc_e2b_bootstrap_failed' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('snapshots guest env before awaiting the manifest', async () => {
    const env = { SANDBOX_CONTROL_CREDENTIAL: 'test-only-original-callhome' };
    const { requests } = bootstrapTransport({
      manifest: () => {
        env.SANDBOX_CONTROL_CREDENTIAL = E2B_TEST_KEY;
        return Response.json({ runtimeBuildId: E2B_TEST_RELEASE.runtimeBuildId });
      },
    });
    await launch({ env });
    const bytes = new Uint8Array(await requests[1].arrayBuffer());
    const body = new TextDecoder().decode(bytes.subarray(5));
    expect(body).toContain('test-only-original-callhome');
    expect(body).not.toContain(E2B_TEST_KEY);
  });
});

describe('E2B envd transport bounds and failures', () => {
  it.each([301, 302, 303, 307, 308, 401, 403, 404, 500, 502])(
    'rejects start HTTP %s without following, retrying, or probing health',
    async status => {
      const { requests } = bootstrapTransport({
        start: () =>
          new Response('test-only-guest-secret', {
            status,
            headers: { Location: 'https://invalid.example' },
          }),
      });
      const error = await launch().catch(error => error);
      expect(error).toMatchObject({ code: 'byoc_e2b_bootstrap_failed' });
      expect(error.cause).toBeUndefined();
      expect(String(error)).not.toContain('test-only-guest-secret');
      expect(requests).toHaveLength(2);
      expect(requests.every(request => request.redirect === 'manual')).toBe(true);
    }
  );

  it.each([
    () => Response.json({ runtimeBuildId: 'different-runtime' }),
    () => Response.json({ secret: 'test-only-guest-secret' }),
    () => new Response('test-only-provider-secret', { status: 404 }),
    () => new Response(null, { status: 307, headers: { Location: 'https://invalid.example' } }),
    () => new Response('x'.repeat(16 * 1024 + 1), { headers: { 'Content-Length': '1' } }),
  ])('refuses an invalid manifest before Process/Start %#', async manifest => {
    const { requests } = bootstrapTransport({ manifest });
    await expect(launch()).rejects.toMatchObject({ code: 'byoc_e2b_bootstrap_failed' });
    expect(requests).toHaveLength(1);
  });

  it.each<Record<string, string>>([
    { 'Content-Type': 'application/json' },
    { ...contentType, 'Content-Length': '32769' },
    { ...contentType, 'Content-Length': '-1' },
    { ...contentType, 'Connect-Content-Encoding': 'gzip' },
    { ...contentType, 'Content-Encoding': 'gzip' },
    { ...contentType, 'X-Padding': 'x'.repeat(16 * 1024) },
    { ...contentType, 'X-Padding-A': 'x'.repeat(9000), 'X-Padding-B': 'x'.repeat(9000) },
    {
      ...contentType,
      ...Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`X-Header-${i}`, 'value'])),
    },
  ])('rejects incompatible or oversized response headers %#', async headers => {
    bootstrapTransport({ start: () => new Response(frame(startEvent), { headers }) });
    await expect(launch()).rejects.toMatchObject({ code: 'byoc_e2b_bootstrap_failed' });
  });

  it('sanitizes transport failures without an SDK error-path request', async () => {
    const { requests } = bootstrapTransport({
      start: () => {
        throw new Error(E2B_TEST_KEY, { cause: 'test-only-callhome-secret' });
      },
    });
    const error = await launch().catch(error => error);
    expect(error).toMatchObject({ code: 'byoc_e2b_bootstrap_failed' });
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(E2B_TEST_KEY);
    expect(requests).toHaveLength(2);
  });

  it.each(['manifest', 'start'] as const)(
    'aborts a delayed %s body within the shared deadline',
    async phase => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const cancel = vi.fn();
      bootstrapTransport({ [phase]: () => streamResponse([], false, cancel) });
      const result = launch({ deadlineAt: E2B_TEST_NOW + 100 }).catch(error => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toMatchObject({ code: 'byoc_e2b_bootstrap_failed' });
      expect(cancel).toHaveBeenCalledTimes(1);
    }
  );

  it('bounds header wait and discards a response delivered after cancellation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let deliver: ((response: Response) => void) | undefined;
    const { requests } = bootstrapTransport({
      start: () =>
        new Promise<Response>(resolve => {
          deliver = resolve;
        }),
    });
    const result = launch({ deadlineAt: E2B_TEST_NOW + 100 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ code: 'byoc_e2b_bootstrap_failed' });
    const cancel = vi.fn();
    deliver?.(streamResponse([frame(startEvent)], false, cancel));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].signal.aborted).toBe(true);
  });

  it('does not submit Process/Start if the saved deadline passes during the manifest read', async () => {
    const { requests } = bootstrapTransport({
      manifest: () => {
        vi.mocked(Date.now).mockReturnValue(E2B_TEST_NOW + 101);
        return Response.json({ runtimeBuildId: E2B_TEST_RELEASE.runtimeBuildId });
      },
    });
    await expect(launch({ deadlineAt: E2B_TEST_NOW + 100 })).rejects.toMatchObject({
      code: 'byoc_e2b_bootstrap_failed',
    });
    expect(requests).toHaveLength(1);
  });
});

describe('E2B bounded Connect-JSON start acknowledgement', () => {
  it('accepts fragmented headers and JSON, then immediately cancels the still-open stream', async () => {
    const bytes = concatenate(frame(keepaliveEvent), frame(startEvent));
    const cancel = vi.fn();
    bootstrapTransport({
      start: () =>
        streamResponse(
          Array.from(bytes, byte => Uint8Array.of(byte)),
          false,
          cancel
        ),
    });
    await expect(launch()).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('accepts a fragmented trailing keepalive and cancels without another request', async () => {
    const ack = frame(startEvent);
    const keepalive = frame(keepaliveEvent);
    const cancel = vi.fn();
    const { requests } = bootstrapTransport({
      start: () =>
        streamResponse(
          [concatenate(ack, keepalive.subarray(0, 2)), keepalive.subarray(2)],
          false,
          cancel
        ),
    });
    await expect(launch()).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/files'],
      ['POST', '/process.Process/Start'],
    ]);
    expect(requests[1].signal.aborted).toBe(true);
  });

  it.each(
    [
      [],
      [Uint8Array.of(0, 0, 0)],
      [frame(startEvent).subarray(0, 10)],
      [rawFrame(new TextEncoder().encode('test-only-invalid-json-secret'))],
      [rawFrame(Uint8Array.of(0xff))],
      [frame({ event: { start: { pid: 0 } } })],
      [frame({ event: { start: { pid: -1 } } })],
      [frame({ event: { start: { pid: 1.5 } } })],
      [frame({ event: { start: { pid: 0x1_0000_0000 } } })],
      [frame({ event: { start: { pid: '42' } } })],
      [frame({ event: { data: { stdout: 'dGVzdC1vbmx5LXNlY3JldA==' } } })],
      [frame({ event: { end: { exited: true, status: 'test-only-guest-secret' } } })],
      [frame({ error: { code: 'internal', message: 'test-only-guest-secret' } }, 2)],
      [frame({}, 2)],
      [frame(startEvent, 1)],
      [frame(startEvent, 128)],
      [new Uint8Array(5)],
    ].map(chunks => ({ chunks }))
  )('rejects malformed, truncated, error, output, or early-exit frames %#', async ({ chunks }) => {
    bootstrapTransport({ start: () => streamResponse(chunks, true) });
    const error = await launch().catch(error => error);
    expect(error).toBeInstanceOf(E2BProviderError);
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain('test-only');
  });

  it.each([
    frame({ event: { end: { exited: true, status: 'exit status 1' } } }),
    frame({ event: { data: { stderr: 'c2VjcmV0' } } }),
    frame({ error: { code: 'internal' } }, 2),
    frame(startEvent),
    Uint8Array.of(0, 0),
  ])('ignores post-ACK exit, output, error, duplicate, or incomplete data %#', async trailing => {
    const cancel = vi.fn();
    const { requests } = bootstrapTransport({
      start: () => streamResponse([concatenate(frame(startEvent), trailing)], false, cancel),
    });
    await expect(launch()).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
  });

  it.each([
    frame({ event: { end: { exited: true, status: 'exit status 1' } } }),
    frame({ event: { data: { stderr: 'c2VjcmV0' } } }),
    frame({ error: { code: 'internal' } }, 2),
  ])('rejects invalid pre-ACK data even when a valid ACK follows %#', async invalid => {
    bootstrapTransport({ start: () => streamResponse([concatenate(invalid, frame(startEvent))]) });
    await expect(launch()).rejects.toMatchObject({ code: 'byoc_e2b_bootstrap_failed' });
  });

  it('rejects an oversized advertised frame before waiting for its payload', async () => {
    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint32(1, 4097);
    const cancel = vi.fn();
    bootstrapTransport({ start: () => streamResponse([header], false, cancel) });
    await expect(launch()).rejects.toMatchObject({ code: 'byoc_e2b_bootstrap_failed' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('bounds received bytes even when a start acknowledgement precedes an output flood', async () => {
    const cancel = vi.fn();
    bootstrapTransport({
      start: () =>
        streamResponse([concatenate(frame(startEvent), new Uint8Array(32 * 1024))], false, cancel),
    });
    await expect(launch()).rejects.toMatchObject({ code: 'byoc_e2b_bootstrap_failed' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('bounds total response bytes across otherwise valid frames', async () => {
    const padded = (value: unknown) =>
      rawFrame(new TextEncoder().encode(JSON.stringify(value).padEnd(4096)));
    const cancel = vi.fn();
    bootstrapTransport({
      start: () =>
        streamResponse(
          [...Array.from({ length: 7 }, () => padded(keepaliveEvent)), padded(startEvent)],
          false,
          cancel
        ),
    });
    await expect(launch()).rejects.toMatchObject({ code: 'byoc_e2b_bootstrap_failed' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('bounds keepalive frame count before a start acknowledgement', async () => {
    bootstrapTransport({
      start: () =>
        streamResponse([
          ...Array.from({ length: 8 }, () => frame(keepaliveEvent)),
          frame(startEvent),
        ]),
    });
    await expect(launch()).rejects.toMatchObject({ code: 'byoc_e2b_bootstrap_failed' });
  });
});
