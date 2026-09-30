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
  mode: 'accept' | 'reject';
};

function startControlServer(mode: 'accept' | 'reject'): {
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

describe('control-plane wrapper process', () => {
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
});
