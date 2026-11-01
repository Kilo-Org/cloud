import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXEC_COMMAND_OUTPUT_TAIL_BYTES,
  type ControlPlaneExecRequestFrame,
  type ControlPlaneExecResult,
  type ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import { createSetupSpawn } from '../control/setup-cgroup.js';
import {
  fenceDirectoryOperations,
  resetDirectoryOperationState,
} from '../control/worktree-operations.js';
import { createSecretRedactor } from '../redact-output.js';
import type { ExecResult, ProcessOptions } from '../utils.js';
import { createControlPlaneExecRequests } from './exec-requests.js';
import type { PreparedExecRoute } from './prepare.js';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const KILO_SESSION_ID = 'ses_12345678901234567890123456';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  resetDirectoryOperationState();
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'exec-command-')));
  temporaryDirectories.push(directory);
  return directory;
}

function execRoute(directory: string, env: Record<string, string> = {}): PreparedExecRoute {
  const environment = { PATH: process.env.PATH ?? '', ...env };
  return {
    kiloSessionId: KILO_SESSION_ID,
    directory,
    env: environment,
    redact: createSecretRedactor({}, [environment], []),
  };
}

function request(
  command: string,
  timeoutMs: number,
  directory: string,
  overrides: { kiloSessionId?: string; directory?: string } = {}
): ControlPlaneExecRequestFrame {
  return {
    type: 'exec.request',
    requestId: 'exec_1',
    session: {
      sessionId: SESSION_ID,
      kiloSessionId: overrides.kiloSessionId ?? KILO_SESSION_ID,
      directory: overrides.directory ?? directory,
    },
    payload: { command, timeoutMs },
  };
}

function harness(
  route: PreparedExecRoute | null,
  runProcess?: (command: string, args: string[], options?: ProcessOptions) => Promise<ExecResult>
) {
  const emitted: ControlPlaneWrapperFrame[] = [];
  const executor = createControlPlaneExecRequests({
    emit: frame => emitted.push(frame),
    preparedRoute: () => route,
    spawn: createSetupSpawn({ enabled: false }),
    ...(runProcess ? { runProcess } : {}),
  });
  return { emitted, executor };
}

function success(emitted: ControlPlaneWrapperFrame[]): ControlPlaneExecResult {
  expect(emitted).toHaveLength(1);
  const frame = emitted[0];
  if (frame.type !== 'exec.result' || !frame.ok) {
    throw new Error(`Expected a successful exec result: ${JSON.stringify(frame)}`);
  }
  expect(Object.keys(frame.result)).toEqual([
    'exitCode',
    'timedOut',
    'durationMs',
    'stdoutTruncated',
    'stderrTruncated',
    'stdout',
    'stderr',
  ]);
  return frame.result;
}

