import fs from 'node:fs/promises';
import path from 'node:path';
import { createKiloClient } from '@kilocode/sdk/v2';
import { z } from 'zod';
import {
  worktreeDeletePayloadSchema,
  type WorktreeDeletePayload,
  type WorktreeDeleteResult,
} from '../../../src/shared/sandbox-control-protocol';
import { fenceDirectoryOperations } from './worktree-operations';
import { directoryForSession, forgetAttachedRoot } from './session-directories';

const sessionSchema = z.object({
  id: z.string().startsWith('ses_').length(30),
  directory: z.string(),
});

type CleanupSession = z.infer<typeof sessionSchema>;

export type WorktreeKiloCleanupClient = {
  listSessionIds(directory: string): Promise<string[]>;
  getSession(directory: string, sessionId: string): Promise<CleanupSession | null>;
  children(directory: string, sessionId: string): Promise<CleanupSession[]>;
  abortSession(directory: string, sessionId: string): Promise<void>;
  stopSessionProcesses(directory: string, sessionId: string): Promise<void>;
  deleteSession(directory: string, sessionId: string): Promise<void>;
  closeTerminals(directory: string): Promise<void>;
  disposeDirectory(directory: string): Promise<void>;
};

function requireData<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (!result.response.ok || result.error !== undefined || result.data === undefined) {
    throw new Error('Kilo worktree cleanup was not confirmed');
  }
  return result.data;
}

function requireTrue(result: { data?: boolean; error?: unknown; response: Response }): void {
  if (requireData(result) !== true) throw new Error('Kilo worktree cleanup was not confirmed');
}

export function createWorktreeKiloCleanupClient(serverUrl: string): WorktreeKiloCleanupClient {
  const client = createKiloClient({ baseUrl: serverUrl });
  const options = () => ({ signal: AbortSignal.timeout(60_000) });
  return {
    async listSessionIds(directory) {
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = requireData(
          await client.v2.session.list({ directory, limit: 100, cursor }, options())
        );
        for (const session of page.data) ids.add(session.id);
        cursor = page.cursor.next;
        if (cursor && cursors.has(cursor))
          throw new Error('Kilo session pagination did not advance');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return [...ids];
    },
    async getSession(directory, sessionId) {
      const result = await client.session.get({ sessionID: sessionId, directory }, options());
      if (result.response.status === 404) return null;
      return sessionSchema.parse(requireData(result));
    },
    async children(directory, sessionId) {
      return z
        .array(sessionSchema)
        .parse(
          requireData(await client.session.children({ sessionID: sessionId, directory }, options()))
        );
    },
    async abortSession(directory, sessionId) {
      const result = await client.session.abort({ sessionID: sessionId, directory }, options());
      if (result.response.status !== 404) requireTrue(result);
    },
    async stopSessionProcesses(directory, sessionId) {
      requireTrue(
        await client.backgroundProcess.stopSession({ sessionID: sessionId, directory }, options())
      );
    },
    async deleteSession(directory, sessionId) {
      const result = await client.session.delete({ sessionID: sessionId, directory }, options());
      if (result.response.status !== 404) requireTrue(result);
    },
    async closeTerminals(directory) {
      const terminals = requireData(
        await client.interactiveTerminal.list({ directory }, options())
      );
      for (const terminal of terminals) {
        requireTrue(
          await client.interactiveTerminal.close(
            { terminalID: terminal.info.id, directory },
            options()
          )
        );
      }
      const ptys = requireData(await client.pty.list({ directory }, options()));
      for (const pty of ptys) {
        requireTrue(await client.pty.remove({ ptyID: pty.id, directory }, options()));
      }
      if (
        requireData(await client.pty.list({ directory }, options())).length > 0 ||
        requireData(await client.interactiveTerminal.list({ directory }, options())).some(
          terminal => terminal.info.status === 'running'
        )
      ) {
        throw new Error('Kilo terminal cleanup was not confirmed');
      }
    },
    async disposeDirectory(directory) {
      requireTrue(await client.instance.dispose({ directory }, options()));
    },
  };
}

