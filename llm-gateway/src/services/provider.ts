import { eq } from 'drizzle-orm';
import { custom_llm, type CustomLlm, type User } from '@kilocode/db/schema';
import {
  type Provider,
  type AnonymousUserContext,
  isAnonymousContext,
  kiloFreeModels,
} from '@kilocode/llm-shared';
import type { OpenRouterChatCompletionRequest } from '@kilocode/llm-shared';
import type { WorkerDb } from '../lib/db.js';

// BYOKResult is a simplified version for the worker
type BYOKResult = {
  providerId: string;
  decryptedAPIKey: string;
};

type GetProviderResult = {
  provider: Provider;
  userByok: BYOKResult[] | null;
  customLlm: CustomLlm | null;
};

// The worker uses env-injected API keys instead of process.env
type ProviderConfig = {
  openrouterApiKey: string;
};

export function createProviders(config: ProviderConfig) {
  const PROVIDERS = {
    OPENROUTER: {
      id: 'openrouter' as const,
      apiUrl: 'https://openrouter.ai/api/v1',
      apiKey: config.openrouterApiKey,
      hasGenerationEndpoint: true,
    },
    VERCEL_AI_GATEWAY: {
      id: 'vercel' as const,
      apiUrl: 'https://ai-gateway.vercel.sh/v1',
      apiKey: '', // Populated from secrets if needed
      hasGenerationEndpoint: true,
    },
  } satisfies Record<string, Provider>;

  return PROVIDERS;
}

export async function getProvider(
  requestedModel: string,
  request: OpenRouterChatCompletionRequest,
  user: User | AnonymousUserContext,
  organizationId: string | undefined,
  taskId: string | undefined,
  db: WorkerDb,
  providers: ReturnType<typeof createProviders>
): Promise<GetProviderResult> {
  // Custom LLM check for org users
  if (requestedModel.startsWith('kilo/') && organizationId) {
    const [customLlmRecord] = await db
      .select()
      .from(custom_llm)
      .where(eq(custom_llm.public_id, requestedModel));
    if (customLlmRecord && customLlmRecord.organization_ids.includes(organizationId)) {
      return {
        provider: {
          id: 'custom',
          apiUrl: customLlmRecord.base_url,
          apiKey: customLlmRecord.api_key,
          hasGenerationEndpoint: true,
        },
        userByok: null,
        customLlm: customLlmRecord,
      };
    }
  }

  // Check kilo free models
  const kiloFreeModel = kiloFreeModels.find(m => m.public_id === requestedModel);
  const freeModelProvider = kiloFreeModel
    ? Object.values(providers).find(p => p.id === kiloFreeModel.gateway)
    : undefined;

  return {
    provider: (freeModelProvider ?? providers.OPENROUTER) as Provider,
    userByok: null,
    customLlm: null,
  };
}
