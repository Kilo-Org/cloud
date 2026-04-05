import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { restoreSession, extractDiffs } from './restore-session';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(diffs: Array<{ file: string; after: string; status: string }>): string {
  return JSON.stringify({
    messages: [{ info: { summary: { diffs } } }],
  });
}

function makeMultiMessageSnapshot(
  ...messageDiffs: Array<Array<{ file: string; after: string; status: string }>>
): string {
  return JSON.stringify({
    messages: messageDiffs.map(diffs => ({ info: { summary: { diffs } } })),
  });
}

/** Wraps a fetch-like function with a no-op `preconnect` so it satisfies Bun's `typeof fetch`. */
function asFetch(
  fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
): typeof fetch {
  return Object.assign(fn, { preconnect: fetch.preconnect });
}

function mockFetchOk(body: string): void {
  globalThis.fetch = asFetch(() =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
  );
}

function mockFetchStatus(status: number, body = ''): void {
  globalThis.fetch = asFetch(() => Promise.resolve(new Response(body, { status })));
}

function writeMockKilo(binDir: string, exitCode: number): void {
  const script = `#!/bin/sh\nexit ${exitCode}\n`;
  const kiloPath = path.join(binDir, 'kilo');
  fs.writeFileSync(kiloPath, script, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('restoreSession', () => {
  let tmpDir: string;
  let workspace: string;
  let binDir: string;
  let savedEnv: Record<string, string | undefined>;
  let originalFetch: typeof globalThis.fetch;

  const SESSION_ID = 'ses_test123';
  const TMP_PATH = `/tmp/kilo-session-export-${SESSION_ID}.json`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-test-'));
    workspace = path.join(tmpDir, 'workspace');
    binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    writeMockKilo(binDir, 0);

    savedEnv = {
      KILO_SESSION_INGEST_URL: process.env.KILO_SESSION_INGEST_URL,
      KILOCODE_TOKEN: process.env.KILOCODE_TOKEN,
      PATH: process.env.PATH,
    };

    process.env.KILO_SESSION_INGEST_URL = 'http://localhost:9999';
    process.env.KILOCODE_TOKEN = 'test-token';
    process.env.PATH = `${binDir}:${process.env.PATH}`;

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    globalThis.fetch = originalFetch;

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    try {
      fs.unlinkSync(TMP_PATH);
    } catch {
      // may already be cleaned up
    }
  });

  // ---- Environment validation ----

  it('returns error when KILO_SESSION_INGEST_URL is missing', async () => {
    delete process.env.KILO_SESSION_INGEST_URL;
    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('KILO_SESSION_INGEST_URL');
      expect(result.code).toBeNull();
      expect(result.step).toBe('download');
    }
  });

  it('returns error when KILOCODE_TOKEN is missing', async () => {
    delete process.env.KILOCODE_TOKEN;
    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('KILOCODE_TOKEN');
      expect(result.code).toBeNull();
      expect(result.step).toBe('download');
    }
  });

  it('returns error mentioning both vars when both are missing', async () => {
    delete process.env.KILO_SESSION_INGEST_URL;
    delete process.env.KILOCODE_TOKEN;
    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('KILO_SESSION_INGEST_URL');
      expect(result.error).toContain('KILOCODE_TOKEN');
    }
  });

  // ---- Download failures ----

  it('returns 404 error when snapshot not found', async () => {
    mockFetchStatus(404);
    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(404);
      expect(result.step).toBe('download');
    }
  });

  it('returns 502 error on server errors', async () => {
    mockFetchStatus(500);
    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(502);
      expect(result.step).toBe('download');
    }
  });

  it('returns download error when fetch throws', async () => {
    globalThis.fetch = asFetch(() => Promise.reject(new Error('network failure')));
    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('network failure');
      expect(result.code).toBeNull();
      expect(result.step).toBe('download');
    }
  });

  // ---- Import failures ----

  it('returns import error when kilo import fails', async () => {
    const snapshot = makeSnapshot([{ file: 'src/index.ts', after: 'content', status: 'modified' }]);
    mockFetchOk(snapshot);
    writeMockKilo(binDir, 1);

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe('import');
      expect(result.error).toContain('kilo import failed');
    }
  });

  // ---- Happy paths ----

  it('downloads snapshot, imports, and applies diffs', async () => {
    const snapshot = makeSnapshot([
      { file: 'src/index.ts', after: "console.log('hello');", status: 'modified' },
      { file: 'old-file.txt', after: '', status: 'deleted' },
    ]);
    mockFetchOk(snapshot);

    // Create file that should be deleted
    fs.writeFileSync(path.join(workspace, 'old-file.txt'), 'old content');

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result).toEqual({
      ok: true,
      downloaded: true,
      imported: true,
      diffs: { applied: 2, skipped: 0, total: 2 },
    });

    // Verify modified file was written
    const created = fs.readFileSync(path.join(workspace, 'src/index.ts'), 'utf-8');
    expect(created).toBe("console.log('hello');");

    // Verify deleted file was removed
    expect(fs.existsSync(path.join(workspace, 'old-file.txt'))).toBe(false);
  });

  it('succeeds with zero diffs when messages array is empty', async () => {
    mockFetchOk(JSON.stringify({ messages: [] }));

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result).toEqual({
      ok: true,
      downloaded: true,
      imported: true,
      diffs: { applied: 0, skipped: 0, total: 0 },
    });
  });

  it('succeeds with zero diffs when messages have no diffs field', async () => {
    mockFetchOk(JSON.stringify({ messages: [{ info: {} }] }));

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result).toEqual({
      ok: true,
      downloaded: true,
      imported: true,
      diffs: { applied: 0, skipped: 0, total: 0 },
    });
  });

  // ---- Path traversal protection ----

  it('skips diffs with path traversal', async () => {
    const snapshot = makeSnapshot([
      { file: '../escaped.txt', after: 'malicious', status: 'modified' },
      { file: 'safe.txt', after: 'safe content', status: 'modified' },
    ]);
    mockFetchOk(snapshot);

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diffs.skipped).toBe(1);
      expect(result.diffs.applied).toBe(1);
      expect(result.diffs.total).toBe(2);
    }

    // Verify traversal target was NOT written outside the workspace
    expect(fs.existsSync(path.join(tmpDir, 'escaped.txt'))).toBe(false);

    // Verify safe file was written
    expect(fs.readFileSync(path.join(workspace, 'safe.txt'), 'utf-8')).toBe('safe content');
  });

  // ---- Deduplication ----

  it('deduplicates diffs by file path with last-write-wins', async () => {
    const snapshot = makeMultiMessageSnapshot(
      [{ file: 'dup.txt', after: 'first version', status: 'modified' }],
      [{ file: 'dup.txt', after: 'second version', status: 'modified' }]
    );
    mockFetchOk(snapshot);

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Deduplicated to 1 unique diff
      expect(result.diffs.total).toBe(1);
      expect(result.diffs.applied).toBe(1);
    }

    // Second message wins
    expect(fs.readFileSync(path.join(workspace, 'dup.txt'), 'utf-8')).toBe('second version');
  });

  // ---- Skipping empty after ----

  it('skips non-deleted diffs with empty after content', async () => {
    const snapshot = makeSnapshot([
      { file: 'empty.txt', after: '', status: 'modified' },
      { file: 'real.txt', after: 'real content', status: 'modified' },
    ]);
    mockFetchOk(snapshot);

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diffs.applied).toBe(1);
      expect(result.diffs.skipped).toBe(1);
      expect(result.diffs.total).toBe(2);
    }

    expect(fs.existsSync(path.join(workspace, 'empty.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, 'real.txt'), 'utf-8')).toBe('real content');
  });

  // ---- Temp file cleanup ----

  it('cleans up temp file on success', async () => {
    mockFetchOk(makeSnapshot([{ file: 'a.txt', after: 'content', status: 'modified' }]));

    const result = await restoreSession(SESSION_ID, workspace);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(TMP_PATH)).toBe(false);
  });

  it('cleans up temp file when Bun.write throws during download', async () => {
    // Simulate a partial write: pre-create the temp file so it exists on disk,
    // then have fetch() reject — the catch path should still unlink it.
    fs.writeFileSync(TMP_PATH, 'partial snapshot data');

    globalThis.fetch = asFetch(() => Promise.reject(new Error('connection reset')));

    const result = await restoreSession(SESSION_ID, workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe('download');
    }
    expect(fs.existsSync(TMP_PATH)).toBe(false);
  });

  it('cleans up temp file on import failure', async () => {
    mockFetchOk(makeSnapshot([{ file: 'a.txt', after: 'content', status: 'modified' }]));
    writeMockKilo(binDir, 1);

    const result = await restoreSession(SESSION_ID, workspace);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(TMP_PATH)).toBe(false);
  });

  // ---- Fetch URL construction ----

  it('sends correct URL and auth header', async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Headers | undefined;

    globalThis.fetch = asFetch((input, init) => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
      if (init?.headers) {
        capturedHeaders = new Headers(init.headers);
      }
      return Promise.resolve(new Response(makeSnapshot([]), { status: 200 }));
    });

    await restoreSession(SESSION_ID, workspace);

    expect(capturedUrl).toBe(`http://localhost:9999/api/session/${SESSION_ID}/export`);
    expect(capturedHeaders?.get('Authorization')).toBe('Bearer test-token');
  });

  it('URL-encodes the session ID', async () => {
    let capturedUrl: string | undefined;

    // Use chars that need URL-encoding but are filesystem-safe (the
    // function writes to /tmp/kilo-session-export-<id>.json)
    const specialId = 'ses special&chars=1';

    globalThis.fetch = asFetch(input => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
      return Promise.resolve(new Response(makeSnapshot([]), { status: 200 }));
    });

    await restoreSession(specialId, workspace);

    expect(capturedUrl).toContain(encodeURIComponent(specialId));
  });

  // ---- Nested directory creation ----

  it('creates nested directories for diff file paths', async () => {
    const snapshot = makeSnapshot([
      { file: 'deep/nested/dir/file.ts', after: 'nested content', status: 'modified' },
    ]);
    mockFetchOk(snapshot);

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(workspace, 'deep/nested/dir/file.ts'), 'utf-8')).toBe(
      'nested content'
    );
  });

  // ---- Delete of already-absent file ----

  it('counts delete as applied even if file does not exist', async () => {
    const snapshot = makeSnapshot([{ file: 'nonexistent.txt', after: '', status: 'deleted' }]);
    mockFetchOk(snapshot);

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diffs.applied).toBe(1);
      expect(result.diffs.skipped).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// extractDiffs (subprocess-based diff extraction)
// ---------------------------------------------------------------------------

describe('extractDiffs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-diffs-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts diffs from a valid snapshot', async () => {
    const filePath = path.join(tmpDir, 'snapshot.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        messages: [
          {
            info: {
              summary: { diffs: [{ file: 'a.ts', after: 'content-a', status: 'modified' }] },
            },
          },
          { info: { summary: { diffs: [{ file: 'b.ts', after: 'content-b', status: 'added' }] } } },
        ],
      })
    );

    const diffs = await extractDiffs(filePath);
    expect(diffs).toEqual([
      { file: 'a.ts', after: 'content-a', status: 'modified' },
      { file: 'b.ts', after: 'content-b', status: 'added' },
    ]);
  });

  it('deduplicates by file path with last-write-wins', async () => {
    const filePath = path.join(tmpDir, 'snapshot.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        messages: [
          {
            info: { summary: { diffs: [{ file: 'dup.ts', after: 'first', status: 'modified' }] } },
          },
          {
            info: { summary: { diffs: [{ file: 'dup.ts', after: 'second', status: 'modified' }] } },
          },
        ],
      })
    );

    const diffs = await extractDiffs(filePath);
    expect(diffs).toHaveLength(1);
    expect(diffs?.[0]?.after).toBe('second');
  });

  it('returns empty array when no diffs exist', async () => {
    const filePath = path.join(tmpDir, 'snapshot.json');
    fs.writeFileSync(filePath, JSON.stringify({ messages: [{ info: {} }] }));

    const diffs = await extractDiffs(filePath);
    expect(diffs).toEqual([]);
  });

  it('returns null on invalid JSON', async () => {
    const filePath = path.join(tmpDir, 'snapshot.json');
    fs.writeFileSync(filePath, 'not valid json {{{');

    const diffs = await extractDiffs(filePath);
    expect(diffs).toBeNull();
  });

  it('returns null when file does not exist', async () => {
    const diffs = await extractDiffs(path.join(tmpDir, 'nonexistent.json'));
    expect(diffs).toBeNull();
  });

  it('returns null when file is empty', async () => {
    const filePath = path.join(tmpDir, 'empty.json');
    fs.writeFileSync(filePath, '');

    const diffs = await extractDiffs(filePath);
    expect(diffs).toBeNull();
  });
});
