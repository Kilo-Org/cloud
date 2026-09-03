let mockWorkerUrl = 'http://127.0.0.1:9019';
const mockGetManualCodeReviewAgentConfig = jest.fn();
const mockResolveConnectedGitHubSource = jest.fn();
const mockPrepareGitHubReviewContext = jest.fn();
const mockFetchGitHubRootTextFileAtRef = jest.fn();
const mockCompareCommits = jest.fn();
const mockGetUnblockedBotUserForOrg = jest.fn();
const mockResolveIsolateReviewInference = jest.fn();
const mockCreateIsolateReviewWorkerClientForUser = jest.fn();
const mockStartReview = jest.fn();
const mockGetReview = jest.fn();
const mockGetTranscript = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    repos: { compareCommits: (...args: unknown[]) => mockCompareCommits(...args) },
  })),
}));
jest.mock('@/lib/code-reviews/manual-code-review-jobs', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/code-reviews/manual-code-review-jobs'),
  getManualCodeReviewAgentConfig: (...args: unknown[]) =>
    mockGetManualCodeReviewAgentConfig(...args),
  resolveConnectedGitHubSource: (...args: unknown[]) => mockResolveConnectedGitHubSource(...args),
}));
jest.mock('@/lib/code-reviews/triggers/prepare-review-payload', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@/lib/code-reviews/triggers/prepare-review-payload'
  ),
  prepareGitHubReviewContext: (...args: unknown[]) => mockPrepareGitHubReviewContext(...args),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: jest.fn().mockResolvedValue({ token: 'installation-secret' }),
  fetchGitHubRootTextFileAtRef: (...args: unknown[]) => mockFetchGitHubRootTextFileAtRef(...args),
}));
jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getUnblockedBotUserForOrg: (...args: unknown[]) => mockGetUnblockedBotUserForOrg(...args),
}));
jest.mock('@/lib/code-reviews/isolate-review-model', () => ({
  resolveIsolateReviewInference: (...args: unknown[]) => mockResolveIsolateReviewInference(...args),
}));
jest.mock('@/lib/isolate-review-worker-client', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/isolate-review-worker-client'),
  createIsolateReviewWorkerClientForUser: (...args: unknown[]) =>
    mockCreateIsolateReviewWorkerClientForUser(...args),
}));

jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/config.server'),
  get ISOLATE_REVIEW_WORKER_URL() {
    return mockWorkerUrl;
  },
}));
jest.mock('@/lib/code-reviews/dispatch/dispatch-pending-reviews', () => ({
  tryDispatchPendingReviews: jest.fn(),
}));

import type { User } from '@kilocode/db';
import {
  IsolateReviewRequestSchema,
  IsolateReviewWorkerError,
  type IsolateReviewPreparation,
  type IsolateReviewStatus,
} from '@/lib/isolate-review-worker-client';
import { createDefaultCodeReviewConfig } from './core/default-config';
import { DEFAULT_CODE_REVIEW_MODEL } from './core/constants';
import { hashIsolateReviewText } from './isolate-review-prompt';
import {
  assertManualIsolateReviewEnabled,
  createManualIsolateReview,
  getManualIsolateReview,
  getManualIsolateReviewTranscript,
  IsolateReviewRunInputSchema,
  ManualIsolateReviewInputSchema,
  resolveManualIsolateReviewSettings,
} from './manual-isolate-reviews';

const url = 'https://github.com/owner/repo/pull/42';

describe('ManualIsolateReviewInputSchema', () => {
  it('defaults to dry-run and does not require a model', () => {
    expect(ManualIsolateReviewInputSchema.parse({ url })).toEqual({
      url,
      reviewMode: 'full',
      dryRun: true,
    });
  });

  it.each([
    'http://github.com/owner/repo/pull/42',
    'https://gitlab.com/owner/repo/pull/42',
    'https://github.com.evil.test/owner/repo/pull/42',
    'https://user:password@github.com/owner/repo/pull/42',
    'https://github.com:8443/owner/repo/pull/42',
    'https://github.com/owner/repo/pull/42?token=secret',
    'https://github.com/owner/repo/pull/42#comment',
    'https://github.com/owner/repo/pull/42/files',
    'https://github.com/owner/repo/pull/0',
    'https://github.com/owner/repo/pull/-1',
    'https://github.com/owner/repo/pull/1.5',
    'https://github.com/owner/repo%2Fother/pull/42',
    'https://github.com/owner//repo/pull/42',
    'https://github.com/owner/../pull/42',
    'https://github.com/owner/./pull/42',
    'https://github.com/owner/repo/pull/9007199254740992',
  ])('rejects a noncanonical or unsafe GitHub URL: %s', invalidUrl => {
    expect(ManualIsolateReviewInputSchema.safeParse({ url: invalidUrl }).success).toBe(false);
  });

  it.each([
    'userPrompt',
    'credentials',
    'userId',
    'installationId',
    'organizationId',
    'council',
    'previousSHA',
    'previousHeadSha',
    'previousSummaryBody',
    'summaryContent',
    'summary',
    'effectiveMode',
    'fallbackReason',
    'reviewSelection',
    'existingSummaryCommentId',
  ])('rejects caller-controlled %s rather than silently stripping it', field => {
    expect(ManualIsolateReviewInputSchema.safeParse({ url, [field]: 'injected' }).success).toBe(
      false
    );
  });

  it('requires an existing-run UUID only when incremental mode is explicitly requested', () => {
    const previousRunId = '1c69229b-41bb-42c3-8363-b2bc548d370c';
    expect(ManualIsolateReviewInputSchema.parse({ url, previousRunId })).toEqual({
      url,
      previousRunId,
      reviewMode: 'full',
      dryRun: true,
    });
    expect(
      ManualIsolateReviewInputSchema.parse({ url, previousRunId, reviewMode: 'incremental' })
    ).toMatchObject({ reviewMode: 'incremental', previousRunId });
    for (const input of [
      { reviewMode: 'incremental' },
      { reviewMode: 'incremental', previousRunId: 'legacy-run' },
      { reviewMode: 'auto', previousRunId },
      { reviewMode: null, previousRunId },
    ]) {
      expect(ManualIsolateReviewInputSchema.safeParse({ url, ...input }).success).toBe(false);
    }
  });

  it.each([null, 'high'])('requires an explicit model for thinking effort %j', thinkingEffort => {
    expect(ManualIsolateReviewInputSchema.safeParse({ url, thinkingEffort }).success).toBe(false);
  });

  it.each(['none', 'instant', 'thinking', 'minimal', 'xhigh', 'max', 'unknown'])(
    'preserves the variant key %s for model-owner validation',
    thinkingEffort => {
      expect(
        ManualIsolateReviewInputSchema.parse({ url, modelSlug: 'chosen-model', thinkingEffort })
      ).toMatchObject({ thinkingEffort });
    }
  );

  it('keeps manual-model bounds and rejects excessive instructions and identifiers', () => {
    expect(
      ManualIsolateReviewInputSchema.safeParse({ url, modelSlug: 'x'.repeat(512) }).success
    ).toBe(true);
    expect(
      ManualIsolateReviewInputSchema.safeParse({ url, modelSlug: 'x'.repeat(513) }).success
    ).toBe(false);
    expect(
      ManualIsolateReviewInputSchema.safeParse({
        url,
        modelSlug: 'model',
        thinkingEffort: 'x'.repeat(51),
      }).success
    ).toBe(false);
    expect(
      ManualIsolateReviewInputSchema.safeParse({ url, instructions: 'x'.repeat(4001) }).success
    ).toBe(false);
    expect(
      ManualIsolateReviewInputSchema.safeParse({ url, expectedHeadSha: 'old-branch' }).success
    ).toBe(false);
    expect(
      ManualIsolateReviewInputSchema.safeParse({ url, previousRunId: '../another-run' }).success
    ).toBe(false);
    expect(
      IsolateReviewRunInputSchema.safeParse({ runId: crypto.randomUUID(), userId: 'other' }).success
    ).toBe(false);
  });
});

