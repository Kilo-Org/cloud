import type { NextRequest } from 'next/server';
import { after, NextResponse } from 'next/server';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { getSecurityFindingById } from '@/lib/security-agent/db/security-findings';
import {
  updateAnalysisStatus,
  transitionAutoAnalysisQueueFromCallback,
  type AutoAnalysisFailureCode,
} from '@/lib/security-agent/db/security-analysis';
import {
  finalizeAnalysis,
  extractLastAssistantMessage,
} from '@/lib/security-agent/services/analysis-service';
import { fetchSessionSnapshot } from '@/lib/session-ingest-client';
import { trackSecurityAgentAnalysisCompleted } from '@/lib/security-agent/posthog-tracking';
import { generateApiToken } from '@/lib/tokens';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { logExceptInTest, sentryLogger } from '@/lib/utils.server';
import type { SecurityFindingAnalysis, SecurityReviewOwner } from '@/lib/security-agent/core/types';
import {
  logSecurityAudit,
  SecurityAuditLogAction,
} from '@/lib/security-agent/services/audit-log-service';
import {
  DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
  DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
} from '@/lib/security-agent/core/constants';

const log = sentryLogger('security-agent:callback', 'info');
const warn = sentryLogger('security-agent:callback', 'warning');
const logError = sentryLogger('security-agent:callback', 'error');

type ExecutionCallbackPayload = {
  sessionId: string;
  cloudAgentSessionId: string;
  executionId: string;
  status: 'completed' | 'failed' | 'interrupted';
  errorMessage?: string;
  kiloSessionId?: string;
  lastSeenBranch?: string;
};

