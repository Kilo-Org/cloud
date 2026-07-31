import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@/lib/config.server';
import { collectReplicationHealth } from '@/lib/replication-health';

/**
 * Emits replication health to Axiom (via the Vercel log drain) and alerts Sentry
 * when a replica is lagging/unreachable or a slot is at risk of losing WAL.
 *
 * This intentionally uses the replica-side SQL probe from `collectReplicationHealth`
 * rather than the Supabase Prometheus `physical_replication_lag_*` metric: that
 * metric has a documented history of returning no data, and — like the primary's
 * `pg_stat_replication` — cannot see a replica whose walreceiver has died. The
 * per-replica probe is the authoritative signal.
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
    if (slot.at_risk) {
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
