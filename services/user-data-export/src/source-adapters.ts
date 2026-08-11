import { keyCursorValues, type ExportCursor } from './contracts';

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
  /** Overrides the caller's default page size. Set where rows are large. */
  pageSize?: number;
  readPage?: (input: {
    kiloUserId: string;
    snapshotAt: string;
    cursor: ExportCursor | null;
    limit: number;
  }) => Promise<SourcePage>;
};

/**
 * Identity comes from the live primary, so an export always reflects who the user is
 * right now. Everything else comes from the export warehouse, a frozen snapshot.
 */
const userQuery = `SELECT id, google_user_email, google_user_name, google_user_image_url,
  created_at, updated_at, hosted_domain, microdollars_used, total_microdollars_acquired,
  next_credit_expiration_at, auto_top_up_enabled, default_model, completed_welcome_form,
  linkedin_url, github_url, discord_server_membership_verified_at,
  openrouter_upstream_safety_identifier, openrouter_downstream_safety_identifier,
  vercel_downstream_safety_identifier, customer_source, signup_ip, normalized_email, email_domain
FROM kilocode_users
WHERE id = $1
LIMIT 1`;

/**
 * Every warehouse query below is scoped by `kilo_user_id = $1` and ordered on the
 * columns its index already covers, so a page is served without a sort step.
 *
 * `kilo_user_id = $1` never matches SQL NULL, which is what excludes org-owned rows.
 * Those carry a NULL owner in the warehouse and belong to no individual's export.
 * Org coverage is a separate piece of work.
 *
 * The warehouse has no `created_at` on any table and is itself a point-in-time
 * snapshot, so there is no `snapshot_at` bound to apply here.
 */
const projectQuery = `SELECT id, title
FROM app_builder_projects
WHERE kilo_user_id = $1
  AND ($2::text IS NULL OR id > $2::text)
ORDER BY id
LIMIT $3`;

const messageQuery = `SELECT id, data
FROM app_builder_messages
WHERE kilo_user_id = $1
  AND ($2::text IS NULL OR id > $2::text)
ORDER BY id
LIMIT $3`;

// session_id repeats about eleven times per session, so the journal position pair is
// the cursor. A cursor on session_id would skip the rest of a session whenever a page
// boundary landed mid-session.
const cliSessionQuery = `SELECT title, git_url, git_branch,
  most_significant_position::text AS most_significant_position,
  least_significant_position::text AS least_significant_position
FROM cli_sessions
WHERE kilo_user_id = $1
  AND ($2::bigint IS NULL
    OR (most_significant_position, least_significant_position) > ($2::bigint, $3::bigint))
ORDER BY most_significant_position, least_significant_position
LIMIT $4`;

const systemPromptQuery = `SELECT system_prompt_prefix_id::text AS system_prompt_prefix_id,
  system_prompt_prefix
FROM system_prompt_prefix
WHERE kilo_user_id = $1
  AND ($2::bigint IS NULL OR system_prompt_prefix_id > $2::bigint)
ORDER BY system_prompt_prefix_id
LIMIT $3`;

const userPromptQuery = `SELECT id, user_prompt_prefix
FROM microdollar_usage_metadata
WHERE kilo_user_id = $1
  AND ($2::text IS NULL OR id > $2::text)
ORDER BY id
LIMIT $3`;

// Message payloads are whole conversations rather than single fields, so this source
// reads fewer rows per page than the others.
const MESSAGE_PAGE_SIZE = 200;

type ProjectRow = { id: string; title: string | null };
type MessageRow = { id: string; data: unknown };
type CliSessionRow = {
  title: string | null;
  git_url: string | null;
  git_branch: string | null;
  most_significant_position: string;
  least_significant_position: string;
};
type SystemPromptRow = { system_prompt_prefix_id: string; system_prompt_prefix: string | null };
type UserPromptRow = { id: string; user_prompt_prefix: string | null };

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

/** Digits only, so a cursor value can never carry anything but a key back into a query. */
function digitString(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (!/^\d+$/.test(text)) throw new Error(`Warehouse row has invalid ${field}`);
  return text;
}

/**
 * jsonb payload as text. SQL NULL is excluded by the export filter, so a null here is
 * the jsonb value 'null' and is preserved as a null record rather than the string.
 */
function jsonValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
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

export type SourceAdapterQueries = {
  /** Live primary replica. Identity only. */
  replicaQuery: ReplicaQuery;
  /** Export warehouse. Read only, frozen at its load cutoff. */
  warehouseQuery: ReplicaQuery;
};

