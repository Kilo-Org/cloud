import type {
  ControlPlaneRouteSpec,
  WorkspaceHistorySession,
} from '../../../src/shared/control-plane-protocol.js';
import type { Harness } from './harness.js';
import type { HistoryPageRequest } from './history-requests.js';
import { withTimeoutAndAbort } from '../utils.js';

const PRELOAD_TIMEOUT_MS = 10_000;

/** History-only warmup, shared by sibling attachments to the same live runtime. */
export function createWorkspaceHistoryPreloader(deps: {
  readRecent?: (request: {
    sessionId: string;
    signal?: AbortSignal;
  }) => Promise<WorkspaceHistorySession[]>;
  readPage?: (request: HistoryPageRequest) => Promise<unknown>;
  log(message: string): void;
}) {
  const preloads = new WeakMap<Harness, Promise<void>>();
  const opening = new WeakMap<Harness, Map<string, Promise<boolean>>>();

  async function open(client: Harness, input: Parameters<Harness['open']>[0]): Promise<boolean> {
    input.signal?.throwIfAborted();
    let sessions = opening.get(client);
    if (!sessions) {
      sessions = new Map();
      opening.set(client, sessions);
    }
    const existing = sessions.get(input.sessionId);
    if (existing) return existing;
    const aborted = Promise.withResolvers<never>();
    const onAbort = () =>
      aborted.reject(input.signal?.reason ?? new Error('Session open was aborted'));
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const promise = Promise.race([client.open(input), aborted.promise]);
    sessions.set(input.sessionId, promise);
    try {
      return await promise;
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
      sessions.delete(input.sessionId);
    }
  }

  async function preload(
    client: Harness,
    spec: ControlPlaneRouteSpec,
    env: Record<string, string>,
    signal: AbortSignal
  ): Promise<void> {
    const readRecent = deps.readRecent;
    const readPage = deps.readPage;
    if (
      !readRecent ||
      !readPage ||
      spec.workspaceSnapshot ||
      spec.runtimeIsolation ||
      !spec.kilo?.scopeId.startsWith('worktree_')
    )
      return;
    const existing = preloads.get(client);
    if (existing) return existing;
    const controller = new AbortController();
    const budget = AbortSignal.any([signal, controller.signal]);
    const run = async () => {
      const recent = await readRecent({ sessionId: spec.sessionId, signal: budget });
      const results = await Promise.allSettled(
        recent
          .filter(session => session.kiloSessionId !== spec.kiloSessionId)
          .map(async session => {
            for (let attempt = 0; attempt < 2; attempt++) {
              budget.throwIfAborted();
              try {
                await open(client, {
                  sessionId: session.kiloSessionId,
                  directory: spec.directory,
                  env,
                  signal: budget,
                  restoreFiles: false,
                  readHistoryPage: cursor =>
                    readPage({
                      ...session,
                      cursor,
                      workspaceSessionId: spec.sessionId,
                      signal: budget,
                    }),
                  onRestore() {},
                });
                return;
              } catch (error) {
                if (attempt === 1) throw error;
              }
            }
          })
      );
      deps.log(
        `workspace history preload sessions=${results.length} failures=${results.filter(result => result.status === 'rejected').length}`
      );
    };
    const promise = withTimeoutAndAbort(run(), {
      timeoutMs: PRELOAD_TIMEOUT_MS,
      signal: budget,
      timeoutMessage: 'Workspace history preload timed out',
      abortMessage: 'Workspace history preload aborted',
    })
      .catch(() => {
        deps.log('workspace history preload incomplete; continuing session preparation');
      })
      .finally(() => controller.abort());
    preloads.set(client, promise);
    return promise;
  }

  return { open, preload };
}
