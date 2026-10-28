import type { CustomLlmDefinition } from '@kilocode/db/schema-types';

/** Vercel's `x-vercel-ip-country`, or null when it is absent, as in local development. */
export function requestCountryCode(headers: Headers | undefined): string | null {
  return headers?.get('x-vercel-ip-country')?.trim().toUpperCase() || null;
}

/** A request without a known country is never denied. */
export function isCustomLlmDeniedInCountry(
  definition: CustomLlmDefinition,
  countryCode: string | null
): boolean {
  return countryCode !== null && (definition.country_deny_list?.includes(countryCode) ?? false);
}
