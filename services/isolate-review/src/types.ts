import type { ReviewIsolate } from './review-isolate';
import type { TaskSession } from './task';
import type { QueuedReviewState } from './queued-review';
import { z } from 'zod';
import { CodeReviewProviderFailureReasonSchema } from '@kilocode/worker-utils/code-review-provider-failure';

export type SecretBinding = string | { get(): Promise<string> };

export type GetTokenForRepoResult =
  | {
      success: true;
      token: string;
      installationId: string;
      accountLogin: string;
      appType: 'standard' | 'lite';
    }
  | {
      success: false;
      reason:
        | 'database_not_configured'
        | 'invalid_repo_format'
        | 'no_installation_found'
        | 'repository_not_installed'
        | 'invalid_org_id'
        | 'integration_mismatch'
        | 'ambiguous_installation';
    };

export type GitTokenService = {
  getTokenForRepo(params: {
    githubRepo: string;
    userId: string;
    orgId?: string;
    expectedIntegrationId?: string;
  }): Promise<GetTokenForRepoResult>;
};

export type Env = {
  REVIEW_ISOLATE: DurableObjectNamespace<ReviewIsolate>;
  HYPERDRIVE: Hyperdrive;
  NEXTAUTH_SECRET: SecretBinding;
  INTERNAL_API_SECRET: SecretBinding;
  ENVIRONMENT: string;
  KILOCODE_BACKEND_BASE_URL?: string;
  GIT_TOKEN_SERVICE?: GitTokenService;
  /** OpenRouter-compatible gateway. Defaults to production `api.kilo.ai`. */
  KILO_GATEWAY_URL?: string;
  /** GitHub REST origin. Blank or omitted defaults to `https://api.github.com`. */
  GITHUB_API_URL?: string;
  /** Clone URL template. Substitutes `{owner}` and `{repo}`. Blank or omitted uses GitHub HTTPS. */
  GIT_CLONE_URL_TEMPLATE?: string;
};

export const GithubPublicationTargetSchema = z
  .object({
    host: z.literal('github.com'),
    repoFullName: z
      .string()
      .max(201)
      .regex(/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/),
    prNumber: z.number().int().positive().max(2_147_483_647),
  })
  .strict();

export const QueuedIsolateIdentitySchema = z
  .object({
    reviewId: z.uuid(),
    attemptId: z.uuid(),
    generation: z.uuid(),
    organizationId: z.uuid(),
    integrationId: z.uuid(),
    executionUserId: z.string().min(1).max(256),
    target: GithubPublicationTargetSchema,
    snapshot: z
      .object({
        headSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        baseTipSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        mergeBaseSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      })
      .strict(),
  })
  .strict();
export type QueuedIsolateIdentity = z.infer<typeof QueuedIsolateIdentitySchema>;

export function queuedIdentityKey(identity: QueuedIsolateIdentity): string {
  return JSON.stringify(QueuedIsolateIdentitySchema.parse(identity));
}

