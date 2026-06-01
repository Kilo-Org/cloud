import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { restoreSession, extractDiffs } from './restore-session';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Real session-ingest exports always carry a top-level `info` block with at
// least `id`. The orchestrator's malformed-snapshot guardrail keys off that
// field, so test fixtures must match real shape.
function snapshotInfo(): { id: string; version: string } {
  return { id: 'ses_test_fixture', version: '2' };
}

function makeSnapshot(diffs: Array<{ file: string; after: string; status: string }>): string {
  return JSON.stringify({
    info: snapshotInfo(),
    messages: [{ info: { summary: { diffs } } }],
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

type MockKiloOptions = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  sleepSeconds?: number;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeMockKilo(binDir: string, options: MockKiloOptions): void {
  const script = [
    '#!/bin/sh',
    options.stdout === undefined ? undefined : `printf '%s' ${shellQuote(options.stdout)}`,
    options.stderr === undefined ? undefined : `printf '%s' ${shellQuote(options.stderr)} >&2`,
    options.sleepSeconds === undefined ? undefined : `exec sleep ${options.sleepSeconds}`,
    `exit ${options.exitCode}`,
    '',
  ]
    .filter(line => line !== undefined)
    .join('\n');
  const kiloPath = path.join(binDir, 'kilo');
  fs.writeFileSync(kiloPath, script, { mode: 0o755 });
}

function writeSlowMockKilo(binDir: string): void {
  const script = "#!/bin/sh\nprintf '%s' 'recognizable timeout diagnostic' >&2\nsleep 1\nexit 0\n";
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

describe('restoreSession', () => {
  let tmpDir: string;
  let workspace: string;
  let binDir: string;
  let wrapperLogPath: string;
  let savedEnv: Record<string, string | undefined>;
  let originalFetch: typeof globalThis.fetch;

  const SESSION_ID = 'ses_test123';
  const TMP_PATH = `/tmp/kilo-session-export-${SESSION_ID}.json`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-test-'));
    workspace = path.join(tmpDir, 'workspace');
    binDir = path.join(tmpDir, 'bin');
    wrapperLogPath = path.join(tmpDir, 'wrapper.log');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    writeMockKilo(binDir, { exitCode: 0 });

    savedEnv = {
      IMPORT_API_KEY: process.env.IMPORT_API_KEY,
      IMPORT_SECRET: process.env.IMPORT_SECRET,
      KILO_SESSION_INGEST_URL: process.env.KILO_SESSION_INGEST_URL,
      KILOCODE_TOKEN: process.env.KILOCODE_TOKEN,
      KILOCODE_TOKEN_FILE: process.env.KILOCODE_TOKEN_FILE,
      PATH: process.env.PATH,
      WRAPPER_LOG_PATH: process.env.WRAPPER_LOG_PATH,
    };

    process.env.KILO_SESSION_INGEST_URL = 'http://localhost:9999';
    process.env.KILOCODE_TOKEN = 'test-token';
    delete process.env.KILOCODE_TOKEN_FILE;
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    process.env.WRAPPER_LOG_PATH = wrapperLogPath;

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
    mockFetchOk('{"info":{"id":"ses_test_fixture"},"messages":[not-json]}');

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('snapshot is not valid JSON');
      expect(result.code).toBeNull();
      expect(result.step).toBe('download');
    }
  });

  it('returns download error when bytes follow the JSON document', async () => {
    mockFetchOk('{"info":{"id":"ses_test_fixture"},"messages":[]} trailing');

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

  it('logs failed import stderr diagnostics while preserving the generic result', async () => {
    const snapshot = makeSnapshot([{ file: 'src/index.ts', after: 'content', status: 'modified' }]);
    mockFetchOk(snapshot);
    writeMockKilo(binDir, { exitCode: 1, stderr: 'recognizable stderr diagnostic' });

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result).toEqual({
      ok: false,
      error: 'kilo import failed exitCode=1',
      code: null,
      step: 'import',
    });
    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain('kilo import finished outcome=error exitCode=1');
    expect(wrapperLog).toContain(
      'kilo import diagnostics stream=stderr totalBytes=30 retainedBytes=30 truncated=false preview="recognizable stderr diagnostic"'
    );
  });

  it('logs failed import stdout diagnostics', async () => {
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, { exitCode: 1, stdout: 'recognizable stdout diagnostic' });

    await restoreSession(SESSION_ID, workspace);

    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain(
      'kilo import diagnostics stream=stdout totalBytes=30 retainedBytes=30 truncated=false preview="recognizable stdout diagnostic"'
    );
  });

  it('logs byte counts when a failed import has no diagnostic output', async () => {
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, { exitCode: 1 });

    await restoreSession(SESSION_ID, workspace);

    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain('kilo import diagnostics stdoutBytes=0 stderrBytes=0');
  });

  it('redacts secrets and ANSI escapes from failed import diagnostics', async () => {
    const kilocodeToken = 'configured-kilocode-token';
    const bearerToken = 'bearer-token-not-env';
    const basicToken = 'basic-token-not-env';
    const gitToken = 'git-token-not-env';
    const urlPassword = 'url-password-not-env';
    const tokenOnlyUrlSecret = 'token-only-url-secret-not-env';
    const signedUrlSecret = 'signed-url-secret-not-env';
    const abbreviatedSignedUrlSecret = 'azure-sas-secret-not-env';
    const assignmentSecret = 'correct horse; battery & staple@example.com';
    const privateKeyMaterial = 'private-key-material-not-env';
    const unfinishedPrivateKeyMaterial = 'unfinished-private-key-material-not-env';
    const jsonApiKey = 'json-api-key-not-env';
    const flagToken = 'flag-token-not-env';
    const envSecret = 'environment-secret';
    process.env.KILOCODE_TOKEN = kilocodeToken;
    process.env.IMPORT_API_KEY = envSecret;
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, {
      exitCode: 1,
      stderr: [
        '\u001b[31mvisible diagnostic\u001b[0m',
        `token=${kilocodeToken}`,
        `authorization=Bearer ${bearerToken}`,
        `basic=Basic ${basicToken}`,
        `git=https://x-access-token:${gitToken}@github.com/org/repo.git`,
        `url=https://user:${urlPassword}@example.com/path`,
        `tokenOnlyUrl=https://${tokenOnlyUrlSecret}@github.com/org/repo.git`,
        `signedUrl=https://example.com/export?X-Amz-Signature=${signedUrlSecret}`,
        `abbreviatedSignedUrl=https://example.blob.core.windows.net/file?sv=1&sig=${abbreviatedSignedUrlSecret}`,
        `password="${assignmentSecret}"`,
        `SSH_PRIVATE_KEY=-----BEGIN OPENSSH PRIVATE KEY-----\n${privateKeyMaterial}\n-----END OPENSSH PRIVATE KEY-----`,
        `{"apiKey":"${jsonApiKey}"}`,
        `--token ${flagToken}`,
        `\u009d0;terminal-title\u009cvisible after c1 controls`,
        `env=${envSecret}`,
        `UNFINISHED_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n${unfinishedPrivateKeyMaterial}`,
      ].join('\n'),
    });

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result).toEqual({
      ok: false,
      error: 'kilo import failed exitCode=1',
      code: null,
      step: 'import',
    });
    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain('[REDACTED]');
    expect(wrapperLog).toContain('visible diagnostic');
    expect(wrapperLog).toContain(
      'abbreviatedSignedUrl=https://example.blob.core.windows.net/file?[REDACTED]'
    );
    for (const secret of [
      kilocodeToken,
      bearerToken,
      basicToken,
      gitToken,
      urlPassword,
      tokenOnlyUrlSecret,
      signedUrlSecret,
      abbreviatedSignedUrlSecret,
      assignmentSecret,
      privateKeyMaterial,
      unfinishedPrivateKeyMaterial,
      jsonApiKey,
      flagToken,
      envSecret,
    ]) {
      expect(wrapperLog).not.toContain(secret);
    }
    expect(wrapperLog).not.toContain('horse');
    expect(wrapperLog).not.toContain('battery');
    expect(wrapperLog).not.toContain('staple@example.com');
    expect(wrapperLog).not.toContain('\\u001b');
    expect(wrapperLog).not.toContain('\u009d');
    expect(wrapperLog).not.toContain('\u009c');
  });

  it('redacts longer environment secrets before overlapping shorter values', async () => {
    const shortSecret = 'overlap-secret';
    const longSecret = `${shortSecret}-suffix`;
    process.env.IMPORT_SECRET = shortSecret;
    process.env.IMPORT_API_KEY = longSecret;
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, { exitCode: 1, stderr: `secret=${longSecret}` });

    await restoreSession(SESSION_ID, workspace);

    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain('secret=[REDACTED]');
    expect(wrapperLog).not.toContain('-suffix');
  });

  it('bounds diagnostics after secret redaction expands output', async () => {
    process.env.IMPORT_SECRET = 'x';
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, { exitCode: 1, stderr: 'x'.repeat(4_096) });

    await restoreSession(SESSION_ID, workspace);

    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    const diagnosticLine = wrapperLog
      .split('\n')
      .find(line => line.includes('kilo import diagnostics stream=stderr'));
    if (!diagnosticLine) throw new Error('missing stderr diagnostic line');
    expect(diagnosticLine).toContain('[REDACTED]');
    expect(diagnosticLine.length).toBeLessThan(5_000);
  });

  it('does not replace secrets inside redaction markers', async () => {
    process.env.IMPORT_API_KEY = 'x';
    process.env.IMPORT_SECRET = 'A';
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, { exitCode: 1, stderr: 'x' });

    await restoreSession(SESSION_ID, workspace);

    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain('preview="[REDACTED]"');
  });

  it('redacts token-file credentials from failed import diagnostics', async () => {
    const tokenPath = path.join(tmpDir, 'restore-token');
    const fileToken = 'token-file-secret';
    fs.writeFileSync(tokenPath, `${fileToken}\n`);
    delete process.env.KILOCODE_TOKEN;
    process.env.KILOCODE_TOKEN_FILE = tokenPath;
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, { exitCode: 1, stderr: `token=${fileToken}` });

    await restoreSession(SESSION_ID, workspace);

    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain('token=[REDACTED]');
    expect(wrapperLog).not.toContain(fileToken);
  });

  it('preserves import failure diagnostics when an optional token file cannot be read', async () => {
    process.env.KILOCODE_TOKEN_FILE = path.join(tmpDir, 'missing-token');
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, { exitCode: 1, stderr: 'diagnostic survives token-file read failure' });

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result).toEqual({
      ok: false,
      error: 'kilo import failed exitCode=1',
      code: null,
      step: 'import',
    });
    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain('diagnostic survives token-file read failure');
  });

  it('drains and truncates large failed import output from both streams', async () => {
    const retainedTail = 'retained-tail-sentinel';
    const largeOutput = `${'x'.repeat(256 * 1_024)}\n${retainedTail}`;
    process.env.IMPORT_SECRET = 'A';
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, { exitCode: 1, stdout: largeOutput, stderr: largeOutput });

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain(
      `kilo import diagnostics stream=stdout totalBytes=${largeOutput.length} retainedBytes=0 truncated=true`
    );
    expect(wrapperLog).toContain(
      `kilo import diagnostics stream=stderr totalBytes=${largeOutput.length} retainedBytes=0 truncated=true`
    );
    expect(wrapperLog).not.toContain(retainedTail);
    expect(wrapperLog).toContain('preview="[REDACTED]"');
    expect(wrapperLog.length).toBeLessThan(20_000);
  });

  it('terminates imports that exceed the diagnostic output budget', async () => {
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, {
      exitCode: 0,
      stdout: 'x'.repeat(1_048_577),
      sleepSeconds: 2,
    });

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('kilo import failed');
      expect(result.step).toBe('import');
    }
    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain('terminationReason=excessive-output');
  });

  it('terminates imports when combined stream output exceeds the diagnostic budget', async () => {
    const streamOutput = 'x'.repeat(600 * 1_024);
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, {
      exitCode: 0,
      stdout: streamOutput,
      stderr: streamOutput,
      sleepSeconds: 2,
    });

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(false);
    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain('terminationReason=excessive-output');
  });

  it('redacts a known secret suffix crossing the retained-tail boundary', async () => {
    const crossingToken = 'cross-boundary-secret-value';
    const retainedTokenSuffix = crossingToken.slice(8);
    const retainedTail = `${retainedTokenSuffix}${'y'.repeat(4_096 - retainedTokenSuffix.length)}`;
    process.env.KILOCODE_TOKEN = crossingToken;
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, {
      exitCode: 1,
      stderr: `${'x'.repeat(4_096)}${crossingToken.slice(0, 8)}${retainedTail}`,
    });

    await restoreSession(SESSION_ID, workspace);

    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain('preview="[REDACTED]"');
    expect(wrapperLog).not.toContain(retainedTokenSuffix);
  });

  it('redacts an unknown credential suffix crossing the retained-tail boundary', async () => {
    const bearerToken = `unknown-bearer-${'z'.repeat(512)}-recognizable-suffix`;
    const retainedTokenSuffix = bearerToken.slice(8);
    const retainedTail = `${retainedTokenSuffix}${'y'.repeat(4_096 - retainedTokenSuffix.length)}`;
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, {
      exitCode: 1,
      stderr: `${'x'.repeat(4_096)}Bearer ${bearerToken.slice(0, 8)}${retainedTail}`,
    });

    await restoreSession(SESSION_ID, workspace);

    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain('preview="[REDACTED]"');
    expect(wrapperLog).not.toContain('-recognizable-suffix');
  });

  it('redacts multiline credential tails whose opening marker was truncated', async () => {
    const privateKeyTailLine = 'private-key-tail-line-not-env';
    const retainedTail =
      `partial-private-key-line\n${privateKeyTailLine}\n-----END PRIVATE KEY-----`.padEnd(
        4_096,
        'y'
      );
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, { exitCode: 1, stderr: `${'x'.repeat(4_096)}${retainedTail}` });

    await restoreSession(SESSION_ID, workspace);

    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain('preview="[REDACTED]"');
    expect(wrapperLog).not.toContain(privateKeyTailLine);
  });

  it('terminates and returns import error when kilo import exceeds its deadline', async () => {
    mockFetchOk(makeSnapshot([]));
    writeSlowMockKilo(binDir);

    const result = await restoreSession(SESSION_ID, workspace, undefined, { importTimeoutMs: 500 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe('import');
      expect(result.error).toContain('kilo import timed out');
    }
    expect(fs.existsSync(TMP_PATH)).toBe(false);
    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).toContain('recognizable timeout diagnostic');
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

  it('drains but does not log successful import output', async () => {
    const stdout = `${'x'.repeat(256 * 1_024)}successful stdout sentinel`;
    const stderr = `${'y'.repeat(256 * 1_024)}successful stderr sentinel`;
    mockFetchOk(makeSnapshot([]));
    writeMockKilo(binDir, { exitCode: 0, stdout, stderr });

    const result = await restoreSession(SESSION_ID, workspace);

    expect(result.ok).toBe(true);
    const wrapperLog = fs.readFileSync(wrapperLogPath, 'utf8');
    expect(wrapperLog).not.toContain('successful stdout sentinel');
    expect(wrapperLog).not.toContain('successful stderr sentinel');
    expect(wrapperLog).not.toContain('kilo import diagnostics');
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
    writeMockKilo(binDir, { exitCode: 1 });

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
