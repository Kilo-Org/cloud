import { query } from '../../util/query.util';
import {
  createTableWastelandConfig,
  wasteland_config,
  WastelandConfigRecord,
} from '../../db/tables/wasteland-config.table';

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

export type WastelandConfigResult = {
  wasteland_id: string;
  name: string;
  owner_type: 'user' | 'org';
  owner_user_id: string | null;
  organization_id: string | null;
  dolthub_upstream: string | null;
  visibility: 'public' | 'private';
  status: 'active' | 'deleted';
  created_at: string;
  updated_at: string;
};

export function initializeDatabase(sql: SqlStorage): void {
  query(sql, createTableWastelandConfig(), []);
}

export function initializeWasteland(
  sql: SqlStorage,
  input: InitializeWastelandInput
): WastelandConfigResult {
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

  return {
    wasteland_id: input.wasteland_id,
    name: input.name,
    owner_type: input.owner_type,
    owner_user_id: input.owner_user_id,
    organization_id: input.organization_id,
    dolthub_upstream: input.dolthub_upstream,
    visibility: input.visibility,
    status: 'active' as const,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function getConfig(sql: SqlStorage, wastelandId: string): WastelandConfigResult | null {
  const rows: Record<string, unknown>[] = [
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
  update: UpdateWastelandConfigInput
): WastelandConfigResult {
  const current = getConfig(sql, wastelandId);
  if (!current) {
    throw new Error('Config not found');
  }

  const sets: string[] = [];
  const params: unknown[] = [];

  if (update.name !== undefined) {
    sets.push(`${wasteland_config.columns.name} = ?`);
    params.push(update.name);
  }
  if (update.visibility !== undefined) {
    sets.push(`${wasteland_config.columns.visibility} = ?`);
    params.push(update.visibility);
  }
  if (update.dolthub_upstream !== undefined) {
    sets.push(`${wasteland_config.columns.dolthub_upstream} = ?`);
    params.push(update.dolthub_upstream);
  }
  if (update.status !== undefined) {
    sets.push(`${wasteland_config.columns.status} = ?`);
    params.push(update.status);
  }

  if (sets.length === 0) {
    return current;
  }

  sets.push(`${wasteland_config.columns.updated_at} = ?`);
  params.push(new Date().toISOString());

  const allParams = [...params, wastelandId];

  query(
    sql,
    /* sql */ `
      UPDATE ${wasteland_config}
      SET ${sets.join(', ')}
      WHERE ${wasteland_config.wasteland_id} = ?
    `,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    allParams as any
  );

  return {
    ...current,
    ...(update.name !== undefined ? { name: update.name } : {}),
    ...(update.visibility !== undefined ? { visibility: update.visibility } : {}),
    ...(update.dolthub_upstream !== undefined ? { dolthub_upstream: update.dolthub_upstream } : {}),
    ...(update.status !== undefined ? { status: update.status } : {}),
  };
}
