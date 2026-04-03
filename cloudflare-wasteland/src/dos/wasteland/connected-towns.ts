import { query } from '../../util/query.util';
import {
  wasteland_connected_towns,
  WastelandConnectedTownRecord,
} from '../../db/tables/wasteland-connected-towns.table';

export function connectTown(
  sql: SqlStorage,
  townId: string,
  wastelandId: string,
  userId: string
): WastelandConnectedTownRecord {
  const now = new Date().toISOString();
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
    [townId, wastelandId, userId, now]
  );
  const rows = [
    ...query(
      sql,
      /* sql */ `SELECT * FROM ${wasteland_connected_towns} WHERE ${wasteland_connected_towns.town_id} = ?`,
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

export function listConnectedTowns(sql: SqlStorage): WastelandConnectedTownRecord[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `SELECT * FROM ${wasteland_connected_towns} ORDER BY ${wasteland_connected_towns.connected_at} DESC`,
      []
    ),
  ];
  return WastelandConnectedTownRecord.array().parse(rows);
}
