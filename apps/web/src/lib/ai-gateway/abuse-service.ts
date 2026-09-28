import {
  ABUSE_SERVICE_CF_ACCESS_CLIENT_ID,
  ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET,
  ABUSE_SERVICE_URL,
} from '@/lib/config.server';
import type { AuthProviderId } from '@/lib/auth/provider-metadata';
import 'server-only';

async function fetchAbuseService<T>(
  path: string,
  payload: unknown,
  label: string
): Promise<T | null> {
  if (!ABUSE_SERVICE_URL) {
    return null;
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (ABUSE_SERVICE_CF_ACCESS_CLIENT_ID && ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET) {
      headers['CF-Access-Client-Id'] = ABUSE_SERVICE_CF_ACCESS_CLIENT_ID;
      headers['CF-Access-Client-Secret'] = ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET;
    }

    const response = await fetch(`${ABUSE_SERVICE_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`[Abuse] ${label} failed (${response.status}): ${await response.text()}`);
      return null;
    }

    return (await response.json()) as T;
  } catch (error) {
    console.error(`[Abuse] ${label} error:`, error);
    return null;
  }
}

export type AuthEventPayload = {
  kilo_user_id: string;
  event_type: 'signup' | 'signin';
  email: string;
  account_created_at?: string;
  ip_address?: string | null;
  geo_city?: string | null;
  geo_country?: string | null;
  ja4_digest?: string | null;
  user_agent?: string | null;
  auth_method?: AuthProviderId | null;
  stytch_session_id?: string | null;

  hosted_domain?: string | null;
  signup_ip?: string | null;
  signup_ja4_digest?: string | null;
  signup_geo_country?: string | null;
  customer_source?: string | null;
  is_bot?: boolean | null;
  is_admin?: boolean | null;
  is_blocked?: boolean | null;
  completed_welcome_form?: boolean | null;
  has_linkedin_url?: boolean | null;
  has_github_url?: boolean | null;
  has_discord_verified?: boolean | null;
  cohorts?: string[] | null;

  has_validation_stytch?: boolean | null;
  has_validation_novel_card_with_hold?: boolean | null;
  stytch_verdict_action?: string | null;
  stytch_is_authentic_device?: boolean | null;
  stytch_device_type?: string | null;
  stytch_hardware_fingerprint?: string | null;
  auth_providers?: string[] | null;

  org_memberships?: Array<{
    organization_id: string;
    role?: string | null;
    plan?: string | null;
    has_sso?: boolean | null;
    in_free_trial?: boolean | null;
  }> | null;
};

export async function reportAuthEvent(payload: AuthEventPayload): Promise<void> {
  await fetchAbuseService('/api/auth-event', payload, 'auth event');
}

type UserEventData = {
  kilo_user_id: string;
  reason?: string | null;
  actor_email?: string | null;
};

type UserEmailChangedData = {
  kilo_user_id: string;
  previous_email?: string | null;
  email: string;
};

type OrgEventData = {
  kilo_user_id: string;
  organization_id: string;
  role?: string | null;
  plan?: string | null;
  has_sso?: boolean;
  in_free_trial?: boolean;
};

type BillingCreditPurchasedData = {
  kilo_user_id: string;
  microdollars_acquired: number;
  total_microdollars_acquired?: number;
};

type BillingKiloPassChangedData = {
  kilo_user_id: string;
  tier?: string | null;
  status?: string | null;
  streak_months?: number;
};

type StripeEventData = {
  id?: string;
  type?: string;
  customer?: string | { id: string } | null;
  data?: {
    object?: { amount?: number; customer?: unknown; decline_code?: string; [k: string]: unknown };
  };
  decline_code?: string;
  amount?: number;
  [k: string]: unknown;
};

export type CloudEvent =
  | { type: 'user.blocked'; occurred_at?: number; data: UserEventData }
  | { type: 'user.unblocked'; occurred_at?: number; data: UserEventData }
  | { type: 'user.deleted'; occurred_at?: number; data: { kilo_user_id: string } }
  | { type: 'user.email_changed'; occurred_at?: number; data: UserEmailChangedData }
  | { type: 'org.member_added'; occurred_at?: number; data: OrgEventData }
  | { type: 'org.member_removed'; occurred_at?: number; data: OrgEventData }
  | { type: 'org.created'; occurred_at?: number; data: OrgEventData }
  | { type: 'org.deleted'; occurred_at?: number; data: OrgEventData }
  | { type: 'billing.credit_purchased'; occurred_at?: number; data: BillingCreditPurchasedData }
  | { type: 'billing.kilo_pass_changed'; occurred_at?: number; data: BillingKiloPassChangedData }
  | { type: 'stripe.payment_method.attached'; occurred_at?: number; data: StripeEventData }
  | { type: 'stripe.payment_method.detached'; occurred_at?: number; data: StripeEventData }
  | { type: 'stripe.charge.dispute.created'; occurred_at?: number; data: StripeEventData }
  | { type: 'stripe.charge.dispute.funds_withdrawn'; occurred_at?: number; data: StripeEventData }
  | {
      type: 'stripe.radar.early_fraud_warning.created';
      occurred_at?: number;
      data: StripeEventData;
    }
  | { type: 'stripe.charge.failed'; occurred_at?: number; data: StripeEventData }
  | { type: 'stripe.payment_intent.succeeded'; occurred_at?: number; data: StripeEventData };

type EventsBatchPayload = {
  events: CloudEvent[];
};

export async function reportEvents(payload: EventsBatchPayload): Promise<void> {
  await fetchAbuseService('/api/events', payload, 'events');
}
