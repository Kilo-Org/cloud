import * as z from 'zod';

export const emailSchema = z.object({
  email: z.email({ message: 'Please enter a valid email address' }),
});

/**
 * Error codes for magic link signup email validation.
 * These match the error codes handled in AuthErrorNotification.
 */
export const MAGIC_LINK_EMAIL_ERRORS = {
  INVALID_FORMAT: 'EMAIL-INVALID-FORMAT',
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

const emailFormatSchema = z.email();

/**
 * The magic link signup rules, shared by `validateMagicLinkSignupEmail` and
 * `magicLinkSignupEmailSchema` so both enforce the same rule set.
 */
const isSyntacticallyValid = (email: string): boolean => emailFormatSchema.safeParse(email).success;
const isLowercase = (email: string): boolean => email === email.toLowerCase();
const hasAllowedPlus = (email: string): boolean => !email.includes('+') || isKilocodeDomain(email);

/**
 * Validates that an email is suitable for magic link signup:
 * - Must be a syntactically valid address
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
  if (!isSyntacticallyValid(email)) {
    return { valid: false, error: MAGIC_LINK_EMAIL_ERRORS.INVALID_FORMAT };
  }
  if (!isLowercase(email)) {
    return { valid: false, error: MAGIC_LINK_EMAIL_ERRORS.LOWERCASE };
  }
  if (!hasAllowedPlus(email)) {
    return { valid: false, error: MAGIC_LINK_EMAIL_ERRORS.NO_PLUS };
  }
  return { valid: true, error: null };
}

export const magicLinkSignupEmailSchema = z
  .email({ message: 'Please enter a valid email address' })
  .refine(isLowercase, {
    message: 'Email address must be lowercase',
  })
  .refine(hasAllowedPlus, {
    message: 'Email address cannot contain a + character',
  });