describe('resolveManualIsolateReviewSettings', () => {
  const saved = {
    ...createDefaultCodeReviewConfig(),
    model_slug: 'saved-global',
    thinking_effort: 'high',
    repository_model_overrides: [
      {
        repository_id: 42,
        repo_full_name: 'owner/repo',
        model_slug: 'saved-repo',
        thinking_effort: 'max',
      },
    ],
  };

  it('uses the repository model and effort as a pair', () => {
    expect(resolveManualIsolateReviewSettings(saved, 'owner/repo', {})).toMatchObject({
      config: { model_slug: 'saved-repo', thinking_effort: 'max' },
      modelSource: 'repository',
    });
  });

  it('uses the global pair for a nonmatching repository', () => {
    expect(resolveManualIsolateReviewSettings(saved, 'other/repo', {})).toMatchObject({
      config: { model_slug: 'saved-global', thinking_effort: 'high' },
      modelSource: 'global',
    });
  });

  it('does not inherit global effort when a repository override omits it', () => {
    const config = {
      ...saved,
      repository_model_overrides: [
        { repository_id: 42, repo_full_name: 'owner/repo', model_slug: 'saved-repo' },
      ],
    };
    expect(resolveManualIsolateReviewSettings(config, 'owner/repo', {}).config).toMatchObject({
      model_slug: 'saved-repo',
      thinking_effort: null,
    });
  });

  it('uses the shared fallback for an empty global model and ignores a blank repository override', () => {
    const config = {
      ...saved,
      model_slug: '',
      repository_model_overrides: [
        { repository_id: 42, repo_full_name: 'owner/repo', model_slug: '', thinking_effort: 'max' },
      ],
    };
    expect(resolveManualIsolateReviewSettings(config, 'owner/repo', {})).toMatchObject({
      config: { model_slug: DEFAULT_CODE_REVIEW_MODEL, thinking_effort: 'high' },
      modelSource: 'global',
    });
  });

  it.each(['saved-global', 'saved-repo', 'different-model'])(
    'does not inherit effort for explicit model %s, including the same slug',
    modelSlug => {
      for (const thinkingEffort of [undefined, null]) {
        expect(
          resolveManualIsolateReviewSettings(saved, 'owner/repo', { modelSlug, thinkingEffort })
        ).toMatchObject({
          config: { model_slug: modelSlug, thinking_effort: null },
          modelSource: 'explicit',
        });
      }
    }
  );

  it('preserves explicit effort and trims additive instructions without changing saved configuration', () => {
    const config = {
      ...saved,
      custom_instructions: 'Saved instructions',
      council: { enabled: true, specialists: [], aggregation_strategy: 'unanimous' as const },
      council_enabled_repository_ids: [42],
    };
    const resolved = resolveManualIsolateReviewSettings(config, 'owner/repo', {
      modelSlug: 'chosen',
      thinkingEffort: 'instant',
      instructions: ' \nAdd manual checks\n ',
    });
    expect(resolved).toMatchObject({
      config: {
        model_slug: 'chosen',
        thinking_effort: 'instant',
        custom_instructions: 'Saved instructions',
        council_enabled_repository_ids: [],
      },
      modelSource: 'explicit',
      manualInstructions: 'Add manual checks',
    });
    expect(resolved.config.council).toBeUndefined();
    expect(config.council.enabled).toBe(true);
    expect(config.council_enabled_repository_ids).toEqual([42]);
    expect(
      resolveManualIsolateReviewSettings(config, 'owner/repo', { instructions: ' \n ' })
        .manualInstructions
    ).toBeNull();
  });
});

describe('assertManualIsolateReviewEnabled', () => {
  beforeEach(() => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development' };
    delete env.VERCEL_ENV;
    jest.replaceProperty(process, 'env', env);
    mockWorkerUrl = 'http://127.0.0.1:9019';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['', '1'])('is independent of DEBUG_SHOW_DEV_UI=%j', value => {
    process.env.DEBUG_SHOW_DEV_UI = value;
    expect(() => assertManualIsolateReviewEnabled()).not.toThrow();
  });

  it.each(['production', 'test'] as const)('rejects NODE_ENV=%s', nodeEnv => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: nodeEnv });
    expect(() => assertManualIsolateReviewEnabled()).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    );
  });

  it.each(['production', 'preview', 'development', ''])(
    'rejects a present VERCEL_ENV=%j',
    vercelEnv => {
      process.env.VERCEL_ENV = vercelEnv;
      expect(() => assertManualIsolateReviewEnabled()).toThrow(
        expect.objectContaining({ code: 'NOT_FOUND' })
      );
    }
  );

  it('rejects an unconfigured Worker', () => {
    mockWorkerUrl = '';
    expect(() => assertManualIsolateReviewEnabled()).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    );
  });
});

