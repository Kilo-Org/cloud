import { watchPrPolicySchema } from '@kilocode/db/schema-types';
import type { CliSessionV2, CloudAgentPrWatch } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import { Octokit } from '@octokit/rest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  assertGitHubInstallationRuntimeAuthorized,
  GitHubRuntimeAuthorizationError,
} from '@/lib/integrations/github/runtime-authorization';
import {
  assertWatchPrExpiry,
  assertWatchPrSource,
  changeWatchPr,
  enableWatchPr,
  getWatchPr,
  getPrWatchOptions,
  recheckWatchPr,
  serializeWatchPr,
  watchPrEnableSchema,
  watchPrQuerySchema,
} from './watch-pr';
import { emptyWatchPrProjection } from './watch-pr-events';
import { replayWatchPrCiEvents } from './watch-pr-ci-inbox';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    query: {
      cli_sessions_v2: { findFirst: jest.fn() },
      cloud_agent_pr_watches: { findFirst: jest.fn() },
      cloud_agent_worktrees: { findFirst: jest.fn() },
      platform_integrations: { findFirst: jest.fn(), findMany: jest.fn() },
      agent_environment_profiles: { findFirst: jest.fn() },
    },
    transaction: jest.fn(),
    select: jest.fn(),
  },
}));
jest.mock('@kilocode/web-shared/lib/posthog-feature-flags', () => ({
  isReleaseToggleEnabled: jest.fn(),
}));
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(),
  GitHubRuntimeAuthorizationError: class extends Error {},
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: jest.fn(),
}));
jest.mock('./watch-pr-ci-inbox', () => ({
  replayWatchPrCiEvents: jest.fn(async (_tx, _watch, next) => next),
}));

const ctx = { user: { id: 'oauth/github|watch-owner' } } as Parameters<typeof enableWatchPr>[0];
const policy = watchPrPolicySchema.parse({
  version: 1,
  model: 'anthropic/claude-sonnet-4.6',
  profileId: null,
  categories: { reviews: true, failedChecks: true, baseUpdates: true },
  branchStrategy: 'merge',
  historyRewriteConsent: false,
  maxAttemptsPerProblem: 2,
  maxTotalAttempts: 10,
  observationOnlyConsent: true,
  futureEventsOnlyConsent: true,
  noHardSpendCapConsent: true,
});
const session = {
  session_id: 'ses_source',
  kilo_user_id: ctx.user.id,
  organization_id: null,
  cloud_agent_session_id: 'workspace_source',
  cloud_agent_worktree_id: 'worktree_source',
  parent_session_id: null,
  git_url: 'git@github.com:Kilo/Widgets.git',
  git_branch: 'repair',
  platform: 'github',
  pr_url: 'https://github.com/kilo/widgets/pull/12',
  pr_number: 12,
  pr_head_ref: 'repair',
  pr_head_sha: 'a'.repeat(40),
  pr_link_verified_at: '2026-10-14 01:00:00+00',
} as CliSessionV2;
const watch = {
  id: 'e8518e75-ecc7-43b1-a8c3-eb425aa2ff33',
  kilo_user_id: ctx.user.id,
  organization_id: null,
  source_session_id: session.session_id,
  worktree_id: session.cloud_agent_worktree_id,
  integration_id: 'a85c0e2e-4c35-4f6e-808d-ea4eaa9be440',
  installation_id: '123',
  github_app_type: 'standard',
  repository_id: '1',
  repo_url: 'https://github.com/kilo/widgets',
  pr_number: 12,
  head_ref: 'repair',
  base_ref: 'main',
  head_sha: 'a'.repeat(40),
  base_sha: 'b'.repeat(40),
  pending_revision: 0,
  lifecycle_reason: null,
  status: 'watching',
  generation: 1,
  policy,
  projection: emptyWatchPrProjection(),
  expires_at: '2027-01-01 00:00:00+00',
  created_at: '2026-10-14 01:16:12.945+00',
  updated_at: '2026-10-14 01:16:12.945+00',
  last_event_at: '2026-10-14 01:17:12.945+00',
} as CloudAgentPrWatch;
const queryInput = {
  sessionId: session.session_id,
  expectedRepoUrl: watch.repo_url,
  expectedPrNumber: watch.pr_number,
};
const input = {
  ...queryInput,
  integrationId: watch.integration_id,
  policy,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};
const prGet = jest.fn();
const prListCommits = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isReleaseToggleEnabled).mockResolvedValue(true);
  jest.mocked(assertGitHubInstallationRuntimeAuthorized).mockResolvedValue(undefined);
  jest.mocked(db.query.platform_integrations.findMany).mockResolvedValue([]);
  jest.mocked(ensureOrganizationAccess).mockResolvedValue('member');
  jest.mocked(db.query.cli_sessions_v2.findFirst).mockResolvedValue(session);
  jest.mocked(db.query.cloud_agent_worktrees.findFirst).mockResolvedValue({
    kilo_user_id: ctx.user.id,
    organization_id: null,
    deletion_started_at: null,
  } as never);
  jest.mocked(db.query.cloud_agent_pr_watches.findFirst).mockResolvedValue(watch);
  jest.mocked(db.query.platform_integrations.findFirst).mockResolvedValue({
    id: watch.integration_id,
    platform_installation_id: '123',
    github_app_type: 'standard',
    repository_access: 'all',
    permissions: { contents: 'write' },
  } as never);
  jest
    .mocked(generateGitHubInstallationToken)
    .mockResolvedValue({ token: 'test', expires_at: null });
  jest
    .mocked(Octokit)
    .mockImplementation(
      () => ({ pulls: { get: prGet, listCommits: prListCommits } }) as unknown as Octokit
    );
  prListCommits.mockResolvedValue({ data: [] });
  prGet.mockResolvedValue({
    data: {
      number: 12,
      updated_at: '2026-10-14T01:00:00Z',
      state: 'open',
      merged_at: null,
      head: { ref: 'repair', sha: 'a'.repeat(40), repo: { id: 1, full_name: 'Kilo/Widgets' } },
      base: { ref: 'main', sha: 'b'.repeat(40), repo: { id: 1, full_name: 'Kilo/Widgets' } },
    },
  });
});

