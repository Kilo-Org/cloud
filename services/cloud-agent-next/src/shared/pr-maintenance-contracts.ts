import * as z from 'zod';

export const watchPrMaintenanceReplyMarker = '<!-- kilo-pr-maintenance -->';

export const watchPrMaintenanceDefaults = {
  maxAttemptsPerProblem: 2,
  maxTotalAttempts: 10,
  batchDelaySeconds: 30,
  maxBatchWaitSeconds: 120,
  quietPeriodSeconds: 180,
  busyRetrySeconds: 30,
  conflictCheckIntervalSeconds: 900,
  conflictQueryBatchSize: 25,
  maxLogJobs: 3,
  maxLogCharactersPerJob: 12_000,
  maxProblemsPerBatch: 50,
  maxPriorDispositions: 50,
  maxPriorResults: 10,
  maxDeliveryAttempts: 5,
  maxInputCharacters: 262_144,
  maxResultCharacters: 131_072,
} as const;

export const watchPrDefaultTrustedBotLogins = [
  'kiloconnect[bot]',
  'kiloconnect-development[bot]',
  'kiloconnect-lite[bot]',
] as const;

const modelSchema = z.string().trim().min(1).max(200);
const problemKeySchema = z.string().min(1).max(200);
const fingerprintSchema = z.string().min(1).max(128);
const shaSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const githubRepositoryUrlSchema = z
  .string()
  .max(500)
  .regex(/^https:\/\/github\.com\/[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/)
  .refine(value => !value.endsWith('.git'), 'Expected a repository URL without the .git suffix')
  .refine(value => value === value.toLowerCase(), 'Expected a canonical GitHub repository URL');
const evidenceUrlSchema = z.string().url().max(2_000);
const refSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    value =>
      value !== '@' &&
      !value.startsWith('-') &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.endsWith('.') &&
      !value.includes('..') &&
      !value.includes('@{') &&
      !value.includes('//') &&
      !/[~^:?*[\]\\]/.test(value) &&
      !Array.from(value).some(character => {
        const code = character.charCodeAt(0);
        return code <= 32 || code === 127;
      }) &&
      !value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')),
    'Expected a Git branch name'
  );

export const watchPrPolicyV1Schema = z
  .object({
    version: z.literal(1),
    model: modelSchema,
    profileId: z.string().uuid().nullable(),
    categories: z.object({
      reviews: z.boolean(),
      failedChecks: z.boolean(),
      baseUpdates: z.boolean(),
    }),
    branchStrategy: z.enum(['merge', 'rebase']),
    historyRewriteConsent: z.boolean(),
    maxAttemptsPerProblem: z.number().int().min(1).max(2),
    maxTotalAttempts: z.number().int().min(1).max(10),
    observationOnlyConsent: z.literal(true),
    futureEventsOnlyConsent: z.literal(true),
    noHardSpendCapConsent: z.literal(true),
  })
  .strict()
  .refine(value => value.branchStrategy !== 'rebase' || value.historyRewriteConsent, {
    message: 'Rebase requires explicit history-rewrite consent',
    path: ['historyRewriteConsent'],
  })
  .refine(value => value.maxAttemptsPerProblem <= value.maxTotalAttempts, {
    message: 'Per-problem attempts cannot exceed total attempts',
    path: ['maxAttemptsPerProblem'],
  });

