import { z } from 'zod';
import type { OpenRouterProviderConfig } from './providers/openrouter/types';

export const providerPrivacySchema = z.object({
  data_collection: z.enum(['allow', 'deny']).optional(),
  zdr: z.boolean().optional(),
});

const providerIdsSchema = z
  .array(z.string())
  .nullish()
  .transform(value => value ?? undefined);

/**
 * Validates the request `provider` fields the gateway reads itself. Parsing strips other fields,
 * so callers forward the original object to keep the remaining OpenRouter options.
 */
export const providerPreferencesSchema = providerPrivacySchema.extend({
  order: providerIdsSchema,
  only: providerIdsSchema,
  ignore: providerIdsSchema,
});

/**
 * The provider preferences the gateway forwards upstream: the caller's own object with the
 * organization's requirements applied over it. `none` means no provider satisfies both the
 * caller's list and the organization's routes, so no upstream may serve the request.
 */
export type ComposedProviderPreferences =
  | { kind: 'eligible'; provider: OpenRouterProviderConfig | undefined }
  | { kind: 'none' };

/**
 * Composes the caller's provider object with the organization's provider policy.
 *
 * The caller keeps every field it sent. The organization's data-collection policy and route
 * ceiling take precedence: `effectivePrivacy` overrides the privacy fields, and `only` becomes
 * the caller's list intersected with the organization's routes, minus every provider the caller
 * ignores. A caller's empty `only` list means no restriction, matching how upstreams read it.
 */
export function composeProviderPreferences(params: {
  requestProvider: OpenRouterProviderConfig | undefined;
  /** The organization's eligible provider routes, without the virtual provider. */
  organizationOnly: readonly string[] | undefined;
  effectivePrivacy: Pick<OpenRouterProviderConfig, 'data_collection' | 'zdr'>;
}): ComposedProviderPreferences {
  const { requestProvider, organizationOnly, effectivePrivacy } = params;
  const requestOnly = requestProvider?.only?.length ? requestProvider.only : undefined;
  const requestIgnore = requestProvider?.ignore ?? [];
  const only = organizationOnly
    ? (requestOnly ?? organizationOnly).filter(
        provider => organizationOnly.includes(provider) && !requestIgnore.includes(provider)
      )
    : requestOnly;
  if (only?.length === 0) return { kind: 'none' };
  if (!requestProvider && !only && Object.keys(effectivePrivacy).length === 0) {
    return { kind: 'eligible', provider: undefined };
  }
  return {
    kind: 'eligible',
    provider: { ...requestProvider, ...effectivePrivacy, ...(only && { only }) },
  };
}

export function getEffectiveProviderPrivacy(
  requestProvider: Pick<OpenRouterProviderConfig, 'data_collection' | 'zdr'> | undefined,
  organizationDataCollection?: OpenRouterProviderConfig['data_collection'] | null
): Pick<OpenRouterProviderConfig, 'data_collection' | 'zdr'> {
  const dataCollection =
    requestProvider?.data_collection === 'deny' || organizationDataCollection === 'deny'
      ? 'deny'
      : (organizationDataCollection ?? requestProvider?.data_collection);

  return {
    ...(dataCollection !== undefined && { data_collection: dataCollection }),
    ...(requestProvider?.zdr !== undefined && { zdr: requestProvider.zdr }),
  };
}
