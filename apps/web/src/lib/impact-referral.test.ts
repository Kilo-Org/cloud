process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';
process.env.TURNSTILE_SECRET_KEY ||= 'test-turnstile-secret';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { eq, sql } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  impact_advocate_participants,
  impact_advocate_registration_attempts,
  kilocode_users,
} from '@kilocode/db/schema';

describe('impact referral participant registration dispatch', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    process.env.IMPACT_ACCOUNT_SID = 'impact-account-sid';
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'impact-advocate-account-sid';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'impact-advocate-auth-token';
    process.env.IMPACT_ADVOCATE_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'tenant-alias';
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.delete(impact_advocate_registration_attempts).where(sql`true`);
    await db.delete(impact_advocate_participants).where(sql`true`);
    await db.delete(kilocode_users).where(sql`true`);
  });

  it('delivers queued participant registrations and marks the participant registered', async () => {
    // Realistic SaaSquatch upsert response shape — the dispatcher must parse
    // referralCodes[programId] and persist it as the participant's
    // opaque_referral_identifier so future referee touches can resolve back
    // to this user as their advocate.
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'sq-hash-id',
          accountId: 'sq-hash-id',
          email: 'participant@example.com',
          referralCodes: { '51699': 'PARTICIPANT9001' },
          referable: true,
        }),
        { status: 200 }
      )
    );
    global.fetch = fetchMock;

    const user = await insertTestUser({
      google_user_email: 'participant@example.com',
      normalized_email: 'participant@example.com',
    });

    const {
      dispatchQueuedImpactAdvocateRegistrationAttempts,
      queueImpactAdvocateParticipantRegistration,
    } = await import('@/lib/impact-referral');

    await queueImpactAdvocateParticipantRegistration({
      user,
      referralTouch: {
        opaqueTrackingValue: 'sq-cookie',
        trackingValueLength: 9,
        isTrackingValueAccepted: true,
        rsCode: 'ref-code',
        rsShareMedium: 'email',
        rsEngagementMedium: 'link',
        landingPath: '/get-started?_saasquatch=sq-cookie',
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        utmTerm: null,
        utmContent: null,
        touchedAt: new Date('2026-04-23T00:00:00.000Z'),
        expiresAt: new Date('2026-05-23T00:00:00.000Z'),
      },
      locale: 'en-US',
      countryCode: 'US',
    });

    const summary = await dispatchQueuedImpactAdvocateRegistrationAttempts();
    expect(summary).toEqual({
      claimed: 1,
      delivered: 1,
      retried: 0,
      failed: 0,
    });

    const [participant] = await db.select().from(impact_advocate_participants);
    expect(participant.registration_state).toBe('registered');
    expect(participant.registered_at).toBeTruthy();
    expect(participant.last_error_code).toBeNull();
    // The advocate's program-scoped SaaSquatch code is now persisted so the
    // attribution lookup in kiloclaw-referrals.ts can resolve referrerUserId.
    expect(participant.opaque_referral_identifier).toBe('PARTICIPANT9001');

    const [attempt] = await db.select().from(impact_advocate_registration_attempts);
    expect(attempt.delivery_state).toBe('succeeded');
    expect(attempt.attempt_count).toBe(1);
    expect(attempt.next_retry_at).toBeNull();
    expect(attempt.response_status_code).toBe(200);

    const encodedEmail = encodeURIComponent(user.google_user_email);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://app.referralsaasquatch.com/api/v1/tenant-alias/open/account/${encodedEmail}/user/${encodedEmail}`,
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization:
            'Basic ' +
            Buffer.from('impact-advocate-account-sid:impact-advocate-auth-token').toString(
              'base64'
            ),
          Accept: 'application/json',
          'Content-Type': 'application/json',
        }),
      })
    );
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof requestBody).toBe('string');
    expect(JSON.parse(String(requestBody))).toEqual({
      id: user.google_user_email,
      accountId: user.google_user_email,
      email: user.google_user_email,
      cookies: 'sq-cookie',
      locale: 'en_US',
      countryCode: 'US',
    });
  });

  it('keeps transient failures retryable until a later dispatch succeeds', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('upstream unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    global.fetch = fetchMock;

    const user = await insertTestUser({
      google_user_email: 'retrying@example.com',
      normalized_email: 'retrying@example.com',
    });

    const {
      dispatchQueuedImpactAdvocateRegistrationAttempts,
      queueImpactAdvocateParticipantRegistration,
    } = await import('@/lib/impact-referral');

    await queueImpactAdvocateParticipantRegistration({
      user,
      referralTouch: {
        opaqueTrackingValue: 'sq-cookie',
        trackingValueLength: 9,
        isTrackingValueAccepted: true,
        rsCode: 'ref-code',
        rsShareMedium: null,
        rsEngagementMedium: null,
        landingPath: '/get-started',
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        utmTerm: null,
        utmContent: null,
        touchedAt: new Date('2026-04-23T00:00:00.000Z'),
        expiresAt: new Date('2026-05-23T00:00:00.000Z'),
      },
    });

    const firstSummary = await dispatchQueuedImpactAdvocateRegistrationAttempts();
    expect(firstSummary).toEqual({
      claimed: 1,
      delivered: 0,
      retried: 1,
      failed: 0,
    });

    const [afterFirstAttempt] = await db.select().from(impact_advocate_registration_attempts);
    expect(afterFirstAttempt.delivery_state).toBe('failed');
    expect(afterFirstAttempt.next_retry_at).toBeTruthy();

    const [retryingParticipant] = await db.select().from(impact_advocate_participants);
    expect(retryingParticipant.registration_state).toBe('retrying');

    await db
      .update(impact_advocate_registration_attempts)
      .set({ next_retry_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(impact_advocate_registration_attempts.id, afterFirstAttempt.id));

    const secondSummary = await dispatchQueuedImpactAdvocateRegistrationAttempts();
    expect(secondSummary).toEqual({
      claimed: 1,
      delivered: 1,
      retried: 0,
      failed: 0,
    });

    const [registeredParticipant] = await db.select().from(impact_advocate_participants);
    expect(registeredParticipant.registration_state).toBe('registered');
  });

  it('does not regress a registered participant when the same referral touch is queued again', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ participantId: 'impact-participant-1' }), { status: 200 })
      );
    global.fetch = fetchMock;

    const user = await insertTestUser({
      google_user_email: 'already-registered@example.com',
      normalized_email: 'already-registered@example.com',
    });

    const {
      dispatchQueuedImpactAdvocateRegistrationAttempts,
      queueImpactAdvocateParticipantRegistration,
    } = await import('@/lib/impact-referral');

    const referralTouch = {
      opaqueTrackingValue: 'sq-cookie',
      trackingValueLength: 9,
      isTrackingValueAccepted: true,
      rsCode: 'ref-code',
      rsShareMedium: 'email',
      rsEngagementMedium: 'link',
      landingPath: '/get-started?_saasquatch=sq-cookie',
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmTerm: null,
      utmContent: null,
      touchedAt: new Date('2026-04-23T00:00:00.000Z'),
      expiresAt: new Date('2026-05-23T00:00:00.000Z'),
    } as const;

    await queueImpactAdvocateParticipantRegistration({
      user,
      referralTouch,
      locale: 'en-US',
      countryCode: 'US',
    });

    const firstSummary = await dispatchQueuedImpactAdvocateRegistrationAttempts();
    expect(firstSummary).toEqual({
      claimed: 1,
      delivered: 1,
      retried: 0,
      failed: 0,
    });

    const [registeredParticipant] = await db.select().from(impact_advocate_participants);
    expect(registeredParticipant.registration_state).toBe('registered');

    await queueImpactAdvocateParticipantRegistration({
      user,
      referralTouch,
      locale: 'en-US',
      countryCode: 'US',
    });

    const participants = await db.select().from(impact_advocate_participants);
    expect(participants).toHaveLength(1);
    expect(participants[0]?.registration_state).toBe('registered');

    const attempts = await db.select().from(impact_advocate_registration_attempts);
    expect(attempts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks 4xx failures terminal, logs them, and does not retry unchanged payloads', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('bad request', { status: 400 }));
    global.fetch = fetchMock;
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const user = await insertTestUser({
      google_user_email: 'terminal@example.com',
      normalized_email: 'terminal@example.com',
    });

    const {
      dispatchQueuedImpactAdvocateRegistrationAttempts,
      queueImpactAdvocateParticipantRegistration,
    } = await import('@/lib/impact-referral');

    await queueImpactAdvocateParticipantRegistration({
      user,
      referralTouch: {
        opaqueTrackingValue: 'sq-cookie',
        trackingValueLength: 9,
        isTrackingValueAccepted: true,
        rsCode: null,
        rsShareMedium: null,
        rsEngagementMedium: null,
        landingPath: '/get-started',
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        utmTerm: null,
        utmContent: null,
        touchedAt: new Date('2026-04-23T00:00:00.000Z'),
        expiresAt: new Date('2026-05-23T00:00:00.000Z'),
      },
    });

    const firstSummary = await dispatchQueuedImpactAdvocateRegistrationAttempts();
    expect(firstSummary).toEqual({
      claimed: 1,
      delivered: 0,
      retried: 0,
      failed: 1,
    });

    const [participant] = await db.select().from(impact_advocate_participants);
    expect(participant.registration_state).toBe('failed');
    expect(participant.last_error_code).toBe('http_4xx');

    const secondSummary = await dispatchQueuedImpactAdvocateRegistrationAttempts();
    expect(secondSummary).toEqual({
      claimed: 0,
      delivered: 0,
      retried: 0,
      failed: 0,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[impact-referral] Impact Advocate participant registration failed permanently',
      expect.objectContaining({
        userId: user.id,
        statusCode: 400,
        failureKind: 'http_4xx',
      })
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it(
    'leaves opaque_referral_identifier untouched when another participant ' +
      'already holds the SaaSquatch code',
    async () => {
      // Existing participant on a *different* user already holds the code.
      // The unique constraint on opaque_referral_identifier means we must not
      // try to write the same code on a second participant — doing so would
      // roll back the success transaction and the cron would loop forever.
      const incumbent = await insertTestUser({
        google_user_email: 'incumbent@example.com',
        normalized_email: 'incumbent@example.com',
      });
      await db.insert(impact_advocate_participants).values({
        user_id: incumbent.id,
        advocate_id: incumbent.google_user_email,
        advocate_account_id: incumbent.google_user_email,
        opaque_referral_identifier: 'COLLIDING_CODE',
        registration_state: 'registered',
      });

      const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'sq-hash-id-other',
            email: 'other@example.com',
            referralCodes: { '51699': 'COLLIDING_CODE' },
            referable: true,
          }),
          { status: 200 }
        )
      );
      global.fetch = fetchMock;

      const newUser = await insertTestUser({
        google_user_email: 'other@example.com',
        normalized_email: 'other@example.com',
      });

      const {
        dispatchQueuedImpactAdvocateRegistrationAttempts,
        queueImpactAdvocateParticipantRegistration,
      } = await import('@/lib/impact-referral');

      await queueImpactAdvocateParticipantRegistration({
        user: newUser,
        referralTouch: {
          opaqueTrackingValue: 'sq-cookie-other',
          trackingValueLength: 15,
          isTrackingValueAccepted: true,
          rsCode: 'ref-other',
          rsShareMedium: 'email',
          rsEngagementMedium: 'link',
          landingPath: '/get-started?_saasquatch=sq-cookie-other',
          utmSource: null,
          utmMedium: null,
          utmCampaign: null,
          utmTerm: null,
          utmContent: null,
          touchedAt: new Date('2026-04-23T00:00:00.000Z'),
          expiresAt: new Date('2026-05-23T00:00:00.000Z'),
        },
        locale: 'en-US',
        countryCode: 'US',
      });

      const summary = await dispatchQueuedImpactAdvocateRegistrationAttempts();
      expect(summary).toEqual({
        claimed: 1,
        delivered: 1,
        retried: 0,
        failed: 0,
      });

      // The new participant is registered but does NOT receive the colliding
      // code; the incumbent keeps it.
      const newParticipant = await db.query.impact_advocate_participants.findFirst({
        where: eq(impact_advocate_participants.user_id, newUser.id),
      });
      expect(newParticipant?.registration_state).toBe('registered');
      expect(newParticipant?.opaque_referral_identifier).toBeNull();

      const incumbentParticipant = await db.query.impact_advocate_participants.findFirst({
        where: eq(impact_advocate_participants.user_id, incumbent.id),
      });
      expect(incumbentParticipant?.opaque_referral_identifier).toBe('COLLIDING_CODE');
    }
  );
});
