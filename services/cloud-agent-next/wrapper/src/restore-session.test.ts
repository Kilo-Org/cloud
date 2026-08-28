import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { restoreSession, extractDiffs, seedSessionIngestRegistration } from './restore-session';
import { buildWorktreeKiloEnvironment } from './control/worktree-runtime';

const SESSION_ID = 'ses_test123';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Real session-ingest exports always carry a top-level `info` block with at
// least `id`. The orchestrator's malformed-snapshot guardrail keys off that
// field, so test fixtures must match real shape.
function snapshotInfo(id = SESSION_ID): { id: string; version: string } {
  return { id, version: '2' };
}

function makeSnapshot(
  diffs: Array<{ file: string; after: string; status: string }>,
  sessionId = SESSION_ID
): string {
  return JSON.stringify({
    info: snapshotInfo(sessionId),
    messages: [{ info: { summary: { diffs } } }],
  });
}

function makeSessionDiffSnapshot(patch: string): string {
  return JSON.stringify({
    info: snapshotInfo(),
    sessionDiff: [
      {
        file: 'src/index.ts',
        patch,
        additions: 1,
        deletions: 0,
        status: 'modified',
      },
    ],
    messages: [
      {
        info: {
          summary: {
            diffs: [{ file: 'legacy.txt', after: 'legacy content', status: 'modified' }],
          },
        },
      },
    ],
  });
}

