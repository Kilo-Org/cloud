import { appendAnthropicBetaHeader } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/beta-header';
import {
  getClaudeVersion,
  isClaudeModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/claude-model';
import type { TransformRequestContext } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  isWhitespaceOnlyMessage,
  preserveCacheControl,
} from '@kilocode/web-shared/lib/ai-gateway/providers/remove-whitespace-only-messages';

const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

/**
 * Claude models of every family from version 5.1 on, including `-latest` aliases, are matched.
 * The models known to bind each thinking block to its system prompt, tools, and earlier messages are Fable
 * 5.1 and Opus, Sonnet, and Haiku 5.5, and newer models are assumed to keep doing so. Provider
 * accounts created on or after 2026-08-31 reject a replayed block whose prefix changed, failing the
 * whole turn. Older models are excluded: OpenRouter's Bedrock route rewrites adaptive thinking for
 * Claude Sonnet 4.5 into a form that rejects `block_binding`.
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
 */
function bindsThinkingToPrefix(model: string) {
  if (isClaudeModel(model) && model.endsWith('-latest')) return true;
  const version = getClaudeVersion(model);
  if (!version) return false;
  return version.major > 5 || (version.major === 5 && version.minor >= 1);
}

/**
 * Drops invalidated thinking blocks instead of failing the request. Adaptive thinking delegates
 * this to the upstream; explicit nonadaptive modes remove historical thinking before forwarding.
 * Only call this for upstreams verified to forward the beta flag, since `block_binding` without
 * it is rejected.
 *
 * Kilo and opencode clients change the prefix of a running session in normal use. The 400 error
 * names what changed; from most to least common in production:
 * - "The `system` prompt differs": the system prompt changes on agent switches and AGENTS.md
 *   edits, and it includes the date.
 * - "Content before this block differs from when it was created, first at `messages.N...`": most
 *   likely because clients clear old tool outputs and replace earlier media with placeholders
 *   after compaction.
 * - "The `tools` list differs": the tools list changes on agent switches, permission changes, and
 *   MCP server updates.
 * - "Content that preceded this block when it was created is missing": context compaction keeps
 *   the most recent turns verbatim, including their thinking, after the summary, so the history
 *   those turns were created with is gone.
 * - "This block was created as the first `thinking` block after its prompt, but another one now
 *   precedes it": thinking blocks were reordered or inserted, which is rare.
 */
export function dropThinkingBlocksOnPrefixMismatch({
  model,
  request,
  extraHeaders,
}: Pick<TransformRequestContext, 'model' | 'request' | 'extraHeaders'>) {
  if (request.kind !== 'messages' || !bindsThinkingToPrefix(model)) return;
  appendAnthropicBetaHeader(extraHeaders, THINKING_BINDING_BETA);
  // These models default to adaptive thinking when the client omits the setting.
  const thinking = (request.body.thinking ??= { type: 'adaptive' });
  if (thinking.type !== 'adaptive') {
    // block_binding is adaptive-only. Remove whole blocks, including signatures and redacted data,
    // without changing the explicit mode or touching nested tool results and user content.
    const messages: typeof request.body.messages = [];
    for (const message of request.body.messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) {
        messages.push(message);
        continue;
      }
      const content = message.content.filter(
        block => block.type !== 'thinking' && block.type !== 'redacted_thinking'
      );
      if (content.length === message.content.length) {
        messages.push(message);
        continue;
      }
      const strippedMessage = { ...message, content };
      if (!isWhitespaceOnlyMessage(strippedMessage)) {
        messages.push(strippedMessage);
        continue;
      }
      const previousMessage = messages.at(-1);
      if (previousMessage) {
        messages[messages.length - 1] = preserveCacheControl(previousMessage, strippedMessage);
      }
    }
    request.body.messages = messages;
    return;
  }
  const binding = thinking.block_binding ?? {};
  if (binding.prefix_mismatch_behavior === undefined && binding.mismatch_behavior === undefined) {
    thinking.block_binding = { ...binding, prefix_mismatch_behavior: 'drop_block' };
  }
}