export function validateWorktreeDirectory(input: WorktreeDeletePayload): void {
  const segments = input.directory.split('/');
  if (
    path.resolve(input.directory) !== input.directory ||
    segments[0] !== '' ||
    segments[1] !== 'workspace' ||
    (segments.length !== 5 && segments.length !== 6) ||
    segments.at(-2) !== 'worktrees' ||
    segments.at(-1) !== input.worktreeId ||
    segments
      .slice(2, -2)
      .some(segment => !/^[a-zA-Z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..') ||
    (segments.length === 6 && !z.uuid().safeParse(segments[2]).success)
  ) {
    throw new Error('Invalid worktree directory');
  }
}

async function assertNoSymlinks(directory: string): Promise<void> {
  let current = '/';
  for (const segment of directory.split('/').filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Invalid worktree directory');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  }
}

export type WorktreeCleanupDeps = {
  client?: WorktreeKiloCleanupClient;
  assertDirectory?: (directory: string) => Promise<void>;
  retireDirectory?: (directory: string) => Promise<void>;
  removeDirectory?: (directory: string) => Promise<void>;
  detachRoot?: (sessionId: string) => void;
  detachTerminals?: (directory: string) => Promise<void>;
};

export async function prepareWorktreeDeletion(
  raw: unknown,
  deps: WorktreeCleanupDeps
): Promise<string[]> {
  const input = worktreeDeletePayloadSchema.parse(raw);
  validateWorktreeDirectory(input);
  await fenceDirectoryOperations(input.directory);
  await (deps.assertDirectory ?? assertNoSymlinks)(input.directory);
  const { client } = deps;
  const sessionIds = new Set([
    ...input.sessionIds,
    ...(client ? await client.listSessionIds(input.directory) : []),
  ]);
  for (const sessionId of sessionIds) {
    const rememberedDirectory = directoryForSession(sessionId);
    if (rememberedDirectory && rememberedDirectory !== input.directory)
      throw new Error('Worktree session directory conflict');
    if (!client) continue;
    const session = await client.getSession(input.directory, sessionId);
    if (session && session.directory !== input.directory)
      throw new Error('Worktree session directory conflict');
    await client.abortSession(input.directory, sessionId);
    if (!session) continue;
    for (const child of await client.children(input.directory, sessionId)) {
      if (child.directory !== input.directory) throw new Error('Worktree child directory conflict');
      sessionIds.add(child.id);
    }
  }
  return [...sessionIds];
}

export async function deleteWorktree(
  raw: unknown,
  deps: WorktreeCleanupDeps
): Promise<WorktreeDeleteResult> {
  const input = worktreeDeletePayloadSchema.parse(raw);
  const sessionIds = await prepareWorktreeDeletion(input, deps);
  const journaled = new Set(input.sessionIds);
  if (sessionIds.some(id => !journaled.has(id)))
    throw new Error('Worktree cleanup manifest changed');
  const { client } = deps;
  if (client) {
    for (const sessionId of sessionIds) {
      await client.stopSessionProcesses(input.directory, sessionId);
    }
  }
  await deps.detachTerminals?.(input.directory);
  if (client) {
    await client.closeTerminals(input.directory);
    for (const sessionId of [...sessionIds].reverse()) {
      await client.deleteSession(input.directory, sessionId);
    }
    for (const sessionId of sessionIds) {
      if (await client.getSession(input.directory, sessionId))
        throw new Error('Kilo session deletion was not confirmed');
    }
    await client.disposeDirectory(input.directory);
  }
  await deps.retireDirectory?.(input.directory);
  await (deps.assertDirectory ?? assertNoSymlinks)(input.directory);
  await (deps.removeDirectory ?? (directory => fs.rm(directory, { recursive: true, force: true })))(
    input.directory
  );
  for (const sessionId of sessionIds) {
    forgetAttachedRoot(sessionId, input.directory);
    deps.detachRoot?.(sessionId);
  }
  return { deleted: true, sessionIds };
}
