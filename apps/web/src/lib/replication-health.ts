import { createDrizzleClient, type DrizzleClient, type pg } from '@kilocode/db/client';
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
 * Number of read replicas we expect in production, one per POSTGRES_REPLICA_*
 * connection string (US + two EU). If fewer are configured (env var dropped,
 * renamed, or misspelled), the monitor would otherwise probe nothing and still
 * report `healthy: true` — so we surface it as an error in production.
 */
export const EXPECTED_REPLICA_COUNT = 3;

/**
 * `pg_replication_slots.wal_status` values that mean the slot is at, or past,
 * the point of losing WAL it still needs. 'lost' is unrecoverable; 'unreserved'
 * is imminent. 'reserved' and 'extended' are both still safe.
 */
const AT_RISK_WAL_STATUSES = new Set(['unreserved', 'lost']);

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Connection config for a single probe.
 *
 * IMPORTANT: do not set `statement_timeout` here. node-postgres transmits
 * `statement_timeout` in the Postgres startup packet (pg `getStartupConf`), and
 * Supabase's Supavisor pooler — which the POSTGRES_REPLICA_* URLs connect
 * through — rejects connections that carry it, so the probe would never
 * establish a session (it silently failed on every EU replica this way). Bound
 * the probe with the client-side `query_timeout` and `connectionTimeoutMillis`
 * instead, matching the app's own replica pool in lib/drizzle.ts.
 */
export const PROBE_POOL_CONFIG = {
  max: 1,
  application_name: 'kilocode-web-replication-health',
  connectionTimeoutMillis: PROBE_TIMEOUT_MS,
  query_timeout: PROBE_TIMEOUT_MS,
} satisfies Partial<pg.PoolConfig>;

export type ReplicaHealthStatus = 'ok' | 'lagging' | 'not_in_recovery' | 'unreachable';

export type ReplicaHealth = {
  name: string;
  status: ReplicaHealthStatus;
  in_recovery: boolean | null;
  replay_lsn: string | null;
  /**
   * How far the WAL *receiver* has got, versus `replay_lsn` (how far replay has
   * got). Together these split lag into its two possible causes: a large
   * `receive_replay_gap_bytes` means the WAL arrived and replay is the
   * bottleneck, while a gap near zero alongside a high `replay_delay_seconds`
   * means the WAL has not arrived yet, i.e. the bottleneck is transport.
   *
   * Compare across samples, never in isolation. `pg_last_wal_receive_lsn()` is
   * null only while streaming has not started in the current recovery session;
   * a walreceiver that *dies* does not null it, it freezes it at the last LSN
   * received. So the dead-walreceiver failure this module exists to catch shows
   * up as a large and roughly constant gap — which in any single sample is
   * indistinguishable from a slow replay. A `receive_lsn` that does not advance
   * between samples is the signature.
   *
   * A negative gap is legitimate: a replica recovering from the WAL archive
   * replays past the position streaming reached.
   *
   * Both fields come from one snapshot of the LSN functions, so they are always
   * consistent with each other and with `replay_lsn` (see `probeReplica`).
   */
  receive_lsn: string | null;
  receive_replay_gap_bytes: string | null;
  last_xact_replay_timestamp: string | null;
  replay_delay_seconds: number | null;
  error: string | null;
};

type ReplicaProbeRow = {
  in_recovery: boolean;
  replay_lsn: string | null;
  receive_lsn: string | null;
  receive_replay_gap_bytes: string | null;
  last_xact_replay_timestamp: string | null;
  replay_delay_seconds: number | null;
};

/**
 * Currently-connected walsender, as seen on the primary.
 *
 * The three read replicas all connect with `application_name = 'main'`, so
 * `client_addr` is the only way to tell them apart.
 *
 * `write`/`flush`/`replay` are reported separately for the same reason the
 * replica probe reports receive and replay separately: write and flush lag
 * cover getting the WAL to the standby's disk, replay lag covers applying it.
 * A spike in all three points at the link; a spike in replay alone points at
 * the standby.
 */
