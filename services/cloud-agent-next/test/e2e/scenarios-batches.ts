/**
 * Deployed E2E batch definitions.
 *
 * Dependency-free and erasable-TypeScript-only, so
 * `node test/e2e/scenarios-batches.ts` runs under Node 24's default type
 * stripping with no install. It deliberately does not import `SHARED_SCENARIOS`
 * (or anything else): callers pass the registry keys, which is also what lets
 * the partition be checked against the real registry in tests.
 *
 * `parallel` is the batch's child-process concurrency when `E2E_PARALLEL` is
 * unset; `E2E_PARALLEL` remains an explicit override. Treat it as an
 * experiment to recalibrate after an operator run, not a proven live-allocation
 * bound: a finished scenario can retain its allocation until the idle stop, so
 * the peak number of live allocations can exceed the active-child count.
 */

import { pathToFileURL } from 'node:url';

export const MAX_BATCH_PARALLEL = 4;

export type E2EBatch = {
  scenarios: readonly string[];
  parallel: number;
};

/**
 * Exactly four disjoint batches, together every `SHARED_SCENARIOS` key once.
 * Membership and ordering follow the accepted plan (plan §5.2).
 */
export const E2E_BATCHES: Record<string, E2EBatch> = {
  'long-question-idle': {
    scenarios: ['question-idle-resume', 'auth-reject', 'unknown-model'],
    parallel: 2,
  },
  'long-leave-return': {
    scenarios: ['leave-and-return', 'chunked-streaming', 'empty-response'],
    parallel: 2,
  },
  'mid-worktree-load': {
    scenarios: [
      'worktree-multi-chat',
      'concurrent-chats',
      'callback-batch-followup',
      'long-conversation',
      'large-stream',
    ],
    parallel: 3,
  },
  'short-queue-callbacks': {
    scenarios: [
      'queue-while-busy',
      'queue-interrupt-clears',
      'callback-interrupt',
      'callback-completion',
      'llm-error',
      'hot',
      'interrupt-then-continue',
      'queue-overflow',
      'cold-hot',
      'queue-rapid-fire-no-gate',
      'cold',
      'interrupt-mid-stream',
      'worktree-chat',
      'external-kill',
      'kill-mid-flight',
      'wrapper-freeze-settled-reap',
      'wrapper-freeze-inflight-reap',
    ],
    parallel: 3,
  },
};

/**
 * The single owner of the unknown-member rule and its diagnostic. Both the
 * exhaustive validator and `resolveBatch` call this, so the rule and its text
 * cannot drift between them. Not exported: it is an implementation detail of
 * this module, not a third entry point.
 */
function unknownScenarioErrors(
  batchName: string,
  scenarios: readonly string[],
  registryKeys: readonly string[]
): string[] {
  const registry = new Set(registryKeys);
  const errors: string[] = [];
  for (const scenario of scenarios) {
    if (!registry.has(scenario)) {
      errors.push(`batch "${batchName}" lists unknown scenario "${scenario}"`);
    }
  }
  return errors;
}

/**
 * The single owner of batch membership validation. Returns every error so a
 * caller can print them all and fail once; an empty array means valid.
 *
 * Rules: a scenario listed by a batch that is not a registry key (delegated to
 * `unknownScenarioErrors`); a scenario listed by more than one batch; a registry
 * scenario missing from every batch; and a `parallel` outside
 * `[1, MAX_BATCH_PARALLEL]`.
 */
export function validateScenarioBatches(
  batches: Record<string, E2EBatch>,
  registryKeys: readonly string[]
): string[] {
  const errors: string[] = [];
  const registry = new Set(registryKeys);
  const placed = new Set<string>();

  for (const [batchName, batch] of Object.entries(batches)) {
    if (
      !Number.isInteger(batch.parallel) ||
      batch.parallel < 1 ||
      batch.parallel > MAX_BATCH_PARALLEL
    ) {
      errors.push(
        `batch "${batchName}" has parallel ${batch.parallel}; must be an integer in [1, ${MAX_BATCH_PARALLEL}]`
      );
    }
    errors.push(...unknownScenarioErrors(batchName, batch.scenarios, registryKeys));
    for (const scenario of batch.scenarios) {
      // Unknown members were already reported; they are not placed.
      if (!registry.has(scenario)) continue;
      if (placed.has(scenario)) {
        errors.push(`scenario "${scenario}" is listed in more than one batch`);
        continue;
      }
      placed.add(scenario);
    }
  }

  for (const name of registryKeys) {
    if (!placed.has(name)) {
      errors.push(`scenario "${name}" is missing from every batch`);
    }
  }

  return errors;
}

export type BatchResolution =
  | { ok: true; name: string; scenarios: readonly string[]; parallel: number }
  | { ok: false; errors: string[] };

/**
 * Resolve one batch. `null` means the name is not an own key of `E2E_BATCHES`
 * (an inherited name such as `toString` is unknown, never a lookup hit).
 *
 * Resolution never filters: the declared membership and parallelism are
 * returned unchanged so a member can never silently disappear. If the supplied
 * registry is missing a declared member it returns `{ ok: false }` rather than
 * a partial batch, using the shared `unknownScenarioErrors` diagnostic. The
 * exhaustive rules are owned solely by `validateScenarioBatches`, which every
 * caller runs first.
 */
export function resolveBatch(
  batchName: string,
  registryKeys: readonly string[]
): BatchResolution | null {
  if (!Object.hasOwn(E2E_BATCHES, batchName)) return null;
  const batch = E2E_BATCHES[batchName];
  const errors = unknownScenarioErrors(batchName, batch.scenarios, registryKeys);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    name: batchName,
    scenarios: batch.scenarios,
    parallel: batch.parallel,
  };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.stdout.write(`${JSON.stringify(Object.keys(E2E_BATCHES))}\n`);
}
