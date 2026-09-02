import 'server-only';

import { Buffer } from 'node:buffer';
import { TRPCError } from '@trpc/server';
import { Octokit } from '@octokit/rest';
import * as z from 'zod';
import type { User } from '@kilocode/db';
import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import { getUnblockedBotUserForOrg } from '@/lib/bot-users/bot-user-service';
import { ISOLATE_REVIEW_WORKER_URL } from '@/lib/config.server';
import {
  fetchGitHubRootTextFileAtRef,
  generateGitHubInstallationToken,
} from '@/lib/integrations/platforms/github/adapter';
import {
  createIsolateReviewWorkerClientForUser,
  IsolateReviewModeSchema,
  IsolateReviewSummaryContentSchema,
  IsolateReviewWorkerError,
  type IsolateReviewFallbackReason,
  type IsolateReviewInference,
  type IsolateReviewPreparation,
  type IsolateReviewSelection,
  type IsolateReviewStatus,
} from '@/lib/isolate-review-worker-client';
import { resolveIsolateReviewInference } from '@/lib/code-reviews/isolate-review-model';
import type { Owner } from './core';
import { DEFAULT_CODE_REVIEW_MODEL } from './core/constants';
import { resolveEffectiveModel } from './core/model-selection';
import {
  getManualCodeReviewAgentConfig,
  ManualCodeReviewJobInputSchema,
  normalizeManualInstructions,
  resolveConnectedGitHubSource,
} from './manual-code-review-jobs';
import {
  hashIsolateReviewText,
  ISOLATE_REVIEW_ADAPTER_VERSION,
  renderIsolateReviewPrompt,
} from './isolate-review-prompt';
import { getReviewAnalyticsEnabledFromConfig } from './analytics/settings';
import { getReviewPromptVersion } from './prompts/generate-prompt';
import { getCurrentReviewSummaryForContext } from './summary/history';
import { sanitizeUserInput } from './prompts/prompt-utils';
import {
  MAX_REVIEW_INSTRUCTIONS_CHARS,
  REVIEW_INSTRUCTIONS_FILE,
} from './prompts/repository-review-instructions';
import {
  prepareGitHubReviewContext,
  readRepositoryReviewInstructions,
} from './triggers/prepare-review-payload';

const MAX_INCREMENTAL_COMPARISON_BYTES = 2 * 1024 * 1024;
const GitHubShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const GitHubComparisonSchema = z.object({
  base_commit: z.object({ sha: GitHubShaSchema }),
  merge_base_commit: z.object({ sha: GitHubShaSchema }),
});
const GitHubFilePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    path =>
      path.trim() === path &&
      path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
  );
const GitHubIncrementalComparisonSchema = GitHubComparisonSchema.extend({
  status: z.enum(['ahead', 'behind', 'diverged', 'identical']),
  files: z
    .array(
      z.object({
        sha: GitHubShaSchema,
        filename: GitHubFilePathSchema,
        previous_filename: GitHubFilePathSchema.optional(),
        status: z.enum([
          'added',
          'removed',
          'modified',
          'renamed',
          'copied',
          'changed',
          'unchanged',
        ]),
        additions: z.number().int().nonnegative().safe(),
        deletions: z.number().int().nonnegative().safe(),
        changes: z.number().int().nonnegative().safe(),
        patch: z.string().optional(),
      })
    )
    .max(300),
});

