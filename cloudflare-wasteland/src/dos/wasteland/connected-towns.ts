/**
 * Connected town management.
 * Tracks which Kilo towns are connected to this wasteland.
 */

import { query } from '../../util/query.util';
import {
  wasteland_connected_towns,
  WastelandConnectedTownRecord,
  createTableWastelandConnectedTowns,
} from '../../db/tables/wasteland-connected-towns.table';

export type WastelandConnectedTown = WastelandConnectedTownRecord;

function now(): string {
  return new Date().toISOString();
}

export function initConnectedTownTables(sql: SqlStorage): void {
  query(sql, createTableWastelandConnectedTowns(), []);
}

export function connectTown(
  sql: SqlStorage,
  townId: string,
  townName: string
): WastelandConnectedTown {
  const timestamp = now();
  query(
    sql,
    /* sql */ `
      INSERT OR REPLACE INTO ${wasteland_connected_towns} (
        ${wasteland_connected_towns.columns.town_id},
        ${wasteland_connected_towns.columns.town_name},
        ${wasteland_connected_towns.columns.connected_at}
      ) VALUES (?, ?, ?)
    `,
    [townId, townName, timestamp]
  );

  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_connected_towns}
        WHERE ${wasteland_connected_towns.town_id} = ?
      `,
      [townId]
    ),
  ];
  return WastelandConnectedTownRecord.parse(rows[0]);
}

export function disconnectTown(sql: SqlStorage, townId: string): void {
  query(
    sql,
    /* sql */ `DELETE FROM ${wasteland_connected_towns} WHERE ${wasteland_connected_towns.town_id} = ?`,
    [townId]
  );
}

export function listConnectedTowns(sql: SqlStorage): WastelandConnectedTown[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_connected_towns}
        ORDER BY ${wasteland_connected_towns.connected_at} DESC
      `,
      []
    ),
  ];
  return WastelandConnectedTownRecord.array().parse(rows);
}
