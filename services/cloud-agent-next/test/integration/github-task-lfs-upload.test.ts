import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubLfsUploadUrl } from '@kilocode/worker-utils/github-task-lfs';
import { forwardGitHubTaskLfs } from '../../src/github-task-lfs.js';

const batchUrl =
  'https://github.com/na2-org/cloud-agent-security-test-a.git/info/lfs/objects/batch';
const storageUrl = 'https://github-cloud.s3.amazonaws.com/synthetic-object';
const verifyUrl = batchUrl.replace('objects/batch', 'verify');
const authorization = 'Basic synthetic-github-credential';
const ref = 'refs/heads/kilo/task';
const bytes = new TextEncoder().encode('Synthetic LFS publication.');
const object = { oid: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };

const urlOf = (url: string | URL | Request): string =>
  typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

const bodyText = (body: BodyInit | null | undefined): string => {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  throw new Error('Unexpected request body');
};

function upload(body: BodyInit, requested = object) {
  return forwardGitHubTaskLfs({
    request: new Request(githubLfsUploadUrl(batchUrl, requested, ref), { method: 'PUT', body }),
    authorization,
    capability: 'kgh3.synthetic',
  });
}

function fixture(
  options: { existing?: boolean; storageStatus?: number; verifyStatus?: number } = {}
) {
  const received: Uint8Array[] = [];
  let verified = false;
  const upstream = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (urlOf(url) === batchUrl) {
      const batch = JSON.parse(bodyText(init?.body));
      expect(batch).toMatchObject({ operation: 'upload', ref: { name: ref } });
      return Response.json({
        objects: batch.objects.map((item: typeof object) => ({
          ...item,
          ...(options.existing
            ? {}
            : {
                actions: {
                  upload: {
                    href: storageUrl,
                    header: { 'Content-Type': 'application/octet-stream' },
                  },
                  verify: { href: verifyUrl },
                },
              }),
        })),
      });
    }
    if (urlOf(url) === storageUrl) {
      expect(init?.redirect).toBe('manual');
      const storageRequest = new Request(storageUrl, init);
      expect(storageRequest.headers.get('authorization')).toBeNull();
      if (options.storageStatus) {
        return new Response(null, { status: options.storageStatus });
      }
      const reader = storageRequest.body!.getReader();
      // Fetch cancels its upload stream on abort; the stub must model that behavior.
      const abort = () => {
        void reader.cancel(storageRequest.signal.reason).catch(() => undefined);
      };
      storageRequest.signal.addEventListener('abort', abort, { once: true });
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received.push(chunk.value);
        }
        storageRequest.signal.throwIfAborted();
      } finally {
        storageRequest.signal.removeEventListener('abort', abort);
      }
      return new Response(null);
    }
    if (urlOf(url) === verifyUrl) {
      const verifiedObject = JSON.parse(bodyText(init?.body));
      expect(verifiedObject.size).toBe(received.reduce((sum, chunk) => sum + chunk.length, 0));
      expect(new Headers(init?.headers).get('authorization')).toBe(authorization);
      verified = true;
      return new Response(null, { status: options.verifyStatus ?? 200 });
    }
    throw new Error('Unexpected upstream request');
  });
  vi.stubGlobal('fetch', upstream);
  return { upstream, received, verified: () => verified };
}

afterEach(() => vi.unstubAllGlobals());

describe('LFS uploads in the Workers runtime', () => {
  it('streams an exact object and verifies it after storage', async () => {
    const state = fixture();
    expect((await upload(bytes)).status).toBe(200);
    expect(new Uint8Array(state.received.flatMap(chunk => [...chunk]))).toEqual(bytes);
    expect(state.verified()).toBe(true);
    expect(state.upstream).toHaveBeenCalledTimes(3);
  });

  it.each(['digest', 'short', 'long'])(
    'does not complete storage or verify an invalid %s',
    async mode => {
      const state = fixture();
      const body =
        mode === 'short'
          ? bytes.slice(0, -1)
          : mode === 'long'
            ? new Uint8Array(bytes.length + 1)
            : bytes.map(value => value ^ 1);
      await expect(upload(body)).rejects.toThrow(/mismatch|stream/i);
      expect(state.received.reduce((sum, chunk) => sum + chunk.length, 0)).toBeLessThan(
        object.size
      );
      expect(state.verified()).toBe(false);
      expect(state.upstream).toHaveBeenCalledTimes(2);
    }
  );

  it('validates bytes even when another upload already stored the object', async () => {
    const state = fixture({ existing: true });
    expect((await upload(bytes)).status).toBe(200);
    await expect(upload(bytes.map(value => value ^ 1))).rejects.toThrow('digest mismatch');
    expect(state.upstream).toHaveBeenCalledTimes(2);
  });

  it('handles empty objects and rejects a false empty digest before any storage PUT', async () => {
    const state = fixture();
    const empty = { oid: createHash('sha256').digest('hex'), size: 0 };
    expect((await upload(new Uint8Array(), empty)).status).toBe(200);
    expect(state.verified()).toBe(true);
    const previous = state.upstream.mock.calls.length;
    await expect(upload(new Uint8Array(), { ...empty, oid: 'a'.repeat(64) })).rejects.toThrow(
      'digest mismatch'
    );
    expect(state.upstream.mock.calls.length).toBe(previous + 1);
  });

  it('validates fragmented bytes without retaining the complete object', async () => {
    const state = fixture();
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(offset, ++offset));
      },
    });
    expect((await upload(body)).status).toBe(200);
    expect(state.received.length).toBeGreaterThan(1);
    expect(new Uint8Array(state.received.flatMap(chunk => [...chunk]))).toEqual(bytes);
  });

  it.each(['storage', 'existing'])(
    'cancels a held %s upload when its request aborts',
    async mode => {
      const state = fixture({ existing: mode === 'existing' });
      const abort = new AbortController();
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const result = forwardGitHubTaskLfs({
        request: new Request(githubLfsUploadUrl(batchUrl, object, ref), {
          method: 'PUT',
          body,
          signal: abort.signal,
        }),
        authorization,
        capability: 'kgh3.synthetic',
      });
      const rejected = expect(result).rejects.toThrow();
      await vi.waitFor(() =>
        expect(state.upstream).toHaveBeenCalledTimes(mode === 'existing' ? 1 : 2)
      );
      abort.abort();
      await rejected;
      expect(cancel).toHaveBeenCalledOnce();
      expect(state.verified()).toBe(false);
    }
  );

  it('withholds completion until EOF confirms no additional bytes', async () => {
    const state = fixture();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const result = upload(body);
    const completion = expect(result).resolves.toHaveProperty('status', 200);
    controller.enqueue(bytes);
    await vi.waitFor(() =>
      expect(state.received.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(object.size - 1)
    );
    expect(state.verified()).toBe(false);
    controller.close();
    await completion;
    expect(state.verified()).toBe(true);
  });

  it.each([302, 403, 500])('rejects storage HTTP %i and cancels the guest stream', async status => {
    const state = fixture({ storageStatus: status });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(upload(body)).rejects.toThrow(/upload unavailable|cancel/i);
    expect(cancel).toHaveBeenCalledOnce();
    expect(state.verified()).toBe(false);
  });

  it('fails the managed PUT when the upstream verification fails', async () => {
    fixture({ verifyStatus: 403 });
    await expect(upload(bytes)).rejects.toThrow('verification unavailable');
  });
});
