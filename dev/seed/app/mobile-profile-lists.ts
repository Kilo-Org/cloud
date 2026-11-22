import { createHash } from 'node:crypto';

import {
  byok_api_keys,
  credit_transactions,
  passkey_credentials,
  user_moderation_blocks,
  user_moderation_mutes,
  user_notification_history,
} from '@kilocode/db/schema';
import { and, eq, inArray, like } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { createByokEnvelope } from '../lib/byok';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { resolveSeedUserId } from '../lib/users';

export const usage = '<email>';

/**
 * The Profile screens whose lists need rows, seeded for one existing account:
 *
 * - passkeys: two credential rows, one with a name that fills the row.
 * - blocked people: two blocked and two muted GitHub logins, one of each long.
 * - notification history: five recorded pushes across three categories, one
 *   with a body that runs past three lines.
 * - provider keys: an Anthropic key and an OpenAI key, both wrapped by the
 *   local `byok-kms` service with a placeholder secret upstream rejects.
 * - credit history: two paid purchases, an expiring grant with its expiry row,
 *   a welcome grant that still expires and an open-ended referral grant, and
 *   one usage deduction, so the purchase list and the ledger both have rows.
 *
 * Two screens need no seed for their empty state, and two cannot be seeded: a
 * fresh account already shows the empty blocked-people list and the empty
 * passkey list (only the "Add" control is offered). A data export request needs
 * the `cloud-data-export-ui` PostHog release toggle, which a local stack does
 * not answer, so the screen stays on its unavailable state whatever rows exist.
 * Trusted hosts live in the device's own SQLCipher store, so there is no backend
 * row to write.
 *
 * The credit history lists purchases, the free grants no expiry row prints, and
 * negative rows (`buildCreditHistoryItems` merges the three sources). An expired
 * grant appears through the expiry row that closes it: that grant is seeded with
 * a past expiry date and an expiry row that names it, which is the shape
 * `computeExpiration` writes. The welcome grant carries a live expiry date, as
 * the category's own 30-day term writes it, so its row prints when it runs out;
 * the referral grant has no term, so its row prints the date alone. Neither
 * unspent grant has an expiry row closing it, so both are rows of their own. The
 * ledger-cache reconciliation row is seeded too, with the shape
 * `recompute-balances` writes, so the list shows the one positive free row the
 * history labels as an adjustment instead of a grant.
 *
 * The passkey rows carry generated credential ids and a placeholder COSE key:
 * they render in the list, and the device cannot sign in with them, because
 * nothing on the device holds their private key. Every id is derived from the
 * account, so two seeded accounts keep their own rows and a rerun replaces the
 * same ones; the passkey credential id is globally unique, so a fixed id could
 * only ever belong to one account.
 *
 * The provider keys need the local `byok-kms` service (`pnpm dev:start core`, or
 * `pnpm dev:byok-kms` with its `local-kms` dependency). Both envelopes are
 * wrapped before anything is deleted, so a missing service leaves the database
 * untouched. Neither secret is printed.
 *
 * A rerun deletes the rows this topic owns — the two derived passkey credential
 * ids, the four moderation logins, the five idempotency keys, the two derived
 * provider ids and the eight credit transaction ids — then inserts them again.
 */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const BLOCKED_LOGINS = ['spam-bot-2026', 'a-blocked-participant-with-a-long-handle'] as const;
const MUTED_LOGINS = ['noisy-reviewer', 'a-muted-participant-with-a-long-handle'] as const;

const NOTIFICATION_KEYS = [
  'dev-seed-notification-session',
  'dev-seed-notification-security',
  'dev-seed-notification-balance',
  'dev-seed-notification-briefing',
  'dev-seed-notification-long',
] as const;

const BYOK_PROVIDERS = ['anthropic', 'openai'] as const;

const CREDIT_KEYS = [
  'purchase-1',
  'purchase-2',
  'grant',
  'grant-expiry',
  'usage',
  'welcome-grant',
  'referral-grant',
  'accounting-adjustment',
  'program-grant',
  'program-grant-expiry',
  'voided-grant',
  'voided-grant-row',
] as const;

