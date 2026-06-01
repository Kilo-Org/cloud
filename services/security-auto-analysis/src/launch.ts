import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { WorkerDb } from '@kilocode/db/client';
import { deriveCallbackToken } from '@kilocode/worker-utils';
import {
  clearAnalysisStatus,
  getSecurityFindingById,
  setFindingPending,
  tryAcquireAnalysisStartLease,
  type SecurityFindingRecord,
} from './db/queries.js';
import {
  transitionAnalysisStartLifecycle,
  type AnalysisStartLifecycleClaim,
} from './analysis-start-lifecycle.js';
import { logger } from './logger.js';
import { generateApiToken } from './token.js';
import { triageSecurityFinding } from './triage.js';
import { maybeAutoDismissCompletedAnalysis } from './auto-dismiss.js';
import type { AnalysisMode, SecurityFindingAnalysis } from './types.js';

export class InsufficientCreditsError extends Error {
  readonly httpStatus = 402;

  constructor(message = 'Insufficient credits: $1 minimum required') {
    super(message);
    this.name = 'InsufficientCreditsError';
  }
}

const PrepareSessionResponseSchema = z.object({
  result: z.object({
    data: z.object({
      cloudAgentSessionId: z.string(),
      kiloSessionId: z.string(),
    }),
  }),
});

const InitiateResponseSchema = z.object({
  result: z.object({
    data: z.object({
      executionId: z.string(),
      status: z.string(),
    }),
  }),
});

function buildAnalysisPrompt(finding: SecurityFindingRecord): string {
  const replacements = {
    packageName: finding.package_name,
    packageEcosystem: finding.package_ecosystem,
    severity: finding.severity ?? 'unknown',
    dependencyScope: finding.dependency_scope ?? 'runtime',
    cveId: finding.cve_id ?? 'N/A',
    ghsaId: finding.ghsa_id ?? 'N/A',
    title: finding.title,
    description: finding.description ?? 'No description available',
    vulnerableVersionRange: finding.vulnerable_version_range ?? 'Unknown',
    patchedVersion: finding.patched_version ?? 'No patch available',
    manifestPath: finding.manifest_path ?? 'Unknown',
  };

  const template = `You are a security analyst reviewing a dependency vulnerability alert for a codebase.

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

1. Search the codebase for usages of the package.
2. Analyze relevance and whether vulnerable paths are used.
3. Determine exploitability and required attacker conditions.
4. Provide concrete remediation guidance.

## Output Format

Provide a markdown analysis with:
- Usage locations with file paths and line numbers
- Exploitability assessment
- Reasoning
- Suggested fix
- Brief summary`;

  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) =>
      (key in replacements ? replacements[key as keyof typeof replacements] : '') ?? ''
  );
}

type StartSecurityAnalysisParams = {
  db: WorkerDb;
  env: CloudflareEnv;
  findingId: string;
  actorUser: {
    id: string;
    api_token_pepper: string | null;
  };
  githubToken?: string;
  triageModel: string;
  analysisModel: string;
  analysisMode: AnalysisMode;
  organizationId?: string;
  nextAuthSecret: string;
  internalApiSecret: string;
  callbackTokenSecret: string;
  retrySandboxOnly?: boolean;
  lifecycleClaim: AnalysisStartLifecycleClaim;
};

export function buildSecurityAnalysisCallbackTarget(
  env: Pick<
    CloudflareEnv,
    | 'SECURITY_ANALYSIS_CALLBACK_ROUTING_MODE'
    | 'SECURITY_ANALYSIS_CALLBACK_WEB_BASE_URL'
    | 'SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL'
  >,
  findingId: string,
  callbackToken: string,
  attemptToken: string
): {
  url: string;
  headers: { 'X-Callback-Token': string };
} {
  const encodedAttemptToken = encodeURIComponent(attemptToken);
  if (env.SECURITY_ANALYSIS_CALLBACK_ROUTING_MODE === 'web') {
    const baseUrl = env.SECURITY_ANALYSIS_CALLBACK_WEB_BASE_URL.replace(/\/$/, '');
    return {
      url: `${baseUrl}/api/internal/security-analysis-callback/${findingId}?attempt=${encodedAttemptToken}`,
      headers: { 'X-Callback-Token': callbackToken },
    };
  }

  const baseUrl = env.SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL.replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL is required for Worker callback routing'
    );
  }

  return {
    url: `${baseUrl}/internal/security-analysis-callback/${findingId}?attempt=${encodedAttemptToken}`,
    headers: { 'X-Callback-Token': callbackToken },
  };
}

export type StartSecurityAnalysisResult = {
  started: boolean;
  error?: string;
  triageOnly?: boolean;
  failureNeedsLifecycleTransition?: boolean;
};