describe('watch consent and source boundaries', () => {
  it('requires explicit canonical repository and PR identity for queries and enablement', () => {
    expect(watchPrQuerySchema.safeParse(queryInput).success).toBe(true);
    expect(watchPrEnableSchema.safeParse(input).success).toBe(true);
    for (const override of [
      { expectedRepoUrl: undefined },
      { expectedPrNumber: undefined },
      { expectedRepoUrl: 'https://github.com/Kilo/Widgets' },
      { expectedRepoUrl: 'https://gitlab.com/kilo/widgets' },
      { expectedPrNumber: 0 },
    ]) {
      expect(watchPrQuerySchema.safeParse({ ...queryInput, ...override }).success).toBe(false);
      expect(watchPrEnableSchema.safeParse({ ...input, ...override }).success).toBe(false);
    }
  });
  it('normalizes production PostgreSQL timestamps and explicitly reports observation-only limitations', () => {
    expect(serializeWatchPr(watch)).toMatchObject({
      created_at: '2026-10-14T01:16:12.945Z',
      updated_at: '2026-10-14T01:16:12.945Z',
      last_event_at: '2026-10-14T01:17:12.945Z',
      automaticRepairsAvailable: false,
      mode: 'observation_only',
      observationCoverage: 'future_events_only',
      hardSpendCapAvailable: false,
    });
  });
  it.each([
    { cloud_agent_worktree_id: null },
    { cloud_agent_session_id: 'agent_legacy' },
    { pr_link_verified_at: null },
    { platform: 'gitlab' },
    { pr_head_ref: 'another' },
    { parent_session_id: 'ses_parent' },
    { pr_url: 'https://github.com/kilo/widgets/pull/99' },
    { pr_url: 'https://github.com/other/widgets/pull/12' },
  ])('rejects unsupported source %j', override => {
    expect(() => assertWatchPrSource({ ...session, ...override })).toThrow();
  });
  it('canonicalizes repository URL and accepts text OAuth owner IDs', () => {
    expect(assertWatchPrSource(session).repo.url).toBe('https://github.com/kilo/widgets');
  });
  it.each([
    { model: '' },
    { profileId: 'not-a-profile' },
    { branchStrategy: 'rebase', historyRewriteConsent: false },
    { maxAttemptsPerProblem: 3 },
    { maxTotalAttempts: 11 },
    { maxTotalAttempts: 1 },
    { observationOnlyConsent: false },
    { futureEventsOnlyConsent: false },
    { noHardSpendCapConsent: false },
  ])('rejects missing or excessive consent %j', override => {
    expect(watchPrPolicySchema.safeParse({ ...policy, ...override }).success).toBe(false);
  });
  it('requires future bounded expiry', () => {
    const now = Date.now();
    expect(() => assertWatchPrExpiry(new Date(now).toISOString(), now)).toThrow();
    expect(() => assertWatchPrExpiry(new Date(now + 86400001).toISOString(), now)).toThrow();
    expect(() => assertWatchPrExpiry(new Date(now + 3600000).toISOString(), now)).not.toThrow();
  });
});

