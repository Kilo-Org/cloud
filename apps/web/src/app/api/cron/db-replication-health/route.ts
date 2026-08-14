import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@/lib/config.server';
import { collectReplicationHealth, isReplicationSlotMonitored } from '@/lib/replication-health';

/**
 * Emits replication health to Axiom (via the Vercel log drain) and alerts Sentry
 * when a replica is lagging/unreachable or a slot is at risk of losing WAL.
 *
 * This intentionally uses the replica-side SQL probe from `collectReplicationHealth`
 * rather than the Supabase Prometheus `physical_replication_lag_*` metric: that
 * metric has a documented history of returning no data, and — like the primary's
 * `pg_stat_replication` — cannot see a replica whose walreceiver has died. The
 * per-replica probe is the authoritative signal.
 *
 * Runs every minute (see `vercel.json`). The us-west replica loses ~1-3 minutes
 * of replay a few times a day; at the previous 5-minute cadence each episode was
 * caught by roughly a single sample, so its onset and duration were unmeasurable.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const report = await collectReplicationHealth();

  // Structured JSON → Vercel log drain → Axiom, one line per series.
  for (const replica of report.replicas) {
    console.log(
      JSON.stringify({ type: 'db_replication_health', ...replica, timestamp: report.timestamp })
    );
  }
  // The primary's view of each replica. Only the replica probe can see a replica
  // that stopped streaming, but only the primary can attribute lag to getting the
  // WAL there (write/flush) versus applying it (replay), which is what the
  // per-replica probe cannot distinguish on its own.
  for (const walSender of report.walSenders) {
    console.log(
      JSON.stringify({
        type: 'db_replication_wal_sender',
        ...walSender,
        timestamp: report.timestamp,
      })
    );
  }
  for (const slot of report.slots) {
    console.log(
      JSON.stringify({ type: 'db_replication_slot', ...slot, timestamp: report.timestamp })
    );
  }

  const problems: string[] = [];
  for (const replica of report.replicas) {
    if (replica.status !== 'ok') {
      problems.push(
        `replica ${replica.name}: ${replica.status}` +
          (replica.replay_delay_seconds !== null
            ? ` (${Math.round(replica.replay_delay_seconds)}s behind)`
            : replica.error
              ? ` (${replica.error})`
              : '')
      );
    }
  }
  for (const slot of report.slots) {
    if (slot.at_risk && isReplicationSlotMonitored(slot.slot_name)) {
      problems.push(`slot ${slot.slot_name}: wal_status=${slot.wal_status}, active=${slot.active}`);
    }
  }
  for (const error of report.errors) {
    problems.push(`primary query failed: ${error}`);
  }

  if (problems.length > 0) {
    console.error(JSON.stringify({ type: 'db_replication_health_alert', problems }));
    captureException(new Error(`Replication health degraded: ${problems.join('; ')}`));
  }

  return NextResponse.json({
    healthy: report.healthy,
    problems,
    replicas: report.replicas.length,
    slots: report.slots.length,
    timestamp: report.timestamp,
  });
}