export function createSourceAdapters(queries: SourceAdapterQueries): SourceAdapter[] {
  const { replicaQuery, warehouseQuery } = queries;

  return [
    {
      name: 'kilocode_users',
      async readPage(input): Promise<SourcePage> {
        if (input.cursor) return { records: [], nextCursor: null };
        const rows = await replicaQuery(userQuery, [input.kiloUserId]);
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
        const [after] = keyCursorValues(input.cursor, 1);
        const rows: ProjectRow[] = await warehouseQuery(projectQuery, [
          input.kiloUserId,
          after,
          input.limit,
        ]).then(result =>
          result.map(row => ({
            id: requiredString(row.id, 'id'),
            title: nullableString(row.title, 'title'),
          }))
        );
        const lastRow = rows.at(-1);
        return {
          records: rows.map(row => ({
            source: 'app_builder_projects',
            field: 'title',
            value: row.title,
          })),
          nextCursor: rows.length === input.limit && lastRow ? { key: [lastRow.id] } : null,
        };
      },
    },
    {
      name: 'app_builder_messages',
      pageSize: MESSAGE_PAGE_SIZE,
      async readPage(input): Promise<SourcePage> {
        const [after] = keyCursorValues(input.cursor, 1);
        const rows: MessageRow[] = await warehouseQuery(messageQuery, [
          input.kiloUserId,
          after,
          input.limit,
        ]).then(result =>
          result.map(row => ({ id: requiredString(row.id, 'id'), data: row.data }))
        );
        const lastRow = rows.at(-1);
        return {
          records: rows.map(row => ({
            source: 'app_builder_messages',
            id: row.id,
            field: 'data',
            value: jsonValue(row.data),
          })),
          nextCursor: rows.length === input.limit && lastRow ? { key: [lastRow.id] } : null,
        };
      },
    },
    {
      name: 'cli_sessions',
      async readPage(input): Promise<SourcePage> {
        const [afterMost, afterLeast] = keyCursorValues(input.cursor, 2);
        const rows: CliSessionRow[] = await warehouseQuery(cliSessionQuery, [
          input.kiloUserId,
          afterMost,
          afterLeast,
          input.limit,
        ]).then(result =>
          result.map(row => ({
            title: nullableString(row.title, 'title'),
            git_url: nullableString(row.git_url, 'git_url'),
            git_branch: nullableString(row.git_branch, 'git_branch'),
            most_significant_position: digitString(
              row.most_significant_position,
              'most_significant_position'
            ),
            least_significant_position: digitString(
              row.least_significant_position,
              'least_significant_position'
            ),
          }))
        );
        const lastRow = rows.at(-1);
        return {
          records: rows.flatMap(row => [
            { source: 'cli_sessions', field: 'title', value: row.title },
            { source: 'cli_sessions', field: 'git_url', value: row.git_url },
            { source: 'cli_sessions', field: 'git_branch', value: row.git_branch },
          ]),
          nextCursor:
            rows.length === input.limit && lastRow
              ? { key: [lastRow.most_significant_position, lastRow.least_significant_position] }
              : null,
        };
      },
    },
    {
      name: 'system_prompt_prefix',
      async readPage(input): Promise<SourcePage> {
        const [after] = keyCursorValues(input.cursor, 1);
        const rows: SystemPromptRow[] = await warehouseQuery(systemPromptQuery, [
          input.kiloUserId,
          after,
          input.limit,
        ]).then(result =>
          result.map(row => ({
            system_prompt_prefix_id: digitString(
              row.system_prompt_prefix_id,
              'system_prompt_prefix_id'
            ),
            system_prompt_prefix: nullableString(row.system_prompt_prefix, 'system_prompt_prefix'),
          }))
        );
        const lastRow = rows.at(-1);
        return {
          records: rows.map(row => ({
            source: 'system_prompt_prefix',
            field: 'system_prompt_prefix',
            value: row.system_prompt_prefix,
          })),
          nextCursor:
            rows.length === input.limit && lastRow
              ? { key: [lastRow.system_prompt_prefix_id] }
              : null,
        };
      },
    },
    {
      name: 'microdollar_usage_metadata',
      async readPage(input): Promise<SourcePage> {
        const [after] = keyCursorValues(input.cursor, 1);
        const rows: UserPromptRow[] = await warehouseQuery(userPromptQuery, [
          input.kiloUserId,
          after,
          input.limit,
        ]).then(result =>
          result.map(row => ({
            id: requiredString(row.id, 'id'),
            user_prompt_prefix: nullableString(row.user_prompt_prefix, 'user_prompt_prefix'),
          }))
        );
        const lastRow = rows.at(-1);
        return {
          records: rows.map(row => ({
            source: 'microdollar_usage_metadata',
            id: row.id,
            field: 'user_prompt_prefix',
            value: row.user_prompt_prefix,
          })),
          nextCursor: rows.length === input.limit && lastRow ? { key: [lastRow.id] } : null,
        };
      },
    },
  ];
}

/** Warehouse queries only. Every one must be scoped to a single user. */
export const warehouseQueries = {
  projectQuery,
  messageQuery,
  cliSessionQuery,
  systemPromptQuery,
  userPromptQuery,
};

export const sourceQueries = { ...warehouseQueries, userQuery };
