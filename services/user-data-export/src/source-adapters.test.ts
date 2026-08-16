import { describe, expect, it } from 'vitest';
import {
  createSourceAdapters,
  sourceQueries,
  sourceQueryScopes,
  findPresentWarehouseTables,
  warehouseRequirements,
  SCOPE_PREDICATES,
  WAREHOUSE_PROFILE_FIELDS,
  WAREHOUSE_ONLY_FIELDS,
  WAREHOUSE_SOURCE_COLUMNS,
  warehouseQueries,
  type ReplicaQuery,
  type SourceAdapter,
} from './source-adapters';
import { TerminalExportError } from './errors';

type Call = { text: string; values: unknown[] };

function harness(rows: Record<string, unknown>[] = [], profileRows?: Record<string, unknown>[]) {
  const replicaCalls: Call[] = [];
  const warehouseCalls: Call[] = [];
  const replicaQuery: ReplicaQuery = async (text, values) => {
    replicaCalls.push({ text, values });
    return rows;
  };
  const warehouseQuery: ReplicaQuery = async (text, values) => {
    warehouseCalls.push({ text, values });
    // The identity source reads the warehouse for the profile fields only; every other
    // source reads it for its own rows, which is what `rows` stands in for.
    return profileRows ?? rows;
  };
  return {
    replicaCalls,
    warehouseCalls,
    adapters: createSourceAdapters({ replicaQuery, warehouseQuery }),
  };
}

function requireAdapter(adapters: SourceAdapter[], name: string): SourceAdapter {
  const adapter = adapters.find(candidate => candidate.name === name);
  if (!adapter) throw new Error(`Missing test adapter: ${name}`);
  return adapter;
}

/** A full `kilocode_users` row, as the primary returns it. */
const PRIMARY_USER_ROW = {
  id: 'user-1',
  google_user_email: 'live@example.com',
  google_user_name: 'Live Name',
  google_user_image_url: '',
  created_at: '2026-02-16T19:11:40.809Z',
  updated_at: '2026-08-07T02:25:54.919Z',
  hosted_domain: null,
  microdollars_used: 1,
  total_microdollars_acquired: 2,
  next_credit_expiration_at: null,
  auto_top_up_enabled: false,
  default_model: null,
  completed_welcome_form: true,
  linkedin_url: null,
  github_url: null,
  discord_server_membership_verified_at: null,
  openrouter_upstream_safety_identifier: null,
  openrouter_downstream_safety_identifier: null,
  vercel_downstream_safety_identifier: null,
  customer_source: null,
  signup_ip: null,
  normalized_email: null,
  email_domain: null,
};

/**
 * A warehouse `users` row. The warehouse-only columns default to null, which is what the
 * real table holds for most people, and the mapper is strict about their presence: the
 * probe guarantees the SELECT can name them, so an absent key is a fixture error rather
 * than a state production can reach.
 */
function warehouseUserRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'user-1',
    email: 'warehouse@example.com',
    name: 'Warehouse Name',
    ...Object.fromEntries(WAREHOUSE_ONLY_FIELDS.map(field => [field, null])),
    ...overrides,
  };
}

const READ_PAGE_INPUT = {
  subject: { type: 'user', kiloUserId: 'owner-user' },
  snapshotAt: '2026-08-08T13:00:00.000Z',
  cursor: null,
  limit: 100,
} as const satisfies Parameters<NonNullable<SourceAdapter['readPage']>>[0];

const ORG_READ_PAGE_INPUT = {
  subject: { type: 'organization', organizationId: 'org-1' },
  snapshotAt: '2026-08-08T13:00:00.000Z',
  cursor: null,
  limit: 100,
} as const satisfies Parameters<NonNullable<SourceAdapter['readPage']>>[0];

