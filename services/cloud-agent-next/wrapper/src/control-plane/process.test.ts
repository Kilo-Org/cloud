import { describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROL_PLANE_ALLOCATION_ID_ENV } from '../../../src/shared/control-plane-protocol.js';

const MAIN_PATH = join(import.meta.dir, 'main.ts');
const PROTOCOL_VERSION = 2;

type ServerState = {
  attempts: number;
  connections: number;
  hellos: Array<Record<string, unknown>>;
  mode: 'accept' | 'reject' | 'shutdown';
};

function startControlServer(mode: ServerState['mode']): {
  port: number;
  state: ServerState;
  send: (frame: unknown) => void;
  stop: () => void;
} {
  const state: ServerState = { attempts: 0, connections: 0, hellos: [], mode };
  const sockets = new Set<Bun.ServerWebSocket<undefined>>();
  const server = Bun.serve<undefined>({
    port: 0,
    fetch(request, srv) {
      state.attempts += 1;
      if (state.mode === 'reject') return new Response('rejected', { status: 503 });
      if (srv.upgrade(request)) return undefined;
      return new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      open(socket) {
        state.connections += 1;
        sockets.add(socket);
        if (state.mode === 'shutdown') {
          socket.send(JSON.stringify({ type: 'shutdown', reason: 'hello_rejected' }));
          socket.close(1008, 'shutdown');
          return;
        }
        socket.send(JSON.stringify({ type: 'welcome', protocolVersion: PROTOCOL_VERSION }));
      },
      message(_socket, raw) {
        const frame = JSON.parse(
          typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
        ) as Record<string, unknown>;
        if (frame.type === 'hello') state.hellos.push(frame);
      },
      close(socket) {
        sockets.delete(socket);
      },
    },
  });
  if (server.port === undefined) throw new Error('control server has no TCP port');
  return {
    port: server.port,
    state,
    send: frame => {
      for (const socket of sockets) {
        try {
          socket.send(JSON.stringify(frame));
        } catch {
          // Socket already closed.
        }
      }
    },
    stop: () => {
      void server.stop(true);
    },
  };
}

function childEnv(url: string, extra: Record<string, string> = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    SANDBOX_CONTROL_URL: url,
    SANDBOX_CONTROL_CREDENTIAL: 'test-credential',
    [CONTROL_PLANE_ALLOCATION_ID_ENV]: 'alloc-1',
    SANDBOX_INTERCEPT_HTTPS: '',
    WRAPPER_LOG_PATH: join(tmpdir(), `cp-wrapper-${process.pid}-${Date.now()}.log`),
    ...extra,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await Bun.sleep(10);
  }
}

async function waitForExit(child: Bun.Subprocess, timeoutMs: number): Promise<number> {
  return Promise.race([
    child.exited,
    (async () => {
      await Bun.sleep(timeoutMs);
      return Number.NaN;
    })(),
  ]);
}

/** A port that was bound and then released, so a connection is refused. */
async function closedPort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('closed') });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error('closed-port server has no TCP port');
  return port;
}

type CapturedChild = {
  child: Bun.Subprocess;
  stderr: () => string;
};

