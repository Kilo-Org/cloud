import type { WorkerDb } from '@kilocode/db/client';
import { container_usage_interval, kilocode_users, organizations } from '@kilocode/db/schema';
import { and, count, eq, gt, like, ne, notLike, sql, type SQL } from 'drizzle-orm';
import {
  getContainerCapacityLimit,
  getContainerCapacityScopes,
  type ContainerCapacityCheck,
  type ContainerCapacityRequest,
  type ContainerConcurrencySubject,
} from './concurrency';

// Two missed five-minute heartbeats plus margin, before the meter's stale sweep.
export const LIVE_INTERVAL_WINDOW = sql`now() - interval '11 minutes'`;
const CLOUD_AGENT_SERVICE_PATTERN = 'cloud-agent-next-%';
const CODE_REVIEW_SERVICE_PATTERN = '%code-review%';

type CapacityReader = Pick<WorkerDb, 'select'>;
type CapacityTransaction = Pick<Parameters<Parameters<WorkerDb['transaction']>[0]>[0], 'execute'>;

export async function lockContainerCapacity(
  tx: CapacityTransaction,
  request: ContainerCapacityRequest
): Promise<void> {
  const keys = [
    ...new Set(
      getContainerCapacityScopes(request).map(
        scope => `container-capacity:${scope.subject.type}:${scope.subject.id}`
      )
    ),
  ].sort();
  for (const key of keys) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}

async function countLiveContainers(
  db: CapacityReader,
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

async function readAccountBalance(
  db: CapacityReader,
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
  db: CapacityReader,
  request: ContainerCapacityRequest
): Promise<ContainerCapacityCheck[]> {
  const balance = request.actor.type === 'user' ? await readAccountBalance(db, request.subject) : 0;
  const checks: ContainerCapacityCheck[] = [];
  for (const scope of getContainerCapacityScopes(request)) {
    checks.push({
      subject: scope.subject,
      live: await countLiveContainers(
        db,
        request.instanceId,
        scope.type === 'actor'
          ? and(
              eq(container_usage_interval.actor_type, 'user'),
              eq(container_usage_interval.actor_id, scope.subject.id)
            )
          : and(
              eq(container_usage_interval.subject_type, scope.subject.type),
              eq(container_usage_interval.subject_id, scope.subject.id)
            )
      ),
      limit: getContainerCapacityLimit(scope, balance),
    });
  }
  return checks;
}