export const watchPrMaintenancePolicySchema = z
  .object({
    version: z.literal(2),
    automaticWritesConsent: z.literal(true),
    historyRewriteConsent: z.literal(true),
    noHardSpendCapConsent: z.literal(true),
    model: modelSchema,
    variant: z.string().trim().min(1).max(100).nullable().default(null),
    profileId: z.string().uuid().nullable(),
    environmentId: z.string().uuid().nullable(),
    trustedBotLogins: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9][a-z0-9-]{0,38}(?:\[bot\])?$/)
      )
      .max(25)
      .default(() => [...watchPrDefaultTrustedBotLogins]),
    categories: z
      .object({ reviews: z.boolean(), failedChecks: z.boolean(), conflicts: z.boolean() })
      .strict()
      .refine(value => value.reviews || value.failedChecks || value.conflicts, {
        message: 'Enable at least one repair category',
      }),
    branchStrategy: z.literal('rebase').default('rebase'),
    maxAttemptsPerProblem: z.number().int().min(1).max(2).default(2),
    maxTotalAttempts: z.number().int().min(1).max(10).default(10),
    batchDelaySeconds: z.number().int().min(5).max(120).default(30),
    maxBatchWaitSeconds: z.number().int().min(10).max(300).default(120),
    quietPeriodSeconds: z.number().int().min(1).max(600).default(180),
  })
  .strict()
  .refine(value => value.maxAttemptsPerProblem <= value.maxTotalAttempts, {
    message: 'Per-problem attempts cannot exceed total attempts',
    path: ['maxAttemptsPerProblem'],
  })
  .refine(value => value.batchDelaySeconds <= value.maxBatchWaitSeconds, {
    message: 'Batch delay cannot exceed the maximum batch wait',
    path: ['batchDelaySeconds'],
  });

export const watchPrPolicySchema = z.discriminatedUnion('version', [
  watchPrPolicyV1Schema,
  watchPrMaintenancePolicySchema,
]);
export type WatchPrPolicyV1 = z.infer<typeof watchPrPolicyV1Schema>;
export type WatchPrMaintenancePolicy = z.infer<typeof watchPrMaintenancePolicySchema>;
export type WatchPrPolicy = z.infer<typeof watchPrPolicySchema>;

export function hasWatchPrAutomaticWriteConsent(
  policy: WatchPrPolicy
): policy is WatchPrMaintenancePolicy {
  return policy.version === 2 && policy.automaticWritesConsent;
}

export const watchPrStatusSchema = z.enum(['watching', 'paused', 'finished']);
export const watchPrExecutionStatusSchema = z.enum([
  'watching',
  'waiting_for_session',
  'fixing',
  'waiting_for_checks',
  'needs_input',
]);
export const watchPrAttemptStatusSchema = z.enum([
  'creating',
  'running',
  'needs_input',
  'completed',
  'failed',
  'stopped',
]);
export const cloudAgentChatKindSchema = z.enum(['user', 'maintenance']);
export const watchPrLiveAttemptStatuses = ['creating', 'running', 'needs_input'] as const;

export type WatchPrStatus = z.infer<typeof watchPrStatusSchema>;
export type WatchPrExecutionStatus = z.infer<typeof watchPrExecutionStatusSchema>;
export type WatchPrAttemptStatus = z.infer<typeof watchPrAttemptStatusSchema>;
export type CloudAgentChatKind = z.infer<typeof cloudAgentChatKindSchema>;

export function isLiveWatchPrAttempt(status: WatchPrAttemptStatus): boolean {
  return status === 'creating' || status === 'running' || status === 'needs_input';
}

export const watchPrFeedbackDispositionSchema = z.enum([
  'addressed',
  'already_addressed',
  'disagreed',
  'deferred',
  'needs_input',
  'not_actionable',
]);
export type WatchPrFeedbackDisposition = z.infer<typeof watchPrFeedbackDispositionSchema>;

export const watchPrEvidenceSchema = z
  .object({
    kind: z.enum(['code', 'verification', 'publication', 'discussion']),
    summary: z.string().min(1).max(2_000),
    url: evidenceUrlSchema.nullable(),
    commitSha: shaSchema.nullable(),
  })
  .strict();
export type WatchPrEvidence = z.infer<typeof watchPrEvidenceSchema>;

