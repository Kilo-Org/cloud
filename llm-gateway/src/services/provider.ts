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
import {
  getModelUserByokProviders,
  getBYOKforUser,
  getBYOKforOrganization,
  type BYOKResult,
} from './byok.js';
import { shouldRouteToVercel } from './vercel-routing.js';

export type { BYOKResult };

type GetProviderResult = {
  provider: Provider;
  userByok: BYOKResult[] | null;
  customLlm: CustomLlm | null;
};

// The worker uses env-injected API keys instead of process.env
type ProviderConfig = {
  openrouterApiKey: string;
  vercelApiKey: string;
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
      apiKey: config.vercelApiKey,
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
  providers: ReturnType<typeof createProviders>,
  kv: KVNamespace,
  encryptionKey: string
): Promise<GetProviderResult> {
  // 1. BYOK check (if user has own keys) → route to VERCEL_AI_GATEWAY
  if (!isAnonymousContext(user)) {
    const modelProviders = await getModelUserByokProviders(requestedModel, db, kv);
    const userByok =
      modelProviders.length === 0
        ? null
        : organizationId
          ? await getBYOKforOrganization(db, organizationId, modelProviders, encryptionKey)
          : await getBYOKforUser(db, user.id, modelProviders, encryptionKey);
    if (userByok) {
      return { provider: providers.VERCEL_AI_GATEWAY, userByok, customLlm: null };
    }
  }

  // 2. Custom LLM check for kilo/ models
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

  // 3. shouldRouteToVercel check → route to VERCEL_AI_GATEWAY
  if (await shouldRouteToVercel(requestedModel, request, taskId || user.id, db, kv)) {
    return { provider: providers.VERCEL_AI_GATEWAY, userByok: null, customLlm: null };
  }

  // 4. Kilo free model check (including martian → custom LLM wrapping)
  const kiloFreeModel = kiloFreeModels.find(m => m.public_id === requestedModel);
  const freeModelProvider = kiloFreeModel
    ? Object.values(providers).find(p => p.id === kiloFreeModel.gateway)
    : undefined;

  // Martian models are wrapped as custom LLMs (gateway: 'martian' in kiloFreeModels).
  // Currently no martian provider in the worker, so this branch is inert until one is added.
  if (kiloFreeModel && freeModelProvider && (freeModelProvider.id as string) === 'martian') {
    return {
      provider: { ...freeModelProvider, id: 'custom' as const },
      userByok: null,
      customLlm: {
        public_id: kiloFreeModel.public_id,
        internal_id: kiloFreeModel.internal_id,
        display_name: kiloFreeModel.display_name,
        context_length: kiloFreeModel.context_length,
        max_completion_tokens: kiloFreeModel.max_completion_tokens,
        verbosity: null,
        provider: 'openai',
        organization_ids: [],
        base_url: freeModelProvider.apiUrl,
        api_key: freeModelProvider.apiKey,
        reasoning_effort: null,
        included_tools: null,
        excluded_tools: null,
        supports_image_input: kiloFreeModel.flags.includes('vision'),
        force_reasoning: true,
        opencode_settings: null,
      },
    };
  }

  // 5. Default → OPENROUTER
  return {
    provider: (freeModelProvider ?? providers.OPENROUTER) as Provider,
    userByok: null,
    customLlm: null,
  };
}
