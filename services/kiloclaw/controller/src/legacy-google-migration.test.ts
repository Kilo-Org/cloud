import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, spawnSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
  spawnSync: spawnSyncMock,
}));

import { migrateLegacyGoogleCredentialsToBroker } from './legacy-google-migration';

type ExecMockOptions = {
  credsPath: string;
  rejectOutFlag?: boolean;
  rejectOverwriteFlag?: boolean;
  failOutExport?: boolean;
};

const testTmpDirs: string[] = [];

function createCredentialsFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-google-migration-test-'));
  testTmpDirs.push(dir);
  const credsPath = path.join(dir, 'credentials.json');
  fs.writeFileSync(
    credsPath,
    JSON.stringify({
      client_id: 'client-id',
      client_secret: 'client-secret',
    })
  );
  return credsPath;
}

function spawnResult(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: ['', '', ''],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    ...overrides,
  };
}

function setupChildProcessMocks(options: ExecMockOptions) {
  execFileSyncMock.mockImplementation((command, args) => {
    if (command !== '/usr/local/bin/gog.real' || !args) {
      throw new Error(`unexpected command invocation: ${String(command)}`);
    }

    const argv = [...args];

    if (argv[0] === 'auth' && argv[1] === 'list') {
      return JSON.stringify({
        accounts: [{ email: 'user@gmail.com' }],
      });
    }

    if (argv[0] === 'auth' && argv[1] === 'credentials' && argv[2] === 'list') {
      return JSON.stringify({
        clients: [{ client: 'default', path: options.credsPath }],
      });
    }

    throw new Error(`unexpected gog invocation: ${argv.join(' ')}`);
  });

  return spawnSyncMock.mockImplementation((command, args) => {
    if (command !== '/usr/local/bin/gog.real' || !args) {
      throw new Error(`unexpected spawn invocation: ${String(command)}`);
    }

    const argv = [...args];
    if (argv[0] !== 'auth' || argv[1] !== 'tokens' || argv[2] !== 'export') {
      throw new Error(`unexpected spawn invocation: ${argv.join(' ')}`);
    }

    const hasOutFlag = argv.includes('--out');
    const hasOverwriteFlag = argv.includes('--overwrite');

    if (hasOutFlag && options.rejectOutFlag) {
      return spawnResult({ status: 1, stderr: 'unknown flag: --out' });
    }

    if (hasOutFlag && options.failOutExport) {
      return spawnResult({
        status: 4,
        stderr: 'Secret not found in keyring (refresh token missing). Run: gog auth add <email>',
      });
    }

    if (!hasOutFlag && hasOverwriteFlag && options.rejectOverwriteFlag) {
      return spawnResult({ status: 1, stderr: 'unknown flag: --overwrite' });
    }

    let outPath = '';
    if (hasOutFlag) {
      const outFlagIndex = argv.indexOf('--out');
      if (outFlagIndex >= 0) {
        outPath = argv[outFlagIndex + 1] ?? '';
      }
    } else {
      outPath = argv[4] ?? '';
    }

    if (!outPath) {
      return spawnResult({ status: 1, stderr: 'empty outPath' });
    }

    fs.writeFileSync(
      outPath,
      JSON.stringify({
        email: 'user@gmail.com',
        client: 'default',
        services: ['calendar'],
        scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        refresh_token: 'refresh-token',
      })
    );
    return spawnResult({ status: 0 });
  });
}

describe('migrateLegacyGoogleCredentialsToBroker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    execFileSyncMock.mockReset();
    spawnSyncMock.mockReset();
    for (const dir of testTmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses --out when exporting legacy tokens', async () => {
    const credsPath = createCredentialsFile();
    const spawnSpy = setupChildProcessMocks({ credsPath });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await migrateLegacyGoogleCredentialsToBroker({
      apiKey: 'api-key',
      gatewayToken: 'gateway-token',
      sandboxId: 'sandbox-id',
      checkinUrl: 'https://example.com/api/controller/checkin',
    });

    expect(result).toEqual({
      attempted: true,
      migrated: true,
      reason: 'migrated',
    });

    const exportCalls = spawnSpy.mock.calls
      .map(([, args]) => (args ? [...args] : []))
      .filter(args => args[0] === 'auth' && args[1] === 'tokens' && args[2] === 'export');

    expect(exportCalls).toHaveLength(1);
    expect(exportCalls[0]).toContain('--out');
    expect(exportCalls[0][4]).toBe('--out');
  });

  it('falls back to positional export args when --out is rejected', async () => {
    const credsPath = createCredentialsFile();
    const spawnSpy = setupChildProcessMocks({ credsPath, rejectOutFlag: true });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await migrateLegacyGoogleCredentialsToBroker({
      apiKey: 'api-key',
      gatewayToken: 'gateway-token',
      sandboxId: 'sandbox-id',
      checkinUrl: 'https://example.com/api/controller/checkin',
    });

    expect(result).toEqual({
      attempted: true,
      migrated: true,
      reason: 'migrated',
    });

    const exportCalls = spawnSpy.mock.calls
      .map(([, args]) => (args ? [...args] : []))
      .filter(args => args[0] === 'auth' && args[1] === 'tokens' && args[2] === 'export');

    expect(exportCalls).toHaveLength(2);
    expect(exportCalls[0]).toContain('--out');
    expect(exportCalls[1]).not.toContain('--out');
    expect(exportCalls[1][4]).toContain('gog-legacy-');
    expect(exportCalls[1][4]).toMatch(/token\.json$/);
  });

  it('does not fallback to positional args for non-flag export failures', async () => {
    const credsPath = createCredentialsFile();
    const spawnSpy = setupChildProcessMocks({ credsPath, failOutExport: true });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await migrateLegacyGoogleCredentialsToBroker({
      apiKey: 'api-key',
      gatewayToken: 'gateway-token',
      sandboxId: 'sandbox-id',
      checkinUrl: 'https://example.com/api/controller/checkin',
    });

    expect(result).toEqual({
      attempted: true,
      migrated: false,
      reason: 'token_export_failed',
    });

    const exportCalls = spawnSpy.mock.calls
      .map(([, args]) => (args ? [...args] : []))
      .filter(args => args[0] === 'auth' && args[1] === 'tokens' && args[2] === 'export');

    expect(exportCalls).toHaveLength(1);
    expect(exportCalls[0]).toContain('--out');
  });

  it('falls back to --force when positional --overwrite is unsupported', async () => {
    const credsPath = createCredentialsFile();
    const spawnSpy = setupChildProcessMocks({
      credsPath,
      rejectOutFlag: true,
      rejectOverwriteFlag: true,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await migrateLegacyGoogleCredentialsToBroker({
      apiKey: 'api-key',
      gatewayToken: 'gateway-token',
      sandboxId: 'sandbox-id',
      checkinUrl: 'https://example.com/api/controller/checkin',
    });

    expect(result).toEqual({
      attempted: true,
      migrated: true,
      reason: 'migrated',
    });

    const exportCalls = spawnSpy.mock.calls
      .map(([, args]) => (args ? [...args] : []))
      .filter(args => args[0] === 'auth' && args[1] === 'tokens' && args[2] === 'export');

    expect(exportCalls).toHaveLength(3);
    expect(exportCalls[0]).toContain('--out');
    expect(exportCalls[1]).toContain('--overwrite');
    expect(exportCalls[2]).toContain('--force');
  });
});
