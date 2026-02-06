export const deadline_XL_first_topup_bonus = new Date('2025-10-14T08:01Z');
const XL_first_topup_amount = 24;

export const is_XL_first_topup_bonus_active = (now?: Date) =>
  (now ?? new Date()) < deadline_XL_first_topup_bonus;
export const FIRST_TOPUP_BONUS_AMOUNT = (now?: Date) =>
  is_XL_first_topup_bonus_active(now) ? XL_first_topup_amount : 20;

export const REFERRAL_BONUS_AMOUNT = 10;

export const PROMO_CREDIT_EXPIRY_HRS = 60 * 24; // 60 days in hours

export const allow_fake_login =
  !!process.env.DEBUG_SHOW_DEV_UI &&
  process.env.NODE_ENV !== 'production' &&
  !process.env.VERCEL_ENV;

export const MINIMUM_TOP_UP_AMOUNT = 10;
export const MAXIMUM_TOP_UP_AMOUNT = 10_000;
export const ORGANIZATION_ID_HEADER = 'x-kilocode-organizationid'; // We pass X-KiloCode-OrganizationId header to identify the organization in API requests

export const LANDING_URL =
  process.env.NODE_ENV === 'production' ? 'https://kilo.ai' : 'http://localhost:3001';

// Make sure to also update NEXTAUTH_URL in the .env.* files
export const APP_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://app.kilo.ai'
    : (process.env.APP_URL_OVERRIDE ?? 'http://localhost:3000');

export const TRIAL_DURATION_DAYS = 30;

export const AUTOCOMPLETE_MODEL = 'codestral-2508';

export const ENABLE_DEPLOY_FEATURE = true;

export const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';

// Cloud Agent WebSocket URL (client-side, inlined at build time)
export const CLOUD_AGENT_WS_URL = process.env.NEXT_PUBLIC_CLOUD_AGENT_WS_URL ?? '';
// Cloud Agent Next WebSocket URL (client-side, inlined at build time)
// Separate URL for the new cloud-agent-next implementation
export const CLOUD_AGENT_NEXT_WS_URL = process.env.NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL ?? '';

// Free model rate limits (applies to both anonymous and authenticated users)
export const FREE_MODEL_RATE_LIMIT_WINDOW_HOURS = 1;
export const FREE_MODEL_MAX_REQUESTS_PER_WINDOW = 200;

// Stripe publishable key (client-side, inlined at build time)
export const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';
