import { describe, expect, it } from 'bun:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import { fetchKiloServer, kiloServerHeaders, type KiloServer } from '../kilo-server-auth.js';
import { createKiloRuntime } from './kilo-runtime.js';
import { createKiloEventFeed } from './kilo-event-feed.js';

const binary = process.env.KILO_781_BINARY;
const suite = binary ? describe : describe.skip;

type SocketOutcome = 'open' | 'error';

function socketOutcome(url: URL, headers: Record<string, string>): Promise<SocketOutcome> {
  const AuthenticatedWebSocket = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> }
  ) => WebSocket;
  const socket = new AuthenticatedWebSocket(url.toString(), { headers });
  return new Promise(resolve => {
    socket.onopen = () => {
      socket.close();
      resolve('open');
    };
    socket.onerror = () => resolve('error');
  });
}

suite('pinned Kilo server password', () => {
  it('the runtime starts Kilo with a password that only its own clients hold', async () => {
    if (!binary) throw new Error('KILO_781_BINARY is required');
    expect(Bun.spawnSync([binary, '--version']).stdout.toString().trim()).toBe('7.8.1');
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kilo-auth-781-'));
    let server: KiloServer | undefined;
    const runtime = createKiloRuntime({
      directory: root,
      env: {
        PATH: `${path.dirname(path.resolve(binary))}:${process.env.PATH ?? ''}`,
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, 'config'),
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
        XDG_STATE_HOME: path.join(root, 'state'),
        KILO_CONFIG_CONTENT: JSON.stringify({ share: 'disabled' }),
      },
      timers: CONTROL_PLANE_TIMERS,
      pidfileDirectory: path.join(root, 'pids'),
      log: () => undefined,
      openFeed(source, callbacks) {
        server = source.server;
        return createKiloEventFeed({ source, ...callbacks, log: () => undefined });
      },
    });
    try {
      // `ensure` resolves only after the runtime's SSE feed delivered a frame,
      // so the authenticated feed is part of this assertion.
      const client = await runtime.ensure();
      if (!server) throw new Error('Native server not observed');
      expect(server.authorization).toStartWith('Basic ');

      const sessionsUrl = new URL('/session', server.url);
      sessionsUrl.searchParams.set('directory', root);
      // A preview request carries no Kilo credential.
      expect((await fetch(sessionsUrl)).status).toBe(401);
      expect((await fetch(new URL('/global/health', server.url))).status).toBe(401);
      expect((await fetchKiloServer(server, sessionsUrl)).status).toBe(200);
      expect(
        await client.observe({
          directory: root,
          observedDirectories: [],
          knownSessions: [],
          signal: AbortSignal.timeout(5000),
        })
      ).toEqual([]);

      const pty = await client.terminals.createPty({ cwd: root, title: 'auth', env: {} });
      const connect = new URL(`/pty/${encodeURIComponent(pty.id)}/connect`, server.url);
      connect.protocol = 'ws:';
      connect.searchParams.set('directory', root);
      expect(await socketOutcome(connect, {})).toBe('error');
      expect(await socketOutcome(connect, kiloServerHeaders(server))).toBe('open');
      expect(await client.terminals.deletePty(pty.id, root)).toBe(true);
    } finally {
      await runtime.shutdown();
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
