/**
 * Wasteland configuration CRUD.
 * Manages the single-row wasteland_config table.
 */

import { z } from 'zod';
import { query } from '../../util/query.util';
import {
  wasteland_config,
  WastelandConfigRecord,
  createTableWastelandConfig,
} from '../../db/tables/wasteland-config.table';

export type WastelandConfig = WastelandConfigRecord;

export const InitWastelandInput = z.object({
  wasteland_id: z.string(),
  name: z.string(),
  owner_type: z.enum(['user', 'org']),
  owner_user_id: z.string().nullable().optional(),
  organization_id: z.string().nullable().optional(),
  dolthub_upstream: z.string().nullable().optional(),
  visibility: z.enum(['public', 'private']).optional(),
});

export type InitWastelandInput = z.infer<typeof InitWastelandInput>;

export const WastelandConfigUpdate = z.object({
  name: z.string().optional(),
  dolthub_upstream: z.string().nullable().optional(),
  visibility: z.enum(['public', 'private']).optional(),
  status: z.enum(['active', 'deleted']).optional(),
});

export type WastelandConfigUpdate = z.infer<typeof WastelandConfigUpdate>;

function now(): string {
  return new Date().toISOString();
}

export function initConfigTables(sql: SqlStorage): void {
  query(sql, createTableWastelandConfig(), []);
}

export function getConfig(sql: SqlStorage): WastelandConfig | null {
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

export function initializeWasteland(sql: SqlStorage, input: InitWastelandInput): void {
  const timestamp = now();
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
      input.owner_user_id ?? null,
      input.organization_id ?? null,
      input.dolthub_upstream ?? null,
      input.visibility ?? 'private',
      'active',
      timestamp,
      timestamp,
    ]
  );
}

export function updateConfig(sql: SqlStorage, update: WastelandConfigUpdate): void {
  const current = getConfig(sql);
  if (!current) throw new Error('Cannot update config: wasteland not initialized');

  const timestamp = now();
  query(
    sql,
    /* sql */ `
      UPDATE ${wasteland_config}
      SET ${wasteland_config.columns.name} = ?,
          ${wasteland_config.columns.dolthub_upstream} = ?,
          ${wasteland_config.columns.visibility} = ?,
          ${wasteland_config.columns.status} = ?,
          ${wasteland_config.columns.updated_at} = ?
      WHERE ${wasteland_config.columns.wasteland_id} = ?
    `,
    [
      update.name ?? current.name,
      update.dolthub_upstream !== undefined ? update.dolthub_upstream : current.dolthub_upstream,
      update.visibility ?? current.visibility,
      update.status ?? current.status,
      timestamp,
      current.wasteland_id,
    ]
  );
}
