import type { ExportCursor } from './contracts';

export type ExportRecord = {
  source: string;
  field: string;
  value: string | number | boolean | null;
  id?: string;
  createdAt?: string | null;
};
export type SourcePage = { records: ExportRecord[]; nextCursor: ExportCursor | null };

export type ReplicaQuery = (text: string, values: unknown[]) => Promise<Record<string, unknown>[]>;

export type SourceAdapter = {
  name: string;
  disabledReason?: string;
  readPage?: (input: {
    kiloUserId: string;
    snapshotAt: string;
    cursor: ExportCursor | null;
    limit: number;
  }) => Promise<SourcePage>;
};

const projectQuery = `SELECT id, title,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM app_builder_projects
WHERE owned_by_user_id = $1
  AND created_at <= $2
  AND ($3::timestamptz IS NULL OR created_at > $3::timestamptz OR (created_at = $3::timestamptz AND id > $4))
ORDER BY created_at, id
LIMIT $5`;

const promptQuery = `SELECT mu.id AS usage_id,
  to_char(mu.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS usage_created_at,
  meta.id AS metadata_id,
  to_char(meta.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS metadata_created_at,
  meta.user_prompt_prefix, spp.system_prompt_prefix
FROM microdollar_usage AS mu
JOIN microdollar_usage_metadata AS meta ON meta.id = mu.id
LEFT JOIN system_prompt_prefix AS spp ON spp.system_prompt_prefix_id = meta.system_prompt_prefix_id
WHERE mu.kilo_user_id = $1
  AND mu.created_at <= $2
  AND ($3::timestamptz IS NULL OR mu.created_at > $3::timestamptz OR (mu.created_at = $3::timestamptz AND mu.id > $4))
ORDER BY mu.created_at, mu.id
LIMIT $5`;

const userQuery = `SELECT id, google_user_email, google_user_name, google_user_image_url,
  created_at, updated_at, hosted_domain, microdollars_used, total_microdollars_acquired,
  next_credit_expiration_at, auto_top_up_enabled, default_model, completed_welcome_form,
  linkedin_url, github_url, discord_server_membership_verified_at,
  openrouter_upstream_safety_identifier, openrouter_downstream_safety_identifier,
  vercel_downstream_safety_identifier, customer_source, signup_ip, normalized_email, email_domain
FROM kilocode_users
WHERE id = $1
LIMIT 1`;

function cursorFor(row: Record<string, unknown>): ExportCursor {
  return { createdAt: cursorTimestamp(row.created_at), id: requiredString(row.id, 'id') };
}

type ProjectRow = { id: string; title: string | null; created_at: string };
type PromptRow = {
  usage_id: string;
  usage_created_at: string;
  metadata_id: string;
  metadata_created_at: string | null;
  user_prompt_prefix: string | null;
  system_prompt_prefix: string | null;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Replica row has invalid ${field}`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function isoTimestamp(value: unknown, field: string): string {
  if (!(typeof value === 'string' || value instanceof Date)) {
    throw new Error(`Replica row has invalid ${field}`);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`Replica row has invalid ${field}`);
  return timestamp.toISOString();
}

function cursorTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) {
    throw new Error('Replica row has invalid created_at cursor');
  }
  return value;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  return isoTimestamp(value, field);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Replica row has invalid ${field}`);
  return value;
}

function safeNumber(value: unknown, field: string): number {
  let number: unknown = value;
  if (typeof value === 'bigint') {
    number = Number(value);
  } else if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    number = Number(BigInt(value));
  }
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
    throw new Error(`Replica row has unsafe ${field}`);
  }
  return number;
}

