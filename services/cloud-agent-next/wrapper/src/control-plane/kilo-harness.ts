import { createKiloClient } from '@kilocode/sdk';
import { WrapperBootstrapError } from '../bootstrap-error.js';
import { createWorktreeKiloCleanupClient } from '../control/delete-worktree.js';
import { summarizeWithTimeout } from '../condense-on-complete.js';
import {
  createWrapperKiloClient,
  isKiloServerUnreachableError,
  type WrapperKiloClient,
} from '../kilo-api.js';
import { fetchKiloServer, kiloClientConfig, type KiloServer } from '../kilo-server-auth.js';
import { restoreSession, seedSessionIngestRegistration } from '../restore-session.js';
import { reportRestoreIncomplete } from '../restore-incomplete.js';
import type { Harness } from './harness.js';
import { readSessionSnapshot } from './session-snapshot.js';

const RELEASE_CLEANUP_MAX_DEPTH = 8;
const RELEASE_CLEANUP_MAX_NODES = 64;
const RELEASE_CLEANUP_ATTEMPTS = 2;

export type KiloHarnessOptions = {
  server: KiloServer;
  directory: string;
  client?: WrapperKiloClient;
  restore?: typeof restoreSession;
  seedRegistration?: typeof seedSessionIngestRegistration;
  sessionExists?: (
    client: WrapperKiloClient,
    sessionId: string,
    directory: string,
    signal: AbortSignal
  ) => Promise<boolean>;
  readSnapshot?: typeof readSessionSnapshot;
  log?: (message: string) => void;
};

async function sessionExists(
  client: WrapperKiloClient,
  sessionId: string,
  directory: string,
  signal: AbortSignal
): Promise<boolean> {
  const url = new URL(`/session/${encodeURIComponent(sessionId)}`, client.serverUrl);
  url.searchParams.set('directory', directory);
  const response = await fetchKiloServer(client.server, url, { signal });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error('Kilo session probe failed');
  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null || !('id' in data) || data.id !== sessionId) {
    throw new Error('Kilo session probe returned an invalid session');
  }
  return true;
}

