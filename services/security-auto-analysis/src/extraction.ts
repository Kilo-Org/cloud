import { z } from 'zod';
import type { SecurityFindingRecord } from './db/queries.js';
import { logger } from './logger.js';
import type { SecurityFindingSandboxAnalysis } from './types.js';

const EXTRACTION_SERVICE_VERSION = '5.0.0';
const EXTRACTION_SERVICE_USER_AGENT = `Kilo-Security-Extraction/${EXTRACTION_SERVICE_VERSION}`;

const ExtractionResultSchema = z.object({
  isExploitable: z.union([z.boolean(), z.literal('unknown')]),
  exploitabilityReasoning: z.string(),
  usageLocations: z.array(z.string()),
  suggestedFix: z.string(),
  suggestedAction: z.enum(['dismiss', 'open_pr', 'manual_review', 'monitor']),
  summary: z.string(),
});

const ExtractionResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        tool_calls: z
          .array(
            z.object({
              type: z.literal('function'),
              function: z.object({ name: z.string(), arguments: z.string() }),
            })
          )
          .optional(),
      }),
    })
  ),
});

function buildExtractionPrompt(finding: SecurityFindingRecord, rawMarkdown: string): string {
  return `## Original Vulnerability Details

**Package**: ${finding.package_name} (${finding.package_ecosystem})
**Severity**: ${finding.severity}
**Dependency Scope**: ${finding.dependency_scope ?? 'unknown'}
**CVE**: ${finding.cve_id ?? 'N/A'}
**GHSA**: ${finding.ghsa_id ?? 'N/A'}
**Title**: ${finding.title}
**Vulnerable Versions**: ${finding.vulnerable_version_range ?? 'Unknown'}
**Patched Version**: ${finding.patched_version ?? 'No patch available'}

## Raw Analysis Report

${rawMarkdown}

Please extract structured analysis and call submit_analysis_extraction.`;
}

function fallbackExtraction(rawMarkdown: string, reason: string): SecurityFindingSandboxAnalysis {
  return {
    isExploitable: 'unknown',
    exploitabilityReasoning: `Extraction failed: ${reason}. Please review the raw analysis.`,
    usageLocations: [],
    suggestedFix: 'Review the raw analysis for fix recommendations.',
    suggestedAction: 'manual_review',
    summary: 'Analysis completed but structured extraction failed. Review raw output.',
    rawMarkdown,
    analysisAt: new Date().toISOString(),
  };
}

function parseExtractionResult(
  argumentsJson: string,
  rawMarkdown: string,
  model: string
): SecurityFindingSandboxAnalysis | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  const result = ExtractionResultSchema.safeParse(parsed);
  if (!result.success) return null;
  return {
    ...result.data,
    rawMarkdown,
    analysisAt: new Date().toISOString(),
    modelUsed: model,
  };
}

export async function extractSandboxAnalysis(params: {
  finding: SecurityFindingRecord;
  rawMarkdown: string;
  authToken: string;
  model: string;
  backendBaseUrl: string;
  organizationId?: string;
}): Promise<SecurityFindingSandboxAnalysis> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${params.authToken}`,
    'X-KiloCode-Version': EXTRACTION_SERVICE_VERSION,
    'User-Agent': EXTRACTION_SERVICE_USER_AGENT,
  });
  if (params.organizationId) headers.set('X-KiloCode-OrganizationId', params.organizationId);

  try {
    const response = await fetch(`${params.backendBaseUrl}/api/openrouter/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: params.model,
        messages: [
          {
            role: 'system',
            content:
              'Extract exploitability, usage locations, suggested fix, suggested action, and summary from the vulnerability analysis.',
          },
          { role: 'user', content: buildExtractionPrompt(params.finding, params.rawMarkdown) },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'submit_analysis_extraction',
              description: 'Submit structured security analysis extraction',
              parameters: {
                type: 'object',
                properties: {
                  isExploitable: {
                    oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['unknown'] }],
                  },
                  exploitabilityReasoning: { type: 'string' },
                  usageLocations: { type: 'array', items: { type: 'string' } },
                  suggestedFix: { type: 'string' },
                  suggestedAction: {
                    type: 'string',
                    enum: ['dismiss', 'open_pr', 'manual_review', 'monitor'],
                  },
                  summary: { type: 'string' },
                },
                required: [
                  'isExploitable',
                  'exploitabilityReasoning',
                  'usageLocations',
                  'suggestedFix',
                  'suggestedAction',
                  'summary',
                ],
              },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'submit_analysis_extraction' } },
        stream: false,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      logger.error('Extraction request failed', {
        status: response.status,
        finding_id: params.finding.id,
      });
      return fallbackExtraction(params.rawMarkdown, `API error: ${response.status}`);
    }
    const parsedResponse = ExtractionResponseSchema.safeParse(await response.json());
    const toolCall = parsedResponse.success
      ? parsedResponse.data.choices[0]?.message.tool_calls?.[0]
      : undefined;
    if (!toolCall || toolCall.function.name !== 'submit_analysis_extraction') {
      return fallbackExtraction(params.rawMarkdown, 'Tool call missing');
    }
    return (
      parseExtractionResult(toolCall.function.arguments, params.rawMarkdown, params.model) ??
      fallbackExtraction(params.rawMarkdown, 'Tool call arguments invalid')
    );
  } catch (error) {
    logger.error('Extraction call threw', {
      finding_id: params.finding.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackExtraction(
      params.rawMarkdown,
      error instanceof Error ? error.message : 'Unknown extraction error'
    );
  }
}