function mapCallbackFailure(params: { status: 'failed' | 'interrupted'; errorMessage?: string }): {
  errorMessage: string;
  failureCode: AutoAnalysisFailureCode;
} {
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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ findingId: string }> }
) {
  try {
    const secret = req.headers.get('X-Internal-Secret');
    if (!INTERNAL_API_SECRET || secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { findingId } = await params;
    const payload: ExecutionCallbackPayload = await req.json();

    if (!payload.status) {
      return NextResponse.json({ error: 'Missing required field: status' }, { status: 400 });
    }

    log('Received callback', {
      findingId,
      status: payload.status,
      cloudAgentSessionId: payload.cloudAgentSessionId,
      kiloSessionId: payload.kiloSessionId,
      hasError: !!payload.errorMessage,
    });

    // Look up the finding to get metadata stored during startSecurityAnalysis
    const finding = await getSecurityFindingById(findingId);
    if (!finding) {
      logError('Finding not found for callback', { findingId });
      return NextResponse.json({ error: 'Finding not found' }, { status: 404 });
    }

    const sessionMismatch =
      (payload.cloudAgentSessionId &&
        finding.session_id &&
        payload.cloudAgentSessionId !== finding.session_id) ||
      (payload.kiloSessionId &&
        finding.cli_session_id &&
        payload.kiloSessionId !== finding.cli_session_id);

    if (sessionMismatch) {
      warn('Ignoring stale auto-analysis callback due to session mismatch', {
        findingId,
        findingSessionId: finding.session_id,
        findingCliSessionId: finding.cli_session_id,
        callbackCloudAgentSessionId: payload.cloudAgentSessionId,
        callbackKiloSessionId: payload.kiloSessionId,
      });
      captureMessage('Auto-analysis callback session mismatch', {
        level: 'warning',
        tags: { source: 'security-analysis-callback-api' },
        extra: {
          findingId,
          findingSessionId: finding.session_id,
          findingCliSessionId: finding.cli_session_id,
          callbackCloudAgentSessionId: payload.cloudAgentSessionId,
          callbackKiloSessionId: payload.kiloSessionId,
        },
      });
      return NextResponse.json({ success: true, message: 'Stale callback ignored' });
    }

    // Skip if already in a terminal state
    if (finding.analysis_status === 'completed' || finding.analysis_status === 'failed') {
      log('Finding already in terminal state, skipping callback', {
        findingId,
        currentStatus: finding.analysis_status,
        callbackStatus: payload.status,
      });
      return NextResponse.json({
        success: true,
        message: 'Finding already in terminal state',
        currentStatus: finding.analysis_status,
      });
    }

    after(async () => {
      try {
        if (payload.status === 'completed') {
          await handleAnalysisCompleted(findingId, payload, finding);
        } else if (payload.status === 'failed' || payload.status === 'interrupted') {
          await handleAnalysisFailed(findingId, payload, finding);
        } else {
          const unknownStatus = payload.status as string;
          logError('Unknown callback status received, marking as failed', {
            findingId,
            status: unknownStatus,
          });
          await updateAnalysisStatus(findingId, 'failed', {
            error: `Unknown callback status: ${unknownStatus}`,
          });
          await transitionAutoAnalysisQueueFromCallback({
            findingId,
            toStatus: 'failed',
            failureCode: 'STATE_GUARD_REJECTED',
            errorMessage: `Unknown callback status: ${unknownStatus}`,
          });
        }
      } catch (error) {
        logError('Error processing security analysis callback', { error });
        captureException(error, {
          tags: { source: 'security-analysis-callback-api' },
        });
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logError('Error processing security analysis callback', { error });
    captureException(error, {
      tags: { source: 'security-analysis-callback-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to process callback',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

/** Read stored analysis metadata, filling in defaults for missing fields. */
function readAnalysisContext(analysis: SecurityFindingAnalysis | null | undefined): {
  correlationId: string;
  modelUsed: string;
  triageModel: string;
  analysisModel: string;
  triggeredByUserId: string;
} {
  const analysisModel =
    analysis?.analysisModel ?? analysis?.modelUsed ?? DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL;
  const triageModel =
    analysis?.triageModel ?? analysis?.modelUsed ?? DEFAULT_SECURITY_AGENT_TRIAGE_MODEL;
  return {
    correlationId: analysis?.correlationId ?? '',
    modelUsed: analysis?.modelUsed ?? analysisModel,
    triageModel,
    analysisModel,
    triggeredByUserId: analysis?.triggeredByUserId ?? '',
  };
}

async function handleAnalysisCompleted(
  findingId: string,
  payload: ExecutionCallbackPayload,
  finding: Awaited<ReturnType<typeof getSecurityFindingById>> & {}
) {
  const {
    correlationId,
    modelUsed: model,
    triageModel,
    analysisModel,
    triggeredByUserId,
  } = readAnalysisContext(finding.analysis);
  const organizationId = finding.owned_by_organization_id ?? undefined;
  const owner: SecurityReviewOwner = organizationId
    ? { organizationId }
    : { userId: finding.owned_by_user_id ?? triggeredByUserId };

  if (!triggeredByUserId) {
    logError('Missing triggeredByUserId in analysis context', { findingId, correlationId });
    await updateAnalysisStatus(findingId, 'failed', {
      error: 'Cannot process callback — triggeredByUserId missing from analysis context',
    });
    await transitionAutoAnalysisQueueFromCallback({
      findingId,
      toStatus: 'failed',
      failureCode: 'STATE_GUARD_REJECTED',
      errorMessage: 'Cannot process callback — triggeredByUserId missing from analysis context',
    });
    return;
  }

  const kiloSessionId = payload.kiloSessionId;
  if (!kiloSessionId) {
    logError('Callback missing kiloSessionId', { findingId, correlationId });
    await updateAnalysisStatus(findingId, 'failed', {
      error: 'Callback missing kiloSessionId — cannot retrieve analysis result',
    });
    await transitionAutoAnalysisQueueFromCallback({
      findingId,
      toStatus: 'failed',
      failureCode: 'STATE_GUARD_REJECTED',
      errorMessage: 'Callback missing kiloSessionId — cannot retrieve analysis result',
    });
    return;
  }

  // Fetch session export from ingest service with retry
  // The callback can arrive before ingest finishes processing the last events.
  const maxAttempts = 3;
  const retryDelayMs = 5000;
  let rawMarkdown: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }

    try {
      const snapshot = await fetchSessionSnapshot(kiloSessionId, triggeredByUserId);
      if (snapshot) {
        rawMarkdown = extractLastAssistantMessage(snapshot);
      }
    } catch (error) {
      warn('Failed to fetch session export', {
        findingId,
        correlationId,
        kiloSessionId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (rawMarkdown) {
      log('Session export fetched', { findingId, correlationId, attempt });
      break;
    }

    if (attempt < maxAttempts) {
      log('No assistant message found, retrying', {
        findingId,
        correlationId,
        kiloSessionId,
        attempt,
        nextRetryMs: retryDelayMs,
      });
    }
  }

  if (!rawMarkdown) {
    warn('Could not retrieve analysis result after retries', {
      findingId,
      correlationId,
      kiloSessionId,
      attempts: maxAttempts,
    });
    await updateAnalysisStatus(findingId, 'failed', {
      error: 'Analysis completed but result could not be retrieved from ingest service',
    });
    await transitionAutoAnalysisQueueFromCallback({
      findingId,
      toStatus: 'failed',
      failureCode: 'START_CALL_AMBIGUOUS',
      errorMessage: 'Analysis completed but result could not be retrieved from ingest service',
    });
    return;
  }

  // Write raw markdown to the analysis field (powers the user-facing summary display).
  // This must happen before Tier 3 extraction so the UI has content even if extraction fails.
  const analysisWithRawMarkdown: SecurityFindingAnalysis = {
    ...finding.analysis,
    rawMarkdown,
    analyzedAt: new Date().toISOString(),
  };
  await updateAnalysisStatus(findingId, 'running', { analysis: analysisWithRawMarkdown });

  // Generate a fresh auth token for the Tier 3 LLM call.
  // The original authToken from startSecurityAnalysis may be expired.
  const [user] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, triggeredByUserId))
    .limit(1);

  if (!user) {
    logError('User not found for Tier 3 extraction', {
      findingId,
      correlationId,
      triggeredByUserId,
    });
    await updateAnalysisStatus(findingId, 'failed', {
      error: `User ${triggeredByUserId} not found — cannot run Tier 3 extraction`,
    });
    await transitionAutoAnalysisQueueFromCallback({
      findingId,
      toStatus: 'failed',
      failureCode: 'STATE_GUARD_REJECTED',
      errorMessage: `User ${triggeredByUserId} not found — cannot run Tier 3 extraction`,
    });
    return;
  }

  const authToken = generateApiToken(user);

  logSecurityAudit({
    owner,
    actor_id: null,
    actor_email: null,
    actor_name: null,
    action: SecurityAuditLogAction.FindingAnalysisCompleted,
    resource_type: 'security_finding',
    resource_id: findingId,
    metadata: {
      source: 'system',
      model,
      triageModel,
      analysisModel,
      correlationId,
      triggeredByUserId,
    },
  });

  try {
    await finalizeAnalysis(
      findingId,
      rawMarkdown,
      analysisModel,
      owner,
      triggeredByUserId,
      authToken,
      correlationId,
      organizationId
    );
  } catch (error) {
    captureException(error, {
      tags: { source: 'security-analysis-callback-api', operation: 'finalizeAnalysis' },
      extra: { findingId, correlationId },
    });
    await transitionAutoAnalysisQueueFromCallback({
      findingId,
      toStatus: 'failed',
      failureCode: 'START_CALL_AMBIGUOUS',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const updatedFinding = await getSecurityFindingById(findingId);
  if (updatedFinding?.analysis_status === 'completed') {
    await transitionAutoAnalysisQueueFromCallback({ findingId, toStatus: 'completed' });
  } else if (updatedFinding?.analysis_status === 'failed') {
    await transitionAutoAnalysisQueueFromCallback({
      findingId,
      toStatus: 'failed',
      failureCode: 'START_CALL_AMBIGUOUS',
      errorMessage: updatedFinding.analysis_error ?? undefined,
    });
  } else {
    await transitionAutoAnalysisQueueFromCallback({
      findingId,
      toStatus: 'failed',
      failureCode: 'STATE_GUARD_REJECTED',
      errorMessage: `Unexpected post-finalize state: ${updatedFinding?.analysis_status ?? 'finding_not_found'}`,
    });
  }
}

async function handleAnalysisFailed(
  findingId: string,
  payload: ExecutionCallbackPayload,
  finding: Awaited<ReturnType<typeof getSecurityFindingById>> & {}
) {
  const {
    correlationId,
    triggeredByUserId,
    modelUsed: model,
    triageModel,
    analysisModel,
  } = readAnalysisContext(finding.analysis);
  const organizationId = finding.owned_by_organization_id ?? undefined;

  if (payload.status !== 'failed' && payload.status !== 'interrupted') {
    return;
  }

  const callbackFailure = mapCallbackFailure({
    status: payload.status,
    errorMessage: payload.errorMessage,
  });
  const errorMessage = callbackFailure.errorMessage;

  if (payload.status === 'interrupted') {
    logExceptInTest('Analysis interrupted by user', {
      findingId,
      correlationId,
      status: payload.status,
      errorMessage,
    });
  } else {
    logError('Analysis failed/interrupted', {
      findingId,
      correlationId,
      status: payload.status,
      errorMessage,
    });
  }

  await updateAnalysisStatus(findingId, 'failed', { error: errorMessage });
  await transitionAutoAnalysisQueueFromCallback({
    findingId,
    toStatus: 'failed',
    failureCode: callbackFailure.failureCode,
    errorMessage,
  });

  if (!triggeredByUserId) {
    logError('Missing triggeredByUserId in analysis context, skipping PostHog tracking', {
      findingId,
      correlationId,
    });
    return;
  }

  trackSecurityAgentAnalysisCompleted({
    distinctId: triggeredByUserId,
    userId: triggeredByUserId,
    organizationId,
    findingId,
    model,
    triageModel,
    analysisModel,
    triageOnly: false,
    durationMs: finding.analysis_started_at
      ? Date.now() - new Date(finding.analysis_started_at).getTime()
      : 0,
  });
}
