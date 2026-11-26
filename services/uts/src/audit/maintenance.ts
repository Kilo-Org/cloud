import { type IdentityStore, IdentityStoreError } from '../db/client';
import {
  maintainAuditPartitions,
  maintainOAuthRows,
  partitionRunwayDays,
  unrelayedAges,
} from './outbox';

/**
 * The identity-store work of the minute cron (`src/scheduled.ts`) and its alert log lines
 * (README, "Audit outbox"). Each step logs its own failure and the next step runs regardless.
 */

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

/** `IdentityStoreError` keeps no row value, so every field here is safe to log. */
export function errorFields(error: unknown): Record<string, string | undefined> {
  if (error instanceof IdentityStoreError) {
    return {
      error: error.name,
      failure: error.failure,
      sqlState: error.sqlState,
      constraint: error.constraint,
      table: error.table,
    };
  }
  return { error: error instanceof Error ? error.name : 'unknown' };
}

/** Runs one step and logs its failure; the caller's next step runs regardless. */
export async function step(name: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'uts.maintenance.failed', step: name, ...errorFields(error) })
    );
  }
}

/**
 * Creates the coming days' partitions and removes old ones, one step per call until a call does
 * nothing. Each partition past the 7-day tier that still holds an unrelayed row goes into `kept`,
 * also from the calls before one that throws.
 */
async function auditPartitions(store: IdentityStore, kept: Set<string>): Promise<void> {
  for (let call = 0; call < MAX_PARTITION_STEPS; call += 1) {
    const steps = await maintainAuditPartitions(store);
    for (const row of steps) {
      if (row.action === 'kept_unrelayed') kept.add(row.partition_name);
      else console.log(JSON.stringify({ event: 'uts.audit_partitions.step', ...row }));
    }
    if (!steps.some(row => row.action !== 'kept_unrelayed')) return;
  }
}

/** Alerts on each kept partition and on a short partition runway. */
async function partitionAlerts(store: IdentityStore, kept: ReadonlySet<string>): Promise<void> {
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

/**
 * Deletes dead OAuth rows until every kind is under one batch, or alerts that it fell behind
 * after `maxCalls` calls.
 */
export async function oauthRows(store: IdentityStore, maxCalls = MAX_OAUTH_CALLS): Promise<void> {
  for (let call = 0; call < maxCalls; call += 1) {
    const full = (await maintainOAuthRows(store)).filter(
      row => row.deleted >= OAUTH_MAINTENANCE_BATCH
    );
    if (full.length === 0) return;
    if (call === maxCalls - 1) {
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

/**
 * One cron run's identity-store work on one connection. A partition maintenance call that throws
 * still leaves the kept-partition alerts and the runway check to run.
 */
export async function runMaintenance(store: IdentityStore): Promise<void> {
  const kept = new Set<string>();
  await step('audit_partitions', () => auditPartitions(store, kept));
  await step('partition_alerts', () => partitionAlerts(store, kept));
  await step('oauth_rows', () => oauthRows(store));
  await step('relay_lag', () => relayLag(store));
}