export const watchPrProblemSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('review'),
        problemKey: problemKeySchema,
        contentFingerprint: fingerprintSchema,
        source: z.enum(['review_comment', 'review', 'conversation_comment']),
        sourceId: z.string().min(1).max(200),
        threadId: z.string().min(1).max(200).nullable(),
        authorLogin: z.string().min(1).max(100),
        body: z.string().min(1).max(12_000),
        url: evidenceUrlSchema.nullable(),
        commitSha: shaSchema.nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('failed_check'),
        problemKey: problemKeySchema,
        contentFingerprint: fingerprintSchema,
        headSha: shaSchema,
        checkId: z.string().min(1).max(200),
        name: z.string().min(1).max(500),
        detailsUrl: evidenceUrlSchema.nullable(),
        log: z.string().max(watchPrMaintenanceDefaults.maxLogCharactersPerJob).nullable(),
        logUnavailableReason: z.string().max(2_000).nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('conflict'),
        problemKey: problemKeySchema,
        contentFingerprint: fingerprintSchema,
        headSha: shaSchema,
        baseSha: shaSchema,
      })
      .strict(),
  ])
  .readonly();
export type WatchPrProblem = z.infer<typeof watchPrProblemSchema>;

export const watchPrVerificationSchema = z
  .object({
    command: z.string().min(1).max(1_000),
    outcome: z.enum(['passed', 'failed', 'not_run']),
    summary: z.string().max(2_000),
    evidenceUrls: z.array(evidenceUrlSchema).max(10),
  })
  .strict();
export type WatchPrVerification = z.infer<typeof watchPrVerificationSchema>;

export const watchPrOwnedRebaseEvidenceSchema = z
  .object({
    source: z.literal('git'),
    attemptId: z.string().uuid(),
    baseSha: shaSchema,
    previousHeadSha: shaSchema,
    rebasedHeadSha: shaSchema,
    completedAt: z.string().datetime(),
  })
  .strict();
export type WatchPrOwnedRebaseEvidence = z.infer<typeof watchPrOwnedRebaseEvidenceSchema>;

export const watchPrPublicationEvidenceSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_attempted'), reason: z.string().max(2_000) }).strict(),
  z.object({ status: z.literal('unknown'), reason: z.string().min(1).max(2_000) }).strict(),
  z.object({ status: z.literal('failed'), reason: z.string().min(1).max(2_000) }).strict(),
  z
    .object({
      status: z.literal('published'),
      source: z.literal('git'),
      repoUrl: githubRepositoryUrlSchema,
      headRef: refSchema,
      observedHeadSha: shaSchema,
      pushedHeadSha: shaSchema,
      remoteHeadSha: shaSchema,
      baseSha: shaSchema,
      exactLease: z.string().min(1).max(400),
      pushExitCode: z.literal(0),
      verifiedAt: z.string().datetime(),
      ownedRebase: watchPrOwnedRebaseEvidenceSchema.optional(),
    })
    .strict()
    .refine(value => value.exactLease === `refs/heads/${value.headRef}:${value.observedHeadSha}`, {
      message: 'Publication requires the exact observed branch lease',
      path: ['exactLease'],
    })
    .refine(value => value.pushedHeadSha === value.remoteHeadSha, {
      message: 'The verified remote head must match the published commit',
      path: ['remoteHeadSha'],
    })
    .refine(
      value =>
        value.ownedRebase === undefined ||
        (value.ownedRebase.baseSha === value.baseSha &&
          Date.parse(value.ownedRebase.completedAt) <= Date.parse(value.verifiedAt)),
      {
        message: 'Owned rebase evidence must describe the published base before publication',
        path: ['ownedRebase'],
      }
    ),
]);
export type WatchPrPublicationEvidence = z.infer<typeof watchPrPublicationEvidenceSchema>;

export const watchPrProblemResultSchema = z
  .object({
    problemKey: problemKeySchema,
    contentFingerprint: fingerprintSchema,
    disposition: watchPrFeedbackDispositionSchema,
    reason: z.string().min(1).max(2_000),
    evidence: z.array(watchPrEvidenceSchema).max(10),
    threadId: z.string().min(1).max(200).nullable(),
    reply: z.string().min(1).max(4_000).nullable(),
    resolve: z.boolean(),
  })
  .strict()
  .refine(
    value =>
      !value.resolve ||
      (value.threadId !== null &&
        (value.disposition === 'addressed' || value.disposition === 'already_addressed')),
    { message: 'Only verified addressed review threads can be resolved', path: ['resolve'] }
  );
