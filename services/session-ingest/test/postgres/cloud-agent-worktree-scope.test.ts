import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import type { CloudAgentSessionScopeV2 } from '@kilocode/session-ingest-contracts';
import { sql } from 'drizzle-orm';
import {
  CLOUD_AGENT_SCOPE_MAX_ANCESTRY_DEPTH,
  resolveScopedChildSession,
  resolveScopedCreateParent,
} from '../../src/services/cloud-agent-worktree-scope';

vi.mock('@kilocode/worker-utils', () => ({ hasOrganizationAccess: async () => true }));

const userId = 'oauth/scope-test';
const organizationId = '33333333-3333-4333-8333-333333333333';
const scope: CloudAgentSessionScopeV2 = {
  worktreeId: 'worktree_test',
  organizationId: null,
  memberRootKiloSessionIds: ['root'],
};
let client: ReturnType<typeof createDrizzleClient>;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('The scope tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  // A session-local table tests the real queries without changing shared data.
  await client.db.execute(sql`
    CREATE TEMP TABLE cli_sessions_v2 (
      session_id text NOT NULL,
      kilo_user_id text NOT NULL,
      parent_session_id text,
      organization_id uuid,
      cloud_agent_session_id text,
      cloud_agent_session_scope_id text,
      cloud_agent_worktree_id text,
      PRIMARY KEY (session_id, kilo_user_id)
    )
  `);
});

afterAll(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await client.db.execute(sql`TRUNCATE pg_temp.cli_sessions_v2`);
});

async function insertSession(
  sessionId: string,
  parentSessionId: string | null,
  overrides: {
    userId?: string;
    organizationId?: string | null;
    worktreeId?: string;
    rootScopeId?: string | null;
  } = {}
) {
  const rootScopeId =
    overrides.rootScopeId === undefined ? 'workspace_root' : overrides.rootScopeId;
  await client.db.execute(sql`
    INSERT INTO pg_temp.cli_sessions_v2 (
      session_id, kilo_user_id, parent_session_id, organization_id,
      cloud_agent_session_id, cloud_agent_session_scope_id, cloud_agent_worktree_id
    ) VALUES (
      ${sessionId}, ${overrides.userId ?? userId}, ${parentSessionId},
      ${overrides.organizationId ?? null}, ${parentSessionId === null ? 'workspace_root' : null},
      ${rootScopeId}, ${overrides.worktreeId ?? scope.worktreeId}
    )
  `);
}

function resolveChild(assertedScope = scope) {
  return resolveScopedChildSession(client.db, {
    kiloUserId: userId,
    sessionId: 'child',
    scope: assertedScope,
  });
}

describe('scoped ancestry PostgreSQL queries', () => {
  it('resolves a child and a create parent through the same bounded ancestry query', async () => {
    await insertSession('root', null, { rootScopeId: null });
    await insertSession('parent', 'root');
    await insertSession('child', 'parent');
    expect(await resolveChild()).toEqual({ kind: 'ok', rootScopeId: 'workspace_root' });
    expect(
      await resolveScopedCreateParent(client.db, {
        kiloUserId: userId,
        parentSessionId: 'parent',
        scope,
      })
    ).toMatchObject({
      kind: 'ok',
      memberRootScopeId: 'workspace_root',
      memberRoot: { sessionId: 'root' },
    });
  });

  it.each([CLOUD_AGENT_SCOPE_MAX_ANCESTRY_DEPTH, CLOUD_AGENT_SCOPE_MAX_ANCESTRY_DEPTH + 1])(
    'bounds %i ancestors with one ancestry round trip',
    async depth => {
      await insertSession('root', null);
      let parentId = 'root';
      for (let index = 1; index < depth; index += 1) {
        const sessionId = `ancestor_${index}`;
        await insertSession(sessionId, parentId);
        parentId = sessionId;
      }
      await insertSession('child', parentId);
      const select = vi.spyOn(client.db, 'select');
      const execute = vi.spyOn(client.db, 'execute');
      const result = await resolveChild();
      expect(select).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        depth === CLOUD_AGENT_SCOPE_MAX_ANCESTRY_DEPTH
          ? { kind: 'ok', rootScopeId: 'workspace_root' }
          : { kind: 'denied' }
      );
    }
  );

  it.each(['self', 'cycle', 'missing', 'unlisted-root', 'scope-mismatch'])(
    'denies %s ancestry',
    async problem => {
      await insertSession('root', null);
      await insertSession(
        'parent',
        problem === 'self'
          ? 'parent'
          : problem === 'cycle'
            ? 'child'
            : problem === 'missing'
              ? 'absent'
              : 'root'
      );
      await insertSession(
        'child',
        'parent',
        problem === 'scope-mismatch' ? { rootScopeId: 'workspace_other' } : {}
      );
      expect(
        await resolveChild(
          problem === 'unlisted-root' ? { ...scope, memberRootKiloSessionIds: ['other'] } : scope
        )
      ).toEqual({ kind: 'denied' });
    }
  );

  it.each([{ userId: 'oauth/another-user' }, { organizationId }, { worktreeId: 'worktree_other' }])(
    'denies an intermediate ancestor outside the asserted scope: %j',
    async overrides => {
      await insertSession('root', null);
      await insertSession('parent', 'root', overrides);
      await insertSession('child', 'parent');
      expect(await resolveChild()).toEqual({ kind: 'denied' });
      expect(
        await resolveScopedCreateParent(client.db, {
          kiloUserId: userId,
          parentSessionId: 'child',
          scope,
        })
      ).toEqual({ kind: 'denied' });
    }
  );

  it('requires the asserted organization on every hop', async () => {
    await insertSession('root', null, { organizationId });
    await insertSession('parent', 'root');
    await insertSession('child', 'parent', { organizationId });
    const orgScope = { ...scope, organizationId };
    expect(await resolveChild(orgScope)).toEqual({ kind: 'denied' });
    await client.db.execute(
      sql`UPDATE pg_temp.cli_sessions_v2 SET organization_id = ${organizationId} WHERE session_id = 'parent'`
    );
    expect(await resolveChild(orgScope)).toEqual({ kind: 'ok', rootScopeId: 'workspace_root' });
  });

  it('denies a root on the child path but permits it as a create parent', async () => {
    await insertSession('root', null, { rootScopeId: null });
    expect(
      await resolveScopedChildSession(client.db, { kiloUserId: userId, sessionId: 'root', scope })
    ).toEqual({ kind: 'denied' });
    expect(
      await resolveScopedCreateParent(client.db, {
        kiloUserId: userId,
        parentSessionId: 'root',
        scope,
      })
    ).toMatchObject({ kind: 'ok', memberRootScopeId: 'workspace_root' });
  });
});
