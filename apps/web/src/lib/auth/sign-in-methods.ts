import type { AuthProviderId } from '@/lib/auth/provider-metadata';
import { ProdNonSSOAuthProviders } from '@/lib/auth/provider-metadata';

const supportedProviders = new Set<string>(ProdNonSSOAuthProviders);

function getSupportedProviders(providerIds: readonly string[]): AuthProviderId[] {
  const providers = providerIds.filter(
    (providerId, index): providerId is AuthProviderId =>
      supportedProviders.has(providerId) && providerIds.indexOf(providerId) === index
  );
  const googleIndex = providers.indexOf('google');
  if (googleIndex > 0) {
    providers.unshift(providers.splice(googleIndex, 1)[0]);
  }
  return providers;
}

export type SignInMethodResolution =
  | { kind: 'automatic-oauth'; provider: AuthProviderId }
  | { kind: 'automatic-email'; provider: 'email' }
  | { kind: 'provider-select'; providers: AuthProviderId[] }
  | { kind: 'no-supported-method' };

/** Filters discovery output without changing the globally shared provider order. */
export function resolveSignInMethods(providerIds: readonly string[]): SignInMethodResolution {
  const providers = getSupportedProviders(providerIds);

  if (providers.length === 0) return { kind: 'no-supported-method' };
  if (providers.length > 1) return { kind: 'provider-select', providers };
  if (providers[0] === 'email') return { kind: 'automatic-email', provider: 'email' };
  return { kind: 'automatic-oauth', provider: providers[0] };
}

/** Orders the server-authorized account-creation methods for presentation. */
export function orderNewAccountProviders(providerIds: readonly string[]): AuthProviderId[] {
  return getSupportedProviders(providerIds);
}
