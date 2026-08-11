import { describe, expect, it } from 'vitest';
import {
  createSourceAdapters,
  sourceQueries,
  sourceQueryScopes,
  USER_SCOPE_PREDICATES,
  warehouseQueries,
  type ReplicaQuery,
  type SourceAdapter,
} from './source-adapters';
import { TerminalExportError } from './errors';

type Call = { text: string; values: unknown[] };

function harness(rows: Record<string, unknown>[] = []) {
  const warehouseCalls: Call[] = [];
  const warehouseQuery: ReplicaQuery = async (text, values) => {
    warehouseCalls.push({ text, values });
    return rows;
  };
  return {
    warehouseCalls,
    adapters: createSourceAdapters({ warehouseQuery }),
  };
}

function requireAdapter(adapters: SourceAdapter[], name: string): SourceAdapter {
  const adapter = adapters.find(candidate => candidate.name === name);
  if (!adapter) throw new Error(`Missing test adapter: ${name}`);
  return adapter;
}

const READ_PAGE_INPUT = {
  kiloUserId: 'owner-user',
  snapshotAt: '2026-08-08T13:00:00.000Z',
  cursor: null,
  limit: 100,
} as const;

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
  // a user. Without this, a source could be added with any predicate its author cared
  // to name and satisfy the assertion below by agreeing with itself.
  it.each(Object.entries(sourceQueryScopes))('%s declares a known user scope', (_name, scope) => {
    expect(USER_SCOPE_PREDICATES).toContain(scope);
  });

  // Membership in the closed set is not enough on its own: the two predicates are not
  // interchangeable. `id = $1` scopes to a user only on a table whose primary key is the
  // user id; on an owned child table it matches the row's own key rather than its owner,
  // so an owned-row source that picked it would be filtering on the wrong column while
  // still passing the membership and containment checks. Bind it to the table shape it is
  // valid for, tested on the query text rather than the export's name.
  it.each(Object.entries(sourceQueries))('%s pairs its predicate with its table', (name, query) => {
    const predicate = sourceQueryScopes[name as keyof typeof sourceQueries];
    if (predicate === 'id = $1') {
      expect(query).toMatch(/FROM users\b/);
    } else {
      expect(predicate).toBe('kilo_user_id = $1');
    }
  });

  // Anchored on WHERE because `id = $1` is a substring of every `<table>_id = $1`:
  // an unanchored match would accept `organization_id = $1` as if it scoped to a user.
  it.each(Object.entries(sourceQueries))('%s is scoped to a single user', (name, query) => {
    const predicate = sourceQueryScopes[name as keyof typeof sourceQueries];
    expect(predicate).toBeDefined();
    expect(query).toContain(`WHERE ${predicate}`);
  });

  it.each(Object.entries(warehouseQueries))('%s orders and limits its page', (_name, query) => {
    expect(query).toContain('ORDER BY');
    expect(query).toContain('LIMIT');
  });

  it('never joins the warehouse to the live primary or reads loader bookkeeping', () => {
    for (const query of Object.values(sourceQueries)) {
      expect(query).not.toContain('kilocode_users');
      expect(query).not.toContain('load_manifest');
    }
  });

  it('reads identity from the warehouse, scoped to the row the user owns', () => {
    expect(sourceQueries.userQuery).toContain('FROM users');
    expect(sourceQueries.userQuery).toContain('WHERE id = $1');
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
    ]);
  });

  it('keeps persisted adapter names unique', () => {
    const names = harness().adapters.map(adapter => adapter.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('reads identity from the warehouse, scoped by the row id', async () => {
    const { adapters, warehouseCalls } = harness([
      {
        id: 'user-1',
        google_user_email: 'a@example.com',
        google_user_name: 'A',
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
      },
    ]);

    await requireAdapter(adapters, 'kilocode_users').readPage?.(READ_PAGE_INPUT);

    expect(warehouseCalls).toEqual([
      { text: expect.stringContaining('WHERE id = $1'), values: ['owner-user'] },
    ]);
  });

  // A row absent from the warehouse is permanent for the life of a snapshot, so this
  // must fail on the first attempt rather than consume the queue's retries. Asserted on
  // the class because that is what `handleGenerationFailure` branches on to mark the
  // export failed instead of releasing it for retry.
  it('fails terminally when the warehouse holds no identity row', async () => {
    const { adapters } = harness([]);

    await expect(
      requireAdapter(adapters, 'kilocode_users').readPage?.(READ_PAGE_INPUT)
    ).rejects.toBeInstanceOf(TerminalExportError);
  });

  it('reports a missing identity row with a code and a message fit to show the requester', async () => {
    const { adapters } = harness([]);

    const error = await requireAdapter(adapters, 'kilocode_users')
      .readPage?.(READ_PAGE_INPUT)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TerminalExportError);
    const terminal = error as TerminalExportError;
    expect(terminal.failureCode).toBe('export_identity_row_missing');
    expect(terminal.redactedMessage).toContain('not found in the data snapshot');
    // The requester's id identifies a person and is carried on the log event already.
    expect(terminal.message).not.toContain(READ_PAGE_INPUT.kiloUserId);
    expect(terminal.redactedMessage).not.toContain(READ_PAGE_INPUT.kiloUserId);
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
      { source: 'app_builder_projects', field: 'title', value: 'Owned project' },
    ]);
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

  it('emits system prompts as their own set, keyed by prefix id', async () => {
    const { adapters } = harness([
      { system_prompt_prefix_id: '42', system_prompt_prefix: 'System prompt' },
    ]);

    const page = await requireAdapter(adapters, 'system_prompt_prefix').readPage?.({
      ...READ_PAGE_INPUT,
      limit: 1,
    });

    expect(page?.records).toEqual([
      { source: 'system_prompt_prefix', field: 'system_prompt_prefix', value: 'System prompt' },
    ]);
    expect(page?.nextCursor).toEqual({ key: ['42'] });
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
});
