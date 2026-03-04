import 'server-only';
import { randomUUID } from 'crypto';
import {
  createCloudAgentNextClient,
  InsufficientCreditsError,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { generateApiToken } from '@/lib/tokens';
import { getSecurityFindingById } from '../db/security-findings';
import { updateAnalysisStatus, tryAcquireAnalysisStartLease } from '../db/security-analysis';
import type {
  AnalysisMode,
  SecurityFindingAnalysis,
  SecurityFindingTriage,
  SecurityReviewOwner,
} from '../core/types';
import type { AnalysisErrorCode } from '../core/error-classification';
import { classifyAnalysisError, isUserActionableError } from '../core/error-classification';
import type { User, SecurityFinding } from '@kilocode/db/schema';
import {
  trackSecurityAgentAnalysisStarted,
  trackSecurityAgentAnalysisCompleted,
} from '../posthog-tracking';
import { addBreadcrumb, captureException } from '@sentry/nextjs';
import { triageSecurityFinding } from './triage-service';
import { extractSandboxAnalysis } from './extraction-service';
import { maybeAutoDismissAnalysis } from './auto-dismiss-service';
import { sentryLogger } from '@/lib/utils.server';
import { APP_URL } from '@/lib/constants';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import type { SessionSnapshot } from '@/lib/session-ingest-client';

import {
  DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
  DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
} from '../core/constants';

const log = sentryLogger('security-agent:analysis', 'info');
const warn = sentryLogger('security-agent:analysis', 'warning');
const logError = sentryLogger('security-agent:analysis', 'error');

const ANALYSIS_PROMPT_TEMPLATE = `You are a security analyst reviewing a dependency vulnerability alert for a codebase.

## Vulnerability Details
- **Package**: {{packageName}} ({{packageEcosystem}})
- **Severity**: {{severity}}
- **Dependency Scope**: {{dependencyScope}}
- **CVE**: {{cveId}}
- **GHSA**: {{ghsaId}}
- **Title**: {{title}}
- **Description**: {{description}}
- **Vulnerable Versions**: {{vulnerableVersionRange}}
- **Patched Version**: {{patchedVersion}}
- **Manifest Path**: {{manifestPath}}

## Your Task

1. **Search the codebase** for usages of the \`{{packageName}}\` package:
   - Look for import/require statements
   - Check how the package is used (which functions/methods are called)
   - Identify if the vulnerable code paths mentioned in the CVE are actually used

2. **Analyze relevance**:
   - Is this package actually used in production code (not just dev dependencies)?
   - Note: This package is listed as a **{{dependencyScope}}** dependency
   - Are the vulnerable functions/methods being called?
   - Is user input ever passed to the vulnerable code paths?

3. **Determine exploitability**:
   - Can an attacker actually trigger the vulnerability given how the package is used?
   - Are there mitigating factors (input validation, sandboxing, etc.)?
   - What would an attacker need to do to exploit this?

4. **Provide recommendations**:
   - What is the suggested fix (e.g., upgrade to patched version)?
   - Are there any workarounds if upgrading is not immediately possible?

## Output Format

Provide a detailed markdown analysis covering:
- **Usage Locations**: List all files where the package is imported/used with line numbers (e.g., "src/utils/helpers.ts:42")
- **Exploitability Assessment**: Whether the vulnerability can be triggered given how the package is used (exploitable/not exploitable/unknown)
- **Reasoning**: Detailed explanation of why this is/isn't exploitable
- **Suggested Fix**: Specific fix recommendation (e.g., upgrade to version X.Y.Z)
- **Summary**: Brief 1-2 sentence summary of findings
`;

function buildAnalysisPrompt(finding: SecurityFinding): string {
  const replacements: Record<string, string> = {
    packageName: finding.package_name,
    packageEcosystem: finding.package_ecosystem,
    severity: finding.severity,
    dependencyScope: finding.dependency_scope || 'runtime',
    cveId: finding.cve_id || 'N/A',
    ghsaId: finding.ghsa_id || 'N/A',
    title: finding.title,
    description: finding.description || 'No description available',
    vulnerableVersionRange: finding.vulnerable_version_range || 'Unknown',
    patchedVersion: finding.patched_version || 'No patch available',
    manifestPath: finding.manifest_path || 'Unknown',
  };
  return ANALYSIS_PROMPT_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, key) => replacements[key] ?? '');
}