export const ManualIsolateReviewInputSchema = z
  .object({
    url: z
      .string()
      .max(2048)
      .url()
      .regex(
        /^https:\/\/github\.com\/[a-zA-Z0-9][a-zA-Z0-9-]*\/(?!\.{1,2}\/)[a-zA-Z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/,
        'Enter a canonical https://github.com/owner/repo/pull/123 URL.'
      )
      .refine(value => Number.isSafeInteger(Number(value.match(/\/pull\/(\d+)\/?$/)?.[1])), {
        message: 'Invalid pull request number.',
      }),
    modelSlug: ManualCodeReviewJobInputSchema.shape.modelSlug.optional(),
    thinkingEffort: ManualCodeReviewJobInputSchema.shape.thinkingEffort,
    instructions: ManualCodeReviewJobInputSchema.shape.instructions,
    expectedHeadSha: GitHubShaSchema.optional(),
    previousRunId: z.uuid().optional(),
    reviewMode: IsolateReviewModeSchema.default('full'),
    dryRun: z.boolean().default(true),
  })
  .strict()
  .refine(input => input.modelSlug !== undefined || input.thinkingEffort === undefined, {
    message: 'thinkingEffort requires an explicit modelSlug.',
    path: ['thinkingEffort'],
  })
  .refine(input => input.reviewMode !== 'incremental' || input.previousRunId !== undefined, {
    message: 'Incremental reviews require a previousRunId.',
    path: ['previousRunId'],
  });

export const IsolateReviewRunInputSchema = z.object({ runId: z.uuid() }).strict();
export type ManualIsolateReviewInput = z.input<typeof ManualIsolateReviewInputSchema>;

export function assertManualIsolateReviewEnabled(): void {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.VERCEL_ENV !== undefined ||
    !ISOLATE_REVIEW_WORKER_URL.trim()
  ) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Manual isolate reviews are only available in configured local development.',
    });
  }
}

export function resolveManualIsolateReviewSettings(
  savedConfig: CodeReviewAgentConfig,
  repoFullName: string,
  input: Pick<ManualIsolateReviewInput, 'modelSlug' | 'thinkingEffort' | 'instructions'>
): {
  config: CodeReviewAgentConfig;
  modelSource: IsolateReviewPreparation['settings']['modelSource'];
  manualInstructions: string | null;
} {
  const selection =
    input.modelSlug === undefined
      ? resolveEffectiveModel(savedConfig, repoFullName, DEFAULT_CODE_REVIEW_MODEL)
      : {
          modelSlug: input.modelSlug,
          thinkingEffort: input.thinkingEffort ?? null,
          source: 'explicit' as const,
        };
  return {
    config: {
      ...savedConfig,
      model_slug: selection.modelSlug,
      thinking_effort: selection.thinkingEffort,
      council: undefined,
      council_enabled_repository_ids: [],
    },
    modelSource: selection.source === 'repository_override' ? 'repository' : selection.source,
    manualInstructions: normalizeManualInstructions(input.instructions),
  };
}

type ManualIsolateReviewScope = {
  user: User;
  organizationId?: string;
};

async function getExecutionUser({ user, organizationId }: ManualIsolateReviewScope): Promise<User> {
  if (user.is_bot) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'A human account must request manual isolate reviews.',
    });
  }
  if (!organizationId) return user;
  const bot = await getUnblockedBotUserForOrg(organizationId, 'code-review');
  if (!bot) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'An existing unblocked organization Code Reviewer bot is required.',
    });
  }
  return bot;
}

