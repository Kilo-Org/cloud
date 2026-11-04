import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';

import worker from '../../src/index';
import { grant, newSessionID, personal, sha256, testEnv } from '../helpers';

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
