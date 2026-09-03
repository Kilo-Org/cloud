import 'server-only';

import type { User } from '@kilocode/db';
import * as z from 'zod';
import { ISOLATE_REVIEW_WORKER_URL, INTERNAL_API_SECRET } from '@/lib/config.server';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';

const FETCH_TIMEOUT_MS = 10_000;

export const MAX_REVIEW_PROMPT_CHARACTERS = 64_000;
export const MAX_REVIEW_SUMMARY_BYTES = 64 * 1024;

const IdentifierSchema = z.string().min(1).max(256);
const ShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, 'Must be a full git commit SHA');
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const ModelSchema = z.string().min(1).max(512);
const ThinkingEffortSchema = z.string().min(1).max(50).nullable();
const AppTypeSchema = z.enum(['standard', 'lite']);

export const IsolateReviewModeSchema = z.enum(['full', 'incremental']);
export const IsolateReviewFallbackReasonSchema = z.enum([
  'previous_run_unavailable',
  'previous_run_not_completed',
  'previous_run_incompatible',
  'previous_summary_unavailable',
  'settings_changed',
  'review_instructions_changed',
  'base_changed',
  'head_unchanged',
  'previous_head_not_ancestor',
  'comparison_unavailable',
  'comparison_incomplete',
]);

export const IsolateReviewSelectionSchema = z
  .discriminatedUnion('effectiveMode', [
    z
      .object({
        requestedMode: IsolateReviewModeSchema,
        effectiveMode: z.literal('full'),
        previousRunId: z.uuid().optional(),
        fallbackReason: IsolateReviewFallbackReasonSchema.optional(),
      })
      .strict(),
    z
      .object({
        requestedMode: z.literal('incremental'),
        effectiveMode: z.literal('incremental'),
        previousRunId: z.uuid(),
        previousHeadSha: ShaSchema,
        previousSummaryHash: HashSchema,
        changedFileCount: z.number().int().min(0).max(299),
      })
      .strict(),
  ])
  .superRefine((selection, ctx) => {
    if (
      selection.effectiveMode === 'full' &&
      selection.requestedMode === 'incremental' &&
      (!selection.previousRunId || !selection.fallbackReason)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Incremental fallback requires a previous run and a reason',
      });
    }
  });

export type IsolateReviewSelection = z.infer<typeof IsolateReviewSelectionSchema>;
export type IsolateReviewFallbackReason = z.infer<typeof IsolateReviewFallbackReasonSchema>;

export const IsolateReviewSummaryContentSchema = z
  .object({
    body: z
      .string()
      .min(1)
      .max(MAX_REVIEW_SUMMARY_BYTES)
      .refine(
        body => new TextEncoder().encode(body).byteLength <= MAX_REVIEW_SUMMARY_BYTES,
        'Summary exceeds the 64 KiB UTF-8 body budget'
      ),
    bodyHash: HashSchema,
  })
  .strict();

export type IsolateReviewSummaryContent = z.infer<typeof IsolateReviewSummaryContentSchema>;

export const IsolateReviewInferenceSchema = z
  .object({
    modelId: ModelSchema,
    provider: z.enum(['anthropic', 'openai', 'openrouter', 'openai-compatible']),
    thinkingEffort: ThinkingEffortSchema,
    variant: z
      .object({
        reasoning: z
          .object({
            enabled: z.boolean().optional(),
            effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
          })
          .strict()
          .optional(),
        verbosity: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      })
      .strict()
      .nullable(),
    reasoningSupported: z.boolean(),
    maxOutputTokens: z.number().int().positive().max(1_000_000),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
  })
  .strict();

export type IsolateReviewInference = z.infer<typeof IsolateReviewInferenceSchema>;

