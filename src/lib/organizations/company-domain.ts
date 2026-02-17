import * as z from 'zod';

/**
 * Normalizes a company domain input. Accepts bare domains or full URLs.
 * Returns just the hostname, or null if the input is empty/whitespace.
 *
 * Unicode/IDN domains are preserved in their original form (e.g. "münchen.de").
 *
 * We avoid new URL() because it punycode-encodes unicode hostnames
 * and domainToUnicode() from node:url isn't available in the browser.
 */
export function normalizeCompanyDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let authority = trimmed;

  // Strip protocol
  const protoEnd = authority.indexOf('://');
  if (protoEnd !== -1) authority = authority.slice(protoEnd + 3);

  // Strip userinfo (user:pass@)
  const atIndex = authority.indexOf('@');
  if (atIndex !== -1) authority = authority.slice(atIndex + 1);

  // Extract hostname (before port, path, query, or fragment)
  const hostname = authority.split(/[/:?#]/)[0];

  return hostname || null;
}

// Each label: starts/ends with letter or digit, may contain hyphens in the middle.
// TLD must be 2+ chars. Supports unicode via \p{L} and \p{N}.
const DOMAIN_REGEX =
  /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}][\p{L}\p{N}-]*[\p{L}\p{N}]$/u;

/**
 * Validates that a string looks like a valid domain.
 * Accepts ASCII, unicode (IDN), and punycode domains.
 */
export function isValidDomain(domain: string): boolean {
  if (domain.length > 253) return false;
  if (!DOMAIN_REGEX.test(domain)) return false;
  return domain.split('.').every(label => label.length <= 63);
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
