import { z } from 'zod';
import { boundSlashCommandCatalog } from '../../../src/shared/slash-commands.js';
import { createMessageId } from '../../../src/shared/message-id.js';
import { kiloServerHeaders, type KiloServer } from '../kilo-server-auth.js';
import { isKiloServerUnreachableError } from '../kilo-api.js';
import { git } from '../utils.js';
import type { Harness, HarnessSession } from './harness.js';
import { readSessionSnapshot } from './session-snapshot.js';
import {
  createKilo2Api,
  Kilo2HttpError,
  kilo2FormSchema,
  kilo2PermissionSchema,
  kilo2SessionPath,
} from './kilo2-api.js';
import { createKilo2Reads, kilo2LocationQuery as locationQuery } from './kilo2-reads.js';
import { restoreKilo2History } from './kilo2-history.js';
import type { Kilo2Lifecycle } from './kilo2-lifecycle.js';

const ptySchema = z.object({
  id: z.string(),
  title: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  status: z.enum(['running', 'exited']),
  pid: z.number(),
});

const MCP_SERVER_NAME = 'kilo-cloud-agent';
const mcpServerSchema = z.object({
  name: z.string(),
  status: z.object({ status: z.string() }),
});

export function createKilo2Harness(options: {
  server: KiloServer;
  directory: string;
  lifecycle: Kilo2Lifecycle;
}): Harness {
  const api = createKilo2Api(options.server);
  const { reads, session, list } = createKilo2Reads(api, options.directory);
  const post = (path: string, body: unknown, signal?: AbortSignal) =>
    api.request(path, { method: 'POST', body, signal });
  async function select(
    input: HarnessSession & { agent?: string; model?: string; variant?: string }
  ) {
    await options.lifecycle.waitForInterrupt(input.sessionId, input.signal);
    if (input.agent)
      await post(
        `${kilo2SessionPath(input.sessionId)}/agent`,
        { agent: input.agent },
        input.signal
      );
    if (input.model)
      await post(
        `${kilo2SessionPath(input.sessionId)}/model`,
        {
          model: {
            providerID: 'kilo',
            id: input.model,
            ...(input.variant ? { variant: input.variant } : {}),
          },
        },
        input.signal
      );
  }
  async function interrupt(input: HarnessSession) {
    const signal = input.signal ?? AbortSignal.timeout(10_000);
    return options.lifecycle.interrupt(input.sessionId, signal, async waitForClose => {
      const result = z
        .object({ interrupted: z.boolean() })
        .parse(await post(`${kilo2SessionPath(input.sessionId)}/interrupt`, undefined, signal));
      if (result.interrupted) await waitForClose();
      const active = z
        .record(z.string(), z.unknown())
        .parse(await api.data('/api/session/active', { signal }));
      return !(input.sessionId in active);
    });
  }
  async function compact(input: HarnessSession & { model: string }) {
    await select(input);
    await options.lifecycle.waitForInterrupt(input.sessionId, input.signal);
    const id = createMessageId();
    await post(`${kilo2SessionPath(input.sessionId)}/compact`, { id }, input.signal);
    await post(
      `/api/experimental/session/${encodeURIComponent(input.sessionId)}/wait`,
      undefined,
      input.signal ?? AbortSignal.timeout(180_000)
    );
    const result = z
      .object({
        type: z.literal('compaction'),
        status: z.enum(['completed', 'failed']),
        error: z.object({ message: z.string() }).optional(),
      })
      .parse(
        await api.data(`${kilo2SessionPath(input.sessionId)}/message/${encodeURIComponent(id)}`, {
          signal: input.signal,
        })
      );
    if (result.status === 'failed')
      throw new Error(
        `Kilo v2 compaction failed: ${result.error?.message ?? 'Unknown native failure'}`
      );
    return true;
  }
  async function remove(path: string, signal?: AbortSignal) {
    try {
      await api.request(path, { method: 'DELETE', signal });
    } catch (error) {
      if (!(error instanceof Kilo2HttpError && error.status === 404)) throw error;
    }
  }
  async function stopSessionProcesses(sessionId: string, signal?: AbortSignal) {
    const endpoint = `/api/experimental/session/${encodeURIComponent(sessionId)}/terminal`;
    const terminals = z
      .array(z.object({ id: z.string(), sessionID: z.string() }))
      .parse(await api.data(endpoint, { signal }));
    if (terminals.length > 64)
      throw new Error('Kilo v2 terminal cleanup exceeded its bounded window');
    for (const terminal of terminals) {
      if (terminal.sessionID !== sessionId)
        throw new Error('Kilo v2 terminal belongs to another session');
      await remove(`/api/experimental/persistent-pty/${encodeURIComponent(terminal.id)}`, signal);
    }
  }
  async function updateCloudAgentMcp(
    credential: Parameters<Harness['updateCloudAgentMcp']>[0],
    signal?: AbortSignal
  ) {
    const query = locationQuery(options.directory);
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      try {
        await api.request(`/api/experimental/mcp/${encodeURIComponent(MCP_SERVER_NAME)}?${query}`, {
          method: 'PUT',
          body: {
            config: {
              type: 'remote',
              url: credential.url,
              oauth: false,
              headers: { Authorization: `Bearer ${credential.token}` },
            },
          },
          signal,
        });
        const servers = z
          .array(mcpServerSchema)
          .parse(await api.request(`/api/mcp?${query}`, { signal }));
        if (servers.find(server => server.name === MCP_SERVER_NAME)?.status.status === 'connected')
          return;
      } catch {
        signal?.throwIfAborted();
      }
    }
    throw new Error('Cloud Agent MCP credential refresh failed');
  }
  const terminals: Harness['terminals'] = {
    async createPty(input) {
      return ptySchema.parse(
        await api.data(`/api/pty?${locationQuery(input.cwd)}`, { method: 'POST', body: input })
      );
    },
    async resizePty(id, size, directory = options.directory) {
      return ptySchema.parse(
        await api.data(`/api/pty/${encodeURIComponent(id)}?${locationQuery(directory)}`, {
          method: 'PUT',
          body: { size },
        })
      );
    },
    async deletePty(id, directory = options.directory) {
      await remove(`/api/pty/${encodeURIComponent(id)}?${locationQuery(directory)}`);
      return true;
    },
    connectPty(id, directory) {
      const url = new URL(
        `/api/pty/${encodeURIComponent(id)}/connect?${locationQuery(directory)}`,
        options.server.url
      );
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const Socket = WebSocket as typeof WebSocket & {
        new (url: string, options: { headers: Record<string, string> }): WebSocket;
      };
      return new Socket(url.toString(), { headers: kiloServerHeaders(options.server) });
    },
    async isIdle(directory, signal) {
      return z
        .array(ptySchema)
        .parse(await api.data(`/api/pty?${locationQuery(directory)}`, { signal }))
        .every(pty => pty.status === 'exited');
    },
  };
  return {
    async open(input) {
      try {
        const existing = await session(input.sessionId, input.signal);
        if (existing.location.directory !== input.directory)
          throw new Error('Kilo v2 session belongs to another directory');
      } catch (error) {
        if (!(error instanceof Kilo2HttpError && error.status === 404)) throw error;
        if (!(await restoreKilo2History(api, input)))
          await post(
            '/api/session',
            { id: input.sessionId, location: { directory: input.directory } },
            input.signal
          );
      }
      // Native history stays in kilo2's database and is restored from local Cloud history.
      return true;
    },
    async submit(input) {
      await select(input);
      await options.lifecycle.waitForInterrupt(input.sessionId, input.signal);
      await post(
        `${kilo2SessionPath(input.sessionId)}/prompt`,
        {
          id: input.messageId,
          text: input.parts
            ? input.parts
                .filter(part => part.type === 'text')
                .map(part => part.text)
                .join('\n')
            : (input.prompt ?? ''),
          files: input.parts
            ?.filter(part => part.type === 'file')
            .map(part => ({ uri: part.url, name: part.filename })),
          delivery: 'steer',
        },
        input.signal
      );
    },
    async command(input) {
      await select(input);
      await options.lifecycle.waitForInterrupt(input.sessionId, input.signal);
      await post(
        `${kilo2SessionPath(input.sessionId)}/command`,
        { name: input.command, text: input.args ?? '' },
        input.signal
      );
    },
    compact,
    async condense(input) {
      try {
        const success = await compact(input);
        return {
          success,
          wasAborted: false,
          ...(success ? {} : { error: 'Kilo v2 compaction failed' }),
        };
      } catch (error) {
        return {
          success: false,
          wasAborted: input.signal?.aborted ?? false,
          error: error instanceof Error ? error.message : 'Kilo v2 compaction failed',
        };
      }
    },
    async answer({ reply, directory, signal }) {
      if (reply.action === 'permission') {
        const pending = z
          .array(kilo2PermissionSchema)
          .parse(await api.data(`/api/permission/request?${locationQuery(directory)}`, { signal }));
        const request = pending.find(item => item.id === reply.permissionId);
        if (!request) return false;
        await post(
          `${kilo2SessionPath(request.sessionID)}/permission/${encodeURIComponent(request.id)}/reply`,
          { decision: reply.response, ...(reply.message ? { message: reply.message } : {}) },
          signal
        );
      } else {
        const pending = z
          .array(kilo2FormSchema)
          .parse(await api.data(`/api/form?${locationQuery(directory)}`, { signal }));
        const form = pending.find(item => item.id === reply.questionId);
        if (!form) return false;
        const path = `${kilo2SessionPath(form.sessionID)}/form/${encodeURIComponent(form.id)}`;
        if (reply.action === 'reject') await remove(path, signal);
        else
          await post(
            `${path}/reply`,
            {
              answer: Object.fromEntries(
                form.fields.map((field, index) => {
                  const selected = reply.answers[index] ?? [];
                  const values = selected.map(
                    label => field.options?.find(option => option.label === label)?.value ?? label
                  );
                  return [field.key, field.type === 'multiselect' ? values : (values[0] ?? '')];
                })
              ),
            },
            signal
          );
      }
      return true;
    },
    interrupt,
    observe: input => readSessionSnapshot({ ...input, client: reads }),
    async release(input) {
      const start = Date.now();
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.deadlineMs)]);
      let failures = 0;
      const sessions = await list(input.directory, signal);
      const ids = new Set([input.sessionId]);
      for (let depth = 0; depth < 8; depth++)
        for (const item of sessions) if (item.parentID && ids.has(item.parentID)) ids.add(item.id);
      if (ids.size > 64) throw new Error('Kilo v2 release exceeded its bounded window');
      for (const sessionId of ids) {
        try {
          if (!(await interrupt({ ...input, sessionId, signal }))) failures++;
          await stopSessionProcesses(sessionId, signal);
        } catch (error) {
          if (!(error instanceof Kilo2HttpError && error.status === 404)) failures++;
        }
      }
      return { ok: failures === 0, sessions: ids.size, failures, elapsedMs: Date.now() - start };
    },
    async listCommands() {
      const commands = z
        .array(z.object({ name: z.string(), description: z.string().optional() }).passthrough())
        .parse(await api.data(`/api/command?${locationQuery(options.directory)}`));
      return boundSlashCommandCatalog(
        commands.map(command => ({
          name: command.name,
          description: command.description ?? '',
          hints: [],
        }))
      );
    },
    async generateCommitMessage(input) {
      const diff = await git(['diff', 'HEAD', '--no-ext-diff', '--no-textconv'], {
        cwd: input.path,
        signal: input.signal,
        timeoutMs: 10_000,
        maxOutputBytes: 128 * 1024,
      });
      const status = await git(['status', '--short'], {
        cwd: input.path,
        signal: input.signal,
        timeoutMs: 10_000,
        maxOutputBytes: 32 * 1024,
      });
      if (diff.exitCode !== 0 || status.exitCode !== 0)
        throw new Error('Cannot read changes for commit message generation');
      const result = z.object({ text: z.string() }).parse(
        await api.data('/api/experimental/generate', {
          method: 'POST',
          body: {
            prompt: `Write a short git commit message for these changes. Return only the commit message.\n\nStatus:\n${status.stdout}\n\nDiff:\n${diff.stdout}`,
          },
          signal: input.signal,
        })
      );
      return { message: result.text };
    },
    isUnavailableError: isKiloServerUnreachableError,
    updateCloudAgentMcp,
    reads,
    terminals,
    worktree: {
      async listSessionIds(directory) {
        return (await list(directory)).map(info => info.id);
      },
      async getSession(directory, id) {
        try {
          const info = await session(id);
          return info.location.directory === directory ? { id, directory } : null;
        } catch (error) {
          if (error instanceof Kilo2HttpError && error.status === 404) return null;
          throw error;
        }
      },
      async children(directory, id) {
        return (await list(directory))
          .filter(info => info.parentID === id)
          .map(info => ({ id: info.id, directory }));
      },
      async abortSession(directory, sessionId) {
        if (!(await interrupt({ directory, sessionId })))
          throw new Error('Kilo v2 cancellation was not confirmed');
      },
      async stopSessionProcesses(directory, sessionId) {
        if (!(await interrupt({ directory, sessionId })))
          throw new Error('Kilo v2 cancellation was not confirmed');
        await stopSessionProcesses(sessionId);
      },
      async deleteSession(_directory, id) {
        await remove(kilo2SessionPath(id));
      },
      async closeTerminals(directory) {
        const ptys = z
          .array(ptySchema)
          .parse(await api.data(`/api/pty?${locationQuery(directory)}`));
        for (const pty of ptys) await terminals.deletePty(pty.id, directory);
      },
      async disposeDirectory(directory) {
        // V2 locations are process-owned caches. Cloud removes the directory after
        // session and PTY cleanup; there is no per-location disposal endpoint.
        if (
          (await list(directory)).length ||
          !(await terminals.isIdle(directory, AbortSignal.timeout(20_000)))
        )
          throw new Error('Kilo v2 directory still has native resources');
      },
    },
  };
}
