import { keyCursorValues, type ExportCursor, type KeyCursor } from './contracts';
import { TerminalExportError } from './errors';

export type ExportRecord = {
  source: string;
  field: string;
  value: string | number | boolean | null;
  id?: string;
  /**
   * Present, and always `true`, on a row prod has deleted since the snapshot.
   *
   * The export returns deleted rows rather than hiding them — it is a truthful copy of
   * what the warehouse holds about someone, not a view of what prod still serves — so
   * this labels them instead of filtering them. Only a positive deletion says anything:
   * a live row and a row whose state is unknown both carry no property at all, because
   * the warehouse cannot tell those two apart. See `SOURCES_WITHOUT_DELETED_COLUMN`.
   */
  softDeleted?: true;
};

/**
 * The warehouse is a CDC copy and keeps rows prod has deleted. Tables reloaded after
 * 2026-08-12 carry `_snowflake_deleted` to mark them; the rest cannot say.
 *
 * Listed so the gap is a recorded fact rather than an omission: `microdollar_usage_metadata`
 * was not reloaded (1.14B rows to mark 5,158), `cli_sessions` is a journal carrying
 * `event_type` instead, and `users` has no CDC column. Naming the column on any of them
 * is a runtime error, so records from those sources are never labelled.
 */
export const DELETED_COLUMN = '_snowflake_deleted';
export const SOURCES_WITHOUT_DELETED_COLUMN = [
  'microdollar_usage_metadata',
  'cli_sessions',
  'users',
] as const;

/**
 * `softDeleted: true`, or nothing at all.
 *
 * Only `true` is meaningful. The column is NULL throughout on a table whose reload has
 * not run yet, and NULL means unknown rather than live, so an absent property covers
 * both "not deleted" and "cannot say" — which is the honest reading of the data.
 */
function deletionMark(value: unknown): { softDeleted: true } | Record<string, never> {
  return value === true ? { softDeleted: true } : {};
}
export type SourcePage = { records: ExportRecord[]; nextCursor: ExportCursor | null };

