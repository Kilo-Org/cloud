import * as z from 'zod';

/**
 * Normalizes a company domain input. Accepts bare domains or full URLs.
 * Returns just the hostname, or null if the input is empty/whitespace.
 *
 * Unicode/IDN domains are preserved in their original form (e.g. "münchen.de").
 *
 * Examples:
 *   "acme.com" → "acme.com"
 *   "https://acme.com" → "acme.com"
 *   "https://acme.com/about" → "acme.com"
 *   "http://www.acme.com" → "www.acme.com"
 *   "münchen.de" → "münchen.de"
 *   "  " → null
 *   "" → null
 */
export function normalizeCompanyDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let hostname = trimmed;

  // If it looks like a URL (has ://), extract the hostname manually
  if (trimmed.includes('://')) {
    try {
      // Extract hostname between :// and the next /, ?, #, or :
      const afterProtocol = trimmed.split('://')[1];
      if (afterProtocol) {
        hostname = afterProtocol.split(/[/?#:]/)[0];
      }
    } catch {
      // Fall through to treat as bare domain
    }
  } else {
    // Extract hostname from bare domain (before /, ?, #, or :)
    hostname = trimmed.split(/[/?#:]/)[0];
  }

  return hostname || null;
}

// Basic domain format regex: allows subdomains, hyphens, unicode characters, requires TLD of 2+ chars
// Using \p{L} for unicode letters, \p{N} for unicode numbers (requires 'u' flag)
// Each label must start and end with alphanumeric, can contain hyphens in the middle
const DOMAIN_REGEX =
  /^[\p{L}\p{N}]([\p{L}\p{N}-]*[\p{L}\p{N}])?(\.[\p{L}\p{N}]([\p{L}\p{N}-]*[\p{L}\p{N}])?)*\.[\p{L}]{2,}$/u;

/**
 * Validates that a string looks like a valid domain.
 * Accepts both ASCII and unicode (IDN) domains.
 */
export function isValidDomain(domain: string): boolean {
  if (!DOMAIN_REGEX.test(domain) || domain.length > 253) return false;
  return domain.split('.').every(label => label.length > 0 && label.length <= 63);
}

/**
 * Zod schema that normalizes and validates a company domain.
 *
 * Input: string (bare domain or full URL)
 * Output: string (validated domain) or null (if input was empty/whitespace)
 */
export const CompanyDomainSchema = z
  .string()
  .transform(normalizeCompanyDomain)
  .pipe(
    z
      .string()
      .refine(isValidDomain, { message: 'Please enter a valid domain (e.g. acme.com)' })
      .nullable()
  );
