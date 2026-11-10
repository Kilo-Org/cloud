import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import worker from '../../src/index';
import { instrument, jsonResponse } from '../../src/metrics';
import { grant, newSessionID, personal, sha256, testEnv } from '../helpers';
import type { Env } from '../../src/env';

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => vi.restoreAllMocks());

it('records one bounded datapoint with actual streamed bytes and no identifiers', async () => {
  const writeDataPoint = vi.fn();
  const ctx = createExecutionContext();
  const user = personal(`metrics-${crypto.randomUUID()}`);
  const body = JSON.stringify({ version: 1, sourceID: crypto.randomUUID() });
  const request = new Request('https://session-sync.test/v1/sessions/ses_metrics', {
    method: 'PUT',
    body,
    headers: { authorization: `Bearer ${await grant(user)}`, 'content-type': 'application/json' },
  });
  const response = await worker.fetch(
    request,
    {
      ...testEnv,
      SESSION_SYNC_METRICS: { writeDataPoint },
    },
    ctx
  );
  expect(response.status).toBe(201);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  expect(writeDataPoint).toHaveBeenCalledTimes(1);
  const point = writeDataPoint.mock.calls[0]![0] as { blobs: string[]; doubles: number[] };
  expect(point.blobs).toEqual(['PUT /v1/sessions/:id', '201', '', 'user']);
  expect(point.doubles[0]).toBeGreaterThanOrEqual(0);
  expect(point.doubles[1]).toBeGreaterThanOrEqual(0);
  expect(point.doubles[4]).toBe(new TextEncoder().encode(body).byteLength);
  expect(point.doubles[5]).toBe(new TextEncoder().encode(text).byteLength);
  expect(JSON.stringify(point)).not.toContain(user.userID);
});

it('records authentication denials without account identifiers', async () => {
  const writeDataPoint = vi.fn();
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request('https://session-sync.test/v1/sessions/ses_metrics'),
    {
      ...testEnv,
      SESSION_SYNC_METRICS: { writeDataPoint },
    },
    ctx
  );
  expect(response.status).toBe(401);
  await response.text();
  await waitOnExecutionContext(ctx);
  expect(writeDataPoint).toHaveBeenCalledTimes(1);
  expect(writeDataPoint.mock.calls[0]![0]).toMatchObject({
    blobs: ['GET /v1/sessions/:id', '401', 'unauthenticated', 'unknown'],
  });
});

it('streams multi-MiB blob PUT and GET unchanged with metrics enabled', async () => {
  const writeDataPoint = vi.fn();
  const env = { ...testEnv, SESSION_SYNC_METRICS: { writeDataPoint } };
  const principal = personal(`large-metrics-${crypto.randomUUID()}`);
  const token = await grant(principal);
  const url = `https://session-sync.test/v1/sessions/${newSessionID()}`;
  const send = async (path: string, init: RequestInit = {}) => {
    const ctx = createExecutionContext();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    const response = await worker.fetch(new Request(path, { ...init, headers }), env, ctx);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await waitOnExecutionContext(ctx);
    return { response, bytes };
  };
  expect(
    (
      await send(url, {
        method: 'PUT',
        body: JSON.stringify({ version: 1, sourceID: crypto.randomUUID() }),
      })
    ).response.status
  ).toBe(201);
  const bytes = new Uint8Array(3 * 1024 * 1024);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const hash = await sha256(bytes);
  const uploaded = await send(`${url}/blobs/${hash}`, {
    method: 'PUT',
    body: bytes,
    headers: { 'content-length': String(bytes.byteLength) },
  });
  expect(uploaded.response.status).toBe(201);
  const downloaded = await send(`${url}/blobs/${hash}`);
  expect(downloaded.response.status).toBe(200);
  expect(downloaded.response.headers.get('content-length')).toBe(String(bytes.byteLength));
  expect(downloaded.bytes.byteLength).toBe(bytes.byteLength);
  expect(downloaded.bytes.every((byte, index) => byte === bytes[index])).toBe(true);
  expect(writeDataPoint).toHaveBeenCalledTimes(3);
  expect(writeDataPoint.mock.calls[1]![0].doubles[4]).toBe(bytes.byteLength);
  expect(writeDataPoint.mock.calls[2]![0].doubles[5]).toBe(bytes.byteLength);
});

