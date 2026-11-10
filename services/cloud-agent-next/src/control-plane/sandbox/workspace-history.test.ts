import { getWorkerDb } from '@kilocode/db/client';
import { describe, expect, it } from 'vitest';
import type { RouteRecord } from './routes.js';
import { workspaceHistorySessionsQuery } from './workspace-history.js';

const workspaceId = 'worktree_6a7199ec-d6d7-4788-b5a5-d74960f401e3';
const route: RouteRecord = {
  sessionId: 'workspace_anchor',
  spec: {
    sessionId: 'workspace_anchor',
    kiloSessionId: `ses_${'a'.repeat(26)}`,
    directory: '/workspace/project',
    attemptId: 'attempt',
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
    { ...route, spec: { ...route.spec, runtimeIsolation: 'per-session' as const } },
    {
      ...route,
      spec: { ...route.spec, kilo: { ...route.spec.kilo!, scopeId: 'not-a-workspace' } },
    },
  ])('does not authorize a missing, failed or non-shared workspace route (%j)', candidate => {
    expect(workspaceHistorySessionsQuery(db, candidate)).toBeNull();
  });
});
