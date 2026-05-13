/**
 * Wasteland connection state for the Town DO.
 *
 * Tracks the town's connection to a single wasteland commons, storing the
 * wasteland ID, upstream path, rig handle, and DoltHub org. This data is
 * used by the mayor to auto-discover the connected wasteland and by the
 * reconciler to flow completions back to the wasteland.
 */

import { z } from 'zod';
import { query } from '../../util/query.util';
import { beads } from '../../db/tables/beads.table';

// ---------------------------------------------------------------------------
// Table DDL
// ---------------------------------------------------------------------------

const TABLE_CREATE = /* sql */ `
  CREATE TABLE IF NOT EXISTS "town_wasteland_connections" (
    "connection_id" TEXT PRIMARY KEY,
    "wasteland_id" TEXT NOT NULL,
    "upstream" TEXT NOT NULL,
    "rig_handle" TEXT NOT NULL,
    "dolthub_org" TEXT NOT NULL,
    "connected_at" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'disconnecting'))
  )
`;

// ---------------------------------------------------------------------------
// Record schema
// ---------------------------------------------------------------------------

export const WastelandConnectionRecord = z.object({
  connection_id: z.string(),
  wasteland_id: z.string(),
  upstream: z.string(),
  rig_handle: z.string(),
  dolthub_org: z.string(),
  connected_at: z.string(),
  status: z.enum(['active', 'disconnecting']),
});

export type WastelandConnectionRecord = z.output<typeof WastelandConnectionRecord>;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initWastelandTables(sql: SqlStorage): void {
  query(sql, TABLE_CREATE, []);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export function connectWasteland(
  sql: SqlStorage,
  input: {
    connectionId: string;
    wastelandId: string;
    upstream: string;
    rigHandle: string;
    dolthubOrg: string;
  }
): WastelandConnectionRecord {
  const now = new Date().toISOString();
  query(
    sql,
    /* sql */ `
      INSERT INTO town_wasteland_connections
        (connection_id, wasteland_id, upstream, rig_handle, dolthub_org, connected_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
      ON CONFLICT(connection_id) DO UPDATE SET
        wasteland_id = excluded.wasteland_id,
        upstream = excluded.upstream,
        rig_handle = excluded.rig_handle,
        dolthub_org = excluded.dolthub_org,
        status = 'active'
    `,
    [input.connectionId, input.wastelandId, input.upstream, input.rigHandle, input.dolthubOrg, now]
  );

  return {
    connection_id: input.connectionId,
    wasteland_id: input.wastelandId,
    upstream: input.upstream,
    rig_handle: input.rigHandle,
    dolthub_org: input.dolthubOrg,
    connected_at: now,
    status: 'active',
  };
}

export function disconnectWasteland(sql: SqlStorage, wastelandId: string): void {
  query(sql, /* sql */ `DELETE FROM town_wasteland_connections WHERE wasteland_id = ?`, [
    wastelandId,
  ]);
}

/**
 * Stamp `metadata.wasteland.reported_done_at` (and optionally
 * `metadata.wasteland.reported_evidence`) onto a bead. Used by the
 * auto-done reporter to persist the idempotency flag once the upstream
 * `markWantedItemDone` call succeeds.
 *
 * Returns `false` (and writes nothing) when the target bead doesn't
 * carry a `metadata.wasteland` object — SQLite's `json_set` won't
 * create intermediate objects, so a silent no-op would let the
 * reconciler retry indefinitely. Returns `true` on a successful stamp.
 */
export function stampWastelandReportedDone(
  sql: SqlStorage,
  beadId: string,
  input: { evidence?: string }
): boolean {
  // Refuse to stamp when there is no wasteland tag to merge into. Without
  // this guard, a malformed canonical-bead pick would silently no-op and
  // the reconciler would re-fire the upstream RPC every tick.
  const probeRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT json_extract(${beads.metadata}, '$.wasteland') AS wl
        FROM ${beads}
        WHERE ${beads.bead_id} = ?
      `,
      [beadId]
    ),
  ];
  const probe = probeRows[0]?.wl;
  if (probe === null || probe === undefined) return false;

  const timestamp = new Date().toISOString();
  query(
    sql,
    /* sql */ `
      UPDATE ${beads}
      SET ${beads.columns.metadata} = json_set(
            COALESCE(${beads.metadata}, '{}'),
            '$.wasteland.reported_done_at', ?,
            '$.wasteland.reported_evidence', ?
          ),
          ${beads.columns.updated_at} = ?
      WHERE ${beads.bead_id} = ?
    `,
    [timestamp, input.evidence ?? null, timestamp, beadId]
  );
  return true;
}

/**
 * Returns the active wasteland connection for this town, or null if none.
 * For the POC we only support a single connection; this returns the first
 * active one found.
 */
export function getWastelandConnection(sql: SqlStorage): WastelandConnectionRecord | null {
  const rows = query(
    sql,
    /* sql */ `
      SELECT connection_id, wasteland_id, upstream, rig_handle, dolthub_org, connected_at, status
      FROM town_wasteland_connections
      WHERE status = 'active'
      LIMIT 1
    `,
    []
  );

  const parsed = WastelandConnectionRecord.array().parse([...rows]);
  return parsed[0] ?? null;
}
