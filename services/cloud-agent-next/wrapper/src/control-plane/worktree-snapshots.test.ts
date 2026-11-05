import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidWorktreeSnapshotError } from '../control/worktree-snapshot.js';
import {
  createWorktreeSnapshots,
  WorktreeSnapshotDownloadError,
  WorktreeSnapshotRestoreError,
  type CapturedWorktreeSnapshot,
  type WorktreeSnapshotClock,
  type WorktreeSnapshotFetch,
} from './worktree-snapshots.js';

const BASE_URL = 'https://control.example/sandbox-worktree-snapshots/sandbox';
const WORKTREE = 'worktree_one';
const DIRECTORY = '/workspace/one';

type FakeTask = { id: number; at: number; run: () => void };

function createFakeClock(start: number) {
  let now = start;
  let sequence = 0;
  const tasks = new Map<number, FakeTask>();
  const clock: WorktreeSnapshotClock = {
    now: () => now,
    setTimeout: (handler, delayMs) => {
      const id = ++sequence;
      tasks.set(id, { id, at: now + Math.max(0, delayMs), run: handler });
      return id;
    },
    clearTimeout: handle => {
      if (typeof handle === 'number') tasks.delete(handle);
    },
  };

  async function settle(): Promise<void> {
    for (let turn = 0; turn < 8; turn += 1)
      await new Promise<void>(resolve => setImmediate(resolve));
  }

  async function advance(ms: number): Promise<void> {
    const target = now + ms;
    while (true) {
      let next: FakeTask | undefined;
      for (const task of tasks.values()) {
        if (task.at > target) continue;
        if (next === undefined || task.at < next.at || (task.at === next.at && task.id < next.id))
          next = task;
      }
      if (next === undefined) break;
      tasks.delete(next.id);
      now = next.at;
      next.run();
      await settle();
    }
    now = target;
    await settle();
  }

  return { clock, advance, settle, tasks };
}

type FetchCall = { url: string; init: RequestInit & { duplex?: 'half' } };

function createFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  calls: FetchCall[];
  fetch: WorktreeSnapshotFetch;
} {
  const calls: FetchCall[] = [];
  const fetch: WorktreeSnapshotFetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetch };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
}

async function driveToSettlement<T>(
  fake: ReturnType<typeof createFakeClock>,
  operation: Promise<T>,
  stepMs = 250,
  maxSteps = 100
): Promise<T> {
  let settled = false;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  void operation.then(
    value => {
      settled = true;
      outcome = { ok: true, value };
    },
    (error: unknown) => {
      settled = true;
      outcome = { ok: false, error };
    }
  );
  for (let step = 0; step < maxSteps && !settled; step += 1) {
    await fake.advance(stepMs);
    await fake.settle();
  }
  for (let turn = 0; turn < 8 && !settled; turn += 1)
    await new Promise<void>(resolve => setImmediate(resolve));
  if (outcome === undefined) throw new Error('operation did not settle within clock budget');
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

const CREDENTIAL = 'signed-launch-credential';

function credential(..._args: number[]): string {
  return CREDENTIAL;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function createSnapshots(
  options: Parameters<typeof createWorktreeSnapshots>[0] = {}
): ReturnType<typeof createWorktreeSnapshots> {
  return createWorktreeSnapshots(options);
}

async function readBody(body: BodyInit | null | undefined): Promise<Buffer> {
  if (body === null || body === undefined) return Buffer.alloc(0);
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
    }
    return Buffer.concat(chunks, size);
  }
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error('unsupported request body');
}

async function temporaryArchive(
  bytes: Buffer
): Promise<{ directory: string; path: string; size: number }> {
  const directory = await mkdtemp(join(tmpdir(), 'worktree-snapshot-test-'));
  const path = join(directory, 'snapshot.tar.gz');
  await writeFile(path, bytes);
  const metadata = await stat(path);
  return { directory, path, size: metadata.size };
}

function captureWith({
  path,
  size,
  contentDigest,
  cleanup,
}: {
  path: string;
  size: number;
  contentDigest: string;
  cleanup?: () => Promise<void>;
}): CapturedWorktreeSnapshot {
  return {
    archivePath: path,
    contentDigest,
    size,
    manifest: {},
    cleanup: cleanup ?? (async () => undefined),
  };
}

