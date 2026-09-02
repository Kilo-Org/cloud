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
import { tool, type ToolSet, type UIMessage } from 'ai';
import { z } from 'zod';
import {
  createGithubClient,
  createGithubTools,
  GITHUB_TOOL_NAMES,
  MAX_HISTORY_COMMITS,
  MAX_HISTORY_REQUESTS,
  MAX_PUBLICATION_ATTEMPTS,
  resolveIncrementalComparison,
  type GithubClient,
  type GithubProposalEvent,
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

  async startReview(runId: string, input: StartReviewInput): Promise<void> {
    const existing = await this.#loadState();
    if (existing) {
      if (existing.runId !== runId) throw new Error('Run already started on this DO');
      if (!isTerminal(existing) && !existing.submissionId) await this.#scheduleClone(runId);
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
    await this.schedule(
      Math.ceil((credentialsExpireAt - now) / 1000),
      'expireCredentials',
      { runId },
      { idempotent: true }
    );
    await this.schedule(REVIEW_RETENTION_SECONDS, 'cleanupReview', { runId }, { idempotent: true });
    await this.schedule(
      new Date(Math.ceil(admissionDeadlineAt / 1000) * 1000),
      'expireReview',
      { runId, deadlineAt: admissionDeadlineAt },
      { idempotent: true }
    );
    await this.#updateState(state => {
      if (state) return state;
      if (credentialsExpireAt <= Date.now()) throw new Error(CREDENTIAL_EXPIRATION_ERROR);
      if (admissionDeadlineAt <= Date.now()) throw new Error('Review admission deadline exceeded');
      return {
        runId,
        status: 'pending',
        input: normalizedInput,
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
    await this.#scheduleClone(runId);
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
      const { sizeKiB } = await admitRepository(
        github,
        state.input.owner,
        state.input.repo,
        signal
      );
      if (!(await this.#updateActive(runId, current => ({ ...current, githubSizeKiB: sizeKiB }))))
        return;
      console.log('[clone] admitted', { runId, githubSizeKiB: sizeKiB });
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
      } else if (!isTerminal(state)) {
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
    const state = await this.#loadState();
    if (!state || state.input.userId !== userId) return null;
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
      onRequestId: id => this.#recordRequestId(id),
      fetchImpl: async (request, init) => {
        const active = await this.#updateActive(state.runId, current => current);
        if (!active) throw new Error('Review is terminal; refusing inference');
        const signal = init?.signal
          ? AbortSignal.any([init.signal, this.#abortController.signal])
          : this.#abortController.signal;
        signal.throwIfAborted();
        return globalThis.fetch(request, { ...init, signal });
      },
    });
  }

  override getSystemPrompt(): string {
    return buildSystemPrompt({
      model: this.#modelId(),
      date: this.#state?.createdAt?.slice(0, 10),
      prepared: Boolean(this.#state?.input.preparation),
    });
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
    const instructions = this.getSystemPrompt();
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
      apiUrl: this.env.GITHUB_API_URL,
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
    const previous = await this.#getPreviousReview(state);
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

  async #getPreviousReview(state: RunState): Promise<ReviewStatusResponse | null> {
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
    const previous = await this.#getPreviousReview(state);
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
    update: (state: RunState | undefined) => RunState | undefined
  ): Promise<RunState | undefined> {
    const mutation = this.#stateMutation.then(async () => {
      const state = await this.#persistence.get<RunState>('runState');
      const next = update(state);
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
      return this.#terminalState(next, {
        status: submission.status === 'completed' ? 'completed' : 'error',
        error: submissionError(submission.error),
        terminationReason:
          submission.status === 'completed'
            ? 'completed'
            : submission.status === 'aborted'
              ? 'cancelled'
              : 'submission_error',
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
    const { kind, summaryContent, ...raw } = event;
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
      const outcome = publicationOutcome(current);
      return {
        ...current,
        ...(kind === 'review'
          ? { reviewProposal: proposal }
          : { summaryProposal: proposal, summaryContent: content }),
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

  async #markPublicationStarted(
    kind: 'review' | 'summary',
    details?: { fingerprint: string; commentId?: number; bodyHash?: string }
  ): Promise<void> {
    if (!details?.fingerprint) throw new Error('Publication fingerprint is required');
    const admitted = await this.#updateActive(this.#state?.runId, state => {
      if (
        !state.executionDeadlineAt ||
        !state.credentialsExpireAt ||
        !state.input.kiloToken ||
        !state.githubToken
      ) {
        throw new Error('Review is not authorized to publish');
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
      return {
        ...state,
        publicationOutcome: { ...publicationOutcome(state), [kind]: 'pending' },
        ...(kind === 'review'
          ? {
              reviewPending: true,
              reviewPendingFingerprint: details.fingerprint,
              reviewPublicationAttempts: attempts + 1,
            }
          : {
              summaryPending: true,
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
        published: true,
        publishedAt: state.publishedAt ?? new Date().toISOString(),
      };
    });
  }

  async #recordRequestId(id: string): Promise<void> {
    if (!id || id.length > 256) throw new Error('Invalid inference request identity');
    const active = await this.#updateActive(this.#state?.runId, state => {
      const requestIds = state.requestIds ?? [];
      if (requestIds.includes(id)) return state;
      if (requestIds.length >= 1_000) {
        throw new Error('Inference request tracking exhausted; refusing an untracked request');
      }
      return { ...state, requestIds: [...requestIds, id] };
    });
    if (!active) throw new Error('Review is terminal; refusing inference');
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
