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
import { getAvailableModelsForOrganization } from '@kilocode/web-shared/lib/organizations/organization-models';
import {
  addDirectByokCatalogAvailability,
  addUserByokAvailability,
  getUserByokProviderIds,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { tagOpenAiChatGptByokModels } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import { tagClaudeBillingByokModels } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/byok-models';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import type { ModelStatsLoadClient } from '@kilocode/web-shared/lib/model-stats/model-stats-cache';
import {
  addAutoRoutingModels,
  addCustomRouterModels,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-models';
import { listUsableCustomRouters } from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { appendLocalFakeDeterministicCatalogModels } from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import { requestCountryCode } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/country-deny-list';
import {
  getEnkryptBenchmarks,
  publishEnkryptModels,
} from '@kilocode/web-shared/lib/model-stats/enkrypt';
import { CATALOG_CACHE_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/handlers/catalog-cache-headers';

async function modelResponse(
  response: OpenRouterModelsResponse,
  cacheScope: keyof typeof CATALOG_CACHE_HEADERS,
  fromDb: ModelStatsLoadClient
) {
  const snapshot = await getEnkryptBenchmarks({ fromDb });
  return NextResponse.json(
    {
      ...response,
      data: publishEnkryptModels(response.data, snapshot),
    },
    { headers: CATALOG_CACHE_HEADERS[cacheScope] }
  );
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
 * The personal catalog for a signed-in caller: the enhanced model list with the
 * auto-routing entries, that caller's BYOK availability and their usable custom
 * routers, and the Enkrypt benchmarks folded in.
 *
 * Both transports answer from here — this module's REST handler and the
 * `models.selectorList` query — so a page gets the same list whether it reads
 * the catalog over `/api/openrouter/models` or over tRPC. The app shell needs
 * that: its session cookie only covers `/app-shell`, so its pages read the list
 * through `/app-shell/api/trpc`.
 */
export async function getPersonalModelList(params: {
  user: { id: string };
  countryCode: string | null;
  fromDb?: ModelStatsLoadClient;
}): Promise<OpenRouterModelsResponse> {
  const { user, countryCode, fromDb = readDb } = params;
  const data = await getEnhancedOpenRouterModels({ countryCode, fromDb });
  if (!Array.isArray(data.data)) {
    return data;
  }
  const models = await addAutoRoutingModels(data.data);

  const [byokModels, enabledByokProviderIds, directByokCatalogModelIds, customRouters] =
    await Promise.all([
      getDirectByokModelsForUser(user.id),
      getUserByokProviderIds(readDb, user.id),
      getDirectByokCatalogModelIds({ type: 'user', id: user.id }),
      usableCustomRouters({ userId: user.id, organizationId: null }),
    ]);
  const modelsWithByokAvailability = await tagClaudeBillingByokModels(
    { kind: 'personal', kiloUserId: user.id },
    await tagOpenAiChatGptByokModels(
      { kiloUserId: user.id, organizationId: null },
      addDirectByokCatalogAvailability(
        await addUserByokAvailability(models, enabledByokProviderIds),
        directByokCatalogModelIds
      )
    )
  );
  const snapshot = await getEnkryptBenchmarks({ fromDb });
  return {
    data: publishEnkryptModels(
      appendLocalFakeDeterministicCatalogModels(
        addCustomRouterModels(modelsWithByokAvailability.concat(byokModels), customRouters)
      ),
      snapshot
    ),
  };
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
    const result =
      auth?.organizationId && auth.user
        ? await getAvailableModelsForOrganization(
            auth.organizationId,
            { type: 'member', kiloUserId: auth.user.id },
            'member',
            { fromDb: readDb, countryCode }
          )
        : null;
    if (result && auth.user && auth.organizationId) {
      const [models, customRouters] = await Promise.all([
        addAutoRoutingModels(result.data),
        usableCustomRouters({ userId: auth.user.id, organizationId: auth.organizationId }),
      ]);
      return await modelResponse(
        {
          ...result,
          data: addCustomRouterModels(models, customRouters),
        },
        'perCaller',
        readDb
      );
    }

    if (!auth?.user) {
      const data = await getEnhancedOpenRouterModels({ countryCode, fromDb: readDb });
      if (!Array.isArray(data.data)) {
        // The passed-through body belongs to the catalog for this request
        // country, so it carries the same directive as the catalog response.
        return NextResponse.json(data, { headers: CATALOG_CACHE_HEADERS.sharedByCountry });
      }
      const models = await addAutoRoutingModels(data.data);
      return await modelResponse(
        {
          data: appendLocalFakeDeterministicCatalogModels(models),
        },
        'sharedByCountry',
        readDb
      );
    }

    const personal = await getPersonalModelList({
      user: auth.user,
      countryCode,
      fromDb: readDb,
    });
    // A body derived for the calling user: it must never populate a shared
    // cache entry.
    return NextResponse.json(personal, { headers: CATALOG_CACHE_HEADERS.perCaller });
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
