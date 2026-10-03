import {
  assistantReportsNoActionableOutput,
  classifyAssistantFailure,
} from '../../src/shared/assistant-failure.js';
import { GITHUB_REVIEW_TOOL_PERMISSION_KEY } from '../../src/shared/github-review-target.js';

export const PUBLICATION_RECOVERY_DEADLINE_MS = 90_000;

export const PUBLICATION_RECOVERY_PROMPT =
  'Publish the review summary by calling the code_review_publish_review_summary tool with the wording only; do not use gh for the summary.';

const NO_PROMPT_ERROR_CODES = new Set([
  'locked',
  'rate_limited',
  'scan_limit',
  'forbidden',
  'misconfigured',
]);

export type PublicationRecoverySignal =
  | { kind: 'verified'; commentId: number }
  | { kind: 'error'; code: string };

export type PublicationRecoveryDecision = 'seal' | 'prompt';

/**
 * One-shot recovery decision for a terminal batch that did not verify a
 * publication. Verified results and terminal tool errors seal without a
 * prompt; a missing, rejected, or unverified result prompts once while the
 * batch budget is unused. Output-limit endings never prompt.
 */
export function decidePublicationRecovery(input: {
  configured: boolean;
  outputLimit: boolean;
  signal: PublicationRecoverySignal | null;
  budgetUsed: boolean;
}): PublicationRecoveryDecision {
  if (!input.configured) return 'seal';
  if (input.outputLimit) return 'seal';
  if (input.signal?.kind === 'verified') return 'seal';
  if (input.signal?.kind === 'error' && NO_PROMPT_ERROR_CODES.has(input.signal.code)) return 'seal';
  if (input.budgetUsed) return 'seal';
  return 'prompt';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a verified publication or a terminal tool error from a root tool part.
 * The CLI names an MCP tool `<server>_<tool>`, so the part's `tool` is the
 * permission key `code_review_publish_review_summary`, not the bare server tool
 * name. A completed part must carry a string output that parses to
 * `{ verified: true, commentId }`; an error part carries the tool's error code.
 * Anything else is ignored.
 */
export function classifyPublicationToolPart(part: unknown): PublicationRecoverySignal | null {
  if (!isRecord(part) || part.tool !== GITHUB_REVIEW_TOOL_PERMISSION_KEY) return null;
  const toolState = part.state;
  if (!isRecord(toolState)) return null;
  if (toolState.status === 'completed') {
    if (typeof toolState.output !== 'string') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolState.output);
    } catch {
      return null;
    }
    if (!isRecord(parsed) || parsed.verified !== true || typeof parsed.commentId !== 'number') {
      return null;
    }
    return { kind: 'verified', commentId: parsed.commentId };
  }
  if (toolState.status === 'error') {
    const raw = typeof toolState.error === 'string' ? toolState.error : '';
    const code = raw.split(':')[0]?.trim();
    return { kind: 'error', code: code && code.length > 0 ? code : 'unverified' };
  }
  return null;
}

export { assistantReportsNoActionableOutput };

/**
 * True when a root assistant message carries the structured output-limit error
 * (the SDK `MessageOutputLengthError`), so the wrapper marks the output-limit
 * predicate before idle and never sends a publication recovery prompt.
 */
export function messageInfoReportsOutputLimit(info: unknown): boolean {
  if (!isRecord(info)) return false;
  const error = info.error;
  if (error === undefined || error === null) return false;
  return classifyAssistantFailure(error).reason === 'output_limit';
}