/** Spawns the real wrapper with piped stderr accumulated as it is written. */
function spawnWrapper(env: Record<string, string>): CapturedChild {
  const chunks: string[] = [];
  const child = Bun.spawn([process.execPath, 'run', MAIN_PATH], {
    env,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  void (async () => {
    const reader = (child.stderr as unknown as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // The process exited; the accumulated text is what we assert on.
    }
  })();
  return { child, stderr: () => chunks.join('') };
}

function statusLine(text: string): string | undefined {
  return text.split('\n').find(line => line.includes('"event":"wrapper.status"'));
}

function nativeLogsEnv(url: string, uploadPort: number): Record<string, string> {
  return childEnv(url, {
    CONTROL_PLANE_NATIVE_LOGS: '1',
    CONTROL_LOG_UPLOAD_URL: `http://127.0.0.1:${uploadPort}/sandbox-logs/a/b/c`,
    CONTROL_LOG_UPLOAD_GRANT: 'test-grant-value',
  });
}

describe('control-plane wrapper process', () => {
  it('exits 0 on terminal admission rejection before welcome without reconnecting', async () => {
    const server = startControlServer('shutdown');
    const child = Bun.spawn([process.execPath, 'run', MAIN_PATH], {
      env: childEnv(`ws://127.0.0.1:${server.port}/sandbox-control/fake`, {
        CONTROL_PLANE_TIMER_DIVISOR: '50',
      }),
      stdout: 'ignore',
      stderr: 'ignore',
    });
    try {
      expect(await waitForExit(child, 6_000)).toBe(0);
      expect(server.state.attempts).toBe(1);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      server.stop();
    }
  }, 10_000);

  it('stays alive across reconnect backoff instead of exiting', async () => {
    const server = startControlServer('reject');
    const child = Bun.spawn([process.execPath, 'run', MAIN_PATH], {
      env: childEnv(`ws://127.0.0.1:${server.port}/sandbox-control-v2/fake`, {
        CONTROL_PLANE_TIMER_DIVISOR: '50',
      }),
      stdout: 'ignore',
      stderr: 'ignore',
    });
    try {
      await Bun.sleep(1_500);
      expect(child.exitCode).toBeNull();
      expect(server.state.attempts).toBeGreaterThanOrEqual(2);
    } finally {
      child.kill();
      await child.exited;
      server.stop();
    }
  });

  it('recycles on SIGUSR1 and exits 0 on a shutdown frame', async () => {
    const server = startControlServer('accept');
    const child = Bun.spawn([process.execPath, 'run', MAIN_PATH], {
      env: childEnv(`ws://127.0.0.1:${server.port}/sandbox-control-v2/fake`, {
        CONTROL_PLANE_TIMER_DIVISOR: '50',
      }),
      stdout: 'ignore',
      stderr: 'ignore',
    });
    try {
      await waitFor(() => server.state.connections >= 1);
      process.kill(child.pid, 'SIGUSR1');
      await waitFor(() => server.state.connections >= 2);
      await waitFor(() => server.state.hellos.length >= 2);
      expect(server.state.hellos[1]?.wrapperId).toBeTypeOf('string');

      server.send({ type: 'shutdown', reason: 'test shutdown' });
      expect(await waitForExit(child, 6_000)).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      server.stop();
    }
  }, 20_000);

  it('writes one production-interval wrapper.status line when the native gate is set', async () => {
    const controlPort = await closedPort();
    const uploadPort = await closedPort();
    const handle = spawnWrapper(
      nativeLogsEnv(`ws://127.0.0.1:${controlPort}/sandbox-control-v2/fake`, uploadPort)
    );
    try {
      // The production interval is 60 s: nothing before 50 s.
      await Bun.sleep(50_000);
      expect(statusLine(handle.stderr())).toBeUndefined();

      let found: string | undefined;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        found = statusLine(handle.stderr());
        if (found) break;
        await Bun.sleep(500);
      }
      expect(found).toBeDefined();
      const record = JSON.parse(found ?? '{}') as {
        event: string;
        fields: Record<string, unknown>;
      };
      expect(record.event).toBe('wrapper.status');
      expect(record.fields.phase).toBe('status');
      expect(['connecting', 'idle']).toContain(String(record.fields.nativeConnectionPhase));
      expect(record.fields).not.toHaveProperty('oomKills');
      expect(record.fields).not.toHaveProperty('oomGroupKills');
      const text = handle.stderr();
      expect(text).not.toContain('test-credential');
      expect(text).not.toContain('test-grant-value');
      // Noisy, non-allowlisted events never reach the native gate.
      expect(text).not.toContain('"event":"control.heartbeat"');
      expect(text).not.toContain('"phase":"keepalive_sent"');
      expect(text).not.toContain('"phase":"retry_scheduled"');
      // The process is still alive when the line appears.
      expect(handle.child.exitCode).toBeNull();
    } finally {
      if (handle.child.exitCode === null) handle.child.kill();
      await handle.child.exited;
    }
  }, 90_000);

  it('writes no wrapper.status line when the native gate is unset', async () => {
    const controlPort = await closedPort();
    const uploadPort = await closedPort();
    const env = childEnv(`ws://127.0.0.1:${controlPort}/sandbox-control-v2/fake`, {
      CONTROL_LOG_UPLOAD_URL: `http://127.0.0.1:${uploadPort}/sandbox-logs/a/b/c`,
      CONTROL_LOG_UPLOAD_GRANT: 'test-grant-value',
    });
    // The gate is literally unset, not set to a falsy string.
    delete env.CONTROL_PLANE_NATIVE_LOGS;
    const handle = spawnWrapper(env);
    try {
      await Bun.sleep(70_000);
      expect(handle.child.exitCode).toBeNull();
      expect(statusLine(handle.stderr())).toBeUndefined();
    } finally {
      if (handle.child.exitCode === null) handle.child.kill();
      await handle.child.exited;
    }
  }, 90_000);

  it('exits 0 on SIGTERM after the status line and writes nothing after stopping', async () => {
    const controlPort = await closedPort();
    const uploadPort = await closedPort();
    const handle = spawnWrapper(
      nativeLogsEnv(`ws://127.0.0.1:${controlPort}/sandbox-control-v2/fake`, uploadPort)
    );
    try {
      const deadline = Date.now() + 75_000;
      while (Date.now() < deadline && statusLine(handle.stderr()) === undefined) {
        await Bun.sleep(500);
      }
      expect(statusLine(handle.stderr())).toBeDefined();
      process.kill(handle.child.pid, 'SIGTERM');
      expect(await waitForExit(handle.child, 8_000)).toBe(0);

      const text = handle.stderr();
      const stoppingIndex = text.indexOf('"phase":"stopping"');
      expect(stoppingIndex).toBeGreaterThanOrEqual(0);
      expect(text.slice(stoppingIndex)).not.toContain('"event":"wrapper.status"');
    } finally {
      if (handle.child.exitCode === null) handle.child.kill();
      await handle.child.exited;
    }
  }, 90_000);
});
