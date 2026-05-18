import { query } from '../../util/query.util';
import {
  createTableWastelandConnectedTowns,
  wasteland_connected_towns,
  WastelandConnectedTownRecord,
} from '../../db/tables/wasteland-connected-towns.table';

export type ConnectedTownResult = {
  town_id: string;
  wasteland_id: string;
  connected_by: string;
  connected_at: string;
};

export function initializeDatabase(sql: SqlStorage): void {
  query(sql, createTableWastelandConnectedTowns(), []);
}

export function connectTown(
  sql: SqlStorage,
  wastelandId: string,
  townId: string,
  userId: string
): ConnectedTownResult {
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

  return {
    town_id: townId,
    wasteland_id: wastelandId,
    connected_by: userId,
    connected_at: timestamp,
  };
}

export function disconnectTown(sql: SqlStorage, wastelandId: string, townId: string): void {
  query(
    sql,
    /* sql */ `
      DELETE FROM ${wasteland_connected_towns}
      WHERE ${wasteland_connected_towns.columns.town_id} = ?
        AND ${wasteland_connected_towns.columns.wasteland_id} = ?
    `,
    [townId, wastelandId]
  );
}

export function listConnectedTowns(sql: SqlStorage, wastelandId: string): ConnectedTownResult[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_connected_towns}
        WHERE ${wasteland_connected_towns.wasteland_id} = ?
        ORDER BY ${wasteland_connected_towns.columns.connected_at} DESC
      `,
      [wastelandId]
    ),
  ];
  return WastelandConnectedTownRecord.array().parse(rows);
}

export function listConnectedTownsForUser(
  sql: SqlStorage,
  wastelandId: string,
  userId: string
): ConnectedTownResult[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_connected_towns}
        WHERE ${wasteland_connected_towns.wasteland_id} = ?
          AND ${wasteland_connected_towns.connected_by} = ?
        ORDER BY ${wasteland_connected_towns.columns.connected_at} DESC
      `,
      [wastelandId, userId]
    ),
  ];
  return WastelandConnectedTownRecord.array().parse(rows);
}
