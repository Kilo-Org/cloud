import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { security_audit_log } from '@kilocode/db/schema';
import { SecurityAuditLogAction } from '@kilocode/db/schema-types';
import { z } from 'zod';
import {
  getActiveAnalysisAttemptToken,
  getAnalysisActorById,
  getSecurityFindingById,
} from './db/queries.js';
import { transitionAnalysisCallbackLifecycle } from './analysis-start-lifecycle.js';
import { generateApiToken } from './token.js';
import { extractSandboxAnalysis as runSandboxExtraction } from './extraction.js';
import { fetchLatestAssistantText as fetchSessionAssistantText } from './session-result.js';
import { maybeAutoDismissCompletedAnalysis } from './auto-dismiss.js';
import { trackSecurityAnalysisCompleted } from './posthog.js';
import type {
  AutoAnalysisFailureCode,
  SecurityFindingAnalysis,
  SecurityFindingSandboxAnalysis,
} from './types.js';

export const SecurityAnalysisCallbackPayloadSchema = z.object({
  sessionId: z.string().min(1),
  cloudAgentSessionId: z.string().min(1),
  executionId: z.string().min(1),
  status: z.enum(['completed', 'failed', 'interrupted']),
  errorMessage: z.string().optional(),
  kiloSessionId: z.string().optional(),
  lastSeenBranch: z.string().optional(),
  lastAssistantMessageText: z.string().optional(),
});

export type SecurityAnalysisCallbackPayload = z.infer<typeof SecurityAnalysisCallbackPayloadSchema>;

export const SecurityAnalysisCallbackMessageSchema = z.object({
  findingId: z.string().uuid(),
  attemptToken: z.string().min(1).optional(),
  payload: SecurityAnalysisCallbackPayloadSchema,
});

export type SecurityAnalysisCallbackMessage = z.infer<typeof SecurityAnalysisCallbackMessageSchema>;

type CallbackFindingState = Pick<
  NonNullable<Awaited<ReturnType<typeof getSecurityFindingById>>>,
  'session_id' | 'cli_session_id' | 'ignored_reason' | 'analysis_status'
>;

export type CallbackDisposition =
  | 'process'
  | 'stale-session'
  | 'stale-attempt'
  | 'superseded'
  | 'already-terminal';

export function classifyAnalysisCallback(
  finding: CallbackFindingState,
  payload: SecurityAnalysisCallbackPayload,
  attempt?: { expected: string; active: string | null | undefined }
): CallbackDisposition {
  if (
    attempt &&
    attempt.active !== attempt.expected &&
    (finding.analysis_status === 'pending' || finding.analysis_status === 'running')
  ) {
    return 'stale-attempt';
  }
  const sessionMismatch =
    (payload.cloudAgentSessionId &&
      finding.session_id &&
      payload.cloudAgentSessionId !== finding.session_id) ||
    (payload.kiloSessionId &&
      finding.cli_session_id &&
      payload.kiloSessionId !== finding.cli_session_id);
  if (sessionMismatch) return 'stale-session';
  if (finding.ignored_reason?.startsWith('superseded:')) return 'superseded';
  if (finding.analysis_status === 'completed' || finding.analysis_status === 'failed') {
    return 'already-terminal';
  }
  return 'process';
}

export function mapAnalysisCallbackFailure(params: {
  status: 'failed' | 'interrupted';
  errorMessage?: string;
}): { errorMessage: string; failureCode: AutoAnalysisFailureCode } {
  if (params.status === 'interrupted') {
    return {
      errorMessage: `Analysis interrupted: ${params.errorMessage ?? 'unknown reason'}`,
      failureCode: 'STATE_GUARD_REJECTED',
    };
  }

  const errorMessage = params.errorMessage ?? 'Analysis failed';
  const normalized = errorMessage.toLowerCase();
  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return { errorMessage, failureCode: 'NETWORK_TIMEOUT' };
  }
  if (
    normalized.includes('502') ||
    normalized.includes('503') ||
    normalized.includes('504') ||
    normalized.includes('upstream') ||
    normalized.includes('5xx')
  ) {
    return { errorMessage, failureCode: 'UPSTREAM_5XX' };
  }
  return { errorMessage, failureCode: 'START_CALL_AMBIGUOUS' };
}

type ExtractSandboxAnalysis = (params: {
  finding: NonNullable<Awaited<ReturnType<typeof getSecurityFindingById>>>;
  rawMarkdown: string;
}) => Promise<SecurityFindingSandboxAnalysis>;

type MaybeAutoDismissAnalysis = (params: {
  findingId: string;
  analysis: SecurityFindingAnalysis;
  finding: NonNullable<Awaited<ReturnType<typeof getSecurityFindingById>>>;
}) => Promise<void>;

