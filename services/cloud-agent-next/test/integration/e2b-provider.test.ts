import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readE2BResponseText, type E2BSandboxDetail } from '../../src/sandbox-control/e2b-api.js';
import { createE2BControlAdapter } from '../../src/sandbox-control/e2b-provider.js';
import { launchE2BWrapper } from '../../src/sandbox-control/e2b-envd.js';
import {
  e2bTestConfig,
  e2bTestIntent,
  e2bTestRef,
  e2bTestSandbox,
  e2bTestSubmittedConfig,
  E2B_TEST_BINDING,
  E2B_TEST_ENVD_TOKEN,
  E2B_TEST_INTENT_ID,
  E2B_TEST_KEY,
  E2B_TEST_NOW,
  E2B_TEST_PHYSICAL_ID,
  E2B_TEST_RELEASE,
  E2B_TEST_SANDBOX_ID,
} from '../../src/sandbox-control/e2b-test-fixtures.js';

function connectFrame(value: unknown, flags = 0, padding = 0): Uint8Array {
  const data = new TextEncoder().encode(JSON.stringify(value).padEnd(padding));
  const frame = new Uint8Array(5 + data.byteLength);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, data.byteLength);
  frame.set(data, 5);
  return frame;
}

function controlledTransport(
  options: {
    lostCreateResponse?: boolean;
    sandbox?: E2BSandboxDetail;
    start?: (request: Request) => Response | Promise<Response>;
  } = {}
) {
  const info = options.sandbox ?? e2bTestSandbox();
  const requests: Request[] = [];
  let disconnects = 0;
  let processAlive = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input instanceof URL ? input.toString() : input, init);
      requests.push(request.clone());
      const url = new URL(request.url);
      if (url.origin === 'https://api.e2b.app') {
        if (url.pathname === '/sandboxes' && request.method === 'POST') {
          if (options.lostCreateResponse) throw new TypeError('Simulated create response loss');
          return Response.json(
            { sandboxID: info.sandboxID, templateID: info.templateID },
            { status: 201 }
          );
        }
        if (url.pathname === '/v2/sandboxes' && request.method === 'GET')
          return Response.json([info]);
        if (url.pathname === `/sandboxes/${info.sandboxID}` && request.method === 'GET')
          return Response.json(info);
        if (url.pathname === `/sandboxes/${info.sandboxID}` && request.method === 'DELETE') {
          processAlive = false;
          return new Response(null, { status: 204 });
        }
      }
      if (
        url.origin === 'https://sandbox.e2b.app' &&
        url.pathname === '/files' &&
        request.method === 'GET'
      ) {
        return Response.json({ runtimeBuildId: E2B_TEST_RELEASE.runtimeBuildId });
      }
      if (
        url.origin === 'https://sandbox.e2b.app' &&
        url.pathname === '/process.Process/Start' &&
        request.method === 'POST'
      ) {
        if (options.start) return options.start(request);
        processAlive = true;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(connectFrame({ event: { start: { pid: 42 } } }));
            },
            cancel() {
              disconnects++;
            },
          }),
          { headers: { 'Content-Type': 'application/connect+json' } }
        );
      }
      throw new Error('Unexpected controlled E2B request');
    })
  );
  return { requests, disconnects: () => disconnects, processAlive: () => processAlive };
}

function adapter(
  resolveApiKey = vi.fn(async () => E2B_TEST_KEY),
  options: { submitted?: boolean } = { submitted: true }
) {
  return createE2BControlAdapter({
    config: options.submitted ? e2bTestConfig() : e2bTestConfig(false),
    binding: E2B_TEST_BINDING,
    sandboxId: E2B_TEST_SANDBOX_ID,
    intentId: E2B_TEST_INTENT_ID,
    resolveApiKey,
    ...(options.submitted ? {} : { submitCreateIntent: async () => e2bTestSubmittedConfig() }),
  });
}

function launchNative(deadlineAt = E2B_TEST_NOW + 60_000) {
  return launchE2BWrapper({
    apiKey: E2B_TEST_KEY,
    sandbox: e2bTestSandbox(),
    runtimeBuildId: E2B_TEST_RELEASE.runtimeBuildId,
    providerRef: e2bTestRef(),
    env: { SANDBOX_CONTROL_CREDENTIAL: 'test-only-native-callhome' },
    deadlineAt,
  });
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
});

