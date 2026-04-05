import * as z from 'zod';

export const emailSchema = z.object({
  email: z.email({ message: 'Please enter a valid email address' }),
});

/**
 * Error codes for magic link signup email validation.
 * These match the error codes handled in AuthErrorNotification.
 */
export const MAGIC_LINK_EMAIL_ERRORS = {
  LOWERCASE: 'EMAIL-MUST-BE-LOWERCASE',
  NO_PLUS: 'EMAIL-CANNOT-CONTAIN-PLUS',
} as const;

/**
 * Domain that is allowed to use + in email addresses for internal testing.
 */
const KILOCODE_DOMAIN = '@kilocode.ai';

/**
 * Checks if an email is from the kilocode.ai domain.
 * Uses strict matching to ensure the domain is exactly @kilocode.ai,
 * not a subdomain or lookalike (e.g., @henkkilocode.ai).
 */
function isKilocodeDomain(email: string): boolean {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return false;
  const domain = email.slice(atIndex).toLowerCase();
  return domain === KILOCODE_DOMAIN;
}

/**
 * Validates that an email is suitable for magic link signup:
 * - Must be lowercase
 * - Must not contain a + character (except for @kilocode.ai emails)
 *
 * This is NOT enforced during sign-in to existing accounts.
 * Returns error codes that can be displayed via AuthErrorNotification.
 */
export function validateMagicLinkSignupEmail(email: string): {
  valid: boolean;
  error: string | null;
} {
  if (email !== email.toLowerCase()) {
    return { valid: false, error: MAGIC_LINK_EMAIL_ERRORS.LOWERCASE };
  }
  if (email.includes('+') && !isKilocodeDomain(email)) {
    return { valid: false, error: MAGIC_LINK_EMAIL_ERRORS.NO_PLUS };
  }
  return { valid: true, error: null };
}

export const magicLinkSignupEmailSchema = z
  .email({ message: 'Please enter a valid email address' })
  .refine(email => email === email.toLowerCase(), {
    message: 'Email address must be lowercase',
  })
  .refine(email => !email.includes('+') || isKilocodeDomain(email), {
    message: 'Email address cannot contain a + character',
  });
