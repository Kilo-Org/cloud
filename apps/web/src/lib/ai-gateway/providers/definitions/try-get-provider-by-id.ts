import { MARTIAN } from '@/lib/ai-gateway/providers/definitions/martian';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@/lib/ai-gateway/providers/definitions/vercel';
import type { Provider, ProviderId } from '@/lib/ai-gateway/providers/types';

export function tryGetProviderById(providerId: ProviderId): Provider | undefined {
  switch (providerId) {
    case 'openrouter':
      return OPENROUTER;
    case 'martian':
      return MARTIAN;
    case 'vercel':
      return VERCEL_AI_GATEWAY;
    default:
      return undefined;
  }
}
