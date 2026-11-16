import { NextResponse, type NextResponse as NextResponseType } from 'next/server';
import { type NextRequest } from 'next/server';
import { getEmbeddingProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { debugSaveProxyRequest } from '@kilocode/web-shared/lib/debugUtils';
import {
  countAndStoreEmbeddingUsage,
  extractEmbeddingPromptInfo,
  invalidRequestResponse,
  malformedJsonResponse,
  modelDoesNotExistResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import {
  getEffectiveProviderPrivacy,
  providerPreferencesSchema,
} from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import {
  buildUpstreamBody,
  type EmbeddingProxyRequest,
  validateEmbeddingDimensions,
} from '@kilocode/web-shared/lib/ai-gateway/embeddings/embedding-request';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { getVercelInferenceProviderConfigForUserByok } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { UPSTREAM_POST_RESPONSE_HEADROOM_MS } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';
import {
  accountAndRewriteUsageResponse,
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
  async resolveProvider({ requestedModelLowerCased, user, organizationId, organizationDecision }) {
    const decision = await organizationDecision();
    return await getEmbeddingProvider(
      requestedModelLowerCased,
      user,
      organizationId,
      decision?.eligibleProviderRoutes
    );
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

    // BYOK: for Vercel gateway, pass the user's key via providerOptions (same as chat completions).
    const isVercelByok = !!userByok && userByok.length > 0 && provider.type === 'vercel';
    if (isVercelByok) {
      body.model = await mapModelIdToVercel(body.model);
    }

    const effectivePrivacy = getEffectiveProviderPrivacy(
      input.requestProvider,
      input.organizationSettings?.data_collection
    );
    const upstreamBody = buildUpstreamBody(
      {
        ...body,
        ...(Object.keys(effectivePrivacy).length > 0 && {
          provider: { ...body.provider, ...effectivePrivacy },
        }),
      },
      input.requestedModelLowerCased
    );

    if (!isVercelByok) return { body: upstreamBody };

    const byokProviders: Record<string, unknown[]> = {};
    for (const byokEntry of userByok) {
      const [key, list] = getVercelInferenceProviderConfigForUserByok(byokEntry);
      byokProviders[key] = [...(byokProviders[key] ?? []), ...list];
    }
    upstreamBody.providerOptions = {
      gateway: {
        only: Object.keys(byokProviders),
        byok: byokProviders,
        zeroDataRetention: effectivePrivacy.zdr,
        disallowPromptTraining: effectivePrivacy.data_collection === 'deny' || undefined,
        // Vercel fails the request instead of leaving the region, as on chat.
        ...(dataRegion && { inferenceRegion: { scope: 'zone', geoRegion: dataRegion } }),
      },
    };
    return { body: upstreamBody, inferenceRegion: dataRegion };
  },

  accountAndRespond: upstream =>
    accountAndRewriteUsageResponse(upstream, countAndStoreEmbeddingUsage),
};

export async function handleEmbeddingsRequest(
  request: NextRequest
): Promise<NextResponseType<unknown>> {
  return await handleUsageEndpointRequest(request, embeddingsEndpoint);
}
