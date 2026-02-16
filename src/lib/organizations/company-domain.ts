import * as z from 'zod';

/**
 * Normalizes a company domain input. Accepts bare domains or full URLs.
 * Returns just the hostname, or null if the input is empty/whitespace.
 *
 * Examples:
 *   "acme.com" → "acme.com"
 *   "https://acme.com" → "acme.com"
 *   "https://acme.com/about" → "acme.com"
 *   "http://www.acme.com" → "www.acme.com"
 *   "  " → null
 *   "" → null
 */
export function normalizeCompanyDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // If it looks like a URL (has ://), try to parse it
  if (trimmed.includes('://')) {
    try {
      const url = new URL(trimmed);
      return url.hostname;
    } catch {
      // Fall through to treat as bare domain
    }
  }

  // Try adding https:// to see if it parses as a URL
  try {
    const url = new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return trimmed; // Return as-is if nothing works
  }
}

// Basic domain format regex: allows subdomains, hyphens, requires TLD of 2+ chars
const DOMAIN_REGEX =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

/**
 * Validates that a string looks like a valid domain.
 */
export function isValidDomain(domain: string): boolean {
  return DOMAIN_REGEX.test(domain) && domain.length <= 253;
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
