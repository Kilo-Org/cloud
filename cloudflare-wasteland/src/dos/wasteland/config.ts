import { query } from '../../util/query.util';
import {
  wasteland_config,
  WastelandConfigRecord,
} from '../../db/tables/wasteland-config.table';

const LOG = '[wasteland/config]';

export type InitWastelandInput = {
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

export function getConfig(sql: SqlStorage): WastelandConfigRecord | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_config}
        LIMIT 1
      `,
      []
    ),
  ];
  if (rows.length === 0) return null;
  return WastelandConfigRecord.parse(rows[0]);
}

export function initializeWasteland(sql: SqlStorage, input: InitWastelandInput): void {
  const timestamp = new Date().toISOString();
  console.log(`${LOG} initializeWasteland: id=${input.wasteland_id} name=${input.name}`);

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
}

export function updateConfig(sql: SqlStorage, update: UpdateConfigInput): void {
  const timestamp = new Date().toISOString();
  console.log(`${LOG} updateConfig: fields=${Object.keys(update).join(',')}`);

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
      update.name ?? null,
      update.visibility ?? null,
      'dolthub_upstream' in update ? 1 : 0,
      'dolthub_upstream' in update ? (update.dolthub_upstream ?? null) : null,
      update.status ?? null,
      timestamp,
    ]
  );
}
