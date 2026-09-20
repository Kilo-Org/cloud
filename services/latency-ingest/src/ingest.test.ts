import { readFileSync } from 'node:fs';
// The worker runtime's global `URL` is not the Node one `fileURLToPath` takes,
// so import Node's explicitly to keep the two types identical.
import { fileURLToPath, URL } from 'node:url';
import { isVersionBelow } from '@kilocode/app-shared/app-version';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleLatencyIngest,
  MAX_BATCH_SAMPLES,
  MAX_PAYLOAD_BYTES,
  type LatencyIngestDeps,
} from './ingest.js';
import worker from './index.js';

const ENDPOINT = 'https://latency.kiloapps.io/v1/latency';
const BEARER = 'session-bearer-token-abc123';

/** The worker config that carries the deployed `MIN_APP_VERSION` var. */
const WRANGLER_JSONC = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
/** The app config that carries the version the store build reports. */
const APP_CONFIG_TS = fileURLToPath(new URL('../../../apps/mobile/app.config.ts', import.meta.url));

/**
 * Read the value a deploy would ship. The JSONC file has comments and trailing
 * commas, so a targeted extraction is more robust than a JSON.parse of the raw
 * source; the regex fails loudly if the key is ever renamed.
 */
function readMinAppVersion(): string {
  const source = readFileSync(WRANGLER_JSONC, 'utf8');
  const match = /"MIN_APP_VERSION"\s*:\s*"([^"]+)"/.exec(source);
  if (!match) throw new Error(`MIN_APP_VERSION not found in ${WRANGLER_JSONC}`);
  return match[1];
}

function readAppVersion(): string {
  const source = readFileSync(APP_CONFIG_TS, 'utf8');
  const match = /\bversion:\s*'([^']+)'/.exec(source);
  if (!match) throw new Error(`version not found in ${APP_CONFIG_TS}`);
  return match[1];
}

function sample(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    procedures: ['user.getMe'],
    ttfbMs: 12,
    totalMs: 34,
    status: 200,
    ok: true,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<LatencyIngestDeps> = {}) {
  const lines: Record<string, unknown>[] = [];
  const keys: string[] = [];
  const deps: LatencyIngestDeps = {
    rateLimiter: {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: true };
      },
    },
    minAppVersion: '1.0.12',
    log: line => lines.push(line),
    ...overrides,
  };
  return { deps, lines, keys };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${BEARER}`,
      'x-kilo-app-version': '1.0.12',
      'x-kilo-app-platform': 'ios',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleLatencyIngest routing and auth', () => {
  it('returns 404 on another path', async () => {
    const { deps } = makeDeps();
    const request = new Request('https://latency.kiloapps.io/v1/other', {
      method: 'POST',
      headers: { authorization: `Bearer ${BEARER}`, 'x-kilo-app-version': '1.0.12' },
      body: JSON.stringify({ samples: [sample()] }),
    });

    const response = await handleLatencyIngest(request, deps);

    expect(response.status).toBe(404);
  });

  it('returns 401 without a bearer authorization header', async () => {
    const { deps, lines } = makeDeps();
    const request = new Request(ENDPOINT, {
      method: 'POST',
      headers: { 'x-kilo-app-version': '1.0.12' },
      body: JSON.stringify({ samples: [sample()] }),
    });

    const response = await handleLatencyIngest(request, deps);

    expect(response.status).toBe(401);
    expect(lines).toHaveLength(0);
  });

  it('returns 403 when the app version is missing', async () => {
    const { deps } = makeDeps();
    const request = post({ samples: [sample()] }, { 'x-kilo-app-version': '' });

    const response = await handleLatencyIngest(request, deps);

    expect(response.status).toBe(403);
  });

  it('returns 403 when the app version is malformed', async () => {
    const { deps } = makeDeps();
    const request = post({ samples: [sample()] }, { 'x-kilo-app-version': 'not-a-version' });

    const response = await handleLatencyIngest(request, deps);

    expect(response.status).toBe(403);
  });

  it('returns 403 when the app version is below the minimum', async () => {
    const { deps } = makeDeps();
    const request = post({ samples: [sample()] }, { 'x-kilo-app-version': '1.0.11' });

    const response = await handleLatencyIngest(request, deps);

    expect(response.status).toBe(403);
  });

  it('returns 429 when the limiter rejects the session', async () => {
    const { deps, lines } = makeDeps({
      rateLimiter: { limit: async () => ({ success: false }) },
    });

    const response = await handleLatencyIngest(post({ samples: [sample()] }), deps);

    expect(response.status).toBe(429);
    expect(lines).toHaveLength(0);
  });
});

describe('handleLatencyIngest body validation', () => {
  it('returns 400 on unparseable JSON', async () => {
    const { deps, lines } = makeDeps();

    const response = await handleLatencyIngest(post('{"samples":['), deps);

    expect(response.status).toBe(400);
    expect(lines).toHaveLength(0);
  });

  it('returns 400 on a schema mismatch', async () => {
    const { deps } = makeDeps();
    const request = post({ samples: [{ ...sample(), ttfbMs: '12' }] });

    const response = await handleLatencyIngest(request, deps);

    expect(response.status).toBe(400);
  });

  it('returns 400 on an unknown extra key', async () => {
    const { deps } = makeDeps();
    const request = post({ samples: [sample()], userId: 'should-not-be-accepted' });

    const response = await handleLatencyIngest(request, deps);

    expect(response.status).toBe(400);
  });

  it('returns 413 over the batch sample cap', async () => {
    const { deps, lines } = makeDeps();
    const samples = Array.from({ length: MAX_BATCH_SAMPLES + 1 }, (_, index) =>
      sample({ requestId: `req-${index}` })
    );

    const response = await handleLatencyIngest(post({ samples }), deps);

    expect(response.status).toBe(413);
    expect(lines).toHaveLength(0);
  });

  it('returns 413 over the payload byte cap', async () => {
    const { deps } = makeDeps();
    const request = post({
      samples: [sample({ procedures: ['x'.repeat(MAX_PAYLOAD_BYTES)] })],
    });

    const response = await handleLatencyIngest(request, deps);

    expect(response.status).toBe(413);
  });

  it('aborts the body read as soon as the cap is exceeded', async () => {
    const { deps, lines } = makeDeps();
    const totalChunks = 256;
    let pulled = 0;
    // Chunked transfer encoding: no content-length, so the pre-check is
    // skipped and only the read loop can bound the buffering.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= totalChunks) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const request = new Request(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${BEARER}`,
        'x-kilo-app-version': '1.0.12',
        'content-type': 'application/json',
      },
      body,
      // Node's fetch requires an explicit duplex mode for a streamed body.
      duplex: 'half',
    } as RequestInit);

    const response = await handleLatencyIngest(request, deps);

    expect(response.status).toBe(413);
    expect(lines).toHaveLength(0);
    expect(pulled).toBeLessThan(totalChunks);
  });
});

