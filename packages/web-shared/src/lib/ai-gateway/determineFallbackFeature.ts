import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { extractSystemPromptKind } from '@kilocode/web-shared/lib/ai-gateway/extractPromptInfo';

export function determineFallbackFeature(
  requestBodyParsed: GatewayRequest,
  userAgent: string | null
): 'direct-gateway' | '' {
  if (userAgent?.startsWith('Kilo-Code/')) return '';
  const systemPromptKind = extractSystemPromptKind(requestBodyParsed);
  if (systemPromptKind === 'kilo' || systemPromptKind === 'openclaw') return '';
  return 'direct-gateway';
}
