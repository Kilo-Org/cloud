import { describe, it, expect } from '@jest/globals';
import {
  validateMagicLinkSignupEmail,
  magicLinkSignupEmailSchema,
  MAGIC_LINK_EMAIL_ERRORS,
} from './email';

describe('validateMagicLinkSignupEmail', () => {
  it('should accept valid lowercase email without +', () => {
    const result = validateMagicLinkSignupEmail('user@example.com');
    expect(result).toEqual({ valid: true, error: null });
  });

  it('should reject email with uppercase characters', () => {
    const result = validateMagicLinkSignupEmail('User@Example.com');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.LOWERCASE });
  });

  it('should reject email with + character for non-kilocode domains', () => {
    const result = validateMagicLinkSignupEmail('user+tag@example.com');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.NO_PLUS });
  });

  it('should allow email with + character for @kilocode.ai domain', () => {
    const result = validateMagicLinkSignupEmail('user+tag@kilocode.ai');
    expect(result).toEqual({ valid: true, error: null });
  });

  it('should reject email with + character for lookalike domains ending in kilocode.ai', () => {
    // @henkkilocode.ai ends with "kilocode.ai" but is not the @kilocode.ai domain
    const result = validateMagicLinkSignupEmail('mark+klaas@henkkilocode.ai');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.NO_PLUS });
  });

  it('should reject email with both uppercase and +', () => {
    // Uppercase check happens first
    const result = validateMagicLinkSignupEmail('User+tag@Example.com');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.LOWERCASE });
  });

  it('should reject uppercase @kilocode.ai email even with +', () => {
    // Uppercase check happens first, even for kilocode.ai
    const result = validateMagicLinkSignupEmail('User+tag@kilocode.ai');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.LOWERCASE });
  });

  it('should reject an address without a valid email format', () => {
    const result = validateMagicLinkSignupEmail('not-an-email');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.INVALID_FORMAT });
  });

  it('should reject an invalid format before the signup policy rules', () => {
    const result = validateMagicLinkSignupEmail('NOT-AN-EMAIL');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.INVALID_FORMAT });
  });

  it('should reject an uppercase address in a single-letter domain', () => {
    const result = validateMagicLinkSignupEmail('A@b.com');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.LOWERCASE });
  });

  it('should reject a plus address outside the kilocode.ai domain', () => {
    const result = validateMagicLinkSignupEmail('a+b@example.com');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.NO_PLUS });
  });
});

describe('magic link signup email rule set', () => {
  it.each([
    'user@example.com',
    'user+tag@kilocode.ai',
    'a+b@example.com',
    'A@b.com',
    'not-an-email',
    'NOT-AN-EMAIL',
    '',
    'user@',
    '@example.com',
    'user@example',
  ])('applies the same verdict in both exports for %o', email => {
    expect(validateMagicLinkSignupEmail(email).valid).toBe(
      magicLinkSignupEmailSchema.safeParse(email).success
    );
  });
});

describe('magicLinkSignupEmailSchema', () => {
  it('should accept valid lowercase email without +', () => {
    const result = magicLinkSignupEmailSchema.safeParse('user@example.com');
    expect(result.success).toBe(true);
  });

  it('should reject invalid email format', () => {
    const result = magicLinkSignupEmailSchema.safeParse('not-an-email');
    expect(result.success).toBe(false);
  });

  it('should reject email with uppercase characters', () => {
    const result = magicLinkSignupEmailSchema.safeParse('User@Example.com');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Email address must be lowercase');
    }
  });

  it('should reject email with + character for non-kilocode domains', () => {
    const result = magicLinkSignupEmailSchema.safeParse('user+tag@example.com');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Email address cannot contain a + character');
    }
  });

  it('should allow email with + character for @kilocode.ai domain', () => {
    const result = magicLinkSignupEmailSchema.safeParse('user+tag@kilocode.ai');
    expect(result.success).toBe(true);
  });

  it('should reject email with + character for lookalike domains ending in kilocode.ai', () => {
    // @henkkilocode.ai ends with "kilocode.ai" but is not the @kilocode.ai domain
    const result = magicLinkSignupEmailSchema.safeParse('mark+klaas@henkkilocode.ai');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Email address cannot contain a + character');
    }
  });
});
