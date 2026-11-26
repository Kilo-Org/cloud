import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { PromptInfo } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
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

/** The first 100 characters of the system prompt, for classifying a request. Never recorded. */
export function extractSystemPromptPrefix(requestBodyParsed: GatewayRequest): string {
  if (requestBodyParsed.kind === 'messages') {
    return extractMessagesSystemPromptText(requestBodyParsed.body).slice(0, 100);
  }
  if (requestBodyParsed.kind === 'responses') {
    return extractResponsesSystemPromptText(requestBodyParsed.body).slice(0, 100);
  }
  try {
    return extractSystemPromptText(requestBodyParsed.body).slice(0, 100);
  } catch {
    return '';
  }
}
