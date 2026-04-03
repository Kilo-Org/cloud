import { query } from '../../util/query.util';
import {
  wasteland_config,
  WastelandConfigRecord,
} from '../../db/tables/wasteland-config.table';

export type ConfigInput = {
  wasteland_id: string;
  name: string;
  owner_type: 'user' | 'org';
  owner_user_id: string | null;
  organization_id: string | null;
  dolthub_upstream: string | null;
  visibility: 'public' | 'private';
};

export type UpdateConfigInput = {
  name?: string;
  visibility?: 'public' | 'private';
  dolthub_upstream?: string | null;
  status?: 'active' | 'deleted';
};

export function insertConfig(sql: SqlStorage, input: ConfigInput): WastelandConfigRecord {
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
      now,
      now,
    ]
  );
  const result = getConfig(sql, input.wasteland_id);
  if (!result) throw new Error('Failed to insert config');
  return result;
}

export function getConfig(
  sql: SqlStorage,
  wastelandId: string
): WastelandConfigRecord | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `SELECT * FROM ${wasteland_config} WHERE ${wasteland_config.wasteland_id} = ?`,
      [wastelandId]
    ),
  ];
  if (rows.length === 0) return null;
  return WastelandConfigRecord.parse(rows[0]);
}

export function updateConfig(
  sql: SqlStorage,
  wastelandId: string,
  input: UpdateConfigInput
): WastelandConfigRecord {
  const now = new Date().toISOString();

  // Build SET clauses dynamically but use a static query per combination
  // to keep things simple. Use COALESCE pattern for conditional updates.
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
      WHERE ${wasteland_config.wasteland_id} = ?
    `,
    [
      input.name ?? null,
      input.visibility ?? null,
      input.dolthub_upstream !== undefined ? 1 : 0,
      input.dolthub_upstream !== undefined ? (input.dolthub_upstream ?? null) : null,
      input.status ?? null,
      now,
      wastelandId,
    ]
  );

  const result = getConfig(sql, wastelandId);
  if (!result) throw new Error('Config not found after update');
  return result;
}
