import { describe, expect, it } from 'vitest';
import { createSourceAdapters, sourceQueries } from './source-adapters';

describe('source adapters', () => {
  it('uses direct project ownership and user-filtered usage traversal', () => {
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
    const [projects] = createSourceAdapters(async (text, values) => {
      calls.push({ text, values });
      return [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          title: 'Owned project',
          created_at: '2026-08-08T12:00:00.000Z',
        },
      ];
    });

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
    const [projects] = createSourceAdapters(async () => [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        title: 'Owned project',
        created_at: '2026-08-08 12:00:00+00',
      },
    ]);

    const page = await projects.readPage?.({
      kiloUserId: 'owner-user',
      snapshotAt: '2026-08-08T13:00:00.000Z',
      cursor: null,
      limit: 1,
    });

    expect(page?.nextCursor).toEqual({
      createdAt: '2026-08-08T12:00:00.000Z',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
  });

  it('maps prompt fields only from rows returned by the user-filtered usage query', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const prompts = createSourceAdapters(async (text, values) => {
      calls.push({ text, values });
      return [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          created_at: '2026-08-08T12:00:00.000Z',
          user_prompt_prefix: 'User prompt',
          system_prompt_prefix: 'System prompt',
        },
      ];
    })[1];

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
});
