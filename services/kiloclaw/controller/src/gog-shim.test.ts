import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function captureShimScript(): Promise<string> {
  const mkdirSpy = vi
    .spyOn(fs, 'mkdirSync')
    .mockImplementation(() => undefined as unknown as string);
  const chmodSpy = vi.spyOn(fs, 'chmodSync').mockImplementation(() => undefined);
  let script = '';
  const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data) => {
    if (String(file) === '/usr/local/bin/gog') {
      script = String(data);
      return;
    }
    return undefined;
  });

  const { installGogShim } = await import('./gog-shim');
  installGogShim();

  writeSpy.mockRestore();
  mkdirSpy.mockRestore();
  chmodSpy.mockRestore();

  return script;
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('gog shim script', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes only calendar commands through broker capabilities', async () => {
    const script = await captureShimScript();
    expect(script).toContain('calendar|cal)');
    expect(script).toContain('broker_capabilities=\'["calendar_read"]\'');
    expect(script).toContain('drive|docs|sheets)');
    expect(script).not.toContain('broker_capabilities=\'["drive_read"]\'');
    expect(script).not.toContain('broker_capabilities=\'["gmail_read"]\'');
    expect(script).toContain('capabilities\\":\${broker_capabilities}');
  });

  it('routes gmail and drive/docs/sheets commands to gog.real', async () => {
    const originalScript = await captureShimScript();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gog-shim-test-'));
    const realPath = path.join(tmp, 'gog.real');
    const shimPath = path.join(tmp, 'gog.sh');

    writeExecutable(realPath, '#!/usr/bin/env bash\nprintf "REAL_GOG %s" "$*"\n');

    const script = originalScript
      .replace('REAL_GOG="/usr/local/bin/gog.real"', `REAL_GOG="${realPath}"`)
      .replace('#!/usr/bin/env bash', '#!/bin/bash');

    writeExecutable(shimPath, script);

    const gmailOutput = execFileSync(shimPath, ['gmail', 'list', '--json'], {
      encoding: 'utf8',
      env: process.env,
    });
    expect(gmailOutput).toContain('REAL_GOG gmail list --json');

    const driveOutput = execFileSync(shimPath, ['drive', 'ls', '--json'], {
      encoding: 'utf8',
      env: process.env,
    });
    expect(driveOutput).toContain('REAL_GOG drive ls --json');
  });

  it('rejects mixed google and non-google auth --services commands', async () => {
    const originalScript = await captureShimScript();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gog-shim-test-'));
    const realPath = path.join(tmp, 'gog.real');
    const shimPath = path.join(tmp, 'gog.sh');

    writeExecutable(realPath, '#!/usr/bin/env bash\necho "real:$*"\n');

    const script = originalScript
      .replace('REAL_GOG="/usr/local/bin/gog.real"', `REAL_GOG="${realPath}"`)
      .replace('#!/usr/bin/env bash', '#!/bin/bash');

    writeExecutable(shimPath, script);

    let stderr = '';
    let code = 0;
    try {
      execFileSync(shimPath, ['auth', 'tokens', '--services', 'calendar,slack'], {
        encoding: 'utf8',
      });
    } catch (error) {
      const err = error as { status?: number; stderr?: string };
      code = err.status ?? 1;
      stderr = err.stderr ?? '';
    }

    expect(code).toBe(64);
    expect(stderr).toContain('mixed google and non-google auth --services is not supported');
  });

  it('falls back to gog.real when legacy migration failed', async () => {
    const originalScript = await captureShimScript();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gog-shim-test-'));
    const realPath = path.join(tmp, 'gog.real');
    const shimPath = path.join(tmp, 'gog.sh');

    writeExecutable(realPath, '#!/usr/bin/env bash\nprintf "REAL_GOG %s" "$*"\n');

    const script = originalScript
      .replace('REAL_GOG="/usr/local/bin/gog.real"', `REAL_GOG="${realPath}"`)
      .replace('#!/usr/bin/env bash', '#!/bin/bash');

    writeExecutable(shimPath, script);

    const output = execFileSync(shimPath, ['gmail', 'list', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        KILOCLAW_GOOGLE_LEGACY_MIGRATION_FAILED: '1',
      },
    });

    expect(output).toContain('REAL_GOG gmail list --json');
  });
});
