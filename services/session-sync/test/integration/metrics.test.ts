import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';

import worker from '../../src/index';
import { grant, personal, testEnv } from '../helpers';

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
