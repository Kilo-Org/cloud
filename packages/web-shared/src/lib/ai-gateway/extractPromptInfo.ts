import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { PromptInfo } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { extractPromptInfo as extractChatCompletionsPromptInfo } from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import { extractMessagesPromptInfo } from '@kilocode/web-shared/lib/ai-gateway/processUsage.messages';
import { extractResponsesPromptInfo } from '@kilocode/web-shared/lib/ai-gateway/processUsage.responses';
import { extractGenerateContentPromptInfo } from '@kilocode/web-shared/lib/ai-gateway/processUsage.generateContent';

export function extractPromptInfo(requestBodyParsed: GatewayRequest): PromptInfo {
  if (requestBodyParsed.kind === 'messages') {
    return extractMessagesPromptInfo(requestBodyParsed.body);
  }
  if (requestBodyParsed.kind === 'responses') {
    return extractResponsesPromptInfo(requestBodyParsed.body);
  }
  if (requestBodyParsed.kind === 'generate_content') {
    return extractGenerateContentPromptInfo(requestBodyParsed.body);
  }
  return extractChatCompletionsPromptInfo(requestBodyParsed.body);
}
