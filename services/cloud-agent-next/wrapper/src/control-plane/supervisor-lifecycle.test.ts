// Real-subprocess regression for the wrapper lifecycle signal policy:
//
//   - a wrapper-only SIGTERM is recoverable: the wrapper exits non-zero and the
//     real supervisor restarts it (child replacement) without retiring;
//   - the supervisor's own TERM/INT trap is terminal and cleans the child up
//     without restarting or orphaning it, even though the real wrapper maps
//     SIGTERM to a recoverable non-zero exit;
//   - an authenticated `shutdown` frame is terminal (exit 0, no restart), and an
//     unauthenticated shutdown attempt does not terminate the wrapper.
//
// The fixture runs the real `controlPlaneExitPolicy`/`createControlPlaneLifecycle`
// and the real connection auth/frame path, so these assertions are about product
// behavior, not the fixture. Bounded restart/budget/backoff and the exit-0 loop
// end are already covered by `supervisor.test.ts` and are reused there.
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROL_PLANE_PROTOCOL_VERSION } from '../../../src/shared/control-plane-protocol.js';

const SUPERVISOR_PATH = join(import.meta.dir, '..', '..', 'control-plane-supervisor.sh');
const FIXTURE_PATH = join(import.meta.dir, 'supervisor-lifecycle-fixture.ts');
const CREDENTIAL = 'lifecycle-regression-credential';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

type Harness = {
  proc: Bun.Subprocess;
  stderr: () => string;
  exitCode: () => number | null;
  childPids: () => number[];
  liveChildPids: () => number[];
  waitForStderr: (needle: string | ((text: string) => boolean), ms: number) => Promise<boolean>;
  waitForChildren: (count: number, ms: number) => Promise<boolean>;
  cleanup: () => Promise<void>;
};

