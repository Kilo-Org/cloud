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
