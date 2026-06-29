import { timingSafeEqual } from 'crypto';
import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { db } from '@/lib/drizzle';

type ReplicationLagRow = {
  pid: number;
  application_name: string;
  client_addr: string | null;
  client_hostname: string | null;
  client_port: number | null;
  state: string | null;
  sync_state: string | null;
  sent_lsn: string | null;
  write_lsn: string | null;
  flush_lsn: string | null;
  replay_lsn: string | null;
  sent_lag_bytes: string;
  write_lag_bytes: string;
  flush_lag_bytes: string;
  replay_lag_bytes: string;
  write_lag_seconds: number | null;
  flush_lag_seconds: number | null;
  replay_lag_seconds: number | null;
};

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function GET(request: Request) {
  const secret = request.headers.get('X-Internal-Secret');
  if (!INTERNAL_API_SECRET || !secretMatches(secret, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { rows } = await db.execute<ReplicationLagRow>(sql`
    SELECT
      pid,
      application_name,
      client_addr::text,
      client_hostname,
      client_port,
      state,
      sync_state,
      sent_lsn::text,
      write_lsn::text,
      flush_lsn::text,
      replay_lsn::text,
      COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn), 0)::text AS sent_lag_bytes,
      COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), write_lsn), 0)::text AS write_lag_bytes,
      COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), flush_lsn), 0)::text AS flush_lag_bytes,
      COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), 0)::text AS replay_lag_bytes,
      EXTRACT(EPOCH FROM write_lag)::double precision AS write_lag_seconds,
      EXTRACT(EPOCH FROM flush_lag)::double precision AS flush_lag_seconds,
      EXTRACT(EPOCH FROM replay_lag)::double precision AS replay_lag_seconds
    FROM pg_stat_replication
    ORDER BY application_name, client_addr, client_port
  `);

  return NextResponse.json({ targets: rows, timestamp: new Date().toISOString() });
}