/** Extract the last assistant message text from a session snapshot. */
export function extractLastAssistantMessage(snapshot: SessionSnapshot): string | null {
  for (let i = snapshot.messages.length - 1; i >= 0; i--) {
    const msg = snapshot.messages[i];
    if (msg.info.role !== 'assistant') continue;

    let text = '';
    for (const p of msg.parts) {
      if (p.type === 'text' && typeof p.text === 'string') {
        text += p.text;
      }
    }

    if (text.length > 0) return text;
  }
  return null;
}

/**
 * Tier 3: Extract structured fields from raw markdown, preserve triage data,
 * and optionally auto-dismiss if sandboxAnalysis.isExploitable === false.
 */
export async function finalizeAnalysis(
  findingId: string,
  rawMarkdown: string,
  model: string,
  owner: SecurityReviewOwner,
  userId: string,
  authToken: string,
  correlationId: string,
  organizationId?: string
): Promise<void> {
  if (!rawMarkdown.trim()) {
    await updateAnalysisStatus(findingId, 'failed', {
      error: 'No response received from analysis agent',
    });
    return;
  }

  const finding = await getSecurityFindingById(findingId);
  if (!finding) {
    await updateAnalysisStatus(findingId, 'failed', {
      error: 'Finding not found during finalization',
    });
    return;
  }

  const existingAnalysis = finding.analysis;

  log('Starting Tier 3 extraction', { correlationId, findingId });

  const sandboxAnalysis = await extractSandboxAnalysis({
    finding,
    rawMarkdown,
    authToken,
    model,
    correlationId,
    userId,
    organizationId,
  });

  log('Extraction complete', {
    correlationId,
    findingId,
    isExploitable: sandboxAnalysis.isExploitable,
    usageLocationsCount: sandboxAnalysis.usageLocations.length,
  });

  const analysis: SecurityFindingAnalysis = {
    triage: existingAnalysis?.triage,
    sandboxAnalysis,
    rawMarkdown: existingAnalysis?.rawMarkdown,
    analyzedAt: new Date().toISOString(),
    modelUsed: model,
    triageModel: existingAnalysis?.triageModel,
    analysisModel: existingAnalysis?.analysisModel ?? model,
    triggeredByUserId: existingAnalysis?.triggeredByUserId,
    correlationId,
  };

  await updateAnalysisStatus(findingId, 'completed', { analysis });

  const triggeredBy = existingAnalysis?.triggeredByUserId ?? userId;
  trackSecurityAgentAnalysisCompleted({
    distinctId: triggeredBy,
    userId: triggeredBy,
    organizationId,
    findingId,
    model,
    triageModel: existingAnalysis?.triageModel,
    analysisModel: existingAnalysis?.analysisModel ?? model,
    triageOnly: false,
    needsSandboxAnalysis: existingAnalysis?.triage?.needsSandboxAnalysis,
    triageSuggestedAction: existingAnalysis?.triage?.suggestedAction,
    triageConfidence: existingAnalysis?.triage?.confidence,
    isExploitable: sandboxAnalysis.isExploitable,
    durationMs: finding.analysis_started_at
      ? Date.now() - new Date(finding.analysis_started_at).getTime()
      : 0,
  });

  if (sandboxAnalysis.isExploitable === false) {
    void maybeAutoDismissAnalysis({ findingId, analysis, owner, userId, correlationId }).catch(
      (error: unknown) => {
        logError('Auto-dismiss after sandbox error', { correlationId, findingId, error });
        captureException(error, {
          tags: { operation: 'maybeAutoDismissAnalysis' },
          extra: { findingId, correlationId },
        });
      }
    );
  }
}

