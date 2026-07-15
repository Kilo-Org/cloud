import { type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';

/**
 * Bounded readiness polling for `createAndRun`. After the create mutation
 * returns `status: 'session_not_ready'`, the orchestrator probes readiness
 * for at most `MAX_ATTEMPTS` attempts, each separated by
 * `pollIntervalMs`. The poll terminates early on the first `ready` probe.
 *
 * Polling is sequential on purpose: the readiness probe reads the
 * persisted `organizationId` for the new session, so concurrent calls
 * would race each other on the relay's in-memory store.
 *
 * `no-await-in-loop` is satisfied by the narrow `runAttempt` helper, which
 * is the single sequential await point.
 */
export const POLL_INTERVAL_MS = 500;
const POLL_BUDGET_MS = 15_000;
export const MAX_ATTEMPTS = Math.floor(POLL_BUDGET_MS / POLL_INTERVAL_MS);

type RouterOutputs = inferRouterOutputs<RootRouter>;

export type ReadinessResult = RouterOutputs['cliSessionsV2']['readiness'];

export type ReadinessProbe = (input: { sessionId: string }) => Promise<ReadinessResult>;

type PollReadinessUntilReadyInput = {
  sessionId: string;
  pollReadiness: ReadinessProbe;
  sleep: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxAttempts?: number;
};

async function runAttempt(
  remaining: number,
  input: Required<Omit<PollReadinessUntilReadyInput, 'intervalMs' | 'maxAttempts'>> & {
    intervalMs: number;
  }
): Promise<boolean> {
  if (remaining <= 0) {
    return false;
  }
  const probe = await input.pollReadiness({ sessionId: input.sessionId });
  if (probe.status === 'ready') {
    return true;
  }
  if (remaining === 1) {
    return false;
  }
  await input.sleep(input.intervalMs);
  return runAttempt(remaining - 1, input);
}

/**
 * Poll readiness for a fresh session until it reports `ready` or the bounded
 * attempt count is exhausted. Returns `true` on the first ready probe and
 * `false` after the budget is consumed.
 */
export async function pollReadinessUntilReady(
  input: PollReadinessUntilReadyInput
): Promise<boolean> {
  const intervalMs = input.intervalMs ?? POLL_INTERVAL_MS;
  const maxAttempts = input.maxAttempts ?? MAX_ATTEMPTS;
  const result = await runAttempt(maxAttempts, { ...input, intervalMs });
  return result;
}