describe('watch options', () => {
  it('returns release availability even before a watch exists without GitHub reads', async () => {
    jest.mocked(isReleaseToggleEnabled).mockResolvedValue(false);
    await expect(getPrWatchOptions(ctx, queryInput)).resolves.toMatchObject({
      enabled: false,
      canEnable: false,
      integrationOptions: [],
      defaultIntegrationId: null,
      defaults: { model: null, profileId: null },
      automaticRepairsAvailable: false,
    });
    expect(prGet).not.toHaveBeenCalled();
    expect(db.query.platform_integrations.findMany).not.toHaveBeenCalled();
  });

  it('rejects unknown owners before returning options', async () => {
    jest.mocked(db.query.cli_sessions_v2.findFirst).mockResolvedValue(undefined);
    await expect(getPrWatchOptions(ctx, queryInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(isReleaseToggleEnabled).not.toHaveBeenCalled();
  });

  it('reports unsupported sources rather than enabling them', async () => {
    jest
      .mocked(db.query.cli_sessions_v2.findFirst)
      .mockResolvedValue({ ...session, cloud_agent_session_id: 'legacy' });
    await expect(getPrWatchOptions(ctx, queryInput)).resolves.toMatchObject({
      enabled: true,
      canEnable: false,
    });
    expect(prGet).not.toHaveBeenCalled();
  });

  it('offers only exact runtime-authorized writable repository integrations', async () => {
    const eligible = {
      id: watch.integration_id,
      platform_installation_id: '123',
      github_app_type: 'standard',
      platform_account_login: 'Kilo',
      permissions: { contents: 'write' },
      repository_access: 'selected',
      repositories: [{ id: 1, full_name: 'Kilo/Widgets' }],
    };
    jest
      .mocked(db.query.platform_integrations.findMany)
      .mockResolvedValue([
        eligible,
        { ...eligible, id: 'readonly', permissions: { contents: 'read' } },
        { ...eligible, id: 'other-repo', repositories: [] },
        { ...eligible, id: 'revoked' },
      ] as never);
    jest
      .mocked(assertGitHubInstallationRuntimeAuthorized)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new GitHubRuntimeAuthorizationError());
    await expect(getPrWatchOptions(ctx, queryInput)).resolves.toMatchObject({
      enabled: true,
      canEnable: true,
      defaultIntegrationId: watch.integration_id,
      integrationOptions: [
        { integrationId: watch.integration_id, appType: 'standard', accountLogin: 'Kilo' },
      ],
    });
    expect(assertGitHubInstallationRuntimeAuthorized).toHaveBeenCalledWith(
      '123',
      'standard',
      watch.integration_id,
      'agent'
    );
    expect(prGet).not.toHaveBeenCalled();
    expect(generateGitHubInstallationToken).not.toHaveBeenCalled();
  });
});

describe('watch lookup identity', () => {
  it.each([null, '33333333-3333-4333-8333-333333333333'])(
    'constrains lookup to canonical PR, worktree, owner and tenant %s',
    async organizationId => {
      jest.mocked(db.query.cli_sessions_v2.findFirst).mockResolvedValue({
        ...session,
        organization_id: organizationId,
        pr_url: 'https://github.com/KILO/Widgets/pull/12',
      });
      jest.mocked(db.query.cloud_agent_pr_watches.findFirst).mockResolvedValue(undefined);
      await expect(getWatchPr(ctx, queryInput)).resolves.toBeNull();
      const where = jest.mocked(db.query.cloud_agent_pr_watches.findFirst).mock.calls[0]?.[0]
        ?.where;
      if (!where || typeof where === 'function') throw new Error('Expected SQL predicate');
      const query = new PgDialect().sqlToQuery(where);
      expect(query.params).toEqual([
        ctx.user.id,
        session.cloud_agent_worktree_id,
        'https://github.com/kilo/widgets',
        12,
        ...(organizationId ? [organizationId] : []),
      ]);
      for (const column of ['kilo_user_id', 'worktree_id', 'repo_url', 'pr_number'])
        expect(query.sql).toContain(`"${column}" =`);
      expect(query.sql).toContain(
        organizationId ? '"organization_id" =' : '"organization_id" is null'
      );
      expect(db.query.cloud_agent_worktrees.findFirst).not.toHaveBeenCalled();
    }
  );

  it.each([{ pr_link_verified_at: null }, { cloud_agent_worktree_id: null }])(
    'does not fall back to another worktree watch for invalid link %j',
    async override => {
      jest
        .mocked(db.query.cli_sessions_v2.findFirst)
        .mockResolvedValue({ ...session, ...override });
      await expect(getWatchPr(ctx, queryInput)).resolves.toBeNull();
      expect(db.query.cloud_agent_pr_watches.findFirst).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    }
  );

  it('queries PR A rather than the newer PR B in the same worktree', async () => {
    jest.mocked(db.select).mockReturnValue({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
    } as never);
    await expect(getWatchPr(ctx, queryInput)).resolves.toMatchObject({ pr_number: 12 });
    const firstWhere = jest.mocked(db.query.cloud_agent_pr_watches.findFirst).mock.calls[0]?.[0]
      ?.where;
    if (!firstWhere || typeof firstWhere === 'function') throw new Error('Expected SQL predicate');
    expect(new PgDialect().sqlToQuery(firstWhere).params).toContain(12);
    jest.mocked(db.query.cli_sessions_v2.findFirst).mockResolvedValue({
      ...session,
      pr_url: 'https://github.com/kilo/widgets/pull/13',
      pr_number: 13,
    });
    jest.mocked(db.query.cloud_agent_pr_watches.findFirst).mockResolvedValue(undefined);
    await expect(getWatchPr(ctx, { ...queryInput, expectedPrNumber: 13 })).resolves.toBeNull();
    const secondWhere = jest.mocked(db.query.cloud_agent_pr_watches.findFirst).mock.calls[1]?.[0]
      ?.where;
    if (!secondWhere || typeof secondWhere === 'function')
      throw new Error('Expected SQL predicate');
    expect(new PgDialect().sqlToQuery(secondWhere).params).toContain(13);
  });

  it.each([
    { pr_url: null, pr_number: null },
    { pr_url: 'https://github.com/kilo/widgets/pull/99' },
    { pr_url: 'https://github.com/other/widgets/pull/12' },
    { pr_url: 'https://github.com/kilo/widgets/pull/13', pr_number: 13 },
    {
      git_url: 'https://github.com/kilo/other',
      pr_url: 'https://github.com/kilo/other/pull/12',
    },
  ])('rejects stale displayed PR identity %j before queries or enablement', async override => {
    jest.mocked(db.query.cli_sessions_v2.findFirst).mockResolvedValue({ ...session, ...override });
    await expect(getWatchPr(ctx, queryInput)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(getPrWatchOptions(ctx, queryInput)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(enableWatchPr(ctx, input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(db.query.cloud_agent_pr_watches.findFirst).not.toHaveBeenCalled();
    expect(db.query.cloud_agent_worktrees.findFirst).not.toHaveBeenCalled();
    expect(db.query.platform_integrations.findMany).not.toHaveBeenCalled();
    expect(generateGitHubInstallationToken).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects stale identity even when enablement is disabled', async () => {
    jest.mocked(isReleaseToggleEnabled).mockResolvedValue(false);
    await expect(
      getPrWatchOptions(ctx, { ...queryInput, expectedPrNumber: 13 })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects the old displayed PR after switching to a session linked to another PR', async () => {
    const switchedInput = { ...queryInput, sessionId: 'ses_other' };
    jest.mocked(db.query.cli_sessions_v2.findFirst).mockResolvedValue({
      ...session,
      session_id: switchedInput.sessionId,
      pr_url: 'https://github.com/kilo/widgets/pull/13',
      pr_number: 13,
    });
    await expect(getWatchPr(ctx, switchedInput)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(getPrWatchOptions(ctx, switchedInput)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(enableWatchPr(ctx, { ...input, ...switchedInput })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    const where = jest.mocked(db.query.cli_sessions_v2.findFirst).mock.calls[0]?.[0]?.where;
    if (!where || typeof where === 'function') throw new Error('Expected SQL predicate');
    expect(new PgDialect().sqlToQuery(where).params).toEqual(['ses_other', ctx.user.id]);
    expect(db.query.cloud_agent_pr_watches.findFirst).not.toHaveBeenCalled();
    expect(generateGitHubInstallationToken).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

function mockWatchTransaction(current: CloudAgentPrWatch, updated = current) {
  const returning = jest.fn().mockResolvedValue([updated]);
  const set = jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning }) });
  const values = jest.fn().mockResolvedValue(undefined);
  const tx = {
    select: jest.fn().mockReturnValue({
      from: () => ({ where: () => ({ for: () => Promise.resolve([current]) }) }),
    }),
    update: jest.fn().mockReturnValue({ set }),
    insert: jest.fn().mockReturnValue({ values }),
  };
  jest.mocked(db.transaction).mockImplementation(async callback => callback(tx as never));
  return { tx, set, values };
}

describe('manual PR recheck and resume', () => {
  it('does not require a repair profile for an observation-only recheck', async () => {
    const current = {
      ...watch,
      policy: { ...policy, profileId: 'cfd83131-f19c-463c-84c4-11fd51e2cc5f' },
    };
    jest.mocked(db.query.cloud_agent_pr_watches.findFirst).mockResolvedValue(current);
    jest.mocked(db.query.agent_environment_profiles.findFirst).mockResolvedValue(undefined);
    mockWatchTransaction(current);
    await recheckWatchPr(ctx, { watchId: watch.id, generation: 1 });
    expect(db.query.agent_environment_profiles.findFirst).not.toHaveBeenCalled();
  });
  it('uses one explicit PR read and preserves pending feedback while paused', async () => {
    const projection = {
      ...emptyWatchPrProjection(),
      evidence: [
        {
          kind: 'feedback' as const,
          key: 'comment:1',
          sha: watch.head_sha,
          updatedAt: '2026-10-14T01:00:00Z',
          state: 'commented',
          body: 'Please fix',
          actorId: '1',
        },
      ],
      pending: [{ key: 'comment:1', reason: 'reviewer_verification_required' as const }],
      needsAttention: true,
    };
    const paused = { ...watch, status: 'paused' as const, projection };
    jest.mocked(db.query.cloud_agent_pr_watches.findFirst).mockResolvedValue(paused);
    const { set } = mockWatchTransaction(paused, { ...paused, generation: 2 });
    await expect(recheckWatchPr(ctx, { watchId: watch.id, generation: 1 })).resolves.toMatchObject({
      status: 'paused',
      generation: 2,
    });
    expect(prGet).toHaveBeenCalledTimes(1);
    expect(replayWatchPrCiEvents).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'paused',
        projection: expect.objectContaining({
          pending: projection.pending,
          evidence: projection.evidence,
        }),
      })
    );
  });

  it('accepts advanced heads without trusting the stale source SHA', async () => {
    const pr = (await prGet()).data;
    pr.head.sha = 'c'.repeat(40);
    prGet.mockClear().mockResolvedValue({ data: pr });
    const { tx, set } = mockWatchTransaction(watch, { ...watch, generation: 2, head_sha: pr.head.sha });
    await recheckWatchPr(ctx, { watchId: watch.id, generation: 1 });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ head_sha: pr.head.sha, generation: 2 })
    );
    expect(prGet).toHaveBeenCalledTimes(1);
    expect(replayWatchPrCiEvents).toHaveBeenCalledWith(
      tx,
      watch,
      expect.objectContaining({ head_sha: pr.head.sha }),
      'standard'
    );
  });

  it('does not overwrite a concurrent webhook observation', async () => {
    const { tx } = mockWatchTransaction({ ...watch, head_sha: 'd'.repeat(40) });
    await expect(recheckWatchPr(ctx, { watchId: watch.id, generation: 1 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it.each(['older_pr', 'head_push', 'base_push'])(
    'does not roll back newer %s evidence',
    async kind => {
      const current = {
        ...watch,
        projection: {
          ...emptyWatchPrProjection(kind === 'older_pr' ? '2026-10-14T02:00:00Z' : undefined),
          headPushObserved: kind === 'head_push',
          basePushObserved: kind === 'base_push',
        },
        head_sha: kind === 'head_push' ? 'd'.repeat(40) : watch.head_sha,
        base_sha: kind === 'base_push' ? 'e'.repeat(40) : watch.base_sha,
      };
      jest.mocked(db.query.cloud_agent_pr_watches.findFirst).mockResolvedValue(current);
      const { tx } = mockWatchTransaction(current);
      await expect(recheckWatchPr(ctx, { watchId: watch.id, generation: 1 })).rejects.toMatchObject(
        { code: 'CONFLICT' }
      );
      expect(tx.update).not.toHaveBeenCalled();
    }
  );

  it('accepts a PR retarget without applying push provenance from the previous base ref', async () => {
    const current = {
      ...watch,
      projection: { ...emptyWatchPrProjection(), basePushObserved: true },
      base_sha: 'e'.repeat(40),
    };
    jest.mocked(db.query.cloud_agent_pr_watches.findFirst).mockResolvedValue(current);
    const pr = (await prGet()).data;
    pr.base.ref = 'release';
    pr.base.sha = 'f'.repeat(40);
    prGet.mockClear().mockResolvedValue({ data: pr });
    const { set } = mockWatchTransaction(current, {
      ...current,
      generation: 2,
      base_ref: pr.base.ref,
      base_sha: pr.base.sha,
    });
    await expect(recheckWatchPr(ctx, { watchId: watch.id, generation: 1 })).resolves.toMatchObject({
      base_ref: 'release',
      base_sha: pr.base.sha,
      generation: 2,
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        base_ref: 'release',
        base_sha: pr.base.sha,
        projection: expect.objectContaining({ basePushObserved: false }),
      })
    );
    expect(prGet).toHaveBeenCalledTimes(1);
  });

  it('finishes only on a confirmed terminal PR and clears pending work', async () => {
    const pr = (await prGet()).data;
    pr.state = 'closed';
    prGet.mockClear().mockResolvedValue({ data: pr });
    const { set } = mockWatchTransaction(watch, { ...watch, status: 'finished', generation: 2 });
    await recheckWatchPr(ctx, { watchId: watch.id, generation: 1 });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'finished',
        lifecycle_reason: 'pr_closed',
        projection: expect.objectContaining({ pending: [], needsAttention: false }),
      })
    );
  });

  it('refuses a replacement installation on the same integration before GitHub', async () => {
    jest.mocked(db.query.platform_integrations.findFirst).mockResolvedValue({
      id: watch.integration_id,
      platform_installation_id: '456',
      permissions: { contents: 'write' },
    } as never);
    await expect(recheckWatchPr(ctx, { watchId: watch.id, generation: 1 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(generateGitHubInstallationToken).not.toHaveBeenCalled();
  });

  it('resumes with current identity despite the source cached SHA being old and retains pending observations', async () => {
    const paused = { ...watch, status: 'paused' as const, head_sha: 'c'.repeat(40) };
    jest.mocked(db.query.cloud_agent_pr_watches.findFirst).mockResolvedValue(paused);
    const pr = (await prGet()).data;
    pr.head.sha = paused.head_sha;
    prGet.mockClear().mockResolvedValue({ data: pr });
    const { set } = mockWatchTransaction(paused, { ...paused, status: 'watching', generation: 2 });
    await expect(
      changeWatchPr(ctx, { watchId: watch.id, generation: 1 }, 'resume')
    ).resolves.toMatchObject({ status: 'watching' });
    expect(set).toHaveBeenCalledWith(
      expect.not.objectContaining({ projection: expect.anything() })
    );
  });

  it('rejects a finished watch without a GitHub read', async () => {
    jest
      .mocked(db.query.cloud_agent_pr_watches.findFirst)
      .mockResolvedValue({ ...watch, status: 'finished' });
    await expect(recheckWatchPr(ctx, { watchId: watch.id, generation: 1 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(prGet).not.toHaveBeenCalled();
  });
});

describe('watch lifecycle authorization', () => {
  it('scopes session and integration reads to the owner rather than trusting identifiers', async () => {
    jest.mocked(db.query.platform_integrations.findFirst).mockResolvedValue(undefined);
    await expect(enableWatchPr(ctx, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const sessionWhere = jest.mocked(db.query.cli_sessions_v2.findFirst).mock.calls[0]?.[0]?.where;
    const integrationWhere = jest.mocked(db.query.platform_integrations.findFirst).mock
      .calls[0]?.[0]?.where;
    if (
      !sessionWhere ||
      typeof sessionWhere === 'function' ||
      !integrationWhere ||
      typeof integrationWhere === 'function'
    )
      throw new Error('Missing ownership predicates');
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(sessionWhere).params).toEqual([session.session_id, ctx.user.id]);
    expect(dialect.sqlToQuery(integrationWhere).params).toEqual([
      watch.integration_id,
      'github',
      ctx.user.id,
    ]);
    expect(dialect.sqlToQuery(integrationWhere).sql).toContain(
      '"owned_by_organization_id" is null'
    );
  });

  it('checks organization access on watch mutations before inspecting the source', async () => {
    jest
      .mocked(db.query.cloud_agent_pr_watches.findFirst)
      .mockResolvedValue({ ...watch, organization_id: 'org' });
    jest.mocked(ensureOrganizationAccess).mockRejectedValue(new Error('membership revoked'));
    await expect(recheckWatchPr(ctx, { watchId: watch.id, generation: 1 })).rejects.toThrow(
      'membership revoked'
    );
    expect(db.query.cloud_agent_worktrees.findFirst).not.toHaveBeenCalled();
    expect(prGet).not.toHaveBeenCalled();
  });

  it('creates an observation-only watch with exact source and integration identity', async () => {
    const worktree = {
      kilo_user_id: ctx.user.id,
      organization_id: null,
      deletion_started_at: null,
    };
    const watchValues = jest.fn().mockReturnValue({
      onConflictDoNothing: () => ({ returning: () => Promise.resolve([watch]) }),
    });
    const activityValues = jest.fn().mockResolvedValue(undefined);
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ for: () => Promise.resolve([worktree]) }) }),
      }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
      insert: jest
        .fn()
        .mockReturnValueOnce({ values: watchValues })
        .mockReturnValueOnce({ values: activityValues }),
    };
    jest.mocked(db.transaction).mockImplementation(async callback => callback(tx as never));
    await expect(enableWatchPr(ctx, input)).resolves.toMatchObject({
      mode: 'observation_only',
      automaticRepairsAvailable: false,
    });
    expect(watchValues).toHaveBeenCalledWith(
      expect.objectContaining({
        kilo_user_id: ctx.user.id,
        organization_id: null,
        integration_id: watch.integration_id,
        installation_id: '123',
        github_app_type: 'standard',
        repository_id: '1',
        pr_number: 12,
        source_session_id: session.session_id,
        worktree_id: session.cloud_agent_worktree_id,
        projection: expect.objectContaining({ pending: [], needsAttention: false }),
      })
    );
    expect(prGet).toHaveBeenCalledTimes(1);
    expect(activityValues).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'enabled', reason: 'observation_only' })
    );
  });

  it('rechecks the worktree deletion fence before inserting a watch', async () => {
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: () =>
              Promise.resolve([
                { organization_id: null, deletion_started_at: '2026-10-14T01:00:00Z' },
              ]),
          }),
        }),
      }),
      insert: jest.fn(),
    };
    jest.mocked(db.transaction).mockImplementation(async callback => callback(tx as never));
    await expect(enableWatchPr(ctx, input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('settles deleted stale watches before replacement without touching available or foreign sources', async () => {
    const stale = {
      ...watch,
      id: 'previous-watch',
      generation: 2,
      status: 'finished' as const,
      lifecycle_reason: 'source_worktree_deleted',
    };
    const where = jest.fn().mockReturnValue({ returning: () => Promise.resolve([stale]) });
    const set = jest.fn().mockReturnValue({ where });
    const activityValues = jest.fn().mockResolvedValue(undefined);
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({ for: () => Promise.resolve([{ organization_id: null }]) }),
        }),
      }),
      update: () => ({ set }),
      insert: jest
        .fn()
        .mockReturnValueOnce({ values: activityValues })
        .mockReturnValueOnce({
          values: () => ({
            onConflictDoNothing: () => ({ returning: () => Promise.resolve([watch]) }),
          }),
        })
        .mockReturnValueOnce({ values: activityValues }),
    };
    jest.mocked(db.transaction).mockImplementation(async callback => callback(tx as never));
    await expect(enableWatchPr(ctx, input)).resolves.toMatchObject({ id: watch.id });
    const query = new PgDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(query.params).toEqual([watch.repo_url, watch.pr_number, ctx.user.id, null]);
    expect(query.sql).toContain('NOT EXISTS');
    expect(query.sql).toContain('"cloud_agent_worktrees"."deletion_started_at" IS NULL');
    expect(query.sql).toContain(
      '"cloud_agent_worktrees"."kilo_user_id" = "cloud_agent_pr_watches"."kilo_user_id"'
    );
    expect(query.sql).toContain(
      '"cloud_agent_worktrees"."organization_id" IS NOT DISTINCT FROM "cloud_agent_pr_watches"."organization_id"'
    );
    expect(new PgDialect().sqlToQuery(set.mock.calls[0][0].lifecycle_reason).sql).toContain(
      "THEN 'expired' ELSE 'source_worktree_deleted'"
    );
    expect(activityValues).toHaveBeenCalledWith({
      watch_id: stale.id,
      generation: 2,
      kind: 'finished',
      reason: 'source_worktree_deleted',
    });
  });

  it.each(['expired', 'source_worktree_deleted'])(
    'settles %s as terminal before mutation',
    async reason => {
      const unavailable = {
        ...watch,
        expires_at: reason === 'expired' ? '2020-01-01T00:00:00Z' : watch.expires_at,
      };
      jest.mocked(db.query.cloud_agent_pr_watches.findFirst).mockResolvedValue(unavailable);
      if (reason === 'source_worktree_deleted')
        jest.mocked(db.query.cloud_agent_worktrees.findFirst).mockResolvedValue(undefined);
      const { set, values } = mockWatchTransaction(unavailable, {
        ...unavailable,
        generation: 2,
        status: 'finished',
        lifecycle_reason: reason,
      });
      await expect(
        changeWatchPr(ctx, { watchId: watch.id, generation: 1 }, 'pause')
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'finished', generation: 2, lifecycle_reason: reason })
      );
      expect(values).toHaveBeenCalledWith(expect.objectContaining({ kind: 'finished', reason }));
      expect(prGet).not.toHaveBeenCalled();
    }
  );

  it.each(['enable', 'resume'])(
    'gates %s with the strict release toggle before reading state',
    async action => {
      jest.mocked(isReleaseToggleEnabled).mockResolvedValue(false);
      const result =
        action === 'enable'
          ? enableWatchPr(ctx, input)
          : changeWatchPr(ctx, { watchId: watch.id, generation: 1 }, 'resume');
      await expect(result).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(isReleaseToggleEnabled).toHaveBeenCalledWith('cloud-agent-watch-pr', ctx.user.id);
      expect(db.query.cli_sessions_v2.findFirst).not.toHaveBeenCalled();
      expect(db.query.cloud_agent_pr_watches.findFirst).not.toHaveBeenCalled();
    }
  );
  it('rejects absent or inaccessible sessions before GitHub', async () => {
    jest.mocked(db.query.cli_sessions_v2.findFirst).mockResolvedValue(undefined);
    await expect(enableWatchPr(ctx, input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(generateGitHubInstallationToken).not.toHaveBeenCalled();
  });
  it('checks organization membership before repository access', async () => {
    jest
      .mocked(db.query.cli_sessions_v2.findFirst)
      .mockResolvedValue({ ...session, organization_id: 'org' });
    jest.mocked(ensureOrganizationAccess).mockRejectedValue(new Error('membership revoked'));
    await expect(enableWatchPr(ctx, input)).rejects.toThrow('membership revoked');
    expect(generateGitHubInstallationToken).not.toHaveBeenCalled();
  });
  it('requires a currently available exact integration', async () => {
    jest.mocked(db.query.platform_integrations.findFirst).mockResolvedValue(undefined);
    await expect(enableWatchPr(ctx, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('uses exact agent authorization and rejects inaccessible repository without creating state', async () => {
    jest.mocked(db.query.platform_integrations.findFirst).mockResolvedValue({
      id: watch.integration_id,
      platform_installation_id: '123',
      github_app_type: 'standard',
      repository_access: 'selected',
      permissions: { contents: 'write' },
      repositories: [],
    } as never);
    await expect(enableWatchPr(ctx, input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(generateGitHubInstallationToken).toHaveBeenCalledWith(
      '123',
      'standard',
      watch.integration_id,
      'agent'
    );
    expect(prGet).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it.each(['closed', 'fork', 'branch', 'head'])('rejects %s PR evidence', async reason => {
    const pr = (await prGet()).data;
    if (reason === 'closed') pr.state = 'closed';
    if (reason === 'fork') pr.head.repo = { id: 2, full_name: 'Other/Widgets' };
    if (reason === 'branch') pr.head.ref = 'unrelated';
    if (reason === 'head') pr.head.sha = 'c'.repeat(40);
    prGet.mockResolvedValue({ data: pr });
    await expect(enableWatchPr(ctx, input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('rejects stale generations and never resurrects a finished watch', async () => {
    await expect(
      changeWatchPr(ctx, { watchId: watch.id, generation: 2 }, 'stop')
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    jest
      .mocked(db.query.cloud_agent_pr_watches.findFirst)
      .mockResolvedValue({ ...watch, status: 'finished' });
    await expect(
      changeWatchPr(ctx, { watchId: watch.id, generation: 1 }, 'resume')
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
  it.each(['pause', 'stop'] as const)(
    'keeps %s available with flag off and performs generation CAS',
    async action => {
      jest.mocked(isReleaseToggleEnabled).mockResolvedValue(false);
      const updated = {
        ...watch,
        status: action === 'pause' ? 'paused' : 'finished',
        generation: 2,
      } as CloudAgentPrWatch;
      const returning = jest.fn().mockResolvedValue([updated]);
      const where = jest.fn().mockReturnValue({ returning });
      const set = jest.fn().mockReturnValue({ where });
      const values = jest.fn().mockResolvedValue(undefined);
      const tx = {
        update: jest.fn().mockReturnValue({ set }),
        insert: jest.fn().mockReturnValue({ values }),
      };
      jest.mocked(db.transaction).mockImplementation(async callback => callback(tx as never));
      await expect(
        changeWatchPr(ctx, { watchId: watch.id, generation: 1 }, action)
      ).resolves.toMatchObject({ status: updated.status, generation: 2 });
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ generation: 2, status: updated.status })
      );
      expect(where).toHaveBeenCalledTimes(1);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ watch_id: watch.id, generation: 2, kind: action })
      );
      expect(isReleaseToggleEnabled).not.toHaveBeenCalled();
      expect(generateGitHubInstallationToken).not.toHaveBeenCalled();
    }
  );
  it('reports lost CAS as a conflict without recording activity', async () => {
    const tx = {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
        }),
      }),
      insert: jest.fn(),
    };
    jest.mocked(db.transaction).mockImplementation(async callback => callback(tx as never));
    await expect(
      changeWatchPr(ctx, { watchId: watch.id, generation: 1 }, 'stop')
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(tx.insert).not.toHaveBeenCalled();
  });
  it('keeps get available with the flag off and no GitHub reads', async () => {
    jest.mocked(isReleaseToggleEnabled).mockResolvedValue(false);
    jest.mocked(db.select).mockReturnValue({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
    } as never);
    await expect(getWatchPr(ctx, queryInput)).resolves.toMatchObject({
      automaticRepairsAvailable: false,
      activity: [],
    });
    expect(isReleaseToggleEnabled).not.toHaveBeenCalled();
    expect(prGet).not.toHaveBeenCalled();
  });
});

describe('initial watch PR ancestry', () => {
  const advancedHeadSha = 'c'.repeat(40);
  const fullCommitPage = Array.from({ length: 100 }, () => ({ sha: 'd'.repeat(40) }));
  const watchValues = jest.fn();

  beforeEach(() => {
    watchValues.mockReturnValue({
      onConflictDoNothing: () => ({
        returning: () => Promise.resolve([{ ...watch, head_sha: advancedHeadSha }]),
      }),
    });
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => Promise.resolve([{ organization_id: null, deletion_started_at: null }]),
          }),
        }),
      }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
      insert: jest
        .fn()
        .mockReturnValueOnce({ values: watchValues })
        .mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    };
    jest.mocked(db.transaction).mockImplementation(async callback => callback(tx as never));
  });

  it('skips commit reads when the session SHA is still the PR head', async () => {
    await enableWatchPr(ctx, input);
    expect(prListCommits).not.toHaveBeenCalled();
    expect(prGet).toHaveBeenCalledTimes(1);
  });

  it('accepts a verified ancestor on a later page and stops before reading more pages', async () => {
    const pr = (await prGet()).data;
    pr.head.sha = advancedHeadSha;
    prGet.mockResolvedValue({ data: pr });
    prGet.mockClear();
    prListCommits.mockResolvedValueOnce({ data: fullCommitPage }).mockResolvedValueOnce({
      data: [{ sha: `  ${session.pr_head_sha?.toUpperCase()}  ` }, ...fullCommitPage.slice(1)],
    });

    await expect(enableWatchPr(ctx, input)).resolves.toMatchObject({ head_sha: advancedHeadSha });

    expect(prListCommits).toHaveBeenCalledTimes(2);
    expect(prListCommits).toHaveBeenNthCalledWith(2, {
      owner: 'kilo',
      repo: 'widgets',
      pull_number: 12,
      per_page: 100,
      page: 2,
    });
    expect(prGet).toHaveBeenCalledTimes(1);
    expect(watchValues).toHaveBeenCalledWith(
      expect.objectContaining({ head_sha: advancedHeadSha, pr_number: 12 })
    );
  });

  it('rejects an unrelated SHA after the final partial commit page', async () => {
    const pr = (await prGet()).data;
    pr.head.sha = advancedHeadSha;
    prGet.mockResolvedValue({ data: pr });
    prListCommits.mockResolvedValueOnce({ data: [{ sha: advancedHeadSha }] });

    await expect(enableWatchPr(ctx, input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(prListCommits).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('bounds ancestry verification to ten commit pages and fails closed', async () => {
    const pr = (await prGet()).data;
    pr.head.sha = advancedHeadSha;
    prGet.mockResolvedValue({ data: pr });
    prListCommits.mockResolvedValue({ data: fullCommitPage });

    await expect(enableWatchPr(ctx, input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(prListCommits).toHaveBeenCalledTimes(10);
    expect(prListCommits).toHaveBeenLastCalledWith(
      expect.objectContaining({ per_page: 100, page: 10 })
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each(['number', 'base repository', 'fork', 'branch'])(
    'does not use ancestry to bypass mismatched %s identity',
    async mismatch => {
      const pr = (await prGet()).data;
      pr.head.sha = advancedHeadSha;
      if (mismatch === 'number') pr.number = 13;
      if (mismatch === 'base repository') pr.base.repo.full_name = 'Other/Widgets';
      if (mismatch === 'fork') pr.head.repo = { id: 2, full_name: 'Other/Widgets' };
      if (mismatch === 'branch') pr.head.ref = 'unrelated';
      prGet.mockResolvedValue({ data: pr });
      prListCommits.mockResolvedValue({ data: [{ sha: session.pr_head_sha }] });

      await expect(enableWatchPr(ctx, input)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });

      expect(prListCommits).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    }
  );

  it('does not create a watch when ancestry cannot be fetched', async () => {
    const pr = (await prGet()).data;
    pr.head.sha = advancedHeadSha;
    prGet.mockResolvedValue({ data: pr });
    prListCommits.mockRejectedValueOnce(new Error('GitHub unavailable'));

    await expect(enableWatchPr(ctx, input)).rejects.toThrow('GitHub unavailable');

    expect(db.transaction).not.toHaveBeenCalled();
  });
});
