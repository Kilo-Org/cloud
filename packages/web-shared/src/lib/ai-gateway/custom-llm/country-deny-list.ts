import type { CustomLlmDefinition } from '@kilocode/db/schema-types';
import { getCustomLlmsById } from './custom-llm-catalog';

/** Vercel's `x-vercel-ip-country`, or null when it is absent, as in local development. */
export function requestCountryCode(headers: Headers): string | null {
  return headers.get('x-vercel-ip-country')?.trim().toUpperCase() || null;
}

/** A request without a known country is never denied. */
export function isCustomLlmDeniedInCountry(
  definition: CustomLlmDefinition,
  countryCode: string | null
): boolean {
  return countryCode !== null && (definition.country_deny_list?.includes(countryCode) ?? false);
}

export async function withoutCustomLlmsDeniedInCountry<T extends { id: string }>(
  models: T[],
  countryCode: string | null
): Promise<T[]> {
  if (countryCode === null) return models;
  const customLlmsById = await getCustomLlmsById();
  return models.filter(model => {
    const customLlm = customLlmsById.get(model.id.toLowerCase());
    return !customLlm || !isCustomLlmDeniedInCountry(customLlm.definition, countryCode);
  });
}