it('avoids wrapping declared bodies while preserving byte counts and error codes', async () => {
  const writeDataPoint = vi.fn();
  const ctx = createExecutionContext();
  const text = 'héllo';
  const bytes = new TextEncoder().encode(text).byteLength;
  const request = new Request('https://session-sync.test/v1/sessions/ses_metrics/batches', {
    method: 'POST',
    body: text,
    headers: { 'content-length': String(bytes) },
  });
  const original = jsonResponse(
    { error: { code: 'position_conflict', message: text } },
    { status: 409 }
  );
  const response = await instrument(
    request,
    { ...testEnv, SESSION_SYNC_METRICS: { writeDataPoint } },
    ctx,
    async counted => {
      expect(counted).toBe(request);
      expect(await counted.text()).toBe(text);
      return original;
    }
  );
  expect(response).toBe(original);
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  expect(writeDataPoint).toHaveBeenCalledTimes(1);
  expect(writeDataPoint.mock.calls[0]![0]).toMatchObject({
    blobs: ['POST /v1/sessions/:id/batches', '409', 'position_conflict', 'unknown'],
    doubles: [expect.any(Number), 0, 0, 0, bytes, new TextEncoder().encode(body).byteLength],
  });
});

it('counts unknown-length request and response streams without buffering them', async () => {
  const writeDataPoint = vi.fn();
  const ctx = createExecutionContext();
  const request = new Request('https://session-sync.test/v1/sessions/ses_metrics/batches', {
    method: 'POST',
    body: new Uint8Array(123),
  });
  const response = await instrument(
    request,
    { ...testEnv, SESSION_SYNC_METRICS: { writeDataPoint } },
    ctx,
    async counted => {
      expect((await counted.arrayBuffer()).byteLength).toBe(123);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(17));
            controller.enqueue(new Uint8Array(29));
            controller.close();
          },
        })
      );
    }
  );
  expect((await response.arrayBuffer()).byteLength).toBe(46);
  await waitOnExecutionContext(ctx);
  expect(writeDataPoint.mock.calls[0]![0].doubles.slice(4)).toEqual([123, 46]);
});

it('normalizes account-erasure metrics and exception logs without user identifiers', async () => {
  const writeDataPoint = vi.fn();
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const ctx = createExecutionContext();
  const userID = `oauth/private-${crypto.randomUUID()}`;
  const namespace = testEnv.SESSION_SYNC_TENANT_DO;
  try {
    const response = await worker.fetch(
      new Request(`https://session-sync.test/internal/users/${encodeURIComponent(userID)}/erase`, {
        method: 'POST',
        headers: { 'X-Internal-Secret': 'internal-test-secret-0123456789abcdef' },
      }),
      {
        ...testEnv,
        SESSION_SYNC_METRICS: { writeDataPoint },
        SESSION_SYNC_TENANT_DO: {
          idFromName: namespace.idFromName.bind(namespace),
          get: () => {
            throw new Error('Synthetic internal failure');
          },
        } as unknown as Env['SESSION_SYNC_TENANT_DO'],
      },
      ctx
    );
    expect(response.status).toBe(500);
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(writeDataPoint.mock.calls[0]?.[0]).toMatchObject({
      blobs: ['POST /internal/users/:id/erase', '500', 'internal_error', 'unknown'],
    });
    expect(logged).toHaveBeenCalledWith('session-sync request failed', {
      path: 'POST /internal/users/:id/erase',
      error: 'Error',
    });
    expect(JSON.stringify([logged.mock.calls, writeDataPoint.mock.calls])).not.toContain(userID);
    expect(JSON.stringify([logged.mock.calls, writeDataPoint.mock.calls])).not.toContain(
      encodeURIComponent(userID)
    );
  } finally {
    logged.mockRestore();
  }
});
