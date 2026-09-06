import type { WrapperKiloClient } from '../kilo-api.js';
import { withKiloRequestDeadline } from './sandbox-control-runtime';
import type { WorktreeKiloRuntime } from './worktree-runtime.js';

type RootSnapshot = {
  kiloSessionId: string;
  directory: string | undefined;
  revision: symbol | undefined;
};

type DirectoryObservation = {
  runtime: WorktreeKiloRuntime;
  client: WrapperKiloClient;
  roots: readonly RootSnapshot[];
  pending: Promise<void> | undefined;
};

type NativeObservationDeps = {
  signal?: AbortSignal;
  roots: () => readonly RootSnapshot[];
  getRuntime: (directory: string) => WorktreeKiloRuntime | undefined;
  reconcileActivity: (
    statuses: Awaited<ReturnType<WrapperKiloClient['getSessionStatuses']>>,
    roots: readonly string[]
  ) => void;
};

export function createNativeObservations(deps: NativeObservationDeps) {
  const observations = new Map<string, DirectoryObservation>();

  function forget(directory: string): void {
    observations.delete(directory);
  }

  async function sampleDirectory(
    directory: string,
    roots: readonly RootSnapshot[],
    signal?: AbortSignal
  ): Promise<void> {
    const runtime = deps.getRuntime(directory);
    if (!runtime) {
      forget(directory);
      return;
    }
    const client = runtime.kiloClient;
    let entry = observations.get(directory);
    if (
      entry &&
      (entry.runtime !== runtime ||
        entry.client !== client ||
        entry.roots.length !== roots.length ||
        !entry.roots.every(before =>
          roots.some(
            root => root.kiloSessionId === before.kiloSessionId && root.revision === before.revision
          )
        ))
    ) {
      entry = undefined;
    }
    if (!entry) {
      entry = { runtime, client, roots: roots.map(root => ({ ...root })), pending: undefined };
      observations.set(directory, entry);
    }
    if (entry.pending) return entry.pending;
    const target = entry;
    const capturedRoots = target.roots;
    const signals = [runtime.signal];
    if (deps.signal) signals.push(deps.signal);
    if (signal) signals.push(signal);
    const readSignal = AbortSignal.any(signals);
    const isCurrent = () =>
      !readSignal.aborted &&
      observations.get(directory) === target &&
      deps.getRuntime(directory) === runtime &&
      runtime.kiloClient === client;

    const pending = (async () => {
      try {
        const statuses = await withKiloRequestDeadline(
          requestSignal => client.getSessionStatuses(directory, requestSignal),
          readSignal
        );
        if (!isCurrent()) return;
        const freshRoots = new Map(deps.roots().map(root => [root.kiloSessionId, root]));
        const currentRoots = capturedRoots
          .filter(before => {
            const root = freshRoots.get(before.kiloSessionId);
            return root?.directory === directory && root.revision === before.revision;
          })
          .map(root => root.kiloSessionId);
        deps.reconcileActivity(statuses, currentRoots);
      } catch {
        return;
      }
    })();
    target.pending = pending;
    await pending.finally(() => {
      if (target.pending === pending) target.pending = undefined;
    });
  }

  async function refresh(signal?: AbortSignal): Promise<void> {
    if (deps.signal?.aborted || signal?.aborted) return;
    const rootsByDirectory = new Map<string, RootSnapshot[]>();
    for (const root of deps.roots()) {
      if (!root.directory) continue;
      const roots = rootsByDirectory.get(root.directory) ?? [];
      roots.push(root);
      rootsByDirectory.set(root.directory, roots);
    }
    for (const directory of observations.keys()) {
      if (!rootsByDirectory.has(directory)) forget(directory);
    }
    await Promise.all(
      [...rootsByDirectory].map(([directory, roots]) => sampleDirectory(directory, roots, signal))
    );
  }

  return { refresh };
}

export type NativeObservations = ReturnType<typeof createNativeObservations>;