export async function startSecurityAnalysis(
  params: StartSecurityAnalysisParams
): Promise<StartSecurityAnalysisResult> {
  const correlationId = randomUUID();

  const finding = await getSecurityFindingById(params.db, params.findingId);
  if (!finding) {
    return { started: false, error: `Finding not found: ${params.findingId}` };
  }

  const leaseAcquired = await tryAcquireAnalysisStartLease(params.db, params.findingId);
  if (!leaseAcquired) {
    if (finding.status !== 'open') {
      return {
        started: false,
        error: `Finding status is '${finding.status}', analysis requires 'open' status`,
      };
    }
    return { started: false, error: 'Analysis already in progress' };
  }

  const existingTriage = params.retrySandboxOnly ? finding.analysis?.triage : undefined;
  const skipTriage = params.retrySandboxOnly === true && existingTriage !== undefined;

  await setFindingPending(
    params.db,
    params.findingId,
    skipTriage ? (finding.analysis ?? null) : null
  );

  try {
    const environment = params.env.ENVIRONMENT === 'production' ? 'production' : 'development';
    const authToken = await generateApiToken(params.actorUser, params.nextAuthSecret, environment);
    const triage = skipTriage
      ? existingTriage
      : await triageSecurityFinding({
          finding,
          authToken,
          model: params.triageModel,
          backendBaseUrl: params.env.KILOCODE_BACKEND_BASE_URL,
          organizationId: params.organizationId,
        });

    const runSandbox =
      skipTriage ||
      params.analysisMode === 'deep' ||
      (params.analysisMode === 'auto' && triage.needsSandboxAnalysis);

    if (!runSandbox) {
      const triageOnlyAnalysis: SecurityFindingAnalysis = {
        triage,
        analyzedAt: new Date().toISOString(),
        modelUsed: params.triageModel,
        triageModel: params.triageModel,
        analysisModel: params.analysisModel,
        triggeredByUserId: params.actorUser.id,
        correlationId,
      };
      const transition = await transitionAnalysisStartLifecycle(params.db, {
        claim: params.lifecycleClaim,
        outcome: { type: 'triage-only-completed', analysis: triageOnlyAnalysis },
      });
      if (!transition.transitioned) {
        await clearAnalysisStatus(params.db, params.findingId);
        return { started: false, error: 'Finding was superseded during analysis' };
      }
      await maybeAutoDismissCompletedAnalysis({
        db: params.db,
        env: params.env,
        findingId: params.findingId,
        finding,
        analysis: triageOnlyAnalysis,
      });
      return { started: true, triageOnly: true };
    }

    const partialAnalysis: SecurityFindingAnalysis = {
      triage,
      analyzedAt: new Date().toISOString(),
      modelUsed: params.analysisModel,
      triageModel: params.triageModel,
      analysisModel: params.analysisModel,
      triggeredByUserId: params.actorUser.id,
      correlationId,
    };

    await setFindingPending(params.db, params.findingId, partialAnalysis);

    const callbackToken = await deriveCallbackToken({
      secret: params.callbackTokenSecret,
      scope: 'security-analysis-callback',
      resourceParts: [params.findingId, params.lifecycleClaim.claimToken],
    });
    const callbackTarget = buildSecurityAnalysisCallbackTarget(
      params.env,
      params.findingId,
      callbackToken,
      params.lifecycleClaim.claimToken
    );

    const prepareInput = {
      prompt: buildAnalysisPrompt(finding),
      mode: 'code',
      model: params.analysisModel,
      githubRepo: finding.repo_full_name,
      githubToken: params.githubToken,
      kilocodeOrganizationId: params.organizationId,
      createdOnPlatform: 'security-agent',
      callbackTarget,
    };

    const prepareResponse = await params.env.CLOUD_AGENT_NEXT.fetch(
      new Request('https://cloud-agent-next/trpc/prepareSession', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
          'x-internal-api-key': params.internalApiSecret,
        },
        body: JSON.stringify(prepareInput),
      })
    );

    if (!prepareResponse.ok) {
      const errorText = await prepareResponse.text();
      return {
        started: false,
        error: errorText,
        failureNeedsLifecycleTransition: true,
      };
    }

    const parsedPrepare = PrepareSessionResponseSchema.safeParse(await prepareResponse.json());
    if (!parsedPrepare.success) {
      return {
        started: false,
        error: 'Invalid prepareSession response shape',
        failureNeedsLifecycleTransition: true,
      };
    }

    const { cloudAgentSessionId, kiloSessionId } = parsedPrepare.data.result.data;
    const runningTransition = await transitionAnalysisStartLifecycle(params.db, {
      claim: params.lifecycleClaim,
      outcome: { type: 'sandbox-running', cloudAgentSessionId, kiloSessionId },
    });
    if (!runningTransition.transitioned) {
      await clearAnalysisStatus(params.db, params.findingId);
      return { started: false, error: 'Finding was superseded during analysis' };
    }

    const initiateResponse = await params.env.CLOUD_AGENT_NEXT.fetch(
      new Request('https://cloud-agent-next/trpc/initiateFromKilocodeSessionV2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ cloudAgentSessionId }),
      })
    );

    if (!initiateResponse.ok) {
      const errorText = await initiateResponse.text();

      if (initiateResponse.status === 402) {
        throw new InsufficientCreditsError(errorText || 'Insufficient credits');
      }

      return {
        started: false,
        error: errorText,
        failureNeedsLifecycleTransition: true,
      };
    }

    const parsedInitiate = InitiateResponseSchema.safeParse(await initiateResponse.json());
    if (!parsedInitiate.success) {
      return {
        started: false,
        error: 'Invalid initiateFromKilocodeSessionV2 response shape',
        failureNeedsLifecycleTransition: true,
      };
    }

    return { started: true, triageOnly: false };
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      throw error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('startSecurityAnalysis failed', {
      finding_id: params.findingId,
      correlation_id: correlationId,
      error: errorMessage,
    });

    return {
      started: false,
      error: errorMessage,
      failureNeedsLifecycleTransition: true,
    };
  }
}
