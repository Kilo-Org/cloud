import { createDrizzleClient } from '@kilocode/db/client';
import { sql } from 'drizzle-orm';

import { getEnvVariable } from '@/lib/dotenvx';
import { db } from '@/lib/drizzle';

/**
 * Replication health for the primary's read replicas and logical (Snowflake)
 * consumers.
 *
 * Why not just `pg_stat_replication`? That view only lists *currently connected*
 * walsenders. A read replica whose walreceiver has died (e.g. it fell behind and
 * the primary recycled the WAL it needed) simply has no row there, so it is
 * invisible — which is exactly the failure we most want to catch. Logical slots
 * disappear from that view the same way once their consumer disconnects.
 *
 * So the authoritative per-replica signal is measured *on each replica* via
 * `pg_last_xact_replay_timestamp()`, and slot health is read from
 * `pg_replication_slots` on the primary (which persists even when the consumer
 * is gone). `pg_stat_replication` is still reported, but only as "who is
 * streaming right now".
 */

/** A replica we expect to exist, resolved from its per-region connection string. */
export type ReplicaTarget = {
  name: string;
  url: string;
};

/**
 * Expected replicas, mirroring the replica URLs consumed in lib/drizzle.ts.
 * Targets without a configured URL are omitted (nothing to probe).
 */
export function getExpectedReplicaTargets(): ReplicaTarget[] {
  const entries: Array<[string, string]> = [
    ['us-west', getEnvVariable('POSTGRES_REPLICA_US_URL')],
    ['eu-central-1', getEnvVariable('POSTGRES_REPLICA_EU_URL')],
    ['eu-central-2', getEnvVariable('POSTGRES_REPLICA_EU_URL_2')],
  ];
  return entries.filter(([, url]) => url.length > 0).map(([name, url]) => ({ name, url }));
}

/**
 * A healthy read replica trails the primary by well under a second. Anything
 * past this threshold is treated as an alertable lag (the stuck US-west replica
 * sat days behind before this was noticed).
 */
export const REPLICA_LAG_ALERT_SECONDS = 300;

/**
 * `pg_replication_slots.wal_status` values that mean the slot is at, or past,
 * the point of losing WAL it still needs. 'lost' is unrecoverable; 'unreserved'
 * is imminent. 'reserved' and 'extended' are both still safe.
 */
const AT_RISK_WAL_STATUSES = new Set(['unreserved', 'lost']);

const PROBE_TIMEOUT_MS = 5_000;

export type ReplicaHealthStatus = 'ok' | 'lagging' | 'not_in_recovery' | 'unreachable';

export type ReplicaHealth = {
  name: string;
  status: ReplicaHealthStatus;
  in_recovery: boolean | null;
  replay_lsn: string | null;
  last_xact_replay_timestamp: string | null;
  replay_delay_seconds: number | null;
  error: string | null;
};

type ReplicaProbeRow = {
  in_recovery: boolean;
  replay_lsn: string | null;
  last_xact_replay_timestamp: string | null;
  replay_delay_seconds: number | null;
};

/** Currently-connected walsender, as seen on the primary. */
export type WalSender = {
  application_name: string | null;
  client_addr: string | null;
  state: string | null;
  sync_state: string | null;
  replay_lag_bytes: string;
  replay_lag_seconds: number | null;
};

export type ReplicationSlot = {
  slot_name: string;
  slot_type: string | null;
  active: boolean;
  wal_status: string | null;
  retained_wal_bytes: string;
  at_risk: boolean;
};

