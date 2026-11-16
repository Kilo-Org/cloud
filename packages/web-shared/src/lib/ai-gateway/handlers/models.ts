import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { OpenRouterModelsResponse } from '@kilocode/web-shared/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  getDirectByokCatalogModelIds,
  getDirectByokModelsForUser,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { organizationMemberCatalog, usableCustomRouters } from './organization-catalog';
import {
  addDirectByokCatalogAvailability,
  addUserByokAvailability,
  getUserByokProviderIds,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { tagOpenAiChatGptByokModels } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  addAutoRoutingModels,
  addCustomRouterModels,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-models';
import { appendLocalFakeDeterministicCatalogModels } from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import { requestCountryCode } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/country-deny-list';
import {
  getEnkryptBenchmarks,
  publishEnkryptModels,
} from '@kilocode/web-shared/lib/model-stats/enkrypt';

async function modelResponse(response: OpenRouterModelsResponse) {
  const snapshot = await getEnkryptBenchmarks({ fromDb: readDb });
  return NextResponse.json({
    ...response,
    data: publishEnkryptModels(response.data, snapshot),
  });
}

async function tryGetUserFromAuth() {
  try {
    return await getUserFromAuth({
      adminOnly: false,
      expectedAudience: KILO_GATEWAY_AUDIENCE,
    });
  } catch (e) {
    console.error('[tryGetUserFromAuth] failed to get user from auth', e);
    return { user: null, organizationId: null };
  }
}

/**
 * Test using:
 * curl -vvv 'http://localhost:3000/api/openrouter/models'
 */
export async function handleModelsRequest(
  request: Request
): Promise<NextResponse<{ error: string; message?: string } | OpenRouterModelsResponse>> {
  const auth = await tryGetUserFromAuth();
  const countryCode = requestCountryCode(request.headers);
  try {
    if (auth?.organizationId && auth.user) {
      const catalog = await organizationMemberCatalog({
        organizationId: auth.organizationId,
        kiloUserId: auth.user.id,
        countryCode,
        endpoint: 'openrouter/models',
      });
      if (catalog) {
        return await modelResponse(catalog);
      }
    }

    const data = await getEnhancedOpenRouterModels({ countryCode, fromDb: readDb });
    if (!Array.isArray(data.data)) {
      return NextResponse.json(data);
    }
    const models = await addAutoRoutingModels(data.data);
    if (!auth?.user) {
      return await modelResponse({
        data: appendLocalFakeDeterministicCatalogModels(models),
      });
    }

    const [byokModels, enabledByokProviderIds, directByokCatalogModelIds, customRouters] =
      await Promise.all([
        getDirectByokModelsForUser(auth.user.id),
        getUserByokProviderIds(readDb, auth.user.id),
        getDirectByokCatalogModelIds({ type: 'user', id: auth.user.id }),
        usableCustomRouters({
          userId: auth.user.id,
          organizationId: null,
          endpoint: 'openrouter/models',
        }),
      ]);
    const modelsWithByokAvailability = await tagOpenAiChatGptByokModels(
      { kiloUserId: auth.user.id, organizationId: null },
      addDirectByokCatalogAvailability(
        await addUserByokAvailability(models, enabledByokProviderIds),
        directByokCatalogModelIds
      )
    );
    return await modelResponse({
      data: appendLocalFakeDeterministicCatalogModels(
        addCustomRouterModels(modelsWithByokAvailability.concat(byokModels), customRouters)
      ),
    });
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'openrouter/models' },
      extra: {
        action: 'fetching_models',
        userId: auth?.user?.id,
        organizationId: auth?.organizationId,
      },
    });
    return NextResponse.json(
      { error: 'Failed to fetch models', message: 'Error from OpenRouter API' },
      { status: 500 }
    );
  }
}
