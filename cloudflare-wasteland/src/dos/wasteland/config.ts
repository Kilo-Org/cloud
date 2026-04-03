import { query } from '../../util/query.util';
import {
  wasteland_config,
  WastelandConfigRecord,
  createTableWastelandConfig,
} from '../../db/tables/wasteland-config.table';

export type InitWastelandInput = {
  wasteland_id: string;
  name: string;
  owner_type: 'user' | 'org';
  owner_user_id: string | null;
  organization_id: string | null;
  dolthub_upstream: string | null;
  visibility: 'public' | 'private';
};

export type UpdateWastelandConfigInput = {
  name?: string;
  visibility?: 'public' | 'private';
  dolthub_upstream?: string | null;
  status?: 'active' | 'deleted';
};

export function initConfigTable(sql: SqlStorage): void {
  query(sql, createTableWastelandConfig(), []);
}

export function getConfig(sql: SqlStorage): WastelandConfigRecord | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `SELECT * FROM ${wasteland_config} LIMIT 1`,
      []
    ),
  ];
  if (rows.length === 0) return null;
  return WastelandConfigRecord.parse(rows[0]);
}

export function initializeWasteland(
  sql: SqlStorage,
  input: InitWastelandInput
): WastelandConfigRecord {
  const timestamp = new Date().toISOString();

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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `,
    [
      input.wasteland_id,
      input.name,
      input.owner_type,
      input.owner_user_id,
      input.organization_id,
      input.dolthub_upstream,
      input.visibility,
      timestamp,
      timestamp,
    ]
  );

  const result = getConfig(sql);
  if (!result) throw new Error('Failed to read config after insert');
  return result;
}

export function updateConfig(
  sql: SqlStorage,
  wastelandId: string,
  update: UpdateWastelandConfigInput
): WastelandConfigRecord {
  const timestamp = new Date().toISOString();

  query(
    sql,
    /* sql */ `
      UPDATE ${wasteland_config}
      SET ${wasteland_config.columns.name} = COALESCE(?, ${wasteland_config.columns.name}),
          ${wasteland_config.columns.visibility} = COALESCE(?, ${wasteland_config.columns.visibility}),
          ${wasteland_config.columns.dolthub_upstream} = COALESCE(?, ${wasteland_config.columns.dolthub_upstream}),
          ${wasteland_config.columns.status} = COALESCE(?, ${wasteland_config.columns.status}),
          ${wasteland_config.columns.updated_at} = ?
      WHERE ${wasteland_config.wasteland_id} = ?
    `,
    [
      update.name ?? null,
      update.visibility ?? null,
      update.dolthub_upstream ?? null,
      update.status ?? null,
      timestamp,
      wastelandId,
    ]
  );

  const result = getConfig(sql);
  if (!result) throw new Error('Failed to read config after update');
  return result;
}