const USER_FIELD_MAPPERS = [
  ['id', (value: unknown) => requiredString(value, 'id')],
  ['google_user_email', (value: unknown) => requiredString(value, 'google_user_email')],
  ['google_user_name', (value: unknown) => requiredString(value, 'google_user_name')],
  ['google_user_image_url', (value: unknown) => requiredString(value, 'google_user_image_url')],
  ['created_at', (value: unknown) => isoTimestamp(value, 'created_at')],
  ['updated_at', (value: unknown) => isoTimestamp(value, 'updated_at')],
  ['hosted_domain', (value: unknown) => nullableString(value, 'hosted_domain')],
  ['microdollars_used', (value: unknown) => safeNumber(value, 'microdollars_used')],
  [
    'total_microdollars_acquired',
    (value: unknown) => safeNumber(value, 'total_microdollars_acquired'),
  ],
  [
    'next_credit_expiration_at',
    (value: unknown) => nullableTimestamp(value, 'next_credit_expiration_at'),
  ],
  ['auto_top_up_enabled', (value: unknown) => requiredBoolean(value, 'auto_top_up_enabled')],
  ['default_model', (value: unknown) => nullableString(value, 'default_model')],
  ['completed_welcome_form', (value: unknown) => requiredBoolean(value, 'completed_welcome_form')],
  ['linkedin_url', (value: unknown) => nullableString(value, 'linkedin_url')],
  ['github_url', (value: unknown) => nullableString(value, 'github_url')],
  [
    'discord_server_membership_verified_at',
    (value: unknown) => nullableTimestamp(value, 'discord_server_membership_verified_at'),
  ],
  [
    'openrouter_upstream_safety_identifier',
    (value: unknown) => nullableString(value, 'openrouter_upstream_safety_identifier'),
  ],
  [
    'openrouter_downstream_safety_identifier',
    (value: unknown) => nullableString(value, 'openrouter_downstream_safety_identifier'),
  ],
  [
    'vercel_downstream_safety_identifier',
    (value: unknown) => nullableString(value, 'vercel_downstream_safety_identifier'),
  ],
  ['customer_source', (value: unknown) => nullableString(value, 'customer_source')],
  ['signup_ip', (value: unknown) => nullableString(value, 'signup_ip')],
  ['normalized_email', (value: unknown) => nullableString(value, 'normalized_email')],
  ['email_domain', (value: unknown) => nullableString(value, 'email_domain')],
] as const;

export function createSourceAdapters(query: ReplicaQuery): SourceAdapter[] {
  return [
    {
      name: 'kilocode_users',
      async readPage(input): Promise<SourcePage> {
        if (input.cursor) return { records: [], nextCursor: null };
        const rows = await query(userQuery, [input.kiloUserId]);
        const row = rows[0];
        if (!row) throw new Error('Export user was not found');
        return {
          records: USER_FIELD_MAPPERS.map(([field, mapValue]) => ({
            source: 'kilocode_users',
            field,
            value: mapValue(row[field]),
          })),
          nextCursor: null,
        };
      },
    },
    {
      name: 'app_builder_projects',
      async readPage(input): Promise<SourcePage> {
        const rows: ProjectRow[] = await query(projectQuery, [
          input.kiloUserId,
          input.snapshotAt,
          input.cursor?.createdAt ?? null,
          input.cursor?.id ?? null,
          input.limit,
        ]).then(result =>
          result.map(row => ({
            id: requiredString(row.id, 'id'),
            title: nullableString(row.title, 'title'),
            created_at: cursorTimestamp(row.created_at),
          }))
        );
        const lastRow = rows.at(-1);
        return {
          records: rows.map(row => ({
            source: 'app_builder_projects',
            field: 'title',
            value: row.title == null ? null : String(row.title),
          })),
          nextCursor: rows.length === input.limit && lastRow ? cursorFor(lastRow) : null,
        };
      },
    },
    {
      name: 'microdollar_usage_prompts',
      async readPage(input): Promise<SourcePage> {
        const rows: PromptRow[] = await query(promptQuery, [
          input.kiloUserId,
          input.snapshotAt,
          input.cursor?.createdAt ?? null,
          input.cursor?.id ?? null,
          input.limit,
        ]).then(result =>
          result.map(row => ({
            usage_id: requiredString(row.usage_id, 'usage_id'),
            usage_created_at: cursorTimestamp(row.usage_created_at),
            metadata_id: requiredString(row.metadata_id, 'metadata_id'),
            metadata_created_at: nullableTimestamp(row.metadata_created_at, 'metadata_created_at'),
            user_prompt_prefix: nullableString(row.user_prompt_prefix, 'user_prompt_prefix'),
            system_prompt_prefix: nullableString(row.system_prompt_prefix, 'system_prompt_prefix'),
          }))
        );
        const records = rows.flatMap(row => [
          {
            source: 'microdollar_usage_metadata',
            id: row.metadata_id,
            createdAt: row.metadata_created_at,
            field: 'user_prompt_prefix',
            value: row.user_prompt_prefix == null ? null : String(row.user_prompt_prefix),
          },
          {
            source: 'system_prompt_prefix',
            field: 'system_prompt_prefix',
            value: row.system_prompt_prefix == null ? null : String(row.system_prompt_prefix),
          },
        ]);
        const lastRow = rows.at(-1);
        return {
          records,
          nextCursor:
            rows.length === input.limit && lastRow
              ? { createdAt: lastRow.usage_created_at, id: lastRow.usage_id }
              : null,
        };
      },
    },
    { name: 'app_builder_messages', disabledReason: 'source_table_dropped' },
    { name: 'numbered_cli_journal', disabledReason: 'source_not_found' },
  ];
}

export const sourceQueries = { projectQuery, promptQuery, userQuery };