describe('manual isolate review preparation and authorized proxy', () => {
  const user = { id: 'oauth/github/human', is_bot: false, api_token_pepper: 'user-secret' } as User;
  const bot = { ...user, id: 'org-reviewer-bot', is_bot: true };
  const organizationId = '9349a984-b219-4eaa-a681-72e52c0db4ac';
  const runId = '071c635d-ea74-4f03-b6a0-330a6244ad52';
  const previousRunId = '1c69229b-41bb-42c3-8363-b2bc548d370c';
  const source = {
    platform: 'github',
    repoFullName: 'owner/repo',
    prNumber: 42,
    integrationId: 'integration-1',
    installationId: '1234',
    appType: 'standard',
    baseRef: 'main',
    headSha: 'a'.repeat(40),
    baseTipSha: 'b'.repeat(40),
  };
  const emptyState = {
    summaryComment: null,
    inlineComments: [],
    previousStatus: 'no-review',
    headCommitSha: source.headSha,
  };
  const summary = { commentId: 88, body: '<!-- kilo-review -->\nCurrent findings' };
  const prior: IsolateReviewStatus = {
    runId: previousRunId,
    status: 'completed',
    requestedModel: 'saved-model',
    dryRun: false,
    owner: 'owner',
    repo: 'repo',
    pullNumber: 42,
    userId: user.id,
    installationId: '1234',
    appType: 'standard',
    summaryCommentId: summary.commentId,
    summaryBodyHash: hashIsolateReviewText(summary.body),
    publicationOutcome: { review: 'not_requested', summary: 'confirmed' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development' };
    delete env.VERCEL_ENV;
    jest.replaceProperty(process, 'env', env);
    mockWorkerUrl = 'http://127.0.0.1:9019';
    mockGetUnblockedBotUserForOrg.mockResolvedValue(bot);
    mockResolveConnectedGitHubSource.mockResolvedValue(source);
    mockGetManualCodeReviewAgentConfig.mockResolvedValue({
      ...createDefaultCodeReviewConfig(),
      model_slug: 'saved-model',
      thinking_effort: 'high',
    });
    mockPrepareGitHubReviewContext.mockResolvedValue(emptyState);
    mockCompareCommits.mockResolvedValue({
      data: {
        base_commit: { sha: source.baseTipSha },
        merge_base_commit: { sha: 'c'.repeat(40) },
      },
    });
    mockFetchGitHubRootTextFileAtRef.mockResolvedValue('Check REVIEW.md policy.');
    mockResolveIsolateReviewInference.mockImplementation(
      async ({ model, thinkingEffort }: { model: string; thinkingEffort?: string | null }) => ({
        modelId: model,
        provider: 'anthropic',
        thinkingEffort: thinkingEffort ?? null,
        variant: thinkingEffort ? { reasoning: { effort: thinkingEffort } } : null,
        reasoningSupported: true,
        maxOutputTokens: 16_384,
      })
    );
    mockCreateIsolateReviewWorkerClientForUser.mockReturnValue({
      startReview: mockStartReview,
      getReview: mockGetReview,
      getTranscript: mockGetTranscript,
    });
    mockStartReview.mockImplementation(async (input: unknown) => {
      IsolateReviewRequestSchema.parse(input);
      return { runId };
    });
    mockGetReview.mockResolvedValue({ ...prior, runId });
    mockGetTranscript.mockResolvedValue({ runId, messages: [], toolCalls: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function startedRequest() {
    return IsolateReviewRequestSchema.parse(mockStartReview.mock.calls[0]?.[0]);
  }

  const previousHeadSha = 'd'.repeat(40);
  const previousSummaryBody = '<!-- kilo-review -->\nPrior unresolved finding in src/baseline.ts';
  const fullComparison = {
    base_commit: { sha: source.baseTipSha },
    merge_base_commit: { sha: 'c'.repeat(40) },
  };
  const deltaFile = {
    sha: 'f'.repeat(40),
    filename: 'src/changed.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    changes: 3,
  };
  const incrementalComparison = {
    base_commit: { sha: previousHeadSha },
    merge_base_commit: { sha: previousHeadSha },
    status: 'ahead',
    files: [deltaFile],
  };

  function setIncrementalComparison(data: unknown) {
    mockCompareCommits.mockImplementation(async ({ base }: { base: string }) => ({
      data: base === source.baseTipSha ? fullComparison : data,
    }));
  }

  async function completedPreparedBaseline(scopeOrganizationId?: string) {
    const result = await createManualIsolateReview({
      user,
      organizationId: scopeOrganizationId,
      input: { url },
    });
    const preparation: IsolateReviewPreparation = {
      ...result.preparation,
      snapshot: { ...result.preparation.snapshot, headSha: previousHeadSha },
    };
    const baseline = {
      runId: previousRunId,
      status: 'completed',
      requestedModel: preparation.settings.model,
      dryRun: true,
      owner: 'owner',
      repo: 'repo',
      pullNumber: source.prNumber,
      userId: preparation.executionUserId,
      organizationId: preparation.organizationId,
      ...preparation.snapshot,
      installationId: preparation.github.installationId,
      appType: preparation.github.appType,
      cleanupAt: Date.now() + 23 * 60 * 60 * 1_000,
      provenance: 'prepared',
      preparation,
      terminationReason: 'completed',
      analysisOutcome: {
        status: 'completed',
        stepCount: 3,
        parentFinishReason: 'stop',
        parentFinished: true,
        contextIncompleteReasons: [],
        incompleteTaskIds: [],
      },
      summaryContent: {
        body: previousSummaryBody,
        bodyHash: hashIsolateReviewText(previousSummaryBody),
      },
      publicationOutcome: { review: 'not_requested', summary: 'proposed' },
    } satisfies IsolateReviewStatus;
    mockStartReview.mockClear();
    mockCompareCommits.mockClear();
    mockGetReview.mockResolvedValue(baseline);
    setIncrementalComparison(incrementalComparison);
    return baseline;
  }

  it('starts a dry-run with immutable source, selected settings, inference and nonsecret provenance', async () => {
    const result = await createManualIsolateReview({
      user,
      input: { url, instructions: ' \nCheck `manual` ${policy}\n ' },
    });
    const request = startedRequest();
    expect(result).toMatchObject({
      runId,
      preparation: {
        version: 1,
        requestingUserId: user.id,
        executionUserId: user.id,
        settings: {
          model: 'saved-model',
          thinkingEffort: 'high',
          modelSource: 'global',
          manualInstructions: 'Check manual policy',
          analyticsEnabled: false,
        },
        snapshot: {
          headSha: source.headSha,
          baseTipSha: source.baseTipSha,
          mergeBaseSha: 'c'.repeat(40),
        },
        github: { integrationId: 'integration-1', installationId: '1234', appType: 'standard' },
        versions: { cli: '7.4.20', adapter: 'isolate-runtime-v2' },
        reviewSelection: { requestedMode: 'full', effectiveMode: 'full' },
      },
      inference: { modelId: 'saved-model', thinkingEffort: 'high' },
    });
    expect(request).toMatchObject({
      dryRun: true,
      expectedIntegrationId: 'integration-1',
      expectedInstallationId: '1234',
      expectedAppType: 'standard',
    });
    expect(request.existingSummaryCommentId).toBeUndefined();
    expect(result.preparation.hashes.adaptedPrompt).toBe(
      hashIsolateReviewText(request.userPrompt ?? '')
    );
    expect(mockCompareCommits).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      base: source.baseTipSha,
      head: source.headSha,
      per_page: 1,
    });
    expect(JSON.stringify(result)).not.toContain('installation-secret');
    expect(JSON.stringify(result)).not.toContain('user-secret');
    expect(result).not.toHaveProperty('userPrompt');
    expect(request.userPrompt).not.toContain('/cloud-agent-fork/review/');
  });

  it('hashes matching effective settings independently of explicit versus configured provenance', async () => {
    const configured = await createManualIsolateReview({ user, input: { url } });
    const explicit = await createManualIsolateReview({
      user,
      input: { url, modelSlug: 'saved-model', thinkingEffort: 'high' },
    });
    expect(configured.preparation.settings.modelSource).toBe('global');
    expect(explicit.preparation.settings.modelSource).toBe('explicit');
    expect(explicit.preparation.hashes.settings).toBe(configured.preparation.hashes.settings);
    expect(explicit.preparation.hashes.canonicalPrompt).toBe(
      configured.preparation.hashes.canonicalPrompt
    );
  });

  it('uses the organization bot for source access, model catalog, Worker authorization and billing', async () => {
    const result = await createManualIsolateReview({
      user,
      organizationId,
      input: { url, modelSlug: 'explicit-model' },
    });
    expect(result.preparation).toMatchObject({
      requestingUserId: user.id,
      executionUserId: bot.id,
      organizationId,
    });
    expect(mockResolveConnectedGitHubSource).toHaveBeenCalledWith(
      { type: 'org', id: organizationId, userId: bot.id },
      url
    );
    expect(mockResolveIsolateReviewInference).toHaveBeenCalledWith({
      user: bot,
      organizationId,
      model: 'explicit-model',
      thinkingEffort: null,
    });
    expect(mockCreateIsolateReviewWorkerClientForUser).toHaveBeenCalledWith(bot);
    expect(startedRequest()).toMatchObject({
      organizationId,
      model: 'explicit-model',
      thinkingEffort: null,
    });
  });

  it.each([undefined, true, false])(
    'fetches REVIEW.md only for disable_review_md=%j, pinned to the base tip',
    async disableReviewMd => {
      mockGetManualCodeReviewAgentConfig.mockResolvedValue({
        ...createDefaultCodeReviewConfig(),
        disable_review_md: disableReviewMd,
      });
      mockFetchGitHubRootTextFileAtRef.mockResolvedValue(' \u0000Base policy\r\n@other.md ');
      const result = await createManualIsolateReview({ user, input: { url } });
      if (disableReviewMd === false) {
        expect(mockFetchGitHubRootTextFileAtRef).toHaveBeenCalledWith({
          token: 'installation-secret',
          owner: 'owner',
          repo: 'repo',
          path: 'REVIEW.md',
          ref: source.baseTipSha,
        });
        expect(result.preparation.reviewInstructions).toEqual({
          path: 'REVIEW.md',
          sha: source.baseTipSha,
          hash: hashIsolateReviewText('Base policy\n@other.md'),
          characterCount: 21,
          truncated: false,
        });
        expect(startedRequest().userPrompt).toContain('Base policy\n@other.md');
      } else {
        expect(mockFetchGitHubRootTextFileAtRef).not.toHaveBeenCalled();
        expect(result.preparation.reviewInstructions).toBeUndefined();
      }
    }
  );

  it('records canonical REVIEW.md truncation without exceeding the manifest character bound', async () => {
    mockGetManualCodeReviewAgentConfig.mockResolvedValue({
      ...createDefaultCodeReviewConfig(),
      disable_review_md: false,
    });
    mockFetchGitHubRootTextFileAtRef.mockResolvedValue('x'.repeat(10_001));
    const result = await createManualIsolateReview({ user, input: { url } });
    expect(result.preparation.reviewInstructions).toMatchObject({
      characterCount: 10_000,
      truncated: true,
    });
    expect(startedRequest().userPrompt).toContain('[REVIEW.md truncated after 10000 characters.]');
  });

  it('records effective analytics enrollment without dispatching a production attempt', async () => {
    mockGetManualCodeReviewAgentConfig.mockResolvedValue({
      ...createDefaultCodeReviewConfig(),
      review_analytics_enabled: true,
    });
    const result = await createManualIsolateReview({ user, organizationId, input: { url } });
    expect(result.preparation.settings.analyticsEnabled).toBe(true);
    expect(startedRequest().userPrompt).toContain('# CODE REVIEW ANALYTICS MANIFEST');
  });

  it('fails admission for a caller head mismatch before further context or model resolution', async () => {
    await expect(
      createManualIsolateReview({ user, input: { url, expectedHeadSha: 'd'.repeat(40) } })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockPrepareGitHubReviewContext).not.toHaveBeenCalled();
    expect(mockResolveIsolateReviewInference).not.toHaveBeenCalled();
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it.each([
    { repoFullName: 'other/repo' },
    { prNumber: 43 },
    { baseTipSha: undefined },
    { headSha: 'not-a-sha' },
  ])('fails incomplete or mismatched source data: %j', async override => {
    mockResolveConnectedGitHubSource.mockResolvedValue({ ...source, ...override });
    await expect(createManualIsolateReview({ user, input: { url } })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it('fails a malformed exact comparison rather than inventing a merge base', async () => {
    mockCompareCommits.mockResolvedValue({ data: { base_commit: { sha: source.baseTipSha } } });
    await expect(createManualIsolateReview({ user, input: { url } })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it('fails a changed head during context preparation', async () => {
    mockPrepareGitHubReviewContext.mockResolvedValue({
      ...emptyState,
      headCommitSha: 'd'.repeat(40),
    });
    await expect(createManualIsolateReview({ user, input: { url } })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it.each(['context', 'instructions', 'model'] as const)(
    'does not start when required %s preparation fails',
    async dependency => {
      if (dependency === 'instructions') {
        mockGetManualCodeReviewAgentConfig.mockResolvedValue({
          ...createDefaultCodeReviewConfig(),
          disable_review_md: false,
        });
        mockFetchGitHubRootTextFileAtRef.mockRejectedValueOnce(new Error('required read failed'));
      } else if (dependency === 'context') {
        mockPrepareGitHubReviewContext.mockRejectedValueOnce(new Error('required read failed'));
      } else {
        mockResolveIsolateReviewInference.mockRejectedValueOnce(
          new Error('unsupported model variant')
        );
      }
      await expect(createManualIsolateReview({ user, input: { url } })).rejects.toThrow();
      expect(mockStartReview).not.toHaveBeenCalled();
    }
  );

  it('does not silently truncate an oversized full current summary', async () => {
    mockPrepareGitHubReviewContext.mockResolvedValue({
      ...emptyState,
      summaryComment: { ...summary, body: 'x'.repeat(64_000) },
    });
    await expect(createManualIsolateReview({ user, input: { url } })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it('treats automatically discovered summaries only as read context', async () => {
    mockPrepareGitHubReviewContext.mockResolvedValue({ ...emptyState, summaryComment: summary });
    const result = await createManualIsolateReview({ user, input: { url } });
    expect(result.preparation.readContextSummary).toEqual({
      commentId: summary.commentId,
      bodyHash: hashIsolateReviewText('Current findings'),
    });
    expect(startedRequest().existingSummaryCommentId).toBeUndefined();
    expect(mockGetReview).not.toHaveBeenCalled();
  });

  it('authorizes summary reuse only through an unchanged, same-scope confirmed previous run', async () => {
    mockPrepareGitHubReviewContext.mockResolvedValue({ ...emptyState, summaryComment: summary });
    mockGetReview.mockResolvedValue(prior);
    await createManualIsolateReview({ user, input: { url, previousRunId, dryRun: false } });
    expect(startedRequest()).toMatchObject({
      previousRunId,
      existingSummaryCommentId: 88,
      dryRun: false,
    });
    expect(mockGetReview).toHaveBeenCalledWith(previousRunId);
  });

  it.each([
    { userId: 'other-user' },
    { organizationId: 'other-org' },
    { owner: 'other-owner' },
    { repo: 'other-repo' },
    { pullNumber: 43 },
    { installationId: 'other-installation' },
    { appType: 'lite' },
    { runId: 'other-run' },
    { summaryCommentId: undefined },
    { summaryBodyHash: undefined },
    { summaryBodyHash: 'd'.repeat(64) },
    { userId: undefined, installationId: undefined, appType: undefined },
  ])('fails previous-run proof closed for mismatched or legacy state: %j', async override => {
    mockPrepareGitHubReviewContext.mockResolvedValue({ ...emptyState, summaryComment: summary });
    mockGetReview.mockResolvedValue({ ...prior, ...override });
    await expect(
      createManualIsolateReview({ user, input: { url, previousRunId } })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it('fails expired previous-run proof and same-bot body edits without relying on footer markers', async () => {
    mockPrepareGitHubReviewContext.mockResolvedValue({
      ...emptyState,
      summaryComment: { ...summary, body: summary.body + '\nSame-bot edit' },
    });
    mockGetReview.mockResolvedValue(prior);
    await expect(
      createManualIsolateReview({ user, input: { url, previousRunId } })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    mockGetReview.mockResolvedValue(null);
    await expect(
      createManualIsolateReview({ user, input: { url, previousRunId } })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it('selects a completed prepared dry-run baseline without granting any summary write authority', async () => {
    const baseline = await completedPreparedBaseline();
    const result = await createManualIsolateReview({
      user,
      input: { url, reviewMode: 'incremental', previousRunId },
    });
    const request = startedRequest();

    expect(result.preparation.reviewSelection).toEqual({
      requestedMode: 'incremental',
      effectiveMode: 'incremental',
      previousRunId,
      previousHeadSha,
      previousSummaryHash: baseline.summaryContent.bodyHash,
      changedFileCount: 1,
    });
    expect(request).toMatchObject({
      reviewMode: 'incremental',
      previousRunId,
      dryRun: true,
      ...result.preparation.snapshot,
    });
    expect(result.preparation.snapshot).toEqual({
      headSha: source.headSha,
      baseTipSha: source.baseTipSha,
      mergeBaseSha: 'c'.repeat(40),
    });
    expect(request.existingSummaryCommentId).toBeUndefined();
    expect(result.preparation.readContextSummary).toBeUndefined();
    expect(request.userPrompt).toContain('# INCREMENTAL REVIEW MODE');
    expect(request.userPrompt).toContain('Prior unresolved finding in src/baseline.ts');
    expect(request.userPrompt).toContain('## Summary Command: CREATE new comment');
    expect(request.userPrompt).toContain('"summaryMutationTarget":null');
    expect(mockCompareCommits).toHaveBeenLastCalledWith({
      owner: 'owner',
      repo: 'repo',
      base: previousHeadSha,
      head: source.headSha,
      per_page: 1,
    });
    expect(mockCompareCommits).toHaveBeenCalledTimes(2);
    expect(mockGetTranscript).not.toHaveBeenCalled();
    expect(result.preparation.hashes.settings).toBe(baseline.preparation.hashes.settings);
    expect(result.preparation.hashes.context).toBe(
      hashIsolateReviewText(
        JSON.stringify({
          snapshot: result.preparation.snapshot,
          reviewSelection: result.preparation.reviewSelection,
          previousSummaryBody: 'Prior unresolved finding in src/baseline.ts',
          summary: null,
          inlineComments: [],
          reviewInstructions: null,
        })
      )
    );
    expect(result.preparation.hashes.adaptedPrompt).toBe(
      hashIsolateReviewText(request.userPrompt ?? '')
    );
  });

  it('keeps previousRunId alone in full mode and requires its legacy publication ownership proof', async () => {
    await completedPreparedBaseline();
    await expect(
      createManualIsolateReview({ user, input: { url, previousRunId } })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(mockStartReview).not.toHaveBeenCalled();
    expect(mockCompareCommits).toHaveBeenCalledTimes(1);
  });

  it('allows case-insensitive repository identity and the same effective settings from an explicit model', async () => {
    const baseline = await completedPreparedBaseline();
    mockGetReview.mockResolvedValue({ ...baseline, owner: 'OWNER', repo: 'Repo' });
    const result = await createManualIsolateReview({
      user,
      input: {
        url,
        previousRunId,
        reviewMode: 'incremental',
        modelSlug: 'saved-model',
        thinkingEffort: 'high',
      },
    });

    expect(result.preparation.reviewSelection?.effectiveMode).toBe('incremental');
    expect(result.preparation.settings.modelSource).toBe('explicit');
    expect(result.preparation.hashes.settings).toBe(baseline.preparation.hashes.settings);
  });

  it('allows another requesting human in the same organization to use its completed reviewer-bot baseline', async () => {
    const baseline = await completedPreparedBaseline(organizationId);
    const otherMember = { ...user, id: 'oauth/github/another-member' };
    const result = await createManualIsolateReview({
      user: otherMember,
      organizationId,
      input: { url, previousRunId, reviewMode: 'incremental' },
    });

    expect(result.preparation).toMatchObject({
      requestingUserId: otherMember.id,
      executionUserId: bot.id,
      organizationId,
      reviewSelection: { effectiveMode: 'incremental' },
    });
    expect(baseline.preparation.requestingUserId).toBe(user.id);
    expect(mockCreateIsolateReviewWorkerClientForUser).toHaveBeenLastCalledWith(bot);
    expect(startedRequest().existingSummaryCommentId).toBeUndefined();
  });

  it.each([
    { status: 'pending' },
    { status: 'cloning' },
    { status: 'running' },
    { status: 'error' },
    { terminationReason: undefined },
    { terminationReason: 'required_context_incomplete' },
    { analysisOutcome: undefined },
    {
      analysisOutcome: {
        status: 'incomplete',
        stepCount: 3,
        parentFinished: true,
        parentFinishReason: 'stop',
      },
    },
    {
      analysisOutcome: {
        status: 'completed',
        stepCount: 3,
        parentFinished: false,
        parentFinishReason: 'stop',
      },
    },
    {
      analysisOutcome: {
        status: 'completed',
        stepCount: 3,
        parentFinished: true,
        parentFinishReason: 'length',
      },
    },
    {
      analysisOutcome: {
        status: 'completed',
        stepCount: 3,
        parentFinished: true,
        parentFinishReason: 'stop',
        contextIncompleteReasons: ['missing patch'],
      },
    },
    {
      analysisOutcome: {
        status: 'completed',
        stepCount: 3,
        parentFinished: true,
        parentFinishReason: 'stop',
        incompleteTaskIds: ['unfinished-child'],
      },
    },
  ])('falls back instead of trusting incomplete previous analysis: %j', async override => {
    const baseline = await completedPreparedBaseline();
    mockGetReview.mockResolvedValue({ ...baseline, ...override });
    const result = await createManualIsolateReview({
      user,
      input: { url, previousRunId, reviewMode: 'incremental' },
    });

    expect(result.preparation.reviewSelection).toEqual({
      requestedMode: 'incremental',
      effectiveMode: 'full',
      previousRunId,
      fallbackReason: 'previous_run_not_completed',
    });
    expect(startedRequest().userPrompt).not.toContain('# INCREMENTAL REVIEW MODE');
    expect(startedRequest().userPrompt).not.toContain(
      'Prior unresolved finding in src/baseline.ts'
    );
    expect(startedRequest().existingSummaryCommentId).toBeUndefined();
    expect(mockCompareCommits).toHaveBeenCalledTimes(1);
  });

  it.each([
    { provenance: 'raw' },
    { provenance: undefined },
    { preparation: undefined },
    { userId: 'other-user' },
    { organizationId: 'other-org' },
    { owner: 'other-owner' },
    { repo: 'other-repo' },
    { pullNumber: 43 },
    { installationId: 'different-installation' },
    { appType: 'lite' },
    { runId: '2c69229b-41bb-42c3-8363-b2bc548d370c' },
    { headSha: 'not-a-sha' },
    { headSha: undefined },
    { headSha: 'e'.repeat(40) },
    { baseTipSha: undefined },
    { mergeBaseSha: undefined },
  ])('falls back for a raw, legacy or incompatible previous run: %j', async override => {
    const baseline = await completedPreparedBaseline();
    mockGetReview.mockResolvedValue({ ...baseline, ...override });
    const result = await createManualIsolateReview({
      user,
      input: { url, previousRunId, reviewMode: 'incremental' },
    });

    expect(result.preparation.reviewSelection).toEqual({
      requestedMode: 'incremental',
      effectiveMode: 'full',
      previousRunId,
      fallbackReason: 'previous_run_incompatible',
    });
    expect(startedRequest().existingSummaryCommentId).toBeUndefined();
    expect(startedRequest().userPrompt).not.toContain(
      'Prior unresolved finding in src/baseline.ts'
    );
    expect(mockCompareCommits).toHaveBeenCalledTimes(1);
  });

  it.each([
    'execution',
    'requester',
    'organization',
    'integration',
    'installation',
    'app',
    'policy',
    'adapter',
  ] as const)(
    'requires compatible prepared %s metadata before using a previous analysis',
    async mismatch => {
      const baseline = await completedPreparedBaseline();
      const preparation = baseline.preparation;
      if (mismatch === 'execution') preparation.executionUserId = 'another-executor';
      if (mismatch === 'requester') preparation.requestingUserId = 'another-human';
      if (mismatch === 'organization') preparation.organizationId = 'another-org';
      if (mismatch === 'integration') preparation.github.integrationId = 'another-integration';
      if (mismatch === 'installation') preparation.github.installationId = 'another-installation';
      if (mismatch === 'app') preparation.github.appType = 'lite';
      if (mismatch === 'policy') preparation.versions.policy = 'previous-policy';
      if (mismatch === 'adapter') preparation.versions.adapter = 'isolate-runtime-v1';
      const result = await createManualIsolateReview({
        user,
        input: { url, previousRunId, reviewMode: 'incremental' },
      });

      expect(result.preparation.reviewSelection).toMatchObject({
        effectiveMode: 'full',
        fallbackReason: 'previous_run_incompatible',
      });
      expect(mockCompareCommits).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['missing', 'expired', 'missing-cleanup', 'network'] as const)(
    'falls back when the prior run is unavailable: %s',
    async unavailable => {
      const baseline = await completedPreparedBaseline();
      if (unavailable === 'missing') mockGetReview.mockResolvedValue(null);
      if (unavailable === 'expired')
        mockGetReview.mockResolvedValue({ ...baseline, cleanupAt: Date.now() - 1 });
      if (unavailable === 'missing-cleanup')
        mockGetReview.mockResolvedValue({ ...baseline, cleanupAt: undefined });
      if (unavailable === 'network')
        mockGetReview.mockRejectedValue(new Error('Worker unavailable'));
      const result = await createManualIsolateReview({
        user,
        input: { url, previousRunId, reviewMode: 'incremental' },
      });

      expect(result.preparation.reviewSelection).toEqual({
        requestedMode: 'incremental',
        effectiveMode: 'full',
        previousRunId,
        fallbackReason: 'previous_run_unavailable',
      });
      expect(mockCompareCommits).toHaveBeenCalledTimes(1);
      expect(startedRequest().existingSummaryCommentId).toBeUndefined();
    }
  );

  it.each([
    undefined,
    { body: previousSummaryBody, bodyHash: 'e'.repeat(64) },
    { body: previousSummaryBody, bodyHash: 'invalid' },
    { body: '', bodyHash: hashIsolateReviewText('') },
    { body: '<!-- kilo-review -->', bodyHash: hashIsolateReviewText('<!-- kilo-review -->') },
    { body: 'é'.repeat(32_769), bodyHash: hashIsolateReviewText('é'.repeat(32_769)) },
  ])(
    'requires retained bounded analysis content with its exact hash, not finalText or transcript',
    async summaryContent => {
      const baseline = await completedPreparedBaseline();
      mockGetReview.mockResolvedValue({
        ...baseline,
        summaryContent,
        finalText: 'Final text is not a trusted analysis summary',
      });
      const result = await createManualIsolateReview({
        user,
        input: { url, previousRunId, reviewMode: 'incremental' },
      });

      expect(result.preparation.reviewSelection).toMatchObject({
        effectiveMode: 'full',
        fallbackReason: 'previous_summary_unavailable',
      });
      expect(startedRequest().userPrompt).not.toContain(
        'Final text is not a trusted analysis summary'
      );
      expect(mockGetTranscript).not.toHaveBeenCalled();
      expect(mockCompareCommits).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    { review_style: 'strict' },
    { focus_areas: ['security'] },
    { custom_instructions: 'Different saved policy' },
    { model_slug: 'different-model' },
    { thinking_effort: 'low' },
    { disable_review_md: false },
  ])('falls back when effective saved review settings change: %j', async override => {
    await completedPreparedBaseline();
    mockGetManualCodeReviewAgentConfig.mockResolvedValue({
      ...createDefaultCodeReviewConfig(),
      model_slug: 'saved-model',
      thinking_effort: 'high',
      ...override,
    });
    const result = await createManualIsolateReview({
      user,
      input: { url, previousRunId, reviewMode: 'incremental' },
    });

    expect(result.preparation.reviewSelection).toMatchObject({
      effectiveMode: 'full',
      fallbackReason: 'settings_changed',
    });
    expect(mockCompareCommits).toHaveBeenCalledTimes(1);
  });

  it('falls back for changed manual instructions or analytics enrollment', async () => {
    await completedPreparedBaseline();
    const manual = await createManualIsolateReview({
      user,
      input: { url, previousRunId, reviewMode: 'incremental', instructions: 'New manual policy' },
    });
    expect(manual.preparation.reviewSelection).toMatchObject({
      effectiveMode: 'full',
      fallbackReason: 'settings_changed',
    });

    await completedPreparedBaseline(organizationId);
    mockGetManualCodeReviewAgentConfig.mockResolvedValue({
      ...createDefaultCodeReviewConfig(),
      model_slug: 'saved-model',
      thinking_effort: 'high',
      review_analytics_enabled: true,
    });
    const analytics = await createManualIsolateReview({
      user,
      organizationId,
      input: { url, previousRunId, reviewMode: 'incremental' },
    });
    expect(analytics.preparation.reviewSelection).toMatchObject({
      effectiveMode: 'full',
      fallbackReason: 'settings_changed',
    });
  });

  it.each([
    { before: 'Original repository policy', after: 'Changed repository policy' },
    { before: 'Original repository policy', after: null },
    { before: null, after: 'New repository policy' },
  ])('falls back when REVIEW.md content or presence changes: %j', async ({ before, after }) => {
    mockGetManualCodeReviewAgentConfig.mockResolvedValue({
      ...createDefaultCodeReviewConfig(),
      model_slug: 'saved-model',
      thinking_effort: 'high',
      disable_review_md: false,
    });
    mockFetchGitHubRootTextFileAtRef.mockResolvedValue(before);
    const baseline = await completedPreparedBaseline();
    mockFetchGitHubRootTextFileAtRef.mockResolvedValue(after);
    const result = await createManualIsolateReview({
      user,
      input: { url, previousRunId, reviewMode: 'incremental' },
    });

    expect(result.preparation.hashes.settings).toBe(baseline.preparation.hashes.settings);
    expect(result.preparation.reviewSelection).toMatchObject({
      effectiveMode: 'full',
      fallbackReason: 'review_instructions_changed',
    });
    expect(mockCompareCommits).toHaveBeenCalledTimes(1);
  });

  it.each(['baseTipSha', 'mergeBaseSha'] as const)('falls back for a changed %s', async field => {
    const baseline = await completedPreparedBaseline();
    mockGetReview.mockResolvedValue({
      ...baseline,
      [field]: 'e'.repeat(40),
      preparation: {
        ...baseline.preparation,
        snapshot: { ...baseline.preparation.snapshot, [field]: 'e'.repeat(40) },
      },
    });
    const result = await createManualIsolateReview({
      user,
      input: { url, previousRunId, reviewMode: 'incremental' },
    });

    expect(result.preparation.reviewSelection).toMatchObject({
      effectiveMode: 'full',
      fallbackReason: 'base_changed',
    });
    expect(mockCompareCommits).toHaveBeenCalledTimes(1);
  });

  it('falls back for an unchanged head instead of calling an empty incremental comparison', async () => {
    const baseline = await completedPreparedBaseline();
    mockGetReview.mockResolvedValue({
      ...baseline,
      headSha: source.headSha,
      preparation: {
        ...baseline.preparation,
        snapshot: { ...baseline.preparation.snapshot, headSha: source.headSha },
      },
    });
    const result = await createManualIsolateReview({
      user,
      input: { url, previousRunId, reviewMode: 'incremental' },
    });

    expect(result.preparation.reviewSelection).toEqual({
      requestedMode: 'incremental',
      effectiveMode: 'full',
      previousRunId,
      fallbackReason: 'head_unchanged',
    });
    expect(mockCompareCommits).toHaveBeenCalledTimes(1);
    expect(startedRequest().userPrompt).toContain('# WORKFLOW');
  });

  it.each([0, 299, 300, 301])(
    'only accepts exact unique incremental file counts below 300: %s',
    async count => {
      await completedPreparedBaseline();
      setIncrementalComparison({
        ...incrementalComparison,
        changed_files: 99_999,
        files: Array.from({ length: count }, (_, index) => ({
          ...deltaFile,
          filename: `src/file-${index}.ts`,
        })),
      });
      const result = await createManualIsolateReview({
        user,
        input: { url, previousRunId, reviewMode: 'incremental' },
      });

      if (count < 300) {
        expect(result.preparation.reviewSelection).toMatchObject({
          effectiveMode: 'incremental',
          changedFileCount: count,
        });
      } else {
        expect(result.preparation.reviewSelection).toEqual({
          requestedMode: 'incremental',
          effectiveMode: 'full',
          previousRunId,
          fallbackReason: 'comparison_incomplete',
        });
        expect(startedRequest().userPrompt).not.toContain('# INCREMENTAL REVIEW MODE');
      }
      expect(mockCompareCommits).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    { base_commit: { sha: 'e'.repeat(40) } },
    { merge_base_commit: { sha: 'e'.repeat(40) } },
    { status: 'diverged' },
    { status: 'behind' },
    { status: 'identical' },
  ])('falls back when the exact previous head is not provably an ancestor: %j', async override => {
    await completedPreparedBaseline();
    setIncrementalComparison({ ...incrementalComparison, ...override });
    const result = await createManualIsolateReview({
      user,
      input: { url, previousRunId, reviewMode: 'incremental' },
    });

    expect(result.preparation.reviewSelection).toEqual({
      requestedMode: 'incremental',
      effectiveMode: 'full',
      previousRunId,
      fallbackReason: 'previous_head_not_ancestor',
    });
    expect(mockCompareCommits).toHaveBeenCalledTimes(2);
  });

  it.each([
    { files: undefined },
    { base_commit: undefined },
    { merge_base_commit: undefined },
    { status: undefined },
    { files: [deltaFile, deltaFile] },
    { files: [{ ...deltaFile, filename: '' }] },
    { files: [{ ...deltaFile, filename: '/src/file.ts' }] },
    { files: [{ ...deltaFile, filename: 'src/../file.ts' }] },
    { files: [{ ...deltaFile, previous_filename: '../file.ts' }] },
    { files: [{ ...deltaFile, status: 'renamed' }] },
    { files: [{ ...deltaFile, sha: 'invalid' }] },
    { files: [{ ...deltaFile, status: 'invented' }] },
    { files: [{ ...deltaFile, additions: -1 }] },
    { files: [{ ...deltaFile, changes: 4 }] },
    { files: [{ ...deltaFile, patch: null }] },
  ])(
    'falls back for incomplete or invalid comparison metadata without a PR-files substitute: %j',
    async override => {
      await completedPreparedBaseline();
      setIncrementalComparison({ ...incrementalComparison, ...override });
      const result = await createManualIsolateReview({
        user,
        input: { url, previousRunId, reviewMode: 'incremental' },
      });

      expect(result.preparation.reviewSelection).toMatchObject({
        effectiveMode: 'full',
        fallbackReason: 'comparison_incomplete',
      });
      expect(mockCompareCommits).toHaveBeenCalledTimes(2);
      expect(startedRequest().userPrompt).not.toContain(
        'Prior unresolved finding in src/baseline.ts'
      );
    }
  );

  it.each(['patch', 'unused-payload'] as const)(
    'selects full review before rendering when a metadata-valid incremental comparison has oversized %s',
    async payloadSource => {
      await completedPreparedBaseline();
      const payload = 'é'.repeat(1024 * 1024);
      const currentFiles = [{ ...deltaFile, patch: '@@ -1 +1,2 @@\n-old\n+new\n+added' }];
      const comparison = {
        ...incrementalComparison,
        files: currentFiles,
        ...(payloadSource === 'patch'
          ? { files: [{ ...deltaFile, patch: `@@ -1 +1,2 @@\n-old\n+${payload}\n+added` }] }
          : { commits: [{ commit: { message: payload } }] }),
      };
      const serialized = JSON.stringify(comparison);
      expect(serialized.length).toBeLessThan(2 * 1024 * 1024);
      expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(2 * 1024 * 1024);
      mockCompareCommits.mockImplementation(async ({ base }: { base: string }) => ({
        data: base === source.baseTipSha ? { ...fullComparison, files: currentFiles } : comparison,
      }));
      const result = await createManualIsolateReview({
        user,
        input: { url, previousRunId, reviewMode: 'incremental' },
      });
      const request = startedRequest();

      expect(result.preparation.reviewSelection).toEqual({
        requestedMode: 'incremental',
        effectiveMode: 'full',
        previousRunId,
        fallbackReason: 'comparison_unavailable',
      });
      expect(request.preparation?.reviewSelection).toEqual(result.preparation.reviewSelection);
      expect(request.userPrompt).toContain('# WORKFLOW');
      expect(request.userPrompt).not.toContain('# INCREMENTAL REVIEW MODE');
      expect(request.userPrompt).not.toContain('Prior unresolved finding in src/baseline.ts');
      expect(result.preparation.hashes.adaptedPrompt).toBe(
        hashIsolateReviewText(request.userPrompt ?? '')
      );
      expect(result.preparation.limitations).toEqual(
        expect.arrayContaining([expect.stringContaining('reserialized JSON UTF-8 bytes')])
      );
      expect(mockCompareCommits).toHaveBeenNthCalledWith(1, {
        owner: 'owner',
        repo: 'repo',
        base: source.baseTipSha,
        head: source.headSha,
        per_page: 1,
      });
      expect(mockCompareCommits).toHaveBeenCalledTimes(2);
      expect(mockStartReview).toHaveBeenCalledTimes(1);
    }
  );

  it.each([0, 1])(
    'bounds the complete serialized incremental response at 2 MiB plus %s bytes',
    async extraBytes => {
      await completedPreparedBaseline();
      const comparison = { ...incrementalComparison, unused: '' };
      const overhead = Buffer.byteLength(JSON.stringify(comparison), 'utf8');
      comparison.unused = 'x'.repeat(2 * 1024 * 1024 - overhead + extraBytes);
      expect(Buffer.byteLength(JSON.stringify(comparison), 'utf8')).toBe(
        2 * 1024 * 1024 + extraBytes
      );
      setIncrementalComparison(comparison);
      const result = await createManualIsolateReview({
        user,
        input: { url, previousRunId, reviewMode: 'incremental' },
      });

      expect(result.preparation.reviewSelection).toMatchObject(
        extraBytes === 0
          ? { effectiveMode: 'incremental', changedFileCount: 1 }
          : { effectiveMode: 'full', fallbackReason: 'comparison_unavailable' }
      );
    }
  );

  it('falls back when the optional previous-to-current GitHub comparison is unavailable', async () => {
    await completedPreparedBaseline();
    mockCompareCommits.mockImplementation(async ({ base }: { base: string }) => {
      if (base === source.baseTipSha) return { data: fullComparison };
      throw new Error('GitHub comparison unavailable');
    });
    const result = await createManualIsolateReview({
      user,
      input: { url, previousRunId, reviewMode: 'incremental' },
    });

    expect(result.preparation.reviewSelection).toEqual({
      requestedMode: 'incremental',
      effectiveMode: 'full',
      previousRunId,
      fallbackReason: 'comparison_unavailable',
    });
    expect(startedRequest().reviewMode).toBe('incremental');
    expect(startedRequest().userPrompt).toContain('# WORKFLOW');
  });

  it.each(['source', 'full-comparison', 'model'] as const)(
    'does not turn required current %s failures into full-review fallback',
    async dependency => {
      await completedPreparedBaseline();
      const error = new Error('Current authorization or required context failed');
      if (dependency === 'source') mockResolveConnectedGitHubSource.mockRejectedValue(error);
      if (dependency === 'full-comparison') mockCompareCommits.mockRejectedValue(error);
      if (dependency === 'model') mockResolveIsolateReviewInference.mockRejectedValue(error);
      await expect(
        createManualIsolateReview({
          user,
          input: { url, previousRunId, reviewMode: 'incremental' },
        })
      ).rejects.toBe(error);
      expect(mockStartReview).not.toHaveBeenCalled();
      expect(mockGetReview).not.toHaveBeenCalled();
    }
  );

  it.each([401, 403])(
    'does not swallow current Worker authorization failure %s during baseline lookup',
    async status => {
      await completedPreparedBaseline();
      const error = new IsolateReviewWorkerError(status, 'Authorization failed');
      mockGetReview.mockRejectedValue(error);
      await expect(
        createManualIsolateReview({
          user,
          input: { url, previousRunId, reviewMode: 'incremental' },
        })
      ).rejects.toBe(error);
      expect(mockStartReview).not.toHaveBeenCalled();
    }
  );

  it.each(['raw-publication', 'analysis-only'] as const)(
    'deduplicates marked read context while checking ownership against the %s hash',
    async hashSource => {
      const baseline = await completedPreparedBaseline();
      const rawBody = `${baseline.summaryContent.body}\n<!-- kilo-isolate-review-summary:${hashIsolateReviewText(previousRunId)} -->`;
      const rawHash = hashIsolateReviewText(rawBody);
      const currentSummary = Object.freeze({ commentId: summary.commentId, body: rawBody });
      mockPrepareGitHubReviewContext.mockResolvedValue({
        ...emptyState,
        summaryComment: currentSummary,
      });
      mockGetReview.mockResolvedValue({
        ...baseline,
        dryRun: false,
        summaryCommentId: currentSummary.commentId,
        summaryBodyHash:
          hashSource === 'raw-publication' ? rawHash : baseline.summaryContent.bodyHash,
        publicationOutcome: { review: 'confirmed', summary: 'confirmed' },
      });
      const result = await createManualIsolateReview({
        user,
        input: { url, previousRunId, reviewMode: 'incremental' },
      });
      const request = startedRequest();

      expect(result.preparation.reviewSelection).toMatchObject({
        effectiveMode: 'incremental',
        previousSummaryHash: baseline.summaryContent.bodyHash,
      });
      expect(request.existingSummaryCommentId).toBe(
        hashSource === 'raw-publication' ? currentSummary.commentId : undefined
      );
      expect(result.preparation.readContextSummary).toEqual({
        commentId: currentSummary.commentId,
        bodyHash: hashIsolateReviewText('Prior unresolved finding in src/baseline.ts'),
      });
      expect(request.userPrompt?.split('Prior unresolved finding in src/baseline.ts')).toHaveLength(
        2
      );
      expect(request.userPrompt).not.toContain('<!-- kilo-isolate-review-summary:');
      expect(currentSummary.body).toBe(rawBody);
      expect(hashIsolateReviewText(currentSummary.body)).toBe(rawHash);
      expect(baseline.summaryContent.body).toBe(previousSummaryBody);
      expect(baseline.summaryContent.bodyHash).not.toBe(rawHash);
    }
  );

  it('separately proves confirmed publication reuse without equating its body hash to the analysis summary hash', async () => {
    const baseline = await completedPreparedBaseline();
    mockPrepareGitHubReviewContext.mockResolvedValue({ ...emptyState, summaryComment: summary });
    mockGetReview.mockResolvedValue({
      ...baseline,
      dryRun: false,
      summaryCommentId: summary.commentId,
      summaryBodyHash: hashIsolateReviewText(summary.body),
      publicationOutcome: { review: 'confirmed', summary: 'confirmed' },
    });
    const result = await createManualIsolateReview({
      user,
      input: { url, previousRunId, reviewMode: 'incremental', dryRun: false },
    });
    const request = startedRequest();

    expect(result.preparation.reviewSelection).toMatchObject({
      effectiveMode: 'incremental',
      previousSummaryHash: baseline.summaryContent.bodyHash,
    });
    expect(baseline.summaryContent.bodyHash).not.toBe(hashIsolateReviewText(summary.body));
    expect(request.existingSummaryCommentId).toBe(summary.commentId);
    expect(request.userPrompt).toContain(
      '"summaryMutationTarget":{"previousRunId":"' + previousRunId + '","commentId":88}'
    );
    expect(request.userPrompt).toContain('Prior unresolved finding in src/baseline.ts');
    expect(request.userPrompt).toContain('Current findings');
  });

  it.each([
    'discovered',
    'unconfirmed',
    'edited',
    'wrong-id',
    'unmarked',
    'production-footer',
  ] as const)(
    'keeps %s current summaries read-only while using a valid analysis baseline',
    async restriction => {
      const baseline = await completedPreparedBaseline();
      let current = summary;
      const previous: IsolateReviewStatus = {
        ...baseline,
        summaryCommentId: summary.commentId,
        summaryBodyHash: hashIsolateReviewText(summary.body),
        publicationOutcome: { review: 'not_requested', summary: 'confirmed' },
      };
      if (restriction === 'discovered') {
        previous.summaryCommentId = undefined;
        previous.summaryBodyHash = undefined;
      }
      if (restriction === 'unconfirmed')
        previous.publicationOutcome = { review: 'not_requested', summary: 'proposed' };
      if (restriction === 'edited') current = { ...summary, body: summary.body + '\nHuman edit' };
      if (restriction === 'wrong-id') current = { ...summary, commentId: 99 };
      if (restriction === 'unmarked') {
        current = { ...summary, body: 'Unmarked human summary' };
        previous.summaryBodyHash = hashIsolateReviewText(current.body);
      }
      if (restriction === 'production-footer') {
        current = { ...summary, body: summary.body + '\n<!-- kilo-usage -->\nProduction footer' };
        previous.summaryBodyHash = hashIsolateReviewText(current.body);
      }
      mockPrepareGitHubReviewContext.mockResolvedValue({ ...emptyState, summaryComment: current });
      mockGetReview.mockResolvedValue(previous);
      const result = await createManualIsolateReview({
        user,
        input: { url, previousRunId, reviewMode: 'incremental' },
      });

      expect(result.preparation.reviewSelection?.effectiveMode).toBe('incremental');
      expect(startedRequest().existingSummaryCommentId).toBeUndefined();
      expect(startedRequest().userPrompt).toContain('"summaryMutationTarget":null');
      expect(result.preparation.readContextSummary?.commentId).toBe(current.commentId);
    }
  );

  it('changes context and prompt hashes when actual retained analysis changes but preserves the settings hash', async () => {
    const baseline = await completedPreparedBaseline();
    const first = await createManualIsolateReview({
      user,
      input: { url, previousRunId, reviewMode: 'incremental' },
    });
    const changedBody = '<!-- kilo-review -->\nA different previously verified finding';
    mockGetReview.mockResolvedValue({
      ...baseline,
      summaryContent: { body: changedBody, bodyHash: hashIsolateReviewText(changedBody) },
    });
    const second = await createManualIsolateReview({
      user,
      input: { url, previousRunId, reviewMode: 'incremental' },
    });

    expect(second.preparation.hashes.settings).toBe(first.preparation.hashes.settings);
    expect(second.preparation.hashes.context).not.toBe(first.preparation.hashes.context);
    expect(second.preparation.hashes.canonicalPrompt).not.toBe(
      first.preparation.hashes.canonicalPrompt
    );
    expect(second.preparation.hashes.adaptedPrompt).not.toBe(
      first.preparation.hashes.adaptedPrompt
    );
  });

  it('hashes resolved fallback metadata without injecting unusable prior context into the full canonical prompt', async () => {
    const baseline = await completedPreparedBaseline();
    mockGetReview.mockResolvedValue(null);
    const unavailable = await createManualIsolateReview({
      user,
      input: { url, previousRunId, reviewMode: 'incremental' },
    });
    mockGetReview.mockResolvedValue({ ...baseline, status: 'error' });
    const incomplete = await createManualIsolateReview({
      user,
      input: { url, previousRunId, reviewMode: 'incremental' },
    });

    expect(unavailable.preparation.hashes.canonicalPrompt).toBe(
      incomplete.preparation.hashes.canonicalPrompt
    );
    expect(unavailable.preparation.hashes.settings).toBe(incomplete.preparation.hashes.settings);
    expect(unavailable.preparation.hashes.context).not.toBe(incomplete.preparation.hashes.context);
    expect(unavailable.preparation.hashes.adaptedPrompt).not.toBe(
      incomplete.preparation.hashes.adaptedPrompt
    );
  });

  it('returns status and transcript using the same personal execution identity', async () => {
    expect(await getManualIsolateReview({ user, runId })).toMatchObject({ runId, userId: user.id });
    expect(await getManualIsolateReviewTranscript({ user, runId })).toEqual({
      runId,
      messages: [],
      toolCalls: [],
    });
    expect(mockCreateIsolateReviewWorkerClientForUser).toHaveBeenCalledWith(user);
  });

  it.each([
    { userId: 'different-human' },
    { userId: undefined },
    { organizationId },
    { runId: previousRunId },
  ])('does not disclose personal status or transcript for %j', async override => {
    mockGetReview.mockResolvedValue({ ...prior, runId, ...override });
    await expect(getManualIsolateReview({ user, runId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(getManualIsolateReviewTranscript({ user, runId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mockGetTranscript).not.toHaveBeenCalled();
  });

  it('uses the existing organization execution identity for reads and rejects an organization mismatch', async () => {
    mockGetReview.mockResolvedValue({ ...prior, runId, userId: bot.id, organizationId });
    expect(await getManualIsolateReview({ user, organizationId, runId })).toMatchObject({
      userId: bot.id,
    });
    expect(await getManualIsolateReviewTranscript({ user, organizationId, runId })).toMatchObject({
      runId,
    });
    expect(mockCreateIsolateReviewWorkerClientForUser).toHaveBeenCalledWith(bot);
    mockGetReview.mockResolvedValue({
      ...prior,
      runId,
      userId: bot.id,
      organizationId: 'other-org',
    });
    mockGetTranscript.mockClear();
    await expect(
      getManualIsolateReviewTranscript({ user, organizationId, runId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockGetTranscript).not.toHaveBeenCalled();
  });

  it('requires an existing bot for organization creation and reads without provisioning one', async () => {
    mockGetUnblockedBotUserForOrg.mockResolvedValue(null);
    await expect(
      createManualIsolateReview({ user, organizationId, input: { url } })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(getManualIsolateReview({ user, organizationId, runId })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(
      getManualIsolateReviewTranscript({ user, organizationId, runId })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockCreateIsolateReviewWorkerClientForUser).not.toHaveBeenCalled();
    expect(mockResolveConnectedGitHubSource).not.toHaveBeenCalled();
  });

  it('does not allow a bot principal to use the human-facing API', async () => {
    await expect(createManualIsolateReview({ user: bot, input: { url } })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(getManualIsolateReview({ user: bot, runId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockCreateIsolateReviewWorkerClientForUser).not.toHaveBeenCalled();
  });

  it('gates all operations before source reads or Worker credentials in production', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
    await expect(createManualIsolateReview({ user, input: { url } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(getManualIsolateReview({ user, runId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(getManualIsolateReviewTranscript({ user, runId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mockCreateIsolateReviewWorkerClientForUser).not.toHaveBeenCalled();
    expect(mockResolveConnectedGitHubSource).not.toHaveBeenCalled();
  });
});
