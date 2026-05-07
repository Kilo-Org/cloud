import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { extractPromptInfo } from '@/lib/ai-gateway/extractPromptInfo';

export function determineFallbackFeature(requestBodyParsed: GatewayRequest): 'direct-gateway' | '' {
  const { system_prompt_prefix } = extractPromptInfo(requestBodyParsed);
  if (
    system_prompt_prefix.includes('You are Kilo') ||
    system_prompt_prefix.includes('You are a personal assistant running inside OpenClaw')
  ) {
    return '';
  }
  return 'direct-gateway';
}
