import { getEnvVariable } from '@/lib/dotenvx';
import type { FraudFingerprintLookupResponse } from 'stytch';
import { Client, envs } from 'stytch';
import { db } from '@/lib/drizzle';
import type { User } from '@kilocode/db/schema';
import { kilocode_users, stytch_fingerprints } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { getFraudDetectionHeaders } from './utils';
import { captureException } from '@sentry/nextjs';
import { updateStytchValidation } from './customerInfo';
import { domainIsRestrictedFromStytchFreeCredits } from './domainIsRestrictedFromStytchFreeCredits';
import { grantCreditForCategory } from './promotionalCredits';
import PostHogClient from '@/lib/posthog';

const NEXT_PUBLIC_STYTCH_PROJECT_ENV = getEnvVariable('NEXT_PUBLIC_STYTCH_PROJECT_ENV');
const STYTCH_PROJECT_ID = getEnvVariable('STYTCH_PROJECT_ID');
const STYTCH_PROJECT_SECRET = getEnvVariable('STYTCH_PROJECT_SECRET');

const client = new Client({
  project_id: STYTCH_PROJECT_ID,
  secret: STYTCH_PROJECT_SECRET,
  env: NEXT_PUBLIC_STYTCH_PROJECT_ENV === 'test' ? envs.test : envs.live,
});

export const getStytchStatus = async (
  user: User,
  telemetryId: string | null,
  headers: Headers
): Promise<boolean | null> => {
  if (user.has_validation_stytch !== null) return user.has_validation_stytch;
  if (!telemetryId) return null;

  const fingerprintData = await client.fraud.fingerprint
    .lookup({
      telemetry_id: telemetryId,
      external_metadata: { external_id: user.google_user_email },
    })
    .catch(err => {
      captureException(err, {
        //missing telemetry_id just means hacker or adblocker: expected non-problematic error
        level:
          err.status_code === 404 && err.error_type === 'telemetry_id_not_found' ? 'info' : 'error',
        tags: { source: 'stytch_fingerprint_lookup' },
        extra: { telemetryId, email: user.google_user_email },
      });
      return null;
    });
  if (!fingerprintData) {
    return null; //404
  }
  const { kilo_free_tier_allowed } = await saveFingerprints(user, fingerprintData, headers);

  return kilo_free_tier_allowed;
};

export async function getStoredFingerprint(kiloUserId: string) {
  return await db.query.stytch_fingerprints.findFirst({
    where: eq(stytch_fingerprints.kilo_user_id, kiloUserId),
  });
}

export async function isKnownFingerprintOfOtherUser(
  kiloUserId: string,
  visitorFingerprint: string
): Promise<boolean> {
  const existingFingerprints = await db.query.stytch_fingerprints.findMany({
    where: eq(stytch_fingerprints.visitor_fingerprint, visitorFingerprint),
    columns: { kilo_user_id: true },
  });

  const fingerprintsOfOtherUsers = existingFingerprints.filter(
    fingerprint => fingerprint.kilo_user_id !== kiloUserId
  );

  if (existingFingerprints.length > 0 && fingerprintsOfOtherUsers.length > 0) {
    if (process.env.NODE_ENV !== 'test')
      console.log('SECURITY: fingerprint found for other users:', {
        kiloUserId,
        visitorFingerprint,
        fingerprintsOfOtherUsers: fingerprintsOfOtherUsers.map(fp => fp.kilo_user_id).join(', '),
      });
    return true;
  }

  return false;
}

export function emailLocalPartHasTooManyDigits(email: string): boolean {
  const localPart = email.split('@')[0] ?? '';
  const digitCount = (localPart.match(/\d/g) ?? []).length;
  return digitCount > 3;
}

