/**
 * Security Finding Extraction Service (Tier 3)
 *
 * Extracts structured analysis fields from raw markdown output of sandbox analysis.
 * Uses direct LLM call with function calling to parse the unstructured analysis
 * into the SecurityFindingSandboxAnalysis type.
 *
 * Following the same pattern as triage-service.ts for structured output via tools.
 */

import 'server-only';
import type OpenAI from 'openai';
import { sendProxiedChatCompletion } from '@/lib/llm-proxy-helpers';
import type { SecurityFinding } from '@/db/schema';
import type { SecurityFindingSandboxAnalysis, SandboxSuggestedAction } from '../core/types';
import { addBreadcrumb, captureException, startSpan } from '@sentry/nextjs';
import { sentryLogger } from '@/lib/utils.server';
import { emitApiMetrics } from '@/lib/o11y/api-metrics.server';
import { O11Y_KILO_GATEWAY_CLIENT_SECRET } from '@/lib/config.server';

const VALID_SUGGESTED_ACTIONS: SandboxSuggestedAction[] = [
  'dismiss',
  'open_pr',
  'manual_review',
  'monitor',
];

const log = sentryLogger('security-agent:extraction', 'info');
const logError = sentryLogger('security-agent:extraction', 'error');

// Version string for API requests - must be >= 4.69.1 to pass LLM proxy version check
const EXTRACTION_SERVICE_VERSION = '5.0.0';
const EXTRACTION_SERVICE_USER_AGENT = `Kilo-Security-Extraction/${EXTRACTION_SERVICE_VERSION}`;

/**
 * System prompt for extraction analysis
 */
const EXTRACTION_SYSTEM_PROMPT = `You are a security analyst extracting structured data from a vulnerability analysis report.

Given the raw analysis markdown and the original vulnerability details, extract the key findings into a structured format.

## Extraction Guidelines

### isExploitable
- Set to \`true\` if the analysis indicates the vulnerability CAN be exploited in this codebase
- Set to \`false\` if the analysis indicates the vulnerability CANNOT be exploited
- Set to \`"unknown"\` if the analysis was inconclusive or couldn't determine exploitability

### exploitabilityReasoning
- Summarize the key reasoning from the analysis about why the vulnerability is/isn't exploitable
- Include specific details about how the package is used
- Mention any mitigating factors or attack vectors

### usageLocations
- Extract all file paths mentioned where the vulnerable package is used
- Include line numbers if mentioned (e.g., "src/utils/helpers.ts:42")
- If no specific locations found, return an empty array

### suggestedFix
- Extract the recommended fix from the analysis
- If a patched version is mentioned, include the upgrade command
- Be specific and actionable

### suggestedAction
Choose the most appropriate next action based on the analysis:
- \`dismiss\`: The vulnerability is NOT exploitable in this codebase. Safe to dismiss.
- \`open_pr\`: The vulnerability IS exploitable AND has a clear fix. Should open a PR to fix it.
- \`manual_review\`: Complex situation - needs human review (unclear exploitability, complex fix, or multiple options).
- \`monitor\`: Exploitable but low risk - keep open but low priority (e.g., dev dependency, limited exposure).

### summary
- Create a brief 1-2 sentence summary suitable for dashboard display
- Focus on the key finding: is it exploitable and what's the recommended action`;

/**
 * Tool definition for submitting extraction results
 */
const SUBMIT_EXTRACTION_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'submit_analysis_extraction',
    description: 'Submit the extracted structured analysis from the raw markdown report',
    parameters: {
      type: 'object',
      properties: {
        isExploitable: {
          oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['unknown'] }],
          description:
            'Whether the vulnerability is exploitable in this codebase. Use true if exploitable, false if not, or "unknown" if inconclusive.',
        },
        exploitabilityReasoning: {
          type: 'string',
          description:
            'Detailed reasoning for the exploitability determination, summarized from the analysis.',
        },
        usageLocations: {
          type: 'array',
          items: { type: 'string' },
          description:
            'File paths where the vulnerable package is used. Include line numbers if available (e.g., "src/utils/helpers.ts:42").',
        },
        suggestedFix: {
          type: 'string',
          description: 'Specific fix recommendation extracted from the analysis.',
        },
        suggestedAction: {
          type: 'string',
          enum: ['dismiss', 'open_pr', 'manual_review', 'monitor'],
          description:
            'Recommended next action: dismiss (not exploitable), open_pr (exploitable with clear fix), manual_review (needs human review), monitor (low risk, keep open).',
        },
        summary: {
          type: 'string',
          description: 'Brief 1-2 sentence summary suitable for dashboard display.',
        },
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
};

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletionResponse = OpenAI.Chat.Completions.ChatCompletion;

/**
 * Build the user prompt with finding details and raw analysis
 */