describe('E2B provider controlled transport in real workerd', () => {
  it('consumes bounded UTF-8 management responses in workerd', async () => {
    const signal = AbortSignal.timeout(1000);
    const response = Response.json({ text: 'café' });
    await expect(readE2BResponseText(response, 1024, signal)).resolves.toBe('{"text":"café"}');
  });

  it('uses secured native envd transport, starts the pinned wrapper, and disconnects without kill', async () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
    const transport = controlledTransport();
    const resolve = vi
      .fn()
      .mockResolvedValueOnce('test-only-create-key')
      .mockResolvedValueOnce('test-only-launch-key');
    const provider = adapter(resolve, { submitted: false });
    const env = {
      SANDBOX_CONTROL_CREDENTIAL: 'test-only-allocation-token; $(not-interpolated)',
      KILO_PLATFORM: 'cloud-agent',
    };
    await expect(provider.create(e2bTestIntent())).resolves.toEqual({ providerRef: e2bTestRef() });
    await expect(provider.launch(e2bTestRef(), env)).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(transport.disconnects()).toBe(1);
    expect(transport.processAlive()).toBe(true);
    expect(
      transport.requests.map(request => [request.method, new URL(request.url).pathname])
    ).toEqual([
      ['POST', '/sandboxes'],
      ['GET', `/sandboxes/${E2B_TEST_PHYSICAL_ID}`],
      ['GET', '/files'],
      ['POST', '/process.Process/Start'],
    ]);
    expect(transport.requests[0].headers.get('X-API-Key')).toBe('test-only-create-key');
    expect(transport.requests[1].headers.get('X-API-Key')).toBe('test-only-launch-key');
    for (const request of transport.requests.slice(2)) {
      expect(new URL(request.url).origin).toBe('https://sandbox.e2b.app');
      expect(request.headers.get('X-Access-Token')).toBe(E2B_TEST_ENVD_TOKEN);
      expect(request.headers.get('E2b-Sandbox-Id')).toBe(E2B_TEST_PHYSICAL_ID);
      expect(request.headers.get('E2b-Sandbox-Port')).toBe('49983');
      expect(request.headers.get('X-API-Key')).toBeNull();
      expect(Array.from(request.headers.values()).join(' ')).not.toContain('test-only-launch-key');
    }
    expect(transport.requests[3].headers.get('connect-timeout-ms')).toBeNull();
    const bytes = new Uint8Array(await transport.requests[3].arrayBuffer());
    expect(bytes[0]).toBe(0);
    const body = JSON.parse(new TextDecoder().decode(bytes.subarray(5)));
    expect(body).toMatchObject({
      process: {
        cmd: '/bin/bash',
        args: [
          '-l',
          '-c',
          'exec bun /opt/kilo/kilocode-control-wrapper.js >> /tmp/kilocode-control-wrapper.log 2>&1',
        ],
        envs: {
          ...env,
          PROVIDER_INSTANCE_ID: e2bTestRef(),
          WRAPPER_LOG_PATH: '/tmp/kilocode-control-wrapper.log',
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain('test-only-create-key');
    expect(JSON.stringify(body)).not.toContain('test-only-launch-key');
  });

  it('accepts a fragmented trailing keepalive and cancels without another request', async () => {
    const ack = connectFrame({ event: { start: { pid: 42 } } });
    const keepalive = connectFrame({ event: { keepalive: {} } });
    const firstChunk = new Uint8Array(ack.byteLength + 2);
    firstChunk.set(ack);
    firstChunk.set(keepalive.subarray(0, 2), ack.byteLength);
    const cancel = vi.fn();
    const transport = controlledTransport({
      start: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(firstChunk);
              controller.enqueue(keepalive.subarray(2));
            },
            cancel,
          }),
          { headers: { 'Content-Type': 'application/connect+json' } }
        ),
    });
    await expect(launchNative()).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(
      transport.requests.map(request => [request.method, new URL(request.url).pathname])
    ).toEqual([
      ['GET', '/files'],
      ['POST', '/process.Process/Start'],
    ]);
    expect(transport.requests[1].signal.aborted).toBe(true);
  });

  it.each([307, 308])(
    'rejects cross-origin Process/Start redirect %s without following it',
    async status => {
      const transport = controlledTransport({
        start: () =>
          new Response(null, {
            status,
            headers: { Location: 'https://invalid.example/process.Process/Start' },
          }),
      });
      await expect(
        adapter().launch(e2bTestRef(), {
          SANDBOX_CONTROL_CREDENTIAL: 'test-only-callhome-credential',
        })
      ).rejects.toMatchObject({ code: 'byoc_e2b_bootstrap_failed' });
      const starts = transport.requests.filter(
        request => new URL(request.url).pathname === '/process.Process/Start'
      );
      expect(starts).toHaveLength(1);
      expect(starts[0].redirect).toBe('manual');
      expect(starts[0].headers.get('X-Access-Token')).toBe(E2B_TEST_ENVD_TOKEN);
      expect(starts[0].headers.get('X-API-Key')).toBeNull();
      expect(new URL(starts[0].url).origin).toBe('https://sandbox.e2b.app');
      const bytes = new Uint8Array(await starts[0].arrayBuffer());
      expect(JSON.parse(new TextDecoder().decode(bytes.subarray(5)))).toMatchObject({
        process: { envs: { SANDBOX_CONTROL_CREDENTIAL: 'test-only-callhome-credential' } },
      });
      expect(transport.requests).toHaveLength(3);
      expect(
        transport.requests.every(
          request => new URL(request.url).origin !== 'https://invalid.example'
        )
      ).toBe(true);
    }
  );

  it('recovers a lost create response with one native POST and non-waking management reconciliation', async () => {
    const transport = controlledTransport({ lostCreateResponse: true });
    await expect(adapter(undefined, { submitted: false }).create(e2bTestIntent())).resolves.toEqual({ providerRef: e2bTestRef() });
    expect(transport.requests.map(request => request.method)).toEqual(['POST', 'GET']);
    expect(transport.requests.every(request => request.redirect === 'manual')).toBe(true);
    expect(new URL(transport.requests[1].url).searchParams.get('state')).toBe('running,paused');
  });

  it('rejects management redirects without forwarding the account key', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        requests.push(request);
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://invalid.example' },
        });
      })
    );
    await expect(adapter().observe(e2bTestRef())).resolves.toEqual({ status: 'unknown' });
    expect(requests).toHaveLength(1);
    expect(requests[0].redirect).toBe('manual');
    expect(new URL(requests[0].url).origin).toBe('https://api.e2b.app');
  });

  it.each([
    {
      name: 'oversized frame',
      response: () => {
        const header = new Uint8Array(5);
        new DataView(header.buffer).setUint32(1, 4097);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(header);
            },
          }),
          { headers: { 'Content-Type': 'application/connect+json' } }
        );
      },
    },
    {
      name: 'oversized body',
      response: () =>
        new Response(new Uint8Array(32769), {
          headers: { 'Content-Type': 'application/connect+json', 'Content-Length': '1' },
        }),
    },
    {
      name: 'total body across valid frames',
      response: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < 7; i++)
                controller.enqueue(connectFrame({ event: { keepalive: {} } }, 0, 4096));
              controller.enqueue(connectFrame({ event: { start: { pid: 42 } } }, 0, 4096));
            },
          }),
          { headers: { 'Content-Type': 'application/connect+json', 'Content-Length': '1' } }
        ),
    },
    {
      name: 'oversized headers',
      response: () =>
        new Response(connectFrame({ event: { start: { pid: 42 } } }), {
          headers: {
            'Content-Type': 'application/connect+json',
            'X-Padding': 'x'.repeat(16 * 1024),
          },
        }),
    },
    {
      name: 'truncated header',
      response: () =>
        new Response(Uint8Array.of(0, 0, 0), {
          headers: { 'Content-Type': 'application/connect+json' },
        }),
    },
    {
      name: 'truncated payload',
      response: () =>
        new Response(connectFrame({ event: { start: { pid: 42 } } }).subarray(0, 10), {
          headers: { 'Content-Type': 'application/connect+json' },
        }),
    },
    {
      name: 'start error trailer',
      response: () =>
        new Response(
          connectFrame({ error: { code: 'internal', message: E2B_TEST_ENVD_TOKEN } }, 2),
          { headers: { 'Content-Type': 'application/connect+json' } }
        ),
    },
    {
      name: 'invalid PID',
      response: () =>
        new Response(connectFrame({ event: { start: { pid: 0 } } }), {
          headers: { 'Content-Type': 'application/connect+json' },
        }),
    },
  ])('rejects native envd $name without another request', async ({ response }) => {
    const transport = controlledTransport({ start: response });
    const error = await launchNative().catch(error => error);
    expect(error).toMatchObject({ code: 'byoc_e2b_bootstrap_failed' });
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain(E2B_TEST_ENVD_TOKEN);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.every(request => request.redirect === 'manual')).toBe(true);
  });

  it('aborts a delayed native start body at the caller deadline', async () => {
    const cancel = vi.fn();
    const transport = controlledTransport({
      start: () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'Content-Type': 'application/connect+json' },
        }),
    });
    await expect(launchNative(E2B_TEST_NOW + 30)).rejects.toMatchObject({
      code: 'byoc_e2b_bootstrap_failed',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1].signal.aborted).toBe(true);
  });

  it('keeps a paused discovery nonterminal, refuses envd launch, and kills only its exact ID', async () => {
    const transport = controlledTransport({ sandbox: { ...e2bTestSandbox(), state: 'paused' } });
    const provider = adapter();
    await expect(provider.observe(null)).resolves.toEqual({
      status: 'unknown',
      providerRef: e2bTestRef(),
    });
    await expect(provider.launch(e2bTestRef(), {})).rejects.toMatchObject({
      code: 'byoc_e2b_bootstrap_failed',
    });
    await expect(provider.stop(e2bTestRef())).resolves.toBe('terminal');
    expect(
      transport.requests.every(request => new URL(request.url).origin === 'https://api.e2b.app')
    ).toBe(true);
    expect(transport.requests.at(-1)?.method).toBe('DELETE');
  });
});
