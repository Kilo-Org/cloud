import { query } from '../../util/query.util';
import {
  wasteland_connected_towns,
  WastelandConnectedTownRecord,
  createTableWastelandConnectedTowns,
} from '../../db/tables/wasteland-connected-towns.table';

export function initConnectedTownsTable(sql: SqlStorage): void {
  query(sql, createTableWastelandConnectedTowns(), []);
}

export function connectTown(
  sql: SqlStorage,
  wastelandId: string,
  townId: string,
  userId: string
): WastelandConnectedTownRecord {
  const timestamp = new Date().toISOString();

  query(
    sql,
    /* sql */ `
      INSERT OR REPLACE INTO ${wasteland_connected_towns} (
        ${wasteland_connected_towns.columns.town_id},
        ${wasteland_connected_towns.columns.wasteland_id},
        ${wasteland_connected_towns.columns.connected_by},
        ${wasteland_connected_towns.columns.connected_at}
      ) VALUES (?, ?, ?, ?)
    `,
    [townId, wastelandId, userId, timestamp]
  );

  const result = getConnectedTown(sql, townId);
  if (!result) throw new Error('Failed to read connected town after insert');
  return result;
}

export function disconnectTown(sql: SqlStorage, townId: string): void {
  query(
    sql,
    /* sql */ `
      DELETE FROM ${wasteland_connected_towns}
      WHERE ${wasteland_connected_towns.town_id} = ?
    `,
    [townId]
  );
}

export function listConnectedTowns(sql: SqlStorage): WastelandConnectedTownRecord[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_connected_towns}
        ORDER BY ${wasteland_connected_towns.connected_at} ASC
      `,
      []
    ),
  ];
  return WastelandConnectedTownRecord.array().parse(rows);
}

function getConnectedTown(
  sql: SqlStorage,
  townId: string
): WastelandConnectedTownRecord | null {
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
  if (rows.length === 0) return null;
  return WastelandConnectedTownRecord.parse(rows[0]);
}