export type ReplicaQuery = (text: string, values: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * Whose data an export contains, which is not the same as who asked for it.
 *
 * A user subject selects the rows that individual owns. An organization subject
 * selects the rows carrying that organization's id — which includes work its members
 * did in the organization's context, and deliberately excludes the personal rows those
 * same members own outside it (`organization_id IS NULL`).
 *
 * Membership is not part of the subject. The organization tag is on the row itself, so
 * selection never needs a member list: rows from someone who has since left are still
 * the organization's, and a current member's personal rows still are not. Membership
 * decides only whether the requester may ask, which is settled before a job is created.
 */
export type ExportSubject =
  | { type: 'user'; kiloUserId: string }
  | { type: 'organization'; organizationId: string };

/** The single bind value that scopes every query for a subject. */
export function subjectScopeValue(subject: ExportSubject): string {
  return subject.type === 'user' ? subject.kiloUserId : subject.organizationId;
}

export type SourceAdapter = {
  name: string;
  disabledReason?: string;
  /**
   * The warehouse table this source reads, checked for existence before the export
   * starts. The warehouse is loaded table by table and the export is released ahead of
   * that, so a source can legitimately name a table that does not exist yet.
   *
   * Distinct from `name`, which is what the export file calls the section. They agree
   * for most sources but not for the identity one, which reads `users`.
   */
  warehouseTable?: string;
  /** Overrides the caller's default page size. Set where rows are large. */
  pageSize?: number;
  readPage?: (input: {
    subject: ExportSubject;
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
 * Export field name to the warehouse column that supplies it, for the profile fields the
 * warehouse carries. Both the SELECT list and the merge below are derived from this, so a
 * field cannot be read from the warehouse without also being applied: adding a column to
 * one and forgetting the other would silently keep serving the live value, which is the
 * inconsistency this whole path exists to remove.
 *
 * Only email and name. The table has geo columns too, but the export has never had a geo
 * section and adding one is not what sourcing identity from the warehouse means.
 */
export const WAREHOUSE_PROFILE_FIELDS = {
  google_user_email: 'email',
  google_user_name: 'name',
} as const;

/**
 * The warehouse's copy of those fields. Keyed on `user_id`, which is the warehouse's name
 * for `kilocode_users.id` and the same value the five child tables carry as `kilo_user_id`.
 *
 * The interpolated column list comes from the module constant above, never from caller
 * input, on the same basis as `singleKeyPageQuery` below. The user id is a bind parameter.
 */
const warehouseProfileQuery = `SELECT user_id, ${Object.values(WAREHOUSE_PROFILE_FIELDS).join(', ')}
FROM users
WHERE user_id = $1
LIMIT 1`;

/**
 * Every warehouse query below is scoped by a single owner column — `kilo_user_id` or
 * `organization_id` — and, with one exception, ordered on the columns its index already
 * covers, so a page is served without a sort step.
 *
 * The exception is `system_prompt_prefix`, whose cursor ends in a `COALESCE` expression
 * that no plain btree index can serve. It sorts within each tie group instead. Tie
 * groups are small, but the trade is deliberate and recorded on that query.
 *
 * Neither predicate matches SQL NULL, and that is what keeps the two subjects apart.
 * `kilo_user_id = $1` skips org-owned rows, which carry a NULL owner. `organization_id
 * = $1` skips every row with no organization, which is precisely a member's personal
 * activity. Each subject sees its own rows and nothing else.
 *
 * The warehouse has no `created_at` on any table and is itself a point-in-time
 * snapshot, so there is no `snapshot_at` bound to apply here.
 */
export const SCOPE_COLUMNS = { user: 'kilo_user_id', organization: 'organization_id' } as const;

/**
 * A keyset page over a table whose own `id` is unique, defined once so a change to the
 * predicate cannot reach some sources and miss others.
 *
 * The cursor column is fixed at `id` rather than parameterised: every source that once
 * needed a different key now has its own builder, because each turned out to need a
 * composite cursor rather than a differently named single one.
 *
 * `table`, `columns` and `scope` are module constants below, never caller input; `scope`
 * in particular is indexed out of `SCOPE_COLUMNS` rather than passed as a string, so no
 * call site can name a column of its own. The subject id and the cursor are always bind
 * parameters, so nothing user-supplied is interpolated.
 */
function singleKeyPageQuery(input: {
  table: string;
  columns: string;
  scope: keyof typeof SCOPE_COLUMNS;
}): string {
  return `SELECT ${input.columns}
FROM ${input.table}
WHERE ${SCOPE_COLUMNS[input.scope]} = $1
  AND ($2::text IS NULL OR id > $2::text)
ORDER BY id
LIMIT $3`;
}

/**
 * Both subject variants of one source, so an adapter picks by subject type rather than
 * branching on a predicate it assembles itself.
 */
function subjectPageQueries(input: {
  table: string;
  columns: string;
}): Record<ExportSubject['type'], string> {
  return {
    user: singleKeyPageQuery({ ...input, scope: 'user' }),
    organization: singleKeyPageQuery({ ...input, scope: 'organization' }),
  };
}

const projectQueries = subjectPageQueries({
  table: 'app_builder_projects',
  columns: 'id, title, _snowflake_deleted',
});

const messageQueries = subjectPageQueries({
  table: 'app_builder_messages',
  columns: 'id, data, _snowflake_deleted',
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
/**
 * The journal positions are cast to text so bigint precision survives JSON, but the
 * output columns are named `cursor_*` rather than reusing the column names.
 *
 * That naming is load-bearing. `ORDER BY <bare identifier>` resolves to an output column
 * in preference to a table column, so aliasing the cast back to `most_significant_position`
 * silently ordered the page lexicographically while the WHERE clause, which cannot see
 * output names, kept comparing the raw bigints. Keyset paging requires those two to
 * agree; when they disagreed the cursor was taken from a row that was not the numerically
 * largest, so later pages both repeated rows and skipped others permanently. Text order
 * diverges wherever digit counts differ, and `least_significant_position` counts up from
 * small numbers.
 *
 * Confirmed on 2026-08-13: the plan showed `Sort Key: ((most_significant_position)::text)`
 * and a Sort node above an index that already covers this ordering exactly.
 */
function cliSessionPageQuery(scope: keyof typeof SCOPE_COLUMNS): string {
  return `SELECT session_id, title, git_url, git_branch,
  most_significant_position::text AS cursor_most,
  least_significant_position::text AS cursor_least
FROM cli_sessions
WHERE ${SCOPE_COLUMNS[scope]} = $1
  AND ($2::bigint IS NULL
    OR (most_significant_position, least_significant_position) > ($2::bigint, $3::bigint))
ORDER BY most_significant_position, least_significant_position
LIMIT $4`;
}

const cliSessionQueries: Record<ExportSubject['type'], string> = {
  user: cliSessionPageQuery('user'),
  organization: cliSessionPageQuery('organization'),
};

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
/**
 * The grain of this table is the triple `(prefix id, user, org)`, not the prefix, so
 * `system_prompt_prefix_id` alone repeats and cannot be the cursor.
 *
 * Measured 2026-08-12: user `05d920e4` carries prefix id 2 twice, once with an
 * organization and once without, and one organization carries prefix id 1 nine times.
 * A single-column cursor pages with `id > $cursor`, so every duplicate that landed on a
 * page boundary was silently dropped — the same defect found in `cli_sessions.session_id`.
 *
 * The remaining dimension of the triple therefore joins the cursor, and which one that
 * is depends on the scope: a user's export varies by organization, an organization's
 * export varies by user.
 *
 * The COALESCE is required, not cosmetic: a user's personal rows carry a NULL
 * organization, and a NULL inside a tuple comparison yields NULL rather than false, so
 * an uncoalesced cursor would drop exactly the rows this exists to keep.
 *
 * `-` rather than `''` as the substitute. Both sort before any id, and the dbt export
 * normalises '' to NULL so neither collides with a real value — but `KeyCursorSchema`
 * requires non-empty strings, and an empty cursor value would be rejected on resume and
 * silently restart the source.
 */
const NULL_CURSOR_SENTINEL = '-';
function systemPromptPageQuery(scope: keyof typeof SCOPE_COLUMNS): string {
  // The dimension the scope does not already pin: scoping by user leaves org varying,
  // and scoping by org leaves user varying.
  const cursorColumn = scope === 'user' ? SCOPE_COLUMNS.organization : SCOPE_COLUMNS.user;
  return `SELECT system_prompt_prefix_id::text AS cursor_id,
  COALESCE(${cursorColumn}, '${NULL_CURSOR_SENTINEL}') AS cursor_secondary,
  system_prompt_prefix, _snowflake_deleted
FROM system_prompt_prefix
WHERE ${SCOPE_COLUMNS[scope]} = $1
  AND ($2::bigint IS NULL
    OR (system_prompt_prefix_id, COALESCE(${cursorColumn}, '${NULL_CURSOR_SENTINEL}')) > ($2::bigint, $3::text))
ORDER BY system_prompt_prefix_id, COALESCE(${cursorColumn}, '${NULL_CURSOR_SENTINEL}')
LIMIT $4`;
}

const systemPromptQueries: Record<ExportSubject['type'], string> = {
  user: systemPromptPageQuery('user'),
  organization: systemPromptPageQuery('organization'),
};

const userPromptQueries = subjectPageQueries({
  table: 'microdollar_usage_metadata',
  columns: 'id, user_prompt_prefix',
});

// Message payloads are whole conversations rather than single fields, so this source
// reads fewer rows per page than the others.
const MESSAGE_PAGE_SIZE = 200;

type ProjectRow = { id: string; title: string | null; deleted: unknown };
type MessageRow = { id: string; data: unknown; deleted: unknown };
type CliSessionRow = {
  session_id: string | null;
  title: string | null;
  git_url: string | null;
  git_branch: string | null;
  cursor_most: string;
  cursor_least: string;
};
type SystemPromptRow = {
  cursor_id: string;
  cursor_secondary: string;
  system_prompt_prefix: string | null;
  deleted: unknown;
};
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

/**
 * Picks the warehouse's copy of a profile field, falling back to the primary's.
 *
 * The warehouse's `users.email` and `users.name` are nullable text with no constraint —
 * the export warehouse declares no keys and its own load checks count nulls rather than
 * forbidding them — while the primary's `google_user_email` and `google_user_name` are
 * NOT NULL. A null or blank warehouse value is therefore a load artifact, not a fact
 * about the user, and the primary value is the true one.
 *
 * Deliberately not passed straight to `requiredString`: that mapper was written for a
 * NOT NULL primary column and throws a plain `Error`, which `handleGenerationFailure`
 * treats as retryable. A null would then spend the queue's four retries on a value
 * frozen in the snapshot that no retry can change — the same waste the missing-row case
 * raises `TerminalExportError` to avoid.
 *
 * Blank counts as absent alongside null: empty string and NULL are not reliably
 * distinguished across this load path, and neither is a usable email or name.
 */
function warehouseProfileValue(warehouseValue: unknown, primaryValue: unknown): unknown {
  if (typeof warehouseValue !== 'string' || warehouseValue.trim() === '') return primaryValue;
  return warehouseValue;
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
      // Reads the warehouse's `users`, not a table of its own name.
      warehouseTable: 'users',
      async readPage(input): Promise<SourcePage> {
        if (input.cursor) return { records: [], nextCursor: null };
        // Identity is a property of a person, and the warehouse holds no organization
        // record at all — it has no `organizations` table, and `users` has no org
        // column. An organization export therefore has no identity section; the
        // organization it belongs to is named in the file header instead.
        if (input.subject.type !== 'user') return { records: [], nextCursor: null };
        const { kiloUserId } = input.subject;
        const [rows, profileRows] = await Promise.all([
          replicaQuery(userQuery, [kiloUserId]),
          warehouseQuery(warehouseProfileQuery, [kiloUserId]),
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
        const merged: Record<string, unknown> = { ...row };
        for (const [exportField, warehouseColumn] of Object.entries(WAREHOUSE_PROFILE_FIELDS)) {
          merged[exportField] = warehouseProfileValue(profile[warehouseColumn], row[exportField]);
        }
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
      warehouseTable: 'app_builder_projects',
      async readPage(input): Promise<SourcePage> {
        const [after] = keyCursorValues(input.cursor, 1);
        const rows: ProjectRow[] = await warehouseQuery(projectQueries[input.subject.type], [
          subjectScopeValue(input.subject),
          after,
          input.limit,
        ]).then(result =>
          result.map(row => ({
            id: requiredString(row.id, 'id'),
            title: nullableString(row.title, 'title'),
            deleted: row._snowflake_deleted,
          }))
        );
        return {
          records: rows.map(row => ({
            source: 'app_builder_projects',
            id: row.id,
            field: 'title',
            value: row.title,
            ...deletionMark(row.deleted),
          })),
          nextCursor: nextKeyCursor(rows, input.limit, row => [row.id]),
        };
      },
    },
    {
      name: 'app_builder_messages',
      warehouseTable: 'app_builder_messages',
      pageSize: MESSAGE_PAGE_SIZE,
      async readPage(input): Promise<SourcePage> {
        const [after] = keyCursorValues(input.cursor, 1);
        const rows: MessageRow[] = await warehouseQuery(messageQueries[input.subject.type], [
          subjectScopeValue(input.subject),
          after,
          input.limit,
        ]).then(result =>
          result.map(row => ({
            id: requiredString(row.id, 'id'),
            data: row.data,
            deleted: row._snowflake_deleted,
          }))
        );
        return {
          records: rows.map(row => ({
            source: 'app_builder_messages',
            id: row.id,
            field: 'data',
            value: jsonValue(row.data),
            ...deletionMark(row.deleted),
          })),
          nextCursor: nextKeyCursor(rows, input.limit, row => [row.id]),
        };
      },
    },
    {
      name: 'cli_sessions',
      warehouseTable: 'cli_sessions',
      async readPage(input): Promise<SourcePage> {
        const [afterMost, afterLeast] = keyCursorValues(input.cursor, 2);
        const rows: CliSessionRow[] = await warehouseQuery(cliSessionQueries[input.subject.type], [
          subjectScopeValue(input.subject),
          afterMost,
          afterLeast,
          input.limit,
        ]).then(result =>
          result.map(row => ({
            session_id: nullableString(row.session_id, 'session_id'),
            title: nullableString(row.title, 'title'),
            git_url: nullableString(row.git_url, 'git_url'),
            git_branch: nullableString(row.git_branch, 'git_branch'),
            cursor_most: digitString(row.cursor_most, 'cursor_most'),
            cursor_least: digitString(row.cursor_least, 'cursor_least'),
          }))
        );
        return {
          records: rows.flatMap(row => {
            // The journal position identifies the row, so records that repeat a
            // value are distinguishable rather than looking like duplication.
            const id = `${row.cursor_most}.${row.cursor_least}`;
            return [
              { source: 'cli_sessions', id, field: 'session_id', value: row.session_id },
              { source: 'cli_sessions', id, field: 'title', value: row.title },
              { source: 'cli_sessions', id, field: 'git_url', value: row.git_url },
              { source: 'cli_sessions', id, field: 'git_branch', value: row.git_branch },
            ];
          }),
          nextCursor: nextKeyCursor(rows, input.limit, row => [row.cursor_most, row.cursor_least]),
        };
      },
    },
    {
      name: 'system_prompt_prefix',
      warehouseTable: 'system_prompt_prefix',
      async readPage(input): Promise<SourcePage> {
        const [afterId, afterSecondary] = keyCursorValues(input.cursor, 2);
        const rows: SystemPromptRow[] = await warehouseQuery(
          systemPromptQueries[input.subject.type],
          [subjectScopeValue(input.subject), afterId, afterSecondary, input.limit]
        ).then(result =>
          result.map(row => ({
            cursor_id: digitString(row.cursor_id, 'cursor_id'),
            // COALESCE in the query means this is '' rather than null on a personal row,
            // so the cursor always has a comparable value to carry forward.
            cursor_secondary: requiredString(row.cursor_secondary, 'cursor_secondary'),
            system_prompt_prefix: nullableString(row.system_prompt_prefix, 'system_prompt_prefix'),
            deleted: row._snowflake_deleted,
          }))
        );
        return {
          records: rows.map(row => ({
            source: 'system_prompt_prefix',
            // The prefix id repeats across the triple, so it cannot identify a row on
            // its own. The pair that orders the page does, and it is what a deletion
            // mark has to hang off to mean anything.
            id: `${row.cursor_id}.${row.cursor_secondary}`,
            field: 'system_prompt_prefix',
            value: row.system_prompt_prefix,
            ...deletionMark(row.deleted),
          })),
          nextCursor: nextKeyCursor(rows, input.limit, row => [
            row.cursor_id,
            row.cursor_secondary,
          ]),
        };
      },
    },
    {
      name: 'microdollar_usage_metadata',
      warehouseTable: 'microdollar_usage_metadata',
      async readPage(input): Promise<SourcePage> {
        const [after] = keyCursorValues(input.cursor, 1);
        const rows: UserPromptRow[] = await warehouseQuery(userPromptQueries[input.subject.type], [
          subjectScopeValue(input.subject),
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
 * Owned-row warehouse queries, both subject variants of each.
 *
 * The user variant filters on `kilo_user_id = $1`, which excludes org-owned rows since
 * those carry a NULL owner. The organization variant filters on `organization_id = $1`,
 * which excludes every row with no organization — a member's personal activity — for
 * the same reason: neither predicate matches SQL NULL.
 *
 * `userQuery` is scoped differently (`id = $1`, the user's own row rather than a row it
 * owns) and is not part of this map.
 */
export const warehouseQueries = {
  projectUserQuery: projectQueries.user,
  projectOrgQuery: projectQueries.organization,
  messageUserQuery: messageQueries.user,
  messageOrgQuery: messageQueries.organization,
  cliSessionUserQuery: cliSessionQueries.user,
  cliSessionOrgQuery: cliSessionQueries.organization,
  systemPromptUserQuery: systemPromptQueries.user,
  systemPromptOrgQuery: systemPromptQueries.organization,
  userPromptUserQuery: userPromptQueries.user,
  userPromptOrgQuery: userPromptQueries.organization,
};

export const sourceQueries = { ...warehouseQueries, userQuery, warehouseProfileQuery };

/**
 * Which of the tables an export wants are actually readable by it.
 *
 * The warehouse is loaded incrementally and the export ships ahead of it, so a source
 * naming a table that has not landed yet is an expected state rather than a fault. Asked
 * once per export, before anything is written, so the header can name what is missing
 * instead of the file simply ending early.
 *
 * Existence of the table is not sufficient. A table can be present from an earlier load
 * and still lack a column a newer query selects — `_snowflake_deleted` arrived table by
 * table, and a source selecting it against a not-yet-reloaded table fails at read time
 * with an undefined-column error rather than being classified unavailable. So this asks
 * about columns, and a source counts as present only when every column it requires is
 * there.
 *
 * Reads `information_schema` rather than probing with a real query: a probe that fails
 * is indistinguishable from a table that exists but is momentarily unreadable, and this
 * has to be a fact about the schema alone.
 */
export const warehouseColumnProbeQuery = `SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = ANY($1::text[])`;

export type WarehouseTableRequirement = { table: string; requiredColumns: readonly string[] };

/**
 * Every warehouse column each source reads, including the ones it only filters or
 * orders on. Declared rather than parsed out of the query text, because the probe has to
 * be exact: a column omitted here is one the export will select from a table it has just
 * declared present.
 *
 * The scope column is deliberately NOT listed here. It is added per subject below,
 * because requiring both would let a table missing `organization_id` be withheld from
 * personal exports too — dropping a section from an export that could have been served
 * perfectly well from `kilo_user_id`.
 *
 * `users` is scoped by `user_id`, which is one of its own columns rather than a scope
 * column, so it takes no addition.
 */
export const WAREHOUSE_SOURCE_COLUMNS: Record<string, readonly string[]> = {
  users: ['user_id', ...Object.values(WAREHOUSE_PROFILE_FIELDS)],
  app_builder_projects: ['id', 'title', DELETED_COLUMN],
  app_builder_messages: ['id', 'data', DELETED_COLUMN],
  cli_sessions: [
    'session_id',
    'title',
    'git_url',
    'git_branch',
    'most_significant_position',
    'least_significant_position',
  ],
  system_prompt_prefix: ['system_prompt_prefix_id', 'system_prompt_prefix', DELETED_COLUMN],
  microdollar_usage_metadata: ['id', 'user_prompt_prefix'],
};

/** Sources filtered by a scope column, as opposed to one of their own keys. */
const SUBJECT_SCOPED_TABLES = new Set(
  Object.keys(WAREHOUSE_SOURCE_COLUMNS).filter(table => table !== 'users')
);

/**
 * The probe input for a set of adapters, for one subject.
 *
 * Subject-dependent because the two scopes read different owner columns, and a table
 * that can serve one is usable for that one even if it cannot serve the other.
 *
 * `system_prompt_prefix` is the exception: its cursor reads the opposite scope column
 * as its second key, so it needs both whichever subject is asking. That does couple the
 * personal export to a column only the organization export filters on — deliberately.
 * The alternative, falling back to a single-column cursor when `organization_id` is
 * absent, would page on a key that repeats and silently skip rows at page boundaries,
 * which is the defect the composite cursor exists to fix. A source correctly reported
 * as unavailable beats a section that quietly omits prompts.
 *
 * Both columns were confirmed present on the warehouse table on 2026-08-12, so this is
 * a guard against regression rather than a live constraint.
 */
export function warehouseRequirements(
  adapters: Pick<SourceAdapter, 'warehouseTable'>[],
  subjectType: ExportSubject['type']
): WarehouseTableRequirement[] {
  return adapters
    .map(adapter => adapter.warehouseTable)
    .filter((table): table is string => table !== undefined)
    .map(table => {
      const declared = WAREHOUSE_SOURCE_COLUMNS[table] ?? [];
      if (!SUBJECT_SCOPED_TABLES.has(table)) return { table, requiredColumns: declared };
      const scopeColumns =
        table === 'system_prompt_prefix'
          ? [SCOPE_COLUMNS.user, SCOPE_COLUMNS.organization]
          : [SCOPE_COLUMNS[subjectType]];
      return { table, requiredColumns: [...scopeColumns, ...declared] };
    });
}

export async function findPresentWarehouseTables(
  warehouseQuery: ReplicaQuery,
  requirements: WarehouseTableRequirement[]
): Promise<Set<string>> {
  if (requirements.length === 0) return new Set();
  const rows = await warehouseQuery(warehouseColumnProbeQuery, [
    requirements.map(requirement => requirement.table),
  ]);
  const columnsByTable = new Map<string, Set<string>>();
  for (const row of rows) {
    const table = requiredString(row.table_name, 'table_name');
    const column = requiredString(row.column_name, 'column_name');
    const columns = columnsByTable.get(table) ?? new Set<string>();
    columns.add(column);
    columnsByTable.set(table, columns);
  }
  return new Set(
    requirements
      .filter(requirement => {
        const columns = columnsByTable.get(requirement.table);
        // No columns at all means the table itself is absent.
        if (!columns) return false;
        return requirement.requiredColumns.every(column => columns.has(column));
      })
      .map(requirement => requirement.table)
  );
}

/**
 * The only predicates that scope a query to a single subject. `kilo_user_id = $1`
 * matches rows one user owns; `organization_id = $1` matches rows one organization
 * owns; `id = $1` and `user_id = $1` match the user's own profile row on the primary
 * and in the warehouse respectively, which name the same column differently.
 *
 * All four take the subject id as their sole bind parameter, and none can match SQL
 * NULL. That is what keeps the two subjects disjoint rather than merely different:
 * a user export cannot reach org-owned rows, and an org export cannot reach the
 * personal rows of its members.
 *
 * A closed set rather than a free string: a source scoped some other way cannot
 * declare its own predicate and pass the guard below on a technicality. Widening
 * this list is the deliberate, reviewable act that adding such a source requires.
 */
export const SCOPE_PREDICATES = [
  'kilo_user_id = $1',
  'organization_id = $1',
  'id = $1',
  'user_id = $1',
] as const;
export type ScopePredicate = (typeof SCOPE_PREDICATES)[number];

/**
 * The single-subject scoping predicate each query in `sourceQueries` must contain,
 * declared beside the queries themselves rather than left to be inferred from
 * which named export a query happens to live in. A query added to `sourceQueries`
 * without an entry here fails the coverage test below, so a new source can't ship
 * unscoped simply by landing outside `warehouseQueries`.
 *
 * Each source appears twice, once per subject, and the two must not agree: a query
 * named `*OrgQuery` scoped on `kilo_user_id` would export the wrong rows to the wrong
 * requester, which is the failure this table is here to make visible.
 */
export const sourceQueryScopes: Record<keyof typeof sourceQueries, ScopePredicate> = {
  projectUserQuery: 'kilo_user_id = $1',
  projectOrgQuery: 'organization_id = $1',
  messageUserQuery: 'kilo_user_id = $1',
  messageOrgQuery: 'organization_id = $1',
  cliSessionUserQuery: 'kilo_user_id = $1',
  cliSessionOrgQuery: 'organization_id = $1',
  systemPromptUserQuery: 'kilo_user_id = $1',
  systemPromptOrgQuery: 'organization_id = $1',
  userPromptUserQuery: 'kilo_user_id = $1',
  userPromptOrgQuery: 'organization_id = $1',
  userQuery: 'id = $1',
  warehouseProfileQuery: 'user_id = $1',
};
