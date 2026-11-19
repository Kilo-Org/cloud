import { describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { createBuilderClient } from './client.js';

describe('archive RPC cancellation', () => {
  it('interrupts an in-flight archive request without retrying', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    let requests = 0;
    const client = createBuilderClient({
      baseUrl: 'https://worker.example.com/build',
      credential: 'synthetic-runner',
      async fetch(_url, init) {
        requests++;
        const signal = init.signal;
        if (!signal) throw new Error('Missing request signal');
        started.resolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    const pending = client.completeArchiveUpload(controller.signal);
    await started.promise;
    controller.abort(new Error('synthetic build cancelled'));
    await rejects(pending, /synthetic build cancelled/);
    expect(requests).toBe(1);
  });
  it('interrupts retry backoff when the build is cancelled', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    let requests = 0;
    const client = createBuilderClient({
      baseUrl: 'https://worker.example.com/build',
      credential: 'synthetic-runner',
      async fetch() {
        requests++;
        started.resolve();
        return new Response(null, { status: 503 });
      },
    });
    const pending = client.completeArchiveUpload(controller.signal);
    await started.promise;
    await Bun.sleep(20);
    const start = Date.now();
    controller.abort(new Error('synthetic build cancelled'));
    await rejects(pending, /aborted|cancelled/);
    expect(Date.now() - start).toBeLessThan(500);
    expect(requests).toBe(1);
  });
});

describe('SCM retirement acknowledgement', () => {
  it('retries an uncertain response with the same authenticated transition', async () => {
    const calls: string[] = [];
    const client = createBuilderClient({
      baseUrl: 'https://worker.example.com/build',
      credential: 'synthetic-runner',
      sleep: async () => undefined,
      async fetch(url, init) {
        calls.push(url);
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({ authorization: 'Bearer synthetic-runner' });
        if (calls.length === 1) throw new Error('response lost');
        return Response.json({ ok: true });
      },
    });
    await client.retireScm();
    expect(calls).toEqual([
      'https://worker.example.com/build/retire-scm',
      'https://worker.example.com/build/retire-scm',
    ]);
  });
});