describe('worktree snapshot scheduler', () => {
  it('debounces one second and caps continuous signals at fifteen seconds', async () => {
    const first = createFakeClock(1_000_000);
    const firstStarts: number[] = [];
    const firstSnapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(1_000, 9_000_000),
      clock: first.clock,
      capture: async () => {
        firstStarts.push(first.clock.now());
        return null;
      },
      fetch: createFetch(() => new Response(null, { status: 204 })).fetch,
    });
    firstSnapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
    firstSnapshots.requestCapture(DIRECTORY);
    await first.advance(999);
    expect(firstStarts).toHaveLength(0);
    await first.advance(1);
    expect(firstStarts).toEqual([1_001_000]);
    firstSnapshots.close();

    const continuous = createFakeClock(2_000_000);
    const continuousStarts: number[] = [];
    const continuousSnapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(2_000, 9_000_000),
      clock: continuous.clock,
      capture: async () => {
        continuousStarts.push(continuous.clock.now());
        return null;
      },
      fetch: createFetch(() => new Response(null, { status: 204 })).fetch,
    });
    continuousSnapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
    for (let signal = 0; signal < 30; signal += 1) {
      continuousSnapshots.requestCapture(DIRECTORY);
      await continuous.advance(500);
    }
    expect(continuousStarts).toEqual([2_015_000]);
    continuousSnapshots.close();
  });

  it('runs one capture per worktree plus one trailing, globally at most two', async () => {
    const fake = createFakeClock(3_000_000);
    const releases: Array<() => void> = [];
    const starts: string[] = [];
    const running = new Map<string, number>();
    let active = 0;
    let maximum = 0;

    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(3_000, 9_000_000),
      clock: fake.clock,
      capture: async ({ worktreeId }) => {
        starts.push(worktreeId);
        const count = (running.get(worktreeId) ?? 0) + 1;
        if (count > 1) throw new Error('worktree capture overlapped');
        running.set(worktreeId, count);
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>(resolve => releases.push(resolve));
        active -= 1;
        running.set(worktreeId, 0);
        return null;
      },
      fetch: createFetch(() => new Response(null, { status: 204 })).fetch,
    });

    for (const name of ['a', 'b', 'c'])
      snapshots.register({ directory: `/w/${name}`, worktreeId: `worktree_${name}` });
    for (const name of ['a', 'b', 'c']) snapshots.requestCapture(`/w/${name}`);
    await fake.advance(1_000);
    expect(starts).toEqual(['worktree_a', 'worktree_b']);
    expect(maximum).toBe(2);

    snapshots.requestCapture('/w/a');
    await fake.advance(1_000);
    expect(starts).toEqual(['worktree_a', 'worktree_b']);

    releases.shift()?.();
    await fake.settle();
    expect(starts).toEqual(['worktree_a', 'worktree_b', 'worktree_c']);

    releases.shift()?.();
    await fake.settle();
    expect(starts).toEqual(['worktree_a', 'worktree_b', 'worktree_c', 'worktree_a']);

    while (releases.length > 0) {
      releases.shift()?.();
      await fake.settle();
    }
    expect(maximum).toBe(2);
    snapshots.close();
  });

  it('retries failed captures after thirty seconds or on the next signal', async () => {
    const retryClock = createFakeClock(4_000_000);
    let retryAttempts = 0;
    const retrySnapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(4_000, 9_000_000),
      clock: retryClock.clock,
      capture: async () => {
        retryAttempts += 1;
        if (retryAttempts === 1) throw new Error('transient');
        return null;
      },
      fetch: createFetch(() => new Response(null, { status: 204 })).fetch,
    });
    retrySnapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
    retrySnapshots.requestCapture(DIRECTORY);
    await retryClock.advance(1_000);
    expect(retryAttempts).toBe(1);
    await retryClock.advance(29_999);
    expect(retryAttempts).toBe(1);
    await retryClock.advance(1);
    expect(retryAttempts).toBe(2);
    retrySnapshots.close();

    const signalClock = createFakeClock(5_000_000);
    let signalAttempts = 0;
    const signalSnapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(5_000, 9_000_000),
      clock: signalClock.clock,
      capture: async () => {
        signalAttempts += 1;
        throw new Error('transient');
      },
      fetch: createFetch(() => new Response(null, { status: 204 })).fetch,
    });
    signalSnapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
    signalSnapshots.requestCapture(DIRECTORY);
    await signalClock.advance(1_000);
    expect(signalAttempts).toBe(1);
    signalSnapshots.requestCapture(DIRECTORY);
    await signalClock.advance(1_000);
    expect(signalAttempts).toBe(2);
    signalSnapshots.close();
  });

  it('ignores capture requests before registration, after release, and after close', async () => {
    const fake = createFakeClock(6_000_000);
    const starts: number[] = [];
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(6_000, 9_000_000),
      clock: fake.clock,
      capture: async () => {
        starts.push(fake.clock.now());
        return null;
      },
      fetch: createFetch(() => new Response(null, { status: 204 })).fetch,
    });

    snapshots.requestCapture(DIRECTORY);
    await fake.advance(20_000);
    expect(starts).toHaveLength(0);

    snapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
    snapshots.requestCapture(DIRECTORY);
    await fake.advance(1_000);
    expect(starts).toHaveLength(1);

    snapshots.unregister(DIRECTORY);
    snapshots.requestCapture(DIRECTORY);
    await fake.advance(20_000);
    expect(starts).toHaveLength(1);

    snapshots.close();
    snapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
    snapshots.requestCapture(DIRECTORY);
    await fake.advance(20_000);
    expect(starts).toHaveLength(1);
  });

  it('close aborts inflight capture and cancels retries without flushing', async () => {
    const fake = createFakeClock(7_000_000);
    let capturedSignal: AbortSignal | undefined;
    let attempts = 0;
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(7_000, 9_000_000),
      clock: fake.clock,
      capture: async ({ signal }) => {
        attempts += 1;
        capturedSignal = signal;
        await new Promise<void>(resolve =>
          signal.addEventListener('abort', () => resolve(), { once: true })
        );
        return null;
      },
      fetch: createFetch(() => new Response(null, { status: 204 })).fetch,
    });
    snapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
    snapshots.requestCapture(DIRECTORY);
    await fake.advance(1_000);
    expect(attempts).toBe(1);
    snapshots.close();
    expect(capturedSignal?.aborted).toBe(true);
    await fake.advance(40_000);
    expect(attempts).toBe(1);
  });

  it('uses contentDigest for unchanged-skip and the archive bytes digest for R2', async () => {
    const bytes = Buffer.from('archive bytes for upload');
    const archive = await temporaryArchive(bytes);
    const fake = createFakeClock(8_000_000);
    const contentDigests = ['a'.repeat(64), 'a'.repeat(64), 'b'.repeat(64)];
    let cleanupCalls = 0;
    const { calls, fetch } = createFetch(() => new Response(null, { status: 204 }));
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(8_000, 9_000_000),
      clock: fake.clock,
      capture: async () => {
        const contentDigest = contentDigests.shift();
        if (contentDigest === undefined) throw new Error('missing content digest');
        return captureWith({
          path: archive.path,
          size: archive.size,
          contentDigest,
          cleanup: async () => {
            cleanupCalls += 1;
          },
        });
      },
      fetch,
    });
    try {
      snapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
      snapshots.requestCapture(DIRECTORY);
      await fake.advance(1_000);
      await waitFor(() => calls.length === 1);

      const first = calls[0];
      expect(first?.url).toBe(`${BASE_URL}/${WORKTREE}`);
      expect(first?.init.method).toBe('PUT');
      expect(first?.init.duplex).toBe('half');
      expect(first?.init.headers).toMatchObject({
        authorization: `Bearer ${credential(8_000, 9_000_000)}`,
        'content-length': String(archive.size),
        'x-kilo-sha256': sha256(bytes),
      });
      expect(await readBody(first?.init.body)).toEqual(bytes);

      snapshots.requestCapture(DIRECTORY);
      await fake.advance(1_000);
      await fake.settle();
      expect(calls).toHaveLength(1);

      snapshots.requestCapture(DIRECTORY);
      await fake.advance(1_000);
      await waitFor(() => calls.length === 2);
      expect(calls).toHaveLength(2);
      expect(cleanupCalls).toBe(3);
    } finally {
      snapshots.close();
      await rm(archive.directory, { recursive: true, force: true });
    }
  });

  it('bounds capture at twenty seconds and retries thirty seconds later', async () => {
    const fake = createFakeClock(9_000_000);
    let attempts = 0;
    let abortedAt: number | undefined;
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(9_000, 9_000_000),
      clock: fake.clock,
      capture: async ({ signal }) => {
        attempts += 1;
        if (attempts > 1) return null;
        await new Promise<void>(resolve =>
          signal.addEventListener(
            'abort',
            () => {
              abortedAt = fake.clock.now();
              resolve();
            },
            { once: true }
          )
        );
        return null;
      },
      fetch: createFetch(() => new Response(null, { status: 204 })).fetch,
    });
    snapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
    snapshots.requestCapture(DIRECTORY);
    await fake.advance(1_000);
    await fake.advance(19_999);
    expect(abortedAt).toBeUndefined();
    await fake.advance(1);
    expect(abortedAt).toBe(9_021_000);
    await fake.advance(30_000);
    expect(attempts).toBe(2);
    snapshots.close();
  });

  it('bounds upload at sixty seconds and retries thirty seconds later', async () => {
    const bytes = Buffer.from('archive bytes for timeout');
    const archive = await temporaryArchive(bytes);
    const fake = createFakeClock(10_000_000);
    let attempts = 0;
    let puts = 0;
    const { fetch } = createFetch(call => {
      if (call.init.method === 'PUT') {
        puts += 1;
        if (puts === 1) return new Promise<Response>(() => undefined);
      }
      return new Response(null, { status: 204 });
    });
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(10_000, 9_000_000),
      clock: fake.clock,
      capture: async () => {
        attempts += 1;
        return captureWith({
          path: archive.path,
          size: archive.size,
          contentDigest: 'c'.repeat(64),
        });
      },
      fetch,
    });
    try {
      snapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
      snapshots.requestCapture(DIRECTORY);
      await fake.advance(1_000);
      await waitFor(() => puts === 1);
      await fake.advance(60_000);
      expect(attempts).toBe(1);
      await fake.advance(30_000);
      await waitFor(() => puts === 2);
      expect(attempts).toBe(2);
    } finally {
      snapshots.close();
      await rm(archive.directory, { recursive: true, force: true });
    }
  });

  it('retries a conditional upload conflict without deduplicating unaccepted content', async () => {
    const archive = await temporaryArchive(Buffer.from('conditional upload'));
    const fake = createFakeClock(10_000_000);
    let captures = 0;
    let puts = 0;
    const { fetch } = createFetch(() => {
      puts += 1;
      return new Response(null, { status: puts === 1 ? 409 : 204 });
    });
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(10_000, 9_000_000),
      clock: fake.clock,
      capture: async () => {
        captures += 1;
        return captureWith({
          path: archive.path,
          size: archive.size,
          contentDigest: 'c'.repeat(64),
        });
      },
      fetch,
    });
    try {
      snapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
      snapshots.requestCapture(DIRECTORY);
      await fake.advance(1_000);
      await waitFor(() => puts === 1);
      await fake.advance(29_999);
      expect(captures).toBe(1);
      await fake.advance(1);
      await waitFor(() => puts === 2);
      expect(captures).toBe(2);

      snapshots.requestCapture(DIRECTORY);
      await fake.advance(1_000);
      await waitFor(() => captures === 3);
      await fake.settle();
      expect(puts).toBe(2);
    } finally {
      snapshots.close();
      await rm(archive.directory, { recursive: true, force: true });
    }
  });

  it('holds the capture slot until a timed-out capture settles', async () => {
    const fake = createFakeClock(20_000_000);
    const starts: string[] = [];
    const releases = new Map<string, () => void>();
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(20_000, 9_000_000),
      clock: fake.clock,
      capture: async ({ worktreeId }) => {
        starts.push(worktreeId);
        await new Promise<void>(resolve => {
          releases.set(worktreeId, resolve);
        });
        return null;
      },
      fetch: createFetch(() => new Response(null, { status: 204 })).fetch,
    });
    for (const name of ['a', 'b', 'c'])
      snapshots.register({ directory: `/w/${name}`, worktreeId: `worktree_${name}` });
    snapshots.requestCapture('/w/a');
    snapshots.requestCapture('/w/b');
    await fake.advance(1_000);
    expect(starts).toEqual(['worktree_a', 'worktree_b']);

    snapshots.requestCapture('/w/c');
    await fake.advance(1_000);
    expect(starts).toEqual(['worktree_a', 'worktree_b']);

    await fake.advance(19_000);
    expect(starts).toEqual(['worktree_a', 'worktree_b']);

    releases.get('worktree_a')?.();
    await fake.settle();
    expect(starts).toEqual(['worktree_a', 'worktree_b', 'worktree_c']);

    releases.get('worktree_b')?.();
    releases.get('worktree_c')?.();
    await fake.settle();
    snapshots.close();
  });

  it('disables automatic captures after a forbidden upload until re-register', async () => {
    const bytes = Buffer.from('forbidden upload');
    const archive = await temporaryArchive(bytes);
    const fake = createFakeClock(21_000_000);
    let captures = 0;
    let puts = 0;
    const { fetch } = createFetch(call => {
      if (call.init.method === 'PUT') {
        puts += 1;
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204 });
    });
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(21_000, 9_000_000),
      clock: fake.clock,
      capture: async () => {
        captures += 1;
        return captureWith({
          path: archive.path,
          size: archive.size,
          contentDigest: 'e'.repeat(64),
        });
      },
      fetch,
    });
    try {
      snapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
      snapshots.requestCapture(DIRECTORY);
      await fake.advance(1_000);
      await waitFor(() => puts === 1);
      expect(captures).toBe(1);

      await fake.advance(40_000);
      expect(captures).toBe(1);
      snapshots.requestCapture(DIRECTORY);
      await fake.advance(5_000);
      expect(captures).toBe(1);

      snapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
      snapshots.requestCapture(DIRECTORY);
      await fake.advance(1_000);
      await waitFor(() => puts === 2);
      expect(captures).toBe(2);
    } finally {
      snapshots.close();
      await rm(archive.directory, { recursive: true, force: true });
    }
  });
});

