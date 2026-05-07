/**
 * Finish reasons that indicate the model completed its turn in an expected way.
 * Includes:
 *   - OpenAI/OpenRouter chat completion: `stop`, `tool_calls`, `stop_sequence`
 *   - Vercel AI SDK style:               `tool-calls`
 *   - Anthropic Messages API:            `end_turn`, `tool_use`, `stop_sequence`
 *   - OpenAI Responses API:              `completed`
 *   - Catch-alls we cannot classify:     `unknown`, `other`
 */
export const NON_ERROR_FINISH_REASONS = [
  'stop',
  'tool_calls',
  'tool-calls',
  'end_turn',
  'completed',
  'tool_use',
  'stop_sequence',
  'unknown',
  'other',
] as const;

/**
 * Finish reasons that mean the response was truncated, refused, or upstream
 * failed in some way. Records carrying these values should be flagged as
 * errors so they show up in dashboards / alerts.
 */
export const ERROR_FINISH_REASONS = [
  'length',
  'max_tokens',
  'content_filter',
  'content-filter',
  'error',
  'network_error',
  'failed',
  'model_context_window_exceeded',
  'engine_overloaded',
  'refusal',
  'incomplete',
  'in_progress',
] as const;

const errorFinishReasonSet: ReadonlySet<string> = new Set(ERROR_FINISH_REASONS);

/**
 * Returns true if the given finish_reason indicates an upstream error,
 * truncation, refusal, or other failure. `null` is treated as non-error
 * (it means we never observed a finish_reason, which is handled separately
 * by the `wasAborted` / `reportedError` signals).
 */
export function isErrorFinishReason(finish_reason: string | null | undefined): boolean {
  if (finish_reason == null) return false;
  return errorFinishReasonSet.has(finish_reason);
}