type TrackCompletedAnalysis = (params: {
  findingId: string;
  analysis: SecurityFindingAnalysis;
  finding: NonNullable<Awaited<ReturnType<typeof getSecurityFindingById>>>;
}) => Promise<void>;

const COMPLETED_CALLBACK_MAX_ATTEMPTS = 3;
const COMPLETED_CALLBACK_RETRY_DELAY_MS = 5000;

type FetchLatestAssistantText = (params: { kiloSessionId: string }) => Promise<string | null>;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function resolveCompletedCallbackMarkdown(params: {
  payload: SecurityAnalysisCallbackPayload;
  fetchLatestAssistantText?: FetchLatestAssistantText;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string | null> {
  const callbackText = params.payload.lastAssistantMessageText?.trim();
  if (callbackText) return callbackText;
  if (!params.payload.kiloSessionId || !params.fetchLatestAssistantText) return null;

  const delay = params.sleep ?? sleep;
  for (let attempt = 1; attempt <= COMPLETED_CALLBACK_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await delay(COMPLETED_CALLBACK_RETRY_DELAY_MS);
    const snapshotText = await params.fetchLatestAssistantText({
      kiloSessionId: params.payload.kiloSessionId,
    });
    const normalized = snapshotText?.trim();
    if (normalized) return normalized;
  }
  return null;
}

export async function finalizeCompletedAnalysisCallback(params: {
  db: WorkerDb;
  findingId: string;
  attemptToken?: string;
  payload: SecurityAnalysisCallbackPayload;
  extractSandboxAnalysis: ExtractSandboxAnalysis;
  maybeAutoDismissAnalysis?: MaybeAutoDismissAnalysis;
  trackCompletedAnalysis?: TrackCompletedAnalysis;
  fetchLatestAssistantText?: FetchLatestAssistantText;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  status: 'missing' | CallbackDisposition | 'completed-finalized' | 'result-missing';
}> {
  const finding = await getSecurityFindingById(params.db, params.findingId);
  if (!finding) return { status: 'missing' };
  const activeAttemptToken = await getActiveAnalysisAttemptToken(params.db, params.findingId);
  const attemptToken = params.attemptToken ?? activeAttemptToken ?? undefined;
  if (
    !attemptToken &&
    (finding.analysis_status === 'pending' || finding.analysis_status === 'running')
  ) {
    return { status: 'stale-attempt' };
  }

  const disposition = attemptToken
    ? classifyAnalysisCallback(finding, params.payload, {
        expected: attemptToken,
        active: activeAttemptToken,
      })
    : classifyAnalysisCallback(finding, params.payload);
  if (disposition === 'stale-session') return { status: disposition };
  if (disposition === 'stale-attempt') return { status: disposition };
  if (disposition === 'already-terminal') {
    const findingStatus = finding.analysis_status === 'failed' ? 'failed' : 'completed';
    if (!attemptToken) return { status: disposition };
    await transitionAnalysisCallbackLifecycle(params.db, {
      findingId: params.findingId,
      attemptToken,
      outcome: {
        type: 'already-terminal',
        findingStatus,
        failureCode: findingStatus === 'failed' ? 'START_CALL_AMBIGUOUS' : null,
        errorMessage:
          findingStatus === 'failed'
            ? 'Analysis completed but callback result text was missing'
            : null,
      },
    });
    return { status: disposition };
  }
  if (disposition === 'superseded') {
    if (!attemptToken) return { status: disposition };
    await transitionAnalysisCallbackLifecycle(params.db, {
      findingId: params.findingId,
      attemptToken,
      outcome: { type: 'superseded' },
    });
    return { status: disposition };
  }
  if (!attemptToken) return { status: 'stale-attempt' };

  const rawMarkdown = await resolveCompletedCallbackMarkdown({
    payload: params.payload,
    fetchLatestAssistantText: params.fetchLatestAssistantText,
    sleep: params.sleep,
  });
  if (!rawMarkdown) {
    const errorMessage = 'Analysis completed but callback result text was missing';
    const lifecycleTransition = await transitionAnalysisCallbackLifecycle(params.db, {
      findingId: params.findingId,
      attemptToken,
      outcome: {
        type: 'failed',
        errorMessage,
        failureCode: 'START_CALL_AMBIGUOUS',
      },
    });
    if (lifecycleTransition.status === 'stale-attempt') return { status: 'stale-attempt' };
    if (lifecycleTransition.status === 'superseded') return { status: 'superseded' };
    return { status: 'result-missing' };
  }

  const sandboxAnalysis = await params.extractSandboxAnalysis({ finding, rawMarkdown });
  const priorAnalysis = finding.analysis ?? undefined;
  const completedAnalysis: SecurityFindingAnalysis = {
    ...priorAnalysis,
    sandboxAnalysis,
    rawMarkdown,
    analyzedAt: new Date().toISOString(),
    modelUsed:
      sandboxAnalysis.modelUsed ?? priorAnalysis?.analysisModel ?? priorAnalysis?.modelUsed,
    analysisModel: priorAnalysis?.analysisModel,
    triageModel: priorAnalysis?.triageModel,
    triggeredByUserId: priorAnalysis?.triggeredByUserId,
    correlationId: priorAnalysis?.correlationId,
  };

  const lifecycleTransition = await transitionAnalysisCallbackLifecycle(params.db, {
    findingId: params.findingId,
    attemptToken,
    outcome: {
      type: 'completed',
      analysis: completedAnalysis,
    },
  });
  if (lifecycleTransition.status === 'superseded') return { status: 'superseded' };
  if (lifecycleTransition.status === 'stale-attempt') return { status: 'stale-attempt' };
  await params.db.insert(security_audit_log).values({
    owned_by_organization_id: finding.owned_by_organization_id,
    owned_by_user_id: finding.owned_by_user_id,
    actor_id: null,
    actor_email: null,
    actor_name: null,
    action: SecurityAuditLogAction.FindingAnalysisCompleted,
    resource_type: 'security_finding',
    resource_id: params.findingId,
    metadata: {
      source: 'system',
      model: completedAnalysis.modelUsed,
      triageModel: completedAnalysis.triageModel,
      analysisModel: completedAnalysis.analysisModel,
      correlationId: completedAnalysis.correlationId,
      triggeredByUserId: completedAnalysis.triggeredByUserId,
    },
  });
  await params.maybeAutoDismissAnalysis?.({
    findingId: params.findingId,
    analysis: completedAnalysis,
    finding,
  });
  await params.trackCompletedAnalysis?.({
    findingId: params.findingId,
    analysis: completedAnalysis,
    finding,
  });
  return { status: 'completed-finalized' };
}

export async function finalizeFailedAnalysisCallback(params: {
  db: WorkerDb;
  findingId: string;
  attemptToken?: string;
  payload: SecurityAnalysisCallbackPayload;
}): Promise<{ status: 'missing' | CallbackDisposition | 'failed-finalized' }> {
  const finding = await getSecurityFindingById(params.db, params.findingId);
  if (!finding) return { status: 'missing' };
  const activeAttemptToken = await getActiveAnalysisAttemptToken(params.db, params.findingId);
  const attemptToken = params.attemptToken ?? activeAttemptToken ?? undefined;
  if (
    !attemptToken &&
    (finding.analysis_status === 'pending' || finding.analysis_status === 'running')
  ) {
    return { status: 'stale-attempt' };
  }

  const disposition = attemptToken
    ? classifyAnalysisCallback(finding, params.payload, {
        expected: attemptToken,
        active: activeAttemptToken,
      })
    : classifyAnalysisCallback(finding, params.payload);
  if (disposition === 'stale-session') return { status: disposition };
  if (disposition === 'stale-attempt') return { status: disposition };
  if (disposition === 'already-terminal') {
    const findingStatus = finding.analysis_status === 'completed' ? 'completed' : 'failed';
    const failure =
      findingStatus === 'failed'
        ? mapAnalysisCallbackFailure({
            status: params.payload.status === 'interrupted' ? 'interrupted' : 'failed',
            errorMessage: params.payload.errorMessage,
          })
        : null;
    if (!attemptToken) return { status: disposition };
    await transitionAnalysisCallbackLifecycle(params.db, {
      findingId: params.findingId,
      attemptToken,
      outcome: {
        type: 'already-terminal',
        findingStatus,
        failureCode: failure?.failureCode ?? null,
        errorMessage: failure?.errorMessage ?? null,
      },
    });
    return { status: disposition };
  }
  if (disposition === 'superseded') {
    if (!attemptToken) return { status: disposition };
    await transitionAnalysisCallbackLifecycle(params.db, {
      findingId: params.findingId,
      attemptToken,
      outcome: { type: 'superseded' },
    });
    return { status: disposition };
  }
  if (!attemptToken) return { status: 'stale-attempt' };

  const failure = mapAnalysisCallbackFailure({
    status: params.payload.status === 'interrupted' ? 'interrupted' : 'failed',
    errorMessage: params.payload.errorMessage,
  });
  const lifecycleTransition = await transitionAnalysisCallbackLifecycle(params.db, {
    findingId: params.findingId,
    attemptToken,
    outcome: {
      type: 'failed',
      errorMessage: failure.errorMessage,
      failureCode: failure.failureCode,
    },
  });
  if (lifecycleTransition.status === 'superseded') return { status: 'superseded' };
  if (lifecycleTransition.status === 'stale-attempt') return { status: 'stale-attempt' };
  return { status: 'failed-finalized' };
}

export async function finalizeFailedAnalysisCallbackFromEnv(params: {
  env: CloudflareEnv;
  findingId: string;
  attemptToken?: string;
  payload: SecurityAnalysisCallbackPayload;
}): Promise<{ status: 'missing' | CallbackDisposition | 'failed-finalized' }> {
  const db = getWorkerDb(params.env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
  return finalizeFailedAnalysisCallback({
    db,
    findingId: params.findingId,
    attemptToken: params.attemptToken,
    payload: params.payload,
  });
}

export async function finalizeCompletedAnalysisCallbackFromEnv(params: {
  env: CloudflareEnv;
  findingId: string;
  attemptToken?: string;
  payload: SecurityAnalysisCallbackPayload;
}): Promise<{
  status: 'missing' | CallbackDisposition | 'completed-finalized' | 'result-missing';
}> {
  const db = getWorkerDb(params.env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
  return finalizeCompletedAnalysisCallback({
    db,
    findingId: params.findingId,
    attemptToken: params.attemptToken,
    payload: params.payload,
    fetchLatestAssistantText: async ({ kiloSessionId }) => {
      const finding = await getSecurityFindingById(db, params.findingId);
      const userId = finding?.analysis?.triggeredByUserId;
      if (!userId) return null;
      const nextAuthSecret = await params.env.NEXTAUTH_SECRET.get();
      return fetchSessionAssistantText({
        sessionId: kiloSessionId,
        userId,
        sessionIngestWorkerUrl: params.env.SESSION_INGEST_WORKER_URL,
        nextAuthSecret,
      });
    },
    extractSandboxAnalysis: async ({ finding, rawMarkdown }) => {
      const triggeredByUserId = finding.analysis?.triggeredByUserId;
      if (!triggeredByUserId) {
        throw new Error('Cannot extract completed security analysis without triggeredByUserId');
      }
      const actor = await getAnalysisActorById(db, triggeredByUserId);
      if (!actor) {
        throw new Error(`Analysis actor ${triggeredByUserId} is unavailable`);
      }
      const [nextAuthSecret] = await Promise.all([params.env.NEXTAUTH_SECRET.get()]);
      const authToken = await generateApiToken(actor, nextAuthSecret, params.env.ENVIRONMENT);
      return runSandboxExtraction({
        finding,
        rawMarkdown,
        authToken,
        model:
          finding.analysis?.analysisModel ??
          finding.analysis?.modelUsed ??
          'anthropic/claude-opus-4.6',
        backendBaseUrl: params.env.KILOCODE_BACKEND_BASE_URL,
        organizationId: finding.owned_by_organization_id ?? undefined,
      });
    },
    maybeAutoDismissAnalysis: async ({ findingId, finding, analysis }) => {
      await maybeAutoDismissCompletedAnalysis({
        db,
        env: params.env,
        findingId,
        finding,
        analysis,
      });
    },
    trackCompletedAnalysis: async ({ findingId, finding, analysis }) => {
      await trackSecurityAnalysisCompleted({
        env: params.env,
        findingId,
        finding,
        analysis,
      });
    },
  });
}

export async function finalizeAnalysisCallbackFromEnv(params: {
  env: CloudflareEnv;
  findingId: string;
  attemptToken?: string;
  payload: SecurityAnalysisCallbackPayload;
}): Promise<{
  status:
    | 'missing'
    | CallbackDisposition
    | 'failed-finalized'
    | 'completed-finalized'
    | 'result-missing';
}> {
  return params.payload.status === 'completed'
    ? finalizeCompletedAnalysisCallbackFromEnv(params)
    : finalizeFailedAnalysisCallbackFromEnv(params);
}

export async function consumeAnalysisCallbackBatch(
  batch: MessageBatch<unknown>,
  env: CloudflareEnv,
  finalizeCallback = finalizeAnalysisCallbackFromEnv
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = SecurityAnalysisCallbackMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      message.ack();
      continue;
    }
    try {
      await finalizeCallback({
        env,
        findingId: parsed.data.findingId,
        attemptToken: parsed.data.attemptToken,
        payload: parsed.data.payload,
      });
      message.ack();
    } catch (error) {
      console.error('Security analysis callback finalization failed', {
        findingId: parsed.data.findingId,
        error: error instanceof Error ? error.message : String(error),
      });
      message.retry();
    }
  }
}
