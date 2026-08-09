import { describe, expect, it } from 'vitest';
import { createSourceAdapters, sourceQueries } from './source-adapters';
import type { SourceAdapter } from './source-adapters';

function requireAdapter(adapters: SourceAdapter[], name: string): SourceAdapter {
  const adapter = adapters.find(candidate => candidate.name === name);
  if (!adapter) throw new Error(`Missing test adapter: ${name}`);
  return adapter;
}

describe('source adapters', () => {
  it('uses direct project ownership and user-filtered usage traversal', () => {
    expect(sourceQueries.userQuery).toContain('FROM kilocode_users');
    expect(sourceQueries.userQuery).toContain('WHERE id = $1');
    expect(sourceQueries.projectQuery).toContain('owned_by_user_id = $1');
    expect(sourceQueries.projectQuery).not.toContain('created_by_user_id');
    expect(sourceQueries.promptQuery).toContain('FROM microdollar_usage AS mu');
    expect(sourceQueries.promptQuery).toContain('mu.kilo_user_id = $1');
  });

  it('reports unresolved sources as disabled without querying them', () => {
    const adapters = createSourceAdapters(async () => []);
    expect(adapters.filter(adapter => !adapter.readPage)).toEqual([
      { name: 'app_builder_messages', disabledReason: 'source_table_dropped' },
      { name: 'numbered_cli_journal', disabledReason: 'source_not_found' },
    ]);
  });

  it('keeps persisted adapter names unique and separate from record source labels', () => {
    const names = createSourceAdapters(async () => []).map(adapter => adapter.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('microdollar_usage_prompts');
    expect(names).not.toContain('microdollar_usage_metadata');
    expect(names).not.toContain('system_prompt_prefix');
  });

  it('passes the authenticated owner to the project query and maps returned titles', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const projects = requireAdapter(
      createSourceAdapters(async (text, values) => {
        calls.push({ text, values });
        return [
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            title: 'Owned project',
            created_at: '2026-08-08T12:00:00.000000Z',
          },
        ];
      }),
      'app_builder_projects'
    );

    const page = await projects.readPage?.({
      kiloUserId: 'owner-user',
      snapshotAt: '2026-08-08T13:00:00.000Z',
      cursor: null,
      limit: 100,
    });

    expect(calls).toEqual([
      {
        text: expect.stringContaining('owned_by_user_id = $1'),
        values: ['owner-user', '2026-08-08T13:00:00.000Z', null, null, 100],
      },
    ]);
    expect(page?.records).toEqual([
      { source: 'app_builder_projects', field: 'title', value: 'Owned project' },
    ]);
  });

  it('normalizes PostgreSQL timestamps before persisting a source cursor', async () => {
    const projects = requireAdapter(
      createSourceAdapters(async () => [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          title: 'Owned project',
          created_at: '2026-08-08T12:00:00.123456Z',
        },
      ]),
      'app_builder_projects'
    );

    const page = await projects.readPage?.({
      kiloUserId: 'owner-user',
      snapshotAt: '2026-08-08T13:00:00.000Z',
      cursor: null,
      limit: 1,
    });

    expect(page?.nextCursor).toEqual({
      createdAt: '2026-08-08T12:00:00.123456Z',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
  });

  it('maps prompt fields only from rows returned by the user-filtered usage query', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const prompts = requireAdapter(
      createSourceAdapters(async (text, values) => {
        calls.push({ text, values });
        return [
          {
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            created_at: '2026-08-08T12:00:00.000000Z',
            user_prompt_prefix: 'User prompt',
            system_prompt_prefix: 'System prompt',
          },
        ];
      }),
      'microdollar_usage_prompts'
    );

    const page = await prompts.readPage?.({
      kiloUserId: 'owner-user',
      snapshotAt: '2026-08-08T13:00:00.000Z',
      cursor: null,
      limit: 100,
    });

    expect(calls).toEqual([
      {
        text: expect.stringContaining('mu.kilo_user_id = $1'),
        values: ['owner-user', '2026-08-08T13:00:00.000Z', null, null, 100],
      },
    ]);
    expect(page?.records).toEqual([
      {
        source: 'microdollar_usage_metadata',
        field: 'user_prompt_prefix',
        value: 'User prompt',
      },
      {
        source: 'system_prompt_prefix',
        field: 'system_prompt_prefix',
        value: 'System prompt',
      },
    ]);
  });

  it('exports the matched Kilo user columns with their JSON value types', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const user = requireAdapter(
      createSourceAdapters(async (text, values) => {
        calls.push({ text, values });
        return [
          {
            id: 'user-id',
            google_user_email: 'user@example.com',
            google_user_name: 'User Name',
            google_user_image_url: 'https://example.com/avatar.png',
            created_at: '2026-01-02 03:04:05+00',
            updated_at: new Date('2026-02-03T04:05:06.000Z'),
            hosted_domain: null,
            microdollars_used: '123',
            total_microdollars_acquired: 456n,
            next_credit_expiration_at: '2026-09-01 00:00:00+00',
            auto_top_up_enabled: true,
            default_model: null,
            completed_welcome_form: false,
            linkedin_url: 'https://linkedin.com/in/user',
            github_url: null,
            discord_server_membership_verified_at: null,
            openrouter_upstream_safety_identifier: 'upstream-id',
            openrouter_downstream_safety_identifier: null,
            vercel_downstream_safety_identifier: 'vercel-id',
            customer_source: 'organic',
            signup_ip: '203.0.113.1',
            normalized_email: 'user@example.com',
            email_domain: 'example.com',
          },
        ];
      }),
      'kilocode_users'
    );

    const page = await user?.readPage?.({
      kiloUserId: 'user-id',
      snapshotAt: '2026-08-03T00:00:00.000Z',
      cursor: null,
      limit: 100,
    });

    expect(calls).toEqual([
      { text: expect.stringContaining('WHERE id = $1'), values: ['user-id'] },
    ]);
    expect(page?.records).toEqual([
      { source: 'kilocode_users', field: 'id', value: 'user-id' },
      {
        source: 'kilocode_users',
        field: 'google_user_email',
        value: 'user@example.com',
      },
      { source: 'kilocode_users', field: 'google_user_name', value: 'User Name' },
      {
        source: 'kilocode_users',
        field: 'google_user_image_url',
        value: 'https://example.com/avatar.png',
      },
      { source: 'kilocode_users', field: 'created_at', value: '2026-01-02T03:04:05.000Z' },
      { source: 'kilocode_users', field: 'updated_at', value: '2026-02-03T04:05:06.000Z' },
      { source: 'kilocode_users', field: 'hosted_domain', value: null },
      { source: 'kilocode_users', field: 'microdollars_used', value: 123 },
      { source: 'kilocode_users', field: 'total_microdollars_acquired', value: 456 },
      {
        source: 'kilocode_users',
        field: 'next_credit_expiration_at',
        value: '2026-09-01T00:00:00.000Z',
      },
      { source: 'kilocode_users', field: 'auto_top_up_enabled', value: true },
      { source: 'kilocode_users', field: 'default_model', value: null },
      { source: 'kilocode_users', field: 'completed_welcome_form', value: false },
      {
        source: 'kilocode_users',
        field: 'linkedin_url',
        value: 'https://linkedin.com/in/user',
      },
      { source: 'kilocode_users', field: 'github_url', value: null },
      {
        source: 'kilocode_users',
        field: 'discord_server_membership_verified_at',
        value: null,
      },
      {
        source: 'kilocode_users',
        field: 'openrouter_upstream_safety_identifier',
        value: 'upstream-id',
      },
      {
        source: 'kilocode_users',
        field: 'openrouter_downstream_safety_identifier',
        value: null,
      },
      {
        source: 'kilocode_users',
        field: 'vercel_downstream_safety_identifier',
        value: 'vercel-id',
      },
      { source: 'kilocode_users', field: 'customer_source', value: 'organic' },
      { source: 'kilocode_users', field: 'signup_ip', value: '203.0.113.1' },
      {
        source: 'kilocode_users',
        field: 'normalized_email',
        value: 'user@example.com',
      },
      { source: 'kilocode_users', field: 'email_domain', value: 'example.com' },
    ]);
    expect(page?.nextCursor).toBeNull();
  });

  it('rejects unsafe bigint values instead of losing precision', async () => {
    const user = requireAdapter(
      createSourceAdapters(async () => [
        {
          id: 'user-id',
          google_user_email: 'user@example.com',
          google_user_name: 'User',
          google_user_image_url: '',
          created_at: new Date(),
          updated_at: new Date(),
          hosted_domain: null,
          microdollars_used: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
          total_microdollars_acquired: 0n,
          next_credit_expiration_at: null,
          auto_top_up_enabled: false,
          default_model: null,
          completed_welcome_form: false,
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
      ]),
      'kilocode_users'
    );

    await expect(
      user?.readPage?.({
        kiloUserId: 'user-id',
        snapshotAt: '2026-08-03T00:00:00.000Z',
        cursor: null,
        limit: 100,
      })
    ).rejects.toThrow('Replica row has unsafe microdollars_used');
  });
});