export const IsolateReviewPreparationSchema = z
  .object({
    version: z.literal(1),
    preparedAt: z.iso.datetime(),
    requestingUserId: IdentifierSchema,
    executionUserId: IdentifierSchema,
    organizationId: IdentifierSchema.optional(),
    reviewSelection: IsolateReviewSelectionSchema.optional(),
    settings: z
      .object({
        reviewStyle: z.enum(['balanced', 'strict', 'lenient', 'roast']),
        focusAreas: z
          .array(z.string().max(MAX_REVIEW_PROMPT_CHARACTERS))
          .max(MAX_REVIEW_PROMPT_CHARACTERS)
          .refine(
            areas =>
              areas.reduce((characters, area) => characters + area.length + 1, 0) <=
              MAX_REVIEW_PROMPT_CHARACTERS,
            'Focus areas exceed the prepared prompt budget'
          ),
        customInstructions: z.string().max(MAX_REVIEW_PROMPT_CHARACTERS).nullable(),
        manualInstructions: z.string().max(4_000).nullable(),
        model: ModelSchema,
        thinkingEffort: ThinkingEffortSchema,
        modelSource: z.enum(['explicit', 'repository', 'global']),
        disableReviewMd: z.boolean(),
        analyticsEnabled: z.boolean(),
      })
      .strict(),
    snapshot: z
      .object({ headSha: ShaSchema, baseTipSha: ShaSchema, mergeBaseSha: ShaSchema })
      .strict(),
    github: z
      .object({
        integrationId: IdentifierSchema,
        installationId: IdentifierSchema,
        appType: AppTypeSchema,
      })
      .strict(),
    reviewInstructions: z
      .object({
        path: z.literal('REVIEW.md'),
        sha: ShaSchema,
        hash: HashSchema,
        characterCount: z.number().int().nonnegative().max(10_000),
        truncated: z.boolean(),
      })
      .strict()
      .optional(),
    readContextSummary: z
      .object({ commentId: z.number().int().positive().safe(), bodyHash: HashSchema })
      .strict()
      .optional(),
    hashes: z
      .object({
        settings: HashSchema,
        context: HashSchema,
        canonicalPrompt: HashSchema,
        adaptedPrompt: HashSchema,
        system: HashSchema,
        workerSystem: HashSchema.optional(),
      })
      .strict(),
    versions: z
      .object({
        cli: z.literal('7.4.20'),
        policy: z.string().min(1).max(128),
        adapter: z.string().min(1).max(128),
        workerSystem: z.string().min(1).max(128).optional(),
      })
      .strict(),
    limitations: z.array(z.string().max(1_000)).max(100),
  })
  .strict();

export type IsolateReviewPreparation = z.infer<typeof IsolateReviewPreparationSchema>;

export const IsolateReviewRequestSchema = z
  .object({
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    pullNumber: z.number().int().positive().safe(),
    organizationId: z.string().max(256).optional(),
    headSha: ShaSchema.optional(),
    baseTipSha: ShaSchema.optional(),
    mergeBaseSha: ShaSchema.optional(),
    model: z.string().max(512).optional(),
    thinkingEffort: ThinkingEffortSchema.optional(),
    expectedIntegrationId: IdentifierSchema.optional(),
    expectedInstallationId: IdentifierSchema.optional(),
    expectedAppType: AppTypeSchema.optional(),
    previousRunId: IdentifierSchema.optional(),
    reviewMode: IsolateReviewModeSchema.optional(),
    inference: IsolateReviewInferenceSchema.optional(),
    preparation: IsolateReviewPreparationSchema.optional(),
    existingSummaryCommentId: z.number().int().positive().safe().optional(),
    dryRun: z.boolean().optional(),
    userPrompt: z.string().max(MAX_REVIEW_PROMPT_CHARACTERS).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.thinkingEffort !== undefined && !input.model?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['thinkingEffort'],
        message: 'thinkingEffort requires an explicit model',
      });
    }
    if (
      input.inference &&
      (input.inference.modelId !== input.model?.trim() ||
        input.inference.thinkingEffort !== (input.thinkingEffort ?? null))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['inference'],
        message: 'Inference must match the requested model and effort',
      });
    }
    const preparation = input.preparation;
    const selection = preparation?.reviewSelection;
    if (
      input.reviewMode === 'incremental' &&
      (!z.uuid().safeParse(input.previousRunId).success || !selection)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['reviewMode'],
        message: 'Incremental reviews require a previous run UUID and canonical preparation',
      });
    }
    if (
      selection &&
      (selection.requestedMode !== (input.reviewMode ?? 'full') ||
        selection.previousRunId !== input.previousRunId)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['preparation', 'reviewSelection'],
        message: 'Review selection must match the requested mode and previous run',
      });
    }
    if (!preparation) return;
    if (!input.userPrompt?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['preparation'],
        message: 'Prepared reviews require a complete prompt',
      });
    }
    if (
      preparation.organizationId !== input.organizationId ||
      preparation.settings.model !== input.model?.trim() ||
      preparation.settings.thinkingEffort !== (input.thinkingEffort ?? null) ||
      preparation.snapshot.headSha.toLowerCase() !== input.headSha?.toLowerCase() ||
      preparation.snapshot.baseTipSha.toLowerCase() !== input.baseTipSha?.toLowerCase() ||
      preparation.snapshot.mergeBaseSha.toLowerCase() !== input.mergeBaseSha?.toLowerCase() ||
      preparation.github.integrationId !== input.expectedIntegrationId ||
      preparation.github.installationId !== input.expectedInstallationId ||
      preparation.github.appType !== input.expectedAppType
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['preparation'],
        message: 'Preparation must match the review request',
      });
    }
  });

