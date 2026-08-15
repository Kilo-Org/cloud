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
 * `event_type` instead, `users` has no CDC column, and `enrichment_data` and
 * `microdollar_usage_journal` were narrowed on request, dropping the flag with the rest.
 * Naming the column on any of them is a runtime error, so records from those sources are
 * never labelled.
 *
 * The narrowed tables are where the flag was given up rather than never held, and in each
 * case it was separating nothing. `enrichment_data` carried 5 deleted rows against 16,661
 * live. `security_findings` carried none at all. `microdollar_usage_journal` is
 * insert-only — every one of its 158,433,290 rows is an `IncrementalInsertRows` event — so
 * nothing there can be deleted in the first place.
 */
export const DELETED_COLUMN = '_snowflake_deleted';
export const SOURCES_WITHOUT_DELETED_COLUMN = [
  'microdollar_usage_metadata',
  'cli_sessions',
  'users',
  'enrichment_data',
  'microdollar_usage_journal',
  'security_findings',
  'source_embeddings',
] as const;

/**
 * Sources that describe an individual and have no organization reading at all, so an
 * organization export never asks for them.
 *
 * `kilocode_users` is the identity section, which is a person's own profile. It was
 * excluded by a name check in `partitionSources` long before this set existed.
 *
 * `enrichment_data` has no organization column in the warehouse whatsoever: it is what
 * third parties assembled about one person, and there is no organization reading of it to
 * offer. Declared here rather than left to the probe, which would report the table as
 * unavailable on every organization export and make an inapplicable source look like a
 * missing one.
 *
 * `user_auth_provider` is here on exactly the same basis. It records which identity
 * providers one person signed in with; the source table has no organization column, so
 * the probe would call it unavailable on every organization export and misreport an
 * inapplicable source as a missing one.
 */
export const USER_ONLY_SOURCES: ReadonlySet<string> = new Set([
  'kilocode_users',
  'enrichment_data',
  'user_auth_provider',
]);

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
 * A user subject selects everything that individual owns, across their personal
 * workspace and any organization workspace they worked in. An organization subject
 * selects the rows carrying that organization's id, which is its workspace: work its
 * members did there, and never what those same members did in their own personal
 * workspace (`organization_id IS NULL`).
 *
 * The two overlap on work done inside an organization, deliberately. That work is both
 * the organization's and the person's.
 *
 * Membership is not part of the subject. The organization tag is on the row itself, so
 * selection never needs a member list: rows from someone who has since left are still
 * the organization's, and a current member's personal workspace still is not. Membership
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
 * Only email and name are overridden this way, because they are the only two the primary
 * also holds. The warehouse's other columns have no live counterpart and are exported
 * directly, through `WAREHOUSE_ONLY_FIELDS` below.
 */
export const WAREHOUSE_PROFILE_FIELDS = {
  google_user_email: 'email',
  google_user_name: 'name',
} as const;

/**
 * Warehouse columns the export returns as they are, having no equivalent on the primary.
 *
 * Mostly location: the country, city, region and timezone attributed to the person, in
 * two generations. The `posthog_*` set is what was recorded historically; the
 * `current_posthog_*` set is the value as of the snapshot. Both are kept, because the
 * difference between where someone was and where they are is itself information held
 * about them, and collapsing it would be the export deciding what they get to see.
 *
 * `posthog_email`, `posthog_name` and `posthog_hosted_domain` are the analytics copies of
 * their identity, distinct from the account's own. They can disagree with
 * `google_user_email` and `google_user_name`, which is exactly why they are worth
 * returning rather than deduplicating away.
 *
 * These arrived after the identity section first shipped, which is the only reason they
 * were absent. The export already returned `signup_ip` from the primary, so it was
 * handing someone the address they signed up from while withholding the country derived
 * from it.
 */
export const WAREHOUSE_ONLY_FIELDS = [
  'posthog_email',
  'posthog_name',
  'posthog_hosted_domain',
  'posthog_country',
  'posthog_country_name',
  'posthog_city',
  'posthog_region_code',
  'posthog_region_name',
  'posthog_timezone',
  'current_posthog_country',
  'current_posthog_country_name',
  'current_posthog_city',
  'current_posthog_region_code',
  'current_posthog_region_name',
  'current_posthog_timezone',
  'vercel_country',
] as const;

/**
 * The warehouse's copy of those fields. Keyed on `user_id`, which is the warehouse's name
 * for `kilocode_users.id` and the same value the five child tables carry as `kilo_user_id`.
 *
 * The interpolated column list comes from the module constant above, never from caller
 * input, on the same basis as `singleKeyPageQuery` below. The user id is a bind parameter.
 */
const warehouseProfileQuery = `SELECT user_id, ${[
  ...Object.values(WAREHOUSE_PROFILE_FIELDS),
  ...WAREHOUSE_ONLY_FIELDS,
].join(', ')}
FROM users
WHERE user_id = $1
LIMIT 1`;

