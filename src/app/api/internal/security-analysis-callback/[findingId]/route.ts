/**
 * Internal API Endpoint: Security Analysis Callback
 *
 * Called by:
 * - cloud-agent-next (when sandbox analysis completes, fails, or is interrupted)
 *
 * The findingId is passed in the URL path.
 *
 * URL: POST /api/internal/security-analysis-callback/{findingId}
 * Protected by internal API secret
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { captureException } from '@sentry/nextjs';
import { getSecurityFindingById } from '@/lib/security-agent/db/security-findings';
import { updateAnalysisStatus } from '@/lib/security-agent/db/security-analysis';
import { finalizeAnalysis } from '@/lib/security-agent/services/analysis-service';
import { fetchSessionExport, extractLastAssistantMessage } from '@/lib/session-ingest/client';
import { trackSecurityAgentAnalysisCompleted } from '@/lib/security-agent/posthog-tracking';
import { generateApiToken } from '@/lib/tokens';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { sentryLogger } from '@/lib/utils.server';
import type { SecurityFindingAnalysis, SecurityReviewOwner } from '@/lib/security-agent/core/types';

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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ findingId: string }> }
) {
  try {
    const secret = req.headers.get('X-Internal-Secret');
    if (secret !== INTERNAL_API_SECRET) {
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

    if (payload.status === 'completed') {
      await handleAnalysisCompleted(findingId, payload, finding);
    } else {
      await handleAnalysisFailed(findingId, payload, finding);
    }

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

/** Safely read the stored analysis metadata from the JSONB column */
function readAnalysisContext(analysis: SecurityFindingAnalysis | null | undefined): {
  correlationId: string;
  modelUsed: string;
  triggeredByUserId: string;
} {
  const defaultModel = 'anthropic/claude-sonnet-4';
  return {
    correlationId: analysis?.correlationId ?? '',
    modelUsed: analysis?.modelUsed ?? defaultModel,
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
    return;
  }

  const kiloSessionId = payload.kiloSessionId;
  if (!kiloSessionId) {
    logError('Callback missing kiloSessionId', { findingId, correlationId });
    await updateAnalysisStatus(findingId, 'failed', {
      error: 'Callback missing kiloSessionId — cannot retrieve analysis result',
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
      const snapshot = await fetchSessionExport(kiloSessionId, triggeredByUserId);
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
    return;
  }

  const authToken = generateApiToken(user);

  await finalizeAnalysis(
    findingId,
    rawMarkdown,
    model,
    owner,
    triggeredByUserId,
    authToken,
    correlationId,
    organizationId
  );
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
  } = readAnalysisContext(finding.analysis);
  const organizationId = finding.owned_by_organization_id ?? undefined;

  const errorMessage =
    payload.status === 'interrupted'
      ? `Analysis interrupted: ${payload.errorMessage ?? 'unknown reason'}`
      : (payload.errorMessage ?? 'Analysis failed');

  logError('Analysis failed/interrupted', {
    findingId,
    correlationId,
    status: payload.status,
    errorMessage,
  });

  await updateAnalysisStatus(findingId, 'failed', { error: errorMessage });

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
    triageOnly: false,
    durationMs: finding.analysis_started_at
      ? Date.now() - new Date(finding.analysis_started_at).getTime()
      : 0,
  });
}
