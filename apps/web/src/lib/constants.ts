export const FIRST_TOPUP_BONUS_AMOUNT: number = 0;

export const REFERRAL_BONUS_AMOUNT = 10;

export const PROMO_CREDIT_EXPIRY_HRS = 60 * 24; // 60 days in hours
export const WELCOME_CREDIT_EXPIRY_HRS = 30 * 24; // 30 days in hours
export const OPENCLAW_SECURITY_ADVISOR_BONUS_EXPIRY_HRS = 48; // 2 days in hours

export const allow_fake_login =
  !!process.env.DEBUG_SHOW_DEV_UI &&
  process.env.NODE_ENV !== 'production' &&
  !process.env.VERCEL_ENV;

export const MINIMUM_TOP_UP_AMOUNT = 10;
export const MAXIMUM_TOP_UP_AMOUNT = 10_000;
export const ORGANIZATION_ID_HEADER = 'x-kilocode-organizationid'; // We pass X-KiloCode-OrganizationId header to identify the organization in API requests

export const LANDING_URL =
  process.env.NODE_ENV === 'production' ? 'https://kilo.ai' : 'http://localhost:3001';

// In development, APP_URL derives from the PORT env var (set by scripts/dev.sh).
// APP_URL_OVERRIDE takes precedence for tunnels (e.g. ngrok).
export const APP_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://app.kilo.ai'
    : (process.env.APP_URL_OVERRIDE ?? `http://localhost:${process.env.PORT || '3000'}`);

export const TRIAL_DURATION_DAYS = 14;

export const AUTOCOMPLETE_MODEL = 'codestral-2508';

export const ENABLE_DEPLOY_FEATURE = true;
export const ENABLE_CODING_PLAN_SUBSCRIPTIONS = false;

export const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';

// Cloud Agent WebSocket URL (client-side, inlined at build time)
export const CLOUD_AGENT_WS_URL = process.env.NEXT_PUBLIC_CLOUD_AGENT_WS_URL ?? '';
// Cloud Agent Next WebSocket URL (client-side, inlined at build time)
// Separate URL for the new cloud-agent-next implementation
export const CLOUD_AGENT_NEXT_WS_URL = process.env.NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL ?? '';
// Session Ingest WebSocket URL (client-side, inlined at build time)
// Used by the CLI live transport for real-time event streaming
export const SESSION_INGEST_WS_URL = process.env.NEXT_PUBLIC_SESSION_INGEST_WS_URL ?? '';

// Next.js inlines NEXT_PUBLIC_* at build time. Fail loudly when required
// public URLs are missing so misconfiguration surfaces at startup instead of
// producing relative URLs against the app origin.
function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

// Gastown worker URL (client-side, inlined at build time)
// The browser talks directly to the gastown Cloudflare Worker for tRPC + WS.
// Must use NEXT_PUBLIC_ prefix so Next.js exposes it to the browser bundle.
export const GASTOWN_URL = requireEnv(
  'NEXT_PUBLIC_GASTOWN_URL',
  process.env.NEXT_PUBLIC_GASTOWN_URL
);

// Kilo Chat worker URL (client-side, inlined at build time)
export const KILO_CHAT_URL = requireEnv(
  'NEXT_PUBLIC_KILO_CHAT_URL',
  process.env.NEXT_PUBLIC_KILO_CHAT_URL
);

// Event Service WebSocket URL (client-side, inlined at build time)
export const EVENT_SERVICE_URL = requireEnv(
  'NEXT_PUBLIC_EVENT_SERVICE_URL',
  process.env.NEXT_PUBLIC_EVENT_SERVICE_URL
);

// Free model rate limits: per-IP for client-side products, per-user for server-side products
export const FREE_MODEL_RATE_LIMIT_WINDOW_HOURS = 1;
export const FREE_MODEL_MAX_REQUESTS_PER_WINDOW = 200;
export const ADMIN_RATE_LIMIT_TEST_MODEL = 'admin-rate-limit-test';

// Stripe publishable key (client-side, inlined at build time)
export const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';

export const PROMOTION_MAX_REQUESTS = 10000;
export const PROMOTION_WINDOW_HOURS = 24;

export const EXA_MONTHLY_ALLOWANCE_MICRODOLLARS = 10_000_000;
