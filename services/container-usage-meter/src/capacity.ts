import {
  container_usage_interval,
  kilocode_users,
  organizations,
  type WorkerDb,
} from '@kilocode/db';
import { and, count, eq, gt, like, ne, notLike, sql, type SQL } from 'drizzle-orm';
import type { RecordStartInput } from '@kilocode/container-usage';

export const USER_CONTAINER_LIMIT = 20;
export const LOW_BALANCE_CONTAINER_LIMIT = 3;
export const FUNDED_CONTAINER_MINIMUM_MICRODOLLARS = 3_000_000;
export const ORGANIZATION_CONTAINER_LIMIT = 50;

/**
 * A live container heartbeats every 300 s in production. Two missed heartbeats
 * plus margin excludes intervals the 15-minute stale sweep has not closed yet.
 */
const LIVE_INTERVAL_WINDOW = sql`now() - interval '11 minutes'`;
const CLOUD_AGENT_SERVICE_PATTERN = 'cloud-agent-next-%';
const CODE_REVIEW_SERVICE_PATTERN = '%code-review%';

type Transaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];
type CapacityRequest = Pick<RecordStartInput, 'subject' | 'actor' | 'instanceId' | 'metadata'>;
type CapacitySubject = RecordStartInput['subject'];

type CapacityScope = {
  subject: CapacitySubject;
  filter: SQL | undefined;
  limit: (balance: number) => number;
};

export type ContainerLimitRejection = {
  kind: 'rejected';
  code: 'container_limit_reached';
  message: string;
};

function isExempt(request: CapacityRequest): boolean {
  return request.metadata?.origin === 'code-review' || request.instanceId.startsWith('crv-');
}

/**
 * A human start counts against the user's cross-account cap and, for an
 * organization, the organization cap. A bot keeps its billing account's cap.
 */
function capacityScopes(request: CapacityRequest): CapacityScope[] {
  const scopes: CapacityScope[] = [];
  if (request.actor.type === 'user') {
    scopes.push({
      subject: { type: 'user', id: request.actor.id },
      filter: and(
        eq(container_usage_interval.actor_type, 'user'),
        eq(container_usage_interval.actor_id, request.actor.id)
      ),
      limit: balance =>
        balance < FUNDED_CONTAINER_MINIMUM_MICRODOLLARS
          ? LOW_BALANCE_CONTAINER_LIMIT
          : USER_CONTAINER_LIMIT,
    });
  }
  if (request.subject.type === 'org' || request.actor.type === 'bot') {
    const organization = request.subject.type === 'org';
    scopes.push({
      subject: request.subject,
      filter: and(
        eq(container_usage_interval.subject_type, request.subject.type),
        eq(container_usage_interval.subject_id, request.subject.id)
      ),
      limit: () => (organization ? ORGANIZATION_CONTAINER_LIMIT : USER_CONTAINER_LIMIT),
    });
  }
  return scopes;
}

/**
 * Serializes admissions that share a cap. The lock is held until the
 * transaction ends, so the next admission counts the interval this one opens.
 * Sorted keys keep two admissions from waiting on each other.
 */
async function lockScopes(tx: Transaction, scopes: CapacityScope[]): Promise<void> {
  const keys = [
    ...new Set(scopes.map(scope => `container-capacity:${scope.subject.type}:${scope.subject.id}`)),
  ].sort();
  for (const key of keys) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}

async function countLiveContainers(
  tx: Transaction,
  instanceId: string,
  filter: SQL | undefined
): Promise<number> {
  const [row] = await tx
    .select({ live: count() })
    .from(container_usage_interval)
    .where(
      and(
        filter,
        eq(container_usage_interval.status, 'open'),
        gt(container_usage_interval.last_seen_at, LIVE_INTERVAL_WINDOW),
        like(container_usage_interval.service, CLOUD_AGENT_SERVICE_PATTERN),
        notLike(container_usage_interval.service, CODE_REVIEW_SERVICE_PATTERN),
        notLike(container_usage_interval.instance_id, 'crv-%'),
        sql`coalesce(${container_usage_interval.metadata}->>'origin', '') <> 'code-review'`,
        // A restarted sandbox can still have an open interval from its previous container.
        ne(container_usage_interval.instance_id, instanceId)
      )
    );
  return row?.live ?? 0;
}

async function readAccountBalance(tx: Transaction, subject: CapacitySubject): Promise<number> {
  const account = subject.type === 'org' ? organizations : kilocode_users;
  const [row] = await tx
    .select({
      balance: sql`${account.total_microdollars_acquired} - ${account.microdollars_used}`.mapWith(
        Number
      ),
    })
    .from(account)
    .where(eq(account.id, subject.id));
  return row?.balance ?? 0;
}

/**
 * Caps concurrent Cloud Agent containers per user and per organization. The
 * caller must run this in a read-committed transaction that then opens the
 * interval, so each count after the lock sees every interval admitted before.
 */
export async function checkContainerCapacity(
  tx: Transaction,
  request: CapacityRequest
): Promise<ContainerLimitRejection | undefined> {
  if (isExempt(request)) return undefined;
  const scopes = capacityScopes(request);
  await lockScopes(tx, scopes);
  const balance = request.actor.type === 'user' ? await readAccountBalance(tx, request.subject) : 0;
  for (const scope of scopes) {
    const limit = scope.limit(balance);
    const live = await countLiveContainers(tx, request.instanceId, scope.filter);
    if (live < limit) continue;
    console.warn(
      JSON.stringify({
        message: 'Container concurrency limit reached',
        event: 'container_limit_reached',
        subjectType: scope.subject.type,
        subjectId: scope.subject.id,
        instanceId: request.instanceId,
        live,
        limit,
      })
    );
    const account = scope.subject.type === 'org' ? 'organization' : 'user';
    return {
      kind: 'rejected',
      code: 'container_limit_reached',
      message: `container_limit_reached: The ${account} has reached its limit of ${limit} concurrent containers. Stop an existing container before starting another.`,
    };
  }
  return undefined;
}
