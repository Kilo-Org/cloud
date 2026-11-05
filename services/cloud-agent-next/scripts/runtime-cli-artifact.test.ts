import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactObjectStore } from '../src/sandbox-control/runtime-artifact-keys.js';
import { PINNED_CLIS, downloadVerified, pinnedCliSourceKey } from './runtime-cli-artifact.js';

const tarball = new TextEncoder().encode('fixture tarball');
const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64');
const tarballUrl = 'https://registry.npmjs.org/fixture.tgz';

function registry(responses: Array<() => Response>) {
  const calls: string[] = [];
  const request = vi.fn(async (input: string) => {
    calls.push(input);
    const next = responses.shift();
    if (!next) throw new Error('Unexpected registry request');
    return next();
  });
  return { request: request as unknown as typeof fetch, calls };
}
const metadata = () => Response.json({ dist: { tarball: tarballUrl, integrity } });
const payload = () => new Response(tarball);
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

function memoryStore(initial: Record<string, Uint8Array> = {}) {
  const objects = new Map(Object.entries(initial));
  const store: ArtifactObjectStore = {
    getBytes: vi.fn(async (key: string) => objects.get(key) ?? null),
    putIfAbsent: vi.fn(async (key: string, bytes: Uint8Array) => {
      if (objects.has(key)) return false;
      objects.set(key, bytes);
      return true;
    }),
  };
  return store;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CLI tarball download', () => {
  it('retries a body that times out mid-transfer and verifies the registry integrity', async () => {
    vi.useFakeTimers();
    const { request, calls } = registry([metadata, stalledBody, payload]);
    const download = downloadVerified('0.0.1-fixture', { request });
    await vi.runAllTimersAsync();
    await expect(download).resolves.toEqual(tarball);
    expect(calls).toEqual([
      'https://registry.npmjs.org/@kilocode/cli-linux-x64-baseline/0.0.1-fixture',
      tarballUrl,
      tarballUrl,
    ]);
  });

  it('reports the URL and cause after bounded transport retries', async () => {
    vi.useFakeTimers();
    const { request, calls } = registry([metadata, stalledBody, stalledBody, stalledBody]);
    const download = downloadVerified('0.0.1-fixture', { request });
    const rejection = expect(download).rejects.toMatchObject({
      message: `CLI registry download failed after 3 attempts: ${tarballUrl}`,
      cause: { name: 'TimeoutError' },
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(calls).toHaveLength(4);
  });

  it('does not retry a definitive registry answer', async () => {
    const { request, calls } = registry([() => new Response('missing', { status: 404 })]);
    await expect(downloadVerified('0.0.1-fixture', { request })).rejects.toThrow(
      'CLI registry request failed (404)'
    );
    expect(calls).toHaveLength(1);
  });

  it('never reads or writes the cache for an unpinned version', async () => {
    const cache = memoryStore();
    const { request } = registry([metadata, payload]);
    await expect(downloadVerified('0.0.1-fixture', { cache, request })).resolves.toEqual(tarball);
    expect(cache.getBytes).not.toHaveBeenCalled();
    expect(cache.putIfAbsent).not.toHaveBeenCalled();
  });

  it.each(Object.values(PINNED_CLIS))(
    'keys the pinned cache for $version by version and digest',
    pinned => {
      expect(pinnedCliSourceKey(pinned)).toBe(
        `runtime-artifacts/v1/sources/cli-linux-x64-baseline-${pinned.version}-${pinned.sha256}.tgz`
      );
    }
  );

  it.each(Object.values(PINNED_CLIS))(
    'ignores a corrupt cached tarball for $version and never caches unverified bytes',
    async pinned => {
      const cache = memoryStore({
        [pinnedCliSourceKey(pinned)]: new TextEncoder().encode('corrupt'),
      });
      const { request, calls } = registry([metadata, payload]);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await expect(downloadVerified(pinned.version, { cache, request })).rejects.toThrow(
        'Pinned CLI content hash mismatch'
      );
      expect(calls).toHaveLength(2);
      expect(cache.putIfAbsent).not.toHaveBeenCalled();
    }
  );
});
