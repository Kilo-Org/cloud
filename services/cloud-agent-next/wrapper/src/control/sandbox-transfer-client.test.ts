import { describe, expect, it, vi } from 'bun:test';
import {
  createSandboxTransferClient,
  sandboxTransferArchivePath,
  sandboxTransferPath,
  type SandboxTransferClientOptions,
} from './sandbox-transfer-client.js';

const baseUrl = 'https://worker.example/sandbox-transfer/a/b/c';

function client(overrides: Partial<SandboxTransferClientOptions> = {}) {
  return createSandboxTransferClient({
    baseUrl,
    grant: 'grant-one',
    expiresAt: Date.now() + 4 * 60 * 60 * 1000,
    sleep: () => Promise.resolve(),
    random: () => 0,
    ...overrides,
  });
}

describe('sandbox transfer client', () => {
  it('puts a body and parses a JSON response', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const subject = client({
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'committed', revision: 2 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      },
    });
    const result = await subject.put('artifacts/objects?path=report.pdf', {
      body: new Uint8Array([1, 2, 3]),
      contentLength: 3,
      contentType: 'application/pdf',
      sha256: 'a'.repeat(64),
    });
    expect(result).toEqual({
      status: 'ok',
      statusCode: 200,
      body: { status: 'committed', revision: 2 },
    });
    expect(calls[0]?.url).toBe(`${baseUrl}/artifacts/objects?path=report.pdf`);
    expect(calls[0]?.init).toMatchObject({
      method: 'PUT',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer grant-one',
        'Content-Length': '3',
        'Content-Type': 'application/pdf',
        'X-Content-SHA256': 'a'.repeat(64),
      },
    });
  });

  it('deletes without a body', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'deleted', revision: 3 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const result = await client({ fetch }).delete('artifacts/objects?path=report.pdf&hash=abc');
    expect(result).toEqual({
      status: 'ok',
      statusCode: 200,
      body: { status: 'deleted', revision: 3 },
    });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('returns rejected with the status for a non-retryable response', async () => {
    const result = await client({
      fetch: () => Promise.resolve(new Response(null, { status: 409 })),
    }).put('artifacts/objects', { body: new Uint8Array() });
    expect(result).toEqual({ status: 'rejected', statusCode: 409 });
  });

  it('retries 5xx with a fresh body and gives up after the attempt bound', async () => {
    let attempts = 0;
    const bodies: BodyInit[] = [];
    const result = await client({
      attempts: 3,
      fetch: () => {
        attempts += 1;
        return Promise.resolve(new Response(null, { status: attempts === 3 ? 200 : 503 }));
      },
    }).put('artifacts/objects', {
      body: () => {
        const body = new Uint8Array([attempts]);
        bodies.push(body);
        return body;
      },
    });
    expect(result).toEqual({ status: 'ok', statusCode: 200 });
    expect(attempts).toBe(3);
    expect(bodies).toHaveLength(3);
  });

  it('reports unavailable after repeated network errors', async () => {
    let attempts = 0;
    const result = await client({
      attempts: 2,
      fetch: () => {
        attempts += 1;
        return Promise.reject(new Error('network down'));
      },
    }).put('logs/files.tar.gz', { body: new Uint8Array([1]) });
    expect(result).toEqual({ status: 'unavailable', reason: 'network' });
    expect(attempts).toBe(2);
  });

  it('bounds a request even when the fetch implementation ignores abort', async () => {
    const result = await client({
      timeoutMs: 5,
      fetch: () => new Promise<Response>(() => undefined),
    }).put('logs/files.tar.gz', { body: new Uint8Array([1]) });
    expect(result).toEqual({ status: 'unavailable', reason: 'timeout' });
  });

  it('renews once on 401 and retries', async () => {
    let attempts = 0;
    const renewGrant = vi
      .fn()
      .mockResolvedValue({ grant: 'grant-two', expiresAt: Date.now() + 1000 });
    const subject = client({
      renewGrant,
      fetch: (_url, init) => {
        attempts += 1;
        if (attempts === 1) {
          expect((init.headers as Record<string, string>).Authorization).toBe('Bearer grant-one');
          return Promise.resolve(new Response(null, { status: 401 }));
        }
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer grant-two');
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    subject.setConnected(true);
    expect(await subject.put('logs/files.tar.gz', { body: new Uint8Array([1]) })).toEqual({
      status: 'ok',
      statusCode: 204,
    });
    expect(renewGrant).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(2);
  });

  it('renews only once when the retry is also 401', async () => {
    const renewGrant = vi
      .fn()
      .mockResolvedValue({ grant: 'grant-two', expiresAt: Date.now() + 1000 });
    const subject = client({
      renewGrant,
      fetch: () => Promise.resolve(new Response(null, { status: 401 })),
    });
    subject.setConnected(true);
    expect(await subject.put('logs/files.tar.gz', { body: new Uint8Array([1]) })).toEqual({
      status: 'rejected',
      statusCode: 401,
    });
    expect(renewGrant).toHaveBeenCalledTimes(1);
  });

  it('does not renew while disconnected', async () => {
    const renewGrant = vi.fn();
    const subject = client({
      renewGrant,
      fetch: () => Promise.resolve(new Response(null, { status: 401 })),
    });
    subject.setConnected(false);
    expect(await subject.put('logs/files.tar.gz', { body: new Uint8Array([1]) })).toEqual({
      status: 'rejected',
      statusCode: 401,
    });
    expect(renewGrant).not.toHaveBeenCalled();
  });

  it('renews at half of the grant lifetime while connected', async () => {
    const timers: Array<{ run: () => void; ms: number }> = [];
    const renewGrant = vi.fn().mockResolvedValue({ grant: 'grant-two', expiresAt: 20_000 });
    const subject = createSandboxTransferClient({
      baseUrl,
      grant: 'grant-one',
      expiresAt: 10_000,
      renewGrant,
      now: () => 0,
      setTimeout: ((run: () => void, ms: number) => {
        timers.push({ run, ms });
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout: (() => undefined) as typeof clearTimeout,
    });
    subject.setConnected(true);
    expect(timers[0]?.ms).toBe(5_000);
    timers[0]?.run();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(renewGrant).toHaveBeenCalledTimes(1);
    expect(subject.currentGrant()?.grant).toBe('grant-two');
  });

  it('renews a grant before the first request when no launch grant is supplied', async () => {
    const renewGrant = vi
      .fn()
      .mockResolvedValue({ grant: 'current-grant', expiresAt: Date.now() + 1000 });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const subject = createSandboxTransferClient({
      baseUrl,
      renewGrant,
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    try {
      subject.setConnected(true);
      expect(
        await subject.put('artifacts/objects?path=report.txt', {
          body: new Uint8Array([1]),
        })
      ).toEqual({ status: 'ok', statusCode: 204 });
      expect(renewGrant).toHaveBeenCalled();
      expect(calls[0]?.url).toBe(`${baseUrl}/artifacts/objects?path=report.txt`);
      expect(new Headers(calls[0]?.init.headers).get('Authorization')).toBe('Bearer current-grant');
    } finally {
      subject.stop();
    }
  });

  it('waits for a grant while disconnected, then renews after reconnecting', async () => {
    const renewGrant = vi
      .fn()
      .mockResolvedValue({ grant: 'current-grant', expiresAt: Date.now() + 1000 });
    let fetches = 0;
    const subject = createSandboxTransferClient({
      baseUrl,
      renewGrant,
      fetch: () => {
        fetches += 1;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    try {
      subject.setConnected(false);
      expect(await subject.put('events', { body: new Uint8Array([1]) })).toEqual({
        status: 'unavailable',
        reason: 'network',
      });
      expect(renewGrant).not.toHaveBeenCalled();
      expect(fetches).toBe(0);

      subject.setConnected(true);
      expect(await subject.put('events', { body: new Uint8Array([1]) })).toEqual({
        status: 'ok',
        statusCode: 204,
      });
      expect(renewGrant).toHaveBeenCalledTimes(1);
      expect(fetches).toBe(1);
    } finally {
      subject.stop();
    }
  });

  it('uses the launch fallback when renewal is unavailable', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fallbackBase = 'https://worker.example/sandbox-transfer/a/b/launch';
    const subject = createSandboxTransferClient({
      baseUrl,
      fallback: { baseUrl: fallbackBase, grant: 'launch-grant' },
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    try {
      expect(await subject.put('logs/files.tar.gz', { body: new Uint8Array([1]) })).toEqual({
        status: 'ok',
        statusCode: 204,
      });
      expect(calls[0]?.url).toBe(`${fallbackBase}/logs/files.tar.gz`);
      expect(new Headers(calls[0]?.init.headers).get('Authorization')).toBe('Bearer launch-grant');
    } finally {
      subject.stop();
    }
  });

  it('uses the launch fallback when a connected renewal fails', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fallbackBase = 'https://worker.example/sandbox-transfer/a/b/launch';
    const subject = createSandboxTransferClient({
      baseUrl,
      fallback: { baseUrl: fallbackBase, grant: 'launch-grant' },
      renewGrant: () => Promise.reject(new Error('renewal unavailable')),
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    try {
      subject.setConnected(true);
      expect(await subject.put('logs/files.tar.gz', { body: new Uint8Array([1]) })).toEqual({
        status: 'ok',
        statusCode: 204,
      });
      expect(calls[0]?.url).toBe(`${fallbackBase}/logs/files.tar.gz`);
      expect(new Headers(calls[0]?.init.headers).get('Authorization')).toBe('Bearer launch-grant');
    } finally {
      subject.stop();
    }
  });

  it('reuses the renewed grant after a reconnect while it is still valid', async () => {
    const renewGrant = vi
      .fn()
      .mockResolvedValue({ grant: 'current-grant', expiresAt: Date.now() + 10_000 });
    const authorizations: string[] = [];
    const subject = createSandboxTransferClient({
      baseUrl,
      renewGrant,
      fetch: (_url, init) => {
        authorizations.push((init.headers as Record<string, string>).Authorization ?? '');
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    try {
      subject.setConnected(true);
      expect(await subject.put('events', { body: new Uint8Array([1]) })).toEqual({
        status: 'ok',
        statusCode: 204,
      });
      expect(renewGrant).toHaveBeenCalledTimes(1);

      subject.setConnected(false);
      subject.setConnected(true);
      expect(await subject.put('events', { body: new Uint8Array([1]) })).toEqual({
        status: 'ok',
        statusCode: 204,
      });
      expect(renewGrant).toHaveBeenCalledTimes(1);
      expect(authorizations).toEqual(['Bearer current-grant', 'Bearer current-grant']);
    } finally {
      subject.stop();
    }
  });

  it('recovers a grantless client after a failed renewal when it reconnects', async () => {
    const renewGrant = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection closed'))
      .mockResolvedValue({ grant: 'current-grant', expiresAt: Date.now() + 10_000 });
    let fetches = 0;
    const subject = createSandboxTransferClient({
      baseUrl,
      renewGrant,
      fetch: () => {
        fetches += 1;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    try {
      subject.setConnected(true);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(subject.currentGrant()).toBeUndefined();

      subject.setConnected(false);
      subject.setConnected(true);
      expect(await subject.put('events', { body: new Uint8Array([1]) })).toEqual({
        status: 'ok',
        statusCode: 204,
      });
      expect(renewGrant).toHaveBeenCalledTimes(2);
      expect(fetches).toBe(1);
    } finally {
      subject.stop();
    }
  });

  it('builds log and artifact paths relative to the base URL', () => {
    expect(sandboxTransferArchivePath('logs')).toBe('logs/files.tar.gz');
    expect(sandboxTransferArchivePath('')).toBe('files.tar.gz');
    expect(sandboxTransferPath('logs', 'batch-id')).toBe('logs/batch-id');
  });
});