export type IsolateReviewRequest = z.infer<typeof IsolateReviewRequestSchema>;

const ReviewProposalSchema = z
  .object({
    fingerprint: HashSchema,
    bodyHash: HashSchema.optional(),
    publishable: z.boolean(),
    blockedReason: z.string().max(1_000).optional(),
  })
  .strict();

const AnalysisOutcomeSchema = z
  .object({
    status: z.enum(['pending', 'running', 'completed', 'incomplete']),
    stepCount: z.number().int().nonnegative(),
    parentFinishReason: z.string().max(100).optional(),
    parentFinished: z.boolean().optional(),
    contextIncompleteReasons: z.array(z.string().max(1_000)).max(100).optional(),
    incompleteTaskIds: z.array(IdentifierSchema).max(100).optional(),
  })
  .strict();

const OperationOutcomeSchema = z.enum([
  'not_requested',
  'proposed',
  'pending',
  'uncertain',
  'confirmed',
  'rejected',
]);
const PublicationOutcomeSchema = z
  .object({ review: OperationOutcomeSchema, summary: OperationOutcomeSchema })
  .strict();
const TerminationReasonSchema = z.enum([
  'completed',
  'cancelled',
  'credentials_expired',
  'admission_deadline',
  'execution_deadline',
  'absolute_deadline',
  'step_limit',
  'parent_incomplete',
  'missing_summary',
  'required_context_incomplete',
  'child_incomplete',
  'publication_incomplete',
  'admission_failed',
  'submission_error',
  'cleanup',
]);

export type IsolateReviewWorkerClientOptions = {
  baseUrl?: string;
  internalApiSecret?: string;
};

const StartReviewResponseSchema = z.object({
  runId: z.string(),
});

const ReviewStatusResponseSchema = z.object({
  runId: z.string(),
  owner: z.string().min(1).max(100).optional(),
  repo: z.string().min(1).max(100).optional(),
  pullNumber: z.number().int().positive().safe().optional(),
  organizationId: IdentifierSchema.optional(),
  userId: IdentifierSchema.optional(),
  baseTipSha: ShaSchema.optional(),
  mergeBaseSha: ShaSchema.optional(),
  installationId: IdentifierSchema.optional(),
  appType: AppTypeSchema.optional(),
  summaryBodyHash: HashSchema.optional(),
  summaryContent: IsolateReviewSummaryContentSchema.optional(),
  cleanupAt: z.number().int().positive().safe().optional(),
  reviewSelection: IsolateReviewSelectionSchema.optional(),
  reviewFingerprint: HashSchema.optional(),
  summaryFingerprint: HashSchema.optional(),
  provenance: z.enum(['raw', 'prepared']).optional(),
  preparation: IsolateReviewPreparationSchema.optional(),
  inference: IsolateReviewInferenceSchema.optional(),
  analysisOutcome: AnalysisOutcomeSchema.optional(),
  publicationOutcome: PublicationOutcomeSchema.optional(),
  terminationReason: TerminationReasonSchema.optional(),
  reviewProposal: ReviewProposalSchema.optional(),
  summaryProposal: ReviewProposalSchema.optional(),
  usageSessions: z.array(IdentifierSchema).max(100).optional(),
  taskSessions: z
    .array(
      z
        .object({
          taskId: IdentifierSchema,
          sessionId: IdentifierSchema,
          parentSessionId: IdentifierSchema.optional(),
          mode: z.enum(['code', 'general', 'explore']),
        })
        .strict()
    )
    .max(100)
    .optional(),
  systemPromptHash: HashSchema.optional(),
  systemPromptVersion: z.string().min(1).max(128).optional(),
  requestIds: z.array(IdentifierSchema).max(1_000).optional(),
  limitations: z.array(z.string().max(1_000)).max(100).optional(),
  status: z.enum(['pending', 'cloning', 'running', 'completed', 'error']),
  requestedModel: z.string(),
  dryRun: z.boolean(),
  createdAt: z.iso.datetime().optional(),
  startedAt: z.iso.datetime().optional(),
  cloneCompletedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  cloneAttempts: z.number().int().nonnegative().optional(),
  githubSizeKiB: z.number().nonnegative().optional(),
  tipFileCount: z.number().int().nonnegative().optional(),
  tipTotalBytes: z.number().nonnegative().optional(),
  vfsTotalBytes: z.number().nonnegative().optional(),
  cloneMs: z.number().nonnegative().optional(),
  headSha: z.string().optional(),
  finalText: z.string().optional(),
  error: z.string().optional(),
  githubReviewId: z.number().int().positive().optional(),
  summaryCommentId: z.number().int().positive().optional(),
  reviewReconciliationAttempts: z.number().int().nonnegative().max(2).optional(),
  summaryReconciliationAttempts: z.number().int().nonnegative().max(2).optional(),
  published: z.boolean().optional(),
  publishedAt: z.string().optional(),
});