async function selectIncrementalReview(params: {
  previousRunId: string;
  previous: IsolateReviewStatus | null;
  current: Pick<
    IsolateReviewPreparation,
    'executionUserId' | 'organizationId' | 'snapshot' | 'github' | 'reviewInstructions' | 'versions'
  > & { owner: string; repo: string; pullNumber: number; settingsHash: string };
  octokit: Octokit;
}): Promise<{ reviewSelection: IsolateReviewSelection; previousSummaryBody?: string }> {
  const { previousRunId, previous, current, octokit } = params;
  const full = (fallbackReason: IsolateReviewFallbackReason) => ({
    reviewSelection: {
      requestedMode: 'incremental',
      effectiveMode: 'full',
      previousRunId,
      fallbackReason,
    } satisfies IsolateReviewSelection,
  });
  if (!previous) return full('previous_run_unavailable');
  if (
    previous.status !== 'completed' ||
    previous.terminationReason !== 'completed' ||
    previous.analysisOutcome?.status !== 'completed' ||
    previous.analysisOutcome.parentFinished !== true ||
    previous.analysisOutcome.parentFinishReason !== 'stop' ||
    (previous.analysisOutcome.contextIncompleteReasons?.length ?? 0) > 0 ||
    (previous.analysisOutcome.incompleteTaskIds?.length ?? 0) > 0
  ) {
    return full('previous_run_not_completed');
  }
  const preparation = previous.preparation;
  const previousSha = GitHubShaSchema.safeParse(previous.headSha);
  if (
    previous.runId !== previousRunId ||
    previous.provenance !== 'prepared' ||
    !preparation ||
    previous.userId !== current.executionUserId ||
    previous.organizationId !== current.organizationId ||
    previous.owner?.toLowerCase() !== current.owner.toLowerCase() ||
    previous.repo?.toLowerCase() !== current.repo.toLowerCase() ||
    previous.pullNumber !== current.pullNumber ||
    previous.installationId !== current.github.installationId ||
    previous.appType !== current.github.appType ||
    preparation.executionUserId !== current.executionUserId ||
    preparation.organizationId !== current.organizationId ||
    (current.organizationId === undefined &&
      preparation.requestingUserId !== current.executionUserId) ||
    preparation.github.integrationId !== current.github.integrationId ||
    preparation.github.installationId !== current.github.installationId ||
    preparation.github.appType !== current.github.appType ||
    !previousSha.success ||
    preparation.snapshot.headSha !== previousSha.data ||
    preparation.snapshot.baseTipSha !== previous.baseTipSha ||
    preparation.snapshot.mergeBaseSha !== previous.mergeBaseSha ||
    preparation.versions.policy !== current.versions.policy ||
    preparation.versions.adapter !== current.versions.adapter
  ) {
    return full('previous_run_incompatible');
  }
  if (previous.cleanupAt === undefined || previous.cleanupAt <= Date.now()) {
    return full('previous_run_unavailable');
  }
  const summary = IsolateReviewSummaryContentSchema.safeParse(previous.summaryContent);
  if (
    !summary.success ||
    hashIsolateReviewText(summary.data.body) !== summary.data.bodyHash ||
    !getCurrentReviewSummaryForContext(summary.data.body)
  ) {
    return full('previous_summary_unavailable');
  }
  if (preparation.hashes.settings !== current.settingsHash) return full('settings_changed');
  if (preparation.reviewInstructions?.hash !== current.reviewInstructions?.hash) {
    return full('review_instructions_changed');
  }
  if (
    preparation.snapshot.baseTipSha !== current.snapshot.baseTipSha ||
    preparation.snapshot.mergeBaseSha !== current.snapshot.mergeBaseSha
  ) {
    return full('base_changed');
  }
  if (previousSha.data === current.snapshot.headSha) return full('head_unchanged');
  let comparisonData: unknown;
  try {
    const response = await octokit.repos.compareCommits({
      owner: current.owner,
      repo: current.repo,
      base: previousSha.data,
      head: current.snapshot.headSha,
      per_page: 1,
    });
    const serialized = JSON.stringify(response.data);
    if (
      serialized !== undefined &&
      Buffer.byteLength(serialized, 'utf8') > MAX_INCREMENTAL_COMPARISON_BYTES
    ) {
      return full('comparison_unavailable');
    }
    comparisonData = response.data;
  } catch {
    return full('comparison_unavailable');
  }
  const comparison = GitHubIncrementalComparisonSchema.safeParse(comparisonData);
  if (!comparison.success) return full('comparison_incomplete');
  if (
    comparison.data.base_commit.sha !== previousSha.data ||
    comparison.data.merge_base_commit.sha !== previousSha.data ||
    comparison.data.status !== 'ahead'
  ) {
    return full('previous_head_not_ancestor');
  }
  const files = comparison.data.files;
  if (
    files.length >= 300 ||
    new Set(files.map(file => file.filename)).size !== files.length ||
    files.some(
      file =>
        file.additions + file.deletions !== file.changes ||
        (file.status === 'renamed' && !file.previous_filename)
    )
  ) {
    return full('comparison_incomplete');
  }
  return {
    reviewSelection: {
      requestedMode: 'incremental',
      effectiveMode: 'incremental',
      previousRunId,
      previousHeadSha: previousSha.data,
      previousSummaryHash: summary.data.bodyHash,
      changedFileCount: files.length,
    },
    previousSummaryBody: summary.data.body,
  };
}

