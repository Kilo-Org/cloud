import { and, count, eq, inArray } from 'drizzle-orm';
import type { WorkerDb } from '@kilocode/db/client';
import { container_usage_interval } from '@kilocode/db/schema';
import type { SandboxAllocation } from '@kilocode/worker-utils/sandbox-allocation';

import { usageServiceForSandboxClass } from './container-usage-context.js';
import { logger } from './logger.js';
import { isInteractiveWebSession } from './session-plane.js';

/**
 * Best-effort per-user limit on concurrently-open interactive single small
 * sandboxes. This is a resource guard, not a hard maximum of running
 * containers: the count is the number of open `container_usage_interval` rows
 * for the user, and that table is not authoritative physical liveness.
 */
export const INTERACTIVE_SMALL_SANDBOX_CAP = 3;

export type InteractiveSandboxCapacityInput = {
  createdOnPlatform?: string;
  devcontainer?: boolean;
  sandboxAllocation?: SandboxAllocation;
  billingOrigin?: string;
  botId?: string;
};

export type InteractiveSandboxCapacityDecision =
  | { kind: 'unchanged' }
  | { kind: 'inject'; sandboxAllocation: SandboxAllocation }
  | { kind: 'reject' };

export type InteractiveSandboxCapacityDependencies = {
  userId: string;
  countOpenSmallSandboxContainers: () => Promise<number>;
};

/** Count of open small-sandbox usage intervals attributed to the user actor. */
export async function countOpenSmallSandboxContainers(
  db: WorkerDb,
  userId: string
): Promise<number> {
  const services = [
    usageServiceForSandboxClass('SandboxSmall'),
    usageServiceForSandboxClass('SandboxSmallContainment'),
  ];
  const [row] = await db
    .select({ count: count() })
    .from(container_usage_interval)
    .where(
      and(
        eq(container_usage_interval.status, 'open'),
        eq(container_usage_interval.actor_type, 'user'),
        eq(container_usage_interval.actor_id, userId),
        inArray(container_usage_interval.service, services)
      )
    );
  return row?.count ?? 0;
}

function isEligibleForInteractiveSandboxCapacity(input: InteractiveSandboxCapacityInput): boolean {
  return (
    isInteractiveWebSession({ createdOnPlatform: input.createdOnPlatform }) &&
    input.botId === undefined &&
    input.devcontainer !== true &&
    input.billingOrigin !== 'code-review'
  );
}

/**
 * True when this create is governed by the interactive capacity policy: an
 * eligible interactive user create that either omits the allocation or
 * explicitly asks for `cloudflare-single`. Every other explicit allocation is
 * unchanged and never reads the count.
 */
function isGovernedByInteractiveSandboxCapacity(input: InteractiveSandboxCapacityInput): boolean {
  return (
    isEligibleForInteractiveSandboxCapacity(input) &&
    (input.sandboxAllocation === undefined || input.sandboxAllocation === 'cloudflare-single')
  );
}

/**
 * Final decision for an eligible-or-not create. Pure: the count is supplied by
 * the caller and is either a number or `'unavailable'` when the read failed.
 */
export function decideInteractiveSandboxAllocation(
  input: InteractiveSandboxCapacityInput,
  openSmallSandboxCount: number | 'unavailable'
): InteractiveSandboxCapacityDecision {
  if (!isGovernedByInteractiveSandboxCapacity(input)) {
    return { kind: 'unchanged' };
  }
  if (input.sandboxAllocation === 'cloudflare-single') {
    return typeof openSmallSandboxCount === 'number' &&
      openSmallSandboxCount >= INTERACTIVE_SMALL_SANDBOX_CAP
      ? { kind: 'reject' }
      : { kind: 'unchanged' };
  }
  if (
    openSmallSandboxCount === 'unavailable' ||
    openSmallSandboxCount >= INTERACTIVE_SMALL_SANDBOX_CAP
  ) {
    return { kind: 'inject', sandboxAllocation: 'cloudflare-shared' };
  }
  return { kind: 'inject', sandboxAllocation: 'cloudflare-single' };
}

/**
 * Reads the user's open small-sandbox count at most once and resolves the
 * capacity decision. A count-read failure never fails the create: it is logged
 * and treated as `'unavailable'` so the caller falls back to the shared
 * sandbox (or leaves an explicit single unchanged).
 */
export async function resolveInteractiveSandboxCapacity(
  input: InteractiveSandboxCapacityInput,
  dependencies: InteractiveSandboxCapacityDependencies
): Promise<InteractiveSandboxCapacityDecision> {
  if (!isGovernedByInteractiveSandboxCapacity(input)) {
    return { kind: 'unchanged' };
  }

  let openSmallSandboxCount: number | 'unavailable';
  try {
    openSmallSandboxCount = await dependencies.countOpenSmallSandboxContainers();
  } catch (error) {
    logger
      .withFields({
        userId: dependencies.userId,
        error: error instanceof Error ? error.message : String(error),
      })
      .warn(
        'Failed to read open interactive small sandbox count; count unavailable, proceeding with fallback decision'
      );
    openSmallSandboxCount = 'unavailable';
  }

  const decision = decideInteractiveSandboxAllocation(input, openSmallSandboxCount);
  logger
    .withFields({
      userId: dependencies.userId,
      decision: decision.kind,
      openSmallSandboxCount,
    })
    .info('Resolved interactive sandbox capacity');
  return decision;
}