/** Stable UUID for one account's fixture key: a rerun replaces the same rows. */
function seedUuid(userId: string, key: string): string {
  const hex = createHash('md5').update(`app:mobile-profile-lists:${userId}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A base64url credential id, the form the table stores, derived from the
 * account so two accounts never claim the same globally unique value.
 */
function seedCredentialId(userId: string, index: number): string {
  return createHash('shake256', { outputLength: 24 })
    .update(`app:mobile-profile-lists:${userId}:passkey:${index}`)
    .digest('base64url');
}

function seedPaymentId(userId: string, key: string): string {
  return `pi_dev_seed_${createHash('md5')
    .update(`app:mobile-profile-lists:${userId}:${key}`)
    .digest('hex')
    .slice(0, 20)}`;
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * One calendar year after `value`, the way `resolvePaidCreditPolicy` writes the
 * `expiry_date` a `one_year` purchase carries (`addCalendarYearUtc` in
 * `packages/web-shared/src/lib/paidCreditPolicy.ts`): a February 29 purchase
 * lands on February 28 of the next year.
 */
function oneYearAfter(value: string): string {
  const date = new Date(value);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.toISOString();
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-profile-lists ${usage}`);
  console.log('');
  console.log('Seeds passkeys, blocked and muted logins, notification history, two provider');
  console.log('keys and credit history for one existing seeded account.');
  console.log('Requires a localhost database and the local byok-kms service.');
  console.log('Open the returned deep links in the signed-in mobile development client.');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const [email, ...rest] = args;
  if (!email || rest.length) {
    printUsage();
    throw new Error(
      `Pass one seeded account email: pnpm dev:seed app:mobile-profile-lists ${email ?? '<email>'}`
    );
  }
  assertLocalSeedDatabase('app:mobile-profile-lists');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This fixture requires a local development database.');
  }

  const normalizedEmail = normalizeSeedEmail(email.trim());
  const userId = await resolveSeedUserId(normalizedEmail);
  const db = getSeedDb();

  const credentialIds = [seedCredentialId(userId, 1), seedCredentialId(userId, 2)];
  const byokKeyIds = BYOK_PROVIDERS.map(provider => seedUuid(userId, `byok:${provider}`));
  const creditIds = CREDIT_KEYS.map(key => seedUuid(userId, `credit:${key}`));

  // Wrap both envelopes before the first delete: the KMS call is the only step
  // that can fail, and it must fail on a database that still holds the old rows.
  const envelopes = await Promise.all(
    BYOK_PROVIDERS.map((provider, index) => {
      const keyId = byokKeyIds[index];
      return createByokEnvelope(
        { key_id: keyId, owner_type: 'user', owner_id: userId, provider_id: provider },
        `dev-seed-purpose:${provider}`
      );
    })
  );

  // Reset only this topic's rows, each by a value it derives from the account.
  await db
    .delete(passkey_credentials)
    .where(
      and(
        eq(passkey_credentials.kilo_user_id, userId),
        inArray(passkey_credentials.credential_id, credentialIds)
      )
    );
  await db
    .delete(user_moderation_blocks)
    .where(
      and(
        eq(user_moderation_blocks.blocker_user_id, userId),
        inArray(user_moderation_blocks.blocked_github_login, [...BLOCKED_LOGINS])
      )
    );
  await db
    .delete(user_moderation_mutes)
    .where(
      and(
        eq(user_moderation_mutes.blocker_user_id, userId),
        inArray(user_moderation_mutes.muted_github_login, [...MUTED_LOGINS])
      )
    );
  await db
    .delete(user_notification_history)
    .where(
      and(
        eq(user_notification_history.user_id, userId),
        like(user_notification_history.idempotency_key, 'dev-seed-notification-%')
      )
    );
  await db.delete(byok_api_keys).where(inArray(byok_api_keys.id, byokKeyIds));
  await db.delete(credit_transactions).where(inArray(credit_transactions.id, creditIds));

  // The placeholder COSE key is a well-formed base64url string, not a key any
  // device holds: the rows list, and nothing signs in with them.
  await db.insert(passkey_credentials).values([
    {
      kilo_user_id: userId,
      credential_id: credentialIds[0],
      public_key: 'pQECAyYgASFYIGRldi1zZWVkLXBsYWNlaG9sZGVyLXB1YmxpYy1rZXk',
      sign_count: 3,
      transports: ['internal', 'hybrid'],
      device_type: 'multiDevice',
      backed_up: true,
      aaguid: 'adce0002-35bc-c60a-648b-0b25f1f05503',
      name: 'MacBook Pro (this device)',
      created_at: iso(-120 * DAY_MS),
      last_used_at: iso(-2 * DAY_MS),
    },
    {
      kilo_user_id: userId,
      credential_id: credentialIds[1],
      public_key: 'pQECAyYgASFYIGRldi1zZWVkLXBsYWNlaG9sZGVyLXNlY29uZC1rZXk',
      sign_count: 0,
      transports: ['usb', 'nfc'],
      device_type: 'singleDevice',
      backed_up: false,
      name: 'YubiKey 5C NFC kept in the desk drawer of the Berlin office',
      created_at: iso(-40 * DAY_MS),
      last_used_at: null,
    },
  ]);

  await db.insert(user_moderation_blocks).values(
    BLOCKED_LOGINS.map(login => ({
      blocker_user_id: userId,
      blocked_github_login: login,
      created_at: iso(-30 * DAY_MS),
    }))
  );
  await db.insert(user_moderation_mutes).values(
    MUTED_LOGINS.map(login => ({
      blocker_user_id: userId,
      muted_github_login: login,
      created_at: iso(-14 * DAY_MS),
    }))
  );

  // Raw-form pushes (`i18n_key` null): the row renders the stored copy, which is
  // what a producer that sends no catalog key records. `dedupe_bucket` is fixed
  // so the unique key stays stable across reruns.
  await db.insert(user_notification_history).values([
    {
      user_id: userId,
      category: 'agentAttention',
      push_type: 'cloud_agent_session',
      payload: {
        type: 'cloud_agent_session',
        cliSessionId: 'dev-seed-notification-session',
        category: 'attention',
      },
      i18n_key: null,
      i18n_params: null,
      fallback_title: 'Kilo',
      fallback_body: 'The release-check agent needs your answer.',
      idempotency_key: NOTIFICATION_KEYS[0],
      dedupe_bucket: 100,
      created_at: iso(-2 * HOUR_MS),
    },
    {
      user_id: userId,
      category: 'securityFindings',
      push_type: 'security_finding',
      payload: {
        type: 'security_finding',
        findingId: 'dev-seed-notification-finding',
        scope: 'personal',
      },
      i18n_key: null,
      i18n_params: null,
      fallback_title: 'New high-severity finding',
      fallback_body: 'Prototype pollution in left-pad, in acme/billing-service.',
      idempotency_key: NOTIFICATION_KEYS[1],
      dedupe_bucket: 101,
      created_at: iso(-20 * HOUR_MS),
    },
    {
      user_id: userId,
      category: 'balanceAlerts',
      push_type: 'low_balance',
      payload: { type: 'low_balance', organizationId: '5c1e7a90-0000-4000-8000-7a1b2c3d4e01' },
      i18n_key: null,
      i18n_params: null,
      fallback_title: 'Low balance',
      fallback_body: 'Kestrel Studio has less than $5 of credit left.',
      idempotency_key: NOTIFICATION_KEYS[2],
      dedupe_bucket: 102,
      created_at: iso(-2 * DAY_MS),
    },
    {
      user_id: userId,
      category: null,
      push_type: 'agent_briefing',
      payload: { type: 'agent_briefing', url: '/agent-briefing' },
      i18n_key: null,
      i18n_params: null,
      fallback_title: 'Your daily briefing is ready',
      fallback_body: 'Three sessions finished overnight.',
      idempotency_key: NOTIFICATION_KEYS[3],
      dedupe_bucket: 103,
      created_at: iso(-3 * DAY_MS),
    },
    {
      user_id: userId,
      category: 'agentAttention',
      push_type: 'cloud_agent_session',
      payload: {
        type: 'cloud_agent_session',
        cliSessionId: 'dev-seed-notification-long',
        category: 'attention',
      },
      i18n_key: null,
      i18n_params: null,
      fallback_title: 'Kilo',
      fallback_body:
        'The migration agent stopped before it applied the second file: the column it renames is referenced by a view that another session created in the same hour, and the agent needs a decision about which of the two should change first.',
      idempotency_key: NOTIFICATION_KEYS[4],
      dedupe_bucket: 104,
      created_at: iso(-5 * DAY_MS),
    },
  ]);

  await db.insert(byok_api_keys).values(
    BYOK_PROVIDERS.map((provider, index) => ({
      id: byokKeyIds[index],
      organization_id: null,
      kilo_user_id: userId,
      provider_id: provider,
      encrypted_api_key_envelope: envelopes[index],
      management_source: 'user' as const,
      created_by: userId,
      is_enabled: true,
    }))
  );

  // Column values as the producers write them: a Stripe top-up carries
  // `paid_credit_policy: 'one_year'` with `credit_source: 'stripe'`
  // (`getPaidCreditTerms('stripe')`, `stripe/index.ts`); a promotional grant is
  // `credit_source: 'promotion'`; an expiry copies its grant's terms and names
  // it through `original_transaction_id` (`packages/db/src/credit-expiration.ts`);
  // a legacy usage deduction has no source.
  const firstPurchaseAt = iso(-40 * DAY_MS);
  const secondPurchaseAt = iso(-12 * DAY_MS);
  await db.insert(credit_transactions).values([
    {
      id: creditIds[0],
      kilo_user_id: userId,
      amount_microdollars: 10_000_000,
      is_free: false,
      description: 'Top-up via stripe',
      credit_source: 'stripe',
      stripe_payment_id: seedPaymentId(userId, 'purchase-1'),
      paid_credit_policy: 'one_year',
      expiry_date: oneYearAfter(firstPurchaseAt),
      created_at: firstPurchaseAt,
    },
    {
      id: creditIds[1],
      kilo_user_id: userId,
      amount_microdollars: 25_000_000,
      is_free: false,
      description: 'Top-up via stripe',
      credit_source: 'stripe',
      stripe_payment_id: seedPaymentId(userId, 'purchase-2'),
      paid_credit_policy: 'one_year',
      expiry_date: oneYearAfter(secondPurchaseAt),
      created_at: secondPurchaseAt,
    },
    {
      id: creditIds[2],
      kilo_user_id: userId,
      amount_microdollars: 5_000_000,
      is_free: true,
      description: 'Promotional credit',
      credit_category: 'github-promo-2025-07-03',
      credit_source: 'promotion',
      expiry_date: iso(-10 * DAY_MS),
      created_at: iso(-90 * DAY_MS),
    },
    {
      id: creditIds[3],
      kilo_user_id: userId,
      amount_microdollars: -5_000_000,
      is_free: true,
      description: 'Expired: Promotional credit',
      credit_category: 'credits_expired',
      original_transaction_id: creditIds[2],
      credit_source: 'promotion',
      created_at: iso(-10 * DAY_MS),
    },
    {
      id: creditIds[4],
      kilo_user_id: userId,
      amount_microdollars: -1_250_000,
      is_free: false,
      description: 'Usage',
      created_at: iso(-6 * DAY_MS),
    },
    {
      id: creditIds[5],
      kilo_user_id: userId,
      amount_microdollars: 4_000_000,
      is_free: true,
      description: 'Welcome credits',
      credit_category: 'automatic-welcome-credits',
      credit_source: 'promotion',
      // The category's own term (`WELCOME_CREDIT_EXPIRY_HRS`, 30 days, in
      // `promoCreditCategoriesOld.ts`) runs from when the grant was written, so
      // this unspent grant still prints the date it runs out. The referral
      // grant below has no term and stays without one.
      created_at: iso(-5 * DAY_MS),
      expiry_date: iso(25 * DAY_MS),
    },
    {
      id: creditIds[6],
      kilo_user_id: userId,
      amount_microdollars: 2_000_000,
      is_free: true,
      description: 'Referral bonus',
      credit_category: 'referral-referring-bonus',
      credit_source: 'promotion',
      created_at: iso(-60 * DAY_MS),
    },
    {
      id: creditIds[7],
      kilo_user_id: userId,
      amount_microdollars: 500_000,
      is_free: true,
      description: 'Correction to match cached balance during recomputation',
      credit_category: 'accounting_adjustment',
      created_at: iso(-150 * DAY_MS),
    },
    {
      id: creditIds[8],
      kilo_user_id: userId,
      amount_microdollars: 2_000_000,
      is_free: true,
      description: 'Promotional credit for influencer',
      credit_category: 'influencer',
      credit_source: 'promotion',
      expiry_date: iso(-20 * DAY_MS),
      created_at: iso(-100 * DAY_MS),
    },
    {
      id: creditIds[9],
      kilo_user_id: userId,
      amount_microdollars: -2_000_000,
      is_free: true,
      description: 'Expired: Promotional credit for influencer',
      credit_category: 'credits_expired',
      original_transaction_id: creditIds[8],
      credit_source: 'promotion',
      created_at: iso(-20 * DAY_MS),
    },
    {
      id: creditIds[10],
      kilo_user_id: userId,
      amount_microdollars: 1_000_000,
      is_free: true,
      description: 'OSS Sponsorship Program initial credits',
      credit_category: 'oss-sponsorship',
      credit_source: 'promotion',
      expiry_date: iso(-30 * DAY_MS),
      created_at: iso(-120 * DAY_MS),
    },
    {
      id: creditIds[11],
      kilo_user_id: userId,
      amount_microdollars: -1_000_000,
      is_free: true,
      description: 'Credit voided from Orb system',
      credit_category: 'orb_credit_voided',
      original_transaction_id: creditIds[10],
      credit_source: 'promotion',
      created_at: iso(-30 * DAY_MS),
    },
  ]);

  console.log('This fixture represents:');
  console.log('  Passkeys, blocked and muted people, recorded notifications, two provider keys');
  console.log('  and a credit ledger with purchases, an expired campaign grant, a program');
  console.log('  grant with its own expiry, a voided program grant, an unspent grant that');
  console.log('  still expires, and a deduction.');
  console.log('  The passkey rows list but cannot sign in: no device holds their private key.');
  console.log('The empty states of the blocked-people and passkey lists need no seed: a fresh');
  console.log('account already shows them. Data export needs the cloud-data-export-ui release');
  console.log('toggle, and trusted hosts live in the device store, so neither is seeded here.');
  console.log('Suggested next step: open a returned deep link in the signed-in mobile app.');

  return {
    userId,
    email: normalizedEmail,
    passkeyCount: credentialIds.length,
    blockedCount: BLOCKED_LOGINS.length,
    mutedCount: MUTED_LOGINS.length,
    notificationCount: NOTIFICATION_KEYS.length,
    providerKeyCount: BYOK_PROVIDERS.length,
    creditTransactionCount: CREDIT_KEYS.length,
    passkeysDeepLink: 'kiloapp:///(app)/(tabs)/(3_profile)/passkeys',
    blockedPeopleDeepLink: 'kiloapp:///(app)/(tabs)/(3_profile)/blocked-people',
    notificationHistoryDeepLink: 'kiloapp:///(app)/(tabs)/(3_profile)/notification-history',
    providerKeysDeepLink: 'kiloapp:///(app)/(tabs)/(3_profile)/provider-keys',
    creditHistoryDeepLink: 'kiloapp:///(app)/(tabs)/(3_profile)/credit-history',
  };
}
