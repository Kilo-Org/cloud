import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import { and, inArray, isNotNull } from 'drizzle-orm';
import type { RouteRecord } from '../../src/control-plane/sandbox/routes.js';
import { readWorkspaceHistorySessions } from '../../src/control-plane/sandbox/workspace-history.js';
import type { WorkspaceHistorySession } from '../../src/shared/control-plane-protocol.js';

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set POSTGRES_URL to the isolated local test database');
const client = createDrizzleClient({ connectionString, ssl: false });
const users = [`oauth/workspace-history-${randomUUID()}`, randomUUID()];
const orgIds = [randomUUID(), randomUUID()];
const worktrees = Array.from({ length: 4 }, () => `worktree_${randomUUID()}`);

function routeFor(
  anchor: WorkspaceHistorySession,
  worktreeId: string,
  orgId?: string
): RouteRecord {
  return {
    sessionId: anchor.sessionId,
    spec: {
      ...anchor,
      directory: '/workspace/project',
      attemptId: 'attempt',
      runtimeIsolation: 'per-session',
      kilo: {
        scopeId: worktreeId,
        token: 'test-token',
        targets: {
          backendBaseUrl: 'https://backend.test',
          providerBaseUrl: 'https://provider.test',
          sessionIngestBaseUrl: 'https://ingest.test',
        },
      },
    },
    credentialSource: {
      userId: users[0],
      orgId,
      kiloSessionId: anchor.kiloSessionId,
      kiloToken: 'test-token',
    },
    state: 'preparing',
    grant: null,
    environment: null,
    attemptId: 'attempt',
    attemptDeadlineAt: 100,
    reason: null,
  };
}

async function insertSession(
  values: Pick<
    typeof cli_sessions_v2.$inferInsert,
    'kilo_user_id' | 'cloud_agent_worktree_id' | 'organization_id' | 'parent_session_id'
  >
): Promise<WorkspaceHistorySession> {
  const session = {
    sessionId: `workspace_${randomUUID()}`,
    kiloSessionId: `ses_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
  };
  await client.db.insert(cli_sessions_v2).values({
    ...values,
    session_id: session.kiloSessionId,
    cloud_agent_session_id: session.sessionId,
  });
  return session;
}

const scopes: Array<{
  name: string;
  route: RouteRecord;
  allowed: WorkspaceHistorySession[];
  denied: WorkspaceHistorySession[];
}> = [];
const deniedRoutes: RouteRecord[] = [];

beforeAll(async () => {
  await client.db.insert(kilocode_users).values(
    users.map(id => ({
      id,
      google_user_email: `${randomUUID()}@example.test`,
      google_user_name: 'Workspace history fixture',
      google_user_image_url: '',
      stripe_customer_id: '',
    }))
  );
  await client.db
    .insert(organizations)
    .values(orgIds.map(id => ({ id, name: 'Workspace history fixture' })));
  await client.db.insert(cloud_agent_worktrees).values([
    { worktree_id: worktrees[0], kilo_user_id: users[0] },
    { worktree_id: worktrees[1], kilo_user_id: users[0], organization_id: orgIds[0] },
    {
      worktree_id: worktrees[2],
      kilo_user_id: users[0],
      deletion_started_at: new Date().toISOString(),
    },
    { worktree_id: worktrees[3], kilo_user_id: users[1] },
  ]);

  for (const [index, name] of ['personal', 'organization'].entries()) {
    const orgId = index === 0 ? undefined : orgIds[0];
    const values = {
      kilo_user_id: users[0],
      cloud_agent_worktree_id: worktrees[index],
      organization_id: orgId,
    };
    const anchor = await insertSession(values);
    const sibling = await insertSession(values);
    const otherUser = await insertSession({ ...values, kilo_user_id: users[1] });
    const otherOrganization = await insertSession({ ...values, organization_id: orgIds[1] });
    const otherScope = await insertSession({
      ...values,
      organization_id: orgId ? null : orgIds[0],
    });
    const child = await insertSession({ ...values, parent_session_id: anchor.kiloSessionId });
    const route = routeFor(anchor, worktrees[index], orgId);
    scopes.push({
      name,
      route,
      allowed: [anchor, sibling],
      denied: [otherUser, otherOrganization, otherScope, child],
    });
    deniedRoutes.push(
      routeFor(otherUser, worktrees[index], orgId),
      routeFor(otherOrganization, worktrees[index], orgId),
      routeFor(child, worktrees[index], orgId),
      routeFor({ ...anchor, kiloSessionId: sibling.kiloSessionId }, worktrees[index], orgId),
      routeFor(anchor, worktrees[1 - index], orgId)
    );
  }
  for (const worktreeId of worktrees.slice(2)) {
    const anchor = await insertSession({
      kilo_user_id: users[0],
      cloud_agent_worktree_id: worktreeId,
    });
    deniedRoutes.push(routeFor(anchor, worktreeId));
  }
  // An otherwise valid anchor cannot authorize a workspace owned by another user.
  const foreign = scopes[0].denied[0];
  const foreignRoute = routeFor(foreign, worktrees[0]);
  foreignRoute.credentialSource = { ...foreignRoute.credentialSource!, userId: users[1] };
  deniedRoutes.push(foreignRoute);
  // Matching chat rows cannot override a different organization on the workspace ledger.
  const wrongOrgRoute = routeFor(scopes[1].denied[1], worktrees[1], orgIds[1]);
  deniedRoutes.push(wrongOrgRoute);
});

afterAll(async () => {
  await client.db
    .delete(cli_sessions_v2)
    .where(
      and(
        inArray(cli_sessions_v2.kilo_user_id, users),
        isNotNull(cli_sessions_v2.parent_session_id)
      )
    );
  await client.db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.kilo_user_id, users));
  await client.db
    .delete(cloud_agent_worktrees)
    .where(inArray(cloud_agent_worktrees.worktree_id, worktrees));
  await client.db.delete(organizations).where(inArray(organizations.id, orgIds));
  await client.db.delete(kilocode_users).where(inArray(kilocode_users.id, users));
  await client.pool.end();
});

describe('workspace history authorization against PostgreSQL', () => {
  it.each(['personal', 'organization'])(
    'returns only owned root chats in the %s scope',
    async name => {
      const scope = scopes.find(item => item.name === name);
      if (!scope) throw new Error('Missing workspace history fixture');
      const recent = await readWorkspaceHistorySessions(client.db, scope.route);
      expect(recent).toHaveLength(scope.allowed.length);
      expect(recent).toEqual(expect.arrayContaining(scope.allowed));
      for (const target of scope.allowed) {
        expect(await readWorkspaceHistorySessions(client.db, scope.route, target)).toEqual([
          target,
        ]);
      }
      for (const target of scope.denied) {
        expect(await readWorkspaceHistorySessions(client.db, scope.route, target)).toEqual([]);
      }
      expect(
        await readWorkspaceHistorySessions(client.db, scope.route, {
          sessionId: scope.allowed[0].sessionId,
          kiloSessionId: scope.allowed[1].kiloSessionId,
        })
      ).toEqual([]);
    }
  );

  it('denies invalid anchors, mismatched workspace ledgers, and deleting workspaces', async () => {
    for (const route of deniedRoutes) {
      expect(await readWorkspaceHistorySessions(client.db, route)).toEqual([]);
      expect(
        await readWorkspaceHistorySessions(client.db, route, {
          sessionId: route.sessionId,
          kiloSessionId: route.spec.kiloSessionId,
        })
      ).toEqual([]);
    }
  });
});