function makeMultiMessageSnapshot(
  ...messageDiffs: Array<Array<{ file: string; after: string; status: string }>>
): string {
  return JSON.stringify({
    info: snapshotInfo(),
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

/** Captures the snapshot path passed to `kilo import` by copying it before exit. */
function writeCapturingMockKilo(binDir: string, capturePath: string): void {
  const script = `#!/bin/sh
if [ "$1" = "import" ] && [ -n "$2" ]; then
  printf '%s' "$2" > "${capturePath}.path"
  cp "$2" "${capturePath}"
fi
exit 0
`;
  const kiloPath = path.join(binDir, 'kilo');
  fs.writeFileSync(kiloPath, script, { mode: 0o755 });
}

function writeSlowMockKilo(binDir: string, startedMarker?: string): void {
  const script = `#!/bin/sh\n${startedMarker ? `: > "${startedMarker}"\n` : ''}exec sleep 30\n`;
  const kiloPath = path.join(binDir, 'kilo');
  fs.writeFileSync(kiloPath, script, { mode: 0o755 });
}

function writeSignalTerminatedMockKilo(binDir: string): void {
  const script = '#!/bin/sh\nkill -TERM $$\n';
  const kiloPath = path.join(binDir, 'kilo');
  fs.writeFileSync(kiloPath, script, { mode: 0o755 });
}

function writeSignalIgnoringDescendantMockKilo(binDir: string, descendantMarker: string): void {
  const readyMarker = `${descendantMarker}.ready`;
  const script = `#!/bin/sh\ntrap 'exit 0' TERM\nnode -e 'const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeFileSync(process.argv[1], "ready"); setTimeout(() => fs.writeFileSync(process.argv[2], "alive"), 800); setInterval(() => {}, 1000);' "${readyMarker}" "${descendantMarker}" </dev/null >/dev/null 2>&1 &\nwhile [ ! -f "${readyMarker}" ]; do sleep 0.01; done\nsleep 2\n`;
  const kiloPath = path.join(binDir, 'kilo');
  fs.writeFileSync(kiloPath, script, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

async function rejected(operation: Promise<void>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject');
}

describe('seedSessionIngestRegistration', () => {
  let tmpDir: string;
  let dataHome: string;
  let registrationDirectory: string;
  const sessionId = 'root_01-kilo';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-ingest-test-'));
    dataHome = path.join(tmpDir, 'worktree data');
    registrationDirectory = path.join(dataHome, 'kilo', 'storage', 'session_share');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes only the pinned registration with restrictive permissions in the explicit data home', async () => {
    const home = path.join(tmpDir, 'unused-home');
    await seedSessionIngestRegistration(sessionId, {
      HOME: home,
      XDG_DATA_HOME: dataHome,
      KILOCODE_TOKEN: 'managed-token-must-not-persist',
      KILO_AUTH_CONTENT: '{"kilo":{"type":"api","key":"auth-must-not-persist"}}',
      SANDBOX_CONTROL_CREDENTIAL: 'control-must-not-persist',
    });

    const registrationPath = path.join(registrationDirectory, `${sessionId}.json`);
    const contents = fs.readFileSync(registrationPath, 'utf8');
    expect(JSON.parse(contents)).toEqual({
      id: sessionId,
      ingestPath: `/api/session/${sessionId}/ingest`,
    });
    expect(contents).not.toContain('must-not-persist');
    expect(fs.statSync(registrationPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(registrationDirectory).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(registrationDirectory)).toEqual([`${sessionId}.json`]);
    expect(fs.existsSync(home)).toBe(false);
  });

  it('isolates roots and data homes across concurrent and repeated seeds', async () => {
    const otherRoot = 'kilo_2';
    const otherDataHome = path.join(tmpDir, 'other-data');
    await Promise.all([
      seedSessionIngestRegistration(sessionId, { XDG_DATA_HOME: dataHome }),
      seedSessionIngestRegistration(otherRoot, { XDG_DATA_HOME: dataHome }),
      seedSessionIngestRegistration(sessionId, { XDG_DATA_HOME: dataHome }),
      seedSessionIngestRegistration(sessionId, { XDG_DATA_HOME: otherDataHome }),
    ]);

    expect(fs.readdirSync(registrationDirectory).sort()).toEqual([
      `${otherRoot}.json`,
      `${sessionId}.json`,
    ]);
    const otherDirectory = path.join(otherDataHome, 'kilo', 'storage', 'session_share');
    expect(fs.readdirSync(otherDirectory)).toEqual([`${sessionId}.json`]);
    for (const [directory, root] of [
      [registrationDirectory, sessionId],
      [registrationDirectory, otherRoot],
      [otherDirectory, sessionId],
    ]) {
      expect(JSON.parse(fs.readFileSync(path.join(directory, `${root}.json`), 'utf8'))).toEqual({
        id: root,
        ingestPath: `/api/session/${root}/ingest`,
      });
    }
  });

  it('accepts a 128-character safe session ID', async () => {
    const root = 'a'.repeat(128);
    await seedSessionIngestRegistration(root, { XDG_DATA_HOME: dataHome });
    expect(
      JSON.parse(fs.readFileSync(path.join(registrationDirectory, `${root}.json`), 'utf8'))
    ).toEqual({ id: root, ingestPath: `/api/session/${root}/ingest` });
  });

  it.each([
    '',
    '.',
    '..',
    '../root',
    '/root',
    'root/other',
    'root\\other',
    'root.json',
    'root?other',
    'root#other',
    'root\n',
    'root\r',
    'root\0',
    'røot',
    'a'.repeat(129),
  ])('rejects unsafe session ID %j before writing', async root => {
    expect(
      await rejected(seedSessionIngestRegistration(root, { XDG_DATA_HOME: dataHome }))
    ).toEqual(new Error('Invalid Kilo session ID for ingest registration'));
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it.each([undefined, '', 'relative/data', '../data', '~/.local/share'])(
    'rejects a missing or relative XDG_DATA_HOME %j',
    async invalidDataHome => {
      expect(
        await rejected(
          seedSessionIngestRegistration(sessionId, {
            HOME: tmpDir,
            XDG_DATA_HOME: invalidDataHome,
          })
        )
      ).toEqual(new Error('Ingest registration requires an explicit absolute XDG_DATA_HOME'));
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    }
  );

  it.each(['\0', '\r', '\n'])('rejects XDG_DATA_HOME containing %j', async character => {
    expect(
      await rejected(
        seedSessionIngestRegistration(sessionId, { XDG_DATA_HOME: `${dataHome}${character}` })
      )
    ).toEqual(new Error('Ingest registration requires an explicit absolute XDG_DATA_HOME'));
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('does not fall back to process-global XDG_DATA_HOME', async () => {
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    try {
      expect(await rejected(seedSessionIngestRegistration(sessionId, {}))).toEqual(
        new Error('Ingest registration requires an explicit absolute XDG_DATA_HOME')
      );
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previous;
    }
  });

  it('propagates a storage-directory creation failure without replacing the blocker', async () => {
    fs.writeFileSync(dataHome, 'not a directory');
    expect(
      await rejected(seedSessionIngestRegistration(sessionId, { XDG_DATA_HOME: dataHome }))
    ).toBeInstanceOf(Error);
    expect(fs.readFileSync(dataHome, 'utf8')).toBe('not a directory');
    expect(fs.readdirSync(tmpDir)).toEqual(['worktree data']);
  });

  it('cleans temporary files when the final rename fails', async () => {
    const registrationPath = path.join(registrationDirectory, `${sessionId}.json`);
    fs.mkdirSync(registrationPath, { recursive: true });
    expect(
      await rejected(seedSessionIngestRegistration(sessionId, { XDG_DATA_HOME: dataHome }))
    ).toBeInstanceOf(Error);
    expect(fs.statSync(registrationPath).isDirectory()).toBe(true);
    expect(fs.readdirSync(registrationDirectory)).toEqual([`${sessionId}.json`]);
  });

  it('cleans a partial write and preserves the previous registration on write failure', async () => {
    fs.mkdirSync(registrationDirectory, { recursive: true });
    const registrationPath = path.join(registrationDirectory, `${sessionId}.json`);
    fs.writeFileSync(registrationPath, 'previous registration');
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    const failure = new Error('registration write failed');
    const write = spyOn(fs.promises, 'writeFile').mockImplementation(
      async (file, _data, options) => {
        await writeFile(file, '{', options);
        throw failure;
      }
    );
    try {
      expect(
        await rejected(seedSessionIngestRegistration(sessionId, { XDG_DATA_HOME: dataHome }))
      ).toBe(failure);
    } finally {
      write.mockRestore();
    }
    expect(fs.readFileSync(registrationPath, 'utf8')).toBe('previous registration');
    expect(fs.readdirSync(registrationDirectory)).toEqual([`${sessionId}.json`]);
  });

  it('does not create storage when already cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('workspace cancelled');
    controller.abort(reason);
    expect(
      await rejected(
        seedSessionIngestRegistration(sessionId, { XDG_DATA_HOME: dataHome }, controller.signal)
      )
    ).toBe(reason);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('cleans a completed temporary write without publishing after cancellation', async () => {
    fs.mkdirSync(registrationDirectory, { recursive: true });
    const registrationPath = path.join(registrationDirectory, `${sessionId}.json`);
    fs.writeFileSync(registrationPath, 'previous registration');
    const controller = new AbortController();
    const reason = new Error('workspace cancelled');
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    const write = spyOn(fs.promises, 'writeFile').mockImplementation(
      async (file, data, options) => {
        await writeFile(file, data, options);
        controller.abort(reason);
      }
    );
    try {
      expect(
        await rejected(
          seedSessionIngestRegistration(sessionId, { XDG_DATA_HOME: dataHome }, controller.signal)
        )
      ).toBe(reason);
    } finally {
      write.mockRestore();
    }
    expect(fs.readFileSync(registrationPath, 'utf8')).toBe('previous registration');
    expect(fs.readdirSync(registrationDirectory)).toEqual([`${sessionId}.json`]);
  });
});

describe('restoreSession', () => {
  let tmpDir: string;
  let workspace: string;
  let binDir: string;
  let savedEnv: Record<string, string | undefined>;
  let originalFetch: typeof globalThis.fetch;

  function snapshotDirectories(): string[] {
    return fs.readdirSync(tmpDir).filter(entry => entry.startsWith('kilo-session-export-'));
  }

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
      KILOCODE_TOKEN_FILE: process.env.KILOCODE_TOKEN_FILE,
      SANDBOX_CONTROL_CREDENTIAL: process.env.SANDBOX_CONTROL_CREDENTIAL,
      RESTORE_PROCESS_ONLY: process.env.RESTORE_PROCESS_ONLY,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
    };

    process.env.KILO_SESSION_INGEST_URL = 'http://localhost:9999';
    process.env.KILOCODE_TOKEN = 'test-token';
    delete process.env.KILOCODE_TOKEN_FILE;
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    process.env.TMPDIR = tmpDir;

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

  it('uses the supplied worktree auth for download and import without inheriting wrapper credentials', async () => {
    process.env.KILOCODE_TOKEN = 'actual-managed-token';
    process.env.SANDBOX_CONTROL_CREDENTIAL = 'actual-control-credential';
    process.env.RESTORE_PROCESS_ONLY = 'wrapper-only-value';
    const capturePath = path.join(tmpDir, 'import-env.json');
    const home = path.join(tmpDir, 'worktree-home');
    const kilo = {
      scopeId: 'worktree_restore',
      token: 'opaque-guest-token',
      targets: {
        backendBaseUrl: 'https://backend.example.test',
        providerBaseUrl: 'https://provider.example.test',
        sessionIngestBaseUrl: 'https://ingest.example.test/worktree',
      },
    };
    const env = buildWorktreeKiloEnvironment(
      workspace,
      home,
      kilo,
      {
        PATH: process.env.PATH ?? '',
        RESTORE_CAPTURE_PATH: capturePath,
      },
      {}
    );
    fs.writeFileSync(
      path.join(binDir, 'kilo'),
      `#!${process.execPath}
await Bun.write(process.env.RESTORE_CAPTURE_PATH, JSON.stringify({
  cwd: process.cwd(),
  args: process.argv.slice(2),
  HOME: process.env.HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  KILOCODE_TOKEN: process.env.KILOCODE_TOKEN,
  KILO_AUTH_CONTENT: process.env.KILO_AUTH_CONTENT,
  KILO_CONFIG_CONTENT: process.env.KILO_CONFIG_CONTENT,
  OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
  SANDBOX_CONTROL_CREDENTIAL: process.env.SANDBOX_CONTROL_CREDENTIAL,
  RESTORE_PROCESS_ONLY: process.env.RESTORE_PROCESS_ONLY,
  ingestRegistration: await Bun.file(process.env.XDG_DATA_HOME + '/kilo/storage/session_share/${SESSION_ID}.json').json(),
}));
`,
      { mode: 0o755 }
    );
    const requests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = asFetch((url, init) => {
      requests.push({
        url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      return Promise.resolve(new Response(makeSnapshot([]), { status: 200 }));
    });

    await seedSessionIngestRegistration(SESSION_ID, env);
    expect((await restoreSession(SESSION_ID, workspace, undefined, { env })).ok).toBe(true);
    expect(requests).toEqual([
      {
        url: `${kilo.targets.sessionIngestBaseUrl}/api/session/${SESSION_ID}/export`,
        authorization: `Bearer ${kilo.token}`,
      },
    ]);
    const imported = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, unknown>;
    const importArgs = imported.args as string[];
    expect(importArgs[0]).toBe('import');
    expect(importArgs[1]).toMatch(/kilo-session-export-.*\/snapshot\.json$/);
    expect(imported).toMatchObject({
      cwd: fs.realpathSync(workspace),
      HOME: home,
      XDG_DATA_HOME: env.XDG_DATA_HOME,
      KILOCODE_TOKEN: kilo.token,
      KILO_AUTH_CONTENT: env.KILO_AUTH_CONTENT,
      KILO_CONFIG_CONTENT: env.KILO_CONFIG_CONTENT,
      OPENCODE_CONFIG_CONTENT: env.OPENCODE_CONFIG_CONTENT,
      ingestRegistration: { id: SESSION_ID, ingestPath: `/api/session/${SESSION_ID}/ingest` },
    });
    expect(JSON.stringify(imported)).not.toContain('actual-');
    expect(process.env.KILOCODE_TOKEN).toBe('actual-managed-token');
    expect(process.env.SANDBOX_CONTROL_CREDENTIAL).toBe('actual-control-credential');
  });

  it('does not fall back to process-global auth when an explicit restore environment omits it', async () => {
    const result = await restoreSession(SESSION_ID, workspace, undefined, {
      env: { KILO_SESSION_INGEST_URL: 'https://ingest.example.test' },
    });
    expect(result).toEqual({
      ok: false,
      error: 'missing env vars: KILOCODE_TOKEN',
      code: null,
      step: 'download',
    });
  });

  it('reads KILOCODE_TOKEN_FILE when KILOCODE_TOKEN is missing', async () => {
    const tokenPath = path.join(tmpDir, 'restore-token');
    fs.writeFileSync(tokenPath, 'file-token\n');
    delete process.env.KILOCODE_TOKEN;
    process.env.KILOCODE_TOKEN_FILE = tokenPath;

    const authorization: { value: string | null } = { value: null };
    globalThis.fetch = asFetch((_, init) => {
      authorization.value = new Headers(init?.headers).get('Authorization');
      return Promise.resolve(
        new Response(makeSnapshot([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(true);
    expect(authorization.value).toBe('Bearer file-token');
  });

  it('returns download error when KILOCODE_TOKEN_FILE cannot be read', async () => {
    delete process.env.KILOCODE_TOKEN;
    process.env.KILOCODE_TOKEN_FILE = path.join(tmpDir, 'missing-token');

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('failed to read KILOCODE_TOKEN_FILE');
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

  it('returns an upstream failure for unauthorized snapshot responses', async () => {
    mockFetchStatus(401);

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result).toEqual({
      ok: false,
      error: 'download failed status=401',
      code: 502,
      step: 'download',
    });
  });

  it('returns a fixed download error when fetch throws', async () => {
    globalThis.fetch = asFetch(() => Promise.reject(new Error('network token secret')));
    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('snapshot download failed');
      expect(result.error).not.toContain('network token secret');
      expect(result.code).toBeNull();
      expect(result.step).toBe('download');
    }
  });

  it('aborts during download without starting import and removes its temp directory', async () => {
    const downloadStarted = Promise.withResolvers<AbortSignal>();
    const capturePath = path.join(tmpDir, 'import-input.json');
    writeCapturingMockKilo(binDir, capturePath);
    globalThis.fetch = asFetch((_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('Expected download signal');
      downloadStarted.resolve(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const controller = new AbortController();
    const restoring = restoreSession(SESSION_ID, workspace, undefined, {
      signal: controller.signal,
    });

    try {
      const signal = await downloadStarted.promise;
      expect(signal.aborted).toBe(false);
      expect(snapshotDirectories()).toHaveLength(1);
      controller.abort();
      const result = await restoring;

      expect(signal.aborted).toBe(true);
      expect(result).toEqual({
        ok: false,
        error: 'snapshot download failed',
        code: null,
        step: 'download',
      });
      expect(fs.existsSync(capturePath)).toBe(false);
      expect(snapshotDirectories()).toEqual([]);
    } finally {
      controller.abort();
      await restoring;
    }
  });

  it('returns download error when the snapshot lacks top-level info.id', async () => {
    mockFetchOk(JSON.stringify({ detail: 'upstream error body' }));

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('snapshot missing info.id');
      expect(result.code).toBeNull();
      expect(result.step).toBe('download');
    }
  });

  it('returns 404 when session-ingest returns a valid empty session export', async () => {
    mockFetchOk(JSON.stringify({ info: {}, messages: [], sessionDiff: [] }));

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result).toEqual({
      ok: false,
      error: 'snapshot not found (empty export)',
      code: 404,
      step: 'download',
    });
  });

  for (const [description, snapshot] of [
    ['null session metadata', { info: null, messages: [], sessionDiff: [] }],
    ['same-size malformed session diffs', { info: {}, messages: [], sessionDiff: {} }],
    ['missing session diffs', { info: {}, messages: [] }],
    [
      'session metadata without an id',
      { info: { title: 'Existing session' }, messages: [], sessionDiff: [] },
    ],
    [
      'existing messages',
      { info: {}, messages: [{ info: { id: 'msg_existing' } }], sessionDiff: [] },
    ],
    ['existing session diffs', { info: {}, messages: [], sessionDiff: [{ file: 'existing.txt' }] }],
    [
      'additional export fields',
      { info: {}, messages: [], sessionDiff: [], detail: 'upstream error' },
    ],
  ] as const) {
    it(`does not identify ${description} as an empty session export`, async () => {
      mockFetchOk(JSON.stringify(snapshot));

      const result = await restoreSession(SESSION_ID, workspace);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('snapshot missing info.id');
        expect(result.code).toBeNull();
        expect(result.step).toBe('download');
        expect(result).not.toHaveProperty('emptySnapshot');
      }
    });
  }

  it('returns download error when the snapshot metadata is not JSON', async () => {
    mockFetchOk('not valid JSON {{{');

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('snapshot is not valid JSON');
      expect(result.code).toBeNull();
      expect(result.step).toBe('download');
    }
  });

  it('returns download error when JSON after info.id is malformed', async () => {
    mockFetchOk('{"info":{"id":"ses_test123"},"messages":[not-json]}');

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('snapshot is not valid JSON');
      expect(result.code).toBeNull();
      expect(result.step).toBe('download');
    }
  });

  it('returns download error when bytes follow the JSON document', async () => {
    mockFetchOk('{"info":{"id":"ses_test123"},"messages":[]} trailing');

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('snapshot is not valid JSON');
      expect(result.code).toBeNull();
      expect(result.step).toBe('download');
    }
  });

  it('returns download error when info.id starts with malformed JSON', async () => {
    mockFetchOk('{"info":{"id":not-json},"messages":[]}');

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('snapshot is not valid JSON');
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
      expect(result.subtype).toBe('kilo_import_failed');
      expect(result.error).toContain('kilo import failed');
      expect(result.detail).toContain('exit code 1');
    }
  });

  it('terminates and returns import error when kilo import exceeds its deadline', async () => {
    mockFetchOk(makeSnapshot([]));
    writeSlowMockKilo(binDir);

    const result = await restoreSession(SESSION_ID, workspace, undefined, { importTimeoutMs: 50 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe('import');
      expect(result.subtype).toBe('kilo_import_timeout');
      expect(result.error).toContain('kilo import timed out');
      expect(result.detail).toContain('timeout');
    }
    expect(snapshotDirectories()).toEqual([]);
  });

  it('terminates kilo import when the workspace deadline is aborted after import starts', async () => {
    mockFetchOk(makeSnapshot([]));
    writeSlowMockKilo(binDir, path.join(workspace, 'import-started'));
    const importStarted = Promise.withResolvers<void>();
    const watcher = fs.watch(
      workspace,
      { signal: AbortSignal.timeout(3_000) },
      (_event, filename) => {
        if (filename === 'import-started') importStarted.resolve();
      }
    );
    watcher.on('error', importStarted.reject);
    watcher.on('close', () => importStarted.reject(new Error('Import did not start')));
    const controller = new AbortController();
    const restoring = restoreSession(SESSION_ID, workspace, undefined, {
      importTimeoutMs: 5_000,
      importTerminationGraceMs: 50,
      signal: controller.signal,
    });

    try {
      await importStarted.promise;
      const startedAt = Date.now();
      controller.abort();
      const result = await restoring;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.step).toBe('import');
        expect(result.error).toContain('kilo import failed');
        expect(result.detail).toContain('termination abort');
      }
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(snapshotDirectories()).toEqual([]);
    } finally {
      controller.abort();
      watcher.close();
      await restoring;
    }
  });

  it('returns import error when kilo import is terminated by a signal', async () => {
    mockFetchOk(makeSnapshot([]));
    writeSignalTerminatedMockKilo(binDir);

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe('import');
      expect(result.error).toContain('kilo import failed');
    }
  });

  it('kills signal-ignoring descendants after a kilo import timeout grace period', async () => {
    mockFetchOk(makeSnapshot([]));
    const descendantMarker = path.join(tmpDir, 'import-descendant-survived');
    writeSignalIgnoringDescendantMockKilo(binDir, descendantMarker);
    const startedAt = Date.now();

    const result = await restoreSession(SESSION_ID, workspace, undefined, {
      importTimeoutMs: 500,
      importTerminationGraceMs: 150,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe('import');
      expect(result.error).toContain('kilo import timed out');
    }
    expect(elapsedMs).toBeGreaterThanOrEqual(600);
    expect(fs.existsSync(descendantMarker)).toBe(false);
  });

  // ---- Happy paths ----

  it('strips transient lifecycle parts from the snapshot before kilo import', async () => {
    const capturePath = path.join(tmpDir, 'import-input.json');
    writeCapturingMockKilo(binDir, capturePath);

    const snapshot = JSON.stringify({
      info: snapshotInfo(),
      messages: [
        {
          info: { role: 'assistant', id: 'msg_1' },
          parts: [
            {
              type: 'text',
              text: 'Initializing snapshot…',
              metadata: { 'kilocode.lifecycle': 'transient' },
            },
            {
              type: 'text',
              text: 'Real assistant reply',
            },
            {
              type: 'text',
              text: 'Keep durable metadata',
              metadata: { 'kilocode.lifecycle': 'durable' },
            },
          ],
        },
        {
          info: { role: 'user', id: 'msg_2' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ],
    });
    mockFetchOk(snapshot);

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(capturePath)).toBe(true);

    const imported = JSON.parse(fs.readFileSync(capturePath, 'utf-8')) as {
      messages: Array<{
        parts: Array<{ type?: string; text?: string; metadata?: Record<string, string> }>;
      }>;
    };
    expect(imported.messages[0]?.parts).toEqual([
      { type: 'text', text: 'Real assistant reply' },
      {
        type: 'text',
        text: 'Keep durable metadata',
        metadata: { 'kilocode.lifecycle': 'durable' },
      },
    ]);
    expect(imported.messages[1]?.parts).toEqual([{ type: 'text', text: 'hello' }]);
    expect(JSON.stringify(imported)).not.toContain('"kilocode.lifecycle":"transient"');
  });

  it('passes a non-object provided snapshot through sanitization unchanged', async () => {
    const capturePath = path.join(tmpDir, 'import-input.json');
    writeCapturingMockKilo(binDir, capturePath);

    // Valid JSON but not a snapshot object. The --file path only logs metadata
    // validation, so sanitization must leave the file intact rather than let a
    // non-total jq filter truncate it to 0 bytes before kilo import.
    const provided = '[1,2,3]';
    const providedPath = path.join(tmpDir, 'provided.json');
    fs.writeFileSync(providedPath, provided);

    const result = await restoreSession(SESSION_ID, workspace, providedPath);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(capturePath)).toBe(true);
    // jq re-serializes the file, so compare values rather than bytes.
    expect(JSON.parse(fs.readFileSync(capturePath, 'utf-8'))).toEqual(JSON.parse(provided));
  });

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

  it('prefers top-level patch session diffs over legacy message summaries', async () => {
    const repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    Bun.spawnSync(['git', 'init'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test User'], {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    fs.writeFileSync(path.join(repo, 'src/index.ts'), 'before\n');
    Bun.spawnSync(['git', 'add', '.'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    Bun.spawnSync(['git', 'commit', '-m', 'initial'], {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    fs.writeFileSync(path.join(repo, 'src/index.ts'), 'after\n');
    const proc = Bun.spawnSync(['git', 'diff', '--src-prefix=a/', '--dst-prefix=b/'], {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const patch = new TextDecoder().decode(proc.stdout);

    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    Bun.spawnSync(['git', 'init'], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], {
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test User'], {
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    fs.writeFileSync(path.join(workspace, 'src/index.ts'), 'before\n');
    Bun.spawnSync(['git', 'add', '.'], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
    Bun.spawnSync(['git', 'commit', '-m', 'initial'], {
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    mockFetchOk(makeSessionDiffSnapshot(patch));

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result).toEqual({
      ok: true,
      downloaded: true,
      imported: true,
      diffs: { applied: 1, skipped: 0, total: 1 },
    });
    expect(fs.readFileSync(path.join(workspace, 'src/index.ts'), 'utf-8')).toBe('after\n');
    expect(fs.existsSync(path.join(workspace, 'legacy.txt'))).toBe(false);
  });

  it('succeeds with zero diffs when messages array is empty', async () => {
    mockFetchOk(JSON.stringify({ info: snapshotInfo(), messages: [] }));

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result).toEqual({
      ok: true,
      downloaded: true,
      imported: true,
      diffs: { applied: 0, skipped: 0, total: 0 },
    });
  });

  it('succeeds with zero diffs when messages have no diffs field', async () => {
    mockFetchOk(JSON.stringify({ info: snapshotInfo(), messages: [{ info: {} }] }));

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

  // ---- Empty after-content ----

  it('restores non-deleted diffs with empty after content', async () => {
    const snapshot = makeSnapshot([
      { file: 'empty.txt', after: '', status: 'modified' },
      { file: 'real.txt', after: 'real content', status: 'modified' },
    ]);
    mockFetchOk(snapshot);

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diffs.applied).toBe(2);
      expect(result.diffs.skipped).toBe(0);
      expect(result.diffs.total).toBe(2);
    }

    expect(fs.readFileSync(path.join(workspace, 'empty.txt'), 'utf-8')).toBe('');
    expect(fs.readFileSync(path.join(workspace, 'real.txt'), 'utf-8')).toBe('real content');
  });

  it('writes after-content when git apply cannot use the patch', async () => {
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    Bun.spawnSync(['git', 'init'], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
    mockFetchOk(
      JSON.stringify({
        info: snapshotInfo(),
        sessionDiff: [
          {
            file: 'src/index.ts',
            patch: 'not a git patch',
            after: 'restored from after\n',
            status: 'modified',
          },
        ],
      })
    );

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result).toEqual({
      ok: true,
      downloaded: true,
      imported: true,
      diffs: { applied: 1, skipped: 0, total: 1 },
    });
    expect(fs.readFileSync(path.join(workspace, 'src/index.ts'), 'utf-8')).toBe(
      'restored from after\n'
    );
  });

  it('continues with a partial restore when a patch cannot be applied', async () => {
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    Bun.spawnSync(['git', 'init'], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
    mockFetchOk(
      JSON.stringify({
        info: snapshotInfo(),
        sessionDiff: [
          {
            file: 'src/index.ts',
            patch: 'not a git patch',
            status: 'modified',
          },
        ],
      })
    );

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result).toEqual({
      ok: true,
      downloaded: true,
      imported: true,
      diffs: { applied: 0, skipped: 1, total: 1 },
    });
    expect(fs.existsSync(path.join(workspace, 'src/index.ts'))).toBe(false);
  });

  it('unlinks a deleted file when its patch cannot be applied', async () => {
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    Bun.spawnSync(['git', 'init'], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
    const deletedFile = path.join(workspace, 'src/gone.ts');
    fs.writeFileSync(deletedFile, 'should be removed');
    mockFetchOk(
      JSON.stringify({
        info: snapshotInfo(),
        sessionDiff: [
          {
            file: 'src/gone.ts',
            patch: 'not a git patch',
            after: '',
            status: 'deleted',
          },
        ],
      })
    );

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result).toEqual({
      ok: true,
      downloaded: true,
      imported: true,
      diffs: { applied: 1, skipped: 0, total: 1 },
    });
    expect(fs.existsSync(deletedFile)).toBe(false);
  });

  it('clears failed three-way state before writing after-content', async () => {
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    Bun.spawnSync(['git', 'init'], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], {
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test User'], {
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const restoredFile = path.join(workspace, 'src/index.ts');
    fs.writeFileSync(restoredFile, 'base\n');
    Bun.spawnSync(['git', 'add', '.'], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
    Bun.spawnSync(['git', 'commit', '-m', 'base'], {
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    fs.writeFileSync(restoredFile, 'snapshot\n');
    const patch = new TextDecoder().decode(
      Bun.spawnSync(['git', 'diff'], {
        cwd: workspace,
        stdout: 'pipe',
        stderr: 'pipe',
      }).stdout
    );
    fs.writeFileSync(restoredFile, 'current\n');
    Bun.spawnSync(['git', 'add', '.'], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
    Bun.spawnSync(['git', 'commit', '-m', 'current'], {
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    mockFetchOk(
      JSON.stringify({
        info: snapshotInfo(),
        sessionDiff: [{ file: 'src/index.ts', patch, after: 'snapshot\n', status: 'modified' }],
      })
    );

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result).toEqual({
      ok: true,
      downloaded: true,
      imported: true,
      diffs: { applied: 1, skipped: 0, total: 1 },
    });
    expect(fs.readFileSync(restoredFile, 'utf-8')).toBe('snapshot\n');
    const unmerged = Bun.spawnSync(['git', 'diff', '--name-only', '--diff-filter=U'], {
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(unmerged.exitCode).toBe(0);
    expect(new TextDecoder().decode(unmerged.stdout)).toBe('');
  });

  // ---- Temp file cleanup ----

  it('cleans up temp file on success', async () => {
    mockFetchOk(makeSnapshot([{ file: 'a.txt', after: 'content', status: 'modified' }]));

    const result = await restoreSession(SESSION_ID, workspace);
    expect(result.ok).toBe(true);
    expect(snapshotDirectories()).toEqual([]);
  });

  it('cleans up its temp directory when Bun.write fails after a partial download', async () => {
    mockFetchOk(makeSnapshot([]));
    const writes: string[] = [];
    const write = spyOn(Bun, 'write').mockImplementationOnce(async destination => {
      if (typeof destination !== 'string') throw new Error('Expected snapshot path');
      writes.push(destination);
      fs.writeFileSync(destination, 'partial snapshot data');
      throw new Error('write failed');
    });

    try {
      const result = await restoreSession(SESSION_ID, workspace);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.step).toBe('download');
      expect(writes).toHaveLength(1);
      expect(fs.existsSync(writes[0])).toBe(false);
      expect(snapshotDirectories()).toEqual([]);
    } finally {
      write.mockRestore();
    }
  });

  it('cleans up its temp directory when downloaded metadata is invalid', async () => {
    mockFetchOk('{"info":{}}');

    const result = await restoreSession(SESSION_ID, workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.step).toBe('download');
    expect(snapshotDirectories()).toEqual([]);
  });

  it('isolates import snapshot paths for simultaneous restores of the same session', async () => {
    const secondWorkspace = path.join(tmpDir, 'second-workspace');
    fs.mkdirSync(secondWorkspace);
    writeCapturingMockKilo(binDir, 'import-input.json');
    let downloadCount = 0;
    globalThis.fetch = asFetch(() => {
      downloadCount += 1;
      return Promise.resolve(
        new Response(
          makeSnapshot([{ file: 'restored.txt', after: String(downloadCount), status: 'modified' }])
        )
      );
    });

    const results = await Promise.all([
      restoreSession(SESSION_ID, workspace),
      restoreSession(SESSION_ID, secondWorkspace),
    ]);

    expect(results.map(result => result.ok)).toEqual([true, true]);
    const importedPaths = [workspace, secondWorkspace].map(directory =>
      fs.readFileSync(path.join(directory, 'import-input.json.path'), 'utf8')
    );
    expect(importedPaths[0]).not.toBe(importedPaths[1]);
    for (const importedPath of importedPaths) {
      expect(path.dirname(importedPath)).toStartWith(path.join(tmpDir, 'kilo-session-export-'));
      expect(fs.existsSync(path.dirname(importedPath))).toBe(false);
    }
    expect(fs.readFileSync(path.join(workspace, 'restored.txt'), 'utf8')).toBe('1');
    expect(fs.readFileSync(path.join(secondWorkspace, 'restored.txt'), 'utf8')).toBe('2');
    expect(snapshotDirectories()).toEqual([]);
  });

  it('cleans up temp file on import failure', async () => {
    mockFetchOk(makeSnapshot([{ file: 'a.txt', after: 'content', status: 'modified' }]));
    writeMockKilo(binDir, 1);

    const result = await restoreSession(SESSION_ID, workspace);
    expect(result.ok).toBe(false);
    expect(snapshotDirectories()).toEqual([]);
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

    const specialId = 'ses special&chars=1';

    globalThis.fetch = asFetch(input => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
      return Promise.resolve(new Response(makeSnapshot([], specialId), { status: 200 }));
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

  it('does not start diff extraction after the workspace deadline expires', async () => {
    const filePath = path.join(tmpDir, 'snapshot.json');
    fs.writeFileSync(filePath, JSON.stringify({ messages: [] }));
    const controller = new AbortController();
    const deadlineError = new Error('workspace deadline reached');
    controller.abort(deadlineError);
    let caughtError: unknown;

    try {
      await extractDiffs(filePath, controller.signal);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBe(deadlineError);
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
