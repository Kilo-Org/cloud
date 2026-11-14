import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  github_branch_pull_requests,
  kilocode_users,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import type { PullRequestPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import { linkStackedPullRequestsFromWebhook } from './stack-linking';
import { upsertCliSessionPullRequestsFromWebhook } from './upsert-cli-session-pull-requests';

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: jest.fn(async () => ({
    token: 'installation-token',
    expires_at: '2026-01-01T01:00:00.000Z',
  })),
}));

const REPO = 'stack-link-tests/widgets';
const GIT_URL = `https://github.com/${REPO}`;
const OWNER = { kind: 'user' as const, userId: '' };

type SessionSeed = {
  sessionId: string;
  worktreeId: string;
  userId: string;
  prNumber: number;
  branch: string;
  headRef?: string | null;
  verified?: boolean;
};

type WorktreeSeed = {
  worktreeId: string;
  userId: string;
  parentWorktreeId?: string | null;
  baseBranch?: string | null;
};

type CacheSeed = {
  userId: string;
  prNumber: number;
  branch: string;
  baseRef?: string | null;
  state?: string;
  stackNumber?: number | null;
  stackPosition?: number | null;
  stackSize?: number | null;
};

type FetchCall = { url: string; init: RequestInit };

function stackResponse(args: {
  status?: number;
  number?: number | null;
  pullRequests?: Array<{ number: number; baseRef?: string | null }>;
  size?: number;
}): Response {
  const status = args.status ?? 200;
  const body =
    status === 204
      ? null
      : JSON.stringify({
          ...(args.number === undefined ? {} : { number: args.number }),
          ...(args.size === undefined ? {} : { size: args.size }),
          ...(args.pullRequests === undefined
            ? {}
            : {
                pull_requests: args.pullRequests.map(pr => ({
                  number: pr.number,
                  ...(pr.baseRef === undefined ? {} : { base: { ref: pr.baseRef } }),
                })),
              }),
        });
  return new Response(body, { status });
}

function fetchSequence(responses: Response[]): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchImpl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const response = responses[index++];
    if (!response) throw new Error(`unexpected fetch call ${calls.length}`);
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makePayload(args: {
  action?: string;
  prNumber: number;
  headRef: string;
  baseRef?: string;
  topLevelStack?: PullRequestPayload['stack'];
}): PullRequestPayload {
  return {
    action: args.action ?? 'opened',
    ...(args.topLevelStack === undefined ? {} : { stack: args.topLevelStack }),
    pull_request: {
      number: args.prNumber,
      title: 'stacked PR',
      state: 'open',
      html_url: `https://github.com/${REPO}/pull/${args.prNumber}`,
      user: { id: 1, login: 'octocat', avatar_url: 'https://example.com/a.png', type: 'User' },
      head: {
        sha: `sha-${args.prNumber}`,
        ref: args.headRef,
        repo: {
          full_name: REPO,
          clone_url: `${GIT_URL}.git`,
          html_url: GIT_URL,
        },
      },
      base: { sha: 'base-sha', ref: args.baseRef ?? 'main' },
    },
    repository: {
      id: 1,
      name: 'widgets',
      full_name: REPO,
      owner: { login: 'stack-link-tests' },
    },
    installation: { id: 1 },
  };
}

