import { it, expect, vi } from 'vitest';
import { remoteArtifactStore } from './runtime-publish-store.js';
const storeWith = (responses: Array<() => Response>) => {
  const request = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('Unexpected runtime store request');
    return next();
  });
  return {
    request,
    store: remoteArtifactStore({
      accountId: 'a'.repeat(32),
      bucket: 'runtime-test',
      accessKeyId: 'fixture-key',
      secretAccessKey: 'fixture-secret',
      request: request as unknown as typeof fetch,
    }),
  };
};
const store = (code: string) =>
  storeWith([() => new Response('<Error><Code>' + code + '</Code></Error>', { status: 404 })])
    .store;
const payloadKey = 'runtime-artifacts/v1/objects/' + 'c'.repeat(64);
const stalledBody = () =>
  new Response(
    new ReadableStream({
      pull(controller) {
        controller.error(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        );
      },
    })
  );
it('a missing bucket fails instead of waiting for a missing handoff', async () => {
  const { store, request } = storeWith([
    () => new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 }),
  ]);
  await expect(
    store.getBytes('runtime-artifacts/v1/handoffs/' + 'b'.repeat(40) + '.json')
  ).rejects.toThrow('bucket does not exist');
  expect(request).toHaveBeenCalledTimes(1);
});
it('retries a payload body that times out while streaming', async () => {
  const { store, request } = storeWith([
    stalledBody,
    () => new Response(new Uint8Array([1, 2, 3])),
  ]);
  await expect(store.getBytes(payloadKey)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  expect(request).toHaveBeenCalledTimes(2);
});
it('names the request and keeps the cause after bounded retries', { timeout: 10_000 }, async () => {
  const { store, request } = storeWith([stalledBody, stalledBody, stalledBody]);
  await expect(store.getBytes(payloadKey)).rejects.toMatchObject({
    message: `runtime store GET ${payloadKey} failed after 3 attempts`,
    cause: { name: 'TimeoutError' },
  });
  expect(request).toHaveBeenCalledTimes(3);
});
it('reads cached source tarballs with the payload byte cap', async () => {
  const bytes = new Uint8Array(128 * 1024);
  const { store } = storeWith([() => new Response(bytes)]);
  await expect(
    store.getBytes(
      'runtime-artifacts/v1/sources/cli-linux-x64-baseline-1.0.0-' + 'd'.repeat(64) + '.tgz'
    )
  ).resolves.toHaveLength(bytes.byteLength);
});
it('a missing key still means publication can be pending', async () => {
  expect(
    await store('NoSuchKey').getBytes('runtime-artifacts/v1/handoffs/' + 'b'.repeat(40) + '.json')
  ).toBeNull();
});
const handoffKey = 'runtime-artifacts/v1/handoffs/' + 'b'.repeat(40) + '.json';
const upload = (responses: Array<() => Response>) => {
  const { store, request } = storeWith(responses);
  return {
    request,
    put: () => store.putIfAbsent(handoffKey, new Uint8Array([1]), 'application/octet-stream'),
  };
};
it('does not upload when the object already exists', async () => {
  const { put, request } = upload([() => new Response(null, { status: 200 })]);
  await expect(put()).resolves.toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});
it('retries a transient HEAD failure before upload', async () => {
  const { put, request } = upload([
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 200 }),
  ]);
  await expect(put()).resolves.toBe(true);
  expect(request).toHaveBeenCalledTimes(3);
});
it('retries a transient PUT failure', async () => {
  const { put, request } = upload([
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 200 }),
  ]);
  await expect(put()).resolves.toBe(true);
  expect(request).toHaveBeenCalledTimes(3);
});
it('returns false when a retried upload finds the object', async () => {
  const { put, request } = upload([
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 412 }),
  ]);
  await expect(put()).resolves.toBe(false);
  expect(request).toHaveBeenCalledTimes(3);
});
it('does not retry a permanent HEAD failure', async () => {
  const { put, request } = upload([() => new Response(null, { status: 403 })]);
  await expect(put()).rejects.toThrow('runtime store HEAD failed (403)');
  expect(request).toHaveBeenCalledTimes(1);
});
