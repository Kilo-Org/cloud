/**
 * Wasteland config operations for WastelandDO.
 */
import { query } from '../../util/query.util';
import {
  createTableWastelandConfig,
  wasteland_config,
  WastelandConfigRecord,
} from '../../db/tables/wasteland-config.table';

export function initConfigTable(sql: SqlStorage): void {
  query(sql, createTableWastelandConfig(), []);
}

export function getConfig(sql: SqlStorage): WastelandConfigRecord | null {
  const rows = [
    ...query(sql, /* sql */ `SELECT * FROM ${wasteland_config} LIMIT ?`, [1]),
  ];
  const parsed = WastelandConfigRecord.array().parse(rows);
  return parsed[0] ?? null;
}

export function insertConfig(
  sql: SqlStorage,
  input: {
    wasteland_id: string;
    name: string;
    owner_type: 'user' | 'org';
    owner_user_id: string | null;
    organization_id: string | null;
    dolthub_upstream: string | null;
    visibility: 'public' | 'private';
  }
): WastelandConfigRecord {
  const now = new Date().toISOString();
  query(
    sql,
    /* sql */ `
      INSERT INTO ${wasteland_config} (
        ${wasteland_config.columns.wasteland_id},
        ${wasteland_config.columns.name},
        ${wasteland_config.columns.owner_type},
        ${wasteland_config.columns.owner_user_id},
        ${wasteland_config.columns.organization_id},
        ${wasteland_config.columns.dolthub_upstream},
        ${wasteland_config.columns.visibility},
        ${wasteland_config.columns.status},
        ${wasteland_config.columns.created_at},
        ${wasteland_config.columns.updated_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.wasteland_id,
      input.name,
      input.owner_type,
      input.owner_user_id,
      input.organization_id,
      input.dolthub_upstream,
      input.visibility,
      'active',
      now,
      now,
    ]
  );

  const config = getConfig(sql);
  if (!config) throw new Error('Failed to read config after insert');
  return config;
}

export function updateConfig(
  sql: SqlStorage,
  updates: {
    name?: string;
    visibility?: 'public' | 'private';
    dolthub_upstream?: string | null;
    status?: 'active' | 'deleted';
  }
): WastelandConfigRecord {
  const now = new Date().toISOString();
  // Use COALESCE pattern for conditional updates
  query(
    sql,
    /* sql */ `
      UPDATE ${wasteland_config}
      SET
        ${wasteland_config.columns.name} = COALESCE(?, ${wasteland_config.columns.name}),
        ${wasteland_config.columns.visibility} = COALESCE(?, ${wasteland_config.columns.visibility}),
        ${wasteland_config.columns.dolthub_upstream} = CASE WHEN ? = 1 THEN ? ELSE ${wasteland_config.columns.dolthub_upstream} END,
        ${wasteland_config.columns.status} = COALESCE(?, ${wasteland_config.columns.status}),
        ${wasteland_config.columns.updated_at} = ?
    `,
    [
      updates.name ?? null,
      updates.visibility ?? null,
      updates.dolthub_upstream !== undefined ? 1 : 0,
      updates.dolthub_upstream !== undefined ? updates.dolthub_upstream : null,
      updates.status ?? null,
      now,
    ]
  );

  const config = getConfig(sql);
  if (!config) throw new Error('Failed to read config after update');
  return config;
}
