import type { IngestEvent } from '../../../src/shared/protocol.js';
import { runAutoCommit, type AutoCommitOptions, type AutoCommitResult } from '../auto-commit.js';
import { isEnvironmentRoot, type RouteRoot } from './workspace-roots.js';

type RootAutoCommitOptions = Omit<AutoCommitOptions, 'workspacePath' | 'upstreamBranch'>;

export type RootAutoCommitOutcome = {
  root: RouteRoot;
  result?: AutoCommitResult;
  /** An unexpected failure: the commit run threw instead of reporting a result. */
  error?: Error;
};

/**
 * One completion event for each repository carries the repository name, so a
 * client can tell the events of a turn apart. A legacy root names no repository
 * and its events are what they always were.
 */
function eventForRoot(root: RouteRoot, event: IngestEvent): IngestEvent {
  if (!isEnvironmentRoot(root)) return event;
  const { repoFullName } = root;
  const data = event.data as Record<string, unknown>;
  return {
    ...event,
    data: {
      ...data,
      repository: repoFullName,
      ...(typeof data.message === 'string' ? { message: `${repoFullName}: ${data.message}` } : {}),
    },
  };
}

/**
 * The failure to warn about for one root. A thrown error always counts. A
 * reported failure (`success: false`, such as a commit a hook rejected) counts
 * for a V2 root only: the clients keep one status for each message, so a later
 * root's success would hide it. A V1 route shows it as its completion event.
 */
export function autoCommitFailure(outcome: RootAutoCommitOutcome): string | undefined {
  if (outcome.error !== undefined) return outcome.error.message;
  const { result, root } = outcome;
  if (result === undefined || result.success || result.skipped || !isEnvironmentRoot(root)) {
    return undefined;
  }
  return result.error ?? 'commit failed';
}

/**
 * Auto-commits each root in turn. A root fails on its own: the others still run.
 * Only an aborted turn stops the pass after the first root, because every later
 * root would fail the same way. A root whose branch was requested passes it, so that a protected
 * branch the user chose can be committed to; a legacy root does not, as before.
 */
export async function autoCommitRoots(input: {
  roots: readonly RouteRoot[];
  options: RootAutoCommitOptions;
  autoCommit?: typeof runAutoCommit;
}): Promise<RootAutoCommitOutcome[]> {
  const autoCommit = input.autoCommit ?? runAutoCommit;
  const outcomes: RootAutoCommitOutcome[] = [];
  for (const root of input.roots) {
    // The first root always runs, so a route with one root does what it always did.
    if (outcomes.length > 0 && input.options.signal?.aborted) break;
    try {
      const result = await autoCommit({
        ...input.options,
        workspacePath: root.directory,
        ...(root.requestedBranch === undefined ? {} : { upstreamBranch: root.requestedBranch }),
        onEvent: event => input.options.onEvent(eventForRoot(root, event)),
      });
      outcomes.push({ root, result });
    } catch (error) {
      outcomes.push({ root, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
  return outcomes;
}
