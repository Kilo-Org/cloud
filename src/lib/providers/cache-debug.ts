import crypto from 'crypto';
import type { GatewayRequest } from '@/lib/providers/openrouter/types';
import { isAnthropicModel } from '@/lib/providers/anthropic';

/**
 * Logs a structured diagnostic payload for Anthropic chat_completions
 * requests to help debug cache hit/miss behavior.
 *
 * Call this AFTER all body mutations (tracking IDs, reasoning dedup,
 * cache breakpoints, provider-specific logic) and BEFORE forwarding upstream.
 */
export function logCacheDiagnostics(
  request: GatewayRequest,
  requestedModel: string,
  sessionId: string | null
) {
  if (request.kind !== 'chat_completions') return;
  if (!isAnthropicModel(requestedModel)) return;
  const messages = request.body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;
  const hasTools = (request.body.tools?.length ?? 0) > 0;
  if (!hasTools) return;

  try {
    // Find the breakpoint message (the one with cache_control set by addCacheBreakpoints)
    let breakpointIndex = -1;
    let breakpointRole = '<none>';
    let breakpointContentLength = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const content = msg.content;
      let hasCacheControl = false;

      if (Array.isArray(content)) {
        hasCacheControl = content.some(
          (part: unknown) =>
            typeof part === 'object' &&
            part !== null &&
            'cache_control' in part &&
            typeof (part as Record<string, unknown>).cache_control === 'object' &&
            (part as Record<string, unknown>).cache_control !== null &&
            'type' in ((part as Record<string, unknown>).cache_control as Record<string, unknown>) &&
            ((part as Record<string, unknown>).cache_control as Record<string, unknown>).type ===
              'ephemeral'
        );
        breakpointContentLength = JSON.stringify(content).length;
      } else if (typeof content === 'string') {
        breakpointContentLength = content.length;
      }

      if (hasCacheControl) {
        breakpointIndex = i;
        breakpointRole = msg.role;
        break;
      }
    }

    // Message structure summary
    const roleCounts: Record<string, number> = {};
    let totalContentBytes = 0;
    for (const msg of messages) {
      roleCounts[msg.role] = (roleCounts[msg.role] || 0) + 1;
      const c = msg.content;
      if (typeof c === 'string') {
        totalContentBytes += c.length;
      } else if (Array.isArray(c)) {
        totalContentBytes += JSON.stringify(c).length;
      }
    }

    // Count reasoning_details entries (residual after dedup)
    let reasoningDetailCount = 0;
    for (const msg of messages) {
      if ('reasoning_details' in msg && Array.isArray(msg.reasoning_details)) {
        reasoningDetailCount += msg.reasoning_details.length;
      }
    }

    // Prefix hash: SHA256 of messages[0..breakpointIndex] serialized.
    // This is the content that SHOULD be cached across consecutive requests.
    // If this hash changes between requests in the same session, the cache misses.
    let prefixHash = '<no-breakpoint>';
    let prefixBytes = 0;
    if (breakpointIndex >= 0) {
      const prefix = messages.slice(0, breakpointIndex + 1);
      const prefixJson = JSON.stringify(prefix);
      prefixBytes = prefixJson.length;
      prefixHash = crypto.createHash('sha256').update(prefixJson).digest('hex').slice(0, 16);
    }

    // Full body hash (for dedup / correlation)
    const bodyJson = JSON.stringify(request.body);
    const bodyBytes = bodyJson.length;
    const bodyHash = crypto.createHash('sha256').update(bodyJson).digest('hex').slice(0, 16);

    console.log(
      `[CacheDiag]`,
      JSON.stringify({
        sessionId: sessionId ?? '<none>',
        model: request.body.model,
        msgCount: messages.length,
        roles: roleCounts,
        reasoningDetails: reasoningDetailCount,
        breakpoint: {
          index: breakpointIndex,
          role: breakpointRole,
          contentLen: breakpointContentLength,
        },
        promptCacheKey: 'prompt_cache_key' in request.body && !!request.body.prompt_cache_key,
        prefixHash,
        prefixBytes,
        bodyHash,
        bodyBytes,
        totalContentBytes,
      })
    );
  } catch (err) {
    // Never let diagnostic logging break the request
    console.warn('[CacheDiag] error:', err);
  }
}
