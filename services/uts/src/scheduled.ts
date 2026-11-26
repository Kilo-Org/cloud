import {
  maintainAuditPartitions,
  maintainOAuthRows,
  partitionRunwayDays,
  unrelayedAges,
} from './audit/outbox';
import { AUDIT_SHARD_COUNT } from './audit/relay';
import { type IdentityStore, IdentityStoreError, withIdentityStore } from './db/client';
import { getAuditRelayStub } from './dos/stubs';
import { readConfig, type Env, type UtsConfig } from './env';
import { identityStoreBinding } from './grants/binding';

/** Alert threshold for the oldest unrelayed audit row (design 8.1). */
export const UNRELAYED_ALERT_SECONDS = 60;
/** Today's partition and the next 7 days' exist after every successful maintenance pass. */
export const PARTITION_RUNWAY_DAYS = 8;
/** `uts.maintain_oauth_rows()` deletes at most this many rows of each kind per call. */
export const OAUTH_MAINTENANCE_BATCH = 5_000;
/**
 * Calls per cron run. Partition maintenance takes one step per call and has at most 8 creates and
 * a truncate plus a drop per old day to do; OAuth maintenance repeats while a kind hits its batch.
 */
export const MAX_PARTITION_STEPS = 32;
export const MAX_OAUTH_CALLS = 20;

function errorFields(error: unknown): Record<string, string | undefined> {
  if (error instanceof IdentityStoreError) {
    return { error: error.name, failure: error.failure, sqlState: error.sqlState };
  }
  return { error: error instanceof Error ? error.name : 'unknown' };
}

/** Runs one maintenance step and logs its failure; the other steps run regardless. */
async function step(name: string, work: () => Promise<void>): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'uts.maintenance.failed', step: name, ...errorFields(error) })
    );
    return false;
  }
}

/**
 * Creates the coming days' partitions and removes old ones, one step per call until a call does
 * nothing. A partition past the 7-day tier that still holds an unrelayed row is kept and alerted.
 */
async function auditPartitions(store: IdentityStore): Promise<void> {
  const kept = new Set<string>();
  for (let call = 0; call < MAX_PARTITION_STEPS; call += 1) {
    const steps = await maintainAuditPartitions(store);
    for (const row of steps) {
      if (row.action === 'kept_unrelayed') kept.add(row.partition_name);
      else console.log(JSON.stringify({ event: 'uts.audit_partitions.step', ...row }));
    }
    if (!steps.some(row => row.action !== 'kept_unrelayed')) break;
  }
  for (const partition of kept) {
    console.error(JSON.stringify({ event: 'uts.audit_partitions.kept_unrelayed', partition }));
  }
  const days = await partitionRunwayDays(store);
  if (days < PARTITION_RUNWAY_DAYS) {
    console.error(
      JSON.stringify({
        event: 'uts.audit_partitions.runway_short',
        days,
        expected: PARTITION_RUNWAY_DAYS,
      })
    );
  }
}

/** Deletes dead OAuth rows until every kind is under one batch, or alerts that it fell behind. */
async function oauthRows(store: IdentityStore): Promise<void> {
  for (let call = 0; call < MAX_OAUTH_CALLS; call += 1) {
    const full = (await maintainOAuthRows(store)).filter(
      row => row.deleted >= OAUTH_MAINTENANCE_BATCH
    );
    if (full.length === 0) return;
    if (call === MAX_OAUTH_CALLS - 1) {
      console.error(
        JSON.stringify({ event: 'uts.oauth_rows.behind', kinds: full.map(row => row.kind) })
      );
    }
  }
}

async function relayLag(store: IdentityStore): Promise<void> {
  for (const { shard, ageSeconds } of await unrelayedAges(store)) {
    if (ageSeconds > UNRELAYED_ALERT_SECONDS) {
      console.error(
        JSON.stringify({
          event: 'uts.audit_relay.lagging',
          shard,
          ageSeconds: Math.round(ageSeconds),
        })
      );
    }
  }
}

async function startRelays(env: Env, config: UtsConfig): Promise<void> {
  const shards = Array.from({ length: AUDIT_SHARD_COUNT }, (_, shard) => shard);
  const results = await Promise.allSettled(
    shards.map(shard => getAuditRelayStub(env, config, shard).ensureStarted())
  );
  results.forEach((result, shard) => {
    if (result.status === 'rejected' || !result.value) {
      console.error(
        JSON.stringify({
          event: 'uts.audit_relay.not_started',
          shard,
          ...(result.status === 'rejected' ? errorFields(result.reason) : { error: 'refused' }),
        })
      );
    }
  });
}

/**
 * The minute cron: keeps the 8 shard relays running, maintains audit partitions and OAuth rows,
 * and raises the relay-lag alert. Nothing runs until the environment binds its identity store.
 * Every statement is its own transaction on one connection.
 */
export async function scheduled(
  _controller: ScheduledController,
  env: Env,
  context: ExecutionContext
): Promise<void> {
  const config = readConfig(env);
  const binding = identityStoreBinding(env);
  if (binding.kind === 'unprovisioned') return;
  await startRelays(env, config);
  await step('connect', () =>
    withIdentityStore(binding.connectionString, context, async store => {
      await step('audit_partitions', () => auditPartitions(store));
      await step('oauth_rows', () => oauthRows(store));
      await step('relay_lag', () => relayLag(store));
    })
  );
}
