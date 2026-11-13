import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  github_branch_pull_requests,
  kilocode_users,
} from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import { readWorkspacePullRequestSummaries } from '../../src/session/workspace-pull-request.js';

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set POSTGRES_URL to the isolated local test database');
const client = createDrizzleClient({ connectionString, ssl: false });

const owner = `oauth/workspace-pr-${randomUUID()}`;
const otherUser = `oauth/workspace-pr-other-${randomUUID()}`;
const gitUrl = `https://github.com/Kilo-Org/workspace-pr-${randomUUID()}`;
const branch = 'feature/shared-pr';
const worktrees = {
  multiSession: `worktree_${randomUUID()}`,
  secondWorkspace: `worktree_${randomUUID()}`,
  unverified: `worktree_${randomUUID()}`,
  otherOwner: `worktree_${randomUUID()}`,
};
const sessionIds: string[] = [];
const headSha = 'a'.repeat(40);

function observations() {
  return {
    version: 1,
    headSha,
    checks: [
      {
        key: 'check:1:test',
        id: '1',
        attempt: 1,
        at: '2026-10-21T12:00:00Z',
        phase: 2,
        failed: false,
        outcome: 'passed',
      },
    ],
    threads: [],
    threadsObserved: true,
    threadsUnknown: false,
    checksTruncated: false,
    threadsTruncated: false,
    checksObserved: true,
    checksComplete: true,
    threadsComplete: true,
    unavailable: [],
  };
}

