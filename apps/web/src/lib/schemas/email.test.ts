import { describe, it, expect } from '@jest/globals';
import {
  validateMagicLinkSignupEmail,
  magicLinkSignupEmailSchema,
  MAGIC_LINK_EMAIL_ERRORS,
  isGmailAddress,
  normalizeGmailAddress,
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

describe('isGmailAddress', () => {
  it('should return true for gmail.com', () => {
    expect(isGmailAddress('henk.janssen@gmail.com')).toBe(true);
  });

  it('should return true for googlemail.com', () => {
    expect(isGmailAddress('henk.janssen@googlemail.com')).toBe(true);
  });

  it('should be case-insensitive for the domain', () => {
    expect(isGmailAddress('henk.janssen@Gmail.com')).toBe(true);
    expect(isGmailAddress('henk.janssen@GMAIL.COM')).toBe(true);
  });

  it('should return false for non-Gmail domains', () => {
    expect(isGmailAddress('henk.janssen@example.com')).toBe(false);
    expect(isGmailAddress('henk.janssen@outlook.com')).toBe(false);
    expect(isGmailAddress('henk.janssen@kilocode.ai')).toBe(false);
  });

  it('should return false for domains containing gmail but not being gmail', () => {
    expect(isGmailAddress('henk@notgmail.com')).toBe(false);
    expect(isGmailAddress('henk@gmail.com.evil.com')).toBe(false);
  });

  it('should return false for emails without @', () => {
    expect(isGmailAddress('henkjanssen')).toBe(false);
  });
});

describe('normalizeGmailAddress', () => {
  it('should strip dots from the local part of gmail.com addresses', () => {
    expect(normalizeGmailAddress('henk.janssen@gmail.com')).toBe('henkjanssen@gmail.com');
  });

  it('should strip multiple dots', () => {
    expect(normalizeGmailAddress('h.e.n.k.j.a.n.s.s.e.n@gmail.com')).toBe('henkjanssen@gmail.com');
  });

  it('should handle addresses without dots', () => {
    expect(normalizeGmailAddress('henkjanssen@gmail.com')).toBe('henkjanssen@gmail.com');
  });

  it('should work with googlemail.com', () => {
    expect(normalizeGmailAddress('henk.janssen@googlemail.com')).toBe('henkjanssen@googlemail.com');
  });

  it('should lowercase the domain', () => {
    expect(normalizeGmailAddress('henk.janssen@Gmail.COM')).toBe('henkjanssen@gmail.com');
  });

  it('should not strip dots for non-Gmail addresses', () => {
    expect(normalizeGmailAddress('henk.janssen@example.com')).toBe('henk.janssen@example.com');
  });

  it('should lowercase non-Gmail addresses without stripping dots', () => {
    expect(normalizeGmailAddress('Henk.Janssen@Example.COM')).toBe('henk.janssen@example.com');
  });

  it('should handle edge case of email without @', () => {
    expect(normalizeGmailAddress('nodomain')).toBe('nodomain');
  });
});