describe('warehouse scoping guard', () => {
  // Every query the export reads must restrict to a single user, and the predicate
  // that does so is declared beside the query in `sourceQueryScopes`. This test
  // covers every entry of `sourceQueries`, not a hand-picked subset, so a source
  // added to `sourceQueries` without a scope in `sourceQueryScopes` fails here
  // rather than shipping with no structural guard at all.
  it('declares a scope for every source query and nothing extra', () => {
    expect(Object.keys(sourceQueryScopes).sort()).toEqual(Object.keys(sourceQueries).sort());
  });

  // A declared scope is only worth checking against if the predicate itself scopes to
  // a subject. Without this, a source could be added with any predicate its author cared
  // to name and satisfy the assertion below by agreeing with itself.
  it.each(Object.entries(sourceQueryScopes))('%s declares a known scope', (_name, scope) => {
    expect(SCOPE_PREDICATES).toContain(scope);
  });

  // Membership in the closed set is not enough on its own: the four predicates are not
  // interchangeable, and each is valid for exactly one table shape. A profile predicate
  // used on an owned child table would match the row's own key rather than its owner,
  // and the two profile predicates are not swappable either — the primary calls this
  // column `id` and the warehouse calls it `user_id`, which is the mismatch that shipped
  // broken. Pinned on the query text rather than the export's name.
  const TABLE_FOR_PREDICATE = {
    'id = $1': /FROM kilocode_users\b/,
    'user_id = $1': /FROM users\b/,
  } as const;

  it.each(Object.entries(sourceQueries))('%s pairs its predicate with its table', (name, query) => {
    const predicate = sourceQueryScopes[name as keyof typeof sourceQueries];
    const expectedTable = TABLE_FOR_PREDICATE[predicate as keyof typeof TABLE_FOR_PREDICATE];
    if (expectedTable) {
      expect(query).toMatch(expectedTable);
    } else {
      expect(['kilo_user_id = $1', 'organization_id = $1']).toContain(predicate);
    }
  });

  // The two subject variants of a source are the same query but for the owner column,
  // so a copy-paste that left an org query scoped on `kilo_user_id` would still pass
  // every assertion above: it is a known predicate, on the right table, in the WHERE
  // clause. It would also hand an organization's admin the requester's own rows. The
  // name of the query is the only thing that says which subject it is for, so that is
  // what this pins it to.
  it.each(Object.entries(sourceQueryScopes))(
    '%s scopes on the owner column its name claims',
    (name, scope) => {
      if (name.endsWith('OrgQuery')) expect(scope).toBe('organization_id = $1');
      if (name.endsWith('UserQuery')) expect(scope).toBe('kilo_user_id = $1');
    }
  );

  // Anchored on WHERE because `id = $1` is a substring of every `<table>_id = $1`:
  // an unanchored match would accept `organization_id = $1` as if it scoped to a user.
  it.each(Object.entries(sourceQueries))('%s is scoped to a single subject', (name, query) => {
    const predicate = sourceQueryScopes[name as keyof typeof sourceQueries];
    expect(predicate).toBeDefined();
    expect(query).toContain(`WHERE ${predicate}`);
  });

  // Both subjects are covered for every warehouse source. A source reachable by only one
  // of them would silently return nothing to the other rather than failing.
  //
  // Four declared exceptions, and they have to be declared rather than inferred: an
  // unpaired query is normally the bug this test exists to catch. None of these four has
  // an organization reading to pair with, and `USER_ONLY_SOURCES` keeps organization
  // exports from asking. Naming them here means a source that loses its org variant by
  // accident still fails.
  const USER_ONLY_QUERY_NAMES = [
    'enrichmentUserQuery',
    'audienceUserQuery',
    'userAuthProviderUserQuery',
    'orbCustomerUserQuery',
  ];
  it('pairs every warehouse source with both subject variants', () => {
    const names = Object.keys(warehouseQueries).filter(
      name => !USER_ONLY_QUERY_NAMES.includes(name)
    );
    const orgNames = names.filter(name => name.endsWith('OrgQuery'));
    const userNames = names.filter(name => name.endsWith('UserQuery'));
    expect(orgNames.length).toBe(userNames.length);
    expect(orgNames.map(name => name.replace(/OrgQuery$/, '')).sort()).toEqual(
      userNames.map(name => name.replace(/UserQuery$/, '')).sort()
    );
  });

  // An organization export must never widen to a member's personal rows, which are
  // exactly the rows with no organization. A predicate that tolerated NULL would do so.
  it.each(Object.entries(sourceQueries).filter(([name]) => name.endsWith('OrgQuery')))(
    '%s never admits rows without an organization',
    (_name, query) => {
      expect(query).not.toMatch(/organization_id\s+IS\s+NULL/i);
      expect(query).not.toMatch(/COALESCE\s*\(\s*organization_id/i);
    }
  );

  it.each(Object.entries(warehouseQueries))('%s orders and limits its page', (_name, query) => {
    expect(query).toContain('ORDER BY');
    expect(query).toContain('LIMIT');
  });

  // A cursor column selected through a cast under its own name shadows the column it
  // came from: a bare name in ORDER BY resolves to the output column first, so the page
  // is ordered by the cast while the cursor in the WHERE clause — which cannot see output
  // aliases — still compares the underlying column. The page's last row is then not its
  // cursor maximum and the next page skips rows, and no index can serve the ordering, so
  // every page sorts the whole owner's rowset instead of reading one page from the index.
  //
  // Neither failure raises anything: the export is short some rows and slow. Nothing else
  // in this file can catch it, because the query text is valid and the scope is correct,
  // so it is pinned here as a rule about the whole set rather than about the two queries
  // that had it. Qualifying the name, or ordering on an expression, resolves to the input
  // column and satisfies this.
  it.each(Object.entries(sourceQueries))(
    '%s never orders on a name a cast has shadowed',
    (_name, query) => {
      const shadowed = [...query.matchAll(/(\w+)::\w+\s+AS\s+\1\b/gi)].map(match => match[1]);
      const orderBy = /ORDER BY([\s\S]*?)(?:\nLIMIT|$)/i.exec(query)?.[1] ?? '';
      for (const column of shadowed) {
        // Not preceded by a dot: `cli_sessions.most_significant_position` is an input
        // reference, the bare name is the shadowing output column.
        expect(orderBy).not.toMatch(new RegExp(`(^|[\\s,(])${column}\\b`));
      }
    }
  );

  // The probe is only as good as what it asks about. A column selected by a query but
  // absent from the declaration would be read from a table the probe just called ready.
  //
  // Plain column names only. A cast, an alias or a COALESCE is skipped rather than parsed:
  // this exists to catch a column quietly added to a SELECT list, and a half-built SQL
  // parser failing on the composite cursors would cost more than it caught. The scope
  // columns are excluded because `warehouseRequirements` adds those itself, per subject.
  const SCOPE_COLUMN_NAMES = ['kilo_user_id', 'organization_id'];
  function plainSelectedColumns(query: string): string[] {
    const body = query.slice('SELECT '.length, query.indexOf('\nFROM'));
    return body
      .split(',')
      .map(part => part.trim())
      .filter(part => /^[a-z_][a-z0-9_]*$/.test(part))
      .filter(part => !SCOPE_COLUMN_NAMES.includes(part));
  }

  it.each(Object.entries(WAREHOUSE_SOURCE_COLUMNS))(
    '%s declares every column its queries select',
    (table, declared) => {
      const queries = Object.entries(sourceQueries)
        .filter(([, query]) => new RegExp(`FROM ${table}\\b`).test(query))
        .map(([, query]) => query);
      expect(queries.length).toBeGreaterThan(0);
      for (const query of queries) {
        for (const column of plainSelectedColumns(query)) {
          expect(declared).toContain(column);
        }
      }
    }
  );

  // The column the export used to label deleted rows with. Rows prod has deleted are still
  // returned; nothing in the file says which they are, and no query reads the column that
  // would say. Asserted across every query so it cannot return one source at a time.
  it.each(Object.entries(sourceQueries))('%s never selects the deletion column', (_name, query) => {
    expect(query).not.toContain('_snowflake_deleted');
  });
});

describe('warehouse availability probe', () => {
  function probeHarness(schema: Record<string, string[]>) {
    const calls: Call[] = [];
    const warehouseQuery: ReplicaQuery = async (text, values) => {
      calls.push({ text, values });
      return Object.entries(schema).flatMap(([table, columns]) =>
        columns.map(column => ({ table_name: table, column_name: column }))
      );
    };
    return { calls, warehouseQuery };
  }

  it('accepts a table carrying every column its source needs', async () => {
    const { warehouseQuery } = probeHarness({ audiences: ['kilo_user_id', 'segment'] });

    const present = await findPresentWarehouseTables(warehouseQuery, [
      { table: 'audiences', requiredColumns: ['kilo_user_id', 'segment'] },
    ]);

    expect([...present]).toEqual(['audiences']);
  });

  // The case table-existence probing missed: loaded earlier, not yet reloaded with the
  // column a newer query selects. Without this it fails at read time instead.
  it('rejects a table that exists but lacks a required column', async () => {
    const { warehouseQuery } = probeHarness({ audiences: ['kilo_user_id'] });

    const present = await findPresentWarehouseTables(warehouseQuery, [
      { table: 'audiences', requiredColumns: ['kilo_user_id', 'segment'] },
    ]);

    expect([...present]).toEqual([]);
  });

  it('rejects a table that is not there at all', async () => {
    const { warehouseQuery } = probeHarness({});

    const present = await findPresentWarehouseTables(warehouseQuery, [
      { table: 'audiences', requiredColumns: ['kilo_user_id'] },
    ]);

    expect([...present]).toEqual([]);
  });

  // A personal export filters on kilo_user_id and never touches organization_id, so a
  // table whose org column has not landed yet is still perfectly serviceable to it.
  // Requiring both would withhold a section from an export that could have been served.
  it('requires only the scope column the subject actually filters on', () => {
    const { adapters } = harness();
    const requirementFor = (subject: 'user' | 'organization', table: string) =>
      warehouseRequirements(adapters, subject).find(item => item.table === table)
        ?.requiredColumns ?? [];

    expect(requirementFor('user', 'app_builder_projects')).toContain('kilo_user_id');
    expect(requirementFor('user', 'app_builder_projects')).not.toContain('organization_id');
    expect(requirementFor('organization', 'app_builder_projects')).toContain('organization_id');
    expect(requirementFor('organization', 'app_builder_projects')).not.toContain('kilo_user_id');
  });

  // The exception: this source's cursor reads the opposite scope column as its second
  // key, so it genuinely needs both whichever subject is asking.
  it('requires both scope columns for the source whose cursor spans them', () => {
    const { adapters } = harness();
    for (const subject of ['user', 'organization'] as const) {
      const columns =
        warehouseRequirements(adapters, subject).find(item => item.table === 'system_prompt_prefix')
          ?.requiredColumns ?? [];
      expect(columns).toContain('kilo_user_id');
      expect(columns).toContain('organization_id');
    }
  });

  it('asks about every table the adapters read, in one query', async () => {
    const { calls, warehouseQuery } = probeHarness({});
    const { adapters } = harness();

    await findPresentWarehouseTables(warehouseQuery, warehouseRequirements(adapters, 'user'));

    expect(calls).toHaveLength(1);
    expect(calls[0].values[0]).toEqual([
      'users',
      'app_builder_projects',
      'app_builder_messages',
      'cli_sessions',
      'cloud_agent_code_reviews',
      'system_prompt_prefix',
      'microdollar_usage_metadata',
      'code_indexing_manifest',
      'code_indexing_search',
      'deployment_events',
      'source_embeddings',
      'security_findings',
      'usage_daily',
      'microdollar_usage_hourly',
      'external_usage_daily',
      'platform_integrations',
      'microdollar_usage_journal',
      'orb_customer',
      'int_microdollar_usage_enriched',
      'audiences',
      'enrichment_data',
      'user_auth_provider',
    ]);
  });

  it('never joins the warehouse to the live primary or reads loader bookkeeping', () => {
    for (const query of Object.values(warehouseQueries)) {
      expect(query).not.toContain('kilocode_users');
      expect(query).not.toContain('load_manifest');
    }
    expect(sourceQueries.warehouseProfileQuery).not.toContain('kilocode_users');
    expect(sourceQueries.warehouseProfileQuery).not.toContain('load_manifest');
  });

  it('reads the primary profile columns from the primary', () => {
    expect(sourceQueries.userQuery).toContain('FROM kilocode_users');
    expect(sourceQueries.userQuery).toContain('WHERE id = $1');
  });

  // The warehouse names this column `user_id`; the primary names the same value `id`.
  // Selecting `id` here is what shipped broken, so the column names are pinned.
  it('reads the warehouse profile fields by the warehouse column names', () => {
    expect(sourceQueries.warehouseProfileQuery).toMatch(/FROM users\b/);
    expect(sourceQueries.warehouseProfileQuery).toContain('WHERE user_id = $1');
    // Exact, not toContain: a column appended to the SELECT list without a matching entry
    // in WAREHOUSE_PROFILE_FIELDS would be read from the warehouse and then quietly
    // discarded in favour of the live value, which is the bug this path exists to remove.
    const selected = sourceQueries.warehouseProfileQuery
      .slice('SELECT '.length, sourceQueries.warehouseProfileQuery.indexOf('\nFROM'))
      .split(', ');
    expect(selected).toEqual([
      'user_id',
      ...Object.values(WAREHOUSE_PROFILE_FIELDS),
      ...WAREHOUSE_ONLY_FIELDS,
    ]);
    // Columns the warehouse does not have. Selecting any of them fails at runtime.
    for (const absent of ['google_user_email', 'google_user_name', 'created_at', 'signup_ip']) {
      expect(sourceQueries.warehouseProfileQuery).not.toContain(absent);
    }
  });
});

describe('source adapters', () => {
  it('exposes every source with a reader and no disabled stubs', () => {
    const { adapters } = harness();
    expect(adapters.filter(adapter => !adapter.readPage)).toEqual([]);
    expect(adapters.map(adapter => adapter.name)).toEqual([
      'kilocode_users',
      'app_builder_projects',
      'app_builder_messages',
      'cli_sessions',
      'cloud_agent_code_reviews',
      'system_prompt_prefix',
      'microdollar_usage_metadata',
      'code_indexing_manifest',
      'code_indexing_search',
      'deployment_events',
      'source_embeddings',
      'security_findings',
      'usage_daily',
      'microdollar_usage_hourly',
      'external_usage_daily',
      'platform_integrations',
      'microdollar_usage_journal',
      'orb_customer',
      'int_microdollar_usage_enriched',
      'audiences',
      'enrichment_data',
      'user_auth_provider',
    ]);
  });

  it('keeps persisted adapter names unique', () => {
    const names = harness().adapters.map(adapter => adapter.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('reads each identity field from the database that has it', async () => {
    const { adapters, replicaCalls, warehouseCalls } = harness(
      [PRIMARY_USER_ROW],
      [warehouseUserRow()]
    );

    await requireAdapter(adapters, 'kilocode_users').readPage?.(READ_PAGE_INPUT);

    expect(replicaCalls).toEqual([
      { text: expect.stringContaining('FROM kilocode_users'), values: ['owner-user'] },
    ]);
    expect(warehouseCalls).toEqual([
      { text: expect.stringContaining('WHERE user_id = $1'), values: ['owner-user'] },
    ]);
  });

  // The warehouse holds location and analytics-identity columns with no counterpart on
  // the primary. They were absent only because they arrived after the identity section
  // shipped, which left the export returning someone's signup IP while withholding the
  // country derived from it.
  it('returns the warehouse columns the primary does not hold', async () => {
    const { adapters } = harness(
      [PRIMARY_USER_ROW],
      [
        warehouseUserRow({
          posthog_city: 'Amsterdam',
          posthog_country_name: 'Netherlands',
          current_posthog_city: 'Rotterdam',
          posthog_email: 'analytics@example.com',
        }),
      ]
    );

    const page = await requireAdapter(adapters, 'kilocode_users').readPage?.(READ_PAGE_INPUT);
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    // Every declared column reaches the file, not just the ones this fixture populates.
    for (const field of WAREHOUSE_ONLY_FIELDS) expect(byField.has(field)).toBe(true);
    expect(byField.get('posthog_city')).toBe('Amsterdam');
    expect(byField.get('current_posthog_city')).toBe('Rotterdam');
    // Both generations are kept: where someone was and where they are are different facts.
    expect(byField.get('posthog_country_name')).toBe('Netherlands');
    // The analytics copy of identity is distinct from the account's own and is not
    // collapsed into it.
    expect(byField.get('posthog_email')).toBe('analytics@example.com');
    expect(byField.get('google_user_email')).toBe('warehouse@example.com');
    // A blank stays a blank rather than failing the export.
    expect(byField.get('vercel_country')).toBeNull();
  });

  // These columns are unconstrained nullable text and the warehouse's load checks count
  // nulls rather than forbidding shapes, which is why the email and name path already
  // tolerates non-strings. A strict mapper here throws a plain Error, which the queue
  // treats as retryable, so one odd cell would burn four retries on a value frozen in the
  // snapshot and then fail the whole export.
  it.each([42, true, {}, [], undefined])(
    'reads a non-string warehouse value as absent rather than failing the export (%p)',
    async bad => {
      const { adapters } = harness(
        [PRIMARY_USER_ROW],
        [warehouseUserRow({ posthog_city: bad, posthog_country: 'NL' })]
      );

      const page = await requireAdapter(adapters, 'kilocode_users').readPage?.(READ_PAGE_INPUT);
      const byField = new Map(page?.records.map(record => [record.field, record.value]));

      expect(byField.get('posthog_city')).toBeNull();
      // The rest of the row still comes through.
      expect(byField.get('posthog_country')).toBe('NL');
    }
  );

  // The point of the change: the two fields the warehouse carries are reported as of the
  // snapshot, so a name or email changed after the cutoff does not appear beside five
  // sources frozen before it.
  it('prefers the warehouse copy of email and name over the live values', async () => {
    const { adapters } = harness([PRIMARY_USER_ROW], [warehouseUserRow()]);

    const page = await requireAdapter(adapters, 'kilocode_users').readPage?.(READ_PAGE_INPUT);
    const value = (field: string) => page?.records.find(record => record.field === field)?.value;

    expect(value('google_user_email')).toBe('warehouse@example.com');
    expect(value('google_user_name')).toBe('Warehouse Name');
    // Everything the warehouse does not carry still comes from the primary row.
    expect(value('microdollars_used')).toBe(1);
    expect(value('created_at')).toBe('2026-02-16T19:11:40.809Z');
  });

  // The warehouse columns are nullable text with no constraint, while the primary's are
  // NOT NULL. Feeding a null into requiredString would throw a plain Error, which is
  // retryable, so the export would burn its retries on a value the snapshot has frozen.
  it.each([
    ['null', null],
    ['blank', '   '],
    ['a non-string', 42],
  ])('falls back to the live value when the warehouse email is %s', async (_label, bad) => {
    const { adapters } = harness([PRIMARY_USER_ROW], [warehouseUserRow({ email: bad, name: bad })]);

    const page = await requireAdapter(adapters, 'kilocode_users').readPage?.(READ_PAGE_INPUT);
    const value = (field: string) => page?.records.find(record => record.field === field)?.value;

    expect(value('google_user_email')).toBe('live@example.com');
    expect(value('google_user_name')).toBe('Live Name');
  });

  // A row absent from the warehouse is permanent for the life of a snapshot, so this
  // must fail on the first attempt rather than consume the queue's retries. Asserted on
  // the class because that is what `handleGenerationFailure` branches on to mark the
  // export failed instead of releasing it for retry.
  it('fails terminally when the warehouse holds no profile row', async () => {
    const { adapters } = harness([PRIMARY_USER_ROW], []);

    await expect(
      requireAdapter(adapters, 'kilocode_users').readPage?.(READ_PAGE_INPUT)
    ).rejects.toBeInstanceOf(TerminalExportError);
  });

  it('reports a missing identity row with a code and a message fit to show the requester', async () => {
    const { adapters } = harness([PRIMARY_USER_ROW], []);

    const error = await requireAdapter(adapters, 'kilocode_users')
      .readPage?.(READ_PAGE_INPUT)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TerminalExportError);
    const terminal = error as TerminalExportError;
    expect(terminal.failureCode).toBe('export_identity_row_missing');
    expect(terminal.redactedMessage).toContain('not found in the data snapshot');
    // The requester's id identifies a person and is carried on the log event already.
    expect(terminal.message).not.toContain(READ_PAGE_INPUT.subject.kiloUserId);
    expect(terminal.redactedMessage).not.toContain(READ_PAGE_INPUT.subject.kiloUserId);
  });

  it('passes the authenticated user to the warehouse and maps project titles', async () => {
    const { adapters, warehouseCalls } = harness([{ id: 'project-1', title: 'Owned project' }]);

    const page = await requireAdapter(adapters, 'app_builder_projects').readPage?.(READ_PAGE_INPUT);

    expect(warehouseCalls).toEqual([
      {
        text: expect.stringContaining('kilo_user_id = $1'),
        values: ['owner-user', null, 100],
      },
    ]);
    expect(page?.records).toEqual([
      { source: 'app_builder_projects', id: 'project-1', field: 'title', value: 'Owned project' },
    ]);
  });

  // Every warehouse source has to switch owner column with the subject. One left on
  // `kilo_user_id` would return the requesting admin's own rows under the
  // organization's name, which is the failure that has no visible symptom.
  it.each([
    'app_builder_projects',
    'app_builder_messages',
    'cli_sessions',
    'system_prompt_prefix',
    'microdollar_usage_metadata',
  ])('scopes %s to the organization for an organization subject', async name => {
    const { adapters, warehouseCalls } = harness([]);

    await requireAdapter(adapters, name).readPage?.(ORG_READ_PAGE_INPUT);

    expect(warehouseCalls).toHaveLength(1);
    expect(warehouseCalls[0].text).toContain('WHERE organization_id = $1');
    // Anchored on WHERE rather than the bare column name: `system_prompt_prefix` reads
    // `kilo_user_id` legitimately, as the second half of its cursor. What must not
    // appear is the user column as the row filter.
    expect(warehouseCalls[0].text).not.toContain('WHERE kilo_user_id');
    expect(warehouseCalls[0].values[0]).toBe('org-1');
  });

  // The identity row belongs to a person. An organization export reading it would put
  // the requesting admin's email and name in a file about the organization.
  it('reads no identity row for an organization subject', async () => {
    const { adapters, replicaCalls, warehouseCalls } = harness([PRIMARY_USER_ROW]);

    const page = await requireAdapter(adapters, 'kilocode_users').readPage?.(ORG_READ_PAGE_INPUT);

    expect(page).toEqual({ records: [], nextCursor: null });
    expect(replicaCalls).toEqual([]);
    expect(warehouseCalls).toEqual([]);
  });

  it('serializes message payloads and preserves a jsonb null', async () => {
    const { adapters } = harness([
      { id: 'message-1', data: { role: 'user', text: 'hi' } },
      { id: 'message-2', data: null },
    ]);

    const messages = requireAdapter(adapters, 'app_builder_messages');
    const page = await messages.readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toEqual([
      {
        source: 'app_builder_messages',
        id: 'message-1',
        field: 'data',
        value: '{"role":"user","text":"hi"}',
      },
      { source: 'app_builder_messages', id: 'message-2', field: 'data', value: null },
    ]);
  });

  it('reads fewer message rows per page than the default', () => {
    const messages = requireAdapter(harness().adapters, 'app_builder_messages');
    expect(messages.pageSize).toBe(500);
  });

  // The sync metadata was dropped from this projection on request. The table does hold
  // deleted rows, so the source can no longer tell them apart and must not imply it can:
  // an absent mark reads as "not deleted, or cannot say", never as a claim of live.
  // Distinct from `system_prompt_prefix`, which still carries the column and still labels.
  it('never marks a message as deleted, having given up the column', async () => {
    const { adapters, warehouseCalls } = harness([
      { id: 'message-gone', data: { role: 'user' }, _snowflake_deleted: true },
    ]);

    const page = await requireAdapter(adapters, 'app_builder_messages').readPage?.(READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).not.toContain('_snowflake');
    expect(page?.records).toHaveLength(1);
    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  it('paginates cli sessions on the journal position pair, not session_id', async () => {
    const { adapters, warehouseCalls } = harness([
      {
        session_id: 'session-1',
        title: 'Session',
        git_url: 'git@example.com:acme/repo.git',
        git_branch: 'main',
        most_significant_position: '10',
        least_significant_position: '20',
      },
    ]);

    const sessions = requireAdapter(adapters, 'cli_sessions');
    const page = await sessions.readPage?.({ ...READ_PAGE_INPUT, limit: 1 });

    expect(warehouseCalls[0]?.values).toEqual(['owner-user', null, null, 1]);
    expect(page?.nextCursor).toEqual({ key: ['10', '20'] });
    expect(page?.records).toEqual([
      { source: 'cli_sessions', id: '10', field: 'session_id', value: 'session-1' },
      { source: 'cli_sessions', id: '10', field: 'title', value: 'Session' },
      {
        source: 'cli_sessions',
        id: '10',
        field: 'git_url',
        value: 'git@example.com:acme/repo.git',
      },
      { source: 'cli_sessions', id: '10', field: 'git_branch', value: 'main' },
    ]);
  });

  it('keys repeated journal rows for one session by position, keeping every value', async () => {
    // A meaningful share of real sessions change values across their journal rows, so
    // a timeline rather than duplication. Collapsing them would drop titles and
    // branches the user actually had.
    const { adapters } = harness([
      {
        session_id: 'session-1',
        title: 'Session',
        git_url: null,
        git_branch: 'main',
        most_significant_position: '10',
        least_significant_position: '1',
      },
      {
        session_id: 'session-1',
        title: 'Session renamed',
        git_url: null,
        git_branch: 'feature/x',
        most_significant_position: '10',
        least_significant_position: '2',
      },
    ]);

    const page = await requireAdapter(adapters, 'cli_sessions').readPage?.(READ_PAGE_INPUT);

    const branches = page?.records.filter(record => record.field === 'git_branch');
    expect(branches).toEqual([
      { source: 'cli_sessions', id: '10', field: 'git_branch', value: 'main' },
      { source: 'cli_sessions', id: '10', field: 'git_branch', value: 'feature/x' },
    ]);

    const sessionIds = page?.records.filter(record => record.field === 'session_id');
    expect(sessionIds?.map(record => record.value)).toEqual(['session-1', 'session-1']);
  });

  it('feeds a cli session cursor back as both position bounds', async () => {
    const { adapters, warehouseCalls } = harness([]);

    await requireAdapter(adapters, 'cli_sessions').readPage?.({
      ...READ_PAGE_INPUT,
      cursor: { key: ['10', '20'] },
    });

    expect(warehouseCalls[0]?.values).toEqual(['owner-user', '10', '20', 100]);
  });

  it('restarts a source when a persisted cursor has the wrong shape', async () => {
    const { adapters, warehouseCalls } = harness([]);

    // A timestamp cursor persisted before this source existed. Paging from a position
    // that cannot be interpreted could skip the user's rows, so it restarts instead.
    await requireAdapter(adapters, 'cli_sessions').readPage?.({
      ...READ_PAGE_INPUT,
      cursor: { createdAt: '2026-08-08T12:00:00.000000Z', id: 'row-id' },
    });

    expect(warehouseCalls[0]?.values).toEqual(['owner-user', null, null, 100]);
  });

  // The prefix id repeats across the triple, so both the record key and the cursor carry
  // the second dimension alongside it.
  it('emits system prompts keyed by the pair that orders them', async () => {
    const { adapters } = harness([
      {
        system_prompt_prefix_id: '42',
        cursor_secondary: 'org-9',
        system_prompt_prefix: 'System prompt',
      },
    ]);

    const page = await requireAdapter(adapters, 'system_prompt_prefix').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    expect(page?.records).toEqual([
      {
        source: 'system_prompt_prefix',
        id: '42.org-9',
        field: 'system_prompt_prefix',
        value: 'System prompt',
      },
    ]);
    expect(page?.nextCursor).toEqual({ key: ['42', 'org-9'] });
  });

  // A personal row has no organization, and the query coalesces it to a sentinel so the
  // tuple comparison stays non-NULL. Without it the row is dropped at a page boundary,
  // which is the defect this cursor was widened to fix.
  it('carries a personal system prompt row through the cursor', async () => {
    const { adapters, warehouseCalls } = harness([
      {
        system_prompt_prefix_id: '7',
        cursor_secondary: '-',
        system_prompt_prefix: 'Personal prompt',
      },
    ]);

    const page = await requireAdapter(adapters, 'system_prompt_prefix').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    expect(warehouseCalls[0].text).toContain("COALESCE(organization_id, '-')");
    expect(page?.nextCursor).toEqual({ key: ['7', '-'] });
    // Non-empty, so the cursor survives KeyCursorSchema on resume.
    expect(page?.nextCursor).toEqual({
      key: expect.arrayContaining([expect.stringMatching(/.+/)]),
    });
  });

  // Deleted rows are RETURNED, they are simply no longer distinguished. The export is a
  // copy of what the warehouse holds about someone rather than a view of what prod still
  // serves, so withholding the marker had to not become withholding the row.
  //
  // All three source states are fed in — deleted, live, and the unknown a not-yet-reloaded
  // table produces — because the marker's absence must mean the same thing for each.
  it('returns a deleted row alongside a live one, marking neither', async () => {
    const { adapters } = harness([
      { system_prompt_prefix_id: '1', cursor_secondary: '-', system_prompt_prefix: 'Live' },
      {
        system_prompt_prefix_id: '2',
        cursor_secondary: '-',
        system_prompt_prefix: 'Deleted',
        _snowflake_deleted: true,
      },
      {
        system_prompt_prefix_id: '3',
        cursor_secondary: '-',
        system_prompt_prefix: 'Unknown',
        _snowflake_deleted: null,
      },
    ]);

    const page = await requireAdapter(adapters, 'system_prompt_prefix').readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toEqual([
      { source: 'system_prompt_prefix', id: '1.-', field: 'system_prompt_prefix', value: 'Live' },
      {
        source: 'system_prompt_prefix',
        id: '2.-',
        field: 'system_prompt_prefix',
        value: 'Deleted',
      },
      {
        source: 'system_prompt_prefix',
        id: '3.-',
        field: 'system_prompt_prefix',
        value: 'Unknown',
      },
    ]);
  });

  // Deleted rows are returned, not filtered. The export is a truthful copy of what the
  // warehouse holds, so a deleted row still reaches the person it belonged to. That holds
  // for the sources that no longer carry the flag too: they stopped labelling, not
  // returning.
  it('returns deleted rows rather than dropping them', async () => {
    const { adapters, warehouseCalls } = harness([
      { id: 'project-gone', title: 'Deleted', _snowflake_deleted: true },
    ]);

    const page = await requireAdapter(adapters, 'app_builder_projects').readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toHaveLength(1);
    expect(warehouseCalls[0].text).not.toContain('_snowflake_deleted IS NOT TRUE');
  });

  // The projection was reduced on request, so this source can no longer tell a deleted
  // project from a live one and must not imply it can.
  it('never marks a project as deleted, having given up the column', async () => {
    const { adapters, warehouseCalls } = harness([
      { id: 'project-gone', title: 'Deleted', _snowflake_deleted: true },
    ]);

    const page = await requireAdapter(adapters, 'app_builder_projects').readPage?.(READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).not.toContain('_snowflake');
    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  it('emits user prompts as their own set, unpaired from system prompts', async () => {
    const { adapters } = harness([{ id: 'usage-1', user_prompt_prefix: 'User prompt' }]);

    const page = await requireAdapter(adapters, 'microdollar_usage_metadata').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    expect(page?.records).toEqual([
      {
        source: 'microdollar_usage_metadata',
        id: 'usage-1',
        field: 'user_prompt_prefix',
        value: 'User prompt',
      },
    ]);
    expect(page?.nextCursor).toEqual({ key: ['usage-1'] });
  });

  it('stops paging when a page is short', async () => {
    const { adapters } = harness([{ id: 'project-1', title: 'Only' }]);

    const page = await requireAdapter(adapters, 'app_builder_projects').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 100,
    });

    expect(page?.nextCursor).toBeNull();
  });

  it('rejects a non-numeric journal position rather than paging from it', async () => {
    const { adapters } = harness([
      {
        session_id: 'session-1',
        title: 'Session',
        git_url: null,
        git_branch: null,
        most_significant_position: '10; DROP TABLE cli_sessions',
        least_significant_position: '20',
      },
    ]);

    await expect(
      requireAdapter(adapters, 'cli_sessions').readPage?.(READ_PAGE_INPUT)
    ).rejects.toThrow('most_significant_position');
  });

  const MANIFEST_ROW = {
    id: 'manifest-1',
    project_id: 'project-a',
    git_branch: 'main',
    file_path: 'src/index.ts',
  };

  it('emits the three manifest fields per row, keyed by the row that carried them', async () => {
    const { adapters } = harness([MANIFEST_ROW]);

    const page = await requireAdapter(adapters, 'code_indexing_manifest').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    // One id across all three, so a file, its branch and its project stay groupable.
    expect(page?.records).toEqual([
      {
        source: 'code_indexing_manifest',
        id: 'manifest-1',
        field: 'project_id',
        value: 'project-a',
      },
      { source: 'code_indexing_manifest', id: 'manifest-1', field: 'git_branch', value: 'main' },
      {
        source: 'code_indexing_manifest',
        id: 'manifest-1',
        field: 'file_path',
        value: 'src/index.ts',
      },
    ]);
    expect(page?.nextCursor).toEqual({ key: ['manifest-1'] });
  });

  // The tight-scoping guard for this source, and the reason it needs one of its own.
  // `organization_id` on a personal row is a uuid derived from the user rather than an
  // organization, which invites a query reaching for both owner columns at once to "catch
  // everything". A user read must name `kilo_user_id` and nothing else, an org read
  // `organization_id` and nothing else, so neither subject can widen into the other's rows.
  // The scope value is the first bind parameter in both, with only cursor and limit after
  // it: no third predicate, and nothing interpolated.
  it('scopes each manifest read to one owner column and never both', async () => {
    const { adapters, warehouseCalls } = harness([MANIFEST_ROW]);
    const adapter = requireAdapter(adapters, 'code_indexing_manifest');

    await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[0].text).not.toContain('organization_id');
    expect(warehouseCalls[0].values).toEqual(['owner-user', null, 100]);
    expect(warehouseCalls[1].text).toContain('WHERE organization_id = $1');
    expect(warehouseCalls[1].text).not.toContain('kilo_user_id');
    expect(warehouseCalls[1].values).toEqual(['org-1', null, 100]);
  });

  it('returns a manifest row prod has deleted, without marking it', async () => {
    const { adapters } = harness([{ ...MANIFEST_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'code_indexing_manifest').readPage?.(
      READ_PAGE_INPUT
    );

    expect(page?.records).toHaveLength(3);
    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  // Unknown is not deleted: the column is NULL throughout on a table whose reload has not
  // run, so an absent mark has to cover both readings.
  it('leaves a manifest row unmarked when the warehouse cannot say', async () => {
    const { adapters } = harness([{ ...MANIFEST_ROW, _snowflake_deleted: null }]);

    const page = await requireAdapter(adapters, 'code_indexing_manifest').readPage?.(
      READ_PAGE_INPUT
    );

    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  // NOT NULL on the primary, unconstrained in the warehouse. One odd cell must not spend
  // the queue's retries on a value frozen in the snapshot.
  it('reads a non-string manifest value as absent rather than failing the export', async () => {
    const { adapters } = harness([{ ...MANIFEST_ROW, git_branch: 42 }]);

    const page = await requireAdapter(adapters, 'code_indexing_manifest').readPage?.(
      READ_PAGE_INPUT
    );
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    expect(byField.get('git_branch')).toBeNull();
    expect(byField.get('file_path')).toBe('src/index.ts');
  });

  const SEARCH_ROW = {
    id: 'search-1',
    project_id: 'project-a',
    query: 'how does auth work',
    metadata: { results: [{ filePath: 'src/auth.ts', startLine: 10 }], path: 'src/' },
    created_at: '2026-07-04T09:15:00.000Z',
  };

  it('emits the three search fields per row, keyed by the row that carried them', async () => {
    const { adapters } = harness([SEARCH_ROW]);

    const page = await requireAdapter(adapters, 'code_indexing_search').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    // One id across all three, so a search, what it ran against and what it returned stay
    // groupable as one event. `created_at` was dropped from the projection on request.
    expect(page?.records).toEqual([
      { source: 'code_indexing_search', id: 'search-1', field: 'project_id', value: 'project-a' },
      {
        source: 'code_indexing_search',
        id: 'search-1',
        field: 'query',
        value: 'how does auth work',
      },
      {
        source: 'code_indexing_search',
        id: 'search-1',
        field: 'metadata',
        value: JSON.stringify(SEARCH_ROW.metadata),
      },
    ]);
    expect(page?.nextCursor).toEqual({ key: ['search-1'] });
  });

  // Both owner columns are notNull() on this table, so unlike its sibling manifest the two
  // scopes overlap rather than partition. Each read must still name one column and not the
  // other: an org read that also matched `kilo_user_id` would return the requester's own
  // personal searches under the organization's name.
  it('scopes each search read to one owner column and never both', async () => {
    const { adapters, warehouseCalls } = harness([SEARCH_ROW]);
    const adapter = requireAdapter(adapters, 'code_indexing_search');

    await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[0].text).not.toContain('organization_id');
    expect(warehouseCalls[0].values).toEqual(['owner-user', null, 100]);
    expect(warehouseCalls[1].text).toContain('WHERE organization_id = $1');
    expect(warehouseCalls[1].text).not.toContain('kilo_user_id');
    expect(warehouseCalls[1].values).toEqual(['org-1', null, 100]);
  });

  // `metadata` is jsonb, so the driver hands back a parsed object. Serialized here rather
  // than dropped, because the result hits are what the search actually returned.
  it('serializes the search metadata payload rather than dropping it', async () => {
    const { adapters } = harness([SEARCH_ROW]);

    const page = await requireAdapter(adapters, 'code_indexing_search').readPage?.(READ_PAGE_INPUT);
    const metadata = page?.records.find(record => record.field === 'metadata')?.value;

    expect(JSON.parse(String(metadata))).toEqual(SEARCH_ROW.metadata);
  });

  it('returns a search row prod has deleted, without marking it', async () => {
    const { adapters } = harness([{ ...SEARCH_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'code_indexing_search').readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toHaveLength(3);
    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  // Reads fewer rows per page than the default, because a row carries a whole result set.
  // The widest source measured, so it is cut below the message source rather than to the
  // same number: both sizes come from bytes per row, not from a shared row count.
  it('cuts the search page size below the message source', async () => {
    const { adapters } = harness([SEARCH_ROW]);

    const search = requireAdapter(adapters, 'code_indexing_search').pageSize;
    const messages = requireAdapter(adapters, 'app_builder_messages').pageSize;
    expect(search).toBe(400);
    expect(search).toBeLessThan(messages ?? 0);
  });

  it('reads a non-string search value as absent rather than failing the export', async () => {
    const { adapters } = harness([{ ...SEARCH_ROW, query: 42 }]);

    const page = await requireAdapter(adapters, 'code_indexing_search').readPage?.(READ_PAGE_INPUT);
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    expect(byField.get('query')).toBeNull();
    expect(byField.get('project_id')).toBe('project-a');
  });

  const DEPLOYMENT_EVENT_ROW = {
    build_id: 'build-a',
    event_id: '7',
    deployment_id: 'deploy-a',
    event_type: 'build.succeeded',
    event_timestamp: '2026-07-04T09:15:00.000Z',
    payload: { status: 'ok' },
  };

  it('keys every deployment event field on the build and event pair', async () => {
    const { adapters } = harness([DEPLOYMENT_EVENT_ROW]);

    const page = await requireAdapter(adapters, 'deployment_events').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    // `event_id` repeats across builds, so the pair is what identifies one event.
    expect(new Set(page?.records.map(record => record.id))).toEqual(new Set(['build-a.7']));
    expect(byField.get('build_id')).toBe('build-a');
    expect(byField.get('deployment_id')).toBe('deploy-a');
    expect(byField.get('payload')).toBe(JSON.stringify({ status: 'ok' }));
    // Dropped from the projection on request.
    expect(byField.has('event_type')).toBe(false);
    expect(byField.has('event_timestamp')).toBe(false);
    expect(byField.has('created_by_user_id')).toBe(false);
    expect(page?.nextCursor).toEqual({ key: ['build-a', '7'] });
  });

  // The table carries a third user column naming whoever created the deployment. It is
  // neither read nor returned, and it never scoped anything: on an org-owned deployment it
  // names a member rather than the owner, so a user read keyed on it would have returned
  // an organization's deployment history as that member's own.
  it('neither reads nor returns the deployment creator', async () => {
    const { adapters, warehouseCalls } = harness([DEPLOYMENT_EVENT_ROW]);
    const adapter = requireAdapter(adapters, 'deployment_events');

    const page = await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);

    for (const call of warehouseCalls) expect(call.text).not.toContain('created_by_user_id');
    expect(page?.records.some(record => record.field === 'created_by_user_id')).toBe(false);
    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[1].text).toContain('WHERE organization_id = $1');
  });

  it('scopes each deployment event read to one owner column and never both', async () => {
    const { adapters, warehouseCalls } = harness([DEPLOYMENT_EVENT_ROW]);
    const adapter = requireAdapter(adapters, 'deployment_events');

    await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).not.toContain('organization_id');
    expect(warehouseCalls[0].values).toEqual(['owner-user', null, null, 100]);
    expect(warehouseCalls[1].text).not.toContain('kilo_user_id');
    expect(warehouseCalls[1].values).toEqual(['org-1', null, null, 100]);
  });

  // A bare `event_id` in the ORDER BY would bind to the `::text` output column rather than
  // the bigint input, sorting the page as text while the cursor compares numerically. That
  // is the defect `cli_sessions` and `system_prompt_prefix` were both fixed for, and it is
  // silent, so the qualified form is pinned here rather than left to review.
  it('orders deployment events on the qualified bigint column', async () => {
    const { adapters, warehouseCalls } = harness([DEPLOYMENT_EVENT_ROW]);

    await requireAdapter(adapters, 'deployment_events').readPage?.(READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain(
      'ORDER BY deployment_events.build_id, deployment_events.event_id'
    );
    expect(warehouseCalls[0].text).toContain('(build_id, event_id) > ($2::text, $3::bigint)');
  });

  it('carries the deployment event cursor pair back into the next page', async () => {
    const { adapters, warehouseCalls } = harness([DEPLOYMENT_EVENT_ROW]);

    await requireAdapter(adapters, 'deployment_events').readPage?.({
      ...READ_PAGE_INPUT,
      cursor: { key: ['build-a', '7'] },
    });

    expect(warehouseCalls[0].values).toEqual(['owner-user', 'build-a', '7', 100]);
  });

  it('returns a deployment event prod has deleted, without marking it', async () => {
    const { adapters } = harness([{ ...DEPLOYMENT_EVENT_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'deployment_events').readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toHaveLength(3);
    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  // The joined columns come from a LEFT JOIN through deployment_builds to deployments, so
  // an absent parent row is a null field rather than a failed export.
  it('reads an unjoined deployment event as absent rather than failing the export', async () => {
    const { adapters } = harness([{ ...DEPLOYMENT_EVENT_ROW, deployment_id: null }]);

    const page = await requireAdapter(adapters, 'deployment_events').readPage?.(READ_PAGE_INPUT);
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    expect(byField.get('deployment_id')).toBeNull();
    expect(byField.get('build_id')).toBe('build-a');
  });

  const ENRICHMENT_ROW = {
    id: 'enrichment-1',
    github_enrichment_data: { login: 'octocat', company: 'GitHub' },
    clay_enrichment_data: { title: 'Engineer' },
  };

  it('emits both enrichment payloads whole, keyed by the row that carried them', async () => {
    const { adapters } = harness([ENRICHMENT_ROW]);

    const page = await requireAdapter(adapters, 'enrichment_data').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    expect(page?.records).toEqual([
      {
        source: 'enrichment_data',
        id: 'enrichment-1',
        field: 'github_enrichment_data',
        value: JSON.stringify(ENRICHMENT_ROW.github_enrichment_data),
      },
      {
        source: 'enrichment_data',
        id: 'enrichment-1',
        field: 'clay_enrichment_data',
        value: JSON.stringify(ENRICHMENT_ROW.clay_enrichment_data),
      },
    ]);
    expect(page?.nextCursor).toEqual({ key: ['enrichment-1'] });
  });

  // The source has no organization column, so there is no organization reading to serve.
  // An empty page would say the organization holds no enrichment, which is a different
  // claim from the true one: it was never a question this source can answer.
  it('refuses an organization read of enrichment rather than returning nothing', async () => {
    const { adapters } = harness([ENRICHMENT_ROW]);

    await expect(
      requireAdapter(adapters, 'enrichment_data').readPage?.(ORG_READ_PAGE_INPUT)
    ).rejects.toThrow('no organization scope');
  });

  it('scopes the enrichment read to the subject of the enrichment', async () => {
    const { adapters, warehouseCalls } = harness([ENRICHMENT_ROW]);

    await requireAdapter(adapters, 'enrichment_data').readPage?.(READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[0].text).not.toContain('organization_id');
    expect(warehouseCalls[0].values).toEqual(['owner-user', null, 100]);
  });

  // The column went with the narrowing, so this source cannot distinguish a deleted row
  // from a live one and must not claim to.
  it('never marks an enrichment record as deleted', async () => {
    const { adapters } = harness([{ ...ENRICHMENT_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'enrichment_data').readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toHaveLength(2);
    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  it('reads a missing enrichment payload as absent rather than failing the export', async () => {
    const { adapters } = harness([{ ...ENRICHMENT_ROW, clay_enrichment_data: null }]);

    const page = await requireAdapter(adapters, 'enrichment_data').readPage?.(READ_PAGE_INPUT);
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    expect(byField.get('clay_enrichment_data')).toBeNull();
    expect(byField.get('github_enrichment_data')).toBe(
      JSON.stringify(ENRICHMENT_ROW.github_enrichment_data)
    );
  });

  const JOURNAL_ROW = {
    payload_id: 'payload-1',
    project_id: 'project-a',
    most_significant_position: '4',
    least_significant_position: '9',
  };

  it('keys the usage journal on the position pair rather than the payload id', async () => {
    const { adapters } = harness([JOURNAL_ROW]);

    const page = await requireAdapter(adapters, 'microdollar_usage_journal').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    // `payload_id` is unique in today's data only because the journal is insert-only, so
    // it is exported as a field and never used to identify the row.
    expect(page?.records).toEqual([
      {
        source: 'microdollar_usage_journal',
        id: '4.9',
        field: 'payload_id',
        value: 'payload-1',
      },
      {
        source: 'microdollar_usage_journal',
        id: '4.9',
        field: 'project_id',
        value: 'project-a',
      },
    ]);
    expect(page?.nextCursor).toEqual({ key: ['4', '9'] });
  });

  // The cursor must be the pair, not `payload_id`. A cursor on `payload_id` works on the
  // current data and starts skipping rows at page boundaries the moment an update event
  // appears, which is how it broke on cli_sessions.
  it('pages the usage journal on the position pair', async () => {
    const { adapters, warehouseCalls } = harness([JOURNAL_ROW]);

    await requireAdapter(adapters, 'microdollar_usage_journal').readPage?.({
      ...READ_PAGE_INPUT,
      cursor: { key: ['4', '9'] },
    });

    expect(warehouseCalls[0].text).toContain(
      '(most_significant_position, least_significant_position) > ($2::bigint, $3::bigint)'
    );
    expect(warehouseCalls[0].text).not.toContain('payload_id >');
    expect(warehouseCalls[0].values).toEqual(['owner-user', '4', '9', 100]);
  });

  // Both positions are bigints selected through a text cast under their own names, so a
  // bare name in the ORDER BY would sort the page as text while the cursor compares
  // numerically. Fourth table where this applies, and the failure is silent every time.
  it('orders the usage journal on the qualified position columns', async () => {
    const { adapters, warehouseCalls } = harness([JOURNAL_ROW]);

    await requireAdapter(adapters, 'microdollar_usage_journal').readPage?.(READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain(
      'ORDER BY microdollar_usage_journal.most_significant_position,\n' +
        '  microdollar_usage_journal.least_significant_position'
    );
  });

  it('scopes each usage journal read to one owner column and never both', async () => {
    const { adapters, warehouseCalls } = harness([JOURNAL_ROW]);
    const adapter = requireAdapter(adapters, 'microdollar_usage_journal');

    await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[0].text).not.toContain('organization_id');
    expect(warehouseCalls[1].text).toContain('WHERE organization_id = $1');
    expect(warehouseCalls[1].text).not.toContain('kilo_user_id');
  });

  // The column went with the narrowing, and the journal is insert-only besides, so this
  // source has nothing to mark and must not claim otherwise.
  it('never marks a usage journal record as deleted', async () => {
    const { adapters } = harness([{ ...JOURNAL_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'microdollar_usage_journal').readPage?.(
      READ_PAGE_INPUT
    );

    expect(page?.records).toHaveLength(2);
    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  it('fails a usage journal page whose cursor column is unreadable', async () => {
    const { adapters } = harness([{ ...JOURNAL_ROW, least_significant_position: 'not-a-number' }]);

    await expect(
      requireAdapter(adapters, 'microdollar_usage_journal').readPage?.(READ_PAGE_INPUT)
    ).rejects.toThrow('least_significant_position');
  });

  const FINDING_ROW = {
    id: 'finding-1',
    repo_full_name: 'acme/private-api',
    package_name: 'lodash',
    manifest_path: 'package.json',
    title: 'Prototype pollution',
    description: 'A crafted payload can reach Object.prototype.',
    status: 'open',
    ignored_reason: null,
    ignored_by: null,
    fixed_at: null,
    dependabot_html_url: 'https://github.com/acme/private-api/security/dependabot/1',
    cwe_ids: '{CWE-1321}',
    cvss_score: '9.8',
    dependency_scope: 'runtime',
    analysis: { reachable: true },
    raw_data: { number: 1 },
  };

  it('emits every declared finding field, keyed by the finding', async () => {
    const { adapters } = harness([FINDING_ROW]);

    const page = await requireAdapter(adapters, 'security_findings').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    // Derived from one declaration, so the count is what stops a column being selected
    // and then quietly not emitted.
    expect(page?.records).toHaveLength(15);
    for (const record of page?.records ?? []) expect(record.id).toBe('finding-1');
    expect(byField.get('repo_full_name')).toBe('acme/private-api');
    expect(byField.get('title')).toBe('Prototype pollution');
    expect(byField.get('status')).toBe('open');
    expect(byField.get('analysis')).toBe(JSON.stringify(FINDING_ROW.analysis));
    expect(byField.get('raw_data')).toBe(JSON.stringify(FINDING_ROW.raw_data));
    expect(page?.nextCursor).toEqual({ key: ['finding-1'] });
  });

  // The owner columns are the scope and are never emitted: the subject already implies
  // them, and re-exporting them would put an organization's id in a personal file.
  it('never emits the finding owner columns as fields', async () => {
    const { adapters } = harness([{ ...FINDING_ROW, kilo_user_id: 'owner-user' }]);

    const page = await requireAdapter(adapters, 'security_findings').readPage?.(READ_PAGE_INPUT);
    const fields = page?.records.map(record => record.field) ?? [];

    expect(fields).not.toContain('kilo_user_id');
    expect(fields).not.toContain('organization_id');
  });

  // `cvss_score` is numeric(3,1). A driver may hand it back as a string or a number
  // depending on whether a type parser is registered, and reading only one of the two
  // would drop the score on the other.
  it.each([
    ['string', '9.8'],
    ['number', 9.8],
  ])('reads a %s cvss score as a number', async (_label, raw) => {
    const { adapters } = harness([{ ...FINDING_ROW, cvss_score: raw }]);

    const page = await requireAdapter(adapters, 'security_findings').readPage?.(READ_PAGE_INPUT);
    const score = page?.records.find(record => record.field === 'cvss_score')?.value;

    expect(score).toBe(9.8);
  });

  it('reads an unusable cvss score as absent rather than failing the export', async () => {
    const { adapters } = harness([{ ...FINDING_ROW, cvss_score: 'n/a' }]);

    const page = await requireAdapter(adapters, 'security_findings').readPage?.(READ_PAGE_INPUT);
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    expect(byField.get('cvss_score')).toBeNull();
    expect(byField.get('title')).toBe('Prototype pollution');
  });

  // `cwe_ids` is text[] in prod but reaches the warehouse flattened. Carried verbatim,
  // because splitting it would mean guessing at a serialisation nobody has confirmed.
  it('carries the cwe list verbatim', async () => {
    const { adapters } = harness([FINDING_ROW]);

    const page = await requireAdapter(adapters, 'security_findings').readPage?.(READ_PAGE_INPUT);

    expect(page?.records.find(record => record.field === 'cwe_ids')?.value).toBe('{CWE-1321}');
  });

  // Audit trail rather than attribution: returned so the person can see who dismissed a
  // finding, never used to decide whose finding it is.
  it('exports the dismisser without ever scoping on it', async () => {
    const { adapters, warehouseCalls } = harness([
      { ...FINDING_ROW, ignored_by: 'admin-user', ignored_reason: 'accepted risk' },
    ]);
    const adapter = requireAdapter(adapters, 'security_findings');

    await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);

    for (const call of warehouseCalls) expect(call.text).not.toContain('ignored_by = $');
    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[1].text).toContain('WHERE organization_id = $1');
    const page = await adapter.readPage?.(READ_PAGE_INPUT);
    const byField = new Map(page?.records.map(record => [record.field, record.value]));
    expect(byField.get('ignored_by')).toBe('admin-user');
    expect(byField.get('ignored_reason')).toBe('accepted risk');
  });

  it('scopes each finding read to one owner column and never both', async () => {
    const { adapters, warehouseCalls } = harness([FINDING_ROW]);
    const adapter = requireAdapter(adapters, 'security_findings');

    await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).not.toContain('organization_id');
    expect(warehouseCalls[0].values).toEqual(['owner-user', null, 100]);
    expect(warehouseCalls[1].text).not.toContain('kilo_user_id');
    expect(warehouseCalls[1].values).toEqual(['org-1', null, 100]);
  });

  it('never marks a finding as deleted', async () => {
    const { adapters } = harness([{ ...FINDING_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'security_findings').readPage?.(READ_PAGE_INPUT);

    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  const EMBEDDING_ROW = {
    id: 'chunk-1',
    project_id: 'project-a',
    file_path: 'src/index.ts',
    git_branch: 'main',
  };

  it('emits the three embedding fields per chunk, keyed by the row that carried them', async () => {
    const { adapters } = harness([EMBEDDING_ROW]);

    const page = await requireAdapter(adapters, 'source_embeddings').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    expect(page?.records).toEqual([
      { source: 'source_embeddings', id: 'chunk-1', field: 'project_id', value: 'project-a' },
      { source: 'source_embeddings', id: 'chunk-1', field: 'file_path', value: 'src/index.ts' },
      { source: 'source_embeddings', id: 'chunk-1', field: 'git_branch', value: 'main' },
    ]);
    expect(page?.nextCursor).toEqual({ key: ['chunk-1'] });
  });

  // Both owner columns are notNull() on this table, so the two scopes overlap: an
  // organization's rows are simultaneously some individual's. Each read must still name
  // one column and not the other, so a personal lookup routes on kilo_user_id alone.
  it('scopes each embedding read to one owner column and never both', async () => {
    const { adapters, warehouseCalls } = harness([EMBEDDING_ROW]);
    const adapter = requireAdapter(adapters, 'source_embeddings');

    await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[0].text).not.toContain('organization_id');
    expect(warehouseCalls[0].values).toEqual(['owner-user', null, 100]);
    expect(warehouseCalls[1].text).toContain('WHERE organization_id = $1');
    expect(warehouseCalls[1].text).not.toContain('kilo_user_id');
    expect(warehouseCalls[1].values).toEqual(['org-1', null, 100]);
  });

  // The cursor both warehouse indexes are built to serve, as (owner, id).
  it('pages the embeddings on id', async () => {
    const { adapters, warehouseCalls } = harness([EMBEDDING_ROW]);

    await requireAdapter(adapters, 'source_embeddings').readPage?.({
      ...READ_PAGE_INPUT,
      cursor: { key: ['chunk-1'] },
    });

    expect(warehouseCalls[0].text).toContain('($2::text IS NULL OR id > $2::text)');
    expect(warehouseCalls[0].text).toContain('ORDER BY id');
    expect(warehouseCalls[0].values).toEqual(['owner-user', 'chunk-1', 100]);
  });

  it('never marks an embedding record as deleted', async () => {
    const { adapters } = harness([{ ...EMBEDDING_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'source_embeddings').readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toHaveLength(3);
    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  it('reads a non-string embedding value as absent rather than failing the export', async () => {
    const { adapters } = harness([{ ...EMBEDDING_ROW, git_branch: 42 }]);

    const page = await requireAdapter(adapters, 'source_embeddings').readPage?.(READ_PAGE_INPUT);
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    expect(byField.get('git_branch')).toBeNull();
    expect(byField.get('file_path')).toBe('src/index.ts');
  });

  const INTEGRATION_ROW = {
    id: 'integration-1',
    platform: 'github',
    platform_account_login: 'acme',
    repositories: [{ full_name: 'acme/private-api' }],
  };

  it('emits the three integration fields, keyed by the integration', async () => {
    const { adapters } = harness([INTEGRATION_ROW]);

    const page = await requireAdapter(adapters, 'platform_integrations').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    expect(page?.records).toEqual([
      {
        source: 'platform_integrations',
        id: 'integration-1',
        field: 'platform',
        value: 'github',
      },
      {
        source: 'platform_integrations',
        id: 'integration-1',
        field: 'platform_account_login',
        value: 'acme',
      },
      {
        source: 'platform_integrations',
        id: 'integration-1',
        field: 'repositories',
        value: JSON.stringify(INTEGRATION_ROW.repositories),
      },
    ]);
    expect(page?.nextCursor).toEqual({ key: ['integration-1'] });
  });

  // The table holds 29 columns, including installation ids, permission and scope grants
  // and an auth-invalid reason. Only three are exported, and the query is what enforces
  // that: a field added here without a decision would ship on the next export.
  it('reads only the three declared integration columns', async () => {
    const { adapters, warehouseCalls } = harness([INTEGRATION_ROW]);

    await requireAdapter(adapters, 'platform_integrations').readPage?.(READ_PAGE_INPUT);

    for (const withheld of [
      'platform_installation_id',
      'permissions',
      'scopes',
      'metadata',
      'auth_invalid_reason',
      'created_by_user_id',
      'suspended_by',
      'kilo_requester_user_id',
    ]) {
      expect(warehouseCalls[0].text).not.toContain(withheld);
    }
  });

  // Measured across the whole table: every row carries exactly one of the two owners, with
  // none carrying both and none carrying neither. Each read still names one owner column
  // and not the other.
  it('scopes each integration read to one owner column and never both', async () => {
    const { adapters, warehouseCalls } = harness([INTEGRATION_ROW]);
    const adapter = requireAdapter(adapters, 'platform_integrations');

    await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[0].text).not.toContain('organization_id');
    expect(warehouseCalls[0].values).toEqual(['owner-user', null, 100]);
    expect(warehouseCalls[1].text).toContain('WHERE organization_id = $1');
    expect(warehouseCalls[1].text).not.toContain('kilo_user_id');
    expect(warehouseCalls[1].values).toEqual(['org-1', null, 100]);
  });

  // The source does hold deleted rows, and this source carries the flag to mark them.
  it('returns a integration prod has deleted, without marking it', async () => {
    const { adapters } = harness([{ ...INTEGRATION_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'platform_integrations').readPage?.(
      READ_PAGE_INPUT
    );

    expect(page?.records).toHaveLength(3);
    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  it('reads a missing integration value as absent rather than failing the export', async () => {
    const { adapters } = harness([
      { ...INTEGRATION_ROW, platform_account_login: null, repositories: null },
    ]);

    const page = await requireAdapter(adapters, 'platform_integrations').readPage?.(
      READ_PAGE_INPUT
    );
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    expect(byField.get('platform_account_login')).toBeNull();
    expect(byField.get('repositories')).toBeNull();
    expect(byField.get('platform')).toBe('github');
  });

  const COUNTRY_ROW = { cursor_owner: 'org-9', geoip_country_code: 'NL' };

  it('emits the country and nothing else', async () => {
    const { adapters } = harness([COUNTRY_ROW]);

    const page = await requireAdapter(adapters, 'external_usage_daily').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    expect(page?.records).toEqual([
      { source: 'external_usage_daily', id: 'NL', field: 'geoip_country_code', value: 'NL' },
    ]);
    expect(page?.nextCursor).toEqual({ key: ['org-9', 'NL'] });
  });

  // The row has no key of its own: all three columns together are what makes it distinct,
  // which is why the load carries DISTINCT. The scope pins one, so the cursor is the other
  // two. The previous cursor on this table, (kilo_user_id, usage_date), was never unique.
  it('pages a country row on both columns the scope did not pin', async () => {
    const { adapters, warehouseCalls } = harness([COUNTRY_ROW]);

    await requireAdapter(adapters, 'external_usage_daily').readPage?.({
      ...READ_PAGE_INPUT,
      cursor: { key: ['org-9', 'NL'] },
    });

    expect(warehouseCalls[0].text).toContain(
      "(COALESCE(organization_id, '-'), COALESCE(geoip_country_code, '-')) > ($2::text, $3::text)"
    );
    expect(warehouseCalls[0].text).not.toContain('usage_date');
    expect(warehouseCalls[0].values).toEqual(['owner-user', 'org-9', 'NL', 100]);
  });

  // A NULL inside a tuple comparison yields NULL rather than false, so an uncoalesced
  // cursor would drop exactly the rows the sentinel exists to keep. The sentinel is a
  // cursor device and never reaches a record.
  it('substitutes the sentinel in the cursor only', async () => {
    const { adapters } = harness([{ cursor_owner: null, geoip_country_code: 'NL' }]);

    const page = await requireAdapter(adapters, 'external_usage_daily').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    expect(page?.nextCursor).toEqual({ key: ['-', 'NL'] });
    expect(page?.records).toEqual([
      { source: 'external_usage_daily', id: 'NL', field: 'geoip_country_code', value: 'NL' },
    ]);
  });

  it('scopes each country read to one owner column and never both', async () => {
    const { adapters, warehouseCalls } = harness([COUNTRY_ROW]);
    const adapter = requireAdapter(adapters, 'external_usage_daily');

    await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[0].values[0]).toBe('owner-user');
    expect(warehouseCalls[1].text).toContain('WHERE organization_id = $1');
    expect(warehouseCalls[1].values[0]).toBe('org-1');
  });

  it('never marks a country row as deleted', async () => {
    const { adapters } = harness([{ ...COUNTRY_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'external_usage_daily').readPage?.(READ_PAGE_INPUT);

    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  const CODE_REVIEW_ROW = {
    payload_id: 'review-1',
    repo_full_name: 'acme/private-api',
    pr_url: 'https://github.com/acme/private-api/pull/7',
    pr_title: 'Tighten the auth guard',
    base_ref: 'main',
    previous_summary_body: 'An earlier summary.',
    most_significant_position: '11',
    least_significant_position: '2',
  };

  it('keys a code review journal row on the position pair, not the review id', async () => {
    const { adapters } = harness([CODE_REVIEW_ROW]);

    const page = await requireAdapter(adapters, 'cloud_agent_code_reviews').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });
    const byField = new Map(page?.records.map(record => [record.field, record.value]));
    expect(byField.get('payload_id')).toBe('review-1');
    expect(byField.get('repo_full_name')).toBe('acme/private-api');
    expect(byField.get('pr_title')).toBe('Tighten the auth guard');
    expect(byField.get('base_ref')).toBe('main');
    expect(byField.get('previous_summary_body')).toBe('An earlier summary.');
    expect(page?.nextCursor).toEqual({ key: ['11', '2'] });
  });

  // A keyset on payload_id would skip the rest of a review at any page boundary inside
  // one, which is the defect cli_sessions and system_prompt_prefix were both fixed for.
  it('pages code reviews on the position pair and never on payload_id', async () => {
    const { adapters, warehouseCalls } = harness([CODE_REVIEW_ROW]);

    await requireAdapter(adapters, 'cloud_agent_code_reviews').readPage?.({
      ...READ_PAGE_INPUT,
      cursor: { key: ['11', '2'] },
    });

    expect(warehouseCalls[0].text).toContain(
      '(most_significant_position, least_significant_position) > ($2::bigint, $3::bigint)'
    );
    expect(warehouseCalls[0].text).not.toContain('payload_id >');
    expect(warehouseCalls[0].values).toEqual(['owner-user', '11', '2', 100]);
  });

  // Both positions are bigints selected through a text cast under their own names, so a
  // bare name in the ORDER BY would sort the page as text while the cursor compares
  // numerically. Fifth table where this applies, and the failure is silent every time.
  it('orders code reviews on the qualified position columns', async () => {
    const { adapters, warehouseCalls } = harness([CODE_REVIEW_ROW]);

    await requireAdapter(adapters, 'cloud_agent_code_reviews').readPage?.(READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain(
      'ORDER BY cloud_agent_code_reviews.most_significant_position,\n' +
        '  cloud_agent_code_reviews.least_significant_position'
    );
  });

  it('scopes each code review read to one owner column and never both', async () => {
    const { adapters, warehouseCalls } = harness([CODE_REVIEW_ROW]);
    const adapter = requireAdapter(adapters, 'cloud_agent_code_reviews');

    await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[0].text).not.toContain('organization_id');
    expect(warehouseCalls[1].text).toContain('WHERE organization_id = $1');
    expect(warehouseCalls[1].text).not.toContain('kilo_user_id');
  });

  // The journal envelope went with the narrowing, so this source can say nothing about
  // deletion and must not imply otherwise.
  it('never marks a code review as deleted', async () => {
    const { adapters } = harness([{ ...CODE_REVIEW_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'cloud_agent_code_reviews').readPage?.(
      READ_PAGE_INPUT
    );

    expect(page?.records).toHaveLength(6);
    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  it('fails a code review page whose cursor column is unreadable', async () => {
    const { adapters } = harness([
      { ...CODE_REVIEW_ROW, most_significant_position: 'not-a-number' },
    ]);

    await expect(
      requireAdapter(adapters, 'cloud_agent_code_reviews').readPage?.(READ_PAGE_INPUT)
    ).rejects.toThrow('most_significant_position');
  });

  const AUTH_PROVIDER_ROW = {
    provider: 'google',
    provider_account_id: '110581',
    email: 'person@example.com',
    display_name: 'Example Person',
    avatar_url: 'https://example.test/a.png',
    hosted_domain: 'example.com',
    created_at: '2026-03-04T09:15:00.000Z',
  };

  it('emits every field of a linked account, keyed by the provider pair', async () => {
    const { adapters } = harness([AUTH_PROVIDER_ROW]);

    const page = await requireAdapter(adapters, 'user_auth_provider').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    expect(page?.records).toEqual([
      { source: 'user_auth_provider', field: 'email', value: 'person@example.com' },
      { source: 'user_auth_provider', field: 'display_name', value: 'Example Person' },
      { source: 'user_auth_provider', field: 'avatar_url', value: 'https://example.test/a.png' },
      { source: 'user_auth_provider', field: 'hosted_domain', value: 'example.com' },
    ]);
    expect(page?.nextCursor).toEqual({ key: ['google', '110581'] });
  });

  it('returns every linked account and names neither the provider nor its account id', async () => {
    const { adapters } = harness([
      AUTH_PROVIDER_ROW,
      { ...AUTH_PROVIDER_ROW, provider: 'github', provider_account_id: '4821' },
    ]);

    const page = await requireAdapter(adapters, 'user_auth_provider').readPage?.(READ_PAGE_INPUT);
    const fields = page?.records.map(record => record.field) ?? [];

    expect(page?.records).toHaveLength(8);
    expect(fields).not.toContain('provider');
    expect(fields).not.toContain('provider_account_id');
  });

  // `kilo_user_id` repeats once per linked account, so it cannot page. The cursor is the
  // primary key pair, and it has to travel as both bind parameters or the second page
  // restarts at the first.
  it('pages on the provider pair rather than the owner', async () => {
    const { adapters, warehouseCalls } = harness([AUTH_PROVIDER_ROW]);

    await requireAdapter(adapters, 'user_auth_provider').readPage?.({
      ...READ_PAGE_INPUT,
      cursor: { key: ['google', '110581'] },
    });

    expect(warehouseCalls[0].text).toContain(
      '(provider, provider_account_id) > ($2::text, $3::text)'
    );
    expect(warehouseCalls[0].text).toContain('ORDER BY provider, provider_account_id');
    expect(warehouseCalls[0].values).toEqual(['owner-user', 'google', '110581', 100]);
  });

  // Same statement as `enrichment_data`: the table has no organization column, so an
  // empty page would claim no accounts are linked when the question never applied.
  it('refuses an organization read of linked accounts rather than returning nothing', async () => {
    const { adapters } = harness([AUTH_PROVIDER_ROW]);

    await expect(
      requireAdapter(adapters, 'user_auth_provider').readPage?.(ORG_READ_PAGE_INPUT)
    ).rejects.toThrow('no organization scope');
  });

  it('scopes the linked-account read to the person who signed in', async () => {
    const { adapters, warehouseCalls } = harness([AUTH_PROVIDER_ROW]);

    await requireAdapter(adapters, 'user_auth_provider').readPage?.(READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[0].text).not.toContain('organization_id');
    expect(warehouseCalls[0].values).toEqual(['owner-user', null, null, 100]);
  });

  // The source does hold deleted rows, and this source carries the flag to mark them.
  it('returns a linked account prod has deleted, without marking it', async () => {
    const { adapters } = harness([{ ...AUTH_PROVIDER_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'user_auth_provider').readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toHaveLength(4);
    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  it('reads a missing linked-account value as absent rather than failing the export', async () => {
    const { adapters } = harness([
      { ...AUTH_PROVIDER_ROW, hosted_domain: null, display_name: null },
    ]);

    const page = await requireAdapter(adapters, 'user_auth_provider').readPage?.(READ_PAGE_INPUT);
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    expect(byField.get('hosted_domain')).toBeNull();
    expect(byField.get('display_name')).toBeNull();
    expect(byField.get('email')).toBe('person@example.com');
  });

  // The cursor half of the row, unlike every other column, is read strictly: a page that
  // could not say where it ended would restart the source and repeat rows forever.
  it('fails a linked-account page that cannot say where it ended', async () => {
    const { adapters } = harness([{ ...AUTH_PROVIDER_ROW, provider_account_id: null }]);

    await expect(
      requireAdapter(adapters, 'user_auth_provider').readPage?.(READ_PAGE_INPUT)
    ).rejects.toThrow('provider_account_id');
  });

  it('emits the audience email as the only field it holds', async () => {
    const { adapters } = harness([{ email: 'marketing@example.com' }]);

    const page = await requireAdapter(adapters, 'audiences').readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toEqual([
      { source: 'audiences', field: 'email', value: 'marketing@example.com' },
    ]);
  });

  // `kilo_user_id` is unique across the table, so scoping already selects at most
  // one row and there is nothing left to page. A cursor here would page on the same column
  // the WHERE clause has already pinned.
  it('reads the audience row without a cursor and never asks for a second page', async () => {
    const { adapters, warehouseCalls } = harness([{ email: 'marketing@example.com' }]);

    const page = await requireAdapter(adapters, 'audiences').readPage?.(READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    // No keyset predicate: nothing is compared against a prior page's key.
    expect(warehouseCalls[0].text).not.toContain('>');
    // Ordered anyway, so the bound limit truncates deterministically rather than
    // arbitrarily if the table ever stopped being one row per user.
    expect(warehouseCalls[0].text).toContain('ORDER BY email');
    expect(warehouseCalls[0].values).toEqual(['owner-user', 100]);
    expect(page?.nextCursor).toBeNull();
  });

  // No organization column exists on this table, so an empty page would answer a question
  // the source cannot be asked. Same treatment as `enrichment_data`.
  it('refuses an organization read of audiences rather than returning nothing', async () => {
    const { adapters } = harness([{ email: 'marketing@example.com' }]);

    await expect(
      requireAdapter(adapters, 'audiences').readPage?.(ORG_READ_PAGE_INPUT)
    ).rejects.toThrow('no organization scope');
  });

  // A dbt model with no CDC column, so this source can say nothing about deletion.
  it('never marks an audience record as deleted', async () => {
    const { adapters } = harness([{ email: 'marketing@example.com', _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'audiences').readPage?.(READ_PAGE_INPUT);

    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  it('reads a missing audience email as absent rather than failing the export', async () => {
    const { adapters } = harness([{ email: null }]);

    const page = await requireAdapter(adapters, 'audiences').readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toEqual([{ source: 'audiences', field: 'email', value: null }]);
  });

  const ORB_ROW = {
    id: 'orb-cus-1',
    additional_emails: ['billing@example.com'],
    billing_address: { line1: '1 Example Street', country: 'NL' },
    email: 'person@example.com',
    name: 'A Person',
    corp_tax_id: { value: 'NL1234' },
    shipping_address: null,
  };

  it('emits every declared orb field, keyed by the orb customer', async () => {
    const { adapters } = harness([ORB_ROW]);

    const page = await requireAdapter(adapters, 'orb_customer').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    expect(page?.records).toHaveLength(6);
    for (const record of page?.records ?? []) expect(record.id).toBe('orb-cus-1');
    expect(byField.get('email')).toBe('person@example.com');
    expect(byField.get('name')).toBe('A Person');
    expect(byField.get('billing_address')).toBe(JSON.stringify(ORB_ROW.billing_address));
    expect(byField.get('additional_emails')).toBe(JSON.stringify(ORB_ROW.additional_emails));
    expect(byField.get('corp_tax_id')).toBe(JSON.stringify(ORB_ROW.corp_tax_id));
    expect(byField.get('shipping_address')).toBeNull();
    expect(page?.nextCursor).toEqual({ key: ['orb-cus-1'] });
  });

  // The association is derived: Orb has no owner column, and `kilo_user_id` is produced by
  // the load matching `external_customer_id` to a Kilo user. The scope must still be the
  // derived column, since that is what the match resolved to.
  it('scopes the orb read on the derived user column', async () => {
    const { adapters, warehouseCalls } = harness([ORB_ROW]);

    await requireAdapter(adapters, 'orb_customer').readPage?.(READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[0].text).not.toContain('WHERE external_customer_id');
    expect(warehouseCalls[0].values).toEqual(['owner-user', null, 100]);
  });

  // Orb has no notion of a Kilo organization, so an empty page would answer a question the
  // source cannot be asked.
  it('refuses an organization read of orb customers rather than returning nothing', async () => {
    const { adapters } = harness([ORB_ROW]);

    await expect(
      requireAdapter(adapters, 'orb_customer').readPage?.(ORG_READ_PAGE_INPUT)
    ).rejects.toThrow('no organization scope');
  });

  it('returns a orb customer prod has deleted, without marking it', async () => {
    const { adapters } = harness([{ ...ORB_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'orb_customer').readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toHaveLength(6);
    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  const USAGE_ENRICHED_ROW = {
    id: 'usage-1',
    project_id: 'project-a',
    vercel_ip_city_id: '2759794',
    vercel_ip_country_id: 528,
    vercel_ip_latitude: '52.3676',
    vercel_ip_longitude: 4.9041,
  };

  it('emits the five enriched usage fields, keyed by the usage row', async () => {
    const { adapters } = harness([USAGE_ENRICHED_ROW]);

    const page = await requireAdapter(adapters, 'int_microdollar_usage_enriched').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    expect(page?.records).toHaveLength(5);
    for (const record of page?.records ?? []) expect(record.id).toBe('usage-1');
    expect(byField.get('project_id')).toBe('project-a');
    expect(page?.nextCursor).toEqual({ key: ['usage-1'] });
  });

  // Every numeric column here arrives as a string or a number depending on the driver's
  // type parsers: bigint is commonly returned as text to protect precision, double
  // precision as a number. Reading only one form would drop coordinates on the other.
  it.each([
    ['vercel_ip_city_id', 2759794],
    ['vercel_ip_country_id', 528],
    ['vercel_ip_latitude', 52.3676],
    ['vercel_ip_longitude', 4.9041],
  ])('reads %s as a number whichever form the driver returns', async (field, expected) => {
    const { adapters } = harness([USAGE_ENRICHED_ROW]);

    const page = await requireAdapter(adapters, 'int_microdollar_usage_enriched').readPage?.(
      READ_PAGE_INPUT
    );

    expect(page?.records.find(record => record.field === field)?.value).toBe(expected);
  });

  it('scopes each enriched usage read to one owner column and never both', async () => {
    const { adapters, warehouseCalls } = harness([USAGE_ENRICHED_ROW]);
    const adapter = requireAdapter(adapters, 'int_microdollar_usage_enriched');

    await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[0].text).not.toContain('organization_id');
    expect(warehouseCalls[0].values).toEqual(['owner-user', null, 100]);
    expect(warehouseCalls[1].text).toContain('WHERE organization_id = $1');
    expect(warehouseCalls[1].text).not.toContain('kilo_user_id');
    expect(warehouseCalls[1].values).toEqual(['org-1', null, 100]);
  });

  // A dbt model with no CDC column, so this source can say nothing about deletion.
  it('never marks an enriched usage record as deleted', async () => {
    const { adapters } = harness([{ ...USAGE_ENRICHED_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'int_microdollar_usage_enriched').readPage?.(
      READ_PAGE_INPUT
    );

    for (const record of page?.records ?? []) expect(record).not.toHaveProperty('softDeleted');
  });

  it('reads an unusable coordinate as absent rather than failing the export', async () => {
    const { adapters } = harness([
      { ...USAGE_ENRICHED_ROW, vercel_ip_latitude: null, vercel_ip_longitude: 'n/a' },
    ]);

    const page = await requireAdapter(adapters, 'int_microdollar_usage_enriched').readPage?.(
      READ_PAGE_INPUT
    );
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    expect(byField.get('vercel_ip_latitude')).toBeNull();
    expect(byField.get('vercel_ip_longitude')).toBeNull();
    expect(byField.get('project_id')).toBe('project-a');
  });
});

describe('microdollar usage hourly', () => {
  const HOURLY_ROW = {
    cursor_owner: 'org-9',
    project_id: 'project-a',
    vercel_ip_country_id: 528,
    vercel_ip_country: 'NL',
  };

  it('emits the three requested fields and neither owner', async () => {
    const { adapters } = harness([HOURLY_ROW]);

    const page = await requireAdapter(adapters, 'microdollar_usage_hourly').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });
    const fields = page?.records.map(record => record.field) ?? [];

    expect(fields).toEqual(['project_id', 'vercel_ip_country_id', 'vercel_ip_country']);
    expect(fields).not.toContain('kilo_user_id');
    expect(fields).not.toContain('organization_id');
  });

  // The load still holds the wider row, so the five requested columns repeat underneath.
  // Without DISTINCT the projected tuple is not unique and a page boundary landing inside
  // a run of them skips the rest, which is the defect this file has fixed four times.
  it('deduplicates in the query, since the load does not', async () => {
    const { adapters, warehouseCalls } = harness([HOURLY_ROW]);

    await requireAdapter(adapters, 'microdollar_usage_hourly').readPage?.(READ_PAGE_INPUT);

    expect(warehouseCalls[0].text.startsWith('SELECT DISTINCT ')).toBe(true);
  });

  // The scope pins one owner, so the cursor is the other four columns.
  it('pages on every column the scope did not pin', async () => {
    const { adapters, warehouseCalls } = harness([HOURLY_ROW]);

    const page = await requireAdapter(adapters, 'microdollar_usage_hourly').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    expect(page?.nextCursor).toEqual({ key: ['org-9', 'project-a', '528', 'NL'] });
    expect(warehouseCalls[0].values).toEqual(['owner-user', null, null, null, null, 1]);
  });

  // Both warehouse indexes are expression indexes over these exact COALESCE forms, so the
  // query has to match them character for character or it cannot use either and scans.
  // `-1` for the bigint, `'-'` for the text columns.
  it('matches the expression indexes the warehouse built', async () => {
    const { adapters, warehouseCalls } = harness([HOURLY_ROW]);

    await requireAdapter(adapters, 'microdollar_usage_hourly').readPage?.({
      ...READ_PAGE_INPUT,
      cursor: { key: ['org-9', 'project-a', '528', 'NL'] },
    });

    expect(warehouseCalls[0].text).toContain('COALESCE(vercel_ip_country_id, -1)');
    expect(warehouseCalls[0].text).toContain("COALESCE(project_id, '-')");
    expect(warehouseCalls[0].text).toContain("COALESCE(vercel_ip_country, '-')");
    expect(warehouseCalls[0].text).toContain('$4::bigint');
    expect(warehouseCalls[0].values).toEqual([
      'owner-user',
      'org-9',
      'project-a',
      '528',
      'NL',
      100,
    ]);
  });

  it('substitutes the sentinel in the cursor only', async () => {
    const { adapters } = harness([{ ...HOURLY_ROW, project_id: null, cursor_owner: null }]);

    const page = await requireAdapter(adapters, 'microdollar_usage_hourly').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    expect(page?.nextCursor).toEqual({ key: ['-', '-', '528', 'NL'] });
    expect(byField.get('project_id')).toBeNull();
  });

  // The numeric column takes the numeric sentinel, or the cursor would hand back a value
  // the WHERE clause cannot compare against a bigint.
  it('substitutes the numeric sentinel for an absent country id', async () => {
    const { adapters } = harness([{ ...HOURLY_ROW, vercel_ip_country_id: null }]);

    const page = await requireAdapter(adapters, 'microdollar_usage_hourly').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    expect(page?.nextCursor).toEqual({ key: ['org-9', 'project-a', '-1', 'NL'] });
  });

  it('scopes each read to one owner column and never both', async () => {
    const { adapters, warehouseCalls } = harness([HOURLY_ROW]);
    const adapter = requireAdapter(adapters, 'microdollar_usage_hourly');

    await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[1].text).toContain('WHERE organization_id = $1');
  });
});

describe('usage daily', () => {
  const USAGE_DAILY_ROW = { cursor_owner: 'org-9', country_code: 'NL' };

  it('emits the country and neither owner', async () => {
    const { adapters } = harness([USAGE_DAILY_ROW]);

    const page = await requireAdapter(adapters, 'usage_daily').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    expect(page?.records).toEqual([
      { source: 'usage_daily', id: 'NL', field: 'country_code', value: 'NL' },
    ]);
  });

  // Both warehouse indexes are expression indexes over these exact COALESCE forms, in this
  // order, so comparing the raw columns would scan instead of seeking.
  it('matches the expression indexes the warehouse built', async () => {
    const { adapters, warehouseCalls } = harness([USAGE_DAILY_ROW]);

    await requireAdapter(adapters, 'usage_daily').readPage?.(READ_PAGE_INPUT);

    expect(warehouseCalls[0].text).toContain(
      "(COALESCE(organization_id, '-'), COALESCE(country_code, '-')) > ($2::text, $3::text)"
    );
    expect(warehouseCalls[0].text).toContain(
      "ORDER BY COALESCE(organization_id, '-'), COALESCE(country_code, '-')"
    );
  });

  // The load has already deduplicated this table, so the grain is unique without our help.
  // Its sibling microdollar_usage_hourly has not, and carries its own DISTINCT.
  it('does not deduplicate, the load having done it', async () => {
    const { adapters, warehouseCalls } = harness([USAGE_DAILY_ROW]);

    await requireAdapter(adapters, 'usage_daily').readPage?.(READ_PAGE_INPUT);

    expect(warehouseCalls[0].text.startsWith('SELECT DISTINCT')).toBe(false);
  });

  it('pages on both columns the scope did not pin', async () => {
    const { adapters, warehouseCalls } = harness([USAGE_DAILY_ROW]);

    const page = await requireAdapter(adapters, 'usage_daily').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });
    await requireAdapter(adapters, 'usage_daily').readPage?.({
      ...READ_PAGE_INPUT,
      cursor: { key: ['org-9', 'NL'] },
    });

    expect(page?.nextCursor).toEqual({ key: ['org-9', 'NL'] });
    expect(warehouseCalls[1].values).toEqual(['owner-user', 'org-9', 'NL', 100]);
  });

  it('substitutes the sentinel in the cursor only', async () => {
    const { adapters } = harness([{ cursor_owner: null, country_code: 'NL' }]);

    const page = await requireAdapter(adapters, 'usage_daily').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    expect(page?.nextCursor).toEqual({ key: ['-', 'NL'] });
    expect(page?.records).toEqual([
      { source: 'usage_daily', id: 'NL', field: 'country_code', value: 'NL' },
    ]);
  });

  // `kilo_user_id` holds anon:<ip> values on this table, so it is a predicate and a cursor
  // value and never a returned field.
  it('scopes each read to one owner column and returns neither', async () => {
    const { adapters, warehouseCalls } = harness([USAGE_DAILY_ROW]);
    const adapter = requireAdapter(adapters, 'usage_daily');

    const page = await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);
    const fields = page?.records.map(record => record.field) ?? [];

    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[1].text).toContain('WHERE organization_id = $1');
    expect(fields).not.toContain('kilo_user_id');
    expect(fields).not.toContain('organization_id');
  });
});
