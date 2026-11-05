import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';

import worker from '../../src/index';
import { instrument, jsonResponse } from '../../src/metrics';
import { testEnv } from '../helpers';

afterEach(() => vi.restoreAllMocks());

it.each(['HEAD', 'GET'])('preserves the normal %s / not-found response', async method => {
  const writeDataPoint = vi.fn();
  const request = new Request('https://session-sync.test/', { method });
  const baselineContext = createExecutionContext();
  const baseline = await worker.fetch(request.clone(), testEnv, baselineContext);
  const baselineBody = await baseline.text();
  await waitOnExecutionContext(baselineContext);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    request,
    { ...testEnv, SESSION_SYNC_METRICS: { writeDataPoint } },
    ctx
  );
  expect(response.status).toBe(404);
  expect(response.status).toBe(baseline.status);
  expect(await response.text()).toBe(baselineBody);
  await waitOnExecutionContext(ctx);
  expect(writeDataPoint).toHaveBeenCalledTimes(1);
  expect(writeDataPoint.mock.calls[0]![0]).toMatchObject({
    blobs: ['not_found', '404', method === 'HEAD' ? '' : 'not_found', 'unknown'],
  });
});

it('never reads or wraps a HEAD response body', async () => {
  const writeDataPoint = vi.fn();
  const original = jsonResponse({ error: { code: 'not_found' } }, { status: 404 });
  const clone = vi.spyOn(original, 'clone');
  const ctx = createExecutionContext();
  const response = await instrument(
    new Request('https://session-sync.test/', { method: 'HEAD' }),
    { ...testEnv, SESSION_SYNC_METRICS: { writeDataPoint } },
    ctx,
    () => original
  );
  expect(response).toBe(original);
  expect(clone).not.toHaveBeenCalled();
  await response.text();
  await waitOnExecutionContext(ctx);
  expect(writeDataPoint.mock.calls[0]![0].blobs[2]).toBe('');
});

it.each(['not JSON', '{"error":{"code":"truncated"', ''])(
  'preserves malformed or truncated JSON errors: %j',
  async body => {
    const writeDataPoint = vi.fn();
    const ctx = createExecutionContext();
    const original = new Response(body, {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });
    const response = await instrument(
      new Request('https://session-sync.test/'),
      { ...testEnv, SESSION_SYNC_METRICS: { writeDataPoint } },
      ctx,
      () => original
    );
    expect(response.status).toBe(422);
    expect(await response.text()).toBe(body);
    await waitOnExecutionContext(ctx);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint.mock.calls[0]![0].blobs).toEqual(['not_found', '422', '', 'unknown']);
  }
);

it('returns the original response and logs once when the metrics sink fails', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const writeDataPoint = vi.fn(() => {
    throw new Error('sink unavailable');
  });
  const ctx = createExecutionContext();
  const original = jsonResponse({ error: { code: 'not_found' } }, { status: 404 });
  const response = await instrument(
    new Request('https://session-sync.test/'),
    { ...testEnv, SESSION_SYNC_METRICS: { writeDataPoint } },
    ctx,
    () => original
  );
  expect(response).toBe(original);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: { code: 'not_found' } });
  await waitOnExecutionContext(ctx);
  expect(writeDataPoint).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledExactlyOnceWith('Session sync metrics failed');
});

it('preserves streamed response bytes when the deferred metrics sink fails', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const writeDataPoint = vi.fn(() => {
    throw new Error('sink unavailable');
  });
  const ctx = createExecutionContext();
  const response = await instrument(
    new Request('https://session-sync.test/'),
    { ...testEnv, SESSION_SYNC_METRICS: { writeDataPoint } },
    ctx,
    () => new Response('streamed response', { status: 404 })
  );
  expect(response.status).toBe(404);
  expect(await response.text()).toBe('streamed response');
  await waitOnExecutionContext(ctx);
  expect(writeDataPoint).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledExactlyOnceWith('Session sync metrics failed');
});

it('returns an unlocked original response if metrics background registration fails', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const ctx = createExecutionContext();
  vi.spyOn(ctx, 'waitUntil').mockImplementation(() => {
    throw new Error('background registration failed');
  });
  const original = new Response('untouched', { status: 404 });
  const response = await instrument(
    new Request('https://session-sync.test/'),
    { ...testEnv, SESSION_SYNC_METRICS: { writeDataPoint: vi.fn() } },
    ctx,
    () => original
  );
  expect(response).toBe(original);
  expect(await response.text()).toBe('untouched');
  expect(log).toHaveBeenCalledExactlyOnceWith('Session sync metrics failed');
});

it.each(['HEAD', 'GET'])(
  'keeps Worker %s / responses intact with a failing metrics sink',
  async method => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const writeDataPoint = vi.fn(() => {
      throw new Error('sink unavailable');
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://session-sync.test/', { method }),
      { ...testEnv, SESSION_SYNC_METRICS: { writeDataPoint } },
      ctx
    );
    expect(response.status).toBe(404);
    if (method === 'HEAD') {
      expect(await response.text()).toBe('');
    } else {
      expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    await waitOnExecutionContext(ctx);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledExactlyOnceWith('Session sync metrics failed');
  }
);

it('calls the handler once without metrics if metrics setup fails', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const env = { ...testEnv };
  Object.defineProperty(env, 'SESSION_SYNC_METRICS', {
    get() {
      throw new Error('metrics binding unavailable');
    },
  });
  const original = new Response('original', { status: 404 });
  const handler = vi.fn(() => original);
  const response = await instrument(
    new Request('https://session-sync.test/'),
    env,
    createExecutionContext(),
    handler
  );
  expect(response).toBe(original);
  expect(await response.text()).toBe('original');
  expect(handler).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledExactlyOnceWith('Session sync metrics failed');
});