export async function saveFingerprints(
  user: User,
  fingerprintData: FraudFingerprintLookupResponse,
  headers: Headers
) {
  const { verdict, fingerprints } = fingerprintData;
  const fraudDetectionHeaders = getFraudDetectionHeaders(headers);

  const inDevModeAndStytchPassEmail =
    process.env.NODE_ENV === 'development' &&
    user.google_user_email.toLowerCase().includes('stytchpass');

  const inDevModeAndStytchFailEmail =
    process.env.NODE_ENV === 'development' &&
    user.google_user_email.toLowerCase().includes('stytchfail');

  if (inDevModeAndStytchPassEmail) {
    console.log(
      `SECURITY: Auto-approving Stytch validation for ${user.google_user_email} in dev mode`
    );
  } else if (inDevModeAndStytchFailEmail) {
    console.log(
      `SECURITY: Auto-failing Stytch validation for ${user.google_user_email} in dev mode`
    );
  }

  const kilo_free_tier_allowed = inDevModeAndStytchFailEmail
    ? false
    : inDevModeAndStytchPassEmail ||
      (verdict.action === 'ALLOW' &&
        !emailLocalPartHasTooManyDigits(user.google_user_email) &&
        !(await isKnownFingerprintOfOtherUser(user.id, fingerprints.visitor_fingerprint)) &&
        !(await domainIsRestrictedFromStytchFreeCredits(user)));

  const stytchFingerprint = {
    ...fraudDetectionHeaders,
    ...fingerprints,
    kilo_user_id: user.id,
    verdict_action: verdict.action,
    detected_device_type: verdict.detected_device_type,
    is_authentic_device: verdict.is_authentic_device,
    reasons: verdict.reasons,
    created_at: new Date(fingerprintData.created_at).toISOString(),
    status_code: fingerprintData.status_code,
    fingerprint_data: fingerprintData,
    kilo_free_tier_allowed,
  };
  if (process.env.NODE_ENV !== 'test')
    console.log('SECURITY: saving fingerprint:', stytchFingerprint);
  await db.insert(stytch_fingerprints).values(stytchFingerprint);

  await updateStytchValidation(user, {
    ...user,
    has_validation_stytch: kilo_free_tier_allowed,
  });

  // Autoban users blocked by Stytch for smart rate limit abuse
  if (verdict.action === 'BLOCK' && verdict.reasons.includes('SMART_RATE_LIMIT_BANNED')) {
    await db
      .update(kilocode_users)
      .set({
        blocked_reason: 'autoban: stytch SMART_RATE_LIMIT_BANNED',
        blocked_at: new Date().toISOString(),
        blocked_by_kilo_user_id: null,
      })
      .where(and(eq(kilocode_users.id, user.id), isNull(kilocode_users.blocked_reason)));
    if (process.env.NODE_ENV !== 'test')
      console.log('SECURITY: autobanned user for SMART_RATE_LIMIT_BANNED:', {
        userId: user.id,
        email: user.google_user_email,
      });
  }

  // User created event in PostHog
  try {
    const posthogClient = PostHogClient();
    if (process.env.NEXT_PUBLIC_POSTHOG_DEBUG) {
      posthogClient.debug();
    }

    posthogClient.capture({
      event: 'stytch_created_db',
      distinctId: stytchFingerprint.kilo_user_id,
      properties: {
        user_id: stytchFingerprint.kilo_user_id,
        $set_once: {
          stytch_verdict_action: stytchFingerprint.verdict_action,
          stytch_device_type: stytchFingerprint.detected_device_type,
          stytch_device_authentic: stytchFingerprint.is_authentic_device,
          stytch_block_reasons: stytchFingerprint.reasons,
          stytch_free_tier_allowed: stytchFingerprint.kilo_free_tier_allowed,
          stytch_city: stytchFingerprint.http_x_vercel_ip_city,
          stytch_country: stytchFingerprint.http_x_vercel_ip_country,
          stytch_user_agent: stytchFingerprint.http_user_agent,
        },
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_capture_stytch_created_db' },
    });
  }

  return { kilo_free_tier_allowed };
}

/**
 * Structured signup attribution. Discriminated union so each source can
 * carry its own payload (openclaw has none today; credit-campaign carries
 * the slug needed for DB lookup).
 */
export type SignupSource =
  | { kind: 'openclaw-security-advisor' }
  | { kind: 'credit-campaign'; slug: string }
  | null;

/**
 * Handles signup promotion logic: grants credits for users who pass
 * both Turnstile and Stytch validation. When signupSource is set, layers
 * an additional product-specific bonus on top of the base welcome credit.
 */
export async function handleSignupPromotion(
  user: User,
  passedValidations: boolean,
  signupSource: SignupSource = null
): Promise<void> {
  if (!passedValidations) return;

  try {
    // Grant automatic-welcome-credits for passing both Turnstile and Stytch validation
    await grantCreditForCategory(user, {
      credit_category: 'automatic-welcome-credits',
      counts_as_selfservice: false,
    });
  } catch (error) {
    // Don't fail the entire process if credit granting fails
    captureException(error, {
      tags: {
        source: 'signup_promotion_credit_grant',
        credit_category: 'automatic-welcome-credits',
      },
      extra: { userId: user.id, email: user.google_user_email, signupSource },
    });
  }

  if (signupSource?.kind === 'openclaw-security-advisor') {
    try {
      await grantCreditForCategory(user, {
        credit_category: 'openclaw-security-advisor-signup-bonus',
        counts_as_selfservice: false,
      });
    } catch (error) {
      captureException(error, {
        tags: {
          source: 'signup_promotion_credit_grant',
          credit_category: 'openclaw-security-advisor-signup-bonus',
        },
        extra: { userId: user.id, email: user.google_user_email, signupSource },
      });
    }
  }

  if (signupSource?.kind === 'credit-campaign') {
    const { grantCreditCampaignBonus } = await import('@/lib/credit-campaigns');
    const result = await grantCreditCampaignBonus(user, signupSource.slug);
    if (!result.granted && result.reason === 'error') {
      // Internal error from the grant path already captured via Sentry
      // inside grantCreditCampaignBonus. Eligibility-fail reasons
      // (not-found, inactive, ended, capped) are expected business
      // states, not errors — no extra reporting.
    }
  }
}
