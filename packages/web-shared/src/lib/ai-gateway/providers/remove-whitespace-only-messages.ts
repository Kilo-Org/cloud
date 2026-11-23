import type Anthropic from '@anthropic-ai/sdk';
import type { GatewayMessagesRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { isCacheableMessagesContentBlock } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';

function isWhitespaceOnlyText(text: unknown) {
  return typeof text === 'string' && text.trim() === '';
}

export function isWhitespaceOnlyMessage(message: Anthropic.MessageParam) {
  if (typeof message.content === 'string') {
    return isWhitespaceOnlyText(message.content);
  }
  return (
    Array.isArray(message.content) &&
    message.content.every(block => block.type === 'text' && isWhitespaceOnlyText(block.text))
  );
}

// removeWhitespaceOnlyMessages cannot reach a non-text-block breakpoint today, because its
// whitespace check requires every block of the removed message to be whitespace text. The shared
// predicate keeps this read in agreement with the write in resolveBreakpointTarget for any caller.
function findCacheControl(message: Anthropic.MessageParam) {
  if (!Array.isArray(message.content)) return undefined;
  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    const block = message.content[index];
    if (block && isCacheableMessagesContentBlock(block) && block.cache_control) {
      return block.cache_control;
    }
  }
  return undefined;
}

function withCacheControlOnBlock<T extends object>(
  content: T[],
  target: T,
  cacheControl: Anthropic.CacheControlEphemeral
): T[] {
  return content.map(block =>
    block === target ? { ...block, cache_control: cacheControl } : block
  );
}

/** Places a carried breakpoint on the message that now ends the history. */
type BreakpointTarget = (cacheControl: Anthropic.CacheControlEphemeral) => Anthropic.MessageParam;

function resolveBreakpointTarget(
  previousMessage: Anthropic.MessageParam
): BreakpointTarget | undefined {
  if (typeof previousMessage.content === 'string') {
    const text = previousMessage.content;
    return cacheControl => ({
      ...previousMessage,
      content: [{ type: 'text', text, cache_control: cacheControl }],
    });
  }
  // The role branch is deliberate: `MessageParam` is a union discriminated by `role` whose
  // `system` variant allows only text blocks, and `cache_control` is not on every
  // `ContentBlockParam` member, so one role-agnostic guard and return cannot be typed.
  if (previousMessage.role === 'system') {
    const systemMessage = previousMessage;
    const content = systemMessage.content;
    if (!Array.isArray(content)) return undefined;
    const target = content.at(-1);
    if (!target || target.cache_control) return undefined;
    return cacheControl => ({
      ...systemMessage,
      content: withCacheControlOnBlock(content, target, cacheControl),
    });
  }
  const message = previousMessage;
  const content = message.content;
  if (!Array.isArray(content)) return undefined;
  const target = content.findLast(isCacheableMessagesContentBlock);
  if (!target || target.cache_control) return undefined;
  return cacheControl => ({
    ...message,
    content: withCacheControlOnBlock(content, target, cacheControl),
  });
}

/**
 * Carries removed messages' breakpoints onto the message that ends the history. Resolves that
 * message's target once and keeps it for the following removals: an applied breakpoint leaves the
 * target block carrying it, which is what a fresh scan would find, so the tail is settled then.
 */
export function createCacheControlCarrier() {
  let retainedMessage: Anthropic.MessageParam | undefined;
  let target: BreakpointTarget | undefined;
  let resolved = false;

  return {
    keep(message: Anthropic.MessageParam): void {
      retainedMessage = message;
      target = undefined;
      resolved = false;
    },
    drop(removedMessage: Anthropic.MessageParam): Anthropic.MessageParam | undefined {
      const message = retainedMessage;
      if (!message) return undefined;
      const cacheControl = findCacheControl(removedMessage);
      if (!cacheControl) return message;
      if (!resolved) {
        resolved = true;
        target = resolveBreakpointTarget(message);
      }
      if (!target) return message;
      const carriedMessage = target(cacheControl);
      retainedMessage = carriedMessage;
      target = undefined;
      return carriedMessage;
    },
  };
}

/**
 * Anthropic rejects a message whose content is only whitespace text with "text content blocks
 * must contain non-whitespace text", while whitespace text next to any other block is accepted.
 * Such a message carries nothing for the model, so it is removed; Anthropic, Bedrock, and Vertex
 * all accept the resulting consecutive same-role messages. A final whitespace-only user message is
 * kept: removing it would end the request on an assistant message, which newer Claude models
 * reject as unsupported prefill and older ones continue instead of answering. A final
 * whitespace-only assistant prefill is removed so the request ends on the turn before it. A cache
 * breakpoint on a removed message moves to the preceding message, the closest prefix that still
 * exists.
 */
export function removeWhitespaceOnlyMessages(body: GatewayMessagesRequest) {
  const lastIndex = body.messages.length - 1;
  const keptMessages: Anthropic.MessageParam[] = [];
  const removedRoles: Anthropic.MessageParam['role'][] = [];
  const carrier = createCacheControlCarrier();

  body.messages.forEach((message, index) => {
    const isRequiredFinalMessage =
      index === lastIndex && (message.role === 'user' || keptMessages.length === 0);
    if (isRequiredFinalMessage || !isWhitespaceOnlyMessage(message)) {
      keptMessages.push(message);
      carrier.keep(message);
      return;
    }
    removedRoles.push(message.role);
    const carriedMessage = carrier.drop(message);
    if (carriedMessage) {
      keptMessages[keptMessages.length - 1] = carriedMessage;
    }
  });

  if (removedRoles.length === 0) return;

  console.warn('[removeWhitespaceOnlyMessages] removed whitespace-only messages', {
    model: body.model,
    removedAssistantMessageCount: removedRoles.filter(role => role === 'assistant').length,
    removedUserMessageCount: removedRoles.filter(role => role === 'user').length,
  });
  body.messages = keptMessages;
}
