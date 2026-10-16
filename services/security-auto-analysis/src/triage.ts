import { APICallError, generateText, RetryError, tool } from 'ai';
import { z } from 'zod';
import { logger } from './logger.js';
import type { SecurityFindingRecord } from './db/queries.js';
import { createGatewayLanguageModel, resolveAiSdkProvider } from './gateway-model.js';
import type { SecurityFindingTriage } from './types.js';

const TRIAGE_SERVICE_VERSION = '5.1.0';
const TRIAGE_SERVICE_USER_AGENT = `Kilo-Security-Triage/${TRIAGE_SERVICE_VERSION}`;

const TRIAGE_SYSTEM_PROMPT = `You are a security analyst performing quick triage of dependency vulnerability alerts.

Your task is to analyze the vulnerability metadata and determine if deeper codebase analysis is needed.

## Triage Guidelines

### Dismiss candidates (needsSandboxAnalysis: false, suggestedAction: 'dismiss'):
- Development dependencies with low/medium severity (test frameworks, linters, build tools)
- Vulnerabilities in packages that are clearly dev-only (jest, mocha, eslint, webpack, etc.)
- DoS vulnerabilities in CLI-only tools that don't affect production
- Low severity vulnerabilities with no known exploits

### Needs codebase analysis (needsSandboxAnalysis: true, suggestedAction: 'analyze_codebase'):
- Runtime dependencies with high/critical severity
- RCE (Remote Code Execution) vulnerabilities
- SQL injection, XSS, or authentication bypass vulnerabilities
- Vulnerabilities in core frameworks (express, react, etc.)
- Any vulnerability where exploitability depends on how the package is used

### Manual review (needsSandboxAnalysis: false, suggestedAction: 'manual_review'):
- Edge cases where you're uncertain
- Critical severity in dev dependencies
- Complex vulnerabilities that need human judgment

## Confidence Levels
- high: Clear-cut case based on metadata alone
- medium: Reasonable confidence but some uncertainty
- low: Uncertain, recommend manual review

Always err on the side of caution - if unsure, recommend codebase analysis or manual review.`;

const TRIAGE_TIMEOUT_MS = 45_000;

const TriagedResultSchema = z.object({
  needsSandboxAnalysis: z.boolean(),
  needsSandboxReasoning: z.string(),
  suggestedAction: z.enum(['dismiss', 'analyze_codebase', 'manual_review']),
  confidence: z.enum(['high', 'medium', 'low']),
});

const submitTriageResultTool = tool({
  description: 'Submit triage result for this vulnerability finding',
  inputSchema: TriagedResultSchema,
});

function buildTriagePrompt(finding: SecurityFindingRecord): string {
  let cweContext = '';
  if (finding.raw_data && typeof finding.raw_data === 'object') {
    const serialized = JSON.stringify(finding.raw_data);
    if (serialized.length > 0) {
      cweContext = `\n\n**Additional Context**: ${serialized.slice(0, 1000)}`;
    }
  }

  return `## Vulnerability Alert to Triage

**Package**: ${finding.package_name} (${finding.package_ecosystem})
**Severity**: ${finding.severity ?? 'unknown'}
**Dependency Scope**: ${finding.dependency_scope ?? 'unknown'}
**CVE**: ${finding.cve_id ?? 'N/A'}
**GHSA**: ${finding.ghsa_id ?? 'N/A'}

**Title**: ${finding.title}
**Description**: ${finding.description ?? 'No description available'}

**Vulnerable Versions**: ${finding.vulnerable_version_range ?? 'Unknown'}
**Patched Version**: ${finding.patched_version ?? 'No patch available'}
**Manifest Path**: ${finding.manifest_path ?? 'Unknown'}${cweContext}

Please analyze this vulnerability and call the submit_triage_result tool with your assessment. If tool calls are unavailable, return only a JSON object matching the tool parameters, without markdown or prose.`;
}

function extractJsonContent(content: string | null | undefined): string | null {
  const trimmed = content?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const fencedJson = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return fencedJson?.[1]?.trim() || null;
}

function createFallbackTriage(reason: string): SecurityFindingTriage {
  return {
    needsSandboxAnalysis: true,
    needsSandboxReasoning: `Triage failed: ${reason}. Defaulting to sandbox analysis.`,
    suggestedAction: 'analyze_codebase',
    confidence: 'low',
    triageAt: new Date().toISOString(),
  };
}

export async function triageSecurityFinding(params: {
  finding: SecurityFindingRecord;
  authToken: string;
  model: string;
  backendBaseUrl: string;
  organizationId?: string;
}): Promise<SecurityFindingTriage> {
  const headers: Record<string, string> = {
    'X-KiloCode-Version': TRIAGE_SERVICE_VERSION,
    'User-Agent': TRIAGE_SERVICE_USER_AGENT,
  };
  if (params.organizationId) {
    headers['X-KiloCode-OrganizationId'] = params.organizationId;
  }
  const connection = {
    backendBaseUrl: params.backendBaseUrl,
    authToken: params.authToken,
    headers,
    abortSignal: AbortSignal.timeout(TRIAGE_TIMEOUT_MS),
  };

  try {
    const provider = await resolveAiSdkProvider(params.model, connection);
    const result = await generateText({
      model: createGatewayLanguageModel(provider, params.model, connection),
      system: TRIAGE_SYSTEM_PROMPT,
      prompt: buildTriagePrompt(params.finding),
      tools: { submit_triage_result: submitTriageResultTool },
      toolChoice: 'auto',
      // Call-level headers replace the provider's User-Agent, so the triage identity must be repeated here.
      headers,
      abortSignal: connection.abortSignal,
    });

    const toolCall = result.toolCalls.find(
      candidate => candidate.toolName === 'submit_triage_result'
    );
    let structuredResult: unknown = toolCall?.input;
    if (structuredResult === undefined) {
      const structuredJson = extractJsonContent(result.text);
      if (!structuredJson) {
        return createFallbackTriage('Structured response missing');
      }
      try {
        structuredResult = JSON.parse(structuredJson);
      } catch {
        return createFallbackTriage('Structured response not valid JSON');
      }
    }

    const parsedResult = TriagedResultSchema.safeParse(structuredResult);
    if (!parsedResult.success) {
      return createFallbackTriage('Structured response invalid');
    }

    return {
      ...parsedResult.data,
      triageAt: new Date().toISOString(),
    };
  } catch (error) {
    const apiError = findApiCallError(error);
    if (apiError) {
      logger.error('Triage request failed', {
        finding_id: params.finding.id,
        model: params.model,
        status: apiError.statusCode,
        error: apiError.responseBody,
      });
      return createFallbackTriage(`API error: ${apiError.statusCode ?? 'unknown'}`);
    }
    logger.error('Triage call threw', {
      finding_id: params.finding.id,
      model: params.model,
      error: error instanceof Error ? error.message : String(error),
    });
    return createFallbackTriage(error instanceof Error ? error.message : 'Unknown triage error');
  }
}

function findApiCallError(error: unknown): APICallError | undefined {
  if (APICallError.isInstance(error)) return error;
  if (RetryError.isInstance(error) && APICallError.isInstance(error.lastError)) {
    return error.lastError;
  }
  return undefined;
}
