import { describe, test, expect, beforeEach } from '@jest/globals';
import { insertTestUser } from '../tests/helpers/user.helper';
import { db } from './drizzle';
import { kilocode_users, stytch_fingerprints, credit_transactions } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { FraudFingerprintLookupResponse } from 'stytch';
import { OPENCLAW_SECURITY_ADVISOR_BONUS_EXPIRY_HRS } from './constants';

import {
  saveFingerprints,
  isKnownFingerprintOfOtherUser,
  getStoredFingerprint,
  handleSignupPromotion,
  emailLocalPartHasTooManyDigits,
} from '@/lib/stytch';

beforeEach(async () => {
  // Clean up any existing fingerprint data before each test
  // eslint-disable-next-line drizzle/enforce-delete-with-where
  await db.delete(stytch_fingerprints);
});

function createMockFingerprintData(): FraudFingerprintLookupResponse {
  return {
    status_code: 200,
    request_id: 'test-request-id',
    telemetry_id: 'test-telemetry-id',
    created_at: '2024-01-01T00:00:00Z',
    expires_at: '2024-01-02T00:00:00Z',
    external_metadata: {},
    verdict: {
      action: 'ALLOW',
      detected_device_type: 'desktop',
      is_authentic_device: true,
      reasons: [],
      verdict_reason_overrides: [],
    },
    fingerprints: {
      visitor_fingerprint: 'visitor-fp-123',
      browser_fingerprint: 'browser-fp-123',
      browser_id: 'browser-id-123',
      hardware_fingerprint: 'hardware-fp-123',
      network_fingerprint: 'network-fp-123',
      visitor_id: 'visitor-id-123',
    },
  };
}

// Helper function to create mock headers
function createMockHeaders(): Headers {
  const headers = new Headers();
  headers.set('x-forwarded-for', '192.168.1.1');
  headers.set('x-vercel-ip-city', 'San Francisco');
  headers.set('x-vercel-ip-country', 'US');
  headers.set('x-vercel-ip-latitude', '37.7749');
  headers.set('x-vercel-ip-longitude', '-122.4194');
  headers.set('x-vercel-ja4-digest', 'ja4-digest-123');
  headers.set('user-agent', 'Mozilla/5.0 Test Browser');
  return headers;
}

