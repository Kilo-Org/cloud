import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

import { migrateLegacyGoogleCredentialsToBroker } from './legacy-google-migration';

type ExecMockOptions = {
  credsPath: string;
  rejectOutFlag?: boolean;
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

function setupExecFileSyncMock(options: ExecMockOptions) {
  return execFileSyncMock.mockImplementation((command, args) => {
    if (command !== '/usr/local/bin/gog.real' || !args) {
      throw new Error(`unexpected command invocation: ${String(command)}`);
    }

    const argv = [...args];

    if (argv[0] === 'auth' && argv[1] === 'list') {
      return JSON.stringify({
        accounts: [{ email: 'user@gmail.com' }],
      });
    }

    if (argv[0] === 'auth' && argv[1] === 'tokens' && argv[2] === 'export') {
      const hasOutFlag = argv.includes('--out');
      if (hasOutFlag && options.rejectOutFlag) {
        throw new Error('unknown flag --out');
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
        throw new Error('missing export output path');
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
      return '';
    }

    if (argv[0] === 'auth' && argv[1] === 'credentials' && argv[2] === 'list') {
      return JSON.stringify({
        clients: [{ client: 'default', path: options.credsPath }],
      });
    }

    throw new Error(`unexpected gog invocation: ${argv.join(' ')}`);
  });
}

describe('migrateLegacyGoogleCredentialsToBroker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    execFileSyncMock.mockReset();
    for (const dir of testTmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses --out when exporting legacy tokens', async () => {
    const credsPath = createCredentialsFile();
    const execSpy = setupExecFileSyncMock({ credsPath });
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

    const exportCalls = execSpy.mock.calls
      .map(([, args]) => (args ? [...args] : []))
      .filter(args => args[0] === 'auth' && args[1] === 'tokens' && args[2] === 'export');

    expect(exportCalls).toHaveLength(1);
    expect(exportCalls[0]).toContain('--out');
    expect(exportCalls[0][4]).toBe('--out');
  });

  it('falls back to positional export args when --out is rejected', async () => {
    const credsPath = createCredentialsFile();
    const execSpy = setupExecFileSyncMock({ credsPath, rejectOutFlag: true });
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

    const exportCalls = execSpy.mock.calls
      .map(([, args]) => (args ? [...args] : []))
      .filter(args => args[0] === 'auth' && args[1] === 'tokens' && args[2] === 'export');

    expect(exportCalls).toHaveLength(2);
    expect(exportCalls[0]).toContain('--out');
    expect(exportCalls[1]).not.toContain('--out');
    expect(exportCalls[1][4]).toContain('gog-legacy-');
    expect(exportCalls[1][4]).toMatch(/token\.json$/);
  });
});
