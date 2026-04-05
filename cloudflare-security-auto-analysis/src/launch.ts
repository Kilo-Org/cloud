import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { WorkerDb } from '@kilocode/db/client';
import {
  clearAnalysisStatus,
  getSecurityFindingById,
  setFindingCompleted,
  setFindingFailed,
  setFindingPending,
  setFindingRunning,
  tryAcquireAnalysisStartLease,
  type SecurityFindingRecord,
} from './db/queries.js';
import { logger } from './logger.js';
import { generateApiToken } from './token.js';
import { triageSecurityFinding } from './triage.js';
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
  model: string;
  analysisMode: AnalysisMode;
  organizationId?: string;
  nextAuthSecret: string;
  internalApiSecret: string;
};

export async function startSecurityAnalysis(
  params: StartSecurityAnalysisParams
): Promise<{ started: boolean; error?: string; triageOnly?: boolean }> {
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

  await setFindingPending(params.db, params.findingId, null);

  try {
    const environment = params.env.ENVIRONMENT === 'production' ? 'production' : 'development';
    const authToken = await generateApiToken(params.actorUser, params.nextAuthSecret, environment);
    const triage = await triageSecurityFinding({
      finding,
      authToken,
      model: params.model,
      backendBaseUrl: params.env.KILOCODE_BACKEND_BASE_URL,
      organizationId: params.organizationId,
    });

    const runSandbox =
      params.analysisMode === 'deep' ||
      (params.analysisMode === 'auto' && triage.needsSandboxAnalysis);

    if (!runSandbox) {
      const triageOnlyAnalysis: SecurityFindingAnalysis = {
        triage,
        analyzedAt: new Date().toISOString(),
        modelUsed: params.model,
        triggeredByUserId: params.actorUser.id,
        correlationId,
      };
      const written = await setFindingCompleted(params.db, params.findingId, triageOnlyAnalysis);
      if (!written) {
        // Finding was superseded between lease acquisition and completion.
        // Clear stale analysis_status so it doesn't count against the concurrency cap.
        await clearAnalysisStatus(params.db, params.findingId);
        return { started: false, error: 'Finding was superseded during analysis' };
      }
      return { started: true, triageOnly: true };
    }

    const partialAnalysis: SecurityFindingAnalysis = {
      triage,
      analyzedAt: new Date().toISOString(),
      modelUsed: params.model,
      triggeredByUserId: params.actorUser.id,
      correlationId,
    };

    await setFindingPending(params.db, params.findingId, partialAnalysis);

    const callbackUrl = `${params.env.KILOCODE_BACKEND_BASE_URL}/api/internal/security-analysis-callback/${params.findingId}`;

    const prepareInput = {
      prompt: buildAnalysisPrompt(finding),
      mode: 'code',
      model: params.model,
      githubRepo: finding.repo_full_name,
      githubToken: params.githubToken,
      kilocodeOrganizationId: params.organizationId,
      createdOnPlatform: 'security-agent',
      callbackTarget: {
        url: callbackUrl,
        headers: {
          'X-Internal-Secret': params.internalApiSecret,
        },
      },
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
      if (!(await setFindingFailed(params.db, params.findingId, errorText))) {
        await clearAnalysisStatus(params.db, params.findingId);
      }
      return { started: false, error: errorText };
    }

    const parsedPrepare = PrepareSessionResponseSchema.safeParse(await prepareResponse.json());
    if (!parsedPrepare.success) {
      if (
        !(await setFindingFailed(
          params.db,
          params.findingId,
          'Invalid prepareSession response shape'
        ))
      ) {
        await clearAnalysisStatus(params.db, params.findingId);
      }
      return { started: false, error: 'Invalid prepareSession response shape' };
    }

    const { cloudAgentSessionId, kiloSessionId } = parsedPrepare.data.result.data;
    await setFindingRunning(params.db, params.findingId, cloudAgentSessionId, kiloSessionId);

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
      if (!(await setFindingFailed(params.db, params.findingId, errorText))) {
        await clearAnalysisStatus(params.db, params.findingId);
      }

      if (initiateResponse.status === 402) {
        throw new InsufficientCreditsError(errorText || 'Insufficient credits');
      }

      return {
        started: false,
        error: errorText,
      };
    }

    const parsedInitiate = InitiateResponseSchema.safeParse(await initiateResponse.json());
    if (!parsedInitiate.success) {
      if (
        !(await setFindingFailed(
          params.db,
          params.findingId,
          'Invalid initiateFromKilocodeSessionV2 response shape'
        ))
      ) {
        await clearAnalysisStatus(params.db, params.findingId);
      }
      return {
        started: false,
        error: 'Invalid initiateFromKilocodeSessionV2 response shape',
      };
    }

    return { started: true, triageOnly: false };
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      // setFindingFailed already called at the throw site (line 231)
      throw error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('startSecurityAnalysis failed', {
      finding_id: params.findingId,
      correlation_id: correlationId,
      error: errorMessage,
    });

    if (!(await setFindingFailed(params.db, params.findingId, errorMessage))) {
      await clearAnalysisStatus(params.db, params.findingId);
    }
    return { started: false, error: errorMessage };
  }
}