describe('linkStackedPullRequestsFromWebhook', () => {
  const userIds: string[] = [];
  const sessionIds: string[] = [];

  beforeAll(async () => {
    const user = await insertTestUser();
    OWNER.userId = user.id;
    userIds.push(user.id);
  });

  afterAll(async () => {
    if (sessionIds.length > 0) {
      await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.session_id, sessionIds));
    }
    const worktreeIds = await db
      .select({ id: cloud_agent_worktrees.worktree_id })
      .from(cloud_agent_worktrees)
      .where(inArray(cloud_agent_worktrees.kilo_user_id, userIds));
    if (worktreeIds.length > 0) {
      await db.delete(cloud_agent_worktrees).where(
        inArray(
          cloud_agent_worktrees.worktree_id,
          worktreeIds.map(row => row.id)
        )
      );
    }
    if (userIds.length > 0) {
      await db
        .delete(github_branch_pull_requests)
        .where(inArray(github_branch_pull_requests.owned_by_user_id, userIds));
      await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
    }
  });

  let counter = 0;
  function unique(prefix: string): string {
    counter += 1;
    return `${prefix}-${Date.now()}-${counter}`;
  }

  async function seedWorktree(seed: WorktreeSeed): Promise<void> {
    await db.insert(cloud_agent_worktrees).values({
      worktree_id: seed.worktreeId,
      kilo_user_id: seed.userId,
      organization_id: null,
      parent_worktree_id: seed.parentWorktreeId ?? null,
      base_branch: seed.baseBranch ?? null,
      name: seed.worktreeId,
    });
  }

  async function seedSession(seed: SessionSeed): Promise<void> {
    sessionIds.push(seed.sessionId);
    await db.insert(cli_sessions_v2).values({
      session_id: seed.sessionId,
      kilo_user_id: seed.userId,
      organization_id: null,
      cloud_agent_worktree_id: seed.worktreeId,
      git_url: GIT_URL,
      git_branch: seed.branch,
      pr_url: `${GIT_URL}/pull/${seed.prNumber}`,
      pr_number: seed.prNumber,
      pr_head_ref: seed.headRef === undefined ? seed.branch : seed.headRef,
      pr_head_sha: null,
      pr_link_verified_at: seed.verified === false ? null : '2026-10-01T00:00:00.000Z',
    });
  }

  async function seedCache(seed: CacheSeed): Promise<void> {
    await db.insert(github_branch_pull_requests).values({
      git_url: GIT_URL,
      git_branch: seed.branch,
      owned_by_organization_id: null,
      owned_by_user_id: seed.userId,
      pr_url: `${GIT_URL}/pull/${seed.prNumber}`,
      pr_number: seed.prNumber,
      pr_state: seed.state ?? 'open',
      pr_title: `PR ${seed.prNumber}`,
      pr_head_sha: `sha-${seed.prNumber}`,
      pr_base_ref: seed.baseRef ?? null,
      stack_number: seed.stackNumber ?? null,
      stack_position: seed.stackPosition ?? null,
      stack_size: seed.stackSize ?? null,
    });
  }

  async function readCache(prNumber: number) {
    const [row] = await db
      .select()
      .from(github_branch_pull_requests)
      .where(
        and(
          eq(github_branch_pull_requests.git_url, GIT_URL),
          eq(github_branch_pull_requests.pr_number, prNumber),
          eq(github_branch_pull_requests.owned_by_user_id, OWNER.userId)
        )
      );
    return row;
  }

  it('creates a stack bottom-to-top when the parent has no stack', async () => {
    const parentWorktree = unique('wt-parent');
    const childWorktree = unique('wt-child');
    await seedWorktree({ worktreeId: parentWorktree, userId: OWNER.userId });
    await seedWorktree({
      worktreeId: childWorktree,
      userId: OWNER.userId,
      parentWorktreeId: parentWorktree,
      baseBranch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-parent'),
      worktreeId: parentWorktree,
      userId: OWNER.userId,
      prNumber: 1001,
      branch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-child'),
      worktreeId: childWorktree,
      userId: OWNER.userId,
      prNumber: 1002,
      branch: 'feature/child',
    });
    await seedCache({ userId: OWNER.userId, prNumber: 1001, branch: 'feature/parent' });
    await seedCache({
      userId: OWNER.userId,
      prNumber: 1002,
      branch: 'feature/child',
      baseRef: 'feature/parent',
    });

    const { fetchImpl, calls } = fetchSequence([
      stackResponse({
        status: 201,
        number: 44,
        pullRequests: [{ number: 1001 }, { number: 1002 }],
        // A size field must be ignored in favour of the array length.
        size: 99,
      }),
    ]);

    await linkStackedPullRequestsFromWebhook({
      payload: makePayload({ prNumber: 1002, headRef: 'feature/child', baseRef: 'feature/parent' }),
      owner: OWNER,
      installationId: '98765',
      appType: 'standard',
      fetchImpl,
      sleep: async () => {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.github.com/repos/${REPO}/stacks`);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      pull_requests: [1001, 1002],
    });
    expect(calls[0].init.signal).toBeDefined();

    const parentRow = await readCache(1001);
    const childRow = await readCache(1002);
    expect(parentRow).toMatchObject({ stack_number: 44, stack_position: 1, stack_size: 2 });
    expect(childRow).toMatchObject({ stack_number: 44, stack_position: 2, stack_size: 2 });
    expect(childRow.pr_base_ref).toBe('feature/parent');
  });

  it('matches the parent by its PR head ref when the cached branch differs', async () => {
    const parentWorktree = unique('wt-parent');
    const childWorktree = unique('wt-child');
    await seedWorktree({ worktreeId: parentWorktree, userId: OWNER.userId });
    await seedWorktree({
      worktreeId: childWorktree,
      userId: OWNER.userId,
      parentWorktreeId: parentWorktree,
      baseBranch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-parent'),
      worktreeId: parentWorktree,
      userId: OWNER.userId,
      prNumber: 1051,
      branch: 'feature/parent-local',
      headRef: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-child'),
      worktreeId: childWorktree,
      userId: OWNER.userId,
      prNumber: 1052,
      branch: 'feature/child',
    });
    await seedCache({ userId: OWNER.userId, prNumber: 1051, branch: 'feature/parent-local' });
    await seedCache({
      userId: OWNER.userId,
      prNumber: 1052,
      branch: 'feature/child',
      baseRef: 'feature/parent',
    });

    const { fetchImpl, calls } = fetchSequence([
      stackResponse({
        status: 201,
        number: 45,
        pullRequests: [{ number: 1051 }, { number: 1052 }],
      }),
    ]);

    await linkStackedPullRequestsFromWebhook({
      payload: makePayload({ prNumber: 1052, headRef: 'feature/child', baseRef: 'feature/parent' }),
      owner: OWNER,
      installationId: '98765',
      appType: 'standard',
      fetchImpl,
      sleep: async () => {},
    });

    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ pull_requests: [1051, 1052] });
  });

  it('adds only the child when the parent is the current stack top', async () => {
    const parentWorktree = unique('wt-parent');
    const childWorktree = unique('wt-child');
    await seedWorktree({ worktreeId: parentWorktree, userId: OWNER.userId });
    await seedWorktree({
      worktreeId: childWorktree,
      userId: OWNER.userId,
      parentWorktreeId: parentWorktree,
      baseBranch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-parent'),
      worktreeId: parentWorktree,
      userId: OWNER.userId,
      prNumber: 1101,
      branch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-child'),
      worktreeId: childWorktree,
      userId: OWNER.userId,
      prNumber: 1102,
      branch: 'feature/child',
    });
    await seedCache({
      userId: OWNER.userId,
      prNumber: 1101,
      branch: 'feature/parent',
      stackNumber: 8,
      stackPosition: 1,
      stackSize: 1,
    });
    await seedCache({
      userId: OWNER.userId,
      prNumber: 1102,
      branch: 'feature/child',
      baseRef: 'feature/parent',
    });

    const { fetchImpl, calls } = fetchSequence([
      stackResponse({
        number: 8,
        pullRequests: [{ number: 1101 }],
      }),
      stackResponse({
        number: 8,
        pullRequests: [{ number: 1101 }, { number: 1102 }],
      }),
    ]);

    await linkStackedPullRequestsFromWebhook({
      payload: makePayload({ prNumber: 1102, headRef: 'feature/child', baseRef: 'feature/parent' }),
      owner: OWNER,
      installationId: '98765',
      appType: 'standard',
      fetchImpl,
      sleep: async () => {},
    });

    expect(calls.map(call => `${call.init.method} ${call.url}`)).toEqual([
      `GET https://api.github.com/repos/${REPO}/stacks/8`,
      `POST https://api.github.com/repos/${REPO}/stacks/8/add`,
    ]);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ pull_requests: [1102] });
    expect(await readCache(1102)).toMatchObject({
      stack_number: 8,
      stack_position: 2,
      stack_size: 2,
    });
  });

  it('does not add below a parent that is not the stack top', async () => {
    const parentWorktree = unique('wt-parent');
    const childWorktree = unique('wt-child');
    await seedWorktree({ worktreeId: parentWorktree, userId: OWNER.userId });
    await seedWorktree({
      worktreeId: childWorktree,
      userId: OWNER.userId,
      parentWorktreeId: parentWorktree,
      baseBranch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-parent'),
      worktreeId: parentWorktree,
      userId: OWNER.userId,
      prNumber: 1201,
      branch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-child'),
      worktreeId: childWorktree,
      userId: OWNER.userId,
      prNumber: 1202,
      branch: 'feature/child',
    });
    await seedCache({
      userId: OWNER.userId,
      prNumber: 1201,
      branch: 'feature/parent',
      stackNumber: 9,
      stackPosition: 1,
      stackSize: 2,
    });
    await seedCache({
      userId: OWNER.userId,
      prNumber: 1202,
      branch: 'feature/child',
      baseRef: 'feature/parent',
    });

    const { fetchImpl, calls } = fetchSequence([]);

    await linkStackedPullRequestsFromWebhook({
      payload: makePayload({ prNumber: 1202, headRef: 'feature/child', baseRef: 'feature/parent' }),
      owner: OWNER,
      installationId: '98765',
      appType: 'standard',
      fetchImpl,
      sleep: async () => {},
    });

    // The cached position/size already says the parent is not the top, so no
    // request (and no repeated 422) is made for a sibling fork.
    expect(calls).toHaveLength(0);
  });

  it('skips an already linked child regardless of stale parent metadata', async () => {
    const parentWorktree = unique('wt-parent');
    const childWorktree = unique('wt-child');
    await seedWorktree({ worktreeId: parentWorktree, userId: OWNER.userId });
    await seedWorktree({
      worktreeId: childWorktree,
      userId: OWNER.userId,
      parentWorktreeId: parentWorktree,
      baseBranch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-parent'),
      worktreeId: parentWorktree,
      userId: OWNER.userId,
      prNumber: 1301,
      branch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-child'),
      worktreeId: childWorktree,
      userId: OWNER.userId,
      prNumber: 1302,
      branch: 'feature/child',
    });
    // Parent cache says "no stack", child cache already has a stack number.
    await seedCache({ userId: OWNER.userId, prNumber: 1301, branch: 'feature/parent' });
    await seedCache({
      userId: OWNER.userId,
      prNumber: 1302,
      branch: 'feature/child',
      baseRef: 'feature/parent',
      stackNumber: 12,
      stackPosition: 2,
      stackSize: 2,
    });

    const { fetchImpl, calls } = fetchSequence([]);

    await linkStackedPullRequestsFromWebhook({
      payload: makePayload({ prNumber: 1302, headRef: 'feature/child', baseRef: 'feature/parent' }),
      owner: OWNER,
      installationId: '98765',
      appType: 'standard',
      fetchImpl,
      sleep: async () => {},
    });

    expect(calls).toHaveLength(0);
  });

  it('requires the parent session link to be verified', async () => {
    const parentWorktree = unique('wt-parent');
    const childWorktree = unique('wt-child');
    await seedWorktree({ worktreeId: parentWorktree, userId: OWNER.userId });
    await seedWorktree({
      worktreeId: childWorktree,
      userId: OWNER.userId,
      parentWorktreeId: parentWorktree,
      baseBranch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-parent'),
      worktreeId: parentWorktree,
      userId: OWNER.userId,
      prNumber: 1401,
      branch: 'feature/parent',
      verified: false,
    });
    await seedSession({
      sessionId: unique('ses-child'),
      worktreeId: childWorktree,
      userId: OWNER.userId,
      prNumber: 1402,
      branch: 'feature/child',
    });
    await seedCache({ userId: OWNER.userId, prNumber: 1401, branch: 'feature/parent' });
    await seedCache({
      userId: OWNER.userId,
      prNumber: 1402,
      branch: 'feature/child',
      baseRef: 'feature/parent',
    });

    const { fetchImpl, calls } = fetchSequence([]);

    await linkStackedPullRequestsFromWebhook({
      payload: makePayload({ prNumber: 1402, headRef: 'feature/child', baseRef: 'feature/parent' }),
      owner: OWNER,
      installationId: '98765',
      appType: 'standard',
      fetchImpl,
      sleep: async () => {},
    });

    expect(calls).toHaveLength(0);
  });

  it('does not link across owners even when the worktree ids and branches match', async () => {
    const other = await insertTestUser();
    userIds.push(other.id);
    const parentWorktree = unique('wt-parent');
    const childWorktree = unique('wt-child');
    await seedWorktree({ worktreeId: parentWorktree, userId: other.id });
    await seedWorktree({
      worktreeId: childWorktree,
      userId: OWNER.userId,
      parentWorktreeId: parentWorktree,
      baseBranch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-parent'),
      worktreeId: parentWorktree,
      userId: other.id,
      prNumber: 1501,
      branch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-child'),
      worktreeId: childWorktree,
      userId: OWNER.userId,
      prNumber: 1502,
      branch: 'feature/child',
    });
    await seedCache({
      userId: other.id,
      prNumber: 1501,
      branch: 'feature/parent',
    });
    await seedCache({
      userId: OWNER.userId,
      prNumber: 1502,
      branch: 'feature/child',
      baseRef: 'feature/parent',
    });

    const { fetchImpl, calls } = fetchSequence([]);

    await linkStackedPullRequestsFromWebhook({
      payload: makePayload({ prNumber: 1502, headRef: 'feature/child', baseRef: 'feature/parent' }),
      owner: OWNER,
      installationId: '98765',
      appType: 'standard',
      fetchImpl,
      sleep: async () => {},
    });

    expect(calls).toHaveLength(0);
  });

  it('retries 409 with bounded 250/500/1000 ms backoff', async () => {
    const parentWorktree = unique('wt-parent');
    const childWorktree = unique('wt-child');
    await seedWorktree({ worktreeId: parentWorktree, userId: OWNER.userId });
    await seedWorktree({
      worktreeId: childWorktree,
      userId: OWNER.userId,
      parentWorktreeId: parentWorktree,
      baseBranch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-parent'),
      worktreeId: parentWorktree,
      userId: OWNER.userId,
      prNumber: 1601,
      branch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-child'),
      worktreeId: childWorktree,
      userId: OWNER.userId,
      prNumber: 1602,
      branch: 'feature/child',
    });
    await seedCache({ userId: OWNER.userId, prNumber: 1601, branch: 'feature/parent' });
    await seedCache({
      userId: OWNER.userId,
      prNumber: 1602,
      branch: 'feature/child',
      baseRef: 'feature/parent',
    });

    const sleeps: number[] = [];
    const { fetchImpl, calls } = fetchSequence([
      stackResponse({ status: 409 }),
      stackResponse({ status: 409 }),
      stackResponse({ status: 409 }),
      stackResponse({
        status: 201,
        number: 21,
        pullRequests: [{ number: 1601 }, { number: 1602 }],
      }),
    ]);

    await linkStackedPullRequestsFromWebhook({
      payload: makePayload({ prNumber: 1602, headRef: 'feature/child', baseRef: 'feature/parent' }),
      owner: OWNER,
      installationId: '98765',
      appType: 'standard',
      fetchImpl,
      sleep: async milliseconds => {
        sleeps.push(milliseconds);
      },
    });

    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([250, 500, 1000]);
    expect(await readCache(1602)).toMatchObject({ stack_number: 21 });
  });

  it('treats 422 as a soft no-op and leaves the cache unchanged', async () => {
    const parentWorktree = unique('wt-parent');
    const childWorktree = unique('wt-child');
    await seedWorktree({ worktreeId: parentWorktree, userId: OWNER.userId });
    await seedWorktree({
      worktreeId: childWorktree,
      userId: OWNER.userId,
      parentWorktreeId: parentWorktree,
      baseBranch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-parent'),
      worktreeId: parentWorktree,
      userId: OWNER.userId,
      prNumber: 1701,
      branch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-child'),
      worktreeId: childWorktree,
      userId: OWNER.userId,
      prNumber: 1702,
      branch: 'feature/child',
    });
    await seedCache({ userId: OWNER.userId, prNumber: 1701, branch: 'feature/parent' });
    await seedCache({
      userId: OWNER.userId,
      prNumber: 1702,
      branch: 'feature/child',
      baseRef: 'feature/parent',
    });

    const { fetchImpl } = fetchSequence([stackResponse({ status: 422 })]);

    await expect(
      linkStackedPullRequestsFromWebhook({
        payload: makePayload({
          prNumber: 1702,
          headRef: 'feature/child',
          baseRef: 'feature/parent',
        }),
        owner: OWNER,
        installationId: '98765',
        appType: 'standard',
        fetchImpl,
        sleep: async () => {},
      })
    ).resolves.toBeUndefined();
    expect(await readCache(1702)).toMatchObject({ stack_number: null, stack_position: null });
  });

  it('skips the GitHub API for KiloConnect-Lite', async () => {
    const { fetchImpl, calls } = fetchSequence([]);

    await linkStackedPullRequestsFromWebhook({
      payload: makePayload({ prNumber: 1801, headRef: 'feature/child' }),
      owner: OWNER,
      installationId: '98765',
      appType: 'lite',
      fetchImpl,
      sleep: async () => {},
    });

    expect(calls).toHaveLength(0);
  });

  it('links the child when the parent PR becomes verified after the child exists', async () => {
    const parentWorktree = unique('wt-parent');
    const childWorktree = unique('wt-child');
    await seedWorktree({ worktreeId: parentWorktree, userId: OWNER.userId });
    await seedWorktree({
      worktreeId: childWorktree,
      userId: OWNER.userId,
      parentWorktreeId: parentWorktree,
      baseBranch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-parent'),
      worktreeId: parentWorktree,
      userId: OWNER.userId,
      prNumber: 2001,
      branch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-child'),
      worktreeId: childWorktree,
      userId: OWNER.userId,
      prNumber: 2002,
      branch: 'feature/child',
    });
    await seedCache({ userId: OWNER.userId, prNumber: 2001, branch: 'feature/parent' });
    await seedCache({
      userId: OWNER.userId,
      prNumber: 2002,
      branch: 'feature/child',
      baseRef: 'feature/parent',
    });

    const { fetchImpl, calls } = fetchSequence([
      stackResponse({
        status: 201,
        number: 55,
        pullRequests: [{ number: 2001 }, { number: 2002 }],
      }),
    ]);

    // The webhook is the parent PR, not the child's.
    await linkStackedPullRequestsFromWebhook({
      payload: makePayload({ prNumber: 2001, headRef: 'feature/parent', baseRef: 'main' }),
      owner: OWNER,
      installationId: '98765',
      appType: 'standard',
      fetchImpl,
      sleep: async () => {},
    });

    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      pull_requests: [2001, 2002],
    });
    expect(await readCache(2002)).toMatchObject({ stack_number: 55, stack_position: 2 });
  });

  it('links after the webhook cache upsert verified the child', async () => {
    const parentWorktree = unique('wt-parent');
    const childWorktree = unique('wt-child');
    await seedWorktree({ worktreeId: parentWorktree, userId: OWNER.userId });
    await seedWorktree({
      worktreeId: childWorktree,
      userId: OWNER.userId,
      parentWorktreeId: parentWorktree,
      baseBranch: 'feature/parent',
    });
    await seedSession({
      sessionId: unique('ses-parent'),
      worktreeId: parentWorktree,
      userId: OWNER.userId,
      prNumber: 2101,
      branch: 'feature/parent',
    });
    const childSessionId = unique('ses-child');
    await seedSession({
      sessionId: childSessionId,
      worktreeId: childWorktree,
      userId: OWNER.userId,
      prNumber: 2102,
      branch: 'feature/child',
      verified: false,
    });
    await seedCache({
      userId: OWNER.userId,
      prNumber: 2101,
      branch: 'feature/parent',
    });

    const payload = makePayload({
      prNumber: 2102,
      headRef: 'feature/child',
      baseRef: 'feature/parent',
    });
    await upsertCliSessionPullRequestsFromWebhook(payload, OWNER);

    const { fetchImpl, calls } = fetchSequence([
      stackResponse({
        status: 201,
        number: 66,
        pullRequests: [{ number: 2101 }, { number: 2102 }],
      }),
    ]);

    await linkStackedPullRequestsFromWebhook({
      payload,
      owner: OWNER,
      installationId: '98765',
      appType: 'standard',
      fetchImpl,
      sleep: async () => {},
    });

    expect(calls).toHaveLength(1);
    expect(await readCache(2102)).toMatchObject({
      stack_number: 66,
      stack_position: 2,
      stack_size: 2,
      pr_base_ref: 'feature/parent',
    });
  });
});
