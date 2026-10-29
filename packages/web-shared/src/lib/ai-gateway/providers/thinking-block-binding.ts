import { appendAnthropicBetaHeader } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic.constants';
import type { TransformRequestContext } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

/**
 * These models bind each thinking block to the system prompt, tools, and earlier messages it was
 * created with. Provider accounts created on or after 2026-08-31 reject a replayed block whose
 * prefix changed, failing the whole turn. Older models are excluded: OpenRouter's Bedrock route
 * rewrites adaptive thinking for Claude Sonnet 4.5 into a form that rejects `block_binding`.
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
 */
const BINDS_THINKING_TO_PREFIX = /claude-(?:fable-5[.-]1|(?:opus|sonnet|haiku)-5[.-]5)(?!\d)/;

/**
 * Drops invalidated thinking blocks instead of failing the request. Only call this for upstreams
 * verified to forward the beta flag, since `block_binding` without it is rejected.
 */
export function dropThinkingBlocksOnPrefixMismatch({
  model,
  request,
  extraHeaders,
}: Pick<TransformRequestContext, 'model' | 'request' | 'extraHeaders'>) {
  if (request.kind !== 'messages' || !BINDS_THINKING_TO_PREFIX.test(model)) return;
  const thinking = request.body.thinking;
  // block_binding is rejected with enabled or disabled thinking.
  if (thinking?.type !== 'adaptive') return;
  const binding = thinking.block_binding ?? {};
  if (binding.prefix_mismatch_behavior === undefined && binding.mismatch_behavior === undefined) {
    thinking.block_binding = { ...binding, prefix_mismatch_behavior: 'drop_block' };
  }
  appendAnthropicBetaHeader(extraHeaders, THINKING_BINDING_BETA);
}
