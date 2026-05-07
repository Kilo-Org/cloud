// Finish reason / stop_reason / Responses API status values observed across
// OpenAI & OpenRouter chat completions (stop, tool_calls, stop_sequence,
// length, content_filter), Vercel AI SDK (tool-calls, content-filter),
// Anthropic Messages (end_turn, tool_use, refusal, model_context_window_exceeded),
// and the OpenAI Responses API (completed, failed, incomplete, in_progress).
// `unknown` / `other` are kept as non-error catch-alls so a novel upstream
// value does not immediately inflate the error rate.

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

// `null` / `undefined` return false: an absent finish_reason is handled by
// the `wasAborted` / `reportedError` signals in the parsers, not here.
export function isErrorFinishReason(finish_reason: string | null | undefined): boolean {
  if (finish_reason == null) return false;
  return errorFinishReasonSet.has(finish_reason);
}