async function startSupervisor(env: Record<string, string>): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-lifecycle-'));
  const pidFile = join(dir, 'child.pid');
  const proc = Bun.spawn(['/bin/sh', SUPERVISOR_PATH], {
    env: {
      ...(process.env as Record<string, string>),
      CONTROL_PLANE_WRAPPER_COMMAND: `exec bun run ${FIXTURE_PATH}`,
      CONTROL_PLANE_NATIVE_LOGS: '1',
      CONTROL_PLANE_SUPERVISOR_BACKOFF_MIN_MS: '50',
      CONTROL_PLANE_SUPERVISOR_BACKOFF_MAX_MS: '50',
      WRAPPER_PID_FILE: pidFile,
      ...env,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  let stderr = '';
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of proc.stderr) stderr += decoder.decode(chunk);
  })();

  const childPids = (): number[] => {
    try {
      return readFileSync(pidFile, 'utf8')
        .split('\n')
        .map(line => Number.parseInt(line, 10))
        .filter(Number.isFinite);
    } catch {
      return [];
    }
  };
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitForStderr = async (
    needle: string | ((text: string) => boolean),
    ms: number
  ): Promise<boolean> => {
    const test = typeof needle === 'string' ? (t: string) => t.includes(needle) : needle;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (test(stderr)) return true;
      await sleep(25);
    }
    return test(stderr);
  };
  const waitForChildren = async (count: number, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (childPids().length >= count) return true;
      await sleep(25);
    }
    return childPids().length >= count;
  };
  const liveChildPids = (): number[] => childPids().filter(isAlive);
  return {
    proc,
    stderr: () => stderr,
    exitCode: () => proc.exitCode,
    childPids,
    liveChildPids,
    waitForStderr,
    waitForChildren,
    cleanup: async () => {
      try {
        if (proc.exitCode === null) proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      for (const pid of liveChildPids()) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
      await sleep(250);
      try {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      for (const pid of liveChildPids()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function waitForNoChild(h: Harness, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (h.liveChildPids().length === 0) return true;
    await sleep(25);
  }
  return h.liveChildPids().length === 0;
}

function startShutdownServer(accept: boolean): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (!accept || req.headers.get('authorization') !== `Bearer ${CREDENTIAL}`) {
        return new Response('unauthorized', { status: 401 });
      }
      if (srv.upgrade(req)) return;
      return new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(
          JSON.stringify({
            type: 'welcome',
            protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
            heartbeatAck: true,
          })
        );
        ws.send(JSON.stringify({ type: 'shutdown', reason: 'sandbox shutdown' }));
      },
      message() {},
      close() {},
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}

describe('control-plane supervisor lifecycle signals', () => {
  it('restarts a wrapper after a wrapper-only SIGTERM without retiring or duplicating it', async () => {
    const h = await startSupervisor({ FIXTURE_MODE: 'ready' });
    try {
      expect(await h.waitForStderr('supervisor_started', 4_000)).toBe(true);
      expect(await h.waitForChildren(1, 4_000)).toBe(true);
      const first = h.childPids()[0]!;

      process.kill(first, 'SIGTERM');
      expect(await h.waitForStderr('wrapper_restart', 6_000)).toBe(true);
      expect(await h.waitForChildren(2, 6_000)).toBe(true);
      // The replacement is running; the supervisor stays up.
      expect(h.exitCode()).toBeNull();

      const replacement = h.childPids()[1]!;
      expect(replacement).not.toBe(first);
      // Exactly one live child: the replacement. No duplicate, no orphan.
      expect(h.liveChildPids()).toEqual([replacement]);
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  it('stays terminal on supervisor TERM even though the real wrapper maps SIGTERM to a recoverable exit', async () => {
    const h = await startSupervisor({ FIXTURE_MODE: 'ready' });
    try {
      expect(await h.waitForStderr('supervisor_started', 4_000)).toBe(true);
      expect(await h.waitForChildren(1, 4_000)).toBe(true);

      process.kill(h.proc.pid!, 'SIGTERM');
      expect(await h.waitForStderr('supervisor_exit', 6_000)).toBe(true);
      expect(await h.proc.exited).toBe(0);
      expect(h.stderr()).not.toContain('wrapper_restart');
      expect(await waitForNoChild(h, 3_000)).toBe(true);
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  it('stays terminal on supervisor INT with orderly child cleanup and no restart', async () => {
    const h = await startSupervisor({ FIXTURE_MODE: 'ready' });
    try {
      expect(await h.waitForStderr('supervisor_started', 4_000)).toBe(true);
      expect(await h.waitForChildren(1, 4_000)).toBe(true);

      process.kill(h.proc.pid!, 'SIGINT');
      expect(await h.waitForStderr('supervisor_exit', 6_000)).toBe(true);
      expect(await h.proc.exited).toBe(0);
      expect(h.stderr()).not.toContain('wrapper_restart');
      expect(await waitForNoChild(h, 3_000)).toBe(true);
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  it('treats an authenticated shutdown frame as terminal (exit 0, no restart)', async () => {
    const server = startShutdownServer(true);
    const h = await startSupervisor({
      FIXTURE_MODE: 'shutdown-frame',
      CONTROL_PLANE_URL: `ws://127.0.0.1:${server.port}`,
      SANDBOX_CONTROL_CREDENTIAL: CREDENTIAL,
    });
    try {
      expect(await h.waitForStderr('supervisor_started', 4_000)).toBe(true);
      expect(await h.waitForStderr('supervisor_exit', 8_000)).toBe(true);
      expect(await h.proc.exited).toBe(0);
      expect(h.stderr()).not.toContain('wrapper_restart');
    } finally {
      await h.cleanup();
      server.stop();
    }
  }, 20_000);

  it('does not terminate the wrapper on an unauthenticated shutdown attempt', async () => {
    const server = startShutdownServer(false);
    const h = await startSupervisor({
      FIXTURE_MODE: 'shutdown-frame',
      CONTROL_PLANE_URL: `ws://127.0.0.1:${server.port}`,
      SANDBOX_CONTROL_CREDENTIAL: CREDENTIAL,
    });
    try {
      expect(await h.waitForStderr('supervisor_started', 4_000)).toBe(true);
      await sleep(1_500);
      expect(h.exitCode()).toBeNull();
      expect(h.stderr()).not.toContain('supervisor_exit');
      expect(h.stderr()).not.toContain('wrapper_restart');
    } finally {
      await h.cleanup();
      server.stop();
    }
  }, 20_000);
});