function buildExtractionPrompt(finding: SecurityFinding, rawMarkdown: string): string {
  return `## Original Vulnerability Details

**Package**: ${finding.package_name} (${finding.package_ecosystem})
**Severity**: ${finding.severity}
**Dependency Scope**: ${finding.dependency_scope || 'unknown'}
**CVE**: ${finding.cve_id || 'N/A'}
**GHSA**: ${finding.ghsa_id || 'N/A'}
**Title**: ${finding.title}
**Vulnerable Versions**: ${finding.vulnerable_version_range || 'Unknown'}
**Patched Version**: ${finding.patched_version || 'No patch available'}

## Raw Analysis Report

${rawMarkdown}

---

Please extract the structured analysis from the report above and call the submit_analysis_extraction tool with your findings.`;
}

/**
 * Parse extraction result from tool call arguments
 */
function parseExtractionResult(
  args: string,
  rawMarkdown: string
): SecurityFindingSandboxAnalysis | null {
  try {
    const parsed = JSON.parse(args);

    if (typeof parsed.isExploitable !== 'boolean' && parsed.isExploitable !== 'unknown') {
      logError('Invalid isExploitable', { value: parsed.isExploitable });
      return null;
    }

    if (typeof parsed.exploitabilityReasoning !== 'string') {
      logError('Invalid exploitabilityReasoning', { value: parsed.exploitabilityReasoning });
      return null;
    }

    if (!Array.isArray(parsed.usageLocations)) {
      logError('Invalid usageLocations', { value: parsed.usageLocations });
      return null;
    }

    if (typeof parsed.suggestedFix !== 'string') {
      logError('Invalid suggestedFix', { value: parsed.suggestedFix });
      return null;
    }

    if (!VALID_SUGGESTED_ACTIONS.includes(parsed.suggestedAction)) {
      logError('Invalid suggestedAction', { value: parsed.suggestedAction });
      return null;
    }

    if (typeof parsed.summary !== 'string') {
      logError('Invalid summary', { value: parsed.summary });
      return null;
    }

    return {
      isExploitable: parsed.isExploitable,
      exploitabilityReasoning: parsed.exploitabilityReasoning,
      usageLocations: parsed.usageLocations.map(String),
      suggestedFix: parsed.suggestedFix,
      suggestedAction: parsed.suggestedAction,
      summary: parsed.summary,
      rawMarkdown,
      analysisAt: new Date().toISOString(),
    };
  } catch (error) {
    logError('Failed to parse tool arguments', { error });
    return null;
  }
}

/**
 * Create a fallback extraction result when LLM call fails
 */
