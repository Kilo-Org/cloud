import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { PromptInfo } from '@/lib/ai-gateway/processUsage.types';
import { extractPromptInfo as extractChatCompletionsPromptInfo } from '@/lib/ai-gateway/processUsage';
import { extractMessagesPromptInfo } from '@/lib/ai-gateway/processUsage.messages';
import { extractResponsesPromptInfo } from '@/lib/ai-gateway/processUsage.responses';

export function extractPromptInfo(requestBodyParsed: GatewayRequest): PromptInfo {
  if (requestBodyParsed.kind === 'messages') {
    return extractMessagesPromptInfo(requestBodyParsed.body);
  }
  if (requestBodyParsed.kind === 'responses') {
    return extractResponsesPromptInfo(requestBodyParsed.body);
  }
  return extractChatCompletionsPromptInfo(requestBodyParsed.body);
}
