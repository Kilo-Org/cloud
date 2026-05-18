import type { SecurityFindingRecord } from './db/queries.js';
import type { SecurityFindingAnalysis } from './types.js';

const POSTHOG_CAPTURE_URL = 'https://us.i.posthog.com/i/v0/e/';
const POSTHOG_TIMEOUT_MS = 5_000;

type SecurityAnalysisCompletedAnalyticsEnv = Pick<CloudflareEnv, 'NEXT_PUBLIC_POSTHOG_KEY'>;

export async function trackSecurityAnalysisCompleted(params: {
  env: SecurityAnalysisCompletedAnalyticsEnv;
  findingId: string;
  finding: SecurityFindingRecord;
  analysis: SecurityFindingAnalysis;
}): Promise<void> {
  const posthogKey = params.env.NEXT_PUBLIC_POSTHOG_KEY;
  const triggeredByUserId = params.analysis.triggeredByUserId;
  if (!posthogKey || !triggeredByUserId) return;

  const durationMs = params.finding.analysis_started_at
    ? Math.max(0, Date.now() - new Date(params.finding.analysis_started_at).getTime())
    : 0;
  const sandboxAnalysis = params.analysis.sandboxAnalysis;
  const triage = params.analysis.triage;

  try {
    const response = await fetch(POSTHOG_CAPTURE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(POSTHOG_TIMEOUT_MS),
      body: JSON.stringify({
        api_key: posthogKey,
        distinct_id: triggeredByUserId,
        event: 'security_agent_analysis_completed',
        properties: {
          distinctId: triggeredByUserId,
          userId: triggeredByUserId,
          organizationId: params.finding.owned_by_organization_id ?? undefined,
          findingId: params.findingId,
          model: params.analysis.modelUsed ?? params.analysis.analysisModel ?? '',
          triageModel: params.analysis.triageModel,
          analysisModel: params.analysis.analysisModel,
          triageOnly: !sandboxAnalysis,
          needsSandboxAnalysis: triage?.needsSandboxAnalysis,
          triageSuggestedAction: triage?.suggestedAction,
          triageConfidence: triage?.confidence,
          isExploitable: sandboxAnalysis?.isExploitable,
          durationMs,
          feature: 'security-agent',
          operation: 'analysis_completed',
          $lib: 'security-auto-analysis-worker',
        },
      }),
    });

    await response.body?.cancel();
    if (!response.ok) {
      console.warn('Security analysis completion PostHog capture failed', {
        status: response.status,
      });
    }
  } catch (error) {
    console.warn('Security analysis completion PostHog capture threw', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