function failure(emitted: ControlPlaneWrapperFrame[]): {
  code: string;
  message: string;
  retryable: boolean;
} {
  expect(emitted).toHaveLength(1);
  const frame = emitted[0];
  if (frame.type !== 'exec.result' || frame.ok) {
    throw new Error(`Expected a failed exec result: ${JSON.stringify(frame)}`);
  }
  return frame.error;
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error('file was not created');
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('control-plane exec requests', () => {
  it('runs in the prepared directory with the route environment', async () => {
    const directory = await temporaryDirectory();
    const h = harness(execRoute(directory, { EXEC_TEST_VALUE: 'visible' }));
    await h.executor.handle(request('pwd; printf "%s" "$EXEC_TEST_VALUE"', 5_000, directory));
    expect(success(h.emitted).stdout).toBe(`${directory}\nvisible`);
  });

  it('passes the command as a single argv without shell interpolation', async () => {
    const directory = await temporaryDirectory();
    const h = harness(execRoute(directory));
    await h.executor.handle(request(`printf '%s' 'semi;colon && echo injected'`, 5_000, directory));
    expect(success(h.emitted).stdout).toBe('semi;colon && echo injected');
  });

  it('closes stdin so a reading command returns immediately', async () => {
    const directory = await temporaryDirectory();
    const h = harness(execRoute(directory));
    await h.executor.handle(request('cat', 3_000, directory));
    const result = success(h.emitted);
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('reports a nonzero exit and keeps the streams separate', async () => {
    const directory = await temporaryDirectory();
    const h = harness(execRoute(directory));
    await h.executor.handle(request('echo out; echo err >&2; exit 7', 5_000, directory));
    const result = success(h.emitted);
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toBe('err\n');
  });

  it('truncates oversized output to the returned tail and keeps the marker', async () => {
    const directory = await temporaryDirectory();
    const h = harness(execRoute(directory));
    await h.executor.handle(
      request(`head -c 100000 /dev/zero | tr '\\0' 'a'; printf MARKER`, 5_000, directory)
    );
    const result = success(h.emitted);
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(EXEC_COMMAND_OUTPUT_TAIL_BYTES);
    expect(result.stdout.startsWith('a')).toBe(true);
    expect(result.stdout.endsWith('MARKER')).toBe(true);
  });

  it('does not split a multibyte character at the tail boundary', async () => {
    const directory = await temporaryDirectory();
    const h = harness(execRoute(directory));
    await h.executor.handle(request(`printf 'x'; printf '€%.0s' {1..3000}`, 5_000, directory));
    const result = success(h.emitted);
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(EXEC_COMMAND_OUTPUT_TAIL_BYTES);
    expect(result.stdout).not.toContain('\uFFFD');
    expect(result.stdout.endsWith('€')).toBe(true);
  });

  it('reports a timeout with exit code 124 and kills the background process', async () => {
    const directory = await temporaryDirectory();
    const pidFile = join(directory, 'pid');
    const h = harness(execRoute(directory));
    await h.executor.handle(request(`sleep 30 & echo $! > "${pidFile}"; wait`, 1_000, directory));
    const result = success(h.emitted);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.durationMs).toBeGreaterThanOrEqual(900);
    const pid = Number(await waitForFile(pidFile));
    for (let attempt = 0; attempt < 100 && processExists(pid); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(processExists(pid)).toBe(false);
  }, 10_000);

  it('escalates to SIGKILL when the process group ignores TERM', async () => {
    const directory = await temporaryDirectory();
    const pidFile = join(directory, 'pid');
    const h = harness(execRoute(directory));
    await h.executor.handle(
      request(`trap '' TERM; sleep 30 & echo $! > "${pidFile}"; wait`, 1_000, directory)
    );
    const result = success(h.emitted);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    const pid = Number(await waitForFile(pidFile));
    for (let attempt = 0; attempt < 100 && processExists(pid); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(processExists(pid)).toBe(false);
  }, 12_000);

  it('rejects a third concurrent command and releases the slot after completion', async () => {
    const directory = await temporaryDirectory();
    const h = harness(execRoute(directory));
    const first = h.executor.handle(request('sleep 0.6; printf first', 5_000, directory));
    const second = h.executor.handle(request('sleep 0.6; printf second', 5_000, directory));
    await h.executor.handle(request('printf third', 5_000, directory));
    expect(failure(h.emitted)).toMatchObject({ code: 'busy' });
    await Promise.all([first, second]);
    h.emitted.splice(0);
    await h.executor.handle(request('printf fourth', 5_000, directory));
    expect(success(h.emitted).stdout).toBe('fourth');
  }, 10_000);

  it('refuses a route whose session identity does not match', async () => {
    const directory = await temporaryDirectory();
    const h = harness(execRoute(directory));
    await h.executor.handle(
      request('printf ok', 5_000, directory, { kiloSessionId: 'ses_other_session_identifier_0' })
    );
    expect(failure(h.emitted)).toMatchObject({
      code: 'route_mismatch',
      message: 'The workspace runtime is not prepared for this session.',
    });
    h.emitted.splice(0);
    await h.executor.handle(request('printf ok', 5_000, directory, { directory: '/elsewhere' }));
    expect(failure(h.emitted)).toMatchObject({ code: 'route_mismatch' });
  });

  it('refuses a route that is not prepared', async () => {
    const h = harness(null);
    await h.executor.handle(request('printf ok', 5_000, '/workspace/app'));
    expect(failure(h.emitted)).toMatchObject({ code: 'route_mismatch' });
  });

  it('redacts a configured secret from the returned streams', async () => {
    const directory = await temporaryDirectory();
    const h = harness(execRoute(directory, { MY_SECRET: 'super-secret-value' }));
    await h.executor.handle(request(`printf '%s' "$MY_SECRET"`, 5_000, directory));
    const result = success(h.emitted);
    expect(result.stdout).toBe('[REDACTED]');
    expect(result.stdout).not.toContain('super-secret-value');
  });

  it('uses the route redactor current when the command finishes', async () => {
    const directory = await temporaryDirectory();
    const route = execRoute(directory);
    const h = harness(route);
    const pending = h.executor.handle(request('sleep 0.3; printf later', 5_000, directory));
    route.redact = text => text.replace('later', '[REDACTED]');
    await pending;
    expect(success(h.emitted).stdout).toBe('[REDACTED]');
  });

  it('reports active commands for heartbeat activity', async () => {
    const directory = await temporaryDirectory();
    const h = harness(execRoute(directory));
    expect(h.executor.hasActive()).toBe(false);
    const pending = h.executor.handle(request('sleep 0.3', 5_000, directory));
    expect(h.executor.hasActive()).toBe(true);
    await pending;
    expect(h.executor.hasActive()).toBe(false);
  });

  it('cancels a session command and does not run its remaining work', async () => {
    const directory = await temporaryDirectory();
    const marker = join(directory, 'marker');
    const h = harness(execRoute(directory));
    const pending = h.executor.handle(
      request(
        `echo started > "${marker}"; sleep 30; echo finished >> "${marker}"`,
        60_000,
        directory
      )
    );
    await waitForFile(marker);
    h.executor.cancelSession(SESSION_ID);
    await pending;
    expect(failure(h.emitted)).toMatchObject({
      code: 'cancelled',
      message:
        'The command was interrupted after it started. Inspect the workspace before retrying.',
      retryable: false,
    });
    expect(await readFile(marker, 'utf8')).toBe('started\n');
  }, 10_000);

  it('reports worktree_deleting when deletion cancels a running command', async () => {
    const directory = await temporaryDirectory();
    const marker = join(directory, 'marker');
    const h = harness(execRoute(directory));
    const pending = h.executor.handle(
      request(
        `echo started > "${marker}"; sleep 30; echo finished >> "${marker}"`,
        60_000,
        directory
      )
    );
    await waitForFile(marker);
    h.executor.cancelDirectory(directory);
    await pending;
    expect(failure(h.emitted)).toMatchObject({ code: 'worktree_deleting' });
    expect(await readFile(marker, 'utf8')).toBe('started\n');
  }, 10_000);

  it('refuses a command while the worktree is being deleted', async () => {
    const directory = await temporaryDirectory();
    await fenceDirectoryOperations(directory);
    const h = harness(execRoute(directory));
    await h.executor.handle(request('printf ok', 5_000, directory));
    expect(failure(h.emitted)).toMatchObject({ code: 'worktree_deleting' });
  });
});
