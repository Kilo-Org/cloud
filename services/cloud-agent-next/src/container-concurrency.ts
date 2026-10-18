import type { WorkerDb } from '@kilocode/db/client';
import { container_usage_interval, kilocode_users, organizations } from '@kilocode/db/schema';
import { withTimeout } from '@kilocode/worker-utils';
import { and, count, eq, gt, like, ne, notLike, sql, type SQL } from 'drizzle-orm';
import { getPgDb } from './db/pg.js';
import { logger } from './logger.js';
import type { Env } from './types.js';

export const USER_CONTAINER_LIMIT = 20;
export const LOW_BALANCE_CONTAINER_LIMIT = 3;
export const FUNDED_CONTAINER_MINIMUM_MICRODOLLARS = 3_000_000;
export const ORGANIZATION_CONTAINER_LIMIT = 50;

/**
 * A live container heartbeats every `CONTAINER_BILLING_HEARTBEAT_SECONDS` (300s
 * in production). Two missed heartbeats plus margin excludes intervals the
 * meter's 15-minute stale sweep has not closed yet.
 */
const LIVE_INTERVAL_WINDOW = sql`now() - interval '11 minutes'`;
const COUNT_TIMEOUT_MS = 10_000;
const CHECK_RETRY_DELAY_MS = 250;
const CLOUD_AGENT_SERVICE_PATTERN = 'cloud-agent-next-%';
const CODE_REVIEW_SERVICE_PATTERN = '%code-review%';

export type ContainerConcurrencySubject = { type: 'user' | 'org'; id: string };

export type ContainerCapacityCheckpoint = 'control-plane-create' | 'sandbox-start';

export type ContainerCapacityRequest = {
  subject: ContainerConcurrencySubject;
  actor: { type: 'user' | 'bot'; id: string };
  /**
   * Billing instance id (the sandbox id) of the container being started. A
   * restarted sandbox can still have an open interval from its previous
   * container until that stop is recorded, so its own interval never counts.
   */
  instanceId: string;
  checkpoint: ContainerCapacityCheckpoint;
  billingOrigin?: string;
};

export class ContainerConcurrencyLimitError extends Error {
  readonly code = 'container_limit_reached';

  constructor(
    readonly accountType: 'personal' | 'organization',
    readonly limit: number
  ) {
    super(
      `container_limit_reached: The ${accountType === 'personal' ? 'user' : 'organization'} has reached its limit of ${limit} concurrent containers. Stop an existing container before starting another.`
    );
    this.name = 'ContainerConcurrencyLimitError';
  }
}

export class ContainerCapacityUnavailableError extends Error {
  readonly code = 'container_capacity_unavailable';

  constructor() {
    super(
      'container_capacity_unavailable: Cannot verify container capacity or account balance. Try again shortly.'
    );
    this.name = 'ContainerCapacityUnavailableError';
  }
}

/** Recognizes admission failures even after Durable Object RPC flattens them. */
export function getContainerCapacityFailureReason(
  error: unknown
): 'container_limit_reached' | 'billing_unavailable' | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === 'container_limit_reached') return 'container_limit_reached';
    if (error.code === 'container_capacity_unavailable') return 'billing_unavailable';
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
  if (message.includes('container_limit_reached:')) return 'container_limit_reached';
  if (message.includes('container_capacity_unavailable:')) return 'billing_unavailable';
  return undefined;
}

export function isContainerConcurrencyExempt(request: ContainerCapacityRequest): boolean {
  return request.billingOrigin === 'code-review' || request.instanceId.startsWith('crv-');
}

async function countLiveContainers(
  db: WorkerDb,
  instanceId: string,
  scope: SQL | undefined
): Promise<number> {
  const [row] = await db
    .select({ live: count() })
    .from(container_usage_interval)
    .where(
      and(
        scope,
        eq(container_usage_interval.status, 'open'),
        gt(container_usage_interval.last_seen_at, LIVE_INTERVAL_WINDOW),
        like(container_usage_interval.service, CLOUD_AGENT_SERVICE_PATTERN),
        notLike(container_usage_interval.service, CODE_REVIEW_SERVICE_PATTERN),
        notLike(container_usage_interval.instance_id, 'crv-%'),
        sql`coalesce(${container_usage_interval.metadata}->>'origin', '') <> 'code-review'`,
        ne(container_usage_interval.instance_id, instanceId)
      )
    );
  return row?.live ?? 0;
}

