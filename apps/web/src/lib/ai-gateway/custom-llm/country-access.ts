/**
 * Determines whether a request is allowed to access a custom LLM based on its
 * `country_codes` allow-list.
 *
 * `country_codes` are ISO 3166-1 alpha-2 codes (e.g. "US", "GB") sourced from
 * Vercel's `x-vercel-ip-country` request header. Comparison is
 * case-insensitive and trims surrounding whitespace.
 *
 * Semantics:
 * - An absent or empty `allowedCountries` list disables the restriction
 *   (every country is allowed).
 * - When a non-empty list is configured and the request country cannot be
 *   determined (`requestCountry` is null or empty), access is denied
 *   (fail-closed) so a misconfigured or spoofed header cannot bypass the
 *   intended geographic restriction.
 */
export function isCountryAllowed(
  allowedCountries: readonly string[] | undefined,
  requestCountry: string | null
): boolean {
  if (!allowedCountries || allowedCountries.length === 0) {
    return true;
  }
  const normalizedRequestCountry = requestCountry?.trim().toUpperCase() ?? null;
  if (!normalizedRequestCountry) {
    return false;
  }
  const normalizedAllowed = new Set(allowedCountries.map(code => code.toUpperCase()));
  return normalizedAllowed.has(normalizedRequestCountry);
}