/**
 * Every warehouse query below is scoped by a single owner column — `kilo_user_id` or
 * `organization_id` — and ordered on the columns its index already covers, so a page is
 * served from the index with no sort step.
 *
 * Where a cursor column is selected through a cast, the ORDER BY names it
 * TABLE-QUALIFIED. That is load-bearing, not style. A bare name in ORDER BY resolves to a
 * matching SELECT-list output column before it resolves to an input column, so
 * `ORDER BY most_significant_position` binds to `most_significant_position::text AS
 * most_significant_position` — the text cast — and not to the bigint column. Two things
 * broke as a result, and both are silent:
 *
 *   - The page was ordered lexicographically while the cursor tuple in the WHERE clause
 *     compared numerically (WHERE cannot see output aliases). A page's last row was
 *     therefore not its numeric maximum, and the next page's `>` skipped whatever the
 *     text order had deferred — the same row loss the composite cursors below exist to
 *     prevent. Verified live: on `system_prompt_prefix`, 263 org-scoped rows sort
 *     differently under the two orderings.
 *   - No btree can serve a text ordering of a bigint column, so every page bitmap-scanned
 *     and sorted the whole owner's rowset. Measured on a 115k-row organization:
 *     116,522 startup cost per page against 0.42 for the qualified form, because nothing
 *     could be returned until all of that owner's rows had been scanned and sorted.
 *
 * A qualified name, or any expression such as the `COALESCE` below, is read as an input
 * reference, which is what both the index and the cursor comparison are built on.
 *
 * Neither predicate matches SQL NULL. That bounds each query to one subject, but the two
 * subjects are deliberately NOT disjoint, and a comment claiming otherwise was wrong.
 *
 * A person works in their personal workspace (`organization_id IS NULL`) and in the
 * workspace of any organization they belong to. `kilo_user_id = $1` returns everything
 * they own across both, which is the intent: their export is their work, wherever they
 * did it. `organization_id = $1` returns the organization's workspace only, so a
 * member's personal workspace never appears in it.
 *
 * A row someone created in an organization's workspace therefore belongs to both
 * exports. That overlap is correct rather than a leak.
 *
 * The warehouse expresses this two ways, and only one of them is exclusive. Measured
 * 2026-08-13, counting rows carrying an organization but no user:
 *
 *     app_builder_projects          2,143    user XOR org
 *     app_builder_messages        266,095    user XOR org
 *     code_indexing_manifest   20,170,449    user XOR org
 *     deployment_events           513,069    user XOR org
 *     platform_integrations         1,862    user XOR org
 *     cli_sessions                      0    both columns set
 *     system_prompt_prefix              0    both columns set
 *     microdollar_usage_metadata        0    both columns set
 *     code_indexing_search              0    both columns set
 *     source_embeddings                 0    both columns set
 *     microdollar_usage_journal         -    not counted
 *     security_findings                 -    user XOR org, by construction
 *
 * `security_findings` earns its XOR from the table rather than from a count: prod carries
 * one partial unique index per owner column, each conditioned on that column being NOT
 * NULL, so `organization_id` is set exactly when `kilo_user_id` is not.
 *
 * `platform_integrations` is the only entry counted from both ends. Measured 2026-08-14
 * across all 38,849 rows: 36,987 user-only, the 1,862 org-only above, and zero rows either
 * carrying both owners or carrying neither. The XOR is exact rather than typical.
 *
 * `microdollar_usage_journal` carries the same owner pair as the other microdollar
 * tables, but the count above was never rerun for it, so it is left blank rather than
 * assumed to be 0. Nothing in the export depends on the answer: both predicates are the
 * standard ones and neither matches NULL, so an unowned row reaches nobody either way.
 * The entry is here so the gap is visible rather than looking like an omission.
 *
 * On the first four, an organization can own a row outright with no user attached, so
 * `kilo_user_id = $1` genuinely skips those. On the other four every row names a user,
 * so an organization-workspace row matches both predicates. Both outcomes are intended;
 * the difference is in what the source model records, not in the export's rules.
 *
 * `enrichment_data` is absent from that table because it has neither reading: the warehouse
 * copy carries no organization column at all, so it is user-only and an organization export
 * never asks for it. See `USER_ONLY_SOURCES`.
 *
 * `code_indexing_search` and `source_embeddings` are the entries whose 0 is a schema
 * guarantee rather than a count: both owner columns are `notNull()` on each table, so no
 * row can carry one without the other. `code_indexing_manifest` sits at the opposite
 * extreme, which is why sources this adjacent are read so differently.
 *
 * `code_indexing_manifest` is the strongest form of the first case, and it qualifies the
 * "everything they own across both" above: indexing under an organization writes
 * `kilo_user_id` as NULL outright, so a person's own export carries their personal
 * indexing only and the organization's export carries the rest. It is also the one table
 * whose `organization_id` is not always an organization — see `codeIndexingQueries`, which
 * is where that column's two readings are set out.
 *
 * The warehouse is itself a point-in-time snapshot, cut at the load cutoff before the
 * export ever reads it, so there is no `snapshot_at` bound to apply here. Only
 * `code_indexing_search` carries a `created_at` at all, and it is exported as a value
 * rather than used as a bound, for that reason.
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
 *
 * The ORDER BY must stay table-qualified: both position columns are selected through a
 * `::text` cast under their own names, so a bare name there sorts the page as text while
 * the cursor above compares as bigint. See the note on `SCOPE_COLUMNS`.
 */
