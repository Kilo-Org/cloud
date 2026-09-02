import 'server-only';

import { Octokit } from '@octokit/rest';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { kilocode_users, organization_memberships } from '@kilocode/db/schema';
import { CodeReviewAgentConfigSchema } from '@kilocode/db/schema-types';
import { db } from '@/lib/drizzle';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import {
  fetchGitHubRootTextFileAtRef,
  generateGitHubInstallationToken,
} from '@/lib/integrations/platforms/github/adapter';
import {
  getGitHubAppCredentials,
  getGitHubAppName,
} from '@/lib/integrations/platforms/github/app-selector';
import {
  IsolateReviewPreparationSchema,
  IsolateReviewRequestSchema,
  type IsolateReviewPreparation,
} from '@/lib/isolate-review-worker-client';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import type { Owner } from '../core';
import { DEFAULT_CODE_REVIEW_MODEL } from '../core/constants';
import { resolveEffectiveModel } from '../core/model-selection';
import { getCodeReviewById, getLatestCodeReviewAttempt } from '../db/code-reviews';
import { getActiveCodeReviewPublicationFence } from '../db/publication-fences';
import { resolveIsolateReviewInference } from '../isolate-review-model';
import { hashIsolateReviewText, renderIsolateReviewPrompt } from '../isolate-review-prompt';
import { getManualCodeReviewConfig } from '../manual-config';
import { sanitizeUserInput } from '../prompts/prompt-utils';
import {
  MAX_REVIEW_INSTRUCTIONS_CHARS,
  REVIEW_INSTRUCTIONS_FILE,
} from '../prompts/repository-review-instructions';
import {
  QueuedIsolateIdentitySchema,
  sameQueuedIsolateIdentity,
  type QueuedIsolateIdentity,
} from '../queued-isolate-contract';
import { buildPreviousReviewSummaryHistory } from '../summary/history';
import {
  prepareGitHubReviewContext,
  readRepositoryReviewInstructions,
} from './prepare-review-payload';

const ShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const GitHubIdSchema = z.number().int().positive().safe();
const SummarySchema = z.object({
  id: GitHubIdSchema,
  body: z.string().max(65_536),
  issue_url: z.string(),
  user: z.object({ id: GitHubIdSchema, login: z.string(), type: z.literal('Bot') }),
  performed_via_github_app: z.object({ id: GitHubIdSchema }),
});

export async function findQueuedIsolateReviewSummary(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  appId: number;
  authorLogin: string;
}): Promise<{ commentId: number; body: string } | null> {
  const { octokit, owner, repo, pullNumber, appId, authorLogin } = params;
  let latest: { commentId: number; body: string; updatedAt: number } | null = null;
  const candidateSchema = SummarySchema.extend({ updated_at: z.iso.datetime() });
  for (let page = 1; page <= 5; page++) {
    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
      page,
    });
    for (const comment of comments) {
      const parsed = candidateSchema.safeParse(comment);
      if (!parsed.success) continue;
      const summary = parsed.data;
      if (
        !summary.body.startsWith('<!-- kilo-review -->') ||
        summary.performed_via_github_app.id !== appId ||
        summary.user.login.toLowerCase() !== authorLogin.toLowerCase() ||
        summary.issue_url.toLowerCase() !==
          `https://api.github.com/repos/${owner}/${repo}/issues/${pullNumber}`.toLowerCase()
      )
        continue;
      const updatedAt = new Date(summary.updated_at).getTime();
      if (!latest || updatedAt > latest.updatedAt)
        latest = { commentId: summary.id, body: summary.body, updatedAt };
    }
    if (comments.length < 100)
      return latest ? { commentId: latest.commentId, body: latest.body } : null;
  }
  throw new Error('Queued summary lookup exceeded the safe issue-comment scan limit');
}

