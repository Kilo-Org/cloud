import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as WorkerUtils from '@kilocode/worker-utils';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const workerUtils = vi.hoisted(() => ({ hasOrganizationAccess: vi.fn() }));
vi.mock('@kilocode/worker-utils', async importOriginal => ({
  ...(await importOriginal<typeof WorkerUtils>()),
  hasOrganizationAccess: workerUtils.hasOrganizationAccess,
}));

import type { CloudAgentSessionScopeV2 } from '@kilocode/session-ingest-contracts';
import {
  encodeCloudAgentSessionScopeV2Headers,
  parseCloudAgentSessionScopeV2Headers,
} from '@kilocode/session-ingest-contracts';
import {
  CLOUD_AGENT_SCOPE_MAX_ANCESTRY_DEPTH,
  resolveScopedChildSession,
  resolveScopedCreateParent,
  type AncestryNode,
} from './cloud-agent-worktree-scope';

const userId = 'usr_test';
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const organizationId = '33333333-3333-4333-8333-333333333333';
const memberRootId = 'ses_11111111111111111111111111';
const otherRootId = 'ses_22222222222222222222222222';
const childId = 'ses_33333333333333333333333333';
const grandchildId = 'ses_44444444444444444444444444';

const scope: CloudAgentSessionScopeV2 = {
  worktreeId,
  organizationId,
  memberRootKiloSessionIds: [memberRootId],
};

function node(overrides: Partial<AncestryNode> & Pick<AncestryNode, 'sessionId'>): AncestryNode {
  return {
    parentSessionId: null,
    cloudAgentSessionId: null,
    cloudAgentSessionScopeId: null,
    ...overrides,
  };
}

function childRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: childId,
    parentSessionId: memberRootId,
    organizationId,
    cloudAgentSessionId: null,
    cloudAgentSessionScopeId: 'workspace_scope',
    cloudAgentWorktreeId: worktreeId,
    ...overrides,
  };
}

function makeScopeDb() {
  const selectConditions: SQL[] = [];
  const selectResults: unknown[][] = [];
  const ancestryQueries: SQL[] = [];

  function makeSelect() {
    const chain = {
      from: () => chain,
      where: (condition: SQL) => {
        selectConditions.push(condition);
        return chain;
      },
      limit: () => chain,
      for: () => chain,
      orderBy: () => chain,
      then: (resolve: (rows: unknown[]) => unknown) => resolve(selectResults.shift() ?? []),
    };
    return chain;
  }

  return {
    db: {
      select: vi.fn(makeSelect),
      execute: vi.fn(async (query: SQL) => {
        ancestryQueries.push(query);
        return { rows: selectResults.shift() ?? [] };
      }),
    } as never,
    selectConditions,
    ancestryQueries,
    pushRow: (row: unknown | null) => selectResults.push(row === null ? [] : [row]),
    pushRows: (...rows: unknown[]) => selectResults.push(rows),
  };
}

function queryOf(condition: SQL) {
  return new PgDialect().sqlToQuery(condition);
}

function expectedScopedLookupSql(organizationId: string | null): string {
  return organizationId === null
    ? `("cli_sessions_v2"."session_id" = $1 and ("cli_sessions_v2"."kilo_user_id" = $2 and "cli_sessions_v2"."organization_id" is null and "cli_sessions_v2"."cloud_agent_worktree_id" = $3))`
    : `("cli_sessions_v2"."session_id" = $1 and ("cli_sessions_v2"."kilo_user_id" = $2 and "cli_sessions_v2"."organization_id" = $3 and "cli_sessions_v2"."cloud_agent_worktree_id" = $4))`;
}

