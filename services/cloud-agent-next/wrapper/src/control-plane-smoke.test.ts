import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmod, copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONTROL_PLANE_PROTOCOL_VERSION } from '../../src/shared/control-plane-protocol.js';
import {
  parseSmokeArgs,
  runControlPlaneSmoke,
  smokeShutdownFrame,
  smokeSupervisorEnv,
  smokeWelcomeFrame,
  validateSmokeHello,
  type ControlPlaneSmokeOptions,
} from './control-plane-smoke.js';

const WRAPPER_DIR = join(import.meta.dir, '..');

function options(extra: string[] = []) {
  return parseSmokeArgs([
    '--supervisor',
    '/usr/local/bin/kilocode-control-plane-supervisor.sh',
    '--protocol-version',
    '3',
    '--allocation-id',
    'alloc-1',
    ...extra,
  ]);
}

async function scratchExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

describe('control-plane smoke harness', () => {
  it('parses required and optional arguments', () => {
    const parsed = options();
    expect(parsed.supervisorPath).toBe('/usr/local/bin/kilocode-control-plane-supervisor.sh');
    expect(parsed.protocolVersion).toBe(3);
    expect(parsed.allocationId).toBe('alloc-1');
    expect(parsed.timerDivisor).toBe(20);
    expect(parsed.timeoutMs).toBe(45_000);
    expect(parsed.cleanupMs).toBe(5_000);
    expect(parsed.wrapperCommand).toBeUndefined();
  });

  it('rejects missing required arguments and valueless flags', () => {
    expect(() => parseSmokeArgs(['--supervisor'])).toThrow();
    expect(() => parseSmokeArgs(['--supervisor', '/x', '--allocation-id'])).toThrow();
    expect(() => parseSmokeArgs(['positional'])).toThrow();
  });

  it('builds the welcome and shutdown frames', () => {
    expect(smokeWelcomeFrame(3)).toEqual({ type: 'welcome', protocolVersion: 3 });
    expect(smokeShutdownFrame('snapshot-smoke')).toEqual({
      type: 'shutdown',
      reason: 'snapshot-smoke',
    });
  });

  it('validates the hello identity and protocol', () => {
    const expected = { allocationId: 'alloc-1', protocolVersion: 3 };
    expect(
      validateSmokeHello(
        { type: 'hello', wrapperId: 'w1', allocationId: 'alloc-1', protocolVersion: 3 },
        expected
      )
    ).toEqual({ wrapperId: 'w1', allocationId: 'alloc-1', protocolVersion: 3 });
    expect(() =>
      validateSmokeHello(
        { type: 'hello', wrapperId: 'w1', allocationId: 'other', protocolVersion: 3 },
        expected
      )
    ).toThrow();
    expect(() => validateSmokeHello({ type: 'welcome', protocolVersion: 3 }, expected)).toThrow();
  });

  it('runs the installed default command unless a wrapper command is provided', () => {
    const base = { CONTROL_PLANE_WRAPPER_COMMAND: 'exit 0', PATH: '/usr/bin' };
    const defaultEnv = smokeSupervisorEnv(
      options(['--scratch-dir', '/scratch']),
      'ws://127.0.0.1:1/x',
      '/home',
      '/log',
      base
    );
    expect(defaultEnv.CONTROL_PLANE_WRAPPER_COMMAND).toBeUndefined();
    expect(defaultEnv.SANDBOX_CONTROL_URL).toBe('ws://127.0.0.1:1/x');

    const overrideEnv = smokeSupervisorEnv(
      { ...options(['--scratch-dir', '/scratch']), wrapperCommand: 'exec bun run /tmp/cp.js' },
      'ws://127.0.0.1:1/x',
      '/home',
      '/log',
      base
    );
    expect(overrideEnv.CONTROL_PLANE_WRAPPER_COMMAND).toBe('exec bun run /tmp/cp.js');
  });
});

describe('control-plane smoke against the built distribution', () => {
  let root = '';
  let installDir = '';
  let controlWrapperPath = '';
  let supervisorPath = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'cp-smoke-test-'));
    installDir = join(root, 'install');
    const build = Bun.spawn(['bun', 'run', 'build.ts', '--install-dir', installDir], {
      cwd: WRAPPER_DIR,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const exitCode = await build.exited;
    if (exitCode !== 0) {
      throw new Error(`wrapper build failed: ${await new Response(build.stderr).text()}`);
    }
    supervisorPath = join(installDir, 'kilocode-control-plane-supervisor.sh');
    controlWrapperPath = join(installDir, 'kilocode-control-plane-wrapper.js');
  }, 60_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('installs the supervisor and executable bundles with the executable bit set by the build', async () => {
    for (const name of [
      'kilocode-control-plane-supervisor.sh',
      'bb',
      'github-review-publish-mcp',
    ]) {
      const mode = (await stat(join(installDir, name))).mode;
      expect(mode & 0o111).not.toBe(0);
    }
  });

  function smokeOptions(scratchDir: string, overrides: Partial<ControlPlaneSmokeOptions> = {}) {
    return {
      supervisorPath,
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      allocationId: 'alloc-smoke-test',
      credential: 'credential-smoke-test',
      timeoutMs: 30_000,
      cleanupMs: 5_000,
      scratchDir,
      timerDivisor: 20,
      wrapperCommand: `exec bun run ${controlWrapperPath}`,
      ...overrides,
    } satisfies ControlPlaneSmokeOptions;
  }

  it('drives the real bundle through the real supervisor and exits cleanly', async () => {
    const scratchDir = join(root, 'run');
    const started = Date.now();
    const result = await runControlPlaneSmoke(smokeOptions(scratchDir));
    const elapsed = Date.now() - started;

    expect(result.wrapperId.length).toBeGreaterThan(0);
    expect(result.allocationId).toBe('alloc-smoke-test');
    expect(result.protocolVersion).toBe(CONTROL_PLANE_PROTOCOL_VERSION);
    expect(result.connected).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.supervisorExitCode).toBe(0);
    expect(result.supervisorRestarts).toBe(0);
    expect(elapsed).toBeLessThan(20_000);
    expect(await scratchExists(scratchDir)).toBe(false);
  }, 60_000);

  it('fails and cleans up when the supervisor is not executable', async () => {
    const scratchDir = join(root, 'nonexec-run');
    const nonExecutable = join(root, 'supervisor-nonexec.sh');
    await copyFile(supervisorPath, nonExecutable);
    await chmod(nonExecutable, 0o644);

    const started = Date.now();
    let rejected = false;
    try {
      await runControlPlaneSmoke(
        smokeOptions(scratchDir, {
          supervisorPath: nonExecutable,
          timeoutMs: 4_000,
          cleanupMs: 2_000,
        })
      );
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await scratchExists(scratchDir)).toBe(false);
  }, 20_000);

  it('bounds timeout cleanup when the wrapper never exits', async () => {
    const scratchDir = join(root, 'timeout-run');
    const hang = join(root, 'supervisor-hang.sh');
    await writeFile(hang, '#!/bin/sh\nexec sleep 1000\n');
    await chmod(hang, 0o755);

    const started = Date.now();
    let rejected = false;
    try {
      await runControlPlaneSmoke(
        smokeOptions(scratchDir, {
          supervisorPath: hang,
          timeoutMs: 1_500,
          cleanupMs: 1_500,
        })
      );
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await scratchExists(scratchDir)).toBe(false);
  }, 20_000);
});