function cliSessionPageQuery(scope: keyof typeof SCOPE_COLUMNS): string {
  return `SELECT session_id, title, git_url, git_branch,
  most_significant_position::text AS most_significant_position,
  least_significant_position::text AS least_significant_position
FROM cli_sessions
WHERE ${SCOPE_COLUMNS[scope]} = $1
  AND ($2::bigint IS NULL
    OR (most_significant_position, least_significant_position) > ($2::bigint, $3::bigint))
ORDER BY cli_sessions.most_significant_position, cli_sessions.least_significant_position
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
 *
 * `system_prompt_prefix_id` is table-qualified in the ORDER BY for the reason recorded on
 * `SCOPE_COLUMNS`: it is selected through a `::text` cast under its own name, and this is
 * the table where the two orderings provably disagree on live data. The `COALESCE` needs
 * no qualifier — an expression is already read as an input reference — and it matches the
 * expression index the warehouse carries for this ordering.
 */
const NULL_CURSOR_SENTINEL = '-';
function systemPromptPageQuery(scope: keyof typeof SCOPE_COLUMNS): string {
  // The dimension the scope does not already pin: scoping by user leaves org varying,
  // and scoping by org leaves user varying.
  const cursorColumn = scope === 'user' ? SCOPE_COLUMNS.organization : SCOPE_COLUMNS.user;
  return `SELECT system_prompt_prefix_id::text AS system_prompt_prefix_id,
  COALESCE(${cursorColumn}, '${NULL_CURSOR_SENTINEL}') AS cursor_secondary,
  system_prompt_prefix, _snowflake_deleted
FROM system_prompt_prefix
WHERE ${SCOPE_COLUMNS[scope]} = $1
  AND ($2::bigint IS NULL
    OR (system_prompt_prefix_id, COALESCE(${cursorColumn}, '${NULL_CURSOR_SENTINEL}')) > ($2::bigint, $3::text))
ORDER BY system_prompt_prefix.system_prompt_prefix_id, COALESCE(${cursorColumn}, '${NULL_CURSOR_SENTINEL}')
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

/**
 * The two owner columns are complementary rather than alternative, and neither is a plain
 * organization tag:
 *
 *   - `kilo_user_id` is set only when the file was indexed in a PERSONAL context, and is
 *     NULL on rows indexed under an organization. It names one person's own work.
 *   - `organization_id` is NOT always an organization. Indexing outside an org falls
 *     through to `getUserUUID(user)` = `uuidv5(user.id, ...)`, so a personal row carries a
 *     uuid DERIVED FROM THE USER. Measured 2026-08-12: 13,010 such ids appear in no
 *     `organizations` row, in strict 1:1 with 13,010 users. A real organization appears
 *     only on rows where `kilo_user_id` is NULL.
 *
 * Each subject is therefore scoped by exactly one of the two columns, and never by both.
 * `kilo_user_id = $1` selects that person's personal indexing. `organization_id = $1` is
 * bound to a real organization id, which no personal row's derived uuid can equal, so
 * personal work cannot reach an organization's export through the column that merely looks
 * like an org tag. Widening either read to reach for both columns is what would break
 * that, which is why this source takes the same single-predicate shape as every other and
 * needs no builder of its own.
 *
 * Rows with both columns NULL are the source's tombstones, every payload column NULL.
 * Neither predicate matches NULL, so scoping alone excludes them and they never reach the
 * file as id-only records. `_snowflake_deleted` is still selected, because the deleted rows
 * that do carry an owner are labelled rather than hidden.
 */
const codeIndexingQueries = subjectPageQueries({
  table: 'code_indexing_manifest',
  columns: 'id, project_id, git_branch, file_path, _snowflake_deleted',
});

/**
 * The sibling of `code_indexing_manifest`, written by the same router, but with the
 * opposite ownership shape. Both owner columns are `notNull()` in `schema.ts`, and the
 * insert at `code-indexing-router.ts` sets `kilo_user_id` to `ctx.user.id` unconditionally,
 * so EVERY row carries both. This is the "both columns set" case, not the XOR one.
 *
 * That makes the two scopes overlap rather than partition, which is the intended reading
 * recorded on `SCOPE_COLUMNS`: `kilo_user_id = $1` returns every search that person ran,
 * in their own workspace and in any organization's, and `organization_id = $1` returns the
 * searches run in that organization by any member. A search run inside an organization
 * belongs to both exports.
 *
 * `organization_id` is still not always an organization. It comes from the same
 * `getCodeIndexOrganizationId` helper as the manifest, which falls through to
 * `getUserUUID(user)` when no org was supplied, so a personal search carries a uuid derived
 * from the user. An organization read binds a real organization id, which no such derived
 * uuid can equal, so personal searches cannot reach an organization's export.
 */
const codeIndexingSearchQueries = subjectPageQueries({
  table: 'code_indexing_search',
  columns: 'id, project_id, query, metadata, created_at, _snowflake_deleted',
});

/**
 * Ownership on this source is resolved upstream, through `deployment_builds` to
 * `deployments`, so the two scope columns are that deployment's owner rather than
 * anything the event itself records. `kilo_user_id` is `deployments.owned_by_user_id`.
 *
 * `created_by_user_id` is a THIRD user column, and it deliberately does not scope
 * anything. It carries provenance only: who pressed the button, as against who owns the
 * result. The warehouse settled that split on two pieces of evidence, both checked
 * 2026-08-11 — `schema.ts` gives `owned_by_user_id` a foreign key to `kilocode_users`
 * while `created_by_user_id` is bare text with none, and `deployments-service.ts` gates
 * every access path on the owner columns and none on the creator.
 *
 * The distinction only bites on organization-owned deployments, which is exactly where
 * the two disagree: 513,069 rows carry an organization and no user, and their creator is
 * a member. Scoping a user export on the creator would hand that member an
 * organization's deployment history as their own personal data. `kilo_user_id = $1`
 * therefore stays the only user predicate, and the creator is exported as a field so the
 * provenance is still visible without ever selecting on it.
 *
 * A further 99,210 rows have neither owner. Both predicates skip them, as with any other
 * unowned row, so they reach nobody.
 *
 * The cursor is the composite `(build_id, event_id)`, prod's primary key, because
 * `event_id` is a per-build sequence number rather than a row identifier and repeats
 * across builds. A cursor on `event_id` alone would skip whole builds.
 *
 * The ORDER BY is table-qualified for the reason recorded on `SCOPE_COLUMNS`, and this is
 * the third table where it matters: `event_id` is a bigint selected through a `::text`
 * cast under its own name, so a bare name there would sort the page as text while the
 * cursor below compares as bigint, and no index could serve it.
 *
 * One known cost, accepted upstream when the load was designed. The warehouse holds 1,255
 * byte-identical duplicate `(build_id, event_id)` pairs among 9,049,083 rows. A keyset
 * cursor can drop one copy of a pair if a page boundary falls exactly between the twins.
 * They carry no information the surviving copy does not.
 */
function deploymentEventPageQuery(scope: keyof typeof SCOPE_COLUMNS): string {
  return `SELECT build_id, event_id::text AS event_id, deployment_id, created_by_user_id,
  event_type, event_timestamp, payload, _snowflake_deleted
FROM deployment_events
WHERE ${SCOPE_COLUMNS[scope]} = $1
  AND ($2::text IS NULL OR (build_id, event_id) > ($2::text, $3::bigint))
ORDER BY deployment_events.build_id, deployment_events.event_id
LIMIT $4`;
}

const deploymentEventQueries: Record<ExportSubject['type'], string> = {
  user: deploymentEventPageQuery('user'),
  organization: deploymentEventPageQuery('organization'),
};

/**
 * The only source with one subject variant rather than two, and the only place in this
 * file where that is not an omission.
 *
 * The warehouse table has no organization column at all. This is what GitHub and Clay
 * assembled ABOUT one person, gathered from outside rather than supplied by them, and
 * `kilo_user_id` is the subject of that enrichment rather than its author. The warehouse
 * settled that on 2026-08-11 from `schema.ts`, where the column is a notNull foreign key
 * to `kilocode_users` and the only user column on the table, and from the sole writer,
 * `admin-router.ts` `enrichmentData.upsert`, which validates it against `kilocode_users`
 * and pointedly does not store the acting admin's id — unlike `user_admin_notes` in the
 * same router, which carries both.
 *
 * So there is no organization query to write, not merely one left unwritten, and
 * `USER_ONLY_SOURCES` keeps organization exports from asking. The warehouse renames the
 * column on the way in: the source calls it `user_id`, and the load aliases it to
 * `kilo_user_id` for the convention every other source here follows.
 *
 * Both payload columns are third-party profile data about a person who did not supply it,
 * which is the strongest case in the whole export for returning something: it is the one
 * category a subject has no other way to see.
 */
const enrichmentQuery = singleKeyPageQuery({
  table: 'enrichment_data',
  columns: 'id, github_enrichment_data, clay_enrichment_data',
  scope: 'user',
});

/**
 * Every exported field of a linked authentication account, in the order the file emits
 * them. One declaration rather than three, on the same principle as
 * `SECURITY_FINDING_FIELDS`: the SELECT list, the probe's column declaration and the
 * emitted records are all derived from this, so a column cannot be selected without also
 * being probed for and emitted.
 *
 * `kilo_user_id` is deliberately absent. It is the scope column, so the subject already
 * implies it, and every other source omits its owner column for the same reason.
 *
 * `provider` and `provider_account_id` lead because they are the key. Both were missing
 * from the projection this source was first specified with, and `provider` is the one
 * that matters most: without it a person with Google and GitHub linked receives two sets
 * of records that are indistinguishable, which is the whole substance of the table.
 * `provider_account_id` is that person's own identifier at Google or GitHub, which is
 * data held about them, so it is returned on the same basis as everything else here.
 */
const USER_AUTH_PROVIDER_FIELDS = [
  'provider',
  'provider_account_id',
  'email',
  'display_name',
  'avatar_url',
  'hosted_domain',
  'created_at',
] as const;

/**
 * Which identity providers a person signed in with, and the profile each one supplied.
 *
 * One row per linked authentication account, NOT one per user: someone with Google and
 * GitHub linked has two. Counted in the loaded warehouse 2026-08-12 at 1,068,683 rows
 * over roughly 1.06M users, about 1.02 each.
 *
 * User only, and it is in `USER_ONLY_SOURCES` rather than left to the probe: the table
 * carries no organization column at all, so there is no organization reading to offer.
 * Attribution is `kilo_user_id`, proven rather than inferred — it is `notNull` in
 * `schema.ts` and the account-deletion transaction erases these rows by it. A row the
 * product destroys with the user is the user's.
 *
 * The cursor is `(provider, provider_account_id)`, prod's primary key and the only unique
 * key this table has. `kilo_user_id` repeats once per linked account, so a cursor on it
 * would skip rows at page boundaries — the defect that shipped twice already, on
 * `cli_sessions.session_id` and again on `system_prompt_prefix`. The warehouse carries
 * `user_auth_provider_user_page (kilo_user_id, provider, provider_account_id)`, so this
 * ordering is served from that index with no sort step.
 *
 * No `COALESCE` sentinel on either cursor column, unlike `system_prompt_prefix`. These
 * two are the only NOT NULL columns on the table, so neither can produce the NULL that
 * makes a tuple comparison yield NULL and silently drop the rows it was meant to keep.
 *
 * Bare names in the ORDER BY are correct here: neither cursor column is selected through
 * a cast, so the output and input references are the same column. See `SCOPE_COLUMNS` for
 * the tables where that is not true and the qualifier is load-bearing.
 */
const userAuthProviderQuery = `SELECT ${USER_AUTH_PROVIDER_FIELDS.join(', ')}, ${DELETED_COLUMN}
FROM user_auth_provider
WHERE ${SCOPE_COLUMNS.user} = $1
  AND ($2::text IS NULL OR (provider, provider_account_id) > ($2::text, $3::text))
ORDER BY provider, provider_account_id
LIMIT $4`;

/**
 * The second journal in the export, and the one place where the cursor is deliberately
 * NOT the column that would work today.
 *
 * `payload_id` is unique across all 158,433,290 rows, measured 2026-08-11. It would serve
 * as a cursor on this data. It is unique by luck rather than by construction: the journal
 * emits only `IncrementalInsertRows`, so nothing produces a second row for an entity. The
 * moment an update event appears, `payload_id` repeats and a cursor built on it starts
 * skipping rows at page boundaries — which is not a hypothetical, it is the defect that
 * shipped on `cli_sessions.session_id` and again on `system_prompt_prefix`.
 *
 * The position pair is unique by construction, so that is the cursor. `payload_id` is
 * exported as a field instead, where its uniqueness does not have to hold.
 *
 * The ORDER BY is table-qualified, the fourth table where that matters and the second where
 * the columns are this exact pair. Both positions are bigints selected through a `::text`
 * cast under their own names, so a bare name there binds to the text output column: the
 * page would sort lexicographically while the cursor compares numerically, and no index
 * could serve it. See the note on `SCOPE_COLUMNS`.
 *
 * Both warehouse indexes are `(owner, most_significant_position,
 * least_significant_position)`, so this ordering is the one they already cover.
 */
function microdollarJournalPageQuery(scope: keyof typeof SCOPE_COLUMNS): string {
  return `SELECT payload_id, project_id,
  most_significant_position::text AS most_significant_position,
  least_significant_position::text AS least_significant_position
FROM microdollar_usage_journal
WHERE ${SCOPE_COLUMNS[scope]} = $1
  AND ($2::bigint IS NULL
    OR (most_significant_position, least_significant_position) > ($2::bigint, $3::bigint))
ORDER BY microdollar_usage_journal.most_significant_position,
  microdollar_usage_journal.least_significant_position
LIMIT $4`;
}

const microdollarJournalQueries: Record<ExportSubject['type'], string> = {
  user: microdollarJournalPageQuery('user'),
  organization: microdollarJournalPageQuery('organization'),
};

/**
 * User or org, never both — `organization_id` is set exactly when `kilo_user_id` is not.
 * That is stated by the table itself rather than inferred: prod carries two partial unique
 * indexes, one per owner column, each with a `WHERE <owner> IS NOT NULL` clause, because
 * the same upstream alert can exist independently for more than one Security Agent owner.
 * Ownership is part of a finding's identity here, not a tag on it.
 *
 * `ignored_by` is the third user column of this batch, after `deployment_events`'
 * `created_by_user_id`, and it behaves the same way: audit trail naming whoever dismissed
 * the finding, never attribution. The access path settles it — every read in
 * `security-agent/db/security-findings.ts` goes through `ownerFindingPredicate()`, which
 * matches the owner columns and nothing else. It is exported as a field and never scoped
 * on.
 *
 * The cursor is `id`, which both warehouse indexes already lead into as `(owner, id)`.
 *
 * Everything the source held is exported except the two owner columns, which the subject
 * already implies. That includes `raw_data`, the unmodified upstream alert. This is the
 * most sensitive source in the export — unpatched vulnerabilities against named private
 * repositories — which is an argument for handling it carefully, not for withholding it
 * from the person whose repositories they are.
 *
 * `severity`, `cve_id` and `ghsa_id` are absent because the load dropped them on request.
 * A finding reads as less than it is without them, and that is a gap in the warehouse
 * rather than a choice made here.
 */
/**
 * Every exported field of a finding, paired with the reader for its column.
 *
 * One declaration rather than three, on the same principle as `WAREHOUSE_PROFILE_FIELDS`:
 * the SELECT list, the probe's column declaration and the emitted records are all derived
 * from this, so a column cannot be selected without being read, declared to the probe, and
 * emitted. At fifteen fields, three hand-maintained lists would drift.
 *
 * Readers are lenient by column type. The text columns take `warehouseText`, the two jsonb
 * payloads `jsonValue`, `cvss_score` `warehouseNumber` because it is `numeric(3,1)`, and
 * `fixed_at` the timestamp reader.
 *
 * `cwe_ids` is `text[]` in prod but reaches the warehouse flattened to a single string, so
 * it is carried verbatim. Splitting it would mean guessing at a serialisation nobody has
 * confirmed, and a wrong guess would quietly corrupt the list.
 */
const SECURITY_FINDING_FIELDS: Record<string, (value: unknown) => string | number | null> = {
  repo_full_name: warehouseText,
  package_name: warehouseText,
  manifest_path: warehouseText,
  title: warehouseText,
  description: warehouseText,
  status: warehouseText,
  ignored_reason: warehouseText,
  ignored_by: warehouseText,
  fixed_at: value => nullableTimestamp(value, 'fixed_at'),
  dependabot_html_url: warehouseText,
  cwe_ids: warehouseText,
  cvss_score: warehouseNumber,
  dependency_scope: warehouseText,
  analysis: jsonValue,
  raw_data: jsonValue,
};

/** The finding's own columns, cursor first. Interpolated from the constant above, never
 * from caller input, on the same basis as `singleKeyPageQuery`. */
const SECURITY_FINDING_COLUMNS = ['id', ...Object.keys(SECURITY_FINDING_FIELDS)];

/**
 * The same three fields as `code_indexing_manifest`, at a finer grain: that source holds
 * one row per indexed file, this one holds a row per indexed CHUNK of a file, so the same
 * path recurs across many rows. They are separate sources rather than merged because the
 * grain is the difference, and collapsing it would misreport how much was indexed.
 *
 * Ownership is the opposite of the manifest's, despite the subject matter being adjacent.
 * Both owner columns are `notNull()` with foreign keys in prod, so every row names both an
 * individual and an organization, putting this in the "both columns set" group with
 * `code_indexing_search`.
 *
 * `kilo_user_id` is the owner, settled on the strongest evidence available for any source
 * here: the account-erasure transaction at `apps/web/src/lib/user/index.ts:1395` deletes
 * these rows by that column when a user is deleted. A row the product destroys with the
 * user is the user's. Confirmed 2026-08-14 that this remains the only reference to the
 * table outside `schema.ts`, so there is no competing read path to weigh against it.
 *
 * `organization_id` is carried for a v2 that does not exist yet and narrows nothing today,
 * since every row has one. It is still the organization scope's predicate, because an
 * organization export asks what its workspace holds rather than what the product reads.
 * The consequence is the overlap `SCOPE_COLUMNS` describes: an organization's export
 * returns rows that are simultaneously some individual's, which is correct rather than a
 * leak. Personal lookups route on `kilo_user_id`, which is the only column that isolates
 * one person.
 *
 * The cursor is `id`, and the warehouse carries an index per scope that leads with the
 * owner and continues into it: `source_embeddings_user_page (kilo_user_id, id)` and
 * `source_embeddings_org_page (organization_id, id) WHERE organization_id IS NOT NULL`.
 * The organization index is partial, which costs this query nothing: `organization_id =
 * $1` cannot match NULL, so no row the index omits was ever in scope.
 *
 * The `embedding` column is not here. The load dropped it — roughly 13.8 KB per row as
 * text, and essentially all of this table's size — so the vectors are unavailable to any
 * consumer. What remains is which files were indexed, on which branch, for which project.
 */
const sourceEmbeddingQueries = subjectPageQueries({
  table: 'source_embeddings',
  columns: 'id, project_id, file_path, git_branch',
});

/**
 * Which source forge a workspace is connected to, under which account, and which
 * repositories that connection reaches.
 *
 * User XOR org, and this one is measured rather than inferred. Counted in Postgres
 * 2026-08-14 across all 38,849 rows: 36,987 name a user and no organization, 1,862 name
 * an organization and no user, and BOTH the both-set and the neither-set counts are zero.
 * No row can reach both exports and none reaches neither.
 *
 * The warehouse aliases the source's `owned_by_user_id` and `owned_by_organization_id` to
 * the repo convention, and the `owned_by_` naming is the same one already settled on
 * `deployment_events` and `security_findings`: it is the owner, as against the
 * `created_by_user_id` this table also carries. That column is not exported and never
 * scopes anything, along with `suspended_by` and `kilo_requester_user_id` — three more
 * user-shaped columns that are audit trail rather than ownership.
 *
 * Deliberately narrow. The table holds 29 columns including installation ids, permission
 * and scope grants, and an auth-invalid reason; the export returns the three that describe
 * the connection as its owner would recognise it. The rest is integration plumbing, and
 * some of it is closer to a credential than to a fact about a person.
 */
const platformIntegrationQueries = subjectPageQueries({
  table: 'platform_integrations',
  columns: 'id, platform, platform_account_login, repositories, _snowflake_deleted',
});

const securityFindingQueries = subjectPageQueries({
  table: 'security_findings',
  columns: SECURITY_FINDING_COLUMNS.join(', '),
});

// Message payloads are whole conversations rather than single fields, so this source
// reads fewer rows per page than the others.
const MESSAGE_PAGE_SIZE = 200;

/**
 * `metadata` carries the whole result set of a search, not a single value, so rows here
 * are large in the same way message payloads are and the page is cut for the same reason.
 */
const SEARCH_PAGE_SIZE = 200;

/** Deployment events carry a payload per event, so the page is cut for the same reason. */
const DEPLOYMENT_EVENT_PAGE_SIZE = 200;

/**
 * A finding carries the whole upstream alert in `raw_data`, plus a description and an
 * analysis blob, and emits fifteen records per row. Cut hardest of the four.
 */
const SECURITY_FINDING_PAGE_SIZE = 100;

type ProjectRow = { id: string; title: string | null; deleted: unknown };
type MessageRow = { id: string; data: unknown; deleted: unknown };
type CliSessionRow = {
  session_id: string | null;
  title: string | null;
  git_url: string | null;
  git_branch: string | null;
  most_significant_position: string;
  least_significant_position: string;
};
type SystemPromptRow = {
  system_prompt_prefix_id: string;
  cursor_secondary: string;
  system_prompt_prefix: string | null;
  deleted: unknown;
};
type UserPromptRow = { id: string; user_prompt_prefix: string | null };
type PlatformIntegrationRow = {
  id: string;
  platform: string | null;
  platform_account_login: string | null;
  repositories: string | null;
  deleted: unknown;
};
type SourceEmbeddingRow = {
  id: string;
  project_id: string | null;
  file_path: string | null;
  git_branch: string | null;
};
type SecurityFindingRow = {
  id: string;
  fields: { field: string; value: string | number | null }[];
};
type MicrodollarJournalRow = {
  payload_id: string | null;
  project_id: string | null;
  most_significant_position: string;
  least_significant_position: string;
};
type EnrichmentRow = {
  id: string;
  github_enrichment_data: string | null;
  clay_enrichment_data: string | null;
};
/**
 * Keyed by the exported field list, so a field added to `USER_AUTH_PROVIDER_FIELDS`
 * without a reader below is a type error rather than an `undefined` in the file.
 */
type UserAuthProviderRow = Record<(typeof USER_AUTH_PROVIDER_FIELDS)[number], string | null> & {
  provider: string;
  provider_account_id: string;
  deleted: unknown;
};
type DeploymentEventRow = {
  build_id: string;
  event_id: string;
  deployment_id: string | null;
  created_by_user_id: string | null;
  event_type: string | null;
  event_timestamp: string | null;
  payload: string | null;
  deleted: unknown;
};
type CodeIndexingSearchRow = {
  id: string;
  project_id: string | null;
  query: string | null;
  metadata: string | null;
  created_at: string | null;
  deleted: unknown;
};
type CodeIndexingRow = {
  id: string;
  project_id: string | null;
  git_branch: string | null;
  file_path: string | null;
  deleted: unknown;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Replica row has invalid ${field}`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

/**
 * A warehouse text column, where anything that is not a string reads as absent.
 *
 * Deliberately more tolerant than `nullableString`, and for the same reason
 * `warehouseProfileValue` is: these columns are unconstrained nullable text, and the
 * warehouse's own load checks count nulls rather than forbidding shapes. A strict mapper
 * throws a plain `Error`, which `handleGenerationFailure` treats as retryable, so a single
 * odd cell would spend the queue's four retries on a value frozen in the snapshot that no
 * retry can change, and then fail the whole export.
 *
 * The strictness is worth keeping on the primary, where the columns are NOT NULL and a
 * type mismatch means the query named the wrong one. Here it protects nothing: the probe
 * already guarantees the column exists, so the only thing left to be strict about is the
 * value, and one unusable value is not worth an export.
 */
function warehouseText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A `numeric` column, read as a number.
 *
 * Both branches are load-bearing rather than defensive. Postgres drivers may hand a
 * `numeric` back as a string, to avoid the precision loss of a float, or as a number if a
 * type parser is registered for the OID. Passing this through `warehouseText` would
 * silently drop the value on whichever of the two the driver did not do.
 *
 * A number rather than the text, because the one column that needs this is a score and a
 * quoted score reads as a label. `numeric(3,1)` has three significant digits, so nothing
 * is lost converting it; a wider numeric would need the string form kept instead.
 *
 * Lenient like `warehouseText`, and for the same reason: an unparseable cell is one bad
 * value, not grounds for failing an export against a frozen snapshot.
 */
function warehouseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
          records: [
            ...USER_FIELD_MAPPERS.map(([field, mapValue]) => ({
              source: 'kilocode_users',
              field,
              value: mapValue(merged[field]),
            })),
            // Emitted under the same section: these describe the same person, and the
            // split between "the primary holds it" and "only the warehouse holds it" is
            // an implementation detail nobody reading their own export should have to
            // reason about. Nullable throughout, so a blank stays a blank rather than
            // failing the export.
            ...WAREHOUSE_ONLY_FIELDS.map(field => ({
              source: 'kilocode_users',
              field,
              value: warehouseText(profile[field]),
            })),
          ],
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
      warehouseTable: 'system_prompt_prefix',
      async readPage(input): Promise<SourcePage> {
        const [afterId, afterSecondary] = keyCursorValues(input.cursor, 2);
        const rows: SystemPromptRow[] = await warehouseQuery(
          systemPromptQueries[input.subject.type],
          [subjectScopeValue(input.subject), afterId, afterSecondary, input.limit]
        ).then(result =>
          result.map(row => ({
            system_prompt_prefix_id: digitString(
              row.system_prompt_prefix_id,
              'system_prompt_prefix_id'
            ),
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
            id: `${row.system_prompt_prefix_id}.${row.cursor_secondary}`,
            field: 'system_prompt_prefix',
            value: row.system_prompt_prefix,
            ...deletionMark(row.deleted),
          })),
          nextCursor: nextKeyCursor(rows, input.limit, row => [
            row.system_prompt_prefix_id,
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
    {
      name: 'code_indexing_manifest',
      warehouseTable: 'code_indexing_manifest',
      async readPage(input): Promise<SourcePage> {
        const [after] = keyCursorValues(input.cursor, 1);
        const rows: CodeIndexingRow[] = await warehouseQuery(
          codeIndexingQueries[input.subject.type],
          [subjectScopeValue(input.subject), after, input.limit]
        ).then(result =>
          result.map(row => ({
            id: requiredString(row.id, 'id'),
            // Nullable through `warehouseText` rather than `nullableString`, though all
            // three are NOT NULL on the primary. The warehouse declares no constraints,
            // and a strict mapper would spend the queue's retries on a value frozen in
            // the snapshot. See the note on `warehouseText`.
            project_id: warehouseText(row.project_id),
            git_branch: warehouseText(row.git_branch),
            file_path: warehouseText(row.file_path),
            deleted: row._snowflake_deleted,
          }))
        );
        return {
          // Three records per manifest row, sharing the row's id, so a file and the
          // branch and project it was indexed under stay groupable. `file_hash`,
          // `chunk_count` and the line counts are deliberately not exported: they
          // describe the index, not the person's work.
          records: rows.flatMap(row => [
            {
              source: 'code_indexing_manifest',
              id: row.id,
              field: 'project_id',
              value: row.project_id,
              ...deletionMark(row.deleted),
            },
            {
              source: 'code_indexing_manifest',
              id: row.id,
              field: 'git_branch',
              value: row.git_branch,
              ...deletionMark(row.deleted),
            },
            {
              source: 'code_indexing_manifest',
              id: row.id,
              field: 'file_path',
              value: row.file_path,
              ...deletionMark(row.deleted),
            },
          ]),
          nextCursor: nextKeyCursor(rows, input.limit, row => [row.id]),
        };
      },
    },
    {
      name: 'code_indexing_search',
      warehouseTable: 'code_indexing_search',
      pageSize: SEARCH_PAGE_SIZE,
      async readPage(input): Promise<SourcePage> {
        const [after] = keyCursorValues(input.cursor, 1);
        const rows: CodeIndexingSearchRow[] = await warehouseQuery(
          codeIndexingSearchQueries[input.subject.type],
          [subjectScopeValue(input.subject), after, input.limit]
        ).then(result =>
          result.map(row => ({
            id: requiredString(row.id, 'id'),
            // Every column here is NOT NULL on the primary, and the warehouse enforces
            // none of that, so each mapper has to tolerate a NULL the source could never
            // produce. What it does NOT have to tolerate is a wrong type: the loaded
            // column types still hold, so only the two text columns can carry something
            // unexpected, and only they need the lenient reader.
            project_id: warehouseText(row.project_id),
            query: warehouseText(row.query),
            // `jsonValue` rather than `warehouseText`: the column is jsonb, so the driver
            // hands back a parsed object rather than text. Same handling as
            // `app_builder_messages.data`, the export's other JSON payload.
            metadata: jsonValue(row.metadata),
            // Tolerates NULL and nothing else, which is all a `timestamptz` column can
            // spring on it.
            created_at: nullableTimestamp(row.created_at, 'created_at'),
            deleted: row._snowflake_deleted,
          }))
        );
        return {
          // Four records per search, sharing the row's id, so the query, the project it
          // ran against, what it returned and when stay groupable as one search.
          records: rows.flatMap(row => [
            {
              source: 'code_indexing_search',
              id: row.id,
              field: 'project_id',
              value: row.project_id,
              ...deletionMark(row.deleted),
            },
            {
              source: 'code_indexing_search',
              id: row.id,
              field: 'query',
              value: row.query,
              ...deletionMark(row.deleted),
            },
            {
              source: 'code_indexing_search',
              id: row.id,
              field: 'metadata',
              value: row.metadata,
              ...deletionMark(row.deleted),
            },
            {
              source: 'code_indexing_search',
              id: row.id,
              field: 'created_at',
              value: row.created_at,
              ...deletionMark(row.deleted),
            },
          ]),
          nextCursor: nextKeyCursor(rows, input.limit, row => [row.id]),
        };
      },
    },
    {
      name: 'deployment_events',
      warehouseTable: 'deployment_events',
      pageSize: DEPLOYMENT_EVENT_PAGE_SIZE,
      async readPage(input): Promise<SourcePage> {
        const [afterBuild, afterEvent] = keyCursorValues(input.cursor, 2);
        const rows: DeploymentEventRow[] = await warehouseQuery(
          deploymentEventQueries[input.subject.type],
          [subjectScopeValue(input.subject), afterBuild, afterEvent, input.limit]
        ).then(result =>
          result.map(row => ({
            // The cursor pair, so both are read strictly: a page that could not say where
            // it ended would silently restart the source rather than continue it.
            build_id: requiredString(row.build_id, 'build_id'),
            event_id: digitString(row.event_id, 'event_id'),
            // Everything below is a LEFT JOIN result or an unconstrained warehouse
            // column, so each is read leniently. See the note on `warehouseText`.
            deployment_id: warehouseText(row.deployment_id),
            created_by_user_id: warehouseText(row.created_by_user_id),
            event_type: warehouseText(row.event_type),
            event_timestamp: nullableTimestamp(row.event_timestamp, 'event_timestamp'),
            payload: jsonValue(row.payload),
            deleted: row._snowflake_deleted,
          }))
        );
        return {
          records: rows.flatMap(row => {
            // `event_id` is unique only within a build, so the pair identifies the event.
            // The same shape `cli_sessions` uses for its journal positions.
            const id = `${row.build_id}.${row.event_id}`;
            const mark = deletionMark(row.deleted);
            return [
              { source: 'deployment_events', id, field: 'build_id', value: row.build_id, ...mark },
              {
                source: 'deployment_events',
                id,
                field: 'deployment_id',
                value: row.deployment_id,
                ...mark,
              },
              // Provenance, never a scope. See the note on `deploymentEventPageQuery`.
              {
                source: 'deployment_events',
                id,
                field: 'created_by_user_id',
                value: row.created_by_user_id,
                ...mark,
              },
              {
                source: 'deployment_events',
                id,
                field: 'event_type',
                value: row.event_type,
                ...mark,
              },
              {
                source: 'deployment_events',
                id,
                field: 'event_timestamp',
                value: row.event_timestamp,
                ...mark,
              },
              { source: 'deployment_events', id, field: 'payload', value: row.payload, ...mark },
            ];
          }),
          nextCursor: nextKeyCursor(rows, input.limit, row => [row.build_id, row.event_id]),
        };
      },
    },
    {
      name: 'source_embeddings',
      warehouseTable: 'source_embeddings',
      async readPage(input): Promise<SourcePage> {
        const [after] = keyCursorValues(input.cursor, 1);
        const rows: SourceEmbeddingRow[] = await warehouseQuery(
          sourceEmbeddingQueries[input.subject.type],
          [subjectScopeValue(input.subject), after, input.limit]
        ).then(result =>
          result.map(row => ({
            id: requiredString(row.id, 'id'),
            project_id: warehouseText(row.project_id),
            file_path: warehouseText(row.file_path),
            git_branch: warehouseText(row.git_branch),
          }))
        );
        return {
          // No deletion mark: the column went with the narrowing to six columns. See
          // `SOURCES_WITHOUT_DELETED_COLUMN`.
          records: rows.flatMap(row => [
            {
              source: 'source_embeddings',
              id: row.id,
              field: 'project_id',
              value: row.project_id,
            },
            {
              source: 'source_embeddings',
              id: row.id,
              field: 'file_path',
              value: row.file_path,
            },
            {
              source: 'source_embeddings',
              id: row.id,
              field: 'git_branch',
              value: row.git_branch,
            },
          ]),
          nextCursor: nextKeyCursor(rows, input.limit, row => [row.id]),
        };
      },
    },
    {
      name: 'security_findings',
      warehouseTable: 'security_findings',
      pageSize: SECURITY_FINDING_PAGE_SIZE,
      async readPage(input): Promise<SourcePage> {
        const [after] = keyCursorValues(input.cursor, 1);
        const rows: SecurityFindingRow[] = await warehouseQuery(
          securityFindingQueries[input.subject.type],
          [subjectScopeValue(input.subject), after, input.limit]
        ).then(result =>
          result.map(row => ({
            id: requiredString(row.id, 'id'),
            fields: Object.entries(SECURITY_FINDING_FIELDS).map(([field, read]) => ({
              field,
              value: read(row[field]),
            })),
          }))
        );
        return {
          // No deletion mark: the column went with the narrowing, and the table carried no
          // deleted rows anyway. See `SOURCES_WITHOUT_DELETED_COLUMN`.
          records: rows.flatMap(row =>
            row.fields.map(({ field, value }) => ({
              source: 'security_findings',
              id: row.id,
              field,
              value,
            }))
          ),
          nextCursor: nextKeyCursor(rows, input.limit, row => [row.id]),
        };
      },
    },
    {
      name: 'platform_integrations',
      warehouseTable: 'platform_integrations',
      async readPage(input): Promise<SourcePage> {
        const [after] = keyCursorValues(input.cursor, 1);
        const rows: PlatformIntegrationRow[] = await warehouseQuery(
          platformIntegrationQueries[input.subject.type],
          [subjectScopeValue(input.subject), after, input.limit]
        ).then(result =>
          result.map(row => ({
            id: requiredString(row.id, 'id'),
            platform: warehouseText(row.platform),
            platform_account_login: warehouseText(row.platform_account_login),
            // jsonb, so the driver returns a parsed value. Serialized whole: which
            // repositories a connection reaches is the substance of it.
            repositories: jsonValue(row.repositories),
            deleted: row._snowflake_deleted,
          }))
        );
        return {
          records: rows.flatMap(row => [
            {
              source: 'platform_integrations',
              id: row.id,
              field: 'platform',
              value: row.platform,
              ...deletionMark(row.deleted),
            },
            {
              source: 'platform_integrations',
              id: row.id,
              field: 'platform_account_login',
              value: row.platform_account_login,
              ...deletionMark(row.deleted),
            },
            {
              source: 'platform_integrations',
              id: row.id,
              field: 'repositories',
              value: row.repositories,
              ...deletionMark(row.deleted),
            },
          ]),
          nextCursor: nextKeyCursor(rows, input.limit, row => [row.id]),
        };
      },
    },
    {
      name: 'microdollar_usage_journal',
      warehouseTable: 'microdollar_usage_journal',
      async readPage(input): Promise<SourcePage> {
        const [afterMost, afterLeast] = keyCursorValues(input.cursor, 2);
        const rows: MicrodollarJournalRow[] = await warehouseQuery(
          microdollarJournalQueries[input.subject.type],
          [subjectScopeValue(input.subject), afterMost, afterLeast, input.limit]
        ).then(result =>
          result.map(row => ({
            payload_id: warehouseText(row.payload_id),
            project_id: warehouseText(row.project_id),
            // The cursor pair, read strictly: a page that could not say where it ended
            // would restart the source rather than continue it.
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
          // No deletion mark: the column went with the narrowing to six columns, so this
          // source cannot say. See `SOURCES_WITHOUT_DELETED_COLUMN`.
          records: rows.flatMap(row => {
            // The position pair identifies the event, not `payload_id`. Same shape as
            // `cli_sessions`, and for the reason set out on the query above.
            const id = `${row.most_significant_position}.${row.least_significant_position}`;
            return [
              {
                source: 'microdollar_usage_journal',
                id,
                field: 'payload_id',
                value: row.payload_id,
              },
              {
                source: 'microdollar_usage_journal',
                id,
                field: 'project_id',
                value: row.project_id,
              },
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
      name: 'enrichment_data',
      warehouseTable: 'enrichment_data',
      async readPage(input): Promise<SourcePage> {
        // Unreachable: `USER_ONLY_SOURCES` drops this source before an organization
        // export reaches a read. Kept as a throw rather than an empty page because the
        // two are not the same statement — an empty page would tell an organization that
        // no enrichment is held, when the truth is that none was asked for.
        if (input.subject.type !== 'user') {
          throw new Error('enrichment_data has no organization scope');
        }
        const [after] = keyCursorValues(input.cursor, 1);
        const rows: EnrichmentRow[] = await warehouseQuery(enrichmentQuery, [
          subjectScopeValue(input.subject),
          after,
          input.limit,
        ]).then(result =>
          result.map(row => ({
            id: requiredString(row.id, 'id'),
            // Both are jsonb, so the driver hands back parsed objects. Serialized whole:
            // a payload assembled about someone by a third party is exactly the thing an
            // export exists to show them, and picking fields out of it would be this
            // service deciding which parts they get to see.
            github_enrichment_data: jsonValue(row.github_enrichment_data),
            clay_enrichment_data: jsonValue(row.clay_enrichment_data),
          }))
        );
        return {
          // No deletion mark anywhere here: the column was dropped when the table was
          // narrowed, so this source cannot say. See `SOURCES_WITHOUT_DELETED_COLUMN`.
          records: rows.flatMap(row => [
            {
              source: 'enrichment_data',
              id: row.id,
              field: 'github_enrichment_data',
              value: row.github_enrichment_data,
            },
            {
              source: 'enrichment_data',
              id: row.id,
              field: 'clay_enrichment_data',
              value: row.clay_enrichment_data,
            },
          ]),
          nextCursor: nextKeyCursor(rows, input.limit, row => [row.id]),
        };
      },
    },
    {
      name: 'user_auth_provider',
      warehouseTable: 'user_auth_provider',
      async readPage(input): Promise<SourcePage> {
        // Unreachable: `USER_ONLY_SOURCES` drops this source before an organization
        // export reaches a read. A throw rather than an empty page, for the same reason
        // `enrichment_data` throws — an empty page would tell an organization that no
        // accounts are linked, when the truth is that the question never applied to it.
        if (input.subject.type !== 'user') {
          throw new Error('user_auth_provider has no organization scope');
        }
        const [afterProvider, afterAccountId] = keyCursorValues(input.cursor, 2);
        const rows: UserAuthProviderRow[] = await warehouseQuery(userAuthProviderQuery, [
          subjectScopeValue(input.subject),
          afterProvider,
          afterAccountId,
          input.limit,
        ]).then(result =>
          result.map(row => ({
            // The cursor pair, read strictly. Both are NOT NULL at the source, and a page
            // that could not say where it ended would restart the source rather than
            // continue it. Same handling as the position pairs on the two journals.
            provider: requiredString(row.provider, 'provider'),
            provider_account_id: requiredString(row.provider_account_id, 'provider_account_id'),
            // Everything else takes the lenient warehouse reader: these columns are
            // nullable and unconstrained here, and one odd cell is not worth failing an
            // export against a frozen snapshot. See `warehouseText`.
            email: warehouseText(row.email),
            display_name: warehouseText(row.display_name),
            avatar_url: warehouseText(row.avatar_url),
            hosted_domain: warehouseText(row.hosted_domain),
            created_at: nullableTimestamp(row.created_at, 'created_at'),
            deleted: row._snowflake_deleted,
          }))
        );
        return {
          records: rows.flatMap(row => {
            // The key pair identifies the linked account, so the records of one account
            // stay groupable and two linked accounts never look like duplication.
            // `AuthProviderId` is a closed set of identifiers none of which contains a
            // dot, so the first one always separates the halves and this cannot be
            // ambiguous the way a free-text pair would be.
            const id = `${row.provider}.${row.provider_account_id}`;
            return USER_AUTH_PROVIDER_FIELDS.map(field => ({
              source: 'user_auth_provider',
              id,
              field,
              value: row[field],
              ...deletionMark(row.deleted),
            }));
          }),
          nextCursor: nextKeyCursor(rows, input.limit, row => [
            row.provider,
            row.provider_account_id,
          ]),
        };
      },
    },
  ];
}

/**
 * Owned-row warehouse queries, both subject variants of each.
 *
 * The user variant filters on `kilo_user_id = $1` and returns everything that person
 * owns, in their personal workspace and in any organization workspace they worked in.
 * It skips rows an organization owns outright with no user attached, which exist on
 * `app_builder_projects`, `app_builder_messages` and `code_indexing_manifest`. On the last
 * of those every organization-scoped row is of that shape, so an organization's indexing
 * reaches only the organization variant.
 *
 * The organization variant filters on `organization_id = $1`, which returns that
 * organization's workspace and never a member's personal workspace, since the predicate
 * cannot match SQL NULL.
 *
 * The two therefore overlap on work done inside an organization, by design. See the note
 * on `SCOPE_COLUMNS` for the measured counts.
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
  codeIndexingUserQuery: codeIndexingQueries.user,
  codeIndexingOrgQuery: codeIndexingQueries.organization,
  codeIndexingSearchUserQuery: codeIndexingSearchQueries.user,
  codeIndexingSearchOrgQuery: codeIndexingSearchQueries.organization,
  deploymentEventUserQuery: deploymentEventQueries.user,
  deploymentEventOrgQuery: deploymentEventQueries.organization,
  // No org counterpart, deliberately. See `enrichmentQuery` and `USER_ONLY_SOURCES`.
  enrichmentUserQuery: enrichmentQuery,
  microdollarJournalUserQuery: microdollarJournalQueries.user,
  microdollarJournalOrgQuery: microdollarJournalQueries.organization,
  securityFindingUserQuery: securityFindingQueries.user,
  securityFindingOrgQuery: securityFindingQueries.organization,
  sourceEmbeddingUserQuery: sourceEmbeddingQueries.user,
  sourceEmbeddingOrgQuery: sourceEmbeddingQueries.organization,
  platformIntegrationUserQuery: platformIntegrationQueries.user,
  platformIntegrationOrgQuery: platformIntegrationQueries.organization,
  // No org counterpart, deliberately. See `userAuthProviderQuery` and `USER_ONLY_SOURCES`.
  userAuthProviderUserQuery: userAuthProviderQuery,
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
  users: ['user_id', ...Object.values(WAREHOUSE_PROFILE_FIELDS), ...WAREHOUSE_ONLY_FIELDS],
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
  // Every column the query reads, and only those. The two owner columns are covered by
  // `sourceQueryScopes` instead, which is what pairs each subject with its predicate.
  code_indexing_manifest: ['id', 'project_id', 'git_branch', 'file_path', DELETED_COLUMN],
  code_indexing_search: ['id', 'project_id', 'query', 'metadata', 'created_at', DELETED_COLUMN],
  // `created_by_user_id` is probed because the query selects it as a field, not because
  // anything scopes on it. The owner columns are covered by `sourceQueryScopes`.
  deployment_events: [
    'build_id',
    'event_id',
    'deployment_id',
    'created_by_user_id',
    'event_type',
    'event_timestamp',
    'payload',
    DELETED_COLUMN,
  ],
  // No deletion column: dropped when the table was narrowed to four columns. The probe
  // must not ask for it, or the table would be called absent on every export.
  enrichment_data: ['id', 'github_enrichment_data', 'clay_enrichment_data'],
  // The position pair is declared because the query orders and pages on it. A column only
  // filtered or ordered on still has to be probed: a table the probe calls present must
  // not then fail at read time on a missing column.
  microdollar_usage_journal: [
    'payload_id',
    'project_id',
    'most_significant_position',
    'least_significant_position',
  ],
  // Derived from the same constant the SELECT list is, so the probe cannot fall behind a
  // column the query started reading. No deletion column: it went with the narrowing.
  security_findings: SECURITY_FINDING_COLUMNS,
  // No deletion column: it went with the narrowing to six columns, along with the
  // `embedding` vector that was almost all of this table's size.
  source_embeddings: ['id', 'project_id', 'file_path', 'git_branch'],
  // Three of the table's 29 columns, plus the cursor and the deletion flag. The rest is
  // integration plumbing the export deliberately leaves behind.
  platform_integrations: [
    'id',
    'platform',
    'platform_account_login',
    'repositories',
    DELETED_COLUMN,
  ],
  // Derived from the same constant the SELECT list is, so the probe cannot fall behind a
  // column the query started reading. The scope column `kilo_user_id` is added per
  // subject below; the cursor pair needs no addition, being two of the fields already.
  user_auth_provider: [...USER_AUTH_PROVIDER_FIELDS, DELETED_COLUMN],
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
 * NULL. That bounds each query to one subject. It does not make the subjects disjoint,
 * and is not meant to: work done in an organization's workspace belongs to both that
 * organization and the person who did it. What the predicates do guarantee is the one
 * direction that matters, that an organization export can never reach a member's
 * personal workspace, since those rows carry no organization. See `SCOPE_COLUMNS`.
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
  codeIndexingUserQuery: 'kilo_user_id = $1',
  codeIndexingOrgQuery: 'organization_id = $1',
  codeIndexingSearchUserQuery: 'kilo_user_id = $1',
  codeIndexingSearchOrgQuery: 'organization_id = $1',
  deploymentEventUserQuery: 'kilo_user_id = $1',
  deploymentEventOrgQuery: 'organization_id = $1',
  enrichmentUserQuery: 'kilo_user_id = $1',
  microdollarJournalUserQuery: 'kilo_user_id = $1',
  microdollarJournalOrgQuery: 'organization_id = $1',
  securityFindingUserQuery: 'kilo_user_id = $1',
  securityFindingOrgQuery: 'organization_id = $1',
  sourceEmbeddingUserQuery: 'kilo_user_id = $1',
  sourceEmbeddingOrgQuery: 'organization_id = $1',
  platformIntegrationUserQuery: 'kilo_user_id = $1',
  platformIntegrationOrgQuery: 'organization_id = $1',
  userAuthProviderUserQuery: 'kilo_user_id = $1',
  userQuery: 'id = $1',
  warehouseProfileQuery: 'user_id = $1',
};
