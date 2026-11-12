import type Anthropic from '@anthropic-ai/sdk';
import type { GatewayMessagesRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

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

function findCacheControl(message: Anthropic.MessageParam) {
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .filter(block => block.type === 'text')
    .findLast(block => block.cache_control)?.cache_control;
}

function isCacheableBlock(
  block: Anthropic.ContentBlockParam
): block is Exclude<
  Anthropic.ContentBlockParam,
  Anthropic.ThinkingBlockParam | Anthropic.RedactedThinkingBlockParam
> {
  return block.type !== 'thinking' && block.type !== 'redacted_thinking';
}

/** Carries a removed message's breakpoint without mutating the retained history. */
export function preserveCacheControl(
  previousMessage: Anthropic.MessageParam,
  removedMessage: Anthropic.MessageParam
): Anthropic.MessageParam {
  const cacheControl = findCacheControl(removedMessage);
  if (!cacheControl) return previousMessage;
  if (typeof previousMessage.content === 'string') {
    return {
      ...previousMessage,
      content: [{ type: 'text', text: previousMessage.content, cache_control: cacheControl }],
    };
  }
  if (!Array.isArray(previousMessage.content)) return previousMessage;
  const target = previousMessage.content.findLast(isCacheableBlock);
  if (!target || target.cache_control) return previousMessage;
  return {
    ...previousMessage,
    content: previousMessage.content.map(block =>
      block === target ? { ...block, cache_control: cacheControl } : block
    ),
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

  body.messages.forEach((message, index) => {
    const isRequiredFinalMessage =
      index === lastIndex && (message.role === 'user' || keptMessages.length === 0);
    if (isRequiredFinalMessage || !isWhitespaceOnlyMessage(message)) {
      keptMessages.push(message);
      return;
    }
    removedRoles.push(message.role);
    const previousMessage = keptMessages.at(-1);
    if (previousMessage) {
      keptMessages[keptMessages.length - 1] = preserveCacheControl(previousMessage, message);
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
