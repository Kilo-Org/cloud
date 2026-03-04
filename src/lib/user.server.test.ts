import { describe, test, expect } from '@jest/globals';
import {
  isEmailBlacklistedByDomain,
  isBlockedTLD,
  parseLinkedInProfileName,
  getUserUUID,
  uuidSchema,
} from './user.server';
import type { User } from '@kilocode/db/schema';
import { v5 as uuidv5 } from 'uuid';

// Same namespace UUID used in user.server.ts
const USER_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('isEmailBlacklistedByDomain', () => {
  test('should return false when blacklisted_domains is undefined', () => {
    const result = isEmailBlacklistedByDomain('test@example.com', undefined);
    expect(result).toBe(false);
  });

  test('should return false when blacklisted_domains is empty array', () => {
    const result = isEmailBlacklistedByDomain('test@example.com', []);
    expect(result).toBe(false);
  });

  test('should return false when email domain is not in blacklist', () => {
    const blacklist = ['spam.com', 'malicious.org'];
    const result = isEmailBlacklistedByDomain('user@legitimate.com', blacklist);
    expect(result).toBe(false);
  });

  test('should return true when email domain matches blacklisted domain with @', () => {
    const blacklist = ['spam.com', 'malicious.org'];
    const result = isEmailBlacklistedByDomain('user@spam.com', blacklist);
    expect(result).toBe(true);
  });

  test('should return true for subdomain with @ pattern', () => {
    const blacklist = ['example.com'];
    const result = isEmailBlacklistedByDomain('user@sub.example.com', blacklist);
    expect(result).toBe(true);
  });

  test('should handle multiple domains in blacklist', () => {
    const blacklist = ['spam.com', 'malicious.org', 'bad.net'];

    expect(isEmailBlacklistedByDomain('user@spam.com', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('user@malicious.org', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('user@bad.net', blacklist)).toBe(true);

    expect(isEmailBlacklistedByDomain('user@good.com', blacklist)).toBe(false);
  });

  test('should be case insensitive', () => {
    const blacklist = ['spam.com'];
    const result = isEmailBlacklistedByDomain('user@SPAM.COM', blacklist);
    expect(result).toBe(true); // Case insensitive, so should match
  });

  test('should handle edge case with domain as part of username', () => {
    const blacklist = ['spam.com'];
    const result = isEmailBlacklistedByDomain('spam.com@legitimate.org', blacklist);
    expect(result).toBe(false);
  });

  test('should match exact domain endings correctly', () => {
    const blacklist = ['evil.com'];

    // Should match
    expect(isEmailBlacklistedByDomain('user@evil.com', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('something.evil.com', blacklist)).toBe(true);

    // Should NOT match
    expect(isEmailBlacklistedByDomain('user@notevil.com', blacklist)).toBe(false);
    expect(isEmailBlacklistedByDomain('user@evil.com.fake', blacklist)).toBe(false);
  });

  test('should handle mixed case in both email and blacklist', () => {
    const blacklist = ['EXAMPLE.COM', 'Test-Domain.ORG'];
    expect(isEmailBlacklistedByDomain('user@example.com', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('USER@EXAMPLE.COM', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('user@test-domain.org', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('USER@TEST-DOMAIN.ORG', blacklist)).toBe(true);
  });

  test('should handle case insensitive subdomain matching', () => {
    const blacklist = ['EXAMPLE.COM'];
    expect(isEmailBlacklistedByDomain('user.sub.example.com', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('user.SUB.EXAMPLE.COM', blacklist)).toBe(true);
    expect(isEmailBlacklistedByDomain('user.Sub.Example.Com', blacklist)).toBe(true);
  });
});

describe('isBlockedTLD', () => {
  const blockedTlds = ['.shop', '.top'];

  test('should block .shop TLD', () => {
    expect(isBlockedTLD('user@example.shop', blockedTlds)).toBe(true);
  });

  test('should block .top TLD', () => {
    expect(isBlockedTLD('user@example.top', blockedTlds)).toBe(true);
  });

  test('should block subdomains under blocked TLDs', () => {
    expect(isBlockedTLD('user@sub.domain.shop', blockedTlds)).toBe(true);
    expect(isBlockedTLD('user@sub.domain.top', blockedTlds)).toBe(true);
  });

  test('should allow .com, .org, .io TLDs', () => {
    expect(isBlockedTLD('user@example.com', blockedTlds)).toBe(false);
    expect(isBlockedTLD('user@example.org', blockedTlds)).toBe(false);
    expect(isBlockedTLD('user@example.io', blockedTlds)).toBe(false);
  });

  test('should be case insensitive', () => {
    expect(isBlockedTLD('user@example.SHOP', blockedTlds)).toBe(true);
    expect(isBlockedTLD('user@example.TOP', blockedTlds)).toBe(true);
    expect(isBlockedTLD('USER@EXAMPLE.Shop', blockedTlds)).toBe(true);
  });

  test('should not block domains containing blocked TLD as a non-TLD part', () => {
    expect(isBlockedTLD('user@shop.example.com', blockedTlds)).toBe(false);
    expect(isBlockedTLD('user@top.example.com', blockedTlds)).toBe(false);
    expect(isBlockedTLD('user@myshop.com', blockedTlds)).toBe(false);
    expect(isBlockedTLD('user@topnotch.com', blockedTlds)).toBe(false);
  });

  test('should return false when blocklist is empty', () => {
    expect(isBlockedTLD('user@example.shop', [])).toBe(false);
  });

  test('should handle multi-part TLDs like .co.uk', () => {
    const withMultiPart = ['.shop', '.co.uk'];
    expect(isBlockedTLD('user@example.co.uk', withMultiPart)).toBe(true);
    expect(isBlockedTLD('user@example.com', withMultiPart)).toBe(false);
    expect(isBlockedTLD('user@example.uk', withMultiPart)).toBe(false);
  });
});

/**
 * This test verifies the LinkedIn profile name parsing logic
 * to prevent the production error: TypeError: e.default[b] is not a function
 * https://kilo-code.sentry.io/issues/7080760666
 */
describe('parseLinkedInProfileName', () => {
  test('should use profile.name when available', () => {
    const result = parseLinkedInProfileName({ name: 'John Doe' });
    expect(result).toBe('John Doe');
    expect(typeof result).toBe('string');
  });

  test('should combine given_name and family_name when both present', () => {
    const result = parseLinkedInProfileName({
      given_name: 'John',
      family_name: 'Doe',
    });
    expect(result).toBe('John Doe');
    expect(typeof result).toBe('string');
  });

  test('should use given_name only when family_name is missing', () => {
    const result = parseLinkedInProfileName({ given_name: 'John' });
    expect(result).toBe('John');
    expect(typeof result).toBe('string');
  });

  test('should use family_name only when given_name is missing', () => {
    const result = parseLinkedInProfileName({ family_name: 'Doe' });
    expect(result).toBe('Doe');
    expect(typeof result).toBe('string');
  });

  test('should return default when no name fields present', () => {
    const result = parseLinkedInProfileName({});
    expect(result).toBe('LinkedIn User');
    expect(typeof result).toBe('string');
  });

  test('CRITICAL: should always return a string, never a boolean', () => {
    // This was the bug - the old code could return a boolean
    const testCases = [
      { name: 'John Doe' },
      { given_name: 'John', family_name: 'Doe' },
      { given_name: 'John' },
      { family_name: 'Doe' },
      {},
    ];

    testCases.forEach(profile => {
      const result = parseLinkedInProfileName(profile);
      expect(typeof result).toBe('string');
      expect(result).not.toBe(true);
      expect(result).not.toBe(false);
    });
  });
});

describe('getUserUUID', () => {
  test('should return the same UUID for a user with a valid UUID id', () => {
    const validUUID = '550e8400-e29b-41d4-a716-446655440000';
    const user = { id: validUUID } as User;

    const result = getUserUUID(user);

    expect(result).toBe(validUUID);
    expect(typeof result).toBe('string');
  });

  test('should generate a UUID for a legacy user id (oauth/google format)', () => {
    const legacyId = 'oauth/google:114000741928328149731';
    const user = { id: legacyId } as User;

    const result = getUserUUID(user);

    // Should return a valid UUID
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(typeof result).toBe('string');
  });

  test('should always return the SAME UUID for the same legacy user id', () => {
    const legacyId = 'oauth/google:114000741928328149731';
    const user = { id: legacyId } as User;

    const result1 = getUserUUID(user);
    const result2 = getUserUUID(user);
    const result3 = getUserUUID(user);

    // All calls should return the exact same UUID
    expect(result1).toBe(result2);
    expect(result2).toBe(result3);

    // Verify it matches the expected uuidv5 output
    const expectedUUID = uuidv5(legacyId, USER_UUID_NAMESPACE);
    expect(result1).toBe(expectedUUID);
  });

  test('should generate different UUIDs for different legacy user ids', () => {
    const legacyId1 = 'oauth/google:114000741928328149731';
    const legacyId2 = 'oauth/google:987654321098765432109';

    const user1 = { id: legacyId1 } as User;
    const user2 = { id: legacyId2 } as User;

    const result1 = getUserUUID(user1);
    const result2 = getUserUUID(user2);

    expect(result1).not.toBe(result2);
    expect(result1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('should handle various legacy id formats consistently', () => {
    const legacyFormats = [
      'oauth/google:114000741928328149731',
      'oauth/github:12345678',
      'oauth/gitlab:abcdef123',
      'some-other-legacy-format',
    ];

    legacyFormats.forEach(legacyId => {
      const user = { id: legacyId } as User;
      const result = getUserUUID(user);

      // Should always return a valid UUID
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      // Should be consistent across multiple calls
      expect(getUserUUID(user)).toBe(result);

      // Should match the expected uuidv5 output
      expect(result).toBe(uuidv5(legacyId, USER_UUID_NAMESPACE));
    });
  });

  test('should handle edge case with UUID-like string that is not valid', () => {
    const invalidUUID = '550e8400-e29b-41d4-a716-44665544000'; // Missing one character
    const user = { id: invalidUUID } as User;

    const result = getUserUUID(user);

    // Should generate a new UUID since the input is not a valid UUID
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result).toBe(uuidv5(invalidUUID, USER_UUID_NAMESPACE));
  });

  test('CRITICAL: should always return a UUID string, never undefined or null', () => {
    const testCases = [
      { id: '550e8400-e29b-41d4-a716-446655440000' }, // Valid UUID
      { id: 'oauth/google:114000741928328149731' }, // Legacy format
      { id: 'some-random-string' }, // Random string
      { id: '' }, // Empty string
    ];

    testCases.forEach(user => {
      const result = getUserUUID(user as User);

      expect(result).toBeDefined();
      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  test('should be deterministic - same input always produces same output', () => {
    const testCases = [
      'oauth/google:114000741928328149731',
      'oauth/github:12345',
      'random-legacy-id',
    ];

    testCases.forEach(legacyId => {
      const user = { id: legacyId } as User;

      // Call the function multiple times
      const results = Array.from({ length: 10 }, () => getUserUUID(user));

      // All results should be identical
      const firstResult = results[0];
      results.forEach(result => {
        expect(result).toBe(firstResult);
      });
    });
  });
});

/**
 * This test verifies the UUID validation for organization IDs
 * to prevent the production error: invalid input syntax for type uuid
 * https://kilo-code.sentry.io/issues/KILOCODE-WEB-5MK
 *
 * The extension was sending organization names instead of UUIDs in the
 * X-KiloCode-OrganizationId header, causing PostgreSQL to throw an error.
 */
describe('uuidSchema (organization ID validation)', () => {
  test('should accept valid UUID v4', () => {
    const validUUID = '550e8400-e29b-41d4-a716-446655440000';
    const result = uuidSchema.safeParse(validUUID);
    expect(result.success).toBe(true);
  });

  test('should accept valid UUID with lowercase letters', () => {
    const validUUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const result = uuidSchema.safeParse(validUUID);
    expect(result.success).toBe(true);
  });

  test('should accept valid UUID with uppercase letters', () => {
    const validUUID = 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890';
    const result = uuidSchema.safeParse(validUUID);
    expect(result.success).toBe(true);
  });

  test('REGRESSION: should reject organization name instead of UUID', () => {
    // This was the actual bug - extension sent an organization name instead of a UUID
    const organizationName = 'MyOrganization';
    const result = uuidSchema.safeParse(organizationName);
    expect(result.success).toBe(false);
  });

  test('should reject empty string', () => {
    const result = uuidSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  test('should reject random strings', () => {
    const testCases = [
      'not-a-uuid',
      'my-organization',
      'test123',
      'some-org-name',
      'acme-corp',
      'org_12345',
    ];

    testCases.forEach(invalidValue => {
      const result = uuidSchema.safeParse(invalidValue);
      expect(result.success).toBe(false);
    });
  });

  test('should reject UUID-like strings with wrong format', () => {
    const testCases = [
      '550e8400-e29b-41d4-a716-44665544000', // Missing one character
      '550e8400e29b41d4a716446655440000', // Missing dashes
      '550e8400-e29b-41d4-a716-4466554400000', // Extra character
      'g50e8400-e29b-41d4-a716-446655440000', // Invalid character 'g'
    ];

    testCases.forEach(invalidValue => {
      const result = uuidSchema.safeParse(invalidValue);
      expect(result.success).toBe(false);
    });
  });

  test('should reject null and undefined', () => {
    expect(uuidSchema.safeParse(null).success).toBe(false);
    expect(uuidSchema.safeParse(undefined).success).toBe(false);
  });

  test('should reject numbers', () => {
    expect(uuidSchema.safeParse(12345).success).toBe(false);
    expect(uuidSchema.safeParse(0).success).toBe(false);
  });
});
