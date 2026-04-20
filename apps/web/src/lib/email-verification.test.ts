import { cleanupDbForTest, db } from '@/lib/drizzle';
import {
  canonicalizeEmailVerificationEmail,
  clearEmailVerificationOverride,
  ensureKnownEmailVerification,
  getEmailVerificationDecision,
  getEmailVerificationDecisionFromRow,
  getStoredEmailVerification,
  refreshEmailVerification,
  setEmailVerificationOverride,
} from '@/lib/email-verification';
import { checkEmailWithNeverBounce } from '@/lib/email-neverbounce';
import { email_verification_state } from '@kilocode/db/schema';

jest.mock('@/lib/email-neverbounce', () => ({
  checkEmailWithNeverBounce: jest.fn(),
}));

const mockCheckEmailWithNeverBounce = jest.mocked(checkEmailWithNeverBounce);

const adminActor = {
  userId: 'admin-user-id',
};

afterEach(async () => {
  jest.clearAllMocks();
  await cleanupDbForTest();
});

describe('email-verification', () => {
  it('canonicalizes emails with trim + lowercase only', () => {
    expect(canonicalizeEmailVerificationEmail('  Foo.Bar+tag@Example.COM  ')).toBe(
      'foo.bar+tag@example.com'
    );
  });

  it('enforces canonical email form at the database layer', async () => {
    await expect(
      db.insert(email_verification_state).values({
        email: ' User@Example.com ',
        verification_result: 'valid',
      })
    ).rejects.toThrow('email_verification_state_email_canonical_check');
  });

  it('returns unknown when no local state exists', async () => {
    await expect(getEmailVerificationDecision('unknown@example.com')).resolves.toEqual({
      email: 'unknown@example.com',
      decision: 'unknown',
      source: 'none',
    });
  });

  it('prefers force_allow over a blocked verification result', () => {
    expect(
      getEmailVerificationDecisionFromRow('user@example.com', {
        email: 'user@example.com',
        verification_result: 'invalid',
        checked_at: '2026-01-01T00:00:00.000Z',
        override_state: 'force_allow',
        override_reason: 'manual allow',
        override_actor_user_id: 'admin-1',
        override_at: '2026-01-01T00:00:00.000Z',
      })
    ).toEqual({
      email: 'user@example.com',
      decision: 'allow',
      source: 'override',
      row: expect.objectContaining({
        override_state: 'force_allow',
        verification_result: 'invalid',
      }),
    });
  });

  it('persists a checked verification result for an unknown email', async () => {
    mockCheckEmailWithNeverBounce.mockResolvedValue({
      kind: 'checked',
      result: 'disposable',
      status: 'success',
      flags: ['has_dns'],
      suggestedCorrection: 'fixed@example.com',
      shouldSend: false,
    });

    const decision = await ensureKnownEmailVerification('  USER@Example.com ');
    const stored = await getStoredEmailVerification('user@example.com');

    expect(decision).toEqual(
      expect.objectContaining({
        email: 'user@example.com',
        decision: 'block',
        source: 'verification',
        outcome: expect.objectContaining({ kind: 'checked', result: 'disposable' }),
      })
    );
    expect(stored).toEqual(
      expect.objectContaining({
        email: 'user@example.com',
        verification_result: 'disposable',
      })
    );
  });

  it('returns allow without storing a row when the provider allows without a live check', async () => {
    mockCheckEmailWithNeverBounce.mockResolvedValue({
      kind: 'allowed_without_check',
      reason: 'missing_api_key',
      shouldSend: true,
    });

    const decision = await ensureKnownEmailVerification('user@example.com');
    const stored = await getStoredEmailVerification('user@example.com');

    expect(decision).toEqual(
      expect.objectContaining({
        email: 'user@example.com',
        decision: 'allow',
        source: 'none',
        outcome: { kind: 'allowed_without_check', reason: 'missing_api_key', shouldSend: true },
      })
    );
    expect(stored).toBeUndefined();
  });

  it('creates and clears overrides', async () => {
    await db.insert(email_verification_state).values({
      email: 'user@example.com',
      verification_result: 'invalid',
      checked_at: new Date().toISOString(),
    });

    await setEmailVerificationOverride(
      ' USER@Example.com ',
      'force_allow',
      adminActor,
      'allow this address'
    );

    await expect(getEmailVerificationDecision('user@example.com')).resolves.toEqual(
      expect.objectContaining({
        email: 'user@example.com',
        decision: 'allow',
        source: 'override',
        row: expect.objectContaining({
          override_state: 'force_allow',
          override_reason: 'allow this address',
          override_actor_user_id: adminActor.userId,
        }),
      })
    );

    await clearEmailVerificationOverride('user@example.com');

    await expect(getEmailVerificationDecision('user@example.com')).resolves.toEqual(
      expect.objectContaining({
        email: 'user@example.com',
        decision: 'block',
        source: 'verification',
        row: expect.objectContaining({
          override_state: null,
          verification_result: 'invalid',
        }),
      })
    );
  });

  it('keeps the existing stored decision when a refresh fails open', async () => {
    await db.insert(email_verification_state).values({
      email: 'user@example.com',
      verification_result: 'valid',
      checked_at: new Date().toISOString(),
    });
    mockCheckEmailWithNeverBounce.mockResolvedValue({
      kind: 'allowed_without_check',
      reason: 'exception',
      error: 'fetch failed',
      shouldSend: true,
    });

    const refreshed = await refreshEmailVerification('user@example.com');

    expect(refreshed).toEqual(
      expect.objectContaining({
        email: 'user@example.com',
        decision: 'allow',
        source: 'verification',
        outcome: {
          kind: 'allowed_without_check',
          reason: 'exception',
          error: 'fetch failed',
          shouldSend: true,
        },
      })
    );
  });
});
