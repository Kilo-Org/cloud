import { describe, expect, it } from 'vitest';
import {
  createSourceAdapters,
  sourceQueries,
  sourceQueryScopes,
  findPresentWarehouseTables,
  warehouseRequirements,
  DELETED_COLUMN,
  SOURCES_WITHOUT_DELETED_COLUMN,
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
  it('pairs every warehouse source with both subject variants', () => {
    const names = Object.keys(warehouseQueries);
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

  // Selecting the deletion column from a table that has none is an undefined-column
  // error at read time, after the source has already been declared present. This keeps
  // the list of tables without it tied to what the queries actually select.
  it.each(Object.entries(sourceQueries))(
    '%s selects the deletion column only where it exists',
    (_name, query) => {
      const readsTableWithoutColumn = SOURCES_WITHOUT_DELETED_COLUMN.some(table =>
        new RegExp(`FROM ${table}\\b`).test(query)
      );
      if (readsTableWithoutColumn) expect(query).not.toContain(DELETED_COLUMN);
    }
  );

  // The probe is only as good as what it asks about. A column selected by a query but
  // absent from the declaration would be read from a table the probe just called ready.
  it.each(Object.entries(WAREHOUSE_SOURCE_COLUMNS))(
    '%s declares every column its queries select',
    (table, declared) => {
      const queries = Object.entries(sourceQueries)
        .filter(([, query]) => new RegExp(`FROM ${table}\\b`).test(query))
        .map(([, query]) => query);
      expect(queries.length).toBeGreaterThan(0);
      for (const query of queries) {
        if (query.includes(DELETED_COLUMN)) expect(declared).toContain(DELETED_COLUMN);
      }
    }
  );

  it('requires the deletion column exactly where the source carries one', () => {
    const withoutColumn = new Set<string>(SOURCES_WITHOUT_DELETED_COLUMN);
    for (const [table, columns] of Object.entries(WAREHOUSE_SOURCE_COLUMNS)) {
      expect(columns.includes(DELETED_COLUMN)).toBe(!withoutColumn.has(table));
    }
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
      { table: 'audiences', requiredColumns: ['kilo_user_id', DELETED_COLUMN] },
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
      'system_prompt_prefix',
      'microdollar_usage_metadata',
      'code_indexing_manifest',
      'code_indexing_search',
      'deployment_events',
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
      'system_prompt_prefix',
      'microdollar_usage_metadata',
      'code_indexing_manifest',
      'code_indexing_search',
      'deployment_events',
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
    expect(messages.pageSize).toBe(200);
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
      { source: 'cli_sessions', id: '10.20', field: 'session_id', value: 'session-1' },
      { source: 'cli_sessions', id: '10.20', field: 'title', value: 'Session' },
      {
        source: 'cli_sessions',
        id: '10.20',
        field: 'git_url',
        value: 'git@example.com:acme/repo.git',
      },
      { source: 'cli_sessions', id: '10.20', field: 'git_branch', value: 'main' },
    ]);
  });

  it('keys repeated journal rows for one session by position, keeping every value', async () => {
    // 12% of real sessions change values across their journal rows, so the rows are
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
      { source: 'cli_sessions', id: '10.1', field: 'git_branch', value: 'main' },
      { source: 'cli_sessions', id: '10.2', field: 'git_branch', value: 'feature/x' },
    ]);

    // Same session, distinguishable rows.
    const sessionIds = page?.records.filter(record => record.field === 'session_id');
    expect(sessionIds?.map(record => record.value)).toEqual(['session-1', 'session-1']);
    expect(sessionIds?.map(record => record.id)).toEqual(['10.1', '10.2']);
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

  it('marks a deleted row and leaves a live one unmarked', async () => {
    const { adapters } = harness([
      { id: 'project-live', title: 'Live', _snowflake_deleted: false },
      { id: 'project-gone', title: 'Deleted', _snowflake_deleted: true },
      // Unknown state: the table's reload has not run. Not deleted as far as we can say.
      { id: 'project-unknown', title: 'Unknown', _snowflake_deleted: null },
    ]);

    const page = await requireAdapter(adapters, 'app_builder_projects').readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toEqual([
      { source: 'app_builder_projects', id: 'project-live', field: 'title', value: 'Live' },
      {
        source: 'app_builder_projects',
        id: 'project-gone',
        field: 'title',
        value: 'Deleted',
        softDeleted: true,
      },
      { source: 'app_builder_projects', id: 'project-unknown', field: 'title', value: 'Unknown' },
    ]);
  });

  // Deleted rows are returned, not filtered. The export is a truthful copy of what the
  // warehouse holds, so a deleted project still reaches the person it belonged to.
  it('returns deleted rows rather than dropping them', async () => {
    const { adapters, warehouseCalls } = harness([
      { id: 'project-gone', title: 'Deleted', _snowflake_deleted: true },
    ]);

    const page = await requireAdapter(adapters, 'app_builder_projects').readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toHaveLength(1);
    expect(warehouseCalls[0].text).not.toContain('_snowflake_deleted IS NOT TRUE');
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

  it('marks every field of a manifest row prod has since deleted', async () => {
    const { adapters } = harness([{ ...MANIFEST_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'code_indexing_manifest').readPage?.(
      READ_PAGE_INPUT
    );

    expect(page?.records).toHaveLength(3);
    for (const record of page?.records ?? []) expect(record.softDeleted).toBe(true);
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

  it('emits the four search fields per row, keyed by the row that carried them', async () => {
    const { adapters } = harness([SEARCH_ROW]);

    const page = await requireAdapter(adapters, 'code_indexing_search').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    // One id across all four, so a search, what it ran against, what it returned and when
    // it ran stay groupable as one event.
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
      {
        source: 'code_indexing_search',
        id: 'search-1',
        field: 'created_at',
        value: '2026-07-04T09:15:00.000Z',
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

  it('marks every field of a search row prod has since deleted', async () => {
    const { adapters } = harness([{ ...SEARCH_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'code_indexing_search').readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toHaveLength(4);
    for (const record of page?.records ?? []) expect(record.softDeleted).toBe(true);
  });

  // Reads fewer rows per page than the default, because a row carries a whole result set.
  it('cuts the search page size, as the message source does', async () => {
    const { adapters } = harness([SEARCH_ROW]);

    expect(requireAdapter(adapters, 'code_indexing_search').pageSize).toBe(200);
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
    created_by_user_id: 'creator-user',
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
    expect(byField.get('event_type')).toBe('build.succeeded');
    expect(byField.get('event_timestamp')).toBe('2026-07-04T09:15:00.000Z');
    expect(byField.get('payload')).toBe(JSON.stringify({ status: 'ok' }));
    expect(page?.nextCursor).toEqual({ key: ['build-a', '7'] });
  });

  // The one source with a third user column. `created_by_user_id` is provenance, and on
  // an org-owned deployment it names a member rather than the owner. Scoping a user read
  // on it would hand that member the organization's deployment history as their own, so
  // it must appear in the SELECT list and never in the WHERE clause.
  it('exports the deployment creator without ever scoping on it', async () => {
    const { adapters, warehouseCalls } = harness([DEPLOYMENT_EVENT_ROW]);
    const adapter = requireAdapter(adapters, 'deployment_events');

    await adapter.readPage?.(READ_PAGE_INPUT);
    await adapter.readPage?.(ORG_READ_PAGE_INPUT);

    for (const call of warehouseCalls) {
      expect(call.text).not.toContain('WHERE created_by_user_id');
      expect(call.text).not.toContain('created_by_user_id = $');
    }
    expect(warehouseCalls[0].text).toContain('WHERE kilo_user_id = $1');
    expect(warehouseCalls[1].text).toContain('WHERE organization_id = $1');
    const page = await adapter.readPage?.(READ_PAGE_INPUT);
    expect(page?.records.find(record => record.field === 'created_by_user_id')?.value).toBe(
      'creator-user'
    );
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

  it('marks every field of a deployment event prod has since deleted', async () => {
    const { adapters } = harness([{ ...DEPLOYMENT_EVENT_ROW, _snowflake_deleted: true }]);

    const page = await requireAdapter(adapters, 'deployment_events').readPage?.(READ_PAGE_INPUT);

    expect(page?.records).toHaveLength(6);
    for (const record of page?.records ?? []) expect(record.softDeleted).toBe(true);
  });

  // The joined columns come from a LEFT JOIN through deployment_builds to deployments, so
  // an absent parent row is a null field rather than a failed export.
  it('reads an unjoined deployment event as absent rather than failing the export', async () => {
    const { adapters } = harness([
      { ...DEPLOYMENT_EVENT_ROW, deployment_id: null, event_type: null },
    ]);

    const page = await requireAdapter(adapters, 'deployment_events').readPage?.(READ_PAGE_INPUT);
    const byField = new Map(page?.records.map(record => [record.field, record.value]));

    expect(byField.get('deployment_id')).toBeNull();
    expect(byField.get('event_type')).toBeNull();
    expect(byField.get('build_id')).toBe('build-a');
  });
});
