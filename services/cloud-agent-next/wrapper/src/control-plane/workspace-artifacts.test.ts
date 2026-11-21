import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Dir, Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_ARTIFACT_MAX_FILE_BYTES,
  WORKSPACE_ARTIFACT_MAX_FILES,
  validateWorkspaceArtifactPath,
} from '../../../src/shared/workspace-artifacts.js';
import {
  WORKSPACE_ARTIFACT_MAX_SCAN_ENTRIES,
  createWorkspaceArtifactSync,
  type WorkspaceArtifactSync,
} from './workspace-artifacts.js';
import type {
  SandboxTransferClient,
  SandboxTransferResult,
} from '../control/sandbox-transfer-client.js';

const ALLOCATION = 'alloc_1';

type PutCall = {
  relativePath: string;
  contentLength: number;
  contentHash: string;
  contentType: string;
  body: string;
  signal: AbortSignal;
};

type DeleteCall = { relativePath: string; expectedHash: string };

type FakeClient = SandboxTransferClient & {
  puts: PutCall[];
  deletes: DeleteCall[];
  setGrant(grant: string): void;
};

async function readBody(body: BodyInit): Promise<string> {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body instanceof Blob) return body.text();
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function replaceFileSystemMethod(
  name: 'lstat' | 'opendir' | 'readdir' | 'open',
  replacement: unknown
): void {
  (fsp as unknown as Record<string, unknown>)[name] = replacement;
}

type LazyDirectoryCounters = { pulled: number; closes: number };

function lazyDirectory(
  names: readonly string[],
  counters: LazyDirectoryCounters,
  delayMs = 0
): Dir {
  let index = 0;
  const read = async (): Promise<Dirent | null> => {
    if (index >= names.length) return null;
    if (delayMs > 0) await Bun.sleep(delayMs);
    counters.pulled += 1;
    return { name: names[index++] } as unknown as Dirent;
  };
  async function* iterate(): AsyncGenerator<Dirent> {
    for (;;) {
      const entry = await read();
      if (entry === null) return;
      yield entry;
    }
  }
  return {
    path: '',
    read,
    async close() {
      counters.closes += 1;
    },
    [Symbol.asyncIterator]: iterate,
  } as unknown as Dir;
}

/** Makes both the path stat and the opened-descriptor stat report `frozen` for `target`. */
function freezeSignature(target: string, frozen: object): () => void {
  const originalLstat = fsp.lstat;
  const originalOpen = fsp.open;
  replaceFileSystemMethod('lstat', async (value: string, options: { bigint: boolean }) =>
    value === target ? frozen : originalLstat(value, options as { bigint: true })
  );
  replaceFileSystemMethod('open', async (value: string, flags: number) => {
    const handle = await originalOpen(value, flags);
    if (value === target) handle.stat = (async () => frozen) as unknown as typeof handle.stat;
    return handle;
  });
  return () => {
    replaceFileSystemMethod('lstat', originalLstat);
    replaceFileSystemMethod('open', originalOpen);
  };
}

function diagnosticCount(diagnostics: readonly string[], text: string): number {
  return diagnostics.filter(line => line.includes(text)).length;
}

function queryOf(pathAndQuery: string): URLSearchParams {
  const index = pathAndQuery.indexOf('?');
  return new URLSearchParams(index === -1 ? '' : pathAndQuery.slice(index + 1));
}

function fakeClient(
  options: {
    put?: (call: PutCall) => Promise<SandboxTransferResult>;
    delete?: (call: DeleteCall) => Promise<SandboxTransferResult>;
    grant?: string;
  } = {}
): FakeClient {
  const puts: PutCall[] = [];
  const deletes: DeleteCall[] = [];
  let grant = options.grant ?? 'grant-1';
  const client: FakeClient = {
    puts,
    deletes,
    setGrant(next) {
      grant = next;
    },
    async put(pathAndQuery, input) {
      const query = queryOf(pathAndQuery);
      const body = typeof input.body === 'function' ? await input.body() : input.body;
      const call: PutCall = {
        relativePath: query.get('path') ?? '',
        contentLength: input.contentLength ?? 0,
        contentHash: input.sha256 ?? '',
        contentType: input.contentType ?? '',
        body: await readBody(body),
        signal: input.signal ?? new AbortController().signal,
      };
      puts.push(call);
      return options.put ? options.put(call) : { status: 'ok', statusCode: 200 };
    },
    async delete(pathAndQuery) {
      const query = queryOf(pathAndQuery);
      const call = {
        relativePath: query.get('path') ?? '',
        expectedHash: query.get('hash') ?? '',
      };
      deletes.push(call);
      return options.delete ? options.delete(call) : { status: 'ok', statusCode: 200 };
    },
    setConnected() {},
    currentGrant() {
      return { grant, expiresAt: 0 };
    },
    stop() {},
  };
  return client;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await Bun.sleep(2);
  }
}

