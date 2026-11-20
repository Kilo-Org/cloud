import { z } from 'zod';
import { kiloServerHeaders, type KiloServer } from '../kilo-server-auth.js';
import type { HarnessTerminal, HarnessTerminals } from './harness.js';
import { Kilo2HttpError, type Kilo2Api } from './kilo2-api.js';

const MAX_SESSION_TERMINALS = 64;

/** The size-prefixed input frames of OpenCode's persistent PTY protocol. */
const PERSISTENT_PTY_INPUT_PROTOCOL = '1';

const terminalSizeSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const persistentPtySchema = z.object({
  id: z.string(),
  title: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  status: z.enum(['running', 'exited']),
  pid: z.number(),
  sessionID: z.string(),
  size: terminalSizeSchema,
  output: z.object({ head: z.number().int().nonnegative(), tail: z.number().int().nonnegative() }),
});

const snapshotSchema = z.object({
  info: persistentPtySchema,
  checkpoint: z.string(),
});

/**
 * The first message the browser receives on every connection: the screen at
 * `size`, encoded as base64 terminal output. The socket then streams output
 * from where the snapshot ends.
 */
export type PersistentPtySnapshotMessage = {
  type: 'snapshot';
  size: z.infer<typeof terminalSizeSchema>;
  checkpoint: string;
};

const persistentPtyPath = (id: string) =>
  `/api/experimental/persistent-pty/${encodeURIComponent(id)}`;

const sessionTerminalsPath = (sessionId: string) =>
  `/api/experimental/session/${encodeURIComponent(sessionId)}/terminal`;

function toHarnessTerminal(pty: z.infer<typeof persistentPtySchema>): HarnessTerminal {
  return {
    id: pty.id,
    title: pty.title,
    command: pty.command,
    args: pty.args,
    cwd: pty.cwd,
    status: pty.status,
    pid: pty.pid,
  };
}

/**
 * Kilo v2 terminals on the persistent PTY service, which keeps each screen in
 * libghostty-vt so that a new connection restores it from a snapshot.
 */
export function createKilo2Terminals(options: {
  api: Kilo2Api;
  server: KiloServer;
  listSessionIds: (directory: string, signal?: AbortSignal) => Promise<string[]>;
}) {
  const { api } = options;
  // A persistent PTY belongs to a session, not a directory, so the idle probe
  // reads the terminals this runtime created.
  const created = new Map<string, string>();

  async function remove(path: string, signal?: AbortSignal) {
    try {
      await api.request(path, { method: 'DELETE', signal });
    } catch (error) {
      if (!(error instanceof Kilo2HttpError && error.status === 404)) throw error;
    }
  }

  async function removeSessionTerminals(sessionId: string, signal?: AbortSignal) {
    const terminals = z
      .array(z.object({ id: z.string(), sessionID: z.string() }))
      .parse(await api.data(sessionTerminalsPath(sessionId), { signal }));
    if (terminals.length > MAX_SESSION_TERMINALS)
      throw new Error('Kilo v2 terminal cleanup exceeded its bounded window');
    for (const terminal of terminals) {
      if (terminal.sessionID !== sessionId)
        throw new Error('Kilo v2 terminal belongs to another session');
      await remove(persistentPtyPath(terminal.id), signal);
      created.delete(terminal.id);
    }
  }

  const terminals: HarnessTerminals = {
    async createPty(input) {
      const pty = persistentPtySchema.parse(
        await api.data(sessionTerminalsPath(input.sessionId), {
          method: 'POST',
          body: { args: [], cwd: input.cwd, title: input.title, env: input.env },
        })
      );
      created.set(pty.id, pty.cwd);
      return toHarnessTerminal(pty);
    },
    async resizePty(id, size) {
      return toHarnessTerminal(
        persistentPtySchema.parse(
          await api.data(persistentPtyPath(id), { method: 'PUT', body: { size } })
        )
      );
    },
    async deletePty(id) {
      await remove(persistentPtyPath(id));
      created.delete(id);
      return true;
    },
    async connectPty(id, _directory, attachmentId) {
      const snapshot = snapshotSchema.parse(await api.data(`${persistentPtyPath(id)}/snapshot`));
      const url = new URL(`${persistentPtyPath(id)}/connect`, options.server.url);
      url.searchParams.set('cursor', String(snapshot.info.output.tail));
      url.searchParams.set('attachment_id', attachmentId);
      url.searchParams.set('takeover', 'true');
      url.searchParams.set('input_protocol', PERSISTENT_PTY_INPUT_PROTOCOL);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const Socket = WebSocket as typeof WebSocket & {
        new (url: string, options: { headers: Record<string, string> }): WebSocket;
      };
      const greeting: PersistentPtySnapshotMessage = {
        type: 'snapshot',
        size: snapshot.info.size,
        checkpoint: snapshot.checkpoint,
      };
      return {
        socket: new Socket(url.toString(), { headers: kiloServerHeaders(options.server) }),
        greeting: JSON.stringify(greeting),
      };
    },
    async isIdle(directory, signal) {
      for (const [id, cwd] of created) {
        if (cwd !== directory) continue;
        try {
          const pty = persistentPtySchema.parse(await api.data(persistentPtyPath(id), { signal }));
          if (pty.status === 'running') return false;
        } catch (error) {
          if (!(error instanceof Kilo2HttpError && error.status === 404)) throw error;
          created.delete(id);
        }
      }
      return true;
    },
  };

  return {
    terminals,
    removeSessionTerminals,
    async closeDirectory(directory: string) {
      for (const sessionId of await options.listSessionIds(directory))
        await removeSessionTerminals(sessionId);
      for (const [id, cwd] of created) if (cwd === directory) await terminals.deletePty(id);
    },
  };
}