const ReviewTranscriptResponseSchema = z.object({
  runId: z.string(),
  messages: z.array(z.unknown()),
  toolCalls: z.array(z.unknown()),
});

export type IsolateReviewStatus = z.infer<typeof ReviewStatusResponseSchema>;
export type IsolateReviewTranscript = z.infer<typeof ReviewTranscriptResponseSchema>;

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Isolate review request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export class IsolateReviewWorkerError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'IsolateReviewWorkerError';
  }
}

export class IsolateReviewWorkerClient {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly internalApiSecret: string;

  constructor(authToken: string, options: IsolateReviewWorkerClientOptions = {}) {
    const baseUrl = options.baseUrl ?? ISOLATE_REVIEW_WORKER_URL;
    const internalApiSecret = options.internalApiSecret ?? INTERNAL_API_SECRET;
    if (!baseUrl || !internalApiSecret) {
      throw new Error('ISOLATE_REVIEW_WORKER_URL or INTERNAL_API_SECRET is not configured');
    }
    if (!authToken.trim()) throw new Error('Isolate review auth token is required');

    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authToken = authToken;
    this.internalApiSecret = internalApiSecret;
  }

  private headers(contentType = false): HeadersInit {
    return {
      Authorization: `Bearer ${this.authToken}`,
      'x-internal-api-key': this.internalApiSecret,
      ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    return fetchWithTimeout(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        ...this.headers(options.body !== undefined),
        ...(options.headers ?? {}),
      },
    });
  }

  async startReview(input: IsolateReviewRequest): Promise<{ runId: string }> {
    const parsed = IsolateReviewRequestSchema.parse(input);
    const response = await this.request('/reviews', {
      method: 'POST',
      body: JSON.stringify(parsed),
    });

    if (!response.ok) {
      throw new Error(`Isolate review start failed: ${response.status} ${await response.text()}`);
    }

    return StartReviewResponseSchema.parse(await response.json());
  }

  async getReview(runId: string): Promise<IsolateReviewStatus | null> {
    const response = await this.request(`/reviews/${encodeURIComponent(runId)}`);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new IsolateReviewWorkerError(
        response.status,
        `Isolate review status failed: ${response.status} ${await response.text()}`
      );
    }
    return ReviewStatusResponseSchema.parse(await response.json());
  }

  async getTranscript(runId: string): Promise<IsolateReviewTranscript | null> {
    const response = await this.request(`/reviews/${encodeURIComponent(runId)}/messages`);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Isolate review transcript failed: ${response.status} ${await response.text()}`
      );
    }
    return ReviewTranscriptResponseSchema.parse(await response.json());
  }
}

export function createIsolateReviewWorkerClient(
  authToken: string,
  options?: IsolateReviewWorkerClientOptions
) {
  return new IsolateReviewWorkerClient(authToken, options);
}

export function createIsolateReviewWorkerClientForUser(
  user: User,
  options?: IsolateReviewWorkerClientOptions
) {
  return createIsolateReviewWorkerClient(
    generateApiToken(
      user,
      { tokenSource: 'isolate-review', botId: 'reviewer' },
      { expiresIn: TOKEN_EXPIRY.oneHour }
    ),
    options
  );
}