export type WatchPrProblemResult = z.infer<typeof watchPrProblemResultSchema>;

export const watchPrMaintenanceResultSchema = z
  .object({
    version: z.literal(1),
    summary: z.string().min(1).max(8_000),
    changedFiles: z.array(z.string().min(1).max(1_000)).max(200),
    verification: z.array(watchPrVerificationSchema).max(20),
    publication: watchPrPublicationEvidenceSchema,
    problems: z
      .array(watchPrProblemResultSchema)
      .max(watchPrMaintenanceDefaults.maxProblemsPerBatch),
    needsInput: z.string().min(1).max(4_000).nullable(),
  })
  .strict()
  .refine(value => JSON.stringify(value).length <= watchPrMaintenanceDefaults.maxResultCharacters, {
    message: 'Maintenance result exceeds its retained size limit',
  })
  .readonly();
export type WatchPrMaintenanceResult = z.infer<typeof watchPrMaintenanceResultSchema>;

export const watchPrMaintenanceInputSchema = z
  .object({
    version: z.literal(1),
    purpose: z.string().min(1).max(8_000),
    constraints: z.array(z.string().min(1).max(2_000)).max(20),
    repository: z
      .object({
        repositoryId: z.string().min(1).max(100),
        repoUrl: githubRepositoryUrlSchema,
        prNumber: z.number().int().positive(),
        headRef: refSchema,
        baseRef: refSchema,
        headSha: shaSchema,
        baseSha: shaSchema,
        parentCommitSha: shaSchema.nullable(),
      })
      .strict(),
    policy: watchPrMaintenancePolicySchema,
    ordinal: z.number().int().min(1).max(10),
    problems: z
      .array(watchPrProblemSchema)
      .min(1)
      .max(watchPrMaintenanceDefaults.maxProblemsPerBatch)
      .readonly(),
    problemAttempts: z
      .array(
        z
          .object({ problemKey: problemKeySchema, attempts: z.number().int().min(0).max(10) })
          .strict()
      )
      .max(watchPrMaintenanceDefaults.maxProblemsPerBatch)
      .readonly(),
    priorDispositions: z
      .array(watchPrProblemResultSchema)
      .max(watchPrMaintenanceDefaults.maxPriorDispositions)
      .readonly(),
    previousResults: z
      .array(
        z
          .object({
            attemptId: z.string().uuid(),
            summary: z.string().min(1).max(4_000),
            verification: z.array(watchPrVerificationSchema).max(20),
            publication: watchPrPublicationEvidenceSchema,
          })
          .strict()
      )
      .max(watchPrMaintenanceDefaults.maxPriorResults)
      .readonly(),
    verificationCommands: z.array(z.string().min(1).max(1_000)).max(20),
    references: z.array(evidenceUrlSchema).max(20),
  })
  .strict()
  .refine(
    value =>
      new Set(value.problems.map(problem => problem.problemKey)).size === value.problems.length,
    { message: 'A batch cannot contain duplicate problems', path: ['problems'] }
  )
  .refine(
    value =>
      value.problems.filter(problem => problem.kind === 'failed_check' && problem.log !== null)
        .length <= watchPrMaintenanceDefaults.maxLogJobs,
    { message: 'A batch exceeds its failing-job log limit', path: ['problems'] }
  )
  .refine(value => JSON.stringify(value).length <= watchPrMaintenanceDefaults.maxInputCharacters, {
    message: 'Maintenance input exceeds its retained size limit',
  })
  .readonly();
export type WatchPrMaintenanceInput = z.infer<typeof watchPrMaintenanceInputSchema>;