async function createFixture(
  files: Record<string, string> = {},
  client: FakeClient = fakeClient(),
  scanIntervalMs = 3_600_000,
  stopBudgetMs?: number
) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'workspace-artifacts-'));
  const artifacts = path.join(root, 'artifacts');
  const statePath = path.join(root, 'state', 'workspace-artifacts.json');
  await fsp.mkdir(artifacts, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(artifacts, relativePath);
    await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
    await fsp.writeFile(absolutePath, content);
  }
  const logs: string[] = [];
  const diagnostics: string[] = [];
  let sync: WorkspaceArtifactSync | undefined;
  const create = (allocationId = ALLOCATION) => {
    sync = createWorkspaceArtifactSync({
      root: artifacts,
      statePath,
      allocationId,
      client,
      timers: {
        setTimeout: (handler, ms) => setTimeout(handler, ms),
        clearTimeout: handle => clearTimeout(handle),
      },
      log: message => logs.push(message),
      onDiagnostic: message => diagnostics.push(message),
      scanIntervalMs,
      ...(stopBudgetMs === undefined ? {} : { stopBudgetMs }),
    });
    return sync;
  };
  const state = async () => JSON.parse(await fsp.readFile(statePath, 'utf8'));
  return {
    root,
    artifacts,
    statePath,
    client,
    logs,
    diagnostics,
    create,
    state,
    async startBaseline(allocationId = ALLOCATION): Promise<WorkspaceArtifactSync> {
      const created = create(allocationId);
      created.start();
      await waitFor(() => logs.some(line => line.includes('baselined')), 'baseline scan');
      return created;
    },
    async cleanup(): Promise<void> {
      await sync?.stop();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

describe('workspace artifact synchronizer baseline', () => {
  it('publishes nothing when a fresh allocation starts with an empty folder', async () => {
    const fixture = await createFixture();
    try {
      const sync = await fixture.startBaseline();
      await sync.flush(5_000);
      expect(fixture.client.puts).toEqual([]);
      expect(fixture.client.deletes).toEqual([]);
      expect(await fixture.state()).toMatchObject({ allocationId: ALLOCATION, files: {} });
    } finally {
      await fixture.cleanup();
    }
  });

  it('baselines a stale tail-snapshot folder then publishes only observed changes', async () => {
    const fixture = await createFixture({ 'report.txt': 'baseline', 'notes/a.md': 'a' });
    try {
      const sync = await fixture.startBaseline();
      expect(fixture.client.puts).toEqual([]);
      expect(fixture.client.deletes).toEqual([]);

      await fsp.writeFile(path.join(fixture.artifacts, 'report.txt'), 'changed');
      await sync.flush(5_000);
      expect(fixture.client.puts.map(call => call.relativePath)).toEqual(['report.txt']);
      expect(fixture.client.puts[0]?.contentHash).toBe(sha256('changed'));
      expect(fixture.client.puts[0]?.contentLength).toBe(7);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not re-upload a baseline file that stays unchanged', async () => {
    const fixture = await createFixture({ 'report.txt': 'baseline' });
    try {
      const sync = await fixture.startBaseline();
      await sync.flush(5_000);
      await sync.flush(5_000);
      expect(fixture.client.puts).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not overwrite newer storage when a baseline file only changes metadata', async () => {
    const fixture = await createFixture({ 'report.txt': 'baseline' });
    try {
      const sync = await fixture.startBaseline();
      const file = path.join(fixture.artifacts, 'report.txt');
      const later = new Date(Date.now() + 5_000);
      await fsp.utimes(file, later, later);
      await sync.flush(5_000);
      expect(fixture.client.puts).toEqual([]);

      await fsp.writeFile(file, 'genuinely changed');
      await sync.flush(5_000);
      expect(fixture.client.puts.map(call => call.relativePath)).toEqual(['report.txt']);
      expect(fixture.client.puts[0]?.contentHash).toBe(sha256('genuinely changed'));
    } finally {
      await fixture.cleanup();
    }
  });

  it('publishes a changed file only after two complete background scans', async () => {
    const client = fakeClient();
    const fixture = await createFixture({ 'report.txt': 'baseline' }, client, 15);
    try {
      await fixture.startBaseline();
      await fsp.writeFile(path.join(fixture.artifacts, 'report.txt'), 'changed');
      await waitFor(() => client.puts.length === 1, 'two background scans');
      expect(client.puts[0]?.contentHash).toBe(sha256('changed'));
    } finally {
      await fixture.cleanup();
    }
  });

  it('deletes a disappeared baseline file only after two complete scans, fenced by its baseline hash', async () => {
    const fixture = await createFixture({ 'report.txt': 'baseline' });
    try {
      const sync = await fixture.startBaseline();
      await fsp.rm(path.join(fixture.artifacts, 'report.txt'));
      await sync.flush(5_000);
      expect(fixture.client.deletes).toEqual([]);
      await sync.flush(5_000);
      expect(fixture.client.deletes).toEqual([
        { relativePath: 'report.txt', expectedHash: sha256('baseline') },
      ]);
      expect((await fixture.state()).files).toEqual({});
    } finally {
      await fixture.cleanup();
    }
  });

  it('resumes a same-allocation state file and publishes files that changed while down', async () => {
    const fixture = await createFixture({ 'report.txt': 'baseline' });
    try {
      const first = await fixture.startBaseline();
      await first.stop();

      await fsp.writeFile(path.join(fixture.artifacts, 'report.txt'), 'changed while down');
      const second = fixture.create();
      second.start();
      await Bun.sleep(50);
      await second.flush(5_000);
      expect(fixture.client.puts.map(call => call.relativePath)).toEqual(['report.txt']);
      expect(fixture.client.puts[0]?.contentHash).toBe(sha256('changed while down'));
    } finally {
      await fixture.cleanup();
    }
  });

  it('starts a new baseline when the state file belongs to another allocation', async () => {
    const fixture = await createFixture({ 'report.txt': 'baseline' });
    try {
      const first = await fixture.startBaseline('alloc_old');
      await first.stop();
      await fsp.writeFile(path.join(fixture.artifacts, 'report.txt'), 'new snapshot');

      const second = await fixture.startBaseline('alloc_new');
      expect(fixture.client.puts).toEqual([]);
      await second.flush(5_000);
      expect(fixture.client.puts).toEqual([]);
      expect((await fixture.state()).allocationId).toBe('alloc_new');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('workspace artifact synchronizer scan rules', () => {
  it('uploads new files with their content hash and skips an unchanged content rewrite', async () => {
    const fixture = await createFixture();
    try {
      const sync = await fixture.startBaseline();
      const file = path.join(fixture.artifacts, 'reports', 'summary.pdf');
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, 'pdf-bytes');
      await sync.flush(5_000);
      expect(fixture.client.puts).toHaveLength(1);
      expect(fixture.client.puts[0]?.relativePath).toBe('reports/summary.pdf');
      expect(fixture.client.puts[0]?.contentType).toBe('application/pdf');
      expect(fixture.client.puts[0]?.contentHash).toBe(sha256('pdf-bytes'));

      const later = new Date(Date.now() + 5_000);
      await fsp.utimes(file, later, later);
      await sync.flush(5_000);
      expect(fixture.client.puts).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not re-upload a published local file that is unchanged after a remote deletion', async () => {
    const fixture = await createFixture();
    try {
      const sync = await fixture.startBaseline();
      await fsp.writeFile(path.join(fixture.artifacts, 'keep.txt'), 'keep');
      await sync.flush(5_000);
      expect(fixture.client.puts).toHaveLength(1);

      // The user deleted the artifact in the view; the local copy and state are unchanged.
      await sync.flush(5_000);
      await sync.flush(5_000);
      expect(fixture.client.puts).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not block a new upload when the local published count is at the cap', async () => {
    const client = fakeClient();
    const fixture = await createFixture({}, client);
    try {
      const published: Record<string, unknown> = {};
      for (let index = 0; index < WORKSPACE_ARTIFACT_MAX_FILES; index += 1) {
        const name = `published-${index}.txt`;
        const absolutePath = path.join(fixture.artifacts, name);
        await fsp.writeFile(absolutePath, 'x');
        const stat = await fsp.lstat(absolutePath, { bigint: true });
        published[name] = {
          size: 1,
          mtimeNs: stat.mtimeNs.toString(),
          ctimeNs: stat.ctimeNs.toString(),
          inode: stat.ino.toString(),
          hash: 'a'.repeat(64),
          publishedHash: 'a'.repeat(64),
        };
      }
      await fsp.mkdir(path.dirname(fixture.statePath), { recursive: true });
      await fsp.writeFile(
        fixture.statePath,
        JSON.stringify({ version: 1, allocationId: ALLOCATION, files: published })
      );
      const sync = fixture.create();
      await fsp.writeFile(path.join(fixture.artifacts, 'new.txt'), 'new');

      await sync.flush(30_000);
      expect(client.puts.map(call => call.relativePath)).toEqual(['new.txt']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('never publishes or counts excluded segments and does not traverse symlinks', async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'workspace-artifacts-outside-'));
    const fixture = await createFixture({
      'ok.txt': 'ok',
      'node_modules/pkg/index.js': 'dependency',
      '__pycache__/cache.pyc': 'cache',
      'venv/bin/python': 'venv',
      '.hidden/secret.txt': 'hidden',
      '.secret': 'secret',
    });
    try {
      await fsp.writeFile(path.join(outside, 'outside.txt'), 'outside');
      await fsp.symlink(
        path.join(outside, 'outside.txt'),
        path.join(fixture.artifacts, 'link.txt')
      );
      execFileSync('mkfifo', [path.join(fixture.artifacts, 'pipe.fifo')]);
      const sync = await fixture.startBaseline();
      await sync.flush(5_000);

      expect(fixture.client.puts).toEqual([]);
      const stored = await fixture.state();
      expect(Object.keys(stored.files)).toEqual(['ok.txt']);
      expect(fixture.diagnostics.join('\n')).toContain('link.txt (symlink)');
      expect(fixture.diagnostics.join('\n')).toContain('pipe.fifo (special_file)');

      await fsp.writeFile(path.join(fixture.artifacts, 'node_modules/pkg/index.js'), 'changed');
      await fsp.writeFile(path.join(fixture.artifacts, '.hidden/secret.txt'), 'changed');
      await sync.flush(5_000);
      expect(fixture.client.puts).toEqual([]);
    } finally {
      await fixture.cleanup();
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('skips files over the per-file cap without publishing or deleting them', async () => {
    const fixture = await createFixture();
    try {
      const sync = await fixture.startBaseline();
      const file = path.join(fixture.artifacts, 'huge.bin');
      await fsp.writeFile(file, 'x');
      await fsp.truncate(file, WORKSPACE_ARTIFACT_MAX_FILE_BYTES + 1);
      await sync.flush(5_000);
      expect(fixture.client.puts).toEqual([]);
      expect(fixture.client.deletes).toEqual([]);
      expect(fixture.diagnostics.join('\n')).toContain('huge.bin (file_too_large)');
    } finally {
      await fixture.cleanup();
    }
  });

  it('treats a missing root as a scan error, never as an empty folder', async () => {
    const fixture = await createFixture({ 'report.txt': 'baseline' });
    try {
      const sync = await fixture.startBaseline();
      await fsp.rm(fixture.artifacts, { recursive: true, force: true });
      await sync.flush(5_000);
      await sync.flush(5_000);
      expect(fixture.client.deletes).toEqual([]);
      expect(fixture.diagnostics.join('\n')).toContain('scan failed');
    } finally {
      await fixture.cleanup();
    }
  });

  it('discards an upload whose file changes before the request returns', async () => {
    let artifacts = '';
    let mutated = false;
    const syncClient = fakeClient({
      async put(call) {
        if (!mutated) {
          mutated = true;
          await fsp.appendFile(path.join(artifacts, call.relativePath), '-more');
        }
        return { status: 'ok', statusCode: 200 };
      },
    });
    const fixture = await createFixture({}, syncClient);
    artifacts = fixture.artifacts;
    try {
      const sync = await fixture.startBaseline();
      await fsp.writeFile(path.join(fixture.artifacts, 'live.txt'), 'first');
      await sync.flush(5_000);
      expect(syncClient.puts).toHaveLength(1);
      expect((await fixture.state()).files['live.txt']?.publishedHash).toBeUndefined();

      await sync.flush(5_000);
      expect(syncClient.puts.length).toBeGreaterThanOrEqual(2);
      expect((await fixture.state()).files['live.txt']?.publishedHash).toBe(sha256('first-more'));
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('workspace artifact synchronizer failures and bounds', () => {
  it('stops on a stale 409 and makes no further requests', async () => {
    const client = fakeClient({
      put: async () => ({ status: 'rejected', statusCode: 409 }),
    });
    const fixture = await createFixture({}, client);
    try {
      const sync = await fixture.startBaseline();
      await fsp.writeFile(path.join(fixture.artifacts, 'new.txt'), 'new');
      await sync.flush(5_000);
      expect(client.puts).toHaveLength(1);
      await fsp.writeFile(path.join(fixture.artifacts, 'another.txt'), 'another');
      await sync.flush(5_000);
      expect(client.puts).toHaveLength(1);
      expect(fixture.diagnostics.join('\n')).toContain('stale allocation');
    } finally {
      await fixture.cleanup();
    }
  });

  it('backs off the rest of a scan when storage is unavailable', async () => {
    const client = fakeClient({
      put: async () => ({ status: 'unavailable', reason: 'network' }),
    });
    const fixture = await createFixture({}, client);
    try {
      const sync = await fixture.startBaseline();
      await fsp.writeFile(path.join(fixture.artifacts, 'a.txt'), 'a');
      await fsp.writeFile(path.join(fixture.artifacts, 'b.txt'), 'b');
      await sync.flush(5_000);
      expect(client.puts).toHaveLength(1);
      expect((await fixture.state()).files['a.txt']).toBeUndefined();
      expect((await fixture.state()).files['b.txt']).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('pauses on a 401 after the transfer client has renewed, then resumes when the grant changes', async () => {
    let rejecting = true;
    const client = fakeClient({
      put: async () =>
        rejecting ? { status: 'rejected', statusCode: 401 } : { status: 'ok', statusCode: 200 },
    });
    const fixture = await createFixture({}, client);
    try {
      const sync = await fixture.startBaseline();
      await fsp.writeFile(path.join(fixture.artifacts, 'new.txt'), 'new');
      await sync.flush(5_000);
      expect(client.puts).toHaveLength(1);
      expect(fixture.diagnostics.join('\n')).toContain('paused after rejection');

      await sync.flush(5_000);
      expect(client.puts).toHaveLength(1);

      client.setGrant('grant-2');
      rejecting = false;
      await sync.flush(5_000);
      expect(client.puts).toHaveLength(2);
      expect((await fixture.state()).files['new.txt']?.publishedHash).toBe(sha256('new'));
    } finally {
      await fixture.cleanup();
    }
  });

  it('bounds a flush with a hanging transfer request', async () => {
    const client = fakeClient({
      put: async call =>
        await new Promise<SandboxTransferResult>(resolve => {
          call.signal.addEventListener(
            'abort',
            () => resolve({ status: 'unavailable', reason: 'aborted' }),
            { once: true }
          );
        }),
    });
    const fixture = await createFixture({}, client);
    try {
      const sync = await fixture.startBaseline();
      await fsp.writeFile(path.join(fixture.artifacts, 'slow.txt'), 'slow');
      const startedAt = Date.now();
      const flushing = sync.flush(50);
      expect(sync.isFlushing()).toBe(true);
      await flushing;
      expect(sync.isFlushing()).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(client.puts).toHaveLength(1);
      expect((await fixture.state()).files['slow.txt']).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('stops its loop and in-flight scan without publishing', async () => {
    const client = fakeClient({
      put: async call =>
        await new Promise<SandboxTransferResult>(resolve => {
          call.signal.addEventListener(
            'abort',
            () => resolve({ status: 'unavailable', reason: 'aborted' }),
            { once: true }
          );
        }),
    });
    const fixture = await createFixture({}, client);
    try {
      const sync = await fixture.startBaseline();
      await fsp.writeFile(path.join(fixture.artifacts, 'slow.txt'), 'slow');
      const flushing = sync.flush(30_000);
      await waitFor(() => client.puts.length === 1, 'upload start');
      await sync.stop();
      await flushing;
      expect(sync.isFlushing()).toBe(false);
      expect((await fixture.state()).files['slow.txt']).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('workspace artifact synchronizer entry swaps', () => {
  async function swapOnFirstOpen(target: string, swap: () => Promise<void>): Promise<() => void> {
    const originalOpen = fsp.open;
    let swapped = false;
    replaceFileSystemMethod('open', async (value: string, flags: number) => {
      if (value === target && !swapped) {
        swapped = true;
        await swap();
      }
      return originalOpen(value, flags);
    });
    return () => replaceFileSystemMethod('open', originalOpen);
  }

  it('does not block on a FIFO swapped in after enumeration', async () => {
    const fixture = await createFixture();
    const target = path.join(fixture.artifacts, 'pipe.txt');
    let restore = (): void => undefined;
    try {
      const sync = await fixture.startBaseline();
      await fsp.writeFile(target, 'regular');
      restore = await swapOnFirstOpen(target, async () => {
        await fsp.rm(target);
        execFileSync('mkfifo', [target]);
      });
      const startedAt = Date.now();
      await sync.flush(30_000);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(fixture.client.puts).toEqual([]);
    } finally {
      restore();
      await fixture.cleanup();
    }
  });

  it('does not follow a symlink swapped in after enumeration', async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'workspace-artifacts-outside-'));
    const fixture = await createFixture();
    const target = path.join(fixture.artifacts, 'report.txt');
    let restore = (): void => undefined;
    try {
      await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret!');
      const sync = await fixture.startBaseline();
      await fsp.writeFile(target, 'report!');
      restore = await swapOnFirstOpen(target, async () => {
        await fsp.rm(target);
        await fsp.symlink(path.join(outside, 'secret.txt'), target);
      });
      await sync.flush(5_000);
      expect(fixture.client.puts).toEqual([]);
    } finally {
      restore();
      await fixture.cleanup();
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('does not read through a parent directory swapped for a symlink', async () => {
    const fixture = await createFixture();
    const directory = path.join(fixture.artifacts, 'sub');
    const target = path.join(directory, 'file.txt');
    let restore = (): void => undefined;
    try {
      const sync = await fixture.startBaseline();
      await fsp.mkdir(directory);
      await fsp.writeFile(target, 'content');
      restore = await swapOnFirstOpen(target, async () => {
        await fsp.rename(directory, `${directory}-moved`);
        await fsp.symlink(`${directory}-moved`, directory);
      });
      await sync.flush(5_000);
      expect(fixture.client.puts).toEqual([]);
      expect(fixture.logs.join('\n')).toContain('changed before reading: sub/file.txt');
    } finally {
      restore();
      await fixture.cleanup();
    }
  });

  it('fails a scan that exceeds the entry cap without deleting anything', async () => {
    const fixture = await createFixture({ 'keep.txt': 'keep' });
    try {
      const sync = await fixture.startBaseline();
      const flood = path.join(fixture.artifacts, 'flood');
      await fsp.mkdir(flood);
      await Promise.all(
        Array.from({ length: WORKSPACE_ARTIFACT_MAX_SCAN_ENTRIES }, (_, index) =>
          fsp.writeFile(path.join(flood, `f${index}`), '')
        )
      );
      await fsp.rm(path.join(fixture.artifacts, 'keep.txt'));
      await sync.flush(5_000);
      await sync.flush(5_000);
      expect(fixture.client.puts).toEqual([]);
      expect(fixture.client.deletes).toEqual([]);
      expect(fixture.diagnostics.join('\n')).toContain(
        'scan failed: artifact folder has more than'
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('iterates a huge directory lazily and stops at the entry cap', async () => {
    const fixture = await createFixture();
    const originalOpendir = fsp.opendir;
    const originalReaddir = fsp.readdir;
    const names = Array.from(
      { length: WORKSPACE_ARTIFACT_MAX_SCAN_ENTRIES + 1_000 },
      (_, index) => `.entry-${index}`
    );
    const counters: LazyDirectoryCounters = { pulled: 0, closes: 0 };
    try {
      const sync = await fixture.startBaseline();
      replaceFileSystemMethod('opendir', (target: string) =>
        target === fixture.artifacts
          ? Promise.resolve(lazyDirectory(names, counters))
          : originalOpendir(target)
      );
      replaceFileSystemMethod('readdir', () =>
        Promise.reject(new Error('readdir must not be used'))
      );

      await sync.flush(5_000);
      expect(counters.pulled).toBe(WORKSPACE_ARTIFACT_MAX_SCAN_ENTRIES + 1);
      expect(counters.pulled).toBeLessThan(names.length);
      expect(counters.closes).toBeGreaterThanOrEqual(1);
      expect(fixture.diagnostics.join('\n')).toContain(
        'scan failed: artifact folder has more than'
      );
      expect(fixture.client.puts).toEqual([]);
      expect(fixture.client.deletes).toEqual([]);
    } finally {
      replaceFileSystemMethod('opendir', originalOpendir);
      replaceFileSystemMethod('readdir', originalReaddir);
      await fixture.cleanup();
    }
  });

  it('closes the directory handle when a flush budget aborts a scan', async () => {
    const fixture = await createFixture();
    const originalOpendir = fsp.opendir;
    const names = Array.from({ length: 100 }, (_, index) => `entry-${index}`);
    const counters: LazyDirectoryCounters = { pulled: 0, closes: 0 };
    try {
      const sync = await fixture.startBaseline();
      replaceFileSystemMethod('opendir', (target: string) =>
        target === fixture.artifacts
          ? Promise.resolve(lazyDirectory(names, counters, 10))
          : originalOpendir(target)
      );

      await sync.flush(100);
      expect(counters.pulled).toBeGreaterThan(0);
      expect(counters.pulled).toBeLessThan(names.length);
      expect(counters.closes).toBeGreaterThanOrEqual(1);
    } finally {
      replaceFileSystemMethod('opendir', originalOpendir);
      await fixture.cleanup();
    }
  });

  it('bounds stop when an in-flight transfer ignores abort', async () => {
    let release = (): void => undefined;
    const client = fakeClient({
      put: () =>
        new Promise<SandboxTransferResult>(resolve => {
          release = () => resolve({ status: 'unavailable', reason: 'aborted' });
        }),
    });
    const fixture = await createFixture({}, client, 3_600_000, 50);
    try {
      const sync = await fixture.startBaseline();
      await fsp.writeFile(path.join(fixture.artifacts, 'stuck.txt'), 'stuck');
      void sync.flush(30_000);
      await waitFor(() => client.puts.length === 1, 'upload start');
      const startedAt = Date.now();
      await sync.stop();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(fixture.logs.join('\n')).toContain('stop budget expired');
    } finally {
      // Let the abandoned upload settle so it closes its file descriptor.
      release();
      await Bun.sleep(10);
      await fixture.cleanup();
    }
  });
});

describe('workspace artifact synchronizer unreadable entries', () => {
  it('keeps scanning when one entry cannot be stat-ed and does not delete it', async () => {
    const fixture = await createFixture({ 'good.txt': 'good', 'fragile.txt': 'fragile' });
    const originalLstat = fsp.lstat;
    let failFragile = false;
    try {
      const sync = await fixture.startBaseline();
      await fsp.writeFile(path.join(fixture.artifacts, 'good.txt'), 'changed');
      replaceFileSystemMethod('lstat', (target: string, options: { bigint: boolean }) => {
        if (failFragile && target.endsWith(`${path.sep}fragile.txt`)) {
          return Promise.reject(new Error('EACCES: permission denied'));
        }
        return originalLstat(target, options as { bigint: true });
      });
      failFragile = true;

      await sync.flush(5_000);
      expect(fixture.client.puts.map(call => call.relativePath)).toEqual(['good.txt']);

      await sync.flush(5_000);
      expect(fixture.client.deletes).toEqual([]);
      expect(fixture.diagnostics.join('\n')).toContain('fragile.txt (unreadable:');
    } finally {
      replaceFileSystemMethod('lstat', originalLstat);
      await fixture.cleanup();
    }
  });

  it('retries a publish read failure without waiting for a signature change', async () => {
    const fixture = await createFixture();
    const originalOpen = fsp.open;
    const target = path.join(fixture.artifacts, 'flaky.txt');
    let failed = false;
    try {
      const sync = await fixture.startBaseline();
      await fsp.writeFile(target, 'first!!');
      replaceFileSystemMethod('open', async (value: string, flags: number) => {
        if (value === target && !failed) {
          failed = true;
          throw new Error('EIO: i/o error');
        }
        return originalOpen(value, flags);
      });

      await sync.flush(5_000);
      expect(fixture.client.puts).toEqual([]);
      expect(fixture.diagnostics.join('\n')).toContain('flaky.txt (unreadable:');

      await sync.flush(5_000);
      expect(fixture.client.puts.map(call => call.relativePath)).toEqual(['flaky.txt']);
      expect(fixture.client.puts[0]?.contentHash).toBe(sha256('first!!'));
    } finally {
      replaceFileSystemMethod('open', originalOpen);
      await fixture.cleanup();
    }
  });

  it.each(['open', 'read'])(
    'keeps uploading unrelated files and retains tracked files after a directory %s failure',
    async failure => {
      const fixture = await createFixture({ 'sub/keep.txt': 'keep', 'other.txt': 'other' });
      const originalOpendir = fsp.opendir;
      const unreadable = path.join(fixture.artifacts, 'sub');
      try {
        const sync = await fixture.startBaseline();
        await fsp.writeFile(path.join(fixture.artifacts, 'other.txt'), 'changed');
        replaceFileSystemMethod('opendir', async (target: string) => {
          if (target === unreadable) {
            if (failure === 'open') throw new Error('EACCES: permission denied');
            const handle = await originalOpendir(target);
            Object.defineProperty(handle, 'read', {
              value: () => Promise.reject(new Error('EACCES: permission denied')),
            });
            return handle;
          }
          return originalOpendir(target);
        });

        await sync.flush(5_000);
        expect(fixture.client.puts.map(call => call.relativePath)).toEqual(['other.txt']);

        await sync.flush(5_000);
        expect(fixture.client.deletes).toEqual([]);
        expect(fixture.diagnostics.join('\n')).toContain('sub (unreadable:');
      } finally {
        replaceFileSystemMethod('opendir', originalOpendir);
        await fixture.cleanup();
      }
    }
  );
});

describe('workspace artifact synchronizer bookkeeping', () => {
  it('reports a skip again after the removed path is reused', async () => {
    const fixture = await createFixture();
    try {
      const sync = await fixture.startBaseline();
      const link = path.join(fixture.artifacts, 'alias.txt');
      await fsp.symlink('missing-target.txt', link);
      await sync.flush(5_000);
      expect(diagnosticCount(fixture.diagnostics, 'alias.txt (symlink)')).toBe(1);

      await fsp.rm(link);
      await sync.flush(5_000);

      await fsp.symlink('missing-target.txt', link);
      await sync.flush(5_000);
      expect(diagnosticCount(fixture.diagnostics, 'alias.txt (symlink)')).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('retries a reused path after its permanent skip was removed from disk', async () => {
    let restore = (): void => undefined;
    const targetName = 'reused.txt';
    const frozen = {
      size: 4n,
      mtimeNs: 111n,
      ctimeNs: 222n,
      ino: 333n,
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => true,
    };
    let rejectWithQuota = true;
    const client = fakeClient({
      put: () =>
        Promise.resolve(
          rejectWithQuota
            ? { status: 'rejected' as const, statusCode: 413 }
            : { status: 'ok' as const, statusCode: 200 }
        ),
    });
    const fixture = await createFixture({}, client);
    const target = path.join(fixture.artifacts, targetName);
    try {
      const sync = await fixture.startBaseline();
      await fsp.writeFile(target, 'data');
      restore = freezeSignature(target, frozen);

      await sync.flush(5_000);
      expect(client.puts).toHaveLength(1);
      expect(fixture.diagnostics.join('\n')).toContain('reused.txt (quota_exceeded)');

      await fsp.rm(target);
      await sync.flush(5_000);

      await fsp.writeFile(target, 'data');
      rejectWithQuota = false;
      await sync.flush(5_000);
      expect(client.puts).toHaveLength(2);
      expect((await fixture.state()).files[targetName]?.publishedHash).toBe(sha256('data'));
    } finally {
      restore();
      await fixture.cleanup();
    }
  });
});

describe('validateWorkspaceArtifactPath', () => {
  it('rejects excluded and unsafe relative paths', () => {
    expect(validateWorkspaceArtifactPath('report.txt')).toEqual({
      ok: true,
      relativePath: 'report.txt',
    });
    for (const invalid of [
      '',
      '.hidden/report.txt',
      'node_modules/report.txt',
      '__pycache__/report.txt',
      'venv/report.txt',
      '../report.txt',
      '/report.txt',
      'a\\b.txt',
      'a//b.txt',
      'a/\u0001.txt',
    ]) {
      expect(validateWorkspaceArtifactPath(invalid).ok).toBe(false);
    }
  });
});
