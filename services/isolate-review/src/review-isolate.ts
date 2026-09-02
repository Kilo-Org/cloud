import { createHash } from 'node:crypto';
import {
  Workspace,
  type DurableObjectStorageLike,
  type ThinkWorkspaceCompatibility,
} from '@cloudflare/computer';
import { createGitClient } from '@cloudflare/computer/git';
import {
  Think,
  type StepContext,
  type ThinkSubmissionInspection,
  type TurnConfig,
  type TurnContext,
} from '@cloudflare/think';
import { withDORetry } from '@kilocode/worker-utils';
import { APICallError, tool, type Tool, type ToolSet, type UIMessage } from 'ai';
import { classifyCodeReviewProviderFailure } from '@kilocode/worker-utils/code-review-provider-failure';
import { z } from 'zod';
import {
  createGithubClient,
  createGithubTools,
  GITHUB_TOOL_NAMES,
  MAX_GITHUB_RESPONSE_BYTES,
  MAX_HISTORY_COMMITS,
  MAX_HISTORY_REQUESTS,
  MAX_PUBLICATION_ATTEMPTS,
  resolveIncrementalComparison,
  type GithubClient,
  type GithubProposalEvent,
  type GithubPublicationDetails,
} from './github';
import {
  admitRepository,
  cloneRepository,
  RepoTooLargeError,
  resolveReviewSnapshot,
  validateRepositoryName,
} from './git';
import { allowsDirectGithubToken, resolveGithubCredentials } from './github-token';
import {
  createKiloGatewayModel,
  resolveIsolateReviewInference,
  validateIsolateReviewInference,
} from './model';
import { REPO_ROOT } from './paths';
import { createReviewPersistence, type ReviewPersistence } from './persistence';
import {
  assertQueuedIdentity,
  notifyQueuedReview,
  queuedCallback,
  QueuedReviewConflictError,
  QueuedReviewRequestSchema,
  requestQueuedAuthority,
  requestQueuedReconciliation,
  readQueuedJson,
  readQueuedProviderFailure,
  updateQueuedSafety,
  type QueuedReviewRequest,
  type QueuedReviewState,
} from './queued-review';
import {
  buildSystemPrompt,
  buildTaskReviewContext,
  DEFAULT_MODEL,
  resolveReviewUserMessage,
  SYSTEM_PROMPT_VERSION,
} from './prompt';
import { ISOLATE_REVIEW_SKILLS } from './prompt/skills';
import { projectReviewTranscript } from './transcript';
import { createTaskTool, type TaskOutcome, type TaskSession } from './task';
import { createReviewGrepTool, createReviewReadTool, createSafeReviewWorkspace } from './workspace';
import {
  hasReviewSecrets,
  isDryRun,
  IsolateReviewPreparationSchema,
  IsolateReviewSelectionSchema,
  IsolateReviewSummaryContentSchema,
  preparationMatchesIdentity,
  QueuedIsolateControlRequestSchema,
  QueuedIsolateIdentitySchema,
  queuedIdentityKey,
  type QueuedIsolateIdentity,
  ReviewProposalSchema,
  scrubReviewSecrets,
  StartReviewRequestSchema,
  type Env,
  type IsolateReviewSelection,
  type PublicationOutcome,
  type ReviewStatusResponse,
  type ReviewTranscriptResponse,
  type RunState,
  type StartReviewInput,
  type SummaryOwnership,
  type TerminationReason,
} from './types';

export {
  createKiloGatewayModel,
  DEFAULT_KILO_GATEWAY_URL,
  DEFAULT_KILO_GATEWAY_URL as KILO_GATEWAY_URL,
  resolveKiloGatewayUrl,
} from './model';

export const MAX_CLONE_ATTEMPTS = 3;

export const REVIEW_ACTIVE_TOOLS = [
  'read',
  'grep',
  'list',
  'find',
  ...GITHUB_TOOL_NAMES,
  'activate_skill',
  'task',
] as const;

const DENIED_WORKSPACE_TOOLS = ['write', 'edit', 'delete'] as const;
const CREDENTIAL_RETENTION_SECONDS = 60 * 60;
const REVIEW_RETENTION_SECONDS = 24 * 60 * 60;
const ADMISSION_TIMEOUT_MS = 5 * 60 * 1000;
const EXECUTION_TIMEOUT_MS = 12 * 60 * 1000;
const ABSOLUTE_TIMEOUT_MS = ADMISSION_TIMEOUT_MS + EXECUTION_TIMEOUT_MS;
const EXECUTION_TIMEOUT_ERROR = 'Review execution deadline exceeded';
const CREDENTIAL_EXPIRATION_ERROR = 'Review credentials expired before completion';
const MISSING_SUMMARY_ERROR = 'Review completed without a valid summary proposal';
const INCOMPLETE_TASKS_ERROR = 'Required child investigations are incomplete; refusing publication';
const PARENT_STEP_LIMIT_ERROR = 'Parent review exhausted its step budget';
const MAX_RECONCILIATION_ATTEMPTS = 2;
const HistoryStateSchema = z
  .object({
    requestCount: z.number().int().nonnegative().max(MAX_HISTORY_REQUESTS),
    commitShas: z
      .array(z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
      .max(MAX_HISTORY_COMMITS),
  })
  .strict();

export class MissingRunStateError extends Error {
  constructor() {
    super('Review run state is not available');
    this.name = 'MissingRunStateError';
  }
}

type TerminalUpdate = {
  status: 'completed' | 'error';
  error?: string;
  terminationReason: TerminationReason;
};

function isTerminal(state: RunState): boolean {
  return state.status === 'completed' || state.status === 'error';
}

function publicationOutcome(state: RunState): PublicationOutcome {
  return state.publicationOutcome ?? { review: 'not_requested', summary: 'not_requested' };
}

function deadlineFailure(state: RunState): TerminalUpdate | undefined {
  const now = Date.now();
  if (state.credentialsExpireAt !== undefined && state.credentialsExpireAt <= now) {
    return {
      status: 'error',
      error: CREDENTIAL_EXPIRATION_ERROR,
      terminationReason: 'credentials_expired',
    };
  }
  if (state.absoluteDeadlineAt !== undefined && state.absoluteDeadlineAt <= now) {
    return {
      status: 'error',
      error: 'Review absolute deadline exceeded',
      terminationReason: 'absolute_deadline',
    };
  }
  if (state.executionDeadlineAt !== undefined && state.executionDeadlineAt <= now) {
    return {
      status: 'error',
      error: EXECUTION_TIMEOUT_ERROR,
      terminationReason: 'execution_deadline',
    };
  }
  if (
    !state.cloneCompletedAt &&
    state.admissionDeadlineAt !== undefined &&
    state.admissionDeadlineAt <= now
  ) {
    return {
      status: 'error',
      error: 'Review admission deadline exceeded',
      terminationReason: 'admission_deadline',
    };
  }
  return undefined;
}

function submissionError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  if (/\b401\b/.test(error)) {
    return `${error}; the kiloToken may have expired during the review`;
  }
  return error;
}

function disabledWorkspaceTool(name: string) {
  return tool<Record<string, unknown>, string, Record<string, unknown>>({
    description: `Disabled. ${name} is not available during a code review.`,
    inputSchema: z.object({}).passthrough(),
    execute: async (_input: Record<string, unknown>) => {
      throw new Error(`${name} is disabled: reviews are read-only`);
    },
  });
}

export class ReviewIsolate extends Think<Env> {
  override workspaceBash = false;
  override includeMcpTools = false;
  override maxSteps = 40;

  override getSkills() {
    return [ISOLATE_REVIEW_SKILLS];
  }