export async function startSecurityAnalysis(params: {
  findingId: string;
  user: User;
  githubRepo: string;
  githubToken?: string;
  triageModel?: string;
  analysisModel?: string;
  analysisMode?: AnalysisMode;
  forceSandbox?: boolean;
  retrySandboxOnly?: boolean;
  organizationId?: string;
}): Promise<{
  started: boolean;
  error?: string;
  errorCode?: AnalysisErrorCode;
  triageOnly?: boolean;
}> {
  const {
    findingId,
    user,
    githubRepo,
    githubToken,
    triageModel = DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
    analysisModel = DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
    analysisMode = 'auto',
    forceSandbox = false,
    retrySandboxOnly = false,
    organizationId,
  } = params;

  const correlationId = randomUUID();

  const finding = await getSecurityFindingById(findingId);
  if (!finding) {
    return { started: false, error: `Finding not found: ${findingId}` };
  }

  const leaseAcquired = await tryAcquireAnalysisStartLease(findingId);
  if (!leaseAcquired) {
    if (finding.status !== 'open') {
      return {
        started: false,
        error: `Finding status is '${finding.status}', analysis requires 'open' status`,
      };
    }
    return { started: false, error: 'Analysis already in progress' };
  }

  const existingTriage = retrySandboxOnly ? finding.analysis?.triage : undefined;
  if (retrySandboxOnly && !existingTriage) {
    log('retrySandboxOnly requested but no existing triage found, falling back to full analysis', {
      correlationId,
      findingId,
    });
  }
  const skipTriage = retrySandboxOnly && !!existingTriage;

  // Coerce null → undefined so updateAnalysisStatus preserves the existing analysis
  if (skipTriage) {
    await updateAnalysisStatus(findingId, 'pending', { analysis: finding.analysis ?? undefined });
  } else {
    await updateAnalysisStatus(findingId, 'pending');
  }

  const analysisStartTime = Date.now();

  try {
    const authToken = generateApiToken(user);

    let triage: SecurityFindingTriage;

    if (skipTriage) {
      triage = existingTriage;
      log('Skipping Tier 1 triage, reusing existing triage for sandbox retry', {
        correlationId,
        findingId,
        suggestedAction: triage.suggestedAction,
        confidence: triage.confidence,
      });

      trackSecurityAgentAnalysisStarted({
        distinctId: user.id,
        userId: user.id,
        organizationId,
        findingId,
        model: analysisModel,
        triageModel,
        analysisModel,
        analysisMode,
      });
    } else {
      log('Starting Tier 1 triage', { correlationId, findingId, triageModel });

      trackSecurityAgentAnalysisStarted({
        distinctId: user.id,
        userId: user.id,
        organizationId,
        findingId,
        model: analysisModel,
        triageModel,
        analysisModel,
        analysisMode,
      });

      const tier1Start = performance.now();
      triage = await triageSecurityFinding({
        finding,
        authToken,
        model: triageModel,
        correlationId,
        userId: user.id,
        organizationId,
      });
      const tier1DurationMs = Math.round(performance.now() - tier1Start);

      log('Triage complete', {
        correlationId,
        findingId,
        durationMs: tier1DurationMs,
        suggestedAction: triage.suggestedAction,
        confidence: triage.confidence,
        needsSandboxAnalysis: triage.needsSandboxAnalysis,
      });

      addBreadcrumb({
        category: 'security-agent.triage',
        message: `Triage outcome: ${triage.suggestedAction}`,
        level: 'info',
        data: {
          correlationId,
          findingId,
          suggestedAction: triage.suggestedAction,
          confidence: triage.confidence,
          needsSandbox: triage.needsSandboxAnalysis,
          durationMs: tier1DurationMs,
        },
      });
    }

    const runSandbox =
      forceSandbox ||
      skipTriage ||
      analysisMode === 'deep' ||
      (analysisMode === 'auto' && triage.needsSandboxAnalysis);

    if (!runSandbox) {
      log('Triage-only completion', { correlationId, findingId });

      const analysis: SecurityFindingAnalysis = {
        triage,
        analyzedAt: new Date().toISOString(),
        modelUsed: triageModel,
        triageModel,
        analysisModel,
        triggeredByUserId: user.id,
        correlationId,
      };

      await updateAnalysisStatus(findingId, 'completed', { analysis });

      trackSecurityAgentAnalysisCompleted({
        distinctId: user.id,
        userId: user.id,
        organizationId,
        findingId,
        model: triageModel,
        triageModel,
        analysisModel,
        triageOnly: true,
        needsSandboxAnalysis: triage.needsSandboxAnalysis,
        triageSuggestedAction: triage.suggestedAction,
        triageConfidence: triage.confidence,
        durationMs: Date.now() - analysisStartTime,
      });

      const owner: SecurityReviewOwner = organizationId ? { organizationId } : { userId: user.id };

      void maybeAutoDismissAnalysis({
        findingId,
        analysis,
        owner,
        userId: user.id,
        correlationId,
      }).catch((error: unknown) => {
        logError('Auto-dismiss error', { correlationId, findingId, error });

        captureException(error, {
          tags: { operation: 'maybeAutoDismissAnalysis' },
          extra: { findingId, correlationId },
        });
      });

      return { started: true, triageOnly: true };
    }

    log('Starting Tier 2 sandbox analysis', { correlationId, findingId });

    const partialAnalysis: SecurityFindingAnalysis = {
      triage,
      analyzedAt: new Date().toISOString(),
      modelUsed: analysisModel,
      triageModel,
      analysisModel,
      triggeredByUserId: user.id,
      correlationId,
    };
    await updateAnalysisStatus(findingId, 'pending', { analysis: partialAnalysis });

    const prompt = buildAnalysisPrompt(finding);
    const client = createCloudAgentNextClient(authToken);

    const callbackUrl = `${APP_URL}/api/internal/security-analysis-callback/${findingId}`;

    const { cloudAgentSessionId, kiloSessionId } = await client.prepareSession({
      prompt,
      mode: 'code',
      model: analysisModel,
      githubRepo,
      githubToken,
      kilocodeOrganizationId: organizationId,
      createdOnPlatform: 'security-agent',
      callbackTarget: {
        url: callbackUrl,
        headers: { 'X-Internal-Secret': INTERNAL_API_SECRET },
      },
    });

    await updateAnalysisStatus(findingId, 'running', {
      sessionId: cloudAgentSessionId,
      cliSessionId: kiloSessionId,
    });

    log('Session prepared', {
      correlationId,
      findingId,
      cloudAgentSessionId,
      kiloSessionId,
      callbackUrl,
    });

    try {
      await client.initiateFromPreparedSession({ cloudAgentSessionId });
    } catch (initiateError) {
      if (initiateError instanceof InsufficientCreditsError) {
        warn('Sandbox initiation blocked by insufficient credits', {
          correlationId,
          findingId,
          cloudAgentSessionId,
        });
        void client.deleteSession(cloudAgentSessionId).catch(() => {});
        throw initiateError;
      }

      void client.deleteSession(cloudAgentSessionId).catch(() => {});

      const classified = classifyAnalysisError(initiateError);
      const isUnknown = classified.code === 'UNKNOWN';
      const errorCode: AnalysisErrorCode = isUnknown ? 'SANDBOX_FAILED' : classified.code;
      const userMessage = isUnknown
        ? 'Sandbox analysis failed to start. Please try again.'
        : classified.userMessage;

      const isActionable = isUserActionableError(errorCode);
      const logFn = isActionable ? warn : logError;
      logFn('initiateFromPreparedSession failed', {
        correlationId,
        findingId,
        cloudAgentSessionId,
        errorCode,
        error: initiateError,
      });

      if (!isActionable) {
        captureException(initiateError, {
          tags: { operation: 'initiateFromPreparedSession', errorCode },
          extra: { findingId, cloudAgentSessionId, correlationId },
        });
      }

      await updateAnalysisStatus(findingId, 'failed', { error: userMessage });
      return { started: false, error: userMessage, errorCode };
    }

    return { started: true, triageOnly: false };
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      await updateAnalysisStatus(findingId, 'failed', { error: error.message });
      throw error;
    }

    const classified = classifyAnalysisError(error);

    await updateAnalysisStatus(findingId, 'failed', {
      error: classified.userMessage,
    });
    if (isUserActionableError(classified.code)) {
      warn('Analysis failed (user-actionable)', {
        correlationId,
        findingId,
        githubRepo,
        errorCode: classified.code,
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      captureException(error, {
        tags: { operation: 'startSecurityAnalysis', errorCode: classified.code },
        extra: { findingId, githubRepo, correlationId },
      });
    }
    return { started: false, error: classified.userMessage, errorCode: classified.code };
  }
}