describe('resolveScopedChildSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    workerUtils.hasOrganizationAccess.mockResolvedValue(true);
  });

  it('scopes the target lookup by owner, asserted organization, and worktree', async () => {
    const fake = makeScopeDb();
    fake.pushRow(null);

    await resolveScopedChildSession(fake.db, { kiloUserId: userId, sessionId: childId, scope });

    expect(fake.selectConditions).toHaveLength(1);
    const query = queryOf(fake.selectConditions[0]);
    expect(query.sql).toBe(expectedScopedLookupSql(organizationId));
    expect(query.params).toEqual([childId, userId, organizationId, worktreeId]);
  });

  it('encodes a personal asserted organization as IS NULL, not any organization', async () => {
    const fake = makeScopeDb();
    fake.pushRow(null);

    await resolveScopedChildSession(fake.db, {
      kiloUserId: userId,
      sessionId: childId,
      scope: { ...scope, organizationId: null },
    });

    const query = queryOf(fake.selectConditions[0]);
    expect(query.sql).toBe(expectedScopedLookupSql(null));
    expect(query.params).toEqual([childId, userId, worktreeId]);
  });

  it('denies a root row on the scoped path without walking ancestry', async () => {
    const fake = makeScopeDb();
    fake.pushRow(childRow({ parentSessionId: null }));
    const result = await resolveScopedChildSession(fake.db, {
      kiloUserId: userId,
      sessionId: childId,
      scope,
    });
    expect(result.kind).toBe('denied');
    expect(fake.selectConditions).toHaveLength(1);
  });

  it('denies before reading the row when the asserted organization has no current membership', async () => {
    workerUtils.hasOrganizationAccess.mockResolvedValue(false);
    const fake = makeScopeDb();
    const result = await resolveScopedChildSession(fake.db, {
      kiloUserId: userId,
      sessionId: childId,
      scope,
    });
    expect(result.kind).toBe('denied');
    expect(fake.selectConditions).toHaveLength(0);
  });

  it('authorizes a child whose bounded walk reaches an asserted member root', async () => {
    const fake = makeScopeDb();
    fake.pushRow(childRow({ cloudAgentSessionScopeId: 'workspace_root' }));
    fake.pushRow(
      node({
        sessionId: memberRootId,
        cloudAgentSessionId: 'workspace_root',
        cloudAgentSessionScopeId: null,
      })
    );
    const result = await resolveScopedChildSession(fake.db, {
      kiloUserId: userId,
      sessionId: childId,
      scope,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.rootScopeId).toBe('workspace_root');
    expect(fake.selectConditions).toHaveLength(1);
    expect(fake.ancestryQueries).toHaveLength(1);
  });

  it('authorizes a grandchild through an intermediate child', async () => {
    const fake = makeScopeDb();
    fake.pushRow(
      childRow({
        sessionId: grandchildId,
        parentSessionId: childId,
        cloudAgentSessionScopeId: 'workspace_scope',
      })
    );
    fake.pushRow(
      node({
        sessionId: memberRootId,
        cloudAgentSessionId: 'workspace_scope',
        cloudAgentSessionScopeId: 'workspace_scope',
      })
    );
    const result = await resolveScopedChildSession(fake.db, {
      kiloUserId: userId,
      sessionId: grandchildId,
      scope,
    });
    expect(result.kind).toBe('ok');
  });

  it('denies when the walk reaches a root that is not an asserted member', async () => {
    const fake = makeScopeDb();
    fake.pushRow(childRow());
    fake.pushRow(node({ sessionId: otherRootId, cloudAgentSessionId: 'workspace_other' }));
    const result = await resolveScopedChildSession(fake.db, {
      kiloUserId: userId,
      sessionId: childId,
      scope,
    });
    expect(result.kind).toBe('denied');
  });

  it('denies when the child scope id does not match the reached member root scope', async () => {
    const fake = makeScopeDb();
    fake.pushRow(childRow({ cloudAgentSessionScopeId: 'workspace_stale' }));
    fake.pushRow(
      node({
        sessionId: memberRootId,
        cloudAgentSessionId: 'workspace_root',
        cloudAgentSessionScopeId: 'workspace_root',
      })
    );
    const result = await resolveScopedChildSession(fake.db, {
      kiloUserId: userId,
      sessionId: childId,
      scope,
    });
    expect(result.kind).toBe('denied');
  });
});

describe('resolveScopedCreateParent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    workerUtils.hasOrganizationAccess.mockResolvedValue(true);
  });

  it('resolves a member-root parent and uses the root cloud agent session id as scope', async () => {
    const fake = makeScopeDb();
    fake.pushRow(
      childRow({
        sessionId: memberRootId,
        parentSessionId: null,
        cloudAgentSessionId: 'workspace_root',
        cloudAgentSessionScopeId: null,
      })
    );
    const result = await resolveScopedCreateParent(fake.db, {
      kiloUserId: userId,
      parentSessionId: memberRootId,
      scope,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.memberRootScopeId).toBe('workspace_root');
    expect(result.parent.cloudAgentSessionScopeId).toBeNull();
  });

  it('resolves a child parent only when its walk reaches an asserted member root', async () => {
    const fake = makeScopeDb();
    fake.pushRow(childRow({ sessionId: childId, cloudAgentSessionScopeId: 'workspace_scope' }));
    fake.pushRow(
      node({
        sessionId: memberRootId,
        cloudAgentSessionId: 'workspace_scope',
        cloudAgentSessionScopeId: 'workspace_scope',
      })
    );
    const result = await resolveScopedCreateParent(fake.db, {
      kiloUserId: userId,
      parentSessionId: childId,
      scope,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.memberRoot.sessionId).toBe(memberRootId);
  });

  it('denies a root parent that is not an asserted member root', async () => {
    const fake = makeScopeDb();
    fake.pushRow(
      childRow({
        sessionId: otherRootId,
        parentSessionId: null,
        cloudAgentSessionId: 'workspace_other',
      })
    );
    const result = await resolveScopedCreateParent(fake.db, {
      kiloUserId: userId,
      parentSessionId: otherRootId,
      scope,
    });
    expect(result.kind).toBe('denied');
  });

  it('denies when the scoped parent lookup returns no owned row (cross-worktree, org, or user)', async () => {
    const fake = makeScopeDb();
    fake.pushRow(null);
    const result = await resolveScopedCreateParent(fake.db, {
      kiloUserId: userId,
      parentSessionId: childId,
      scope,
    });
    expect(result.kind).toBe('denied');
    const query = queryOf(fake.selectConditions[0]);
    expect(query.sql).toBe(expectedScopedLookupSql(organizationId));
    expect(query.params).toEqual([childId, userId, organizationId, worktreeId]);
  });

  it('scopes every ancestry hop by owner, asserted organization, and worktree', async () => {
    const fake = makeScopeDb();
    fake.pushRow(childRow({ sessionId: grandchildId, parentSessionId: childId }));
    fake.pushRow(
      node({
        sessionId: memberRootId,
        cloudAgentSessionId: 'workspace_scope',
        cloudAgentSessionScopeId: 'workspace_scope',
      })
    );
    await resolveScopedCreateParent(fake.db, {
      kiloUserId: userId,
      parentSessionId: grandchildId,
      scope,
    });
    expect(fake.selectConditions).toHaveLength(1);
    expect(fake.ancestryQueries).toHaveLength(1);
    const query = queryOf(fake.ancestryQueries[0]);
    expect(query.sql).toContain('WITH RECURSIVE ancestry');
    expect(query.sql).toContain('parent.kilo_user_id =');
    expect(query.sql).toContain('parent.organization_id =');
    expect(query.sql).toContain('parent.cloud_agent_worktree_id =');
    expect(query.sql).toContain('NOT (parent.session_id = ANY(ancestry.path))');
    expect(query.params).toEqual([
      childId,
      userId,
      organizationId,
      worktreeId,
      userId,
      organizationId,
      worktreeId,
      CLOUD_AGENT_SCOPE_MAX_ANCESTRY_DEPTH,
    ]);
  });
});

