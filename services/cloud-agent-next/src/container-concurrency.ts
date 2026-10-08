import type { WorkerDb } from '@kilocode/db/client';
import { container_usage_interval } from '@kilocode/db/schema';
import { withTimeout } from '@kilocode/worker-utils';
import { and, count, eq, gt, like, ne, notLike, sql } from 'drizzle-orm';
import { getPgDb } from './db/pg.js';
import { logger } from './logger.js';
import type { Env } from './types.js';

export const PERSONAL_CONTAINER_LIMIT = 20;
export const ORGANIZATION_CONTAINER_LIMIT = 50;

/**
 * A live container heartbeats every `CONTAINER_BILLING_HEARTBEAT_SECONDS` (300s
 * in production). Two missed heartbeats plus margin excludes intervals the
 * meter's 15-minute stale sweep has not closed yet.
 */
const LIVE_INTERVAL_WINDOW = sql`now() - interval '11 minutes'`;
const COUNT_TIMEOUT_MS = 10_000;
const CLOUD_AGENT_SERVICE_PATTERN = 'cloud-agent-next-%';
const CODE_REVIEW_SERVICE_PATTERN = '%code-review%';

export type ContainerConcurrencySubject = { type: 'user' | 'org'; id: string };

export type ContainerCapacityCheckpoint = 'control-plane-create' | 'sandbox-start';

export type ContainerCapacityRequest = {
  subject: ContainerConcurrencySubject;
  /**
   * Billing instance id (the sandbox id) of the container being started. A
   * restarted sandbox can still have an open interval from its previous
   * container until that stop is recorded, so its own interval never counts.
   */
  instanceId: string;
  checkpoint: ContainerCapacityCheckpoint;
};

export class ContainerConcurrencyLimitError extends Error {
  readonly code = 'container_limit_reached';

  constructor(
    readonly accountType: 'personal' | 'organization',
    readonly limit: number
  ) {
    super(
      `container_limit_reached: The ${accountType} account has reached its limit of ${limit} concurrent containers. Stop an existing container before starting another.`
    );
    this.name = 'ContainerConcurrencyLimitError';
  }
}

/** Recognizes the denial after Durable Object RPC has reduced it to a message. */
export function isContainerConcurrencyLimitError(error: unknown): boolean {
  if (error instanceof ContainerConcurrencyLimitError) return true;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === 'container_limit_reached') return true;
  }
  const message =
    typeof error === 'string'
      ? error
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : '';
  return message.includes('container_limit_reached:');
}

export function isContainerConcurrencyExempt(sandboxId: string): boolean {
  return sandboxId.startsWith('crv-');
}

export function containerLimitFor(subject: ContainerConcurrencySubject): number {
  return subject.type === 'org' ? ORGANIZATION_CONTAINER_LIMIT : PERSONAL_CONTAINER_LIMIT;
}

export async function countLiveContainers(
  db: WorkerDb,
  request: ContainerCapacityRequest
): Promise<number> {
  const [row] = await db
    .select({ live: count() })
    .from(container_usage_interval)
    .where(
      and(
        eq(container_usage_interval.subject_type, request.subject.type),
        eq(container_usage_interval.subject_id, request.subject.id),
        eq(container_usage_interval.status, 'open'),
        gt(container_usage_interval.last_seen_at, LIVE_INTERVAL_WINDOW),
        like(container_usage_interval.service, CLOUD_AGENT_SERVICE_PATTERN),
        notLike(container_usage_interval.service, CODE_REVIEW_SERVICE_PATTERN),
        notLike(container_usage_interval.instance_id, 'crv-%'),
        ne(container_usage_interval.instance_id, request.instanceId)
      )
    );
  return row?.live ?? 0;
}

type CapacityDependencies = {
  countLive?: (request: ContainerCapacityRequest) => Promise<number>;
};

/**
 * Soft per-account cap on concurrently running Cloud Agent containers, read
 * from the usage meter's open intervals. Concurrent starts can overshoot by the
 * number in flight, and an unavailable database admits the start: the cap
 * guards against runaway usage and must not turn a Postgres outage into a
 * Cloud Agent outage.
 */
export async function assertContainerCapacity(
  env: Pick<Env, 'HYPERDRIVE'>,
  request: ContainerCapacityRequest,
  dependencies: CapacityDependencies = {}
): Promise<void> {
  const countLive = dependencies.countLive ?? (input => countLiveContainers(getPgDb(env), input));
  let live: number;
  let limit: number;
  try {
    if (isContainerConcurrencyExempt(request.instanceId)) return;
    limit = containerLimitFor(request.subject);
    live = await withTimeout(countLive(request), COUNT_TIMEOUT_MS, 'Container capacity count');
  } catch (error) {
    logger
      .withTags({ logTag: 'container_limit_check_unavailable', sandboxId: request.instanceId })
      .withFields({
        checkpoint: request.checkpoint,
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      .warn('Container capacity check unavailable; admitting start');
    return;
  }
  if (live < limit) return;
  logger
    .withTags({ logTag: 'container_limit_reached', sandboxId: request.instanceId })
    .withFields({
      checkpoint: request.checkpoint,
      subjectType: request.subject.type,
      subjectId: request.subject.id,
      live,
      limit,
    })
    .error('Container concurrency limit reached');
  throw new ContainerConcurrencyLimitError(
    request.subject.type === 'org' ? 'organization' : 'personal',
    limit
  );
}
