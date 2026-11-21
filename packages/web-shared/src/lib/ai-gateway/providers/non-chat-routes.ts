import type { User } from '@kilocode/db/schema';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { isAnonymousContext, type AnonymousUserContext } from '@kilocode/web-shared/lib/anonymous';
import {
  byokOwner,
  getStoredByokKeys,
  isGatewayUserByokEligibleModel,
  type ByokKeyState,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { createByokRouteRank } from '@kilocode/web-shared/lib/ai-gateway/byok/route-order';
import { getAllowedGatewayRoutedByokProviders } from '@kilocode/web-shared/lib/ai-gateway/providers/route-plan';
import { isGatewayUserByokProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { getVercelModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  createUserOpenRouterProvider,
  OPENROUTER,
} from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import {
  createUserVercelAiGatewayProvider,
  VERCEL_AI_GATEWAY,
} from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import type { BYOKResult, Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

/**
 * The Vercel model `type` of a non-chat endpoint's models: `embedding` for embeddings and
 * `evaluation` for System One decisions.
 */
export type NonChatVercelModelType = 'embedding' | 'evaluation';

export type NonChatRoute = {
  provider: Provider;
  /** The owner's keys that pay for the route, or null when Kilo pays. */
  userByok: BYOKResult[] | null;
};

/**
 * Whether the Vercel AI Gateway serves the model under the id `mapModelIdToVercel` maps it to.
 * The request names an OpenRouter catalog id: models only Vercel serves are deliberately not
 * supported on these endpoints yet (see `packages/web-shared/AGENTS.md`).
 */
export async function isVercelNonChatModel(
  requestedModel: string,
  modelType: NonChatVercelModelType
): Promise<boolean> {
  const [vercelModels, vercelModelId] = await Promise.all([
    getVercelModelsMetadataFromDatabase(),
    mapModelIdToVercel(requestedModel),
  ]);
  return vercelModels[vercelModelId]?.type === modelType;
}

async function loadEnabledKeysInRouteOrder(
  user: User,
  organizationId: string | undefined
): Promise<{ keys: ByokKeyState[]; decrypt: (key: ByokKeyState) => Promise<BYOKResult> }> {
  const stored = await getStoredByokKeys(readDb, byokOwner(user.id, organizationId));
  const rank = createByokRouteRank(stored.keys);
  return {
    keys: stored.keys
      .filter(key => key.isEnabled)
      .toSorted((a, b) => rank(a.providerId) - rank(b.providerId)),
    decrypt: key => stored.decrypt(key.providerId),
  };
}

/**
 * Picks the route of an embeddings or System One request. In the owner's BYOK route order, the
 * first enabled key that serves the model takes it:
 *
 * - a provider key the Vercel AI Gateway serves the mapped model with; every such key of the owner
 *   then travels with the request, as chat's Vercel BYOK route does,
 * - the owner's OpenRouter key, which serves any model OpenRouter does,
 * - the owner's Vercel AI Gateway key, when Vercel serves the mapped model.
 *
 * Direct BYOK keys never serve these endpoints. Free models are Kilo-funded, so gateway keys never
 * serve them, as on chat.
 * Without a key Kilo pays: through OpenRouter, or through Kilo's Vercel AI Gateway when the
 * organization disabled OpenRouter and Vercel serves the mapped model. Kilo's Vercel opt-out list
 * does not apply to these endpoints; the gateway settings decide afterwards whether the route may
 * serve the request.
 */
export async function resolveEmbeddingOrDecisionRoute(input: {
  requestedModel: string;
  modelType: NonChatVercelModelType;
  user: User | AnonymousUserContext;
  organizationId: string | undefined;
  /** The OpenRouter provider slugs the organization policy allows, or undefined for any. */
  allowedProviders: ReadonlySet<string> | undefined;
  openRouterDisabled: boolean;
}): Promise<NonChatRoute> {
  const { requestedModel, modelType, user, organizationId } = input;
  let vercelServesModel: Promise<boolean> | undefined;
  const servesOnVercel = () =>
    (vercelServesModel ??= isVercelNonChatModel(requestedModel, modelType));

  if (!isAnonymousContext(user)) {
    const allowedProviderIds = await getAllowedGatewayRoutedByokProviders(requestedModel, {
      includeGatewayKeys: isGatewayUserByokEligibleModel(requestedModel),
      getAllowedProviders: async () => input.allowedProviders,
    });
    if (allowedProviderIds.length > 0) {
      const { keys, decrypt } = await loadEnabledKeysInRouteOrder(user, organizationId);
      const candidates = keys.filter(key => allowedProviderIds.includes(key.providerId));
      for (const key of candidates) {
        if (key.providerId === 'openrouter') {
          const credential = await decrypt(key);
          return {
            provider: createUserOpenRouterProvider(credential.decryptedAPIKey),
            userByok: [credential],
          };
        }
        if (key.providerId === 'vercel-ai-gateway') {
          if (!(await servesOnVercel())) continue;
          const credential = await decrypt(key);
          return {
            provider: createUserVercelAiGatewayProvider(credential.decryptedAPIKey),
            userByok: [credential],
          };
        }
        if (!(await servesOnVercel())) continue;
        const providerKeys = candidates.filter(
          candidate => !isGatewayUserByokProviderId(candidate.providerId)
        );
        // One undecryptable key does not fail the request while another still decrypts. When none
        // does, fail closed so the request never falls back to a route Kilo pays for.
        const results = await Promise.allSettled(providerKeys.map(decrypt));
        const credentials = results.flatMap(result =>
          result.status === 'fulfilled' ? [result.value] : []
        );
        if (credentials.length === 0) {
          const [failure] = results;
          throw failure?.status === 'rejected' ? failure.reason : new Error('No provider key');
        }
        return { provider: VERCEL_AI_GATEWAY, userByok: credentials };
      }
    }
  }

  if (input.openRouterDisabled && (await servesOnVercel())) {
    return { provider: VERCEL_AI_GATEWAY, userByok: null };
  }
  return { provider: OPENROUTER, userByok: null };
}

/**
 * Picks the route of a transcription request. Transcriptions run only on OpenRouter: through the
 * owner's enabled OpenRouter key, otherwise on Kilo's account. The organization provider
 * allow-list does not restrict gateway keys, as on chat.
 */
export async function resolveTranscriptionRoute(input: {
  requestedModel: string;
  user: User | AnonymousUserContext;
  organizationId: string | undefined;
}): Promise<NonChatRoute> {
  const { requestedModel, user, organizationId } = input;
  if (!isAnonymousContext(user) && isGatewayUserByokEligibleModel(requestedModel)) {
    const { keys, decrypt } = await loadEnabledKeysInRouteOrder(user, organizationId);
    const key = keys.find(candidate => candidate.providerId === 'openrouter');
    if (key) {
      const credential = await decrypt(key);
      return {
        provider: createUserOpenRouterProvider(credential.decryptedAPIKey),
        userByok: [credential],
      };
    }
  }
  return { provider: OPENROUTER, userByok: null };
}
