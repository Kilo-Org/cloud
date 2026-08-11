import { keyCursorValues, type ExportCursor, type KeyCursor } from './contracts';
import { TerminalExportError } from './errors';

export type ExportRecord = {
  source: string;
  field: string;
  value: string | number | boolean | null;
  id?: string;
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
 * The identity section is assembled from both databases, because the profile fields
 * are split across them.
 *
 * `email` and `name` are the fields the export presents as the user's identity, and
 * the warehouse carries its own copy of both. Those are read from the warehouse
 * (`warehouseProfileQuery`) so they are as of the same moment as the other five
 * sources, rather than showing a name the user changed after the snapshot beside
 * data that predates the change.
 *
 * The remaining columns below have no warehouse equivalent — most were never exported
 * from the source model, and the monetization ones were deliberately dropped from it —
 * so they still come from the live primary. This is a single indexed lookup by primary
 * key, once per export, not the bulk traffic the warehouse exists to absorb.
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
 * The warehouse's copy of the profile fields it carries. Keyed on `user_id`, which is
 * the warehouse's name for `kilocode_users.id` and the same value the five child tables
 * carry as `kilo_user_id`.
 *
 * Only `email` and `name` are read. The table has geo columns too, but the export has
 * never had a geo section and adding one is not what sourcing identity from the
 * warehouse means.
 */
const warehouseProfileQuery = `SELECT user_id, email, name
FROM users
WHERE user_id = $1
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
/**
 * A single-key keyset page, defined once so a change to the predicate cannot reach
 * some sources and miss others.
 *
 * `table`, `columns` and `key` are module constants below, never caller input. The
 * user id and the cursor are always bind parameters, so nothing user-supplied is
 * interpolated into the statement.
 */
function singleKeyPageQuery(input: {
  table: string;
  columns: string;
  key?: string;
  keyType?: 'text' | 'bigint';
}): string {
  const key = input.key ?? 'id';
  const keyType = input.keyType ?? 'text';
  return `SELECT ${input.columns}
FROM ${input.table}
WHERE kilo_user_id = $1
  AND ($2::${keyType} IS NULL OR ${key} > $2::${keyType})
ORDER BY ${key}
LIMIT $3`;
}

const projectQuery = singleKeyPageQuery({
  table: 'app_builder_projects',
  columns: 'id, title',
});

const messageQuery = singleKeyPageQuery({
  table: 'app_builder_messages',
  columns: 'id, data',
});

/**
 * The source is a journal, so a session appears once per recorded change rather
 * than once overall, and session_id repeats. The journal position pair is therefore
 * the cursor: a cursor on session_id would skip the rest of a session whenever a
 * page boundary landed mid-session.
 *
 * Every journal row is exported rather than collapsed to one row per session.
 * Measured on a real account, 12% of sessions carry values that change across their
 * rows, so collapsing would silently drop titles and branches the user actually
 * had. Each record is keyed by its journal position so repeated values read as a
 * timeline instead of looking like duplication, and session_id is exported so rows
 * belonging to one session can be grouped.
 */
const cliSessionQuery = `SELECT session_id, title, git_url, git_branch,
  most_significant_position::text AS most_significant_position,
  least_significant_position::text AS least_significant_position
FROM cli_sessions
WHERE kilo_user_id = $1
  AND ($2::bigint IS NULL
    OR (most_significant_position, least_significant_position) > ($2::bigint, $3::bigint))
ORDER BY most_significant_position, least_significant_position
LIMIT $4`;

/**
 * System prompts and user prompts ship as two independent sets.
 *
 * The previous implementation ran one join across microdollar_usage,
 * microdollar_usage_metadata and system_prompt_prefix, emitting each user prompt
 * immediately followed by the system prompt in effect for it. Adjacency in the
 * stream was the only thing expressing that pairing; neither record carried a
 * shared key.
 *
 * The warehouse cannot reproduce it: microdollar_usage_metadata carries no
 * system_prompt_prefix_id, and system_prompt_prefix is deduplicated to its distinct
 * (prefix id, user, org) grain rather than one row per usage event. Restoring the
 * pairing would mean re-exporting a 1.1 billion row table to add the join key.
 *
 * Decided deliberately: the export lists every system prompt the user used and
 * every prompt they wrote, with no correspondence between the two.
 */
const systemPromptQuery = singleKeyPageQuery({
  table: 'system_prompt_prefix',
  columns: 'system_prompt_prefix_id::text AS system_prompt_prefix_id, system_prompt_prefix',
  key: 'system_prompt_prefix_id',
  keyType: 'bigint',
});

const userPromptQuery = singleKeyPageQuery({
  table: 'microdollar_usage_metadata',
  columns: 'id, user_prompt_prefix',
});

// Message payloads are whole conversations rather than single fields, so this source
// reads fewer rows per page than the others.
const MESSAGE_PAGE_SIZE = 200;

type ProjectRow = { id: string; title: string | null };
type MessageRow = { id: string; data: unknown };
type CliSessionRow = {
  session_id: string | null;
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

/**
 * The cursor for the next page, or null when this page ends the source.
 *
 * A full page is assumed to imply another page exists. That costs one extra empty
 * read when the row count is an exact multiple of the page size, which is cheaper
 * than the alternative failure: stopping early and silently truncating a user's
 * export. Defined once so this trade-off cannot be changed for some sources and
 * missed for others.
 */
function nextKeyCursor<Row>(
  rows: Row[],
  limit: number,
  keyOf: (row: Row) => string[]
): KeyCursor | null {
  const lastRow = rows.at(-1);
  if (rows.length < limit || !lastRow) return null;
  return { key: keyOf(lastRow) };
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
  /** Live primary replica. The profile columns the warehouse does not carry. */
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
        const [rows, profileRows] = await Promise.all([
          replicaQuery(userQuery, [input.kiloUserId]),
          warehouseQuery(warehouseProfileQuery, [input.kiloUserId]),
        ]);
        const row = rows[0];
        if (!row) throw new Error('Export user was not found');

        // Terminal, not retryable. The primary row above always exists for an
        // authenticated requester, but the warehouse copy can be genuinely absent — an
        // account created after the load cutoff, or a gap in the load. No retry makes it
        // appear, so this fails on the first attempt with the real reason instead of
        // spending the queue's retries to arrive at the same place with a generic error.
        //
        // Not silently falling back to the primary values: that would put a
        // current-second name and email beside five sources frozen at the cutoff, which
        // is the inconsistency reading them from the warehouse exists to remove. A user
        // absent from the snapshot has nothing to export from it.
        const profile = profileRows[0];
        if (!profile) {
          throw new TerminalExportError(
            'export_identity_row_missing',
            'Your account was not found in the data snapshot this export reads from. This can happen when the account was created after the snapshot was taken.',
            'Identity row was not present in the export warehouse'
          );
        }

        // The warehouse copy wins for the two fields it carries, so the identity section
        // is as of the same moment as the rest of the export. Field names are unchanged,
        // so this is not a schema version change for consumers.
        const merged: Record<string, unknown> = {
          ...row,
          google_user_email: profile.email,
          google_user_name: profile.name,
        };
        return {
          records: USER_FIELD_MAPPERS.map(([field, mapValue]) => ({
            source: 'kilocode_users',
            field,
            value: mapValue(merged[field]),
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
        return {
          records: rows.map(row => ({
            source: 'app_builder_projects',
            field: 'title',
            value: row.title,
          })),
          nextCursor: nextKeyCursor(rows, input.limit, row => [row.id]),
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
        return {
          records: rows.map(row => ({
            source: 'app_builder_messages',
            id: row.id,
            field: 'data',
            value: jsonValue(row.data),
          })),
          nextCursor: nextKeyCursor(rows, input.limit, row => [row.id]),
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
            session_id: nullableString(row.session_id, 'session_id'),
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
        return {
          records: rows.flatMap(row => {
            // The journal position identifies the row, so records that repeat a
            // value are distinguishable rather than looking like duplication.
            const id = `${row.most_significant_position}.${row.least_significant_position}`;
            return [
              { source: 'cli_sessions', id, field: 'session_id', value: row.session_id },
              { source: 'cli_sessions', id, field: 'title', value: row.title },
              { source: 'cli_sessions', id, field: 'git_url', value: row.git_url },
              { source: 'cli_sessions', id, field: 'git_branch', value: row.git_branch },
            ];
          }),
          nextCursor: nextKeyCursor(rows, input.limit, row => [
            row.most_significant_position,
            row.least_significant_position,
          ]),
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
        return {
          records: rows.map(row => ({
            source: 'system_prompt_prefix',
            field: 'system_prompt_prefix',
            value: row.system_prompt_prefix,
          })),
          nextCursor: nextKeyCursor(rows, input.limit, row => [row.system_prompt_prefix_id]),
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
        return {
          records: rows.map(row => ({
            source: 'microdollar_usage_metadata',
            id: row.id,
            field: 'user_prompt_prefix',
            value: row.user_prompt_prefix,
          })),
          nextCursor: nextKeyCursor(rows, input.limit, row => [row.id]),
        };
      },
    },
  ];
}

/**
 * Owned-row warehouse queries: every one filters on `kilo_user_id = $1`, which
 * excludes NULL-owned (organization) rows by construction. `userQuery` is scoped
 * differently (`id = $1`, the user's own row rather than a row it owns) and is not
 * part of this map.
 */
export const warehouseQueries = {
  projectQuery,
  messageQuery,
  cliSessionQuery,
  systemPromptQuery,
  userPromptQuery,
};

export const sourceQueries = { ...warehouseQueries, userQuery, warehouseProfileQuery };

/**
 * The only predicates that scope a query to a single user. `kilo_user_id = $1` matches
 * rows the user owns; `id = $1` and `user_id = $1` match the user's own profile row on
 * the primary and in the warehouse respectively, which name the same column differently.
 * All three take the authenticated user id as their sole bind parameter, and none can
 * match SQL NULL, which is what keeps org-owned rows out.
 *
 * A closed set rather than a free string: a source scoped some other way cannot
 * declare its own predicate and pass the guard below on a technicality. Widening
 * this list is the deliberate, reviewable act that adding such a source requires.
 */
export const USER_SCOPE_PREDICATES = ['kilo_user_id = $1', 'id = $1', 'user_id = $1'] as const;
export type UserScopePredicate = (typeof USER_SCOPE_PREDICATES)[number];

/**
 * The single-user scoping predicate each query in `sourceQueries` must contain,
 * declared beside the queries themselves rather than left to be inferred from
 * which named export a query happens to live in. A query added to `sourceQueries`
 * without an entry here fails the coverage test below, so a new source can't ship
 * unscoped simply by landing outside `warehouseQueries`.
 */
export const sourceQueryScopes: Record<keyof typeof sourceQueries, UserScopePredicate> = {
  projectQuery: 'kilo_user_id = $1',
  messageQuery: 'kilo_user_id = $1',
  cliSessionQuery: 'kilo_user_id = $1',
  systemPromptQuery: 'kilo_user_id = $1',
  userPromptQuery: 'kilo_user_id = $1',
  userQuery: 'id = $1',
  warehouseProfileQuery: 'user_id = $1',
};
