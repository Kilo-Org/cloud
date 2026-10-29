import { appendAnthropicBetaHeader } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic.constants';
import type { TransformRequestContext } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

/**
 * Matches `claude-opus-5.5`, `claude-opus-5-5@20261005`, and `claude-haiku-4-5-20251001-v1:0`.
 * A minor version has at most two digits, so a date suffix is not read as one.
 */
const CLAUDE_FAMILY_AND_VERSION = /claude-([a-z]+)-(\d+)(?:[.-](\d{1,2})(?!\d))?/;

/**
 * Claude Fable 5.1 and later, and Claude Opus, Sonnet, and Haiku 5.5 and later, bind each thinking
 * block to the system prompt, tools, and earlier messages it was created with. Provider accounts
 * created on or after 2026-08-31 reject a replayed block whose prefix changed, failing the whole
 * turn. Newer models are assumed to keep binding thinking. Older models are excluded: OpenRouter's
 * Bedrock route rewrites adaptive thinking for Claude Sonnet 4.5 into a form that rejects
 * `block_binding`.
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
 */
function bindsThinkingToPrefix(model: string) {
  const match = CLAUDE_FAMILY_AND_VERSION.exec(model);
  if (!match) return false;
  const [, family, major, minor = '0'] = match;
  const [firstMajor, firstMinor] = family === 'fable' ? [5, 1] : [5, 5];
  return (
    Number(major) > firstMajor || (Number(major) === firstMajor && Number(minor) >= firstMinor)
  );
}

/**
 * Drops invalidated thinking blocks instead of failing the request. Only call this for upstreams
 * verified to forward the beta flag, since `block_binding` without it is rejected.
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
  const thinking = request.body.thinking;
  // block_binding is rejected with enabled or disabled thinking.
  if (thinking?.type !== 'adaptive') return;
  const binding = thinking.block_binding ?? {};
  if (binding.prefix_mismatch_behavior === undefined && binding.mismatch_behavior === undefined) {
    thinking.block_binding = { ...binding, prefix_mismatch_behavior: 'drop_block' };
  }
  appendAnthropicBetaHeader(extraHeaders, THINKING_BINDING_BETA);
}