describe('Stytch Fingerprint Functions', () => {
  describe('getStoredFingerprint', () => {
    test('should return null when no fingerprint exists for user', async () => {
      const user = await insertTestUser();
      const result = await getStoredFingerprint(user.id);
      expect(result).toBeUndefined();
    });

    test('should return fingerprint when it exists for user', async () => {
      const user = await insertTestUser();
      await saveFingerprints(user, createMockFingerprintData(), createMockHeaders());
      const result = await getStoredFingerprint(user.id);

      expect(result).toBeDefined();
      expect(result?.kilo_user_id).toBe(user.id);
      expect(result?.visitor_fingerprint).toBe('visitor-fp-123');
    });
  });

  describe('isKnownFingerprintOfOtherUser', () => {
    test('should return false when fingerprint does not exist', async () => {
      const user = await insertTestUser();
      const result = await isKnownFingerprintOfOtherUser(user.id, 'non-existent-fp');
      expect(result).toBe(false);
    });

    test('should return false when fingerprint belongs only to the same user', async () => {
      const user = await insertTestUser();
      await saveFingerprints(user, createMockFingerprintData(), createMockHeaders());
      const result = await isKnownFingerprintOfOtherUser(user.id, 'visitor-fp-123');

      expect(result).toBe(false);
    });

    test('should return true when fingerprint belongs to other users', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();
      await saveFingerprints(user1, createMockFingerprintData(), createMockHeaders());
      const result = await isKnownFingerprintOfOtherUser(user2.id, 'visitor-fp-123');

      expect(result).toBe(true);
    });

    test('should return true when fingerprint belongs to both current user and other users', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();
      const fingerprintData = createMockFingerprintData();
      const headers = createMockHeaders();

      await saveFingerprints(user1, fingerprintData, headers);
      await saveFingerprints(user2, fingerprintData, headers);

      const result = await isKnownFingerprintOfOtherUser(user1.id, 'visitor-fp-123');

      expect(result).toBe(true);
    });
  });

  describe('saveFingerprints', () => {
    test('should save fingerprint data correctly', async () => {
      const user = await insertTestUser({ google_user_email: 'fp-save-test@example.com' });
      const fingerprintData = createMockFingerprintData();
      const headers = createMockHeaders();

      const result = await saveFingerprints(user, fingerprintData, headers);

      expect(result.kilo_free_tier_allowed).toBe(true);

      // Verify data was saved to database
      const savedFingerprint = await db.query.stytch_fingerprints.findFirst({
        where: eq(stytch_fingerprints.kilo_user_id, user.id),
      });

      expect(savedFingerprint).toBeDefined();
      expect(savedFingerprint?.kilo_user_id).toBe(user.id);
      expect(savedFingerprint?.visitor_fingerprint).toBe('visitor-fp-123');
      expect(savedFingerprint?.verdict_action).toBe('ALLOW');
      expect(savedFingerprint?.is_authentic_device).toBe(true);
      expect(savedFingerprint?.kilo_free_tier_allowed).toBe(true);
      expect(savedFingerprint?.http_x_forwarded_for).toBe('192.168.1.1');
      expect(savedFingerprint?.http_x_vercel_ip_city).toBe('San Francisco');
    });

    test('should set kilo_free_tier_allowed to false when verdict is not ALLOW', async () => {
      const user = await insertTestUser();
      const fingerprintData = {
        ...createMockFingerprintData(),
        verdict: {
          action: 'BLOCK',
          detected_device_type: 'desktop',
          is_authentic_device: false,
          reasons: ['suspicious_activity'],
          verdict_reason_overrides: [],
        },
      };
      const headers = createMockHeaders();

      const result = await saveFingerprints(user, fingerprintData, headers);

      expect(result.kilo_free_tier_allowed).toBe(false);

      const savedFingerprint = await db.query.stytch_fingerprints.findFirst({
        where: eq(stytch_fingerprints.kilo_user_id, user.id),
      });

      expect(savedFingerprint?.kilo_free_tier_allowed).toBe(false);
    });

    test('should set kilo_free_tier_allowed to false when fingerprint belongs to other user', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();
      const fingerprintData = createMockFingerprintData();
      const headers = createMockHeaders();

      await saveFingerprints(user1, fingerprintData, headers);
      const result = await saveFingerprints(user2, fingerprintData, headers);

      expect(result.kilo_free_tier_allowed).toBe(false);

      const savedFingerprint = await db.query.stytch_fingerprints.findFirst({
        where: eq(stytch_fingerprints.kilo_user_id, user2.id),
      });

      expect(savedFingerprint?.kilo_free_tier_allowed).toBe(false);
    });

    test('should automatically grant welcome credits and set default model when validation passes', async () => {
      const user = await insertTestUser({ google_user_email: 'fp-credits-test@example.com' });
      const fingerprintData = createMockFingerprintData();
      const headers = createMockHeaders();

      const { kilo_free_tier_allowed } = await saveFingerprints(user, fingerprintData, headers);
      expect(kilo_free_tier_allowed).toBe(true);

      await handleSignupPromotion(user, kilo_free_tier_allowed);

      // Check if credit was granted
      const creditTransaction = await db.query.credit_transactions.findFirst({
        where: eq(credit_transactions.kilo_user_id, user.id),
      });

      expect(creditTransaction?.credit_category).toBe('automatic-welcome-credits');
      expect(creditTransaction?.amount_microdollars).toBe(1250000); // $1.25 in microdollars
    });

    test('should set kilo_free_tier_allowed to false when email local part has too many digits', async () => {
      const user = await insertTestUser({ google_user_email: 'user12345@example.com' });
      const fingerprintData = createMockFingerprintData();
      const headers = createMockHeaders();

      const result = await saveFingerprints(user, fingerprintData, headers);

      expect(result.kilo_free_tier_allowed).toBe(false);
    });

    test('should autoban user when verdict is BLOCK with SMART_RATE_LIMIT_BANNED reason', async () => {
      const user = await insertTestUser();
      const fingerprintData = {
        ...createMockFingerprintData(),
        verdict: {
          action: 'BLOCK',
          detected_device_type: 'desktop',
          is_authentic_device: false,
          reasons: ['SMART_RATE_LIMIT_BANNED'],
          verdict_reason_overrides: [],
        },
      };

      await saveFingerprints(user, fingerprintData, createMockHeaders());

      const updatedUser = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
        columns: { blocked_reason: true },
      });
      expect(updatedUser?.blocked_reason).toBe('autoban: stytch SMART_RATE_LIMIT_BANNED');
    });

    test('should not overwrite existing blocked_reason when autobanning', async () => {
      const user = await insertTestUser();
      await db
        .update(kilocode_users)
        .set({ blocked_reason: 'already blocked' })
        .where(eq(kilocode_users.id, user.id));

      const fingerprintData = {
        ...createMockFingerprintData(),
        verdict: {
          action: 'BLOCK',
          detected_device_type: 'desktop',
          is_authentic_device: false,
          reasons: ['SMART_RATE_LIMIT_BANNED'],
          verdict_reason_overrides: [],
        },
      };

      await saveFingerprints(user, fingerprintData, createMockHeaders());

      const updatedUser = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
        columns: { blocked_reason: true },
      });
      expect(updatedUser?.blocked_reason).toBe('already blocked');
    });

    test('should not autoban when verdict is BLOCK without SMART_RATE_LIMIT_BANNED reason', async () => {
      const user = await insertTestUser();
      const fingerprintData = {
        ...createMockFingerprintData(),
        verdict: {
          action: 'BLOCK',
          detected_device_type: 'desktop',
          is_authentic_device: false,
          reasons: ['suspicious_activity'],
          verdict_reason_overrides: [],
        },
      };

      await saveFingerprints(user, fingerprintData, createMockHeaders());

      const updatedUser = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
        columns: { blocked_reason: true },
      });
      expect(updatedUser?.blocked_reason).toBeNull();
    });
  });

  describe('emailLocalPartHasTooManyDigits', () => {
    test('should return false for emails with 3 or fewer digits', () => {
      expect(emailLocalPartHasTooManyDigits('alice@example.com')).toBe(false);
      expect(emailLocalPartHasTooManyDigits('user1@example.com')).toBe(false);
      expect(emailLocalPartHasTooManyDigits('test12@example.com')).toBe(false);
      expect(emailLocalPartHasTooManyDigits('a1b2c3@example.com')).toBe(false);
    });

    test('should return true for emails with more than 3 digits', () => {
      expect(emailLocalPartHasTooManyDigits('user1234@example.com')).toBe(true);
      expect(emailLocalPartHasTooManyDigits('test123456789@example.com')).toBe(true);
      expect(emailLocalPartHasTooManyDigits('a1b2c3d4@example.com')).toBe(true);
    });

    test('should only count digits in the local part, not the domain', () => {
      expect(emailLocalPartHasTooManyDigits('alice@example123456.com')).toBe(false);
    });
  });

  describe('handleSignupPromotion with signupSource', () => {
    test('grants both welcome and openclaw-security-advisor bonus when passed + source matches', async () => {
      const user = await insertTestUser({
        google_user_email: 'osa-bonus-pass@example.com',
      });

      await handleSignupPromotion(user, true, 'openclaw-security-advisor');

      const grants = await db.query.credit_transactions.findMany({
        where: eq(credit_transactions.kilo_user_id, user.id),
      });

      const byCategory = new Map(grants.map(g => [g.credit_category, g]));
      expect(byCategory.get('automatic-welcome-credits')?.amount_microdollars).toBe(1_250_000);

      const bonus = byCategory.get('openclaw-security-advisor-signup-bonus');
      expect(bonus?.amount_microdollars).toBe(7_130_000);

      if (!bonus?.expiry_date) throw new Error('bonus.expiry_date should be set');
      const expiryMs = new Date(bonus.expiry_date).getTime();
      const expectedMs = Date.now() + OPENCLAW_SECURITY_ADVISOR_BONUS_EXPIRY_HRS * 60 * 60 * 1000;
      // Loose ±2 minute window — test DB inserts + clock drift
      expect(Math.abs(expiryMs - expectedMs)).toBeLessThan(2 * 60 * 1000);
    });

    test('grants only welcome credit when signupSource is null', async () => {
      const user = await insertTestUser({
        google_user_email: 'osa-bonus-nosource@example.com',
      });

      await handleSignupPromotion(user, true, null);

      const grants = await db.query.credit_transactions.findMany({
        where: eq(credit_transactions.kilo_user_id, user.id),
      });

      expect(grants.map(g => g.credit_category).sort()).toEqual(['automatic-welcome-credits']);
    });

    test('grants nothing when Stytch validation fails even with source set', async () => {
      const user = await insertTestUser({
        google_user_email: 'osa-bonus-stytchfail@example.com',
      });

      await handleSignupPromotion(user, false, 'openclaw-security-advisor');

      const grants = await db.query.credit_transactions.findMany({
        where: eq(credit_transactions.kilo_user_id, user.id),
      });

      expect(grants).toHaveLength(0);
    });

    test('bonus grant is idempotent: repeat call inserts no additional row', async () => {
      const user = await insertTestUser({
        google_user_email: 'osa-bonus-idempotent@example.com',
      });

      await handleSignupPromotion(user, true, 'openclaw-security-advisor');
      await handleSignupPromotion(user, true, 'openclaw-security-advisor');

      const bonusRows = await db.query.credit_transactions.findMany({
        where: eq(credit_transactions.kilo_user_id, user.id),
      });

      const bonusOnly = bonusRows.filter(
        g => g.credit_category === 'openclaw-security-advisor-signup-bonus'
      );
      expect(bonusOnly).toHaveLength(1);
    });
  });

  describe('Integration: saveFingerprints -> getStoredFingerprint -> isKnownFingerprintOfOtherUser', () => {
    test('should demonstrate complete workflow with multiple users', async () => {
      const user1 = await insertTestUser({ google_user_email: 'fp-workflow-alice@example.com' });
      const user2 = await insertTestUser({ google_user_email: 'fp-workflow-bob@example.com' });
      const user3 = await insertTestUser({ google_user_email: 'fp-workflow-carol@example.com' });
      const headers = createMockHeaders();

      const fingerprintData1 = {
        ...createMockFingerprintData(),
        fingerprints: {
          visitor_fingerprint: 'unique-fp-user1',
          browser_fingerprint: 'browser-fp-user1',
          browser_id: 'browser-id-user1',
          hardware_fingerprint: 'hardware-fp-user1',
          network_fingerprint: 'network-fp-user1',
          visitor_id: 'visitor-id-user1',
        },
      };

      const fingerprint_2_and_3 = {
        ...createMockFingerprintData(),
        fingerprints: {
          visitor_fingerprint: 'shared-fp-123',
          browser_fingerprint: 'shared-browser-fp',
          browser_id: 'shared-browser-id',
          hardware_fingerprint: 'shared-hardware-fp',
          network_fingerprint: 'shared-network-fp',
          visitor_id: 'shared-visitor-id',
        },
      };

      const result1 = await saveFingerprints(user1, fingerprintData1, headers);
      expect(result1.kilo_free_tier_allowed).toBe(true);

      const result2 = await saveFingerprints(user2, fingerprint_2_and_3, headers);
      expect(result2.kilo_free_tier_allowed).toBe(true);

      const result3 = await saveFingerprints(user3, fingerprint_2_and_3, headers);
      expect(result3.kilo_free_tier_allowed).toBe(false);

      const storedFp1 = await getStoredFingerprint(user1.id);
      const storedFp2 = await getStoredFingerprint(user2.id);
      const storedFp3 = await getStoredFingerprint(user3.id);

      expect(storedFp1?.visitor_fingerprint).toBe('unique-fp-user1');
      expect(storedFp2?.visitor_fingerprint).toBe('shared-fp-123');
      expect(storedFp3?.visitor_fingerprint).toBe('shared-fp-123');

      expect(await isKnownFingerprintOfOtherUser(user1.id, 'unique-fp-user1')).toBe(false); // Unique fingerprint
      expect(await isKnownFingerprintOfOtherUser(user2.id, 'shared-fp-123')).toBe(true); // Shared with user3
      expect(await isKnownFingerprintOfOtherUser(user3.id, 'shared-fp-123')).toBe(true); // Shared with user2
    });

    test('should handle edge case where user saves multiple different fingerprints', async () => {
      const user = await insertTestUser();
      const headers = createMockHeaders();

      const fingerprint1 = {
        ...createMockFingerprintData(),
        fingerprints: {
          visitor_fingerprint: 'fp1-for-user',
          browser_fingerprint: 'browser-fp1',
          browser_id: 'browser-id1',
          hardware_fingerprint: 'hardware-fp1',
          network_fingerprint: 'network-fp1',
          visitor_id: 'visitor-id1',
        },
      };

      const fingerprint2 = {
        ...createMockFingerprintData(),
        fingerprints: {
          visitor_fingerprint: 'fp2-for-user',
          browser_fingerprint: 'browser-fp2',
          browser_id: 'browser-id2',
          hardware_fingerprint: 'hardware-fp2',
          network_fingerprint: 'network-fp2',
          visitor_id: 'visitor-id2',
        },
      };

      await saveFingerprints(user, fingerprint1, headers);
      await saveFingerprints(user, fingerprint2, headers);

      const storedFp = await getStoredFingerprint(user.id);
      expect(storedFp).toBeDefined();
      expect(['fp1-for-user', 'fp2-for-user']).toContain(storedFp?.visitor_fingerprint);

      // Both fingerprints should not be considered as belonging to other users
      expect(await isKnownFingerprintOfOtherUser(user.id, 'fp1-for-user')).toBe(false);
      expect(await isKnownFingerprintOfOtherUser(user.id, 'fp2-for-user')).toBe(false);
    });
  });
});