export async function createManualIsolateReview(
  params: ManualIsolateReviewScope & { input: ManualIsolateReviewInput }
): Promise<{
  runId: string;
  preparation: IsolateReviewPreparation;
  inference: IsolateReviewInference;
}> {
  assertManualIsolateReviewEnabled();
  const input = ManualIsolateReviewInputSchema.parse(params.input);
  const executionUser = await getExecutionUser(params);
  const organizationId = params.organizationId;
  const owner: Owner = organizationId
    ? { type: 'org', id: organizationId, userId: executionUser.id }
    : { type: 'user', id: executionUser.id, userId: executionUser.id };
  const [source, savedConfig] = await Promise.all([
    resolveConnectedGitHubSource(owner, input.url),
    getManualCodeReviewAgentConfig(owner, 'github'),
  ]);
  const [, requestedOwner, requestedRepo, , requestedPullNumber] = new URL(
    input.url
  ).pathname.split('/');
  if (
    source.repoFullName.toLowerCase() !== `${requestedOwner}/${requestedRepo}`.toLowerCase() ||
    source.prNumber !== Number(requestedPullNumber)
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'GitHub returned a different pull request.',
    });
  }
  const [repoOwner, repoName] = source.repoFullName.split('/');
  const sourceSnapshot = z
    .object({ headSha: GitHubShaSchema, baseTipSha: GitHubShaSchema })
    .safeParse(source);
  if (!sourceSnapshot.success) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'GitHub did not provide a complete review snapshot.',
    });
  }
  const { headSha, baseTipSha } = sourceSnapshot.data;
  if (input.expectedHeadSha !== undefined && input.expectedHeadSha !== headSha) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The pull request head no longer matches expectedHeadSha.',
    });
  }
  const { config, modelSource, manualInstructions } = resolveManualIsolateReviewSettings(
    savedConfig,
    source.repoFullName,
    input
  );
  const tokenData = await generateGitHubInstallationToken(source.installationId, source.appType);
  const octokit = new Octokit({ auth: tokenData.token, request: { timeout: 10_000 } });
  const [existingReviewState, comparisonResponse, reviewInstructions, inference] =
    await Promise.all([
      prepareGitHubReviewContext({
        installationId: source.installationId,
        appType: source.appType,
        repoOwner,
        repoName,
        prNumber: source.prNumber,
      }),
      octokit.repos.compareCommits({
        owner: repoOwner,
        repo: repoName,
        base: baseTipSha,
        head: headSha,
        per_page: 1,
      }),
      config.disable_review_md === false
        ? readRepositoryReviewInstructions({
            ref: baseTipSha,
            fetchInstructions: () =>
              fetchGitHubRootTextFileAtRef({
                token: tokenData.token,
                owner: repoOwner,
                repo: repoName,
                path: REVIEW_INSTRUCTIONS_FILE,
                ref: baseTipSha,
              }),
          })
        : Promise.resolve({ content: null, used: false, ref: null, truncated: false }),
      resolveIsolateReviewInference({
        user: executionUser,
        organizationId,
        model: config.model_slug,
        thinkingEffort: config.thinking_effort,
      }),
    ]);
  const comparison = GitHubComparisonSchema.safeParse(comparisonResponse.data);
  if (!comparison.success || comparison.data.base_commit.sha !== baseTipSha) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'GitHub did not provide the exact comparison snapshot.',
    });
  }
  if (existingReviewState.headCommitSha !== headSha) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The pull request head changed during preparation.',
    });
  }
  const snapshot = { headSha, baseTipSha, mergeBaseSha: comparison.data.merge_base_commit.sha };
  const client = createIsolateReviewWorkerClientForUser(executionUser);
  const effectiveSettings = {
    reviewStyle: config.review_style,
    focusAreas: config.focus_areas,
    customInstructions: config.custom_instructions
      ? sanitizeUserInput(config.custom_instructions)
      : null,
    manualInstructions: manualInstructions ? sanitizeUserInput(manualInstructions) : null,
    model: config.model_slug,
    thinkingEffort: config.thinking_effort ?? null,
    disableReviewMd: config.disable_review_md !== false,
    analyticsEnabled: organizationId !== undefined && getReviewAnalyticsEnabledFromConfig(config),
  };
  const settings = { ...effectiveSettings, modelSource };
  const settingsHash = hashIsolateReviewText(JSON.stringify(effectiveSettings));
  const github = {
    integrationId: source.integrationId,
    installationId: source.installationId,
    appType: source.appType,
  };
  const versions = {
    cli: '7.4.20',
    policy: getReviewPromptVersion('github'),
    adapter: ISOLATE_REVIEW_ADAPTER_VERSION,
  } satisfies IsolateReviewPreparation['versions'];
  const reviewInstructionsMetadata: IsolateReviewPreparation['reviewInstructions'] =
    reviewInstructions.content
      ? {
          path: REVIEW_INSTRUCTIONS_FILE,
          sha: baseTipSha,
          hash: hashIsolateReviewText(reviewInstructions.content),
          characterCount: Math.min(
            reviewInstructions.content.length,
            MAX_REVIEW_INSTRUCTIONS_CHARS
          ),
          truncated: reviewInstructions.truncated,
        }
      : undefined;
  let previous: IsolateReviewStatus | null = null;
  if (input.previousRunId) {
    try {
      previous = await client.getReview(input.previousRunId);
    } catch (error) {
      if (
        input.reviewMode === 'full' ||
        (error instanceof IsolateReviewWorkerError && [401, 403].includes(error.status))
      ) {
        throw error;
      }
    }
  }
  const selected =
    input.reviewMode === 'incremental' && input.previousRunId
      ? await selectIncrementalReview({
          previousRunId: input.previousRunId,
          previous,
          current: {
            executionUserId: executionUser.id,
            organizationId,
            owner: repoOwner,
            repo: repoName,
            pullNumber: source.prNumber,
            snapshot,
            github,
            versions,
            reviewInstructions: reviewInstructionsMetadata,
            settingsHash,
          },
          octokit,
        })
      : {
          reviewSelection: {
            requestedMode: 'full',
            effectiveMode: 'full',
            ...(input.previousRunId ? { previousRunId: input.previousRunId } : {}),
          } satisfies IsolateReviewSelection,
          previousSummaryBody: undefined,
        };
  let existingSummaryCommentId: number | undefined;
  if (input.previousRunId) {
    const summary = existingReviewState.summaryComment;
    if (
      previous &&
      previous.runId === input.previousRunId &&
      previous.userId === executionUser.id &&
      previous.organizationId === organizationId &&
      previous.owner?.toLowerCase() === repoOwner.toLowerCase() &&
      previous.repo?.toLowerCase() === repoName.toLowerCase() &&
      previous.pullNumber === source.prNumber &&
      previous.installationId === source.installationId &&
      previous.appType === source.appType &&
      previous.publicationOutcome?.summary === 'confirmed' &&
      previous.summaryCommentId &&
      previous.summaryBodyHash &&
      /^[a-f0-9]{64}$/.test(previous.summaryBodyHash) &&
      summary?.commentId === previous.summaryCommentId &&
      summary.body.startsWith('<!-- kilo-review -->') &&
      !/<!--\s*\/?kilo-(?:review-history(?:-entry)?|usage|review-guidance)\s*-->/i.test(
        summary.body
      ) &&
      hashIsolateReviewText(summary.body) === previous.summaryBodyHash &&
      (input.reviewMode === 'full' ||
        (previous.preparation?.github.integrationId === github.integrationId &&
          previous.cleanupAt !== undefined &&
          previous.cleanupAt > Date.now()))
    ) {
      existingSummaryCommentId = previous.summaryCommentId;
    } else if (input.reviewMode === 'full') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'The previous run does not prove ownership of the unchanged current summary for this review.',
      });
    }
  }
  const rendered = await renderIsolateReviewPrompt({
    config,
    repoFullName: source.repoFullName,
    prNumber: source.prNumber,
    snapshot,
    reviewSelection: selected.reviewSelection,
    previousSummaryBody: selected.previousSummaryBody,
    existingReviewState,
    repositoryReviewInstructions: reviewInstructions.content,
    manualInstructions,
    organizationId,
    previousRunId: input.previousRunId,
    existingSummaryCommentId,
    dryRun: input.dryRun,
  });
  const preparation: IsolateReviewPreparation = {
    version: 1,
    preparedAt: new Date().toISOString(),
    requestingUserId: params.user.id,
    executionUserId: executionUser.id,
    organizationId,
    reviewSelection: selected.reviewSelection,
    settings,
    snapshot,
    github,
    ...(reviewInstructionsMetadata ? { reviewInstructions: reviewInstructionsMetadata } : {}),
    ...(rendered.readContextSummary
      ? {
          readContextSummary: {
            commentId: rendered.readContextSummary.commentId,
            bodyHash: hashIsolateReviewText(rendered.readContextSummary.body),
          },
        }
      : {}),
    hashes: {
      settings: settingsHash,
      context: hashIsolateReviewText(
        JSON.stringify({
          snapshot,
          reviewSelection: selected.reviewSelection,
          previousSummaryBody: rendered.previousSummaryBody ?? null,
          summary: rendered.readContextSummary,
          inlineComments: existingReviewState.inlineComments,
          reviewInstructions: reviewInstructions.content,
        })
      ),
      canonicalPrompt: hashIsolateReviewText(rendered.canonicalPrompt),
      adaptedPrompt: hashIsolateReviewText(rendered.userPrompt),
      system: rendered.runtimeAdapterHash,
    },
    versions,
    limitations: [
      'Incremental analysis requires a completed prepared candidate within its existing 24-hour retention and an exact ancestor comparison below 300 files; otherwise full review is selected.',
      'Web checks the optional incremental comparison against 2 MiB of reserialized JSON UTF-8 bytes after Octokit decoding, not a streaming transport cap. The Worker enforces the authoritative exact decoded-response byte limit.',
      'No canonical review record, Cloud fix link, or production analytics attempt is created.',
      'The system hash covers the web runtime adapter only, not the separately composed Worker system prompt.',
      ...(rendered.readContextSummary && !existingSummaryCommentId
        ? [
            'The current summary is read-only context; live publication requires Worker ownership preflight.',
          ]
        : []),
    ],
  };
  const { runId } = await client.startReview({
    owner: repoOwner,
    repo: repoName,
    pullNumber: source.prNumber,
    organizationId,
    ...snapshot,
    model: config.model_slug,
    thinkingEffort: config.thinking_effort ?? null,
    expectedIntegrationId: source.integrationId,
    expectedInstallationId: source.installationId,
    expectedAppType: source.appType,
    reviewMode: input.reviewMode,
    previousRunId: input.previousRunId,
    existingSummaryCommentId,
    dryRun: input.dryRun,
    userPrompt: rendered.userPrompt,
    inference,
    preparation,
  });
  return { runId, preparation, inference };
}