describe('handleLatencyIngest accepted batches', () => {
  it('returns 204 and logs one line per sample', async () => {
    const { deps, lines } = makeDeps();
    const samples = [sample(), sample({ requestId: 'req-2', procedures: ['activeSessions.list'] })];

    const response = await handleLatencyIngest(post({ samples }), deps);

    expect(response.status).toBe(204);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      type: 'client_latency',
      client: 'mobile',
      platform: 'ios',
      version: '1.0.12',
      requestId: 'req-1',
      procedures: ['user.getMe'],
      batchSize: 2,
      ttfbMs: 12,
      totalMs: 34,
      status: 200,
      ok: true,
    });
    expect(lines[1]).toMatchObject({ requestId: 'req-2', batchSize: 2 });
  });

  it('never logs the bearer or a userId', async () => {
    const { deps, lines } = makeDeps();

    const response = await handleLatencyIngest(post({ samples: [sample()] }), deps);

    expect(response.status).toBe(204);
    expect(JSON.stringify(lines)).not.toContain(BEARER);
    for (const line of lines) {
      expect(line).not.toHaveProperty('userId');
    }
  });

  it('accepts an empty batch with 204 and no lines', async () => {
    const { deps, lines } = makeDeps();

    const response = await handleLatencyIngest(post({ samples: [] }), deps);

    expect(response.status).toBe(204);
    expect(lines).toHaveLength(0);
  });
});

describe('handleLatencyIngest rate-limit key', () => {
  it('keys the limiter on the trusted edge client, not the caller-supplied bearer', async () => {
    const { deps, keys } = makeDeps();

    await handleLatencyIngest(
      post({ samples: [sample()] }, { 'cf-connecting-ip': '203.0.113.7' }),
      deps
    );
    await handleLatencyIngest(
      post(
        { samples: [sample()] },
        { 'cf-connecting-ip': '203.0.113.7', authorization: 'Bearer a-rotated-bearer' }
      ),
      deps
    );
    await handleLatencyIngest(
      post({ samples: [sample()] }, { 'cf-connecting-ip': '198.51.100.9' }),
      deps
    );

    expect(keys).toEqual(['client:203.0.113.7', 'client:203.0.113.7', 'client:198.51.100.9']);
    // A rotated bearer does not mint a fresh bucket for the same client.
    expect(keys[0]).not.toContain(BEARER);
    expect(keys[0]).not.toContain('a-rotated-bearer');
  });

  it('falls back to one shared bucket when the edge header is absent', async () => {
    const { deps, keys } = makeDeps();

    await handleLatencyIngest(post({ samples: [sample()] }), deps);
    await handleLatencyIngest(
      post({ samples: [sample()] }, { authorization: 'Bearer another-bearer' }),
      deps
    );

    expect(keys).toEqual(['client:unknown', 'client:unknown']);
  });
});

describe('worker entrypoint', () => {
  function env(overrides: Partial<CloudflareEnv> = {}): CloudflareEnv {
    return {
      MIN_APP_VERSION: '1.0.12',
      LATENCY_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ...overrides,
    } as unknown as CloudflareEnv;
  }

  it('answers GET /health', async () => {
    const response = await worker.fetch(new Request('https://latency.kiloapps.io/health'), env());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'latency-ingest',
    });
  });

  it('wires the env bindings and logs through the worker', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const response = await worker.fetch(post({ samples: [sample()] }), env());

    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      type: 'client_latency',
      client: 'mobile',
      requestId: 'req-1',
    });
  });
});

describe('MIN_APP_VERSION contract with the mobile app', () => {
  it('accepts the app version this tree builds', () => {
    const minAppVersion = readMinAppVersion();
    const appVersion = readAppVersion();

    expect(isVersionBelow(appVersion, minAppVersion)).toBe(false);
  });
});
