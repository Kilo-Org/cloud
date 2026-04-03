import { query } from '../../util/query.util';
import { wasteland_config, WastelandConfigRecord } from '../../db/tables/wasteland-config.table';

export type InitializeWastelandInput = {
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

export function initializeWasteland(
  sql: SqlStorage,
  input: InitializeWastelandInput
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

  const config = getConfig(sql, input.wasteland_id);
  if (!config) throw new Error('Failed to read back config after INSERT');
  return config;
}

export function getConfig(sql: SqlStorage, wastelandId: string): WastelandConfigRecord | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_config}
        WHERE ${wasteland_config.wasteland_id} = ?
      `,
      [wastelandId]
    ),
  ];
  if (rows.length === 0) return null;
  return WastelandConfigRecord.parse(rows[0]);
}

export function updateConfig(
  sql: SqlStorage,
  wastelandId: string,
  input: UpdateWastelandConfigInput
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
      input.name ?? null,
      input.visibility ?? null,
      input.dolthub_upstream ?? null,
      input.status ?? null,
      timestamp,
      wastelandId,
    ]
  );

  const config = getConfig(sql, wastelandId);
  if (!config) throw new Error('Failed to read back config after UPDATE');
  return config;
}