describe('worktree snapshot credential lifecycle', () => {
  it('stops captures as revoked after a 401 and resumes with a restarted wrapper credential', async () => {
    const archive = await temporaryArchive(Buffer.from('revoked upload'));
    const firstClock = createFakeClock(40_000_000);
    let firstCaptures = 0;
    let firstPuts = 0;
    const firstFetch = createFetch(call => {
      if (call.init.method === 'PUT') {
        firstPuts += 1;
        return new Response(null, { status: 401 });
      }
      return new Response(null, { status: 204 });
    });
    const first = createSnapshots({
      url: BASE_URL,
      credential: credential(40_000, 9_000_000),
      clock: firstClock.clock,
      capture: async () => {
        firstCaptures += 1;
        return captureWith({
          path: archive.path,
          size: archive.size,
          contentDigest: 'a'.repeat(64),
        });
      },
      fetch: firstFetch.fetch,
    });
    try {
      first.register({ directory: DIRECTORY, worktreeId: WORKTREE });
      first.requestCapture(DIRECTORY);
      await firstClock.advance(1_000);
      await waitFor(() => firstPuts === 1);
      expect(firstCaptures).toBe(1);

      await firstClock.advance(40_000);
      expect(firstCaptures).toBe(1);
      first.requestCapture(DIRECTORY);
      await firstClock.advance(5_000);
      expect(firstCaptures).toBe(1);
      first.register({ directory: DIRECTORY, worktreeId: WORKTREE });
      first.requestCapture(DIRECTORY);
      await firstClock.advance(5_000);
      expect(firstCaptures).toBe(1);
      expect(firstFetch.calls.every(call => call.init.method !== 'POST')).toBe(true);
    } finally {
      first.close();
    }

    const restartedCredential = 'restarted-signed-launch-credential';
    const secondClock = createFakeClock(41_000_000);
    let secondCaptures = 0;
    let secondPuts = 0;
    const secondFetch = createFetch(call => {
      if (call.init.method === 'PUT') secondPuts += 1;
      return new Response(null, { status: 204 });
    });
    const second = createSnapshots({
      url: BASE_URL,
      credential: restartedCredential,
      clock: secondClock.clock,
      capture: async () => {
        secondCaptures += 1;
        return captureWith({
          path: archive.path,
          size: archive.size,
          contentDigest: 'b'.repeat(64),
        });
      },
      fetch: secondFetch.fetch,
    });
    try {
      second.register({ directory: DIRECTORY, worktreeId: WORKTREE });
      second.requestCapture(DIRECTORY);
      await secondClock.advance(1_000);
      await waitFor(() => secondPuts === 1);
      expect(secondCaptures).toBe(1);
      const put = secondFetch.calls.find(call => call.init.method === 'PUT');
      expect(put?.init.headers).toMatchObject({
        authorization: `Bearer ${restartedCredential}`,
      });
      expect(secondFetch.calls.some(call => call.init.method === 'POST')).toBe(false);
    } finally {
      second.close();
      await rm(archive.directory, { recursive: true, force: true });
    }
  });

  it('retries a 503 upload after thirty seconds and recovers without an auth cycle', async () => {
    const archive = await temporaryArchive(Buffer.from('outage upload'));
    const fake = createFakeClock(42_000_000);
    let captures = 0;
    let puts = 0;
    const { calls, fetch } = createFetch(call => {
      if (call.init.method === 'PUT') {
        puts += 1;
        return new Response(null, { status: puts === 1 ? 503 : 204 });
      }
      return new Response(null, { status: 204 });
    });
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(42_000, 9_000_000),
      clock: fake.clock,
      capture: async () => {
        captures += 1;
        return captureWith({
          path: archive.path,
          size: archive.size,
          contentDigest: 'c'.repeat(64),
        });
      },
      fetch,
    });
    try {
      snapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
      snapshots.requestCapture(DIRECTORY);
      await fake.advance(1_000);
      await waitFor(() => puts === 1);
      await fake.advance(29_999);
      expect(puts).toBe(1);
      await fake.advance(1);
      await waitFor(() => puts === 2);
      expect(captures).toBe(2);
      expect(calls.some(call => call.init.method === 'POST')).toBe(false);
    } finally {
      snapshots.close();
      await rm(archive.directory, { recursive: true, force: true });
    }
  });
});

