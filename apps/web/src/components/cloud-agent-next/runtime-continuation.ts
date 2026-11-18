import { isTextPart, type Part } from './types';

export type RuntimeContinuationReason = 'interrupted' | 'restarted' | 'output-limit';

export type RuntimeContinuation = {
  reason: RuntimeContinuationReason;
  text: string;
};

/**
 * Exact synthetic prompts the kilo2 runtime publishes to continue a turn
 * (pinned CLI 0.0.0-v2-104). The runtime gives them no distinguishing
 * metadata, so the text is the only signal; match it exactly and only on a
 * synthetic part so typed or pasted user text keeps the user bubble.
 */
export const RUNTIME_CONTINUATION_PROMPTS = {
  interrupted:
    'The previous response was interrupted. Continue from where you left off without repeating completed content.',
  restarted:
    'The server restarted while you were working. Continue from where you left off without repeating completed work.',
  'output-limit':
    'Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.',
} satisfies Record<RuntimeContinuationReason, string>;

const PROMPT_REASONS = new Map<string, RuntimeContinuationReason>([
  [RUNTIME_CONTINUATION_PROMPTS.interrupted, 'interrupted'],
  [RUNTIME_CONTINUATION_PROMPTS.restarted, 'restarted'],
  [RUNTIME_CONTINUATION_PROMPTS['output-limit'], 'output-limit'],
]);

export function parseRuntimeContinuation(parts: Part[]): RuntimeContinuation | null {
  const visible = parts.filter(part => !(isTextPart(part) && part.ignored === true));
  const [part] = visible;
  if (visible.length !== 1 || !isTextPart(part) || part.synthetic !== true) return null;
  const text = part.text.trim();
  const reason = PROMPT_REASONS.get(text);
  return reason === undefined ? null : { reason, text };
}
