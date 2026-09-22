import { ALIBABA } from '@/lib/ai-gateway/providers/definitions/alibaba';
import { LONGCAT } from '@/lib/ai-gateway/providers/definitions/longcat';
import { MARTIAN } from '@/lib/ai-gateway/providers/definitions/martian';
import { MISTRAL } from '@/lib/ai-gateway/providers/definitions/mistral';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import { SEED } from '@/lib/ai-gateway/providers/definitions/seed';
import { STREAMLAKE } from '@/lib/ai-gateway/providers/definitions/streamlake';
import { VERCEL_AI_GATEWAY } from '@/lib/ai-gateway/providers/definitions/vercel';
import type { Provider, ProviderId } from '@/lib/ai-gateway/providers/types';

export function tryGetProviderById(providerId: ProviderId): Provider | undefined {
  switch (providerId) {
    case 'openrouter':
      return OPENROUTER;
    case 'alibaba':
      return ALIBABA;
    case 'seed':
      return SEED;
    case 'longcat':
      return LONGCAT;
    case 'martian':
      return MARTIAN;
    case 'mistral':
      return MISTRAL;
    case 'streamlake':
      return STREAMLAKE;
    case 'vercel':
      return VERCEL_AI_GATEWAY;
    default:
      return undefined;
  }
}