describe('worktree snapshot restore', () => {
  it('cancels a pending capture before restoring', async () => {
    const fake = createFakeClock(10_500_000);
    let attempts = 0;
    const { fetch } = createFetch(() => new Response(null, { status: 404 }));
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(10_500, 9_000_000),
      clock: fake.clock,
      fetch,
      capture: async () => {
        attempts += 1;
        return null;
      },
    });
    snapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
    snapshots.requestCapture(DIRECTORY);
    const result = await snapshots.restore({
      directory: DIRECTORY,
      worktreeId: WORKTREE,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ found: false });
    await fake.advance(40_000);
    expect(attempts).toBe(0);
    snapshots.close();
  });

  it('aborts an inflight capture before restoring', async () => {
    const fake = createFakeClock(10_750_000);
    let attempts = 0;
    let captureSignal: AbortSignal | undefined;
    const { fetch } = createFetch(() => new Response(null, { status: 404 }));
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(10_750, 9_000_000),
      clock: fake.clock,
      fetch,
      capture: async ({ signal }) => {
        attempts += 1;
        captureSignal = signal;
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return null;
      },
    });
    snapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
    snapshots.requestCapture(DIRECTORY);
    await fake.advance(1_000);
    await waitFor(() => attempts === 1);
    const result = await snapshots.restore({
      directory: DIRECTORY,
      worktreeId: WORKTREE,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ found: false });
    expect(captureSignal?.aborted).toBe(true);
    await fake.advance(40_000);
    expect(attempts).toBe(1);
    snapshots.close();
  });

  it('returns not found for 404 without applying', async () => {
    const fake = createFakeClock(11_000_000);
    const { calls, fetch } = createFetch(() => new Response(null, { status: 404 }));
    let applies = 0;
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(11_000, 9_000_000),
      clock: fake.clock,
      fetch,
      apply: async () => {
        applies += 1;
        return { applied: 0, omitted: 0, conflicts: [], partial: false };
      },
    });
    const result = await snapshots.restore({
      directory: DIRECTORY,
      worktreeId: WORKTREE,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ found: false });
    expect(calls).toHaveLength(1);
    expect(applies).toBe(0);
    snapshots.close();
  });

  it('downloads a verified archive, applies it, and removes the temporary file', async () => {
    const bytes = Buffer.from('downloaded archive');
    const fake = createFakeClock(12_000_000);
    const { calls, fetch } = createFetch(
      () =>
        new Response(bytes, {
          status: 200,
          headers: {
            'content-length': String(bytes.length),
            'x-kilo-sha256': sha256(bytes),
          },
        })
    );
    let appliedPath: string | undefined;
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(12_000, 9_000_000),
      clock: fake.clock,
      fetch,
      apply: async input => {
        appliedPath = input.archivePath;
        expect(await readFile(input.archivePath)).toEqual(bytes);
        return { applied: 2, omitted: 1, conflicts: ['conflict.txt'], partial: true };
      },
    });
    const result = await snapshots.restore({
      directory: DIRECTORY,
      worktreeId: WORKTREE,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      found: true,
      applied: 2,
      omitted: 1,
      conflicts: ['conflict.txt'],
      partial: true,
    });
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: `Bearer ${credential(12_000, 9_000_000)}`,
    });
    const cleanupError = await readFile(appliedPath ?? '').catch(error => error);
    expect(cleanupError).toBeInstanceOf(Error);
    snapshots.close();
  });

  it('retries transfer digest mismatches three times before marking invalid', async () => {
    const bytes = Buffer.from('mismatch');
    const fake = createFakeClock(13_000_000);
    const { calls, fetch } = createFetch(
      () =>
        new Response(bytes, {
          status: 200,
          headers: {
            'content-length': String(bytes.length),
            'x-kilo-sha256': 'f'.repeat(64),
          },
        })
    );
    let applies = 0;
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(13_000, 9_000_000),
      clock: fake.clock,
      fetch,
      apply: async () => {
        applies += 1;
        return { applied: 0, omitted: 0, conflicts: [], partial: false };
      },
    });
    const pending = snapshots.restore({
      directory: DIRECTORY,
      worktreeId: WORKTREE,
      signal: new AbortController().signal,
    });
    await waitFor(() => calls.length >= 1);
    const result = await driveToSettlement(fake, pending);
    expect(result).toEqual({ found: true, invalid: true });
    expect(calls).toHaveLength(3);
    expect(applies).toBe(0);
    snapshots.close();
  });

  it('retries a transfer digest mismatch and accepts a later verified download', async () => {
    const bytes = Buffer.from('mismatch then ok');
    const fake = createFakeClock(13_500_000);
    let downloads = 0;
    const { fetch } = createFetch(() => {
      downloads += 1;
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-length': String(bytes.length),
          'x-kilo-sha256': downloads === 1 ? 'f'.repeat(64) : sha256(bytes),
        },
      });
    });
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(13_500, 9_000_000),
      clock: fake.clock,
      fetch,
      apply: async () => ({ applied: 1, omitted: 0, conflicts: [], partial: false }),
    });
    const pending = snapshots.restore({
      directory: DIRECTORY,
      worktreeId: WORKTREE,
      signal: new AbortController().signal,
    });
    await waitFor(() => downloads >= 1);
    const result = await driveToSettlement(fake, pending);
    expect(result).toEqual({
      found: true,
      applied: 1,
      omitted: 0,
      conflicts: [],
      partial: false,
    });
    expect(downloads).toBe(2);
    snapshots.close();
  });

  it('retries a transfer length mismatch and accepts a later verified download', async () => {
    const bytes = Buffer.from('length mismatch');
    const fake = createFakeClock(13_700_000);
    let downloads = 0;
    const { fetch } = createFetch(() => {
      downloads += 1;
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-length': String(bytes.length + (downloads === 1 ? 1 : 0)),
          'x-kilo-sha256': sha256(bytes),
        },
      });
    });
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(13_700, 9_000_000),
      clock: fake.clock,
      fetch,
      apply: async () => ({ applied: 1, omitted: 0, conflicts: [], partial: false }),
    });
    const pending = snapshots.restore({
      directory: DIRECTORY,
      worktreeId: WORKTREE,
      signal: new AbortController().signal,
    });
    await waitFor(() => downloads >= 1);
    const result = await driveToSettlement(fake, pending);
    expect(result).toEqual({
      found: true,
      applied: 1,
      omitted: 0,
      conflicts: [],
      partial: false,
    });
    expect(downloads).toBe(2);
    snapshots.close();
  });

  it('returns invalid when the downloaded object exceeds the size cap', async () => {
    const fake = createFakeClock(14_000_000);
    const { fetch } = createFetch(
      () =>
        new Response('small', {
          status: 200,
          headers: {
            'content-length': String(64 * 1024 * 1024 + 1),
            'x-kilo-sha256': sha256('small'),
          },
        })
    );
    let applies = 0;
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(14_000, 9_000_000),
      clock: fake.clock,
      fetch,
      apply: async () => {
        applies += 1;
        return { applied: 0, omitted: 0, conflicts: [], partial: false };
      },
    });
    const result = await snapshots.restore({
      directory: DIRECTORY,
      worktreeId: WORKTREE,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ found: true, invalid: true });
    expect(applies).toBe(0);
    snapshots.close();
  });

  it('returns invalid when the archive engine rejects the archive', async () => {
    const bytes = Buffer.from('archive');
    const fake = createFakeClock(15_000_000);
    const { fetch } = createFetch(
      () =>
        new Response(bytes, {
          status: 200,
          headers: {
            'content-length': String(bytes.length),
            'x-kilo-sha256': sha256(bytes),
          },
        })
    );
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(15_000, 9_000_000),
      clock: fake.clock,
      fetch,
      apply: async () => {
        throw new InvalidWorktreeSnapshotError('invalid archive');
      },
    });
    const result = await snapshots.restore({
      directory: DIRECTORY,
      worktreeId: WORKTREE,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ found: true, invalid: true });
    snapshots.close();
  });

  it('retries transient download failures three times and then fails preparation', async () => {
    const fake = createFakeClock(16_000_000);
    let attempts = 0;
    const { calls, fetch } = createFetch(() => {
      attempts += 1;
      return new Response(null, { status: 503 });
    });
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(16_000, 9_000_000),
      clock: fake.clock,
      fetch,
      apply: async () => ({ applied: 0, omitted: 0, conflicts: [], partial: false }),
    });
    const pending = snapshots.restore({
      directory: DIRECTORY,
      worktreeId: WORKTREE,
      signal: new AbortController().signal,
    });
    await waitFor(() => attempts >= 1);
    const failure = await driveToSettlement(fake, pending).then(
      () => undefined,
      error => error
    );
    expect(failure).toBeInstanceOf(WorktreeSnapshotDownloadError);
    expect(attempts).toBe(3);
    expect(calls).toHaveLength(3);
    snapshots.close();
  });

  it('retries transient failures and succeeds, but does not retry authorization failures', async () => {
    const bytes = Buffer.from('transient then ok');
    const fake = createFakeClock(17_000_000);
    const outcomes: Array<Response | Error> = [
      new Response(null, { status: 503 }),
      new Error('network down'),
      new Response(bytes, {
        status: 200,
        headers: {
          'content-length': String(bytes.length),
          'x-kilo-sha256': sha256(bytes),
        },
      }),
    ];
    let downloads = 0;
    const { fetch } = createFetch(() => {
      downloads += 1;
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next ?? new Response(null, { status: 404 });
    });
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(17_000, 9_000_000),
      clock: fake.clock,
      fetch,
      apply: async () => ({ applied: 1, omitted: 0, conflicts: [], partial: false }),
    });
    const pending = snapshots.restore({
      directory: DIRECTORY,
      worktreeId: WORKTREE,
      signal: new AbortController().signal,
    });
    await waitFor(() => downloads >= 1);
    const result = await driveToSettlement(fake, pending);
    expect(result).toEqual({
      found: true,
      applied: 1,
      omitted: 0,
      conflicts: [],
      partial: false,
    });
    expect(downloads).toBe(3);
    snapshots.close();

    const deniedClock = createFakeClock(18_000_000);
    const denied = createFetch(() => new Response(null, { status: 401 }));
    const deniedSnapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(18_000, 9_000_000),
      clock: deniedClock.clock,
      fetch: denied.fetch,
      apply: async () => ({ applied: 0, omitted: 0, conflicts: [], partial: false }),
    });
    const deniedFailure = await deniedSnapshots
      .restore({
        directory: DIRECTORY,
        worktreeId: WORKTREE,
        signal: new AbortController().signal,
      })
      .then(
        () => undefined,
        error => error
      );
    expect(deniedFailure).toBeInstanceOf(WorktreeSnapshotDownloadError);
    expect(denied.calls).toHaveLength(1);
    deniedSnapshots.close();
  });

  it('bounds the whole restore at sixty seconds even if apply ignores abort', async () => {
    const bytes = Buffer.from('bounded restore');
    const fake = createFakeClock(19_000_000);
    const { fetch } = createFetch(
      () =>
        new Response(bytes, {
          status: 200,
          headers: {
            'content-length': String(bytes.length),
            'x-kilo-sha256': sha256(bytes),
          },
        })
    );
    let applyStarted = false;
    let releaseApply: (() => void) | undefined;
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(19_000, 9_000_000),
      clock: fake.clock,
      fetch,
      apply: async () => {
        applyStarted = true;
        await new Promise<void>(resolve => {
          releaseApply = resolve;
        });
        return { applied: 0, omitted: 0, conflicts: [], partial: false };
      },
    });
    const pending = snapshots
      .restore({
        directory: DIRECTORY,
        worktreeId: WORKTREE,
        signal: new AbortController().signal,
      })
      .then(
        () => undefined,
        error => error
      );
    await waitFor(() => applyStarted);
    await fake.advance(60_000);
    const failure = await pending;
    expect(failure).toBeInstanceOf(WorktreeSnapshotRestoreError);
    releaseApply?.();
    await fake.settle();
    snapshots.close();
  });

  it('combines the caller abort signal with the restore bound', async () => {
    const bytes = Buffer.from('caller abort restore');
    const fake = createFakeClock(19_500_000);
    const { fetch } = createFetch(
      () =>
        new Response(bytes, {
          status: 200,
          headers: {
            'content-length': String(bytes.length),
            'x-kilo-sha256': sha256(bytes),
          },
        })
    );
    let applyStarted = false;
    let releaseApply: (() => void) | undefined;
    const snapshots = createSnapshots({
      url: BASE_URL,
      credential: credential(19_500, 9_000_000),
      clock: fake.clock,
      fetch,
      apply: async () => {
        applyStarted = true;
        await new Promise<void>(resolve => {
          releaseApply = resolve;
        });
        return { applied: 0, omitted: 0, conflicts: [], partial: false };
      },
    });
    const controller = new AbortController();
    const pending = snapshots
      .restore({
        directory: DIRECTORY,
        worktreeId: WORKTREE,
        signal: controller.signal,
      })
      .then(
        () => undefined,
        error => error
      );
    await waitFor(() => applyStarted);
    const reason = new Error('release');
    controller.abort(reason);
    const failure = await pending;
    expect(failure).toBe(reason);
    releaseApply?.();
    await fake.settle();
    snapshots.close();
  });

  it('is a no-op when the snapshot environment is absent', async () => {
    const snapshots = createSnapshots({});
    expect(
      await snapshots.restore({
        directory: DIRECTORY,
        worktreeId: WORKTREE,
        signal: new AbortController().signal,
      })
    ).toEqual({ found: false });
    snapshots.register({ directory: DIRECTORY, worktreeId: WORKTREE });
    snapshots.requestCapture(DIRECTORY);
    snapshots.unregister(DIRECTORY);
    snapshots.close();
  });
});