describe('Cloud Agent session scope v2 header codec', () => {
  it('round-trips an organization scope', () => {
    const input: CloudAgentSessionScopeV2 = {
      worktreeId,
      organizationId,
      memberRootKiloSessionIds: [memberRootId, otherRootId],
    };
    expect(
      parseCloudAgentSessionScopeV2Headers(encodeCloudAgentSessionScopeV2Headers(input))
    ).toEqual({ kind: 'ok', scope: input });
  });

  it('round-trips a personal scope as the explicit personal sentinel', () => {
    const input: CloudAgentSessionScopeV2 = {
      worktreeId,
      organizationId: null,
      memberRootKiloSessionIds: [memberRootId],
    };
    const headers = encodeCloudAgentSessionScopeV2Headers(input);
    expect(headers.expectedOrganization).toBe('personal');
    expect(parseCloudAgentSessionScopeV2Headers(headers)).toEqual({ kind: 'ok', scope: input });
  });

  it('de-duplicates repeated member roots', () => {
    const parsed = parseCloudAgentSessionScopeV2Headers({
      worktreeId,
      expectedOrganization: organizationId,
      memberRootKiloSessionIds: `${memberRootId},${memberRootId}`,
    });
    expect(parsed).toEqual({
      kind: 'ok',
      scope: {
        worktreeId,
        organizationId,
        memberRootKiloSessionIds: [memberRootId],
      },
    });
  });

  it.each([
    [
      'a missing worktree id',
      { expectedOrganization: organizationId, memberRootKiloSessionIds: memberRootId },
    ],
    ['a missing organization', { worktreeId, memberRootKiloSessionIds: memberRootId }],
    ['missing member roots', { worktreeId, expectedOrganization: organizationId }],
    [
      'a capitalized personal sentinel',
      { worktreeId, expectedOrganization: 'Personal', memberRootKiloSessionIds: memberRootId },
    ],
    [
      'an empty organization',
      { worktreeId, expectedOrganization: '', memberRootKiloSessionIds: memberRootId },
    ],
    [
      'a non-uuid organization',
      { worktreeId, expectedOrganization: 'org-a', memberRootKiloSessionIds: memberRootId },
    ],
    [
      'an empty member-root entry',
      { worktreeId, expectedOrganization: organizationId, memberRootKiloSessionIds: 'a,,b' },
    ],
    [
      'an empty member-root list',
      { worktreeId, expectedOrganization: organizationId, memberRootKiloSessionIds: '' },
    ],
  ])('rejects %s', (_label, input) => {
    expect(parseCloudAgentSessionScopeV2Headers(input)).toEqual({ kind: 'invalid' });
  });

  it('rejects a header block over 4096 bytes even when it de-duplicates to one member root', () => {
    const repeated = Array.from({ length: 140 }, () => memberRootId).join(',');
    expect(repeated.length).toBeGreaterThan(4096);
    expect(
      parseCloudAgentSessionScopeV2Headers({
        worktreeId,
        expectedOrganization: organizationId,
        memberRootKiloSessionIds: repeated,
      })
    ).toEqual({ kind: 'invalid' });
  });
});