export type ReplicationHealthReport = {
  healthy: boolean;
  timestamp: string;
  replicas: ReplicaHealth[];
  walSenders: WalSender[];
  slots: ReplicationSlot[];
  errors: string[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Pure status derivation, split out so it can be unit-tested without a database. */
export function classifyReplicaRow(row: ReplicaProbeRow): ReplicaHealthStatus {
  if (!row.in_recovery) return 'not_in_recovery';
  if (row.replay_delay_seconds !== null && row.replay_delay_seconds > REPLICA_LAG_ALERT_SECONDS) {
    return 'lagging';
  }
  return 'ok';
}

/**
 * Connect directly to a single replica and ask it how far behind it is. Never
 * throws: connection/timeout failures are reported as `status: 'unreachable'`,
 * which is itself the signal that the replica is down.
 */
export async function probeReplica(target: ReplicaTarget): Promise<ReplicaHealth> {
  const client = createDrizzleClient({
    connectionString: target.url,
    poolConfig: {
      max: 1,
      application_name: 'kilocode-web-replication-health',
      connectionTimeoutMillis: PROBE_TIMEOUT_MS,
      statement_timeout: PROBE_TIMEOUT_MS,
      query_timeout: PROBE_TIMEOUT_MS,
    },
  });

  try {
    const { rows } = await client.db.execute<ReplicaProbeRow>(sql`
      SELECT
        pg_is_in_recovery() AS in_recovery,
        pg_last_wal_replay_lsn()::text AS replay_lsn,
        pg_last_xact_replay_timestamp()::text AS last_xact_replay_timestamp,
        EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::double precision
          AS replay_delay_seconds
    `);

    const row = rows[0];
    if (!row) {
      return {
        name: target.name,
        status: 'unreachable',
        in_recovery: null,
        replay_lsn: null,
        last_xact_replay_timestamp: null,
        replay_delay_seconds: null,
        error: 'probe returned no rows',
      };
    }

    return {
      name: target.name,
      status: classifyReplicaRow(row),
      in_recovery: row.in_recovery,
      replay_lsn: row.replay_lsn,
      last_xact_replay_timestamp: row.last_xact_replay_timestamp,
      replay_delay_seconds: row.replay_delay_seconds,
      error: null,
    };
  } catch (error) {
    return {
      name: target.name,
      status: 'unreachable',
      in_recovery: null,
      replay_lsn: null,
      last_xact_replay_timestamp: null,
      replay_delay_seconds: null,
      error: errorMessage(error),
    };
  } finally {
    await client.pool.end().catch(() => {});
  }
}

async function getWalSenders(): Promise<WalSender[]> {
  const { rows } = await db.execute<WalSender>(sql`
    SELECT
      application_name,
      client_addr::text AS client_addr,
      state,
      sync_state,
      COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), 0)::text AS replay_lag_bytes,
      EXTRACT(EPOCH FROM replay_lag)::double precision AS replay_lag_seconds
    FROM pg_stat_replication
    ORDER BY application_name, client_addr
  `);
  return rows;
}

type ReplicationSlotRow = Omit<ReplicationSlot, 'at_risk'>;

async function getReplicationSlots(): Promise<ReplicationSlot[]> {
  const { rows } = await db.execute<ReplicationSlotRow>(sql`
    SELECT
      slot_name,
      slot_type,
      active,
      wal_status,
      COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0)::text AS retained_wal_bytes
    FROM pg_replication_slots
    ORDER BY slot_name
  `);
  return rows.map(row => ({
    ...row,
    at_risk: AT_RISK_WAL_STATUSES.has(row.wal_status ?? ''),
  }));
}

/**
 * Collect the full replication picture: per-replica lag (probed on each
 * replica), connected walsenders, and slot health. Primary-side queries are
 * isolated so one failing component does not blank the whole report.
 *
 * `probe` and `targets` are injectable for testing.
 */
export async function collectReplicationHealth(options?: {
  probe?: (target: ReplicaTarget) => Promise<ReplicaHealth>;
  targets?: ReplicaTarget[];
}): Promise<ReplicationHealthReport> {
  const targets = options?.targets ?? getExpectedReplicaTargets();
  const probe = options?.probe ?? probeReplica;
  const errors: string[] = [];

  const [replicas, walSenders, slots] = await Promise.all([
    Promise.all(targets.map(target => probe(target))),
    getWalSenders().catch(error => {
      errors.push(`pg_stat_replication: ${errorMessage(error)}`);
      return [] as WalSender[];
    }),
    getReplicationSlots().catch(error => {
      errors.push(`pg_replication_slots: ${errorMessage(error)}`);
      return [] as ReplicationSlot[];
    }),
  ]);

  const healthy =
    errors.length === 0 &&
    replicas.every(replica => replica.status === 'ok') &&
    slots.every(slot => !slot.at_risk);

  return {
    healthy,
    timestamp: new Date().toISOString(),
    replicas,
    walSenders,
    slots,
    errors,
  };
}
