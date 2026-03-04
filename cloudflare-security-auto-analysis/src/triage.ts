import { z } from 'zod';
import { logger } from './logger.js';
import type { SecurityFindingRecord } from './db/queries.js';
import type { SecurityFindingTriage } from './types.js';

const TRIAGE_SERVICE_VERSION = '5.0.0';
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

const TriagedResultSchema = z.object({
  needsSandboxAnalysis: z.boolean(),
  needsSandboxReasoning: z.string(),
  suggestedAction: z.enum(['dismiss', 'analyze_codebase', 'manual_review']),
  confidence: z.enum(['high', 'medium', 'low']),
});

const TriageResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        tool_calls: z
          .array(
            z.object({
              type: z.literal('function'),
              function: z.object({
                name: z.string(),
                arguments: z.string(),
              }),
            })
          )
          .optional(),
      }),
    })
  ),
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

Please analyze this vulnerability and call the submit_triage_result tool with your assessment.`;
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
  const requestBody = {
    model: params.model,
    messages: [
      { role: 'system', content: TRIAGE_SYSTEM_PROMPT },
      { role: 'user', content: buildTriagePrompt(params.finding) },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'submit_triage_result',
          description: 'Submit triage result for this vulnerability finding',
          parameters: {
            type: 'object',
            properties: {
              needsSandboxAnalysis: {
                type: 'boolean',
              },
              needsSandboxReasoning: {
                type: 'string',
              },
              suggestedAction: {
                type: 'string',
                enum: ['dismiss', 'analyze_codebase', 'manual_review'],
              },
              confidence: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
              },
            },
            required: [
              'needsSandboxAnalysis',
              'needsSandboxReasoning',
              'suggestedAction',
              'confidence',
            ],
          },
        },
      },
    ],
    tool_choice: {
      type: 'function',
      function: { name: 'submit_triage_result' },
    },
    stream: false,
  };

  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${params.authToken}`,
    'X-KiloCode-Version': TRIAGE_SERVICE_VERSION,
    'User-Agent': TRIAGE_SERVICE_USER_AGENT,
  });

  if (params.organizationId) {
    headers.set('X-KiloCode-OrganizationId', params.organizationId);
  }

  try {
    const response = await fetch(`${params.backendBaseUrl}/api/openrouter/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(45_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Triage request failed', {
        finding_id: params.finding.id,
        status: response.status,
        error: errorText,
      });
      return createFallbackTriage(`API error: ${response.status}`);
    }

    const parsedResponse = TriageResponseSchema.safeParse(await response.json());
    if (!parsedResponse.success) {
      logger.warn('Triage response did not match expected shape', {
        finding_id: params.finding.id,
      });
      return createFallbackTriage('Invalid response shape');
    }

    const firstChoice = parsedResponse.data.choices[0];
    const firstToolCall = firstChoice?.message.tool_calls?.[0];
    if (!firstToolCall || firstToolCall.function.name !== 'submit_triage_result') {
      return createFallbackTriage('Tool call missing');
    }

    let args: unknown;
    try {
      args = JSON.parse(firstToolCall.function.arguments);
    } catch {
      return createFallbackTriage('Tool call arguments not valid JSON');
    }
    const parsedArgs = TriagedResultSchema.safeParse(args);
    if (!parsedArgs.success) {
      return createFallbackTriage('Tool call arguments invalid');
    }

    return {
      ...parsedArgs.data,
      triageAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.error('Triage call threw', {
      finding_id: params.finding.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return createFallbackTriage(error instanceof Error ? error.message : 'Unknown triage error');
  }
}