export function createKiloHarness(options: KiloHarnessOptions): Harness {
  const client =
    options.client ??
    createWrapperKiloClient(
      createKiloClient(kiloClientConfig(options.server, options.directory)),
      options.server,
      options.directory
    );
  const log = options.log ?? (() => undefined);
  return {
    async open(input) {
      const signal = input.signal ?? new AbortController().signal;
      await (options.seedRegistration ?? seedSessionIngestRegistration)(
        input.sessionId,
        input.env,
        signal
      );
      if (
        await (options.sessionExists ?? sessionExists)(
          client,
          input.sessionId,
          input.directory,
          signal
        )
      ) {
        return true;
      }
      input.onRestore();
      const restored = await (options.restore ?? restoreSession)(
        input.sessionId,
        input.directory,
        undefined,
        { env: input.env, signal, restoreFiles: input.restoreFiles }
      );
      if (restored.ok) {
        if (restored.diffs.skipped > 0) {
          await reportRestoreIncomplete({
            diffs: restored.diffs,
            identity: `kiloSessionId=${input.sessionId}`,
            log,
          }).catch(() => undefined);
        }
        return true;
      }
      if (restored.code !== 404 && !restored.emptySnapshot) {
        throw new WrapperBootstrapError({
          code: 'WORKSPACE_SETUP_FAILED',
          subtype: restored.subtype ?? 'kilo_import_failed',
          message: restored.error,
          retryable: true,
        });
      }
      await client.ensureSession(input.sessionId, input.directory, signal);
      return true;
    },
    submit: input =>
      client.sendPromptAsync({
        ...input,
        model: input.model === undefined ? undefined : { providerID: 'kilo', modelID: input.model },
      }),
    async command(input) {
      await client.sendCommand({
        ...input,
        model: input.model === undefined ? undefined : { providerID: 'kilo', modelID: input.model },
      });
    },
    compact: input => client.summarizeSession({ ...input, model: { modelID: input.model } }),
    condense: input =>
      summarizeWithTimeout({
        kiloClient: client,
        kiloSessionId: input.sessionId,
        directory: input.directory,
        model: input.model,
        signal: input.signal,
      }),
    answer: ({ reply, directory, interactive, signal }) => {
      if (reply.action === 'permission') {
        return client.answerPermission(
          reply.permissionId,
          reply.response,
          reply.message,
          interactive,
          directory,
          signal
        );
      }
      if (reply.action === 'reject')
        return client.rejectQuestion(reply.questionId, directory, signal);
      return client.answerQuestion(reply.questionId, reply.answers, directory, signal);
    },
    interrupt: input => client.abortSession(input),
    observe: input => (options.readSnapshot ?? readSessionSnapshot)({ ...input, client }),
    release: input => releaseKiloSessionTree(client, input),
    listCommands: () => client.listCommands(),
    generateCommitMessage: input => client.generateCommitMessage(input),
    isUnavailableError: isKiloServerUnreachableError,
    reads: {
      getSessionDetails: (...args) => client.getSessionDetails(...args),
      getRecentSessionMessages: (...args) => client.getRecentSessionMessages(...args),
      getSessionStatuses: (...args) => client.getSessionStatuses(...args),
      getSessionTodos: (...args) => client.getSessionTodos(...args),
      getSessionDiff: (...args) => client.getSessionDiff(...args),
      getQuestions: (...args) => client.getQuestions(...args),
      getPermissions: (...args) => client.getPermissions(...args),
    },
    terminals: {
      createPty: input => client.createPty(input),
      resizePty: (id, size, directory) => client.resizePty(id, size, directory),
      deletePty: (id, directory) => client.deletePty(id, directory),
      connectPty: (id, directory) => client.connectPty(id, directory),
      async isIdle(directory, signal) {
        const url = new URL('/pty', options.server.url);
        url.searchParams.set('directory', directory);
        const response = await fetchKiloServer(options.server, url, { signal });
        if (!response.ok) return false;
        const ptys: unknown = await response.json();
        return Array.isArray(ptys) && ptys.length === 0;
      },
    },
    worktree: createWorktreeKiloCleanupClient(options.server),
  };
}

async function releaseKiloSessionTree(
  client: WrapperKiloClient,
  input: Parameters<Harness['release']>[0]
): ReturnType<Harness['release']> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), input.deadlineMs);
  const deadline = new Promise<never>((_, reject) => {
    const abort = () => reject(new Error('release cleanup deadline exceeded'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  void deadline.catch(() => undefined);
  const visited = new Set<string>();
  const queue = [{ id: input.sessionId, depth: 0 }];
  let sessions = 0;
  let failures = 0;
  const attempt = async (operation: () => Promise<void>): Promise<boolean> => {
    for (let number = 1; number <= RELEASE_CLEANUP_ATTEMPTS; number++) {
      if (signal.aborted) return false;
      try {
        await Promise.race([operation(), deadline]);
        return true;
      } catch {
        if (number === RELEASE_CLEANUP_ATTEMPTS) return false;
      }
    }
    return false;
  };
  try {
    while (queue.length > 0 && sessions < RELEASE_CLEANUP_MAX_NODES && !signal.aborted) {
      const next = queue.shift();
      if (!next || visited.has(next.id)) continue;
      visited.add(next.id);
      sessions++;
      const target = { sessionId: next.id, directory: input.directory, signal };
      if (!(await attempt(() => client.abortSessionForCleanup(target)))) failures++;
      if (!(await attempt(() => client.stopSessionProcesses(target)))) failures++;
      if (next.depth >= RELEASE_CLEANUP_MAX_DEPTH) continue;
      let children: Array<{ id: string; directory: string }> = [];
      if (
        !(await attempt(async () => {
          children = await client.children(target);
        }))
      ) {
        failures++;
        continue;
      }
      for (const child of children) {
        if (child.directory === input.directory && !visited.has(child.id))
          queue.push({ id: child.id, depth: next.depth + 1 });
      }
    }
    return {
      ok: failures === 0 && !signal.aborted,
      sessions,
      failures,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