export type ContainerCapacityCheck = {
  subject: ContainerConcurrencySubject;
  live: number;
  limit: number;
};

async function readAccountBalance(
  db: WorkerDb,
  subject: ContainerConcurrencySubject
): Promise<number> {
  const account = subject.type === 'org' ? organizations : kilocode_users;
  const [row] = await db
    .select({
      balance: sql`${account.total_microdollars_acquired} - ${account.microdollars_used}`.mapWith(
        Number
      ),
    })
    .from(account)
    .where(eq(account.id, subject.id));
  return row?.balance ?? 0;
}

export async function readContainerCapacity(
  db: WorkerDb,
  request: ContainerCapacityRequest
): Promise<ContainerCapacityCheck[]> {
  const checks: ContainerCapacityCheck[] = [];
  if (request.actor.type === 'user') {
    const [live, balance] = await Promise.all([
      countLiveContainers(
        db,
        request.instanceId,
        and(
          eq(container_usage_interval.actor_type, 'user'),
          eq(container_usage_interval.actor_id, request.actor.id)
        )
      ),
      readAccountBalance(db, request.subject),
    ]);
    checks.push({
      subject: { type: 'user', id: request.actor.id },
      live,
      limit:
        balance < FUNDED_CONTAINER_MINIMUM_MICRODOLLARS
          ? LOW_BALANCE_CONTAINER_LIMIT
          : USER_CONTAINER_LIMIT,
    });
  }
  // Bots retain their billing-account limits. Human starts also share the
  // organization's existing cap, in addition to their cross-organization cap.
  if (request.subject.type === 'org' || request.actor.type === 'bot') {
    checks.push({
      subject: request.subject,
      live: await countLiveContainers(
        db,
        request.instanceId,
        and(
          eq(container_usage_interval.subject_type, request.subject.type),
          eq(container_usage_interval.subject_id, request.subject.id)
        )
      ),
      limit: request.subject.type === 'org' ? ORGANIZATION_CONTAINER_LIMIT : USER_CONTAINER_LIMIT,
    });
  }
  return checks;
}

type CapacityDependencies = {
  readCapacity?: (request: ContainerCapacityRequest) => Promise<ContainerCapacityCheck[]>;
};

/**
 * Soft per-user and per-organization caps on Cloud Agent containers, read
 * from the usage meter's open intervals. Concurrent starts can overshoot by the
 * number in flight. An unavailable database rejects new starts after one
 * bounded retry; running containers do not need a fresh admission check.
 */
export async function assertContainerCapacity(
  env: Pick<Env, 'HYPERDRIVE' | 'CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED'>,
  request: ContainerCapacityRequest,
  dependencies: CapacityDependencies = {}
): Promise<number | undefined> {
  // Test Workers use fake providers or share one funded test account across
  // the suite. Production leaves this flag unset and enforces admission.
  if (env.CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED === 'true') return;
  const readCapacity =
    dependencies.readCapacity ?? (input => readContainerCapacity(getPgDb(env), input));
  let checks: ContainerCapacityCheck[];
  try {
    if (isContainerConcurrencyExempt(request)) return;
    const readWithRetry = async () => {
      try {
        return await readCapacity(request);
      } catch {
        await new Promise(resolve => setTimeout(resolve, CHECK_RETRY_DELAY_MS));
        return readCapacity(request);
      }
    };
    checks = await withTimeout(readWithRetry(), COUNT_TIMEOUT_MS, 'Container capacity check');
  } catch (error) {
    logger
      .withTags({ logTag: 'container_limit_check_unavailable', sandboxId: request.instanceId })
      .withFields({
        checkpoint: request.checkpoint,
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      .warn('Container capacity check unavailable; refusing start');
    throw new ContainerCapacityUnavailableError();
  }
  const exceeded = checks.find(check => check.live >= check.limit);
  if (!exceeded) return checks.find(check => check.subject.type === 'user')?.limit;
  const { subject, live, limit } = exceeded;
  logger
    .withTags({ logTag: 'container_limit_reached', sandboxId: request.instanceId })
    .withFields({
      checkpoint: request.checkpoint,
      subjectType: subject.type,
      subjectId: subject.id,
      live,
      limit,
    })
    .error('Container concurrency limit reached');
  throw new ContainerConcurrencyLimitError(
    subject.type === 'org' ? 'organization' : 'personal',
    limit
  );
}