export async function fetchIsolateReviewSnapshot(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  expectedHeadSha: string;
}) {
  const { octokit, owner, repo, pullNumber, expectedHeadSha } = params;
  const pull = z
    .object({
      number: z.literal(pullNumber),
      state: z.literal('open'),
      draft: z.literal(false),
      head: z.object({ sha: ShaSchema }),
      base: z.object({ sha: ShaSchema, repo: z.object({ full_name: z.string() }) }),
    })
    .parse((await octokit.pulls.get({ owner, repo, pull_number: pullNumber })).data);
  if (
    pull.head.sha !== expectedHeadSha ||
    pull.base.repo.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()
  ) {
    throw new Error('The pull request no longer matches the canonical review');
  }
  const comparison = z
    .object({
      base_commit: z.object({ sha: z.literal(pull.base.sha) }),
      merge_base_commit: z.object({ sha: ShaSchema }),
    })
    .parse(
      (
        await octokit.repos.compareCommits({
          owner,
          repo,
          base: pull.base.sha,
          head: pull.head.sha,
          per_page: 1,
        })
      ).data
    );
  return {
    headSha: pull.head.sha,
    baseTipSha: pull.base.sha,
    mergeBaseSha: comparison.merge_base_commit.sha,
  };
}

export async function prepareIsolateReviewPayload(params: {
  identity: QueuedIsolateIdentity;
  owner: Owner;
  dispatchReservationId: string;
  agentConfig: { config: unknown };
}) {
  const identity = QueuedIsolateIdentitySchema.parse(params.identity);
  const { owner, dispatchReservationId } = params;
  const assertCanonical = async () => {
    const [review, attempt, fence] = await Promise.all([
      getCodeReviewById(identity.reviewId),
      getLatestCodeReviewAttempt(identity.reviewId),
      db.transaction(tx => getActiveCodeReviewPublicationFence(tx, identity.target)),
    ]);
    if (
      owner.type !== 'org' ||
      owner.id !== identity.organizationId ||
      owner.userId !== identity.executionUserId ||
      !review ||
      review.status !== 'queued' ||
      review.dispatch_reservation_id !== dispatchReservationId ||
      review.platform !== 'github' ||
      review.review_type !== 'standard' ||
      review.owned_by_user_id !== null ||
      review.owned_by_organization_id !== identity.organizationId ||
      review.platform_integration_id !== identity.integrationId ||
      review.repo_full_name.toLowerCase() !== identity.target.repoFullName ||
      review.pr_number !== identity.target.prNumber ||
      review.head_sha !== identity.snapshot.headSha ||
      !attempt ||
      attempt.id !== identity.attemptId ||
      attempt.reviewer_backend !== 'isolate' ||
      attempt.reviewer_execution_id !== identity.attemptId ||
      !['pending', 'queued'].includes(attempt.status) ||
      !fence ||
      !sameQueuedIsolateIdentity(QueuedIsolateIdentitySchema.parse(fence.identity), identity) ||
      fence.released_at !== null
    )
      throw new Error(
        'Queued isolate preparation requires the current canonical attempt and fence'
      );
    return { review, attempt };
  };
  const { review, attempt } = await assertCanonical();
  const manual = getManualCodeReviewConfig(review);
  if (manual && manual.outputMode !== 'provider')
    throw new Error('Queued isolate requires provider output');
  const saved = CodeReviewAgentConfigSchema.parse(manual?.agentConfig ?? params.agentConfig.config);
  const model = manual
    ? {
        modelSlug: saved.model_slug,
        thinkingEffort: saved.thinking_effort ?? null,
        source: 'explicit' as const,
      }
    : resolveEffectiveModel(saved, review.repo_full_name, DEFAULT_CODE_REVIEW_MODEL);
  const config = {
    ...saved,
    model_slug: model.modelSlug,
    thinking_effort: model.thinkingEffort,
    review_analytics_enabled: attempt.analytics_enabled_at_dispatch === true,
  };
  const [integration, users] = await Promise.all([
    getIntegrationById(identity.integrationId, identity.organizationId),
    db
      .select({ user: kilocode_users })
      .from(kilocode_users)
      .innerJoin(
        organization_memberships,
        and(
          eq(organization_memberships.kilo_user_id, kilocode_users.id),
          eq(organization_memberships.organization_id, identity.organizationId)
        )
      )
      .where(
        and(
          eq(kilocode_users.id, identity.executionUserId),
          isNull(kilocode_users.blocked_at),
          isNull(kilocode_users.blocked_reason)
        )
      )
      .limit(1),
  ]);
  const user = users[0]?.user;
  if (!user) throw new Error('Queued isolate execution identity is unavailable or blocked');
  if (
    !integration ||
    integration.id !== identity.integrationId ||
    integration.platform !== 'github' ||
    integration.integration_status !== 'active' ||
    integration.auth_invalid_at !== null ||
    integration.owned_by_organization_id !== identity.organizationId ||
    integration.owned_by_user_id !== null ||
    !integration.platform_installation_id ||
    (integration.github_app_type ?? 'standard') !== 'standard'
  ) {
    throw new Error('Queued isolate requires its exact active organization GitHub integration');
  }
  const installationId = integration.platform_installation_id;
  const [repoOwner, repoName] = identity.target.repoFullName.split('/');
  const { token } = await generateGitHubInstallationToken(installationId, 'standard');
  const octokit = new Octokit({ auth: token, request: { timeout: 10_000 } });
  const snapshot = await fetchIsolateReviewSnapshot({
    octokit,
    owner: repoOwner,
    repo: repoName,
    pullNumber: review.pr_number,
    expectedHeadSha: identity.snapshot.headSha,
  });
  if (
    snapshot.baseTipSha !== identity.snapshot.baseTipSha ||
    snapshot.mergeBaseSha !== identity.snapshot.mergeBaseSha
  ) {
    throw new Error('The pull request comparison changed after canonical selection');
  }
  const appId = z.coerce
    .number()
    .int()
    .positive()
    .safe()
    .parse(getGitHubAppCredentials('standard').appId);
  const authorLogin = `${getGitHubAppName('standard').toLowerCase()}[bot]`;
  const [context, instructions, inference] = await Promise.all([
    prepareGitHubReviewContext({
      installationId,
      appType: 'standard',
      repoOwner,
      repoName,
      prNumber: review.pr_number,
      findSummaryComment: () =>
        findQueuedIsolateReviewSummary({
          octokit,
          owner: repoOwner,
          repo: repoName,
          pullNumber: review.pr_number,
          appId,
          authorLogin,
        }),
    }),
    config.disable_review_md === false
      ? readRepositoryReviewInstructions({
          ref: snapshot.baseTipSha,
          fetchInstructions: () =>
            fetchGitHubRootTextFileAtRef({
              token,
              owner: repoOwner,
              repo: repoName,
              path: REVIEW_INSTRUCTIONS_FILE,
              ref: snapshot.baseTipSha,
            }),
        })
      : Promise.resolve({ content: null, used: false, ref: null, truncated: false }),
    resolveIsolateReviewInference({
      user,
      organizationId: identity.organizationId,
      model: config.model_slug,
      thinkingEffort: config.thinking_effort,
    }),
  ]);
  if (context.headCommitSha !== snapshot.headSha)
    throw new Error('The pull request head changed during preparation');
  const queued: NonNullable<IsolateReviewPreparation['queued']> = {
    identity,
    gateThreshold: config.gate_threshold ?? 'off',
    summaryHistory: '',
  };
  if (context.summaryComment) {
    const summary = SummarySchema.parse(
      (
        await octokit.issues.getComment({
          owner: repoOwner,
          repo: repoName,
          comment_id: context.summaryComment.commentId,
        })
      ).data
    );
    if (
      summary.id !== context.summaryComment.commentId ||
      summary.body !== context.summaryComment.body ||
      !summary.body.startsWith('<!-- kilo-review -->') ||
      summary.issue_url.toLowerCase() !==
        `https://api.github.com/repos/${identity.target.repoFullName}/issues/${review.pr_number}` ||
      summary.performed_via_github_app.id !== appId ||
      summary.user.login.toLowerCase() !== authorLogin
    ) {
      throw new Error('The canonical summary failed app, author, marker, or target validation');
    }
    queued.summaryTarget = {
      commentId: summary.id,
      bodyHash: hashIsolateReviewText(summary.body),
      authorId: summary.user.id,
      authorLogin: summary.user.login,
      appId,
    };
    queued.summaryHistory = buildPreviousReviewSummaryHistory(
      summary.body.replace(/\n?<!--\s*kilo-isolate-review-summary:[^>]*-->/gi, '')
    );
  }
  const manualInstructions = manual?.instructions ?? null;
  const selection = { requestedMode: 'full', effectiveMode: 'full' } as const;
  const rendered = await renderIsolateReviewPrompt({
    config,
    repoFullName: review.repo_full_name,
    prNumber: review.pr_number,
    snapshot,
    reviewSelection: selection,
    existingReviewState: context,
    repositoryReviewInstructions: instructions.content,
    manualInstructions,
    organizationId: identity.organizationId,
    dryRun: false,
    queued,
  });
  const settings = {
    reviewStyle: config.review_style,
    focusAreas: config.focus_areas,
    customInstructions: config.custom_instructions
      ? sanitizeUserInput(config.custom_instructions)
      : null,
    manualInstructions: manualInstructions ? sanitizeUserInput(manualInstructions) : null,
    model: config.model_slug,
    thinkingEffort: config.thinking_effort ?? null,
    modelSource: model.source === 'repository_override' ? 'repository' : model.source,
    disableReviewMd: config.disable_review_md !== false,
    analyticsEnabled: rendered.analyticsEnabled,
  };
  const preparation = IsolateReviewPreparationSchema.parse({
    version: 1,
    preparedAt: new Date().toISOString(),
    requestingUserId: user.id,
    executionUserId: user.id,
    organizationId: identity.organizationId,
    queued,
    reviewSelection: selection,
    settings,
    snapshot,
    github: { integrationId: integration.id, installationId, appType: 'standard' },
    ...(instructions.content
      ? {
          reviewInstructions: {
            path: REVIEW_INSTRUCTIONS_FILE,
            sha: snapshot.baseTipSha,
            hash: hashIsolateReviewText(instructions.content),
            characterCount: Math.min(instructions.content.length, MAX_REVIEW_INSTRUCTIONS_CHARS),
            truncated: instructions.truncated,
          },
        }
      : {}),
    ...(rendered.readContextSummary
      ? {
          readContextSummary: {
            commentId: rendered.readContextSummary.commentId,
            bodyHash: hashIsolateReviewText(rendered.readContextSummary.body),
          },
        }
      : {}),
    hashes: {
      settings: hashIsolateReviewText(JSON.stringify(settings)),
      context: hashIsolateReviewText(
        JSON.stringify({ snapshot, context, instructions: instructions.content, queued })
      ),
      canonicalPrompt: hashIsolateReviewText(rendered.canonicalPrompt),
      adaptedPrompt: hashIsolateReviewText(rendered.userPrompt),
      system: rendered.runtimeAdapterHash,
    },
    versions: { cli: '7.4.20', policy: rendered.policyVersion, adapter: rendered.adapterVersion },
    limitations: [
      'Full analysis; no Cloud Agent continuation or fabricated CLI session.',
      'Requesting identity is the canonical dispatch execution user; the review row does not retain the original human requester.',
      'Publication hash checks cannot prevent a pre-existing legacy write from racing afterward.',
    ],
  });
  const request = IsolateReviewRequestSchema.parse({
    owner: repoOwner,
    repo: repoName,
    pullNumber: review.pr_number,
    organizationId: identity.organizationId,
    ...snapshot,
    model: config.model_slug,
    thinkingEffort: config.thinking_effort ?? null,
    expectedIntegrationId: integration.id,
    expectedInstallationId: installationId,
    expectedAppType: 'standard',
    reviewMode: 'full',
    dryRun: false,
    userPrompt: rendered.userPrompt,
    inference,
    preparation,
  });
  await assertCanonical();
  return {
    review: request,
    admission: {
      version: 1 as const,
      runId: identity.attemptId,
      identity,
      preparationHash: hashIsolateReviewText(JSON.stringify(request)),
    },
    authToken: generateApiToken(
      user,
      { tokenSource: 'isolate-review', botId: 'reviewer', organizationId: identity.organizationId },
      { expiresIn: TOKEN_EXPIRY.oneHour }
    ),
  };
}