function createFallbackExtraction(
  rawMarkdown: string,
  reason: string
): SecurityFindingSandboxAnalysis {
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

/**
 * Extract structured analysis fields from raw markdown output.
 * Uses direct LLM call with function calling to parse the unstructured analysis.
 *
 * @param options.finding - The security finding being analyzed
 * @param options.rawMarkdown - Raw markdown output from sandbox analysis
 * @param options.authToken - Auth token for the LLM proxy
 * @param options.model - Model to use for extraction (default: anthropic/claude-sonnet-4)
 * @param options.correlationId - Correlation ID for tracing across the analysis pipeline
 * @param options.userId - User ID for metrics tracking
 * @param options.organizationId - Optional organization ID for usage tracking
 */
export async function extractSandboxAnalysis(options: {
  finding: SecurityFinding;
  rawMarkdown: string;
  authToken: string;
  model?: string;
  correlationId?: string;
  userId?: string;
  organizationId?: string;
}): Promise<SecurityFindingSandboxAnalysis> {
  const {
    finding,
    rawMarkdown,
    authToken,
    model = 'anthropic/claude-sonnet-4',
    correlationId = '',
    userId = '',
    organizationId,
  } = options;
  log('Starting extraction', { correlationId, findingId: finding.id });

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: EXTRACTION_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: buildExtractionPrompt(finding, rawMarkdown),
    },
  ];

  try {
    const extractionResult = await startSpan(
      { name: 'security-agent.extraction', op: 'ai.inference' },
      async span => {
        span.setAttribute('security_agent.model', model);
        span.setAttribute('security_agent.finding_id', finding.id);
        span.setAttribute('security_agent.correlation_id', correlationId);

        const llmStart = performance.now();

        const result = await sendProxiedChatCompletion<ChatCompletionResponse>({
          authToken,
          version: EXTRACTION_SERVICE_VERSION,
          userAgent: EXTRACTION_SERVICE_USER_AGENT,
          body: {
            model,
            messages,
            tools: [SUBMIT_EXTRACTION_TOOL],
            tool_choice: {
              type: 'function',
              function: { name: 'submit_analysis_extraction' },
            },
          },
          organizationId,
        });

        const durationMs = Math.round(performance.now() - llmStart);
        span.setAttribute('security_agent.duration_ms', durationMs);

        if (!result.ok) {
          logError('Extraction API error', {
            correlationId,
            findingId: finding.id,
            status: result.status,
          });
          captureException(new Error(`Extraction API error: ${result.status}`), {
            tags: { operation: 'extractSandboxAnalysis' },
            extra: {
              findingId: finding.id,
              status: result.status,
              error: result.error,
              correlationId,
            },
          });

          span.setAttribute('security_agent.status', 'error');
          span.setAttribute('security_agent.is_fallback', true);

          addBreadcrumb({
            category: 'security-agent.extraction',
            message: 'Extraction fallback used',
            level: 'warning',
            data: { correlationId, findingId: finding.id, isFallback: true },
          });

          return createFallbackExtraction(rawMarkdown, `API error: ${result.status}`);
        }

        // Set token usage on span
        const usage = result.data.usage;
        if (usage) {
          span.setAttribute('security_agent.input_tokens', usage.prompt_tokens);
          span.setAttribute('security_agent.output_tokens', usage.completion_tokens);
        }

        // Emit API metrics (only if o11y client secret is configured)
        if (usage && userId && O11Y_KILO_GATEWAY_CLIENT_SECRET) {
          const responseToolCalls = result.data.choices?.[0]?.message?.tool_calls ?? [];
          const toolsUsed = responseToolCalls
            .filter(tc => tc.type === 'function')
            .map(tc => `function:${tc.function.name}`);

          emitApiMetrics({
            clientSecret: O11Y_KILO_GATEWAY_CLIENT_SECRET,
            kiloUserId: userId,
            organizationId,
            isAnonymous: false,
            isStreaming: false,
            userByok: false,
            mode: 'security-agent-extraction',
            provider: 'anthropic',
            requestedModel: model,
            resolvedModel: model,
            toolsAvailable: ['function:submit_analysis_extraction'],
            toolsUsed,
            ttfbMs: durationMs,
            completeRequestMs: durationMs,
            statusCode: 200,
            tokens: {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            },
          });
        }

        const choice = result.data.choices?.[0];
        if (!choice) {
          logError('No choice in response', { correlationId, findingId: finding.id });
          span.setAttribute('security_agent.is_fallback', true);
          return createFallbackExtraction(rawMarkdown, 'No response from LLM');
        }

        const message = choice.message;
        const toolCall = message.tool_calls?.[0];

        if (!toolCall || toolCall.type !== 'function') {
          logError('No tool call in response', { correlationId, findingId: finding.id });
          span.setAttribute('security_agent.is_fallback', true);
          return createFallbackExtraction(rawMarkdown, 'LLM did not call the extraction tool');
        }

        if (toolCall.function.name !== 'submit_analysis_extraction') {
          logError('Unexpected tool call', { correlationId, findingId: finding.id, tool: toolCall.function.name });
          span.setAttribute('security_agent.is_fallback', true);
          return createFallbackExtraction(
            rawMarkdown,
            `Unexpected tool: ${toolCall.function.name}`
          );
        }

        const parsed = parseExtractionResult(toolCall.function.arguments, rawMarkdown);
        if (!parsed) {
          span.setAttribute('security_agent.is_fallback', true);
          return createFallbackExtraction(rawMarkdown, 'Failed to parse extraction result');
        }

        log('Extraction complete', {
          correlationId,
          findingId: finding.id,
          isExploitable: parsed.isExploitable,
          usageLocationsCount: parsed.usageLocations.length,
        });

        span.setAttribute('security_agent.status', 'success');
        span.setAttribute('security_agent.is_exploitable', String(parsed.isExploitable));
        span.setAttribute('security_agent.suggested_action', parsed.suggestedAction);
        span.setAttribute('security_agent.is_fallback', false);

        addBreadcrumb({
          category: 'security-agent.extraction',
          message: `Extraction outcome: isExploitable=${parsed.isExploitable}`,
          level: 'info',
          data: {
            correlationId,
            findingId: finding.id,
            isExploitable: parsed.isExploitable,
            suggestedAction: parsed.suggestedAction,
            isFallback: false,
          },
        });

        return parsed;
      }
    );

    return extractionResult;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError('Error during extraction', {
      correlationId,
      findingId: finding.id,
      error: errorMessage,
    });
    captureException(error, {
      tags: { operation: 'extractSandboxAnalysis' },
      extra: { findingId: finding.id, correlationId },
    });

    addBreadcrumb({
      category: 'security-agent.extraction',
      message: 'Extraction fallback used',
      level: 'warning',
      data: { correlationId, findingId: finding.id, isFallback: true },
    });

    return createFallbackExtraction(rawMarkdown, errorMessage);
  }
}