export const QueuedIsolateSafetySchema = z
  .object({
    sequence: z.number().int().positive().safe(),
    execution: z.enum(['not_started', 'running', 'completed', 'failed', 'cancelled']),
    cancellationRequested: z.boolean(),
    publication: z.enum(['not_started', 'pending', 'uncertain', 'settled']),
    quiescent: z.boolean(),
    observedAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    state =>
      !state.quiescent ||
      ((state.execution === 'completed' ||
        state.execution === 'failed' ||
        state.execution === 'cancelled') &&
        (state.publication === 'not_started' || state.publication === 'settled')),
    'Quiescence requires terminal execution and no unresolved publication'
  );
export type QueuedIsolateSafety = z.infer<typeof QueuedIsolateSafetySchema>;

export const QueuedIsolateAdmissionSchema = z
  .object({
    version: z.literal(1),
    runId: z.uuid(),
    identity: QueuedIsolateIdentitySchema,
    preparationHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .refine(request => request.runId === request.identity.attemptId, 'Run must match attempt');

export const QueuedIsolateAuthorityRequestSchema = z
  .object({
    version: z.literal(1),
    identity: QueuedIsolateIdentitySchema,
    operation: z.enum(['execute', 'publish', 'reconcile']),
    operationId: z.uuid(),
    preparationHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const QueuedIsolateAuthorityResponseSchema = QueuedIsolateAuthorityRequestSchema.extend({
  authorized: z.boolean(),
  reconciliationUserId: z.string().min(1).max(256).optional(),
}).refine(
  response =>
    (response.authorized && response.operation === 'reconcile') ===
    Boolean(response.reconciliationUserId)
);

export const QueuedIsolateControlRequestSchema = z
  .object({
    version: z.literal(1),
    identity: QueuedIsolateIdentitySchema,
    operation: z.enum(['status', 'cancel']),
  })
  .strict();

export const QueuedIsolateResultSchema = z
  .object({
    reason: z.enum([
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
      ...CodeReviewProviderFailureReasonSchema.options,
      'cleanup',
    ]),
    completedAt: z.iso.datetime(),
    sessions: z
      .array(
        z
          .object({
            sessionId: z.uuid(),
            parentSessionId: z.uuid().nullable(),
            requestCount: z.number().int().nonnegative().max(1_000).optional(),
          })
          .strict()
      )
      .min(1)
      .max(100),
    summary: z
      .object({
        commentId: z.number().int().positive().safe(),
        bodyHash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .nullable(),
    gateResult: z.enum(['pass', 'fail']).nullable(),
    analytics: z
      .object({
        marker: z
          .string()
          .max(17_000)
          .refine(value => new TextEncoder().encode(value).byteLength <= 17_000)
          .nullable(),
        omitted: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const QueuedIsolateNotificationSchema = z
  .object({
    version: z.literal(1),
    identity: QueuedIsolateIdentitySchema,
    safety: QueuedIsolateSafetySchema,
    result: QueuedIsolateResultSchema.optional(),
  })
  .strict()
  .superRefine((notification, ctx) => {
    const terminal = ['completed', 'failed', 'cancelled'].includes(notification.safety.execution);
    if (terminal !== Boolean(notification.result))
      ctx.addIssue({ code: 'custom', message: 'Terminal notifications require a result' });
    if (notification.result) {
      const { sessions, reason } = notification.result;
      const root = notification.identity.attemptId;
      const seen = new Set<string>();
      for (const session of sessions) {
        if (
          seen.has(session.sessionId) ||
          (session.sessionId === root
            ? session.parentSessionId !== null
            : !session.parentSessionId || !seen.has(session.parentSessionId))
        )
          ctx.addIssue({ code: 'custom', message: 'Invalid execution session tree' });
        seen.add(session.sessionId);
      }
      if (
        sessions[0]?.sessionId !== root ||
        (notification.safety.execution === 'completed') !== (reason === 'completed') ||
        (notification.safety.execution === 'cancelled') !== (reason === 'cancelled')
      )
        ctx.addIssue({ code: 'custom', message: 'Result does not match execution' });
    }
  });

export const QueuedIsolateAcknowledgementSchema = z
  .object({
    version: z.literal(1),
    identity: QueuedIsolateIdentitySchema,
    sequence: z.number().int().positive().safe(),
    notificationRecorded: z.literal(true),
    fenceReleased: z.boolean(),
    usageSettled: z.boolean().default(false),
  })
  .strict();

export const MAX_REVIEW_PROMPT_CHARACTERS = 64_000;

const IdentifierSchema = z.string().min(1).max(256);
const ShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, 'Must be a full git commit SHA');
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const ModelSchema = z.string().min(1).max(512);
const ThinkingEffortSchema = z.string().min(1).max(50).nullable();
const AppTypeSchema = z.enum(['standard', 'lite']);

export const MAX_REVIEW_SUMMARY_BYTES = 64 * 1024;
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
export type SummaryContent = z.infer<typeof IsolateReviewSummaryContentSchema>;

export type GithubHistoryState = { requestCount: number; commitShas: string[] };

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

export const QueuedIsolatePublicationSchema = z
  .object({
    identity: QueuedIsolateIdentitySchema,
    gateThreshold: z.enum(['off', 'all', 'warning', 'critical']),
    summaryTarget: z
      .object({
        commentId: z.number().int().positive().safe(),
        bodyHash: HashSchema,
        authorId: z.number().int().positive().safe(),
        authorLogin: z.string().min(1).max(100),
        appId: z.number().int().positive().safe(),
      })
      .strict()
      .optional(),
    summaryHistory: z.string().max(24_000),
  })
  .strict();

export const IsolateReviewPreparationSchema = z
  .object({
    version: z.literal(1),
    preparedAt: z.iso.datetime(),
    queued: QueuedIsolatePublicationSchema.optional(),
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

export const StartReviewRequestSchema = z
  .object({
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    pullNumber: z.number().int().positive().safe(),
    /** Offline-fixture credential. Production requests must not provide this. */
    gitToken: z.string().max(8_192).optional(),
    /** Kilo organization for token lookup and gateway usage. Optional. */
    organizationId: z.string().max(256).optional(),
    headSha: ShaSchema.optional(),
    baseTipSha: ShaSchema.optional(),
    mergeBaseSha: ShaSchema.optional(),
    /** OpenRouter-style slug, e.g. "anthropic/claude-sonnet-4.6". */
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
    /** Defaults to true. Publishing tools return their payload instead of sending. */
    dryRun: z.boolean().optional(),
    /** Optional override for the review user message. Blank is treated as absent. */
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

export type StartReviewRequest = z.infer<typeof StartReviewRequestSchema>;

export function preparationMatchesIdentity(input: StartReviewRequest, userId: string): boolean {
  return (
    !input.preparation ||
    (input.preparation.executionUserId === userId &&
      (input.organizationId !== undefined || input.preparation.requestingUserId === userId))
  );
}

export type StartReviewInput = StartReviewRequest & {
  /** Kilo user whose GitHub installation access is used for this repository. */
  userId?: string;
  /** Kilo JWT for the gateway. Injected from the authenticated bearer. Never logged. */
  kiloToken: string;
  credentialsExpireAt?: number;
};

export function isDryRun(dryRun: boolean | undefined): boolean {
  return dryRun !== false;
}

export function scrubReviewSecrets(input: StartReviewInput): StartReviewInput {
  return { ...input, gitToken: '', kiloToken: '' };
}

export function hasReviewSecrets(input: StartReviewInput): boolean {
  return Boolean(input.gitToken || input.kiloToken);
}

export type RunStatus = 'pending' | 'cloning' | 'running' | 'completed' | 'error';

export const ReviewProposalSchema = z
  .object({
    fingerprint: HashSchema,
    bodyHash: HashSchema.optional(),
    publishable: z.boolean(),
    blockedReason: z.string().max(1_000).optional(),
  })
  .strict();

export type ReviewProposal = z.infer<typeof ReviewProposalSchema>;

export const AnalysisOutcomeSchema = z
  .object({
    status: z.enum(['pending', 'running', 'completed', 'incomplete']),
    stepCount: z.number().int().nonnegative(),
    parentFinishReason: z.string().max(100).optional(),
    parentFinished: z.boolean().optional(),
    contextIncompleteReasons: z.array(z.string().max(1_000)).max(100).optional(),
    incompleteTaskIds: z.array(IdentifierSchema).max(100).optional(),
  })
  .strict();

export type AnalysisOutcome = z.infer<typeof AnalysisOutcomeSchema>;

const OperationOutcomeSchema = z.enum([
  'not_requested',
  'proposed',
  'pending',
  'uncertain',
  'confirmed',
  'rejected',
]);
export const PublicationOutcomeSchema = z
  .object({
    review: OperationOutcomeSchema,
    summary: OperationOutcomeSchema,
  })
  .strict();

export type PublicationOutcome = z.infer<typeof PublicationOutcomeSchema>;

export const TerminationReasonSchema = z.enum([
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
  ...CodeReviewProviderFailureReasonSchema.options,
  'cleanup',
]);
export type TerminationReason = z.infer<typeof TerminationReasonSchema>;

export type SummaryOwnership = { previousRunId: string; commentId: number; bodyHash: string };

export type RunState = {
  runId: string;
  queued?: QueuedReviewState;
  queuedPublication?: IsolateReviewPreparation['queued'];
  status: RunStatus;
  input: StartReviewInput;
  createdAt?: string;
  startedAt?: string;
  cloneCompletedAt?: string;
  completedAt?: string;
  credentialsExpireAt?: number;
  cleanupAt?: number;
  executionDeadlineAt?: number;
  admissionDeadlineAt?: number;
  absoluteDeadlineAt?: number;
  provenance?: 'raw' | 'prepared';
  inferenceResolved?: boolean;
  analysisOutcome?: AnalysisOutcome;
  publicationOutcome?: PublicationOutcome;
  terminationReason?: TerminationReason;
  reviewProposal?: ReviewProposal;
  summaryProposal?: ReviewProposal;
  summaryContent?: SummaryContent;
  gateResult?: 'pass' | 'fail';
  reviewSelection?: IsolateReviewSelection;
  historyState?: GithubHistoryState;
  summaryOwnership?: SummaryOwnership;
  installationId?: string;
  appType?: 'standard' | 'lite';
  baseTipSha?: string;
  mergeBaseSha?: string;
  usageSessions?: string[];
  taskSessions?: TaskSession[];
  systemPromptHash?: string;
  systemPromptVersion?: string;
  requestIds?: string[];
  usageRequestCounts?: Record<string, number>;
  limitations?: string[];
  /** Repository-scoped GitHub token minted by GIT_TOKEN_SERVICE. Never logged. */
  githubToken?: string;
  headSha?: string;
  submissionId?: string;
  error?: string;
  githubSizeKiB?: number;
  /** Working tree only — excludes `.git`. */
  tipFileCount?: number;
  tipTotalBytes?: number;
  /** Whole VFS including the fully-populated `.git`. */
  vfsTotalBytes?: number;
  cloneMs?: number;
  cloneAttempts?: number;
  reviewId?: number;
  reviewPending?: boolean;
  reviewPendingFingerprint?: string;
  reviewPublicationAttempts?: number;
  summaryPublicationAttempts?: number;
  reviewReconciliationAttempts?: number;
  summaryReconciliationAttempts?: number;
  reviewFingerprint?: string;
  summaryCommentId?: number;
  summaryPending?: boolean;
  summaryPendingFingerprint?: string;
  summaryPendingCommentId?: number;
  summaryPendingBodyHash?: string;
  summaryFingerprint?: string;
  summaryBodyHash?: string;
  summaryPublished?: boolean;
  published?: boolean;
  publishedAt?: string;
};

export type ReviewStatusResponse = {
  runId: string;
  owner?: string;
  repo?: string;
  pullNumber?: number;
  organizationId?: string;
  userId?: string;
  baseTipSha?: string;
  mergeBaseSha?: string;
  installationId?: string;
  appType?: 'standard' | 'lite';
  summaryBodyHash?: string;
  reviewFingerprint?: string;
  summaryFingerprint?: string;
  provenance?: 'raw' | 'prepared';
  preparation?: IsolateReviewPreparation;
  inference?: IsolateReviewInference;
  analysisOutcome?: AnalysisOutcome;
  publicationOutcome?: PublicationOutcome;
  terminationReason?: TerminationReason;
  reviewProposal?: ReviewProposal;
  summaryProposal?: ReviewProposal;
  summaryContent?: SummaryContent;
  gateResult?: 'pass' | 'fail';
  reviewSelection?: IsolateReviewSelection;
  cleanupAt?: number;
  usageSessions?: string[];
  taskSessions?: TaskSession[];
  systemPromptHash?: string;
  systemPromptVersion?: string;
  requestIds?: string[];
  limitations?: string[];
  status: RunStatus;
  requestedModel: string;
  dryRun: boolean;
  createdAt?: string;
  startedAt?: string;
  cloneCompletedAt?: string;
  completedAt?: string;
  cloneAttempts?: number;
  githubSizeKiB?: number;
  tipFileCount?: number;
  tipTotalBytes?: number;
  vfsTotalBytes?: number;
  cloneMs?: number;
  headSha?: string;
  finalText?: string;
  error?: string;
  githubReviewId?: number;
  summaryCommentId?: number;
  reviewReconciliationAttempts?: number;
  summaryReconciliationAttempts?: number;
  published?: boolean;
  publishedAt?: string;
};

export type {
  ReviewTranscriptMessage,
  ReviewTranscriptResponse,
  ReviewTranscriptToolCall,
} from './transcript';