export type WalSender = {
  application_name: string | null;
  client_addr: string | null;
  state: string | null;
  sync_state: string | null;
  sent_lag_bytes: string;
  flush_lag_bytes: string;
  replay_lag_bytes: string;
  write_lag_seconds: number | null;
  flush_lag_seconds: number | null;
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
  if (!(error instanceof Error)) return String(error);
  // drizzle wraps DB failures as `Error('Failed query: <sql>')` and attaches the
  // real driver error (e.g. the connection/pooler rejection) as `cause`. Prefer
  // that cause so alerts show why a probe failed instead of the SQL text.
  const cause = error.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return error.message;
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
  // createDrizzleClient must stay inside the try: getDatabaseClientConfig runs
  // `new URL(connectionString)`, which throws synchronously on a malformed
  // POSTGRES_REPLICA_* value. Keeping it here preserves the "never throws"
  // contract and maps such failures to `status: 'unreachable'`.
  let client: DrizzleClient | undefined;

  try {
    client = createDrizzleClient({
      connectionString: target.url,
      poolConfig: PROBE_POOL_CONFIG,
    });

    // A pg.Pool emits 'error' when an idle/checked-out client's connection drops
    // unexpectedly (likely here, since we probe replicas that may already be in a
    // bad state). Without a listener Node treats it as unhandled and crashes the
    // process, so attach a no-op like the long-lived pools in lib/drizzle.ts do.
    client.pool.on('error', () => {});

    // Every one of these LSN functions is volatile and reads live shared memory,
    // so each call site is evaluated independently: calling them once per output
    // column would let `receive_replay_gap_bytes` disagree with the `receive_lsn`
    // and `replay_lsn` logged beside it, and could even report a negative gap
    // from replay advancing mid-row. Reading them once in a subquery and
    // deriving the outputs from those columns keeps the row self-consistent —
    // Postgres will not flatten a subquery whose target list is volatile, so the
    // values really are reused rather than re-read.
    const { rows } = await client.db.execute<ReplicaProbeRow>(sql`
      SELECT
        snapshot.in_recovery,
        snapshot.replay_lsn::text AS replay_lsn,
        snapshot.receive_lsn::text AS receive_lsn,
        pg_wal_lsn_diff(snapshot.receive_lsn, snapshot.replay_lsn)::text
          AS receive_replay_gap_bytes,
        snapshot.last_xact_replay_timestamp::text AS last_xact_replay_timestamp,
        EXTRACT(EPOCH FROM (now() - snapshot.last_xact_replay_timestamp))::double precision
          AS replay_delay_seconds
      FROM (
        SELECT
          pg_is_in_recovery() AS in_recovery,
          pg_last_wal_replay_lsn() AS replay_lsn,
          pg_last_wal_receive_lsn() AS receive_lsn,
          pg_last_xact_replay_timestamp() AS last_xact_replay_timestamp
      ) AS snapshot
    `);

    const row = rows[0];
    if (!row) {
      return {
        name: target.name,
        status: 'unreachable',
        in_recovery: null,
        replay_lsn: null,
        receive_lsn: null,
        receive_replay_gap_bytes: null,
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
      receive_lsn: row.receive_lsn,
      receive_replay_gap_bytes: row.receive_replay_gap_bytes,
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
      receive_lsn: null,
      receive_replay_gap_bytes: null,
      last_xact_replay_timestamp: null,
      replay_delay_seconds: null,
      error: errorMessage(error),
    };
  } finally {
    await client?.pool.end().catch(() => {});
  }
}

async function getWalSenders(): Promise<WalSender[]> {
  const { rows } = await db.execute<WalSender>(sql`
    SELECT
      application_name,
      client_addr::text AS client_addr,
      state,
      sync_state,
      COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn), 0)::text AS sent_lag_bytes,
      COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), flush_lsn), 0)::text AS flush_lag_bytes,
      COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), 0)::text AS replay_lag_bytes,
      EXTRACT(EPOCH FROM write_lag)::double precision AS write_lag_seconds,
      EXTRACT(EPOCH FROM flush_lag)::double precision AS flush_lag_seconds,
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

  // A monitor that silently checks zero replicas is itself an invisible failure.
  // In production every replica URL should be set, so treat a short inventory as
  // an error (which forces `healthy: false` and triggers the cron's alert).
  // Preview/dev deployments legitimately run without replica URLs, so gate on
  // VERCEL_ENV to avoid false alarms there.
  if (process.env.VERCEL_ENV === 'production' && targets.length < EXPECTED_REPLICA_COUNT) {
    errors.push(
      `expected ${EXPECTED_REPLICA_COUNT} read replicas but only ${targets.length} configured; ` +
        `check POSTGRES_REPLICA_* env vars`
    );
  }

  const [replicas, walSenders, slots] = await Promise.all([
    // Isolate each probe: `probeReplica` is contracted not to throw, but a
    // custom/injected probe or an unexpected error must not reject the whole
    // report and blank the walsender and slot data below.
    Promise.all(
      targets.map(target =>
        probe(target).catch(
          (error): ReplicaHealth => ({
            name: target.name,
            status: 'unreachable',
            in_recovery: null,
            replay_lsn: null,
            receive_lsn: null,
            receive_replay_gap_bytes: null,
            last_xact_replay_timestamp: null,
            replay_delay_seconds: null,
            error: errorMessage(error),
          })
        )
      )
    ),
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