function requireReviewScope(
  review: IsolateReviewStatus | null,
  runId: string,
  executionUser: User,
  organizationId: string | undefined
): IsolateReviewStatus {
  if (
    !review ||
    review.runId !== runId ||
    review.userId !== executionUser.id ||
    review.organizationId !== organizationId
  ) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Isolate review not found.' });
  }
  return review;
}

export async function getManualIsolateReview(params: ManualIsolateReviewScope & { runId: string }) {
  assertManualIsolateReviewEnabled();
  const { runId } = IsolateReviewRunInputSchema.parse({ runId: params.runId });
  const executionUser = await getExecutionUser(params);
  const client = createIsolateReviewWorkerClientForUser(executionUser);
  return requireReviewScope(
    await client.getReview(runId),
    runId,
    executionUser,
    params.organizationId
  );
}

export async function getManualIsolateReviewTranscript(
  params: ManualIsolateReviewScope & { runId: string }
) {
  assertManualIsolateReviewEnabled();
  const { runId } = IsolateReviewRunInputSchema.parse({ runId: params.runId });
  const executionUser = await getExecutionUser(params);
  const client = createIsolateReviewWorkerClientForUser(executionUser);
  requireReviewScope(await client.getReview(runId), runId, executionUser, params.organizationId);
  const transcript = await client.getTranscript(runId);
  if (!transcript || transcript.runId !== runId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Isolate review transcript not found.' });
  }
  return transcript;
}