async function insertSession(values: {
  worktreeId: string;
  userId: string;
  gitBranch?: string;
  prUrl?: string;
  prNumber?: number;
  prLinkVerifiedAt?: string;
}) {
  const sessionId = `ses_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  sessionIds.push(sessionId);
  await client.db.insert(cli_sessions_v2).values({
    session_id: sessionId,
    cloud_agent_session_id: `workspace_${randomUUID()}`,
    kilo_user_id: values.userId,
    cloud_agent_worktree_id: values.worktreeId,
    git_url: gitUrl,
    git_branch: values.gitBranch ?? branch,
    pr_url: values.prUrl ?? null,
    pr_number: values.prNumber ?? null,
    pr_link_verified_at: values.prLinkVerifiedAt ?? null,
  });
}

beforeAll(async () => {
  await client.db.insert(kilocode_users).values(
    [owner, otherUser].map(id => ({
      id,
      google_user_email: `${randomUUID()}@example.test`,
      google_user_name: 'Workspace PR fixture',
      google_user_image_url: '',
      stripe_customer_id: '',
    }))
  );
  await client.db.insert(cloud_agent_worktrees).values([
    {
      worktree_id: worktrees.multiSession,
      kilo_user_id: owner,
      git_url: gitUrl,
      git_branch: branch,
    },
    {
      worktree_id: worktrees.secondWorkspace,
      kilo_user_id: owner,
      git_url: gitUrl,
      git_branch: branch,
    },
    {
      worktree_id: worktrees.unverified,
      kilo_user_id: owner,
      git_url: gitUrl,
      git_branch: `${branch}-unverified`,
    },
    {
      worktree_id: worktrees.otherOwner,
      kilo_user_id: otherUser,
      git_url: gitUrl,
      git_branch: branch,
    },
  ]);

  await client.db.insert(github_branch_pull_requests).values([
    {
      git_url: gitUrl,
      git_branch: branch,
      owned_by_user_id: owner,
      pr_url: 'https://github.com/Kilo-Org/cloud/pull/142',
      pr_number: 142,
      pr_state: 'open',
      pr_title: 'Shared workspace PR',
      pr_head_sha: headSha,
      pr_observations: observations(),
      pr_review_decision: 'approved',
      review_decision_pending: false,
      pr_last_synced_at: '2026-10-21T12:00:00Z',
    },
    {
      git_url: gitUrl,
      git_branch: 'feature/unverified-link',
      owned_by_user_id: owner,
      pr_url: 'https://github.com/Kilo-Org/cloud/pull/777',
      pr_number: 777,
      pr_state: 'open',
      pr_title: 'Unverified link candidate',
      pr_head_sha: headSha,
      pr_observations: observations(),
      review_decision_pending: false,
      pr_last_synced_at: '2026-10-21T12:00:00Z',
    },
    {
      git_url: gitUrl,
      git_branch: branch,
      owned_by_user_id: otherUser,
      pr_url: 'https://github.com/Kilo-Org/cloud/pull/999',
      pr_number: 999,
      pr_state: 'open',
      pr_title: 'Other owner PR',
      pr_head_sha: headSha,
      pr_observations: observations(),
      review_decision_pending: false,
      pr_last_synced_at: '2026-10-21T12:00:00Z',
    },
  ]);

  await insertSession({
    worktreeId: worktrees.multiSession,
    userId: owner,
    prUrl: 'https://github.com/Kilo-Org/cloud/pull/142',
    prNumber: 142,
    prLinkVerifiedAt: '2026-10-21T12:00:00Z',
  });
  await insertSession({
    worktreeId: worktrees.multiSession,
    userId: owner,
    prUrl: 'https://github.com/Kilo-Org/cloud/pull/142',
    prNumber: 142,
    prLinkVerifiedAt: '2026-10-21T12:00:00Z',
  });
  await insertSession({ worktreeId: worktrees.secondWorkspace, userId: owner });
  await insertSession({
    worktreeId: worktrees.unverified,
    userId: owner,
    gitBranch: 'feature/unverified-link',
    prUrl: 'https://github.com/Kilo-Org/cloud/pull/777',
    prNumber: 777,
  });
  await insertSession({
    worktreeId: worktrees.otherOwner,
    userId: otherUser,
    prUrl: 'https://github.com/Kilo-Org/cloud/pull/999',
    prNumber: 999,
    prLinkVerifiedAt: '2026-10-21T12:00:00Z',
  });
});

afterAll(async () => {
  await client.db
    .delete(cli_sessions_v2)
    .where(inArray(cli_sessions_v2.cloud_agent_worktree_id, Object.values(worktrees)));
  await client.db
    .delete(cloud_agent_worktrees)
    .where(inArray(cloud_agent_worktrees.worktree_id, Object.values(worktrees)));
  await client.db
    .delete(github_branch_pull_requests)
    .where(inArray(github_branch_pull_requests.owned_by_user_id, [owner, otherUser]));
  await client.db.delete(kilocode_users).where(inArray(kilocode_users.id, [owner, otherUser]));
  await client.pool.end();
});

describe('workspace PR projection against PostgreSQL', () => {
  it('returns one stable summary per workspace across multiple root sessions', async () => {
    const summaries = await readWorkspacePullRequestSummaries(
      { HYPERDRIVE: { connectionString } as Hyperdrive },
      {
        userId: owner,
        workspaces: [{ workspaceId: worktrees.multiSession, organizationId: null }],
      }
    );

    const summary = summaries.get(worktrees.multiSession);
    expect(summary).toMatchObject({
      number: 142,
      title: 'Shared workspace PR',
      review: { decision: 'approved' },
      checks: { passed: 1, failed: 0, complete: true, available: true },
    });
  });

  it('keeps two workspaces distinct when they share one PR', async () => {
    const summaries = await readWorkspacePullRequestSummaries(
      { HYPERDRIVE: { connectionString } as Hyperdrive },
      {
        userId: owner,
        workspaces: [
          { workspaceId: worktrees.multiSession, organizationId: null },
          { workspaceId: worktrees.secondWorkspace, organizationId: null },
        ],
      }
    );

    expect(summaries.get(worktrees.multiSession)?.number).toBe(142);
    expect(summaries.get(worktrees.secondWorkspace)?.number).toBe(142);
  });

  it('never projects an unverified link', async () => {
    const summaries = await readWorkspacePullRequestSummaries(
      { HYPERDRIVE: { connectionString } as Hyperdrive },
      {
        userId: owner,
        workspaces: [{ workspaceId: worktrees.unverified, organizationId: null }],
      }
    );

    expect(summaries.has(worktrees.unverified)).toBe(false);
  });

  it("does not read another owner's workspace", async () => {
    const summaries = await readWorkspacePullRequestSummaries(
      { HYPERDRIVE: { connectionString } as Hyperdrive },
      {
        userId: owner,
        workspaces: [{ workspaceId: worktrees.otherOwner, organizationId: null }],
      }
    );

    expect(summaries.size).toBe(0);
  });
});
