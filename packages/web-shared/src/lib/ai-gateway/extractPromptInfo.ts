import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { PromptInfo } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  classifySystemPrompt,
  type SystemPromptKind,
} from '@kilocode/web-shared/lib/ai-gateway/system-prompt-kind';
import {
  extractPromptInfo as extractChatCompletionsPromptInfo,
  extractSystemPromptText,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import {
  extractMessagesPromptInfo,
  extractMessagesSystemPromptText,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.messages';
import {
  extractResponsesPromptInfo,
  extractResponsesSystemPromptText,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.responses';

export function extractPromptInfo(requestBodyParsed: GatewayRequest): PromptInfo {
  if (requestBodyParsed.kind === 'messages') {
    return extractMessagesPromptInfo(requestBodyParsed.body);
  }
  if (requestBodyParsed.kind === 'responses') {
    return extractResponsesPromptInfo(requestBodyParsed.body);
  }
  return extractChatCompletionsPromptInfo(requestBodyParsed.body);
}

/** The client guessed from the full system prompt, without reporting an unreadable body. */
export function extractSystemPromptKind(
  requestBodyParsed: GatewayRequest
): SystemPromptKind | null {
  if (requestBodyParsed.kind === 'messages') {
    return classifySystemPrompt(extractMessagesSystemPromptText(requestBodyParsed.body));
  }
  if (requestBodyParsed.kind === 'responses') {
    return classifySystemPrompt(extractResponsesSystemPromptText(requestBodyParsed.body));
  }
  try {
    return classifySystemPrompt(extractSystemPromptText(requestBodyParsed.body));
  } catch {
    return null;
  }
}
