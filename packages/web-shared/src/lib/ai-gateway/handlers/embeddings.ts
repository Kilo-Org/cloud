import { NextResponse, type NextResponse as NextResponseType } from 'next/server';
import { type NextRequest } from 'next/server';
import { getEmbeddingProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { debugSaveProxyRequest } from '@kilocode/web-shared/lib/debugUtils';
import {
  countAndStoreEmbeddingUsage,
  extractEmbeddingPromptInfo,
  invalidRequestResponse,
  makeErrorReadable,
  malformedJsonResponse,
  modelDoesNotExistResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import {
  getEffectiveProviderPrivacy,
  providerPreferencesSchema,
} from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import { emitApiMetricsForResponse } from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server';
import { getCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import {
  responseUsageContext,
  rewriteBilledResponse_UsageEndpoint,
} from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.usageEndpoints';
import {
  buildUpstreamBody,
  type EmbeddingProxyRequest,
  validateEmbeddingDimensions,
} from '@kilocode/web-shared/lib/ai-gateway/embeddings/embedding-request';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { getUsageEndpointGatewayOptions } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { UPSTREAM_POST_RESPONSE_HEADROOM_MS } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';
import {
  handleUsageEndpointRequest,
  type UsageEndpoint,
} from '@kilocode/web-shared/lib/ai-gateway/handlers/usage-endpoint-pipeline';

/**
 * The embeddings route's `maxDuration` is 300s. The upstream call gets what is
 * left after the post-response headroom chat reserves for its usage work.
 */
export const EMBEDDINGS_UPSTREAM_DURATION_BUDGET_MS =
  300 * 1000 - UPSTREAM_POST_RESPONSE_HEADROOM_MS;

const embeddingsEndpoint: UsageEndpoint<EmbeddingProxyRequest> = {
  apiKind: 'embeddings',
  spanPrefix: 'embedding',
  path: '/embeddings',
  durationBudgetMs: EMBEDDINGS_UPSTREAM_DURATION_BUDGET_MS,
  defaultFeature: 'embeddings',
  allowAnonymousFreeModels: true,

  // The body is parsed before auth: whether the model is free decides anonymous access.
  async parse(request) {
    const requestBodyText = await request.text();
    debugSaveProxyRequest(requestBodyText);
    let body: EmbeddingProxyRequest;
    try {
      body = JSON.parse(requestBodyText) as EmbeddingProxyRequest;
    } catch (e) {
      return { kind: 'rejected', response: malformedJsonResponse(e) };
    }

    if (typeof body.model !== 'string' || body.model.trim().length === 0) {
      return { kind: 'rejected', response: modelDoesNotExistResponse() };
    }

    if (body.input == null) {
      return { kind: 'rejected', response: invalidRequestResponse() };
    }

    const requestPrivacy = providerPreferencesSchema.optional().safeParse(body.provider);
    if (!requestPrivacy.success) return { kind: 'rejected', response: invalidRequestResponse() };

    return {
      kind: 'parsed',
      body,
      model: body.model.trim(),
      requestProvider: requestPrivacy.data,
      promptInfo: extractEmbeddingPromptInfo(body),
    };
  },

  // The provider depends on the routes the organization member may use, so the decision is
  // resolved first.
  async resolveProvider({
    requestedModelLowerCased,
    user,
    organizationId,
    organizationDecision,
    gatewaySettings,
  }) {
    const decision = await organizationDecision();
    return await getEmbeddingProvider(requestedModelLowerCased, user, organizationId, {
      allowedProviders: decision?.eligibleProviderRoutes,
      openRouterDisabled: gatewaySettings.openRouterDisabled,
    });
  },

  validate(body, requestedModelLowerCased) {
    const dimensionError = validateEmbeddingDimensions(body, requestedModelLowerCased);
    if (!dimensionError) return null;
    return NextResponse.json(
      {
        error: {
          message: dimensionError,
          type: 'invalid_request_error',
          param: 'dimensions',
          code: null,
        },
      },
      { status: 400 }
    );
  },

  async buildUpstreamBody(input) {
    const { body, provider, userByok, dataRegion } = input;
    if (input.organizationProvider) body.provider = input.organizationProvider;
    body.safety_identifier = input.safetyIdentifier;

    const effectivePrivacy = getEffectiveProviderPrivacy(
      input.requestProvider,
      input.organizationSettings?.data_collection
    );
    const providerPreferences =
      Object.keys(effectivePrivacy).length > 0
        ? { ...body.provider, ...effectivePrivacy }
        : body.provider;
    if (provider.type !== 'vercel') {
      return {
        body: buildUpstreamBody(
          { ...body, ...(providerPreferences && { provider: providerPreferences }) },
          input.requestedModelLowerCased
        ),
      };
    }

    // Vercel names models by its own ids and takes routing options under `providerOptions`.
    body.model = await mapModelIdToVercel(body.model);
    const upstreamBody = buildUpstreamBody(
      { ...body, provider: undefined },
      input.requestedModelLowerCased
    );
    upstreamBody.providerOptions = {
      gateway: getUsageEndpointGatewayOptions({
        userByok,
        provider: { ...input.organizationProvider, ...effectivePrivacy },
        dataRegion,
      }),
    };
    return { body: upstreamBody, inferenceRegion: dataRegion };
  },

  accountAndRespond: async upstream => {
    const { response, usageContext, provider, userByok } = upstream;
    // makeErrorReadable reads a clone, which must be taken before the accounting reads the body.
    const errorResponse = response.status >= 400 ? response.clone() : null;
    const accounting = countAndStoreEmbeddingUsage(
      response,
      usageContext,
      upstream.requestSpan,
      provider
    );
    emitApiMetricsForResponse(
      upstream.metricsParams,
      accounting.statsPromise,
      upstream.requestStartedAt
    );

    if (errorResponse) {
      const readableError = await makeErrorReadable({
        provider: provider.type,
        requestedModel: upstream.requestedModelLowerCased,
        request: null,
        response: errorResponse,
        userByokProviderIds: userByok?.map(byok => byok.providerId) ?? null,
      });
      if (readableError) return readableError;
    }

    // The accounting reads the body once; the response reports the cost the ledger row bills.
    return await rewriteBilledResponse_UsageEndpoint({
      response,
      body: accounting.bodyPromise,
      billed: accounting.pricedStatsPromise,
      usageContext: responseUsageContext(usageContext, await getCustomPricingConfig()),
      vercelRequestId: upstream.vercelRequestId,
    });
  },
};

export async function handleEmbeddingsRequest(
  request: NextRequest
): Promise<NextResponseType<unknown>> {
  return await handleUsageEndpointRequest(request, embeddingsEndpoint);
}
