import { getWorkerDb } from '@kilocode/db/client';
import { describe, expect, it, vi } from 'vitest';
import type { RouteRecord } from './routes.js';
import {
  createWorkspaceHistoryReader,
  workspaceHistorySessionsQuery,
} from './workspace-history.js';

const workspaceId = 'worktree_6a7199ec-d6d7-4788-b5a5-d74960f401e3';
const route: RouteRecord = {
  sessionId: 'workspace_anchor',
  spec: {
    sessionId: 'workspace_anchor',
    kiloSessionId: `ses_${'a'.repeat(26)}`,
    directory: '/workspace/project',
    attemptId: 'attempt',
    runtimeIsolation: 'per-session',
    kilo: {
      scopeId: workspaceId,
      token: 'test-token',
      targets: {
        backendBaseUrl: 'https://backend.test',
        providerBaseUrl: 'https://provider.test',
        sessionIngestBaseUrl: 'https://ingest.test',
      },
    },
  },
  credentialSource: {
    userId: 'oauth/example',
    kiloSessionId: `ses_${'a'.repeat(26)}`,
    kiloToken: 'test-token',
  },
  state: 'preparing',
  grant: null,
  environment: null,
  attemptId: 'attempt',
  attemptDeadlineAt: 100,
  reason: null,
};

// Only render SQL: these policy checks do not need a running PostgreSQL server.
const db = getWorkerDb('postgres://unused:unused@localhost/unused');

describe('workspace history ownership query', () => {
  it('accepts production stored routes retaining the runtime isolation compatibility field', () => {
    expect(route.spec.runtimeIsolation).toBe('per-session');
    expect(workspaceHistorySessionsQuery(db, route)).not.toBeNull();
  });
  it('selects the five most recently updated root chats, with a deterministic tie-breaker', () => {
    const query = workspaceHistorySessionsQuery(db, route)?.toSQL();
    expect(query?.sql).toContain(
      'order by "cli_sessions_v2"."updated_at" desc, "cli_sessions_v2"."session_id" desc'
    );
    expect(query?.params.at(-1)).toBe(5);
    expect(query?.sql).toContain('"cli_sessions_v2"."parent_session_id" is null');
    expect(query?.sql).toContain('"cli_sessions_v2"."cloud_agent_session_id" is not null');
    expect(query?.sql).toContain('"cloud_agent_worktrees"."deletion_started_at" is null');
  });

  it('checks workspace, owner and personal scope for the anchor, target and workspace ledger', () => {
    const query = workspaceHistorySessionsQuery(db, route)?.toSQL();
    for (const table of ['anchor', 'cli_sessions_v2', 'cloud_agent_worktrees']) {
      expect(query?.sql).toContain(`"${table}"."kilo_user_id" =`);
      expect(query?.sql).toContain(`"${table}"."organization_id" is null`);
    }
    expect(query?.sql).toContain('exists (select');
    expect(query?.sql).toContain('"anchor"."cloud_agent_session_id" =');
    expect(query?.sql).toContain('"anchor"."session_id" =');
    expect(query?.sql).toContain('"anchor"."cloud_agent_worktree_id" =');
    expect(query?.sql).toContain('"cli_sessions_v2"."cloud_agent_worktree_id" =');
    expect(query?.params.filter(value => value === 'oauth/example')).toHaveLength(3);
    expect(query?.params.filter(value => value === workspaceId)).toHaveLength(2);
    expect(query?.params).toContain(route.sessionId);
    expect(query?.params).toContain(route.spec.kiloSessionId);
  });

  it('requires the exact organization and both target session ids on sibling page reads', () => {
    const orgId = '777b0ec6-4261-4bf0-ae06-b0c466ca49a3';
    const target = { sessionId: 'workspace_sibling', kiloSessionId: `ses_${'b'.repeat(26)}` };
    const scoped = { ...route, credentialSource: { ...route.credentialSource!, orgId } };
    const query = workspaceHistorySessionsQuery(db, scoped, target)?.toSQL();
    expect(query?.params.filter(value => value === orgId)).toHaveLength(3);
    expect(query?.params).toContain(target.sessionId);
    expect(query?.params).toContain(target.kiloSessionId);
    expect(query?.params.at(-1)).toBe(1);
    expect(query?.sql).not.toContain('"organization_id" is null');
  });

  it.each([
    { ...route, credentialSource: null },
    { ...route, state: 'failed' as const },
    {
      ...route,
      spec: { ...route.spec, kilo: { ...route.spec.kilo!, scopeId: 'not-a-workspace' } },
    },
  ])('does not authorize a missing, failed or invalid workspace route (%j)', candidate => {
    expect(workspaceHistorySessionsQuery(db, candidate)).toBeNull();
  });
});

describe('workspace history preload authorization', () => {
  const target = { sessionId: 'workspace_sibling', kiloSessionId: `ses_${'b'.repeat(26)}` };

  it('authorizes all discovered sibling pages with one ledger read during the preload', async () => {
    const read = vi.fn(async () => [target]);
    const reader = createWorkspaceHistoryReader(read);
    expect(await reader.readRecent(route)).toEqual([target]);
    for (let page = 0; page < 10; page++) expect(await reader.authorize(route, target)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rechecks the ledger after ten seconds without extending the grant on page reads', async () => {
    let now = 0;
    const read = vi.fn(async () => [target]);
    const reader = createWorkspaceHistoryReader(read, () => now);
    await reader.readRecent(route);
    now = 9_999;
    expect(await reader.authorize(route, target)).toBe(true);
    now = 10_000;
    read.mockResolvedValue([]);
    expect(await reader.authorize(route, target)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(route, target);
  });

  it.each([
    { ...route, sessionId: 'workspace_other' },
    { ...route, attemptId: 'new-attempt' },
    { ...route, spec: { ...route.spec, kiloSessionId: 'ses_other' } },
    { ...route, spec: { ...route.spec, kilo: { ...route.spec.kilo!, scopeId: 'other' } } },
    { ...route, credentialSource: { ...route.credentialSource!, userId: 'oauth/other' } },
    { ...route, credentialSource: { ...route.credentialSource!, orgId: 'other-org' } },
    { ...route, credentialSource: null },
  ])('does not reuse authorization for a changed route (%j)', async changed => {
    const read = vi.fn(async () => [target]);
    const reader = createWorkspaceHistoryReader(read);
    await reader.readRecent(route);
    read.mockResolvedValue([]);
    expect(await reader.authorize(changed, target)).toBe(false);
    expect(read).toHaveBeenLastCalledWith(changed, target);
  });

  it('denies failed routes and rechecks undiscovered or mismatched native sessions', async () => {
    const read = vi.fn(async () => [target]);
    const reader = createWorkspaceHistoryReader(read);
    await reader.readRecent(route);
    expect(await reader.authorize({ ...route, state: 'failed' }, target)).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue([]);
    const other = { ...target, kiloSessionId: 'ses_other' };
    expect(await reader.authorize(route, other)).toBe(false);
    expect(read).toHaveBeenLastCalledWith(route, other);
  });

  it('does not reuse discovery across sockets or cache discovery failures', async () => {
    const read = vi.fn(async () => [target]);
    const first = createWorkspaceHistoryReader(read);
    const second = createWorkspaceHistoryReader(read);
    await first.readRecent(route);
    read.mockRejectedValueOnce(new Error('unavailable'));
    await expect(second.readRecent(route)).rejects.toThrow('unavailable');
    read.mockResolvedValue([]);
    expect(await second.authorize(route, target)).toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
