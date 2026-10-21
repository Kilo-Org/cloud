import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { OpenRouterModelsResponse } from '@kilocode/web-shared/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { getDirectByokModelsForUser } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { getAvailableModelsForOrganization } from '@kilocode/web-shared/lib/organizations/organization-models';
import {
  addUserByokAvailability,
  getUserByokProviderIds,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { tagOpenAiChatGptByokModels } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  addAutoRoutingModels,
  addCustomRouterModels,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-models';
import { listUsableCustomRouters } from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { appendLocalFakeDeterministicCatalogModels } from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import {
  getEnkryptBenchmarks,
  publishEnkryptModels,
} from '@kilocode/web-shared/lib/model-stats/enkrypt';

async function modelResponse(response: OpenRouterModelsResponse) {
  const snapshot = await getEnkryptBenchmarks();
  return NextResponse.json({
    ...response,
    data: publishEnkryptModels(response.data, snapshot),
  });
}

async function usableCustomRouters(params: { userId: string; organizationId: string | null }) {
  try {
    return await listUsableCustomRouters(params);
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'openrouter/models' },
      extra: { action: 'listing_custom_routers', ...params },
    });
    return [];
  }
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
export async function handleModelsRequest(): Promise<
  NextResponse<{ error: string; message?: string } | OpenRouterModelsResponse>
> {
  const auth = await tryGetUserFromAuth();
  try {
    const result =
      auth?.organizationId && auth.user
        ? await getAvailableModelsForOrganization(
            auth.organizationId,
            { type: 'member', kiloUserId: auth.user.id },
            'member',
            readDb
          )
        : null;
    if (result && auth.user && auth.organizationId) {
      const [models, customRouters] = await Promise.all([
        addAutoRoutingModels(result.data),
        usableCustomRouters({ userId: auth.user.id, organizationId: auth.organizationId }),
      ]);
      return await modelResponse({
        ...result,
        data: addCustomRouterModels(models, customRouters),
      });
    }

    const data = await getEnhancedOpenRouterModels();
    if (!Array.isArray(data.data)) {
      return NextResponse.json(data);
    }
    const models = await addAutoRoutingModels(data.data);
    if (!auth?.user) {
      return await modelResponse({
        data: appendLocalFakeDeterministicCatalogModels(models),
      });
    }

    const [byokModels, enabledByokProviderIds, customRouters] = await Promise.all([
      getDirectByokModelsForUser(auth.user.id),
      getUserByokProviderIds(readDb, auth.user.id),
      usableCustomRouters({ userId: auth.user.id, organizationId: null }),
    ]);
    const modelsWithByokAvailability = await tagOpenAiChatGptByokModels(
      { kiloUserId: auth.user.id, organizationId: null },
      await addUserByokAvailability(models, enabledByokProviderIds)
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