  #rawWorkspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    useThink: true,
    git: createGitClient(),
  }) as Workspace & ThinkWorkspaceCompatibility;

  override workspace = createSafeReviewWorkspace(this.#rawWorkspace);

  #persistence: ReviewPersistence;
  #state?: RunState;
  #loggedToolNames = false;
  #cleanupDestroyed = false;
  #stateMutation: Promise<void> = Promise.resolve();
  #cloneRunning = false;
  #executionTimer?: ReturnType<typeof setTimeout>;
  #abortController = new AbortController();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const { persistence, migrate } = createReviewPersistence(ctx.storage);
    this.#persistence = persistence;
    void ctx.blockConcurrencyWhile(async () => {
      await migrate();
      this.#state = await persistence.get<RunState>('runState');
    });
  }

  override async alarm(): Promise<void> {
    try {
      await super.alarm();
    } catch (error) {
      if (
        !this.#cleanupDestroyed ||
        !(error instanceof Error) ||
        !/no such table: cf_think_workflow_notifications\b/.test(error.message)
      ) {
        throw error;
      }
    }
  }

  async startQueuedReview(
    raw: QueuedReviewRequest,
    credentials: Pick<StartReviewInput, 'kiloToken' | 'userId' | 'credentialsExpireAt'>
  ) {
    const request = QueuedReviewRequestSchema.parse(raw);
    const { identity, preparationHash, runId } = request.admission;
    if (credentials.userId !== identity.executionUserId) throw new QueuedReviewConflictError();
    const existing = await this.#loadState();
    if (existing) {
      this.#assertQueuedAdmission(existing, identity, preparationHash);
    } else {
      const queued = await this.#newQueuedState(identity, preparationHash);
      await this.#initializeReview(runId, { ...request.review, ...credentials }, queued);
    }
    await this.#admitQueuedReview(runId);
    return this.#queuedStatus(identity);
  }

  async controlQueuedReview(raw: z.infer<typeof QueuedIsolateControlRequestSchema>) {
    const request = QueuedIsolateControlRequestSchema.parse(raw);
    const { identity } = request;
    const existing = await this.#loadState();
    if (existing) assertQueuedIdentity(existing, identity);
    if (request.operation === 'status' || (existing && isTerminal(existing)))
      return existing ? this.#queuedStatus(identity) : null;
    const queued = existing?.queued ?? (await this.#newQueuedState(identity));
    const [owner, repo] = identity.target.repoFullName.split('/');
    if (!owner || !repo) throw new QueuedReviewConflictError();
    const state = await this.#updateState(current => {
      if (current) assertQueuedIdentity(current, identity);
      if (current && isTerminal(current)) return current;
      const base =
        current ??
        ({
          runId: identity.attemptId,
          status: 'pending',
          input: {
            owner,
            repo,
            pullNumber: identity.target.prNumber,
            organizationId: identity.organizationId,
            userId: identity.executionUserId,
            expectedIntegrationId: identity.integrationId,
            kiloToken: '',
            dryRun: false,
          },
          queued,
        } satisfies RunState);
      if (!base.queued) throw new QueuedReviewConflictError();
      return this.#terminalState(
        {
          ...base,
          queued: { ...base.queued, cancellationRequested: true },
        },
        { status: 'error', error: 'Review cancelled', terminationReason: 'cancelled' }
      );
    });
    if (state) await this.#stopExecution(state);
    return this.#queuedStatus(identity);
  }

  async #newQueuedState(
    identity: QueuedIsolateIdentity,
    preparationHash?: string
  ): Promise<QueuedReviewState> {
    QueuedIsolateIdentitySchema.parse(identity);
    const callback = await queuedCallback(this.env, identity);
    const schedule = await this.schedule(
      '*/1 * * * *',
      'maintainQueuedReview',
      { runId: identity.attemptId },
      { idempotent: true }
    );
    return {
      identity,
      preparationHash,
      callback,
      maintenanceScheduleId: schedule.id,
      admitted: false,
      cancellationRequested: false,
      operations: [],
      acknowledgedSequence: 0,
      fenceReleased: false,
      cleaned: false,
      safety: {
        sequence: 1,
        execution: 'not_started',
        cancellationRequested: false,
        publication: 'not_started',
        quiescent: false,
        observedAt: new Date().toISOString(),
      },
    };
  }

  #assertQueuedAdmission(
    state: RunState,
    identity: QueuedIsolateIdentity,
    preparationHash: string
  ) {
    assertQueuedIdentity(state, identity);
    if (
      state.queued?.preparationHash !== undefined &&
      state.queued.preparationHash !== preparationHash
    ) {
      throw new QueuedReviewConflictError();
    }
  }

  async #queuedStatus(identity: QueuedIsolateIdentity) {
    const state = await this.#loadState();
    if (!state?.queued) throw new QueuedReviewConflictError();
    assertQueuedIdentity(state, identity);
    return { version: 1 as const, identity: state.queued.identity, safety: state.queued.safety };
  }

  async #admitQueuedReview(runId: string): Promise<void> {
    let state = await this.#updateActive(runId, current => current);
    if (!state?.queued) return;
    if (!state.queued.admitted) {
      const authorized = await requestQueuedAuthority(state.queued, 'execute', runId);
      state = await this.#updateActive(runId, current => {
        if (!current.queued) throw new QueuedReviewConflictError();
        if (!authorized)
          return this.#terminalState(current, {
            status: 'error',
            error: 'Canonical queued review authority denied admission',
            terminationReason: 'admission_failed',
          });
        return { ...current, queued: { ...current.queued, admitted: true } };
      });
    }
    if (state && !state.submissionId) await this.#scheduleClone(runId);
  }

  async maintainQueuedReview(payload: { runId: string }): Promise<void> {
    let state = await this.#loadState();
    if (!state?.queued || state.runId !== payload.runId) return;
    try {
      if (!isTerminal(state)) {
        await this.#admitQueuedReview(state.runId);
        await this.getReview(state.queued.identity.executionUserId);
      } else if (state.queued.operations.some(operation => operation.state === 'sent')) {
        await this.#reconcileQueuedPublication(state);
      }
    } catch {
      console.error('[queued-review] maintenance deferred', { runId: payload.runId });
    }
    state = await this.#loadState();
    if (!state?.queued) return;
    try {
      const acknowledgement = await notifyQueuedReview(state.queued);
      if (acknowledgement !== undefined) {
        const { sequence, fenceReleased, usageSettled } = acknowledgement;
        await this.#updateState(current => {
          if (!current?.queued || current.queued.pendingNotification?.safety.sequence !== sequence)
            return current;
          return {
            ...current,
            queued: {
              ...current.queued,
              acknowledgedSequence: sequence,
              fenceReleased,
              pendingNotification:
                isTerminal(current) &&
                sequence === current.queued.safety.sequence &&
                (!usageSettled || (current.queued.safety.quiescent && !fenceReleased))
                  ? current.queued.pendingNotification
                  : undefined,
            },
          };
        });
      }
    } catch {
      console.error('[queued-review] notification deferred', { runId: payload.runId });
    }
    const latest = await this.#loadState();
    if (
      latest?.queued?.safety.quiescent &&
      latest.queued.fenceReleased &&
      !latest.queued.pendingNotification
    ) {
      await this.cancelSchedule(latest.queued.maintenanceScheduleId);
    }
  }

  async startReview(runId: string, input: StartReviewInput): Promise<void> {
    if (!allowsDirectGithubToken(this.env.ENVIRONMENT))
      throw new Error('Direct reviews are development-only');
    await this.#initializeReview(runId, input);
  }

  async #initializeReview(
    runId: string,
    input: StartReviewInput,
    queued?: QueuedReviewState
  ): Promise<void> {
    const existing = await this.#loadState();
    if (existing) {
      if (queued?.preparationHash)
        this.#assertQueuedAdmission(existing, queued.identity, queued.preparationHash);
      else if (existing.queued) throw new QueuedReviewConflictError();
      if (existing.runId !== runId) throw new Error('Run already started on this DO');
      if (!existing.queued && !isTerminal(existing) && !existing.submissionId)
        await this.#scheduleClone(runId);
      return;
    }
    const { kiloToken, userId, credentialsExpireAt: verifiedExpiry, ...request } = input;
    const parsed = StartReviewRequestSchema.parse(request);
    if (!runId || !kiloToken) throw new Error('Invalid review input');
    const offlineFixture =
      Boolean(parsed.gitToken?.trim()) && allowsDirectGithubToken(this.env.ENVIRONMENT);
    if (!userId?.trim() && !offlineFixture)
      throw new Error('userId is required for GitHub token resolution');
    if (!preparationMatchesIdentity(parsed, userId ?? '')) {
      throw new Error('Preparation does not match the authenticated execution user');
    }
    const publication = parsed.preparation?.queued;
    if (queued) {
      if (
        !publication ||
        queuedIdentityKey(publication.identity) !== queuedIdentityKey(queued.identity)
      ) {
        throw new Error('Queued preparation does not match canonical admission');
      }
    } else if (publication) {
      throw new Error('Canonical publication requires queued admission');
    }
    if (
      parsed.dryRun === false &&
      parsed.existingSummaryCommentId !== undefined &&
      !parsed.previousRunId
    ) {
      throw new Error('Summary reuse requires a previousRunId ownership proof');
    }
    validateRepositoryName(parsed.owner, parsed.repo);
    const now = Date.now();
    if (
      (!Number.isSafeInteger(verifiedExpiry) || (verifiedExpiry ?? 0) <= now) &&
      !offlineFixture
    ) {
      throw new Error('Verified credential expiry is required');
    }
    if (
      verifiedExpiry !== undefined &&
      (!Number.isSafeInteger(verifiedExpiry) || verifiedExpiry <= now)
    ) {
      throw new Error(CREDENTIAL_EXPIRATION_ERROR);
    }
    const credentialsExpireAt = Math.min(
      verifiedExpiry ?? Infinity,
      now + CREDENTIAL_RETENTION_SECONDS * 1000
    );
    const normalizedInput: StartReviewInput = {
      ...parsed,
      kiloToken,
      userId,
      credentialsExpireAt: verifiedExpiry,
      model: parsed.model?.trim() || DEFAULT_MODEL,
      dryRun: isDryRun(parsed.dryRun),
    };
    const admissionDeadlineAt = Math.min(now + ADMISSION_TIMEOUT_MS, credentialsExpireAt);
    const absoluteDeadlineAt = Math.min(now + ABSOLUTE_TIMEOUT_MS, credentialsExpireAt);
    await this.#updateState(async state => {
      if (state) {
        if (queued?.preparationHash)
          this.#assertQueuedAdmission(state, queued.identity, queued.preparationHash);
        else if (state.queued) throw new QueuedReviewConflictError();
        return state;
      }
      await this.schedule(
        Math.ceil((credentialsExpireAt - now) / 1000),
        'expireCredentials',
        { runId },
        { idempotent: true }
      );
      await this.schedule(
        REVIEW_RETENTION_SECONDS,
        'cleanupReview',
        { runId },
        { idempotent: true }
      );
      await this.schedule(
        new Date(Math.ceil(admissionDeadlineAt / 1000) * 1000),
        'expireReview',
        { runId, deadlineAt: admissionDeadlineAt },
        { idempotent: true }
      );
      if (credentialsExpireAt <= Date.now()) throw new Error(CREDENTIAL_EXPIRATION_ERROR);
      if (admissionDeadlineAt <= Date.now()) throw new Error('Review admission deadline exceeded');
      return {
        runId,
        status: 'pending',
        input: normalizedInput,
        ...(queued ? { queued, queuedPublication: publication } : {}),
        createdAt: new Date(now).toISOString(),
        credentialsExpireAt,
        admissionDeadlineAt,
        absoluteDeadlineAt,
        cleanupAt: now + REVIEW_RETENTION_SECONDS * 1000,
        provenance: parsed.preparation ? 'prepared' : 'raw',
        inferenceResolved: Boolean(parsed.preparation && parsed.inference),
        analysisOutcome: { status: 'pending', stepCount: 0 },
        publicationOutcome: { review: 'not_requested', summary: 'not_requested' },
        usageSessions: [runId],
        limitations: [
          'Clone transport may continue after cancellation; late completion cannot authorize review work.',
        ],
      };
    });
    if (!queued) await this.#scheduleClone(runId);
  }

  async runClone(payload?: { runId: string }): Promise<void> {
    if (this.#cloneRunning) return;
    this.#cloneRunning = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let runId: string | undefined;
    try {
      const initial = await this.#loadState();
      if (
        !initial ||
        (payload && initial.runId !== payload.runId) ||
        initial.submissionId ||
        (initial.queued && !initial.queued.admitted) ||
        !['pending', 'cloning'].includes(initial.status)
      )
        return;
      runId = initial.runId;
      const state = await this.#updateActive(runId, current => {
        if ((current.cloneAttempts ?? 0) >= MAX_CLONE_ATTEMPTS) {
          return this.#terminalState(current, {
            status: 'error',
            error: `Clone failed after ${MAX_CLONE_ATTEMPTS} attempts`,
            terminationReason: 'admission_failed',
          });
        }
        const now = Date.now();
        const createdAt = current.createdAt ? Date.parse(current.createdAt) : now;
        const credentialsExpireAt =
          current.credentialsExpireAt ??
          current.input.credentialsExpireAt ??
          now + CREDENTIAL_RETENTION_SECONDS * 1000;
        return {
          ...current,
          status: 'cloning',
          cloneAttempts: (current.cloneAttempts ?? 0) + 1,
          startedAt: current.startedAt ?? new Date(now).toISOString(),
          credentialsExpireAt,
          admissionDeadlineAt:
            current.admissionDeadlineAt ??
            Math.min(createdAt + ADMISSION_TIMEOUT_MS, credentialsExpireAt),
          absoluteDeadlineAt:
            current.absoluteDeadlineAt ??
            Math.min(createdAt + ABSOLUTE_TIMEOUT_MS, credentialsExpireAt),
        };
      });
      if (!state) return;
      const deadline = state.executionDeadlineAt ?? state.admissionDeadlineAt;
      if (deadline === undefined) throw new MissingRunStateError();
      timeout = setTimeout(
        () => {
          this.ctx.waitUntil(this.expireReview({ runId: state.runId }));
        },
        Math.max(0, deadline - Date.now())
      );
      const signal = this.#abortController.signal;
      const credentials = state.githubToken
        ? { token: state.githubToken, installationId: state.installationId, appType: state.appType }
        : await resolveGithubCredentials({
            input: state.input,
            service: this.env.GIT_TOKEN_SERVICE,
            allowDirectToken: allowsDirectGithubToken(this.env.ENVIRONMENT),
          });
      const authenticated = await this.#updateActive(runId, current => {
        if (
          (current.input.expectedInstallationId !== undefined &&
            current.input.expectedInstallationId !== credentials.installationId) ||
          (current.input.expectedAppType !== undefined &&
            current.input.expectedAppType !== credentials.appType)
        )
          throw new Error('Resolved GitHub identity does not match the prepared review');
        return {
          ...current,
          githubToken: credentials.token,
          installationId: credentials.installationId,
          appType: credentials.appType,
        };
      });
      if (!authenticated) return;
      const github = createGithubClient(
        credentials.token,
        globalThis.fetch,
        this.env.GITHUB_API_URL
      );
      const snapshot =
        state.headSha && state.baseTipSha && state.mergeBaseSha
          ? {
              headSha: state.headSha,
              baseTipSha: state.baseTipSha,
              mergeBaseSha: state.mergeBaseSha,
            }
          : await resolveReviewSnapshot(github, state.input, signal);
      const pinned = await this.#updateActive(runId, current => ({ ...current, ...snapshot }));
      if (!pinned) return;
      const { sizeKiB } = await admitRepository(
        github,
        state.input.owner,
        state.input.repo,
        snapshot.headSha,
        signal
      );
      if (!(await this.#updateActive(runId, current => ({ ...current, githubSizeKiB: sizeKiB }))))
        return;
      console.log('[clone] admitted', { runId, githubSizeKiB: sizeKiB });
      const reviewSelection =
        pinned.reviewSelection ?? (await this.#resolveReviewSelection(pinned, github, signal));
      const selected = await this.#updateActive(runId, current => ({
        ...current,
        reviewSelection,
      }));
      if (!selected) return;
      const summaryOwnership =
        selected.summaryOwnership ?? (await this.#resolveSummaryOwnership(selected));
      if (!(await this.#updateActive(runId, current => ({ ...current, summaryOwnership })))) return;
      const inference = validateIsolateReviewInference(
        pinned.inferenceResolved && pinned.input.inference
          ? pinned.input.inference
          : await resolveIsolateReviewInference({
              kiloToken: pinned.input.kiloToken,
              organizationId: pinned.input.organizationId,
              model: pinned.input.model,
              thinkingEffort: pinned.input.thinkingEffort,
              gatewayUrl: this.env.KILO_GATEWAY_URL,
              fetchImpl: (request, init) =>
                globalThis.fetch(request, {
                  ...init,
                  signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
                }),
            })
      );
      if (
        inference.modelId !== (pinned.input.model?.trim() || DEFAULT_MODEL) ||
        inference.thinkingEffort !== (pinned.input.thinkingEffort ?? null)
      )
        throw new Error('Resolved inference does not match the requested model and effort');
      const ready = await this.#updateActive(runId, current => ({
        ...current,
        input: { ...current.input, inference },
        inferenceResolved: true,
      }));
      if (!ready) return;
      const stats = await cloneRepository(this.#rawWorkspace, ready.input, snapshot.headSha, {
        cloneUrlTemplate: this.env.GIT_CLONE_URL_TEMPLATE,
        token: credentials.token,
        signal,
      });
      const cloned = await this.#updateActive(runId, current => ({
        ...current,
        cloneCompletedAt: new Date(Date.now()).toISOString(),
        tipFileCount: stats.tipFileCount,
        tipTotalBytes: stats.tipTotalBytes,
        vfsTotalBytes: stats.vfsTotalBytes,
        cloneMs: stats.cloneMs,
        executionDeadlineAt: Math.min(
          current.executionDeadlineAt ?? Date.now() + EXECUTION_TIMEOUT_MS,
          current.absoluteDeadlineAt ?? Infinity,
          current.credentialsExpireAt ?? Infinity
        ),
        analysisOutcome: {
          ...current.analysisOutcome,
          status: 'running',
          stepCount: current.analysisOutcome?.stepCount ?? 0,
        },
      }));
      if (!cloned) return;
      console.log('[clone] complete', { runId, githubSizeKiB: sizeKiB, ...stats });
      await this.#scheduleDeadline(cloned);
      const admitted = await this.#updateActive(runId, current => current);
      if (!admitted) return;
      const text = admitted.input.preparation
        ? admitted.input.userPrompt
        : resolveReviewUserMessage(admitted.input, snapshot.headSha);
      if (!text?.trim()) throw new Error('Prepared review prompt is missing');
      const message: UIMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text }],
      };
      const submission = await this.submitMessages([message], { idempotencyKey: runId });
      await this.#settleSubmission(submission);
    } catch (error) {
      if (!runId) throw error;
      const current = await this.#updateActive(runId, state => state);
      if (!current) return;
      if (error instanceof RepoTooLargeError) {
        await this.#updateActive(runId, state => ({ ...state, githubSizeKiB: error.sizeKiB }));
        await this.#terminate(runId, {
          status: 'error',
          error: error.message,
          terminationReason: 'admission_failed',
        });
        return;
      }
      const message = this.#safeError(
        error instanceof Error ? error.message : String(error),
        current
      );
      if ((current.cloneAttempts ?? 0) < MAX_CLONE_ATTEMPTS) throw new Error(message);
      await this.#terminate(runId, {
        status: 'error',
        error: `Clone failed after ${MAX_CLONE_ATTEMPTS} attempts: ${message}`,
        terminationReason: 'admission_failed',
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.#cloneRunning = false;
      const latest = await this.#loadState();
      if (latest && isTerminal(latest))
        await this.workspace.rm(REPO_ROOT, { recursive: true, force: true });
    }
  }

  async expireCredentials(payload: { runId: string }): Promise<void> {
    await this.#terminate(payload.runId, {
      status: 'error',
      error: CREDENTIAL_EXPIRATION_ERROR,
      terminationReason: 'credentials_expired',
    });
  }

  async expireReview(payload: { runId: string; deadlineAt?: number }): Promise<void> {
    const state = await this.#updateActive(payload.runId, current => current);
    if (state) await this.#scheduleDeadline(state);
  }

  async cancelReview(userId: string): Promise<boolean> {
    const state = await this.#loadState();
    if (!state || state.input.userId !== userId) return false;
    await this.#terminate(state.runId, {
      status: 'error',
      error: 'Review cancelled',
      terminationReason: 'cancelled',
    });
    return true;
  }

  override async cancelSubmission(submissionId: string, reason?: unknown): Promise<void> {
    const state = await this.#loadState();
    if (state?.submissionId === submissionId && !isTerminal(state)) {
      await this.#terminate(state.runId, {
        status: 'error',
        error: 'Review cancelled',
        terminationReason: 'cancelled',
      });
      return;
    }
    await super.cancelSubmission(submissionId, reason);
  }

  async cleanupReview(payload: { runId: string }): Promise<void> {
    const state = await this.#loadState();
    if (!state || state.runId !== payload.runId) return;
    await this.#terminate(state.runId, {
      status: 'error',
      error: 'Review retention expired',
      terminationReason: 'cleanup',
    });
    if (state.queued) {
      if (!this.session) await this.onStart();
      await this.clearMessages();
      await this.#persistence.deleteExcept('runState');
      await this.#updateState(current => {
        if (!current?.queued) return current;
        return {
          ...current,
          input: {
            owner: current.input.owner,
            repo: current.input.repo,
            pullNumber: current.input.pullNumber,
            organizationId: current.input.organizationId,
            userId: current.input.userId,
            expectedIntegrationId: current.input.expectedIntegrationId,
            expectedInstallationId: current.input.expectedInstallationId,
            expectedAppType: current.input.expectedAppType,
            kiloToken: '',
            dryRun: false,
          },
          summaryContent: undefined,
          reviewProposal: undefined,
          summaryProposal: undefined,
          historyState: undefined,
          taskSessions: undefined,
          requestIds: undefined,
          usageRequestCounts: undefined,
          queued: { ...current.queued, cleaned: true },
        };
      });
      return;
    }
    await this.destroy();
    this.#cleanupDestroyed = true;
  }

  async getReview(userId: string): Promise<ReviewStatusResponse | null> {
    let state = await this.#loadState();
    if (!state || state.input.userId !== userId) return null;
    if (!isTerminal(state)) {
      state =
        (await this.#updateActive(state.runId, current => current)) ?? (await this.#loadState());
      if (!state) return null;
      if (!isTerminal(state) && state.submissionId) {
        const submission = await this.inspectSubmission(state.submissionId);
        if (submission) await this.#settleSubmission(submission);
      } else if (!isTerminal(state) && (!state.queued || state.queued.admitted)) {
        await this.#scheduleClone(state.runId);
      }
    }
    if (isTerminal(state) && (hasReviewSecrets(state.input) || state.githubToken)) {
      await this.#updateState(current =>
        current
          ? { ...current, input: scrubReviewSecrets(current.input), githubToken: undefined }
          : current
      );
      await this.workspace.rm(REPO_ROOT, { recursive: true, force: true });
    }
    const persisted = await this.#loadState();
    if (!persisted) return null;
    return {
      runId: persisted.runId,
      status: persisted.status,
      owner: persisted.input.owner,
      repo: persisted.input.repo,
      pullNumber: persisted.input.pullNumber,
      organizationId: persisted.input.organizationId,
      userId: persisted.input.userId,
      requestedModel: persisted.input.model?.trim() || DEFAULT_MODEL,
      dryRun: isDryRun(persisted.input.dryRun),
      createdAt: persisted.createdAt,
      startedAt: persisted.startedAt,
      cloneCompletedAt: persisted.cloneCompletedAt,
      completedAt: persisted.completedAt,
      cloneAttempts: persisted.cloneAttempts,
      githubSizeKiB: persisted.githubSizeKiB,
      tipFileCount: persisted.tipFileCount,
      tipTotalBytes: persisted.tipTotalBytes,
      vfsTotalBytes: persisted.vfsTotalBytes,
      cloneMs: persisted.cloneMs,
      headSha: persisted.headSha,
      baseTipSha: persisted.baseTipSha,
      mergeBaseSha: persisted.mergeBaseSha,
      installationId: persisted.installationId,
      appType: persisted.appType,
      summaryBodyHash: persisted.summaryBodyHash,
      reviewFingerprint: persisted.reviewFingerprint,
      summaryFingerprint: persisted.summaryFingerprint,
      provenance: persisted.provenance,
      preparation: persisted.input.preparation,
      inference: persisted.input.inference,
      analysisOutcome: persisted.analysisOutcome,
      publicationOutcome: persisted.publicationOutcome,
      terminationReason: persisted.terminationReason,
      reviewProposal: persisted.reviewProposal,
      summaryProposal: persisted.summaryProposal,
      summaryContent: persisted.status === 'completed' ? persisted.summaryContent : undefined,
      gateResult: persisted.status === 'completed' ? persisted.gateResult : undefined,
      reviewSelection: persisted.reviewSelection,
      cleanupAt: persisted.cleanupAt,
      usageSessions: persisted.usageSessions ?? [persisted.runId],
      taskSessions: persisted.taskSessions,
      systemPromptHash: persisted.systemPromptHash,
      systemPromptVersion: persisted.systemPromptVersion,
      requestIds: persisted.requestIds,
      limitations: persisted.limitations,
      error: persisted.error,
      finalText: persisted.status === 'completed' ? await this.#lastAssistantText() : undefined,
      githubReviewId: persisted.reviewId,
      summaryCommentId: persisted.summaryCommentId,
      reviewReconciliationAttempts: persisted.reviewReconciliationAttempts,
      summaryReconciliationAttempts: persisted.summaryReconciliationAttempts,
      published: persisted.published,
      publishedAt: persisted.publishedAt,
    };
  }

  async getTranscript(userId: string): Promise<ReviewTranscriptResponse | null> {
    const state = await this.#persistence.get<RunState>('runState');
    if (!state || state.input.userId !== userId) return null;
    await this.__unsafe_ensureInitialized();
    const { messages, toolCalls } = projectReviewTranscript(await this.getMessages());
    return { runId: state.runId, messages, toolCalls };
  }

  override getModel() {
    const state = this.#state;
    if (!state) throw new MissingRunStateError();
    return this.#createModel({ sessionId: state.runId, mode: 'code' });
  }

  #createModel(session: Pick<TaskSession, 'sessionId' | 'parentSessionId' | 'mode'>) {
    const state = this.#state;
    if (!state) throw new MissingRunStateError();
    const failure = deadlineFailure(state);
    if (failure) throw new Error(failure.error);
    if (isTerminal(state)) throw new Error('Review is terminal');
    if (state.input.reviewMode === 'incremental' && !state.reviewSelection) {
      throw new Error('Incremental review selection has not been validated');
    }
    if (
      !state.inferenceResolved ||
      !state.input.inference ||
      !state.input.kiloToken ||
      state.executionDeadlineAt === undefined
    )
      throw new Error('Review inference has not been resolved');
    return createKiloGatewayModel({
      runId: state.runId,
      ...session,
      kiloToken: state.input.kiloToken,
      organizationId: state.input.organizationId,
      model: this.#modelId(),
      inference: state.input.inference,
      gatewayUrl: this.env.KILO_GATEWAY_URL,
      fetchImpl: (request, init) =>
        this.#fetchInference(state.runId, session.sessionId, request, init),
    });
  }

  #reviewInstructions(): string {
    const prompt = buildSystemPrompt({
      model: this.#modelId(),
      date: this.#state?.createdAt?.slice(0, 10),
      prepared: Boolean(this.#state?.input.preparation),
    });
    const queued = this.#state?.queuedPublication;
    if (!this.#state?.queued || !queued) return prompt;
    return (
      prompt.replace(
        'This isolate has no canonical review ID. Never invent or copy a Cloud fix link.',
        `This run belongs to canonical review ${queued.identity.reviewId}, attempt ${queued.identity.attemptId}. Never invent a Cloud Agent or CLI session ID or a Cloud fix link.`
      ) +
      `\n# QUEUED PUBLICATION POLICY\nThese queued-run rules override the skill's direct experimental previous-run ownership and absent-canonical-review statements. The Worker can authorize the exact server-selected summary, including a legacy summary; a discovered ID alone still grants no authority. History and usage blocks remain code-owned: never author or copy them. The merge-gate threshold is ${queued.gateThreshold}; when not off, upsert_summary requires gateResult pass or fail, evaluated against the threshold in the canonical policy. Missing required output cannot pass.\n`
    );
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    const state = await this.#updateActive(this.#state?.runId, current =>
      (current.analysisOutcome?.stepCount ?? 0) >= this.maxSteps
        ? this.#terminalState(current, {
            status: 'error',
            error: PARENT_STEP_LIMIT_ERROR,
            terminationReason: 'step_limit',
          })
        : current
    );
    if (!state) throw new Error(this.#state?.error ?? 'Review is terminal');
    if (state.executionDeadlineAt === undefined) throw new MissingRunStateError();
    const remainingMs =
      Math.min(
        state.executionDeadlineAt,
        state.credentialsExpireAt ?? Infinity,
        state.absoluteDeadlineAt ?? Infinity
      ) - Date.now();
    if (this.#executionTimer !== undefined) clearTimeout(this.#executionTimer);
    this.#executionTimer = setTimeout(
      () => {
        this.ctx.waitUntil(this.expireReview({ runId: state.runId }));
      },
      Math.max(0, remainingMs)
    );
    if (!this.#loggedToolNames) {
      this.#loggedToolNames = true;
      const names = Object.keys(ctx.tools);
      const missing = REVIEW_ACTIVE_TOOLS.filter(name => !names.includes(name));
      console.log('[turn] tools', { names, missing });
    }
    const instructions = this.#reviewInstructions();
    const systemPromptHash = createHash('sha256').update(instructions).digest('hex');
    const recorded = await this.#updateActive(state.runId, current => ({
      ...current,
      systemPromptHash,
      systemPromptVersion: SYSTEM_PROMPT_VERSION,
      input: current.input.preparation
        ? {
            ...current.input,
            preparation: {
              ...current.input.preparation,
              hashes: { ...current.input.preparation.hashes, workerSystem: systemPromptHash },
              versions: {
                ...current.input.preparation.versions,
                workerSystem: SYSTEM_PROMPT_VERSION,
              },
            },
          }
        : current.input,
    }));
    if (!recorded) throw new Error('Review is terminal; refusing inference');
    const unfinishedTasks = (recorded.analysisOutcome?.incompleteTaskIds ?? []).map(taskId => {
      const session = recorded.taskSessions?.find(session => session.taskId === taskId);
      return {
        task_id: taskId,
        ...(session?.mode === 'general' || session?.mode === 'explore'
          ? { subagent_type: session.mode }
          : {}),
      };
    });
    return {
      instructions,
      ...(ctx.continuation && unfinishedTasks.length
        ? {
            messages: [
              ...ctx.messages,
              {
                role: 'user',
                content: `Required child investigations are unfinished. Resume these existing tasks using task_id and their original subagent_type; do not create replacements or publish before they complete:\n${JSON.stringify(unfinishedTasks)}`,
              },
            ],
          }
        : {}),
      activeTools: [...REVIEW_ACTIVE_TOOLS],
      maxSteps: this.maxSteps - (recorded.analysisOutcome?.stepCount ?? 0),
      timeout: { totalMs: remainingMs, toolMs: remainingMs },
    };
  }

  override async onStepEnd(ctx: StepContext): Promise<void> {
    await this.#updateActive(this.#state?.runId, state => ({
      ...state,
      analysisOutcome: {
        ...state.analysisOutcome,
        status: 'running',
        stepCount: (state.analysisOutcome?.stepCount ?? 0) + 1,
        parentFinishReason: ctx.finishReason,
        parentFinished: ctx.finishReason === 'stop' && ctx.toolCalls.length === 0,
      },
    }));
  }

  protected override async onSubmissionStatus(
    submission: ThinkSubmissionInspection
  ): Promise<void> {
    if (submission.status === 'pending' || submission.status === 'running') return;
    await this.#settleSubmission(submission);
  }

  override getTools(): ToolSet {
    const state = this.#state;
    if (!state?.headSha || !state.baseTipSha || !state.mergeBaseSha || isTerminal(state)) {
      throw new MissingRunStateError();
    }
    if (state.input.reviewMode === 'incremental' && !state.reviewSelection) {
      throw new Error('Incremental review selection has not been validated');
    }
    const githubToken =
      state.githubToken ??
      (allowsDirectGithubToken(this.env.ENVIRONMENT) ? state.input.gitToken : undefined);
    if (!githubToken) throw new MissingRunStateError();
    const githubOptions = {
      runId: state.runId,
      input: { ...state.input, expectedAppType: state.appType ?? state.input.expectedAppType },
      token: githubToken,
      headSha: state.headSha,
      baseTipSha: state.baseTipSha,
      mergeBaseSha: state.mergeBaseSha,
      reviewSelection: state.reviewSelection,
      historyState: state.historyState,
      onHistoryRequest: () => this.#markHistoryRequest(state.runId),
      onHistoryCommits: shas => this.#markHistoryCommits(state.runId, shas),
      summaryOwnership: state.summaryOwnership,
      queuedPublication: state.queued ? state.queuedPublication : undefined,
      apiUrl: this.env.GITHUB_API_URL,
      ...(state.queued
        ? { fetchImpl: (request, init) => this.#queuedGithubFetch(request, init) }
        : {}),
      publicationState: {
        ...state,
        contextIncompleteReasons: state.analysisOutcome?.contextIncompleteReasons,
      },
      onReconciliationStarted: kind => this.#markReconciliationStarted(kind),
      onPublicationStarted: (kind, details) => this.#markPublicationStarted(kind, details),
      onPublicationRejected: kind => this.#markPublicationRejected(kind),
      onPublished: event => this.#markPublished(event),
      onProposal: event => this.#markProposal(event),
      onContextIncomplete: reason => this.#markContextIncomplete(reason),
    } satisfies Parameters<typeof createGithubTools>[0];
    const github = createGithubTools(githubOptions);
    for (const [name, kind] of [
      ['submit_review', 'review'],
      ['upsert_summary', 'summary'],
    ] as const) {
      const original = github[name];
      const execute = original?.execute;
      if (!original || !execute) continue;
      let executePublication = execute;
      github[name] = {
        ...original,
        execute: async (args, context) => {
          const active = await this.#updateActive(state.runId, current => {
            const outcome = publicationOutcome(current);
            return {
              ...current,
              publicationOutcome: {
                ...outcome,
                [kind]: ['confirmed', 'pending', 'uncertain'].includes(outcome[kind])
                  ? outcome[kind]
                  : 'rejected',
              },
            };
          });
          if (!active) throw new Error('Review is terminal; refusing publication');
          const previouslyPublished =
            kind === 'review' ? active.reviewId !== undefined : active.summaryPublished === true;
          try {
            if (active.analysisOutcome?.incompleteTaskIds?.length) {
              throw new Error(INCOMPLETE_TASKS_ERROR);
            }
            const result: unknown = await executePublication(args, context);
            if (isDryRun(active.input.dryRun)) {
              const current = await this.#updateActive(state.runId, current => current);
              if (!current) throw new Error('Review is terminal; refusing proposal');
              if (current.analysisOutcome?.incompleteTaskIds?.length) {
                throw new Error(INCOMPLETE_TASKS_ERROR);
              }
            }
            if (result && typeof result === 'object' && 'error' in result) {
              await this.#markPublicationFailed(kind, previouslyPublished);
            }
            return result;
          } catch (error) {
            await this.#markPublicationFailed(kind, previouslyPublished);
            if (error instanceof Error && error.message === INCOMPLETE_TASKS_ERROR) {
              const current = await this.#loadState();
              if (current && !isTerminal(current)) {
                const refreshed = createGithubTools({
                  ...githubOptions,
                  publicationState: {
                    ...current,
                    contextIncompleteReasons: current.analysisOutcome?.contextIncompleteReasons,
                  },
                })[name]?.execute;
                if (refreshed) executePublication = refreshed;
              }
            }
            throw error;
          }
        },
      };
    }
    return {
      ...Object.fromEntries(
        DENIED_WORKSPACE_TOOLS.map(name => [name, disabledWorkspaceTool(name)])
      ),
      ...github,
      read: createReviewReadTool(this.workspace),
      grep: createReviewGrepTool(this.workspace),
      task: createTaskTool({
        parentSessionId: state.runId,
        createModel: session => this.#createModel(session),
        reviewContext: buildTaskReviewContext(state.input, {
          headSha: state.headSha,
          baseTipSha: state.baseTipSha,
          mergeBaseSha: state.mergeBaseSha,
        }),
        prepared: Boolean(state.input.preparation),
        workspace: this.workspace,
        github,
        storage: this.#persistence,
        onTaskState: outcome => this.#markTaskState(outcome),
      }),
    };
  }

  async #resolveReviewSelection(
    state: RunState,
    github: GithubClient,
    signal: AbortSignal
  ): Promise<IsolateReviewSelection> {
    const current = state.input.preparation;
    const asserted = current?.reviewSelection;
    if (!asserted) {
      if (state.input.reviewMode === 'incremental') {
        throw new Error('Incremental review requires canonical preparation');
      }
      return { requestedMode: 'full', effectiveMode: 'full' };
    }
    const selection = IsolateReviewSelectionSchema.parse(asserted);
    if (
      selection.requestedMode !== (state.input.reviewMode ?? 'full') ||
      selection.previousRunId !== state.input.previousRunId
    ) {
      throw new Error('Prepared review selection does not match the request');
    }
    if (selection.effectiveMode === 'full') return selection;
    if (
      !current ||
      !state.input.userId ||
      !state.installationId ||
      !state.appType ||
      !state.headSha ||
      !state.baseTipSha ||
      !state.mergeBaseSha ||
      selection.previousRunId === state.runId
    ) {
      throw new Error('Incremental baseline identity could not be proven');
    }
    signal.throwIfAborted();
    using previous = await this.#getPreviousReview(state);
    signal.throwIfAborted();
    const parsedPreparation = IsolateReviewPreparationSchema.safeParse(previous?.preparation);
    if (
      !previous ||
      !parsedPreparation.success ||
      previous.runId !== selection.previousRunId ||
      previous.status !== 'completed' ||
      previous.terminationReason !== 'completed' ||
      previous.analysisOutcome?.status !== 'completed' ||
      previous.analysisOutcome.parentFinished !== true ||
      previous.analysisOutcome.parentFinishReason !== 'stop' ||
      previous.analysisOutcome.contextIncompleteReasons?.length ||
      previous.analysisOutcome.incompleteTaskIds?.length ||
      previous.provenance !== 'prepared' ||
      previous.userId !== state.input.userId ||
      previous.organizationId !== state.input.organizationId ||
      previous.owner?.toLowerCase() !== state.input.owner.toLowerCase() ||
      previous.repo?.toLowerCase() !== state.input.repo.toLowerCase() ||
      previous.pullNumber !== state.input.pullNumber ||
      previous.installationId !== state.installationId ||
      previous.appType !== state.appType ||
      previous.cleanupAt === undefined ||
      !Number.isSafeInteger(previous.cleanupAt) ||
      previous.cleanupAt <= Date.now()
    ) {
      throw new Error('Previous review is not an eligible completed incremental baseline');
    }
    const prior = parsedPreparation.data;
    const summary = IsolateReviewSummaryContentSchema.safeParse(previous.summaryContent);
    if (
      !summary.success ||
      !summary.data.body.replace(/^<!-- kilo-review -->/, '').trim() ||
      createHash('sha256').update(summary.data.body).digest('hex') !== summary.data.bodyHash ||
      selection.previousSummaryHash !== summary.data.bodyHash
    ) {
      throw new Error('Incremental baseline summary content could not be proven');
    }
    if (
      prior.executionUserId !== state.input.userId ||
      prior.organizationId !== state.input.organizationId ||
      (state.input.organizationId === undefined && prior.requestingUserId !== state.input.userId) ||
      prior.github.integrationId !== current.github.integrationId ||
      prior.github.installationId !== state.installationId ||
      prior.github.appType !== state.appType ||
      prior.snapshot.headSha !== previous.headSha ||
      prior.snapshot.baseTipSha !== previous.baseTipSha ||
      prior.snapshot.mergeBaseSha !== previous.mergeBaseSha ||
      prior.snapshot.headSha !== selection.previousHeadSha ||
      prior.snapshot.headSha === state.headSha ||
      prior.snapshot.baseTipSha !== state.baseTipSha ||
      prior.snapshot.mergeBaseSha !== state.mergeBaseSha ||
      prior.hashes.settings !== current.hashes.settings ||
      prior.reviewInstructions?.hash !== current.reviewInstructions?.hash ||
      prior.versions.policy !== current.versions.policy ||
      prior.versions.adapter !== current.versions.adapter
    ) {
      throw new Error(
        'Incremental baseline no longer matches the prepared review policy or snapshot'
      );
    }
    if (!(await this.#updateActive(state.runId, active => active))) {
      throw new Error('Review is terminal; refusing incremental baseline verification');
    }
    const comparison = await resolveIncrementalComparison(
      github,
      state.input,
      {
        headSha: state.headSha,
        baseTipSha: state.baseTipSha,
        mergeBaseSha: state.mergeBaseSha,
      },
      selection.previousHeadSha,
      signal
    );
    if ('fallbackReason' in comparison) {
      throw new Error(`Prepared incremental comparison is invalid: ${comparison.fallbackReason}`);
    }
    if (comparison.changedFileCount !== selection.changedFileCount) {
      throw new Error('Prepared incremental comparison file count changed');
    }
    return selection;
  }

  async #getPreviousReview(state: RunState): Promise<(ReviewStatusResponse & Disposable) | null> {
    const previousRunId = state.input.previousRunId;
    const userId = state.input.userId;
    if (!previousRunId || !userId || previousRunId === state.runId) return null;
    return withDORetry(
      () => this.env.REVIEW_ISOLATE.get(this.env.REVIEW_ISOLATE.idFromName(previousRunId)),
      stub => stub.getReview(userId),
      'getReview'
    );
  }

  async #resolveSummaryOwnership(state: RunState): Promise<SummaryOwnership | undefined> {
    const previousRunId = state.input.previousRunId;
    if (
      !previousRunId ||
      (state.input.reviewMode === 'incremental' &&
        state.input.existingSummaryCommentId === undefined)
    )
      return undefined;
    if (
      previousRunId === state.runId ||
      !state.input.userId ||
      !state.installationId ||
      !state.appType
    ) {
      throw new Error('Previous summary ownership could not be proven');
    }
    using previous = await this.#getPreviousReview(state);
    if (
      !previous ||
      previous.userId !== state.input.userId ||
      previous.organizationId !== state.input.organizationId ||
      previous.owner?.toLowerCase() !== state.input.owner.toLowerCase() ||
      previous.repo?.toLowerCase() !== state.input.repo.toLowerCase() ||
      previous.pullNumber !== state.input.pullNumber ||
      previous.installationId !== state.installationId ||
      previous.appType !== state.appType ||
      previous.publicationOutcome?.summary !== 'confirmed' ||
      !previous.summaryCommentId ||
      !previous.summaryBodyHash ||
      (state.input.existingSummaryCommentId !== undefined &&
        state.input.existingSummaryCommentId !== previous.summaryCommentId)
    )
      throw new Error('Previous summary ownership could not be proven');
    return {
      previousRunId,
      commentId: previous.summaryCommentId,
      bodyHash: previous.summaryBodyHash,
    };
  }

  async #loadState(): Promise<RunState | undefined> {
    return this.#updateState(state => state);
  }

  async #updateState(
    update: (state: RunState | undefined) => RunState | undefined | Promise<RunState | undefined>
  ): Promise<RunState | undefined> {
    const mutation = this.#stateMutation.then(async () => {
      const state = await this.#persistence.get<RunState>('runState');
      const updated = await update(state);
      const next = updated?.queued
        ? updateQueuedSafety(
            updated,
            isTerminal(updated) && !updated.queued.result
              ? await this.#lastAssistantText()
              : undefined
          )
        : updated;
      if (next && next !== state) {
        const safe = isTerminal(next)
          ? {
              ...next,
              error: next.error ? this.#safeError(next.error, next) : undefined,
              input: scrubReviewSecrets(next.input),
              githubToken: undefined,
            }
          : next;
        await this.#persistence.put('runState', safe);
        this.#state = safe;
      } else {
        this.#state = next;
      }
      return this.#state;
    });
    this.#stateMutation = mutation.then(
      () => undefined,
      () => undefined
    );
    return mutation;
  }

  async #updateActive(
    runId: string | undefined,
    update: (state: RunState) => RunState
  ): Promise<RunState | undefined> {
    const state = await this.#updateState(current => {
      if (!current || (runId !== undefined && current.runId !== runId) || isTerminal(current))
        return current;
      const failure = deadlineFailure(current);
      if (failure) return this.#terminalState(current, failure);
      const next = update(current);
      const nextFailure = deadlineFailure(next);
      return nextFailure && !isTerminal(next) ? this.#terminalState(next, nextFailure) : next;
    });
    if (!state || (runId !== undefined && state.runId !== runId)) return undefined;
    if (isTerminal(state)) {
      await this.#stopExecution(state);
      return undefined;
    }
    return state;
  }

  async #scheduleClone(runId: string): Promise<void> {
    await this.schedule(
      0,
      'runClone',
      { runId },
      { idempotent: true, retry: { maxAttempts: MAX_CLONE_ATTEMPTS } }
    );
  }

  async #scheduleDeadline(state: RunState): Promise<void> {
    const deadline = Math.min(
      state.credentialsExpireAt ?? Infinity,
      state.absoluteDeadlineAt ?? Infinity,
      state.executionDeadlineAt ?? state.admissionDeadlineAt ?? Infinity
    );
    if (Number.isFinite(deadline))
      await this.schedule(
        new Date(Math.ceil(deadline / 1000) * 1000),
        'expireReview',
        { runId: state.runId, deadlineAt: deadline },
        { idempotent: true }
      );
  }

  #terminalState(state: RunState, update: TerminalUpdate): RunState {
    if (isTerminal(state)) return state;
    const analysis = state.analysisOutcome;
    let incomplete: TerminalUpdate | undefined;
    if (!analysis?.parentFinished || analysis.stepCount > this.maxSteps) {
      incomplete =
        (analysis?.stepCount ?? 0) >= this.maxSteps
          ? {
              status: 'error',
              error: PARENT_STEP_LIMIT_ERROR,
              terminationReason: 'step_limit',
            }
          : {
              status: 'error',
              error: 'Parent review did not finish cleanly',
              terminationReason: 'parent_incomplete',
            };
    } else if (analysis.contextIncompleteReasons?.length) {
      incomplete = {
        status: 'error',
        error: 'Required review context is incomplete',
        terminationReason: 'required_context_incomplete',
      };
    } else if (analysis.incompleteTaskIds?.length) {
      incomplete = {
        status: 'error',
        error: 'Required child investigations are incomplete',
        terminationReason: 'child_incomplete',
      };
    } else if (
      state.queued &&
      state.queuedPublication?.gateThreshold !== 'off' &&
      !z.enum(['pass', 'fail']).safeParse(state.gateResult).success
    ) {
      incomplete = {
        status: 'error',
        error: 'Required merge-gate result is missing or invalid',
        terminationReason: 'parent_incomplete',
      };
    } else if (!state.summaryProposal?.bodyHash) {
      incomplete = {
        status: 'error',
        error: MISSING_SUMMARY_ERROR,
        terminationReason: 'missing_summary',
      };
    }
    const outcomes = publicationOutcome(state);
    let terminal =
      update.status === 'completed' ? (deadlineFailure(state) ?? incomplete ?? update) : update;
    if (
      terminal.status === 'completed' &&
      (state.reviewPending ||
        state.summaryPending ||
        ['rejected', 'pending', 'uncertain'].includes(outcomes.review) ||
        ['rejected', 'pending', 'uncertain'].includes(outcomes.summary) ||
        (!isDryRun(state.input.dryRun) &&
          (!state.summaryPublished ||
            !state.summaryCommentId ||
            !state.summaryBodyHash ||
            outcomes.summary !== 'confirmed' ||
            (outcomes.review !== 'not_requested' && outcomes.review !== 'confirmed'))))
    ) {
      terminal = {
        status: 'error',
        error: 'Review publication is incomplete or unconfirmed',
        terminationReason: 'publication_incomplete',
      };
    }
    return {
      ...state,
      ...terminal,
      error: terminal.error ? this.#safeError(terminal.error, state) : undefined,
      analysisOutcome: {
        ...analysis,
        stepCount: analysis?.stepCount ?? 0,
        status:
          update.status === 'completed' && !incomplete && !deadlineFailure(state)
            ? 'completed'
            : 'incomplete',
      },
      publicationOutcome: {
        review:
          state.reviewPending || outcomes.review === 'pending' ? 'uncertain' : outcomes.review,
        summary:
          state.summaryPending || outcomes.summary === 'pending' ? 'uncertain' : outcomes.summary,
      },
      completedAt: state.completedAt ?? new Date(Date.now()).toISOString(),
    };
  }

  async #terminate(runId: string, update: TerminalUpdate): Promise<void> {
    const state = await this.#updateState(current =>
      current?.runId === runId ? this.#terminalState(current, update) : current
    );
    if (state?.runId === runId && isTerminal(state)) await this.#stopExecution(state);
  }

  async #stopExecution(state: RunState, cancel = true): Promise<void> {
    if (this.#executionTimer !== undefined) clearTimeout(this.#executionTimer);
    this.#executionTimer = undefined;
    this.#abortController.abort();
    if (cancel && state.submissionId && state.status !== 'completed') {
      try {
        await super.cancelSubmission(state.submissionId, state.error);
      } catch {
        console.error('[review] failed to cancel terminal submission', { runId: state.runId });
      }
    }
    await this.workspace.rm(REPO_ROOT, { recursive: true, force: true });
  }

  async #settleSubmission(submission: ThinkSubmissionInspection): Promise<void> {
    let accepted = false;
    const state = await this.#updateState(current => {
      if (!current) return current;
      const correlated = current.submissionId
        ? current.submissionId === submission.submissionId
        : submission.idempotencyKey === current.runId;
      if (!correlated) return current;
      accepted = true;
      const next = { ...current, submissionId: submission.submissionId };
      if (isTerminal(current)) return next;
      if (submission.status === 'pending' || submission.status === 'running') {
        const failure = deadlineFailure(next);
        return failure
          ? this.#terminalState(next, failure)
          : { ...next, status: submission.status };
      }
      const terminationReason =
        submission.status === 'completed'
          ? 'completed'
          : submission.status === 'aborted'
            ? 'cancelled'
            : ((next.queued ? classifyCodeReviewProviderFailure(submission.error) : null) ??
              'submission_error');
      return this.#terminalState(next, {
        status: submission.status === 'completed' ? 'completed' : 'error',
        error: next.queued
          ? terminationReason === 'completed'
            ? undefined
            : `Isolate review: ${terminationReason}`
          : submissionError(submission.error),
        terminationReason,
      });
    });
    if (accepted && state && isTerminal(state)) {
      await this.#stopExecution(
        state,
        submission.status === 'pending' || submission.status === 'running'
      );
    }
  }

  async #markProposal(event: GithubProposalEvent): Promise<void> {
    const { kind, summaryContent, gateResult, ...raw } = event;
    const gate = z.enum(['pass', 'fail']).optional().parse(gateResult);
    const proposal = ReviewProposalSchema.parse(raw);
    const content = summaryContent
      ? IsolateReviewSummaryContentSchema.parse(summaryContent)
      : undefined;
    if (
      content &&
      (kind !== 'summary' ||
        createHash('sha256').update(content.body).digest('hex') !== content.bodyHash)
    ) {
      throw new Error('Summary content does not match its validated body hash');
    }
    if (kind === 'summary' && !proposal.bodyHash)
      throw new Error('Summary proposal body hash is required');
    const state = await this.#updateActive(this.#state?.runId, current => {
      if (current.analysisOutcome?.incompleteTaskIds?.length) {
        throw new Error(INCOMPLETE_TASKS_ERROR);
      }
      if (
        current.queued &&
        kind === 'summary' &&
        (current.summaryPendingFingerprint || current.summaryFingerprint)
      ) {
        return current;
      }
      const outcome = publicationOutcome(current);
      return {
        ...current,
        ...(kind === 'review'
          ? { reviewProposal: proposal }
          : current.queued
            ? { summaryProposal: proposal }
            : { summaryProposal: proposal, summaryContent: content, gateResult: gate }),
        publicationOutcome: {
          ...outcome,
          [kind]: ['confirmed', 'pending', 'uncertain'].includes(outcome[kind])
            ? outcome[kind]
            : 'proposed',
        },
      };
    });
    if (!state) throw new Error('Review is terminal; refusing proposal');
  }

  async #markHistoryRequest(runId: string): Promise<void> {
    const active = await this.#updateActive(runId, state => {
      const history = HistoryStateSchema.parse(
        state.historyState ?? { requestCount: 0, commitShas: [] }
      );
      if (history.requestCount >= MAX_HISTORY_REQUESTS) {
        throw new Error('History request budget exhausted');
      }
      return {
        ...state,
        historyState: { ...history, requestCount: history.requestCount + 1 },
      };
    });
    if (!active) throw new Error('Review is terminal; refusing history request');
  }

  async #markHistoryCommits(runId: string, shas: string[]): Promise<void> {
    const active = await this.#updateActive(runId, state => {
      const history = HistoryStateSchema.parse(
        state.historyState ?? { requestCount: 0, commitShas: [] }
      );
      const historyState = HistoryStateSchema.parse({
        ...history,
        commitShas: [...new Set([...history.commitShas, ...shas])],
      });
      return { ...state, historyState };
    });
    if (!active) throw new Error('Review is terminal; refusing history provenance');
  }

  async #markTaskState(outcome: TaskOutcome): Promise<void> {
    const { taskId, sessionId, parentSessionId, mode } = outcome;
    let trackingExhausted = false;
    const active = await this.#updateActive(this.#state?.runId, state => {
      const sessions = state.taskSessions ?? [];
      const previous = sessions.find(session => session.taskId === taskId);
      if (
        previous &&
        (previous.sessionId !== sessionId ||
          previous.mode !== mode ||
          previous.parentSessionId !== parentSessionId)
      ) {
        throw new Error('Child session identity changed during a review');
      }
      const taskSessions = previous
        ? sessions
        : [...sessions, { taskId, sessionId, parentSessionId, mode }];
      const usageSessions = [...new Set([state.runId, ...(state.usageSessions ?? []), sessionId])];
      const incompleteTaskIds =
        outcome.state === 'completed'
          ? (state.analysisOutcome?.incompleteTaskIds ?? []).filter(id => id !== taskId)
          : [...new Set([...(state.analysisOutcome?.incompleteTaskIds ?? []), taskId])];
      if (
        taskSessions.length > 100 ||
        usageSessions.length > 100 ||
        incompleteTaskIds.length > 100
      ) {
        trackingExhausted = true;
        return {
          ...state,
          analysisOutcome: {
            ...state.analysisOutcome,
            status: 'running',
            stepCount: state.analysisOutcome?.stepCount ?? 0,
            contextIncompleteReasons: [
              ...new Set([
                ...(state.analysisOutcome?.contextIncompleteReasons ?? []),
                'Child session tracking exhausted; refusing untracked inference',
              ]),
            ].slice(-100),
          },
        };
      }
      return {
        ...state,
        taskSessions,
        usageSessions,
        reviewProposal:
          incompleteTaskIds.length && state.reviewProposal?.publishable
            ? { ...state.reviewProposal, publishable: false, blockedReason: INCOMPLETE_TASKS_ERROR }
            : state.reviewProposal,
        summaryProposal:
          incompleteTaskIds.length && state.summaryProposal?.publishable
            ? {
                ...state.summaryProposal,
                publishable: false,
                blockedReason: INCOMPLETE_TASKS_ERROR,
              }
            : state.summaryProposal,
        analysisOutcome: {
          ...state.analysisOutcome,
          status: 'running',
          stepCount: state.analysisOutcome?.stepCount ?? 0,
          incompleteTaskIds,
        },
      };
    });
    if (!active) throw new Error('Review is terminal; refusing child work');
    if (trackingExhausted) throw new Error('Child session tracking exhausted');
  }

  async #markContextIncomplete(reason: string): Promise<void> {
    await this.#updateActive(this.#state?.runId, state => ({
      ...state,
      analysisOutcome: {
        ...state.analysisOutcome,
        status: 'running',
        stepCount: state.analysisOutcome?.stepCount ?? 0,
        contextIncompleteReasons: [
          ...new Set([
            ...(state.analysisOutcome?.contextIncompleteReasons ?? []),
            reason.slice(0, 1_000),
          ]),
        ].slice(0, 100),
      },
    }));
  }

  async #queuedGithubFetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(
      typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
    );
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      if (!(await this.#updateActive(this.#state?.runId, current => current)))
        throw new Error('Review is terminal');
      return globalThis.fetch(request, init);
    }
    const body = init?.body;
    if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > 263_168) {
      throw new Error('Invalid queued publication body');
    }
    let operationId: string | undefined;
    const admitted = await this.#updateActive(this.#state?.runId, state => {
      if (!state.queued?.admitted) throw new Error('Queued review has not been admitted');
      const pending = state.queued.operations.find(operation => operation.state === 'prepared');
      if (!pending) throw new Error('Queued publication has no durable authorization');
      const base = `/repos/${encodeURIComponent(state.input.owner)}/${encodeURIComponent(state.input.repo)}`;
      const expectedPath =
        pending.kind === 'review'
          ? `${base}/pulls/${state.input.pullNumber}/reviews`
          : pending.commentId === undefined
            ? `${base}/issues/${state.input.pullNumber}/comments`
            : `${base}/issues/comments/${pending.commentId}`;
      if (
        url.pathname !== expectedPath ||
        url.search ||
        method !== (pending.commentId === undefined ? 'POST' : 'PATCH')
      ) {
        throw new Error('Queued publication escaped its authorized target');
      }
      operationId = pending.id;
      return {
        ...state,
        queued: {
          ...state.queued,
          operations: state.queued.operations.map(operation =>
            operation.id === pending.id
              ? { ...operation, state: 'sent' as const, requestBody: body }
              : operation
          ),
        },
      };
    });
    if (!admitted || !operationId) throw new Error('Review is terminal; refusing provider write');
    const response = await globalThis.fetch(request, init);
    if (response.ok) {
      try {
        const result = z
          .object({ id: z.number().int().positive().safe() })
          .parse(await readQueuedJson(response.clone(), MAX_GITHUB_RESPONSE_BYTES));
        await this.#updateState(state => {
          if (!state?.queued) return state;
          return {
            ...state,
            queued: {
              ...state.queued,
              operations: state.queued.operations.map(operation =>
                operation.id === operationId &&
                operation.state === 'sent' &&
                (operation.commentId === undefined || operation.commentId === result.id)
                  ? { ...operation, responseId: result.id }
                  : operation
              ),
            },
          };
        });
      } catch {
        console.error('[queued-review] provider response remains unresolved', {
          runId: admitted.runId,
        });
      }
    }
    return response;
  }

  async #reconcileQueuedPublication(state: RunState): Promise<void> {
    const queued = state.queued;
    const operation = queued?.operations.find(operation => operation.state === 'sent');
    if (!queued || !operation?.requestBody) return;
    if (
      (operation.kind === 'review' || operation.commentId !== undefined) &&
      operation.responseId === undefined
    )
      return;
    const key =
      operation.kind === 'review'
        ? 'reviewReconciliationAttempts'
        : 'summaryReconciliationAttempts';
    if ((state[key] ?? 0) >= MAX_RECONCILIATION_ATTEMPTS) return;
    const reconciliationUserId = await requestQueuedReconciliation(queued, operation.id);
    if (!reconciliationUserId) return;
    const credentials = await resolveGithubCredentials({
      input: { ...state.input, userId: reconciliationUserId },
      service: this.env.GIT_TOKEN_SERVICE,
      allowDirectToken: false,
    });
    const signal = AbortSignal.timeout(10_000);
    const readonlyFetch: typeof globalThis.fetch = (request, init) => {
      if ((init?.method ?? 'GET') !== 'GET') throw new Error('Reconciliation cannot write');
      return globalThis.fetch(request, { ...init, signal });
    };
    const tools = createGithubTools({
      runId: state.runId,
      input: state.input,
      ...queued.identity.snapshot,
      token: credentials.token,
      apiUrl: this.env.GITHUB_API_URL,
      fetchImpl: readonlyFetch,
      publicationState: state,
      queuedPublication: state.queuedPublication,
      onReconciliationStarted: async () => {
        await this.#updateState(current => {
          if (
            !current?.queued ||
            !current.queued.operations.some(
              item => item.id === operation.id && item.state === 'sent'
            )
          ) {
            throw new Error('Publication is no longer unresolved');
          }
          if ((current[key] ?? 0) >= MAX_RECONCILIATION_ATTEMPTS)
            throw new Error('Reconciliation budget exhausted');
          return { ...current, [key]: (current[key] ?? 0) + 1 };
        });
      },
      onPublicationStarted: async () => {
        throw new Error('Reconciliation cannot authorize writes');
      },
      onPublished: async event => {
        if (operation.responseId !== undefined && event?.id !== operation.responseId) {
          throw new Error('Reconciliation did not identify the exact provider operation');
        }
        await this.#markPublished(event);
      },
    });
    const body: unknown = JSON.parse(operation.requestBody);
    if (operation.kind === 'summary') {
      const payload = {
        ...z.object({ body: z.string() }).strict().parse(body),
        gateResult: state.gateResult,
      };
      const summary = tools.upsert_summary as Tool<typeof payload>;
      if (!summary.execute) throw new Error('Summary reconciliation tool unavailable');
      await summary.execute(payload, {
        toolCallId: operation.id,
        messages: [],
        abortSignal: signal,
        context: {},
      });
    } else {
      const payload = z
        .object({
          commit_id: z.literal(queued.identity.snapshot.headSha),
          event: z.literal('COMMENT'),
          body: z.literal(''),
          comments: z
            .array(
              z
                .object({
                  path: z.string(),
                  line: z.number(),
                  side: z.literal('RIGHT'),
                  body: z.string(),
                })
                .strict()
            )
            .max(100),
        })
        .strict()
        .parse(body);
      const review = tools.submit_review as Tool<Pick<typeof payload, 'comments'>>;
      if (!review.execute) throw new Error('Review reconciliation tool unavailable');
      await review.execute(
        { comments: payload.comments },
        { toolCallId: operation.id, messages: [], abortSignal: signal, context: {} }
      );
    }
  }

  async #markPublicationStarted(
    kind: 'review' | 'summary',
    details?: GithubPublicationDetails
  ): Promise<void> {
    if (!details?.fingerprint) throw new Error('Publication fingerprint is required');
    const operationId = crypto.randomUUID();
    const initial = await this.#loadState();
    if (
      initial?.queued &&
      !(await requestQueuedAuthority(initial.queued, 'publish', operationId))
    ) {
      throw new Error('Canonical queued review authority denied publication');
    }
    const admitted = await this.#updateActive(this.#state?.runId, state => {
      if (
        !state.executionDeadlineAt ||
        !state.credentialsExpireAt ||
        !state.input.kiloToken ||
        !state.githubToken
      ) {
        throw new Error('Review is not authorized to publish');
      }
      if (state.queued && (!state.queued.admitted || state.reviewPending || state.summaryPending)) {
        throw new Error('Queued publication is not admitted or another operation is unresolved');
      }
      if (isDryRun(state.input.dryRun)) throw new Error('Dry-run reviews cannot publish');
      if (state.analysisOutcome?.contextIncompleteReasons?.length) {
        throw new Error('Required review context is incomplete; refusing publication');
      }
      if (state.analysisOutcome?.incompleteTaskIds?.length) {
        throw new Error(INCOMPLETE_TASKS_ERROR);
      }
      const proposal = kind === 'review' ? state.reviewProposal : state.summaryProposal;
      if (
        !proposal?.publishable ||
        proposal.fingerprint !== details.fingerprint ||
        (kind === 'summary' && (!details.bodyHash || details.bodyHash !== proposal.bodyHash))
      ) {
        throw new Error('Publication does not match a validated publishable proposal');
      }
      const attempts =
        kind === 'review'
          ? (state.reviewPublicationAttempts ?? 0)
          : (state.summaryPublicationAttempts ?? 0);
      if (attempts >= MAX_PUBLICATION_ATTEMPTS)
        throw new Error('Publication retry budget exhausted');
      if (
        kind === 'review'
          ? state.reviewPending || state.reviewFingerprint
          : state.summaryPending || state.summaryFingerprint
      ) {
        throw new Error('Publication is already pending or confirmed; refusing another write');
      }
      let summaryContent = state.summaryContent;
      let gateResult = state.gateResult;
      if (state.queued && kind === 'summary') {
        summaryContent = IsolateReviewSummaryContentSchema.parse(details.summary?.content);
        gateResult = z.enum(['pass', 'fail']).optional().parse(details.summary?.gateResult);
        if (
          createHash('sha256').update(summaryContent.body).digest('hex') !==
            summaryContent.bodyHash ||
          (state.queuedPublication?.gateThreshold !== 'off' && gateResult === undefined)
        )
          throw new Error('Queued publication requires validated summary content and gate result');
      }
      return {
        ...state,
        publicationOutcome: { ...publicationOutcome(state), [kind]: 'pending' },
        ...(state.queued
          ? {
              queued: {
                ...state.queued,
                operations: [
                  ...state.queued.operations,
                  {
                    id: operationId,
                    kind,
                    fingerprint: details.fingerprint,
                    commentId: details.commentId,
                    bodyHash: details.bodyHash,
                    state: 'prepared' as const,
                  },
                ],
              },
            }
          : {}),
        ...(kind === 'review'
          ? {
              reviewPending: true,
              reviewPendingFingerprint: details.fingerprint,
              reviewPublicationAttempts: attempts + 1,
            }
          : {
              summaryPending: true,
              summaryContent,
              gateResult,
              summaryPublicationAttempts: attempts + 1,
              summaryPendingFingerprint: details.fingerprint,
              summaryPendingCommentId: details.commentId,
              summaryPendingBodyHash: details.bodyHash,
            }),
      };
    });
    if (!admitted) throw new Error('Review is terminal; refusing publication');
  }

  async #markReconciliationStarted(kind: 'review' | 'summary'): Promise<void> {
    const initial = await this.#loadState();
    if (initial?.queued) {
      const operation = initial.queued.operations.find(
        operation => operation.kind === kind && operation.state === 'sent'
      );
      if (
        !operation ||
        ((kind === 'review' || operation.commentId !== undefined) &&
          operation.responseId === undefined) ||
        !(await requestQueuedAuthority(initial.queued, 'reconcile', operation.id))
      ) {
        throw new Error('Exact queued publication cannot be reconciled');
      }
    }
    const admitted = await this.#updateActive(this.#state?.runId, state => {
      const key =
        kind === 'review' ? 'reviewReconciliationAttempts' : 'summaryReconciliationAttempts';
      const attempts = state[key] ?? 0;
      if (
        !Number.isSafeInteger(attempts) ||
        attempts < 0 ||
        attempts >= MAX_RECONCILIATION_ATTEMPTS
      ) {
        throw new Error('Publication reconciliation budget exhausted');
      }
      return { ...state, [key]: attempts + 1 };
    });
    if (!admitted) throw new Error('Review is terminal; refusing reconciliation');
  }

  async #markPublicationFailed(
    kind: 'review' | 'summary',
    previouslyPublished: boolean
  ): Promise<void> {
    await this.#updateState(state => {
      if (!state || isTerminal(state)) return state;
      const outcome = publicationOutcome(state);
      if (
        ['pending', 'uncertain'].includes(outcome[kind]) ||
        (outcome[kind] === 'confirmed' && !previouslyPublished)
      )
        return state;
      return { ...state, publicationOutcome: { ...outcome, [kind]: 'rejected' } };
    });
  }

  async #markPublicationRejected(kind: 'review' | 'summary'): Promise<void> {
    await this.#updateState(state =>
      state
        ? {
            ...state,
            publicationOutcome: { ...publicationOutcome(state), [kind]: 'rejected' },
            ...(state.queued
              ? {
                  queued: {
                    ...state.queued,
                    operations: state.queued.operations.map(operation =>
                      operation.kind === kind && operation.state === 'sent'
                        ? { ...operation, state: 'rejected' as const, requestBody: undefined }
                        : operation
                    ),
                  },
                }
              : {}),
            ...(kind === 'review'
              ? { reviewPending: false, reviewPendingFingerprint: undefined }
              : {
                  summaryPending: false,
                  summaryPendingFingerprint: undefined,
                  summaryPendingCommentId: undefined,
                  summaryPendingBodyHash: undefined,
                }),
          }
        : state
    );
  }

  async #markPublished(event?: {
    kind: 'review' | 'summary';
    id?: number;
    fingerprint?: string;
    bodyHash?: string;
  }): Promise<void> {
    if (!event || !Number.isSafeInteger(event.id) || (event.id ?? 0) <= 0)
      throw new Error('Confirmed publication ID is required');
    await this.#updateState(state => {
      if (!state) throw new MissingRunStateError();
      const pendingFingerprint =
        event.kind === 'review' ? state.reviewPendingFingerprint : state.summaryPendingFingerprint;
      const confirmedFingerprint =
        event.kind === 'review' ? state.reviewFingerprint : state.summaryFingerprint;
      const fingerprint = event.fingerprint ?? pendingFingerprint ?? confirmedFingerprint;
      if (
        !fingerprint ||
        (pendingFingerprint && pendingFingerprint !== fingerprint) ||
        (confirmedFingerprint && confirmedFingerprint !== fingerprint)
      ) {
        throw new Error('Publication acknowledgement does not match the authorized operation');
      }
      if (state.queued) {
        const operation = state.queued.operations.find(
          operation =>
            operation.kind === event.kind &&
            operation.fingerprint === fingerprint &&
            ['sent', 'confirmed'].includes(operation.state)
        );
        if (
          !operation ||
          (operation.responseId !== undefined && operation.responseId !== event.id) ||
          ((event.kind === 'review' || operation.commentId !== undefined) &&
            operation.responseId === undefined)
        ) {
          throw new Error('Queued acknowledgement cannot prove the exact authorized operation');
        }
      }
      const bodyHash = event.bodyHash ?? state.summaryPendingBodyHash ?? state.summaryBodyHash;
      if (event.kind === 'summary' && !bodyHash)
        throw new Error('Confirmed summary body hash is required');
      return {
        ...state,
        ...(event.kind === 'review'
          ? {
              reviewId: event.id,
              reviewFingerprint: fingerprint,
              reviewPending: false,
              reviewPendingFingerprint: undefined,
            }
          : {
              summaryCommentId: event.id,
              summaryFingerprint: fingerprint,
              summaryBodyHash: bodyHash,
              summaryPending: false,
              summaryPendingFingerprint: undefined,
              summaryPendingCommentId: undefined,
              summaryPendingBodyHash: undefined,
              summaryPublished: true,
            }),
        publicationOutcome: {
          ...publicationOutcome(state),
          [event.kind]:
            confirmedFingerprint && publicationOutcome(state)[event.kind] === 'rejected'
              ? 'rejected'
              : 'confirmed',
        },
        ...(state.queued
          ? {
              queued: {
                ...state.queued,
                operations: state.queued.operations.map(operation =>
                  operation.kind === event.kind &&
                  operation.fingerprint === fingerprint &&
                  operation.state === 'sent'
                    ? { ...operation, state: 'confirmed' as const, requestBody: undefined }
                    : operation
                ),
              },
            }
          : {}),
        published: true,
        publishedAt: state.publishedAt ?? new Date().toISOString(),
      };
    });
  }

  async #fetchInference(
    runId: string,
    sessionId: string,
    request: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const id = new Headers(init?.headers).get('x-kilo-request');
    if (!id || id.length > 256) throw new Error('Invalid inference request identity');
    const signal = init?.signal
      ? AbortSignal.any([init.signal, this.#abortController.signal])
      : this.#abortController.signal;
    let sent: Promise<{ response: Response } | { error: unknown }> | undefined;
    const active = await this.#updateState(async state => {
      if (!state || state.runId !== runId || isTerminal(state)) return state;
      const failure = deadlineFailure(state);
      if (failure) return this.#terminalState(state, failure);
      signal.throwIfAborted();
      const requestIds = state.requestIds ?? [];
      if (requestIds.includes(id)) throw new Error('Inference request identity already used');
      if (requestIds.length >= 1_000) {
        throw new Error('Inference request tracking exhausted; refusing an untracked request');
      }
      const tracked = state.queued && (state.usageRequestCounts || requestIds.length === 0);
      const unsent: RunState = {
        ...state,
        requestIds: [...requestIds, id],
        ...(tracked ? { usageRequestCounts: state.usageRequestCounts ?? {} } : {}),
      };
      const intent: RunState = {
        ...unsent,
        ...(tracked
          ? {
              usageRequestCounts: {
                ...unsent.usageRequestCounts,
                [sessionId]: (unsent.usageRequestCounts?.[sessionId] ?? 0) + 1,
              },
            }
          : {}),
      };
      await this.#persistence.put('runState', intent);
      const expired = deadlineFailure(unsent);
      if (expired) return this.#terminalState(unsent, expired);
      if (signal.aborted) return unsent;
      sent = globalThis.fetch(request, { ...init, signal }).then(
        response => ({ response }),
        (error: unknown) => ({ error })
      );
      return intent;
    });
    if (!sent) {
      if (active && isTerminal(active)) await this.#stopExecution(active);
      signal.throwIfAborted();
      throw new Error('Review is terminal; refusing inference');
    }
    const outcome = await sent;
    if ('error' in outcome) throw outcome.error;
    const response = outcome.response;
    if (active?.queued && !response.ok) {
      const reason = await readQueuedProviderFailure(response);
      const message = reason
        ? `Isolate review: ${reason}`
        : `Isolate inference request failed (${response.status})`;
      if (reason) {
        await this.#terminate(runId, {
          status: 'error',
          error: message,
          terminationReason: reason,
        });
      }
      const url = new URL(
        typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
      );
      throw new APICallError({
        message,
        url: url.origin,
        requestBodyValues: undefined,
        statusCode: response.status,
        isRetryable: reason ? false : undefined,
      });
    }
    return response;
  }

  #safeError(error: string, state: RunState): string {
    let safe = error;
    for (const secret of [state.input.kiloToken, state.input.gitToken, state.githubToken]) {
      if (secret) safe = safe.replaceAll(secret, '[redacted]');
    }
    return safe;
  }

  #modelId(): string {
    return this.#state?.input.model?.trim() || DEFAULT_MODEL;
  }

  async #lastAssistantText(): Promise<string | undefined> {
    const messages = await this.getMessages();
    const assistant = [...messages].reverse().find(message => message.role === 'assistant');
    if (!assistant) return undefined;
    const text = assistant.parts
      .filter(
        (part): part is Extract<(typeof assistant.parts)[number], { type: 'text' }> =>
          part.type === 'text'
      )
      .map(part => part.text)
      .join('');
    return text || undefined;
  }
}
