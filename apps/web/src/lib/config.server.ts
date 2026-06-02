import { APP_URL } from '@/lib/constants';
import { getEnvVariable, requireEnv } from '@/lib/dotenvx';
import 'server-only';

export const IS_IN_AUTOMATED_TEST = !!getEnvVariable('IS_IN_AUTOMATED_TEST');
export const NEXTAUTH_URL = APP_URL;
export const MAILGUN_API_KEY = getEnvVariable('MAILGUN_API_KEY');
export const MAILGUN_DOMAIN = getEnvVariable('MAILGUN_DOMAIN');
export const NEVERBOUNCE_API_KEY = getEnvVariable('NEVERBOUNCE_API_KEY');
export const WORKOS_API_KEY = getEnvVariable('WORKOS_API_KEY');
export const WORKOS_CLIENT_ID = getEnvVariable('WORKOS_CLIENT_ID');
export const GOOGLE_CLIENT_ID = getEnvVariable('GOOGLE_CLIENT_ID');
export const GOOGLE_CLIENT_SECRET = getEnvVariable('GOOGLE_CLIENT_SECRET');
export const GOOGLE_WORKSPACE_OAUTH_CLIENT_ID = getEnvVariable('GOOGLE_WORKSPACE_OAUTH_CLIENT_ID');
export const GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = getEnvVariable(
  'GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET'
);
export const GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI = getEnvVariable(
  'GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI'
);
export const GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY = getEnvVariable(
  'GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY'
);
export const GITHUB_CLIENT_ID = getEnvVariable('GITHUB_CLIENT_ID');
export const GITHUB_CLIENT_SECRET = getEnvVariable('GITHUB_CLIENT_SECRET');
// Admin-only GitHub access (used for admin dashboards)
export const GITHUB_ADMIN_STATS_TOKEN = getEnvVariable('GITHUB_ADMIN_STATS_TOKEN');
export const CONTRIBUTOR_CHAMPION_TEAM_EMAILS =
  getEnvVariable('CONTRIBUTOR_CHAMPION_TEAM_EMAILS') || '';
export const GITLAB_CLIENT_ID = getEnvVariable('GITLAB_CLIENT_ID');
export const GITLAB_CLIENT_SECRET = getEnvVariable('GITLAB_CLIENT_SECRET');
export const LINKEDIN_CLIENT_ID = getEnvVariable('LINKEDIN_CLIENT_ID');
export const LINKEDIN_CLIENT_SECRET = getEnvVariable('LINKEDIN_CLIENT_SECRET');
export const TURNSTILE_SECRET_KEY = getEnvVariable('TURNSTILE_SECRET_KEY');
export const NEXTAUTH_SECRET = getEnvVariable('NEXTAUTH_SECRET');
export const OPENROUTER_API_KEY = getEnvVariable('OPENROUTER_API_KEY');
export const MISTRAL_API_KEY = getEnvVariable('MISTRAL_API_KEY');
export const OPENAI_API_KEY = getEnvVariable('OPENAI_API_KEY');
export const INCEPTION_API_KEY = getEnvVariable('INCEPTION_API_KEY');
export const EXA_API_KEY = getEnvVariable('EXA_API_KEY');
export const INTERNAL_API_SECRET = getEnvVariable('INTERNAL_API_SECRET');
export const CALLBACK_TOKEN_SECRET = getEnvVariable('CALLBACK_TOKEN_SECRET');
export const CODE_REVIEW_WORKER_AUTH_TOKEN = getEnvVariable('CODE_REVIEW_WORKER_AUTH_TOKEN');
export const IMPACT_ACCOUNT_SID = getEnvVariable('IMPACT_ACCOUNT_SID') || '';
export const IMPACT_AUTH_TOKEN = getEnvVariable('IMPACT_AUTH_TOKEN') || '';
export const IMPACT_CAMPAIGN_ID = getEnvVariable('IMPACT_CAMPAIGN_ID') || '';
export const IMPACT_ADVOCATE_TENANT_ALIAS = getEnvVariable('IMPACT_ADVOCATE_TENANT_ALIAS') || '';
export const IMPACT_ADVOCATE_PROGRAM_ID = getEnvVariable('IMPACT_ADVOCATE_PROGRAM_ID') || '';
export const IMPACT_ADVOCATE_ACCOUNT_SID = getEnvVariable('IMPACT_ADVOCATE_ACCOUNT_SID') || '';
export const IMPACT_ADVOCATE_AUTH_TOKEN = getEnvVariable('IMPACT_ADVOCATE_AUTH_TOKEN') || '';
export const IMPACT_ADVOCATE_WIDGET_ID = getEnvVariable('IMPACT_ADVOCATE_WIDGET_ID') || '';
export const IMPACT_ADVOCATE_API_BASE_URL =
  getEnvVariable('IMPACT_ADVOCATE_API_BASE_URL') || 'https://app.referralsaasquatch.com';
export const IMPACT_ADVOCATE_DEBUG_LOGGING =
  getEnvVariable('IMPACT_ADVOCATE_DEBUG_LOGGING') === 'true';

// Gates the Coding Plans UI on the /subscriptions route. Hidden by default so
// the feature can ship dark; set CODING_PLANS_PURCHASE_ENABLED=true to reveal it.
export const CODING_PLANS_PURCHASE_ENABLED =
  getEnvVariable('CODING_PLANS_PURCHASE_ENABLED') === 'true';

if (!NEXTAUTH_SECRET) throw new Error('NEXTAUTH_SECRET is required JWT signing');
if (!TURNSTILE_SECRET_KEY) throw new Error('TURNSTILE_SECRET_KEY is required');
if (!CALLBACK_TOKEN_SECRET) throw new Error('CALLBACK_TOKEN_SECRET is required');

export const STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID = getEnvVariable(
  'STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID'
);

export const STRIPE_ENTERPRISE_SUBSCRIPTION_PRODUCT_ID = getEnvVariable(
  'STRIPE_ENTERPRISE_SUBSCRIPTION_PRODUCT_ID'
);

export const STRIPE_TEAMS_MONTHLY_PRICE_ID = getEnvVariable('STRIPE_TEAMS_MONTHLY_PRICE_ID');
export const STRIPE_TEAMS_ANNUAL_PRICE_ID = getEnvVariable('STRIPE_TEAMS_ANNUAL_PRICE_ID');
export const STRIPE_ENTERPRISE_MONTHLY_PRICE_ID = getEnvVariable(
  'STRIPE_ENTERPRISE_MONTHLY_PRICE_ID'
);
export const STRIPE_ENTERPRISE_ANNUAL_PRICE_ID = getEnvVariable(
  'STRIPE_ENTERPRISE_ANNUAL_PRICE_ID'
);

export const USER_DEPLOYMENTS_API_BASE_URL =
  getEnvVariable('USER_DEPLOYMENTS_API_BASE_URL') ||
  'https://kilo-test-builder-do.engineering-e11.workers.dev';
export const USER_DEPLOYMENTS_API_AUTH_KEY = getEnvVariable('USER_DEPLOYMENTS_API_AUTH_KEY') || '';

// Dispatcher API for password protection
export const USER_DEPLOYMENTS_DISPATCHER_URL =
  getEnvVariable('USER_DEPLOYMENTS_DISPATCHER_URL') || '';
export const USER_DEPLOYMENTS_DISPATCHER_AUTH_KEY =
  getEnvVariable('USER_DEPLOYMENTS_DISPATCHER_AUTH_KEY') || '';

/**
 * RSA public key used for encrypting deployment environment variables.
 * Must be in PEM format, one line base64 encoded
 */
export const USER_DEPLOYMENTS_ENV_VARS_PUBLIC_KEY =
  getEnvVariable('USER_DEPLOYMENTS_ENV_VARS_PUBLIC_KEY') || '';

// openssl rand -base64 32
export const USER_DEPLOYMENTS_GIT_TOKEN_ENCRYPTION_KEY = getEnvVariable(
  'USER_DEPLOYMENTS_GIT_TOKEN_ENCRYPTION_KEY'
);

/**
 * AES-256 encryption key for BYOK API keys.
 * Must be a base64-encoded 32-byte (256-bit) key.
 * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
export const BYOK_ENCRYPTION_KEY = requireEnv(
  'BYOK_ENCRYPTION_KEY',
  getEnvVariable('BYOK_ENCRYPTION_KEY')
);

// Artificial Analysis API
export const ARTIFICIAL_ANALYSIS_API_KEY = getEnvVariable('ARTIFICIAL_ANALYSIS_API_KEY');

// Cron jobs
export const CRON_SECRET = getEnvVariable('CRON_SECRET');

// Qdrant configuration
export const QDRANT_HOST = getEnvVariable('QDRANT_HOST');
export const QDRANT_API_KEY = getEnvVariable('QDRANT_API_KEY');
// Qdrant cluster RAM size in GB (hard-coded based on cluster tier)
// Development: 1 GB, Production: 16 GB
export const QDRANT_CLUSTER_RAM_GB = Number(getEnvVariable('QDRANT_CLUSTER_RAM_GB') || '1');

// Milvus/Zilliz Cloud configuration
export const MILVUS_ADDRESS = getEnvVariable('MILVUS_ADDRESS');
export const MILVUS_TOKEN = getEnvVariable('MILVUS_TOKEN');

// App Builder
export const APP_BUILDER_URL = getEnvVariable('APP_BUILDER_URL');
export const APP_BUILDER_AUTH_TOKEN = getEnvVariable('APP_BUILDER_AUTH_TOKEN');

// App Builder DB Proxy
export const APP_BUILDER_DB_PROXY_URL = getEnvVariable('APP_BUILDER_DB_PROXY_URL');
export const APP_BUILDER_DB_PROXY_AUTH_TOKEN = getEnvVariable('APP_BUILDER_DB_PROXY_AUTH_TOKEN');

// Slack
export const SLACK_CLIENT_ID = getEnvVariable('SLACK_CLIENT_ID');
export const SLACK_CLIENT_SECRET = getEnvVariable('SLACK_CLIENT_SECRET');
export const SLACK_SIGNING_SECRET = getEnvVariable('SLACK_SIGNING_SECRET');

// Linear (bot integration)
// @chat-adapter/linear 4.27 does not (yet) support encryption-at-rest via
// an `encryptionKey` config option the way @chat-adapter/slack does; the
// adapter stores installations (including OAuth tokens) via the configured
// Chat SDK state adapter. Revisit when the adapter exposes an encryption key.
export const LINEAR_CLIENT_ID = getEnvVariable('LINEAR_CLIENT_ID');
export const LINEAR_CLIENT_SECRET = getEnvVariable('LINEAR_CLIENT_SECRET');
export const LINEAR_WEBHOOK_SECRET = getEnvVariable('LINEAR_WEBHOOK_SECRET');

// DoltHub OAuth integration
export const DOLTHUB_APP_CLIENT_ID = getEnvVariable('DOLTHUB_APP_CLIENT_ID');
export const DOLTHUB_APP_CLIENT_SECRET = getEnvVariable('DOLTHUB_APP_CLIENT_SECRET');

// Discord (bot integration — existing)
export const DISCORD_CLIENT_ID = getEnvVariable('DISCORD_CLIENT_ID');
export const DISCORD_CLIENT_SECRET = getEnvVariable('DISCORD_CLIENT_SECRET');
export const DISCORD_BOT_TOKEN = getEnvVariable('DISCORD_BOT_TOKEN');
export const DISCORD_PUBLIC_KEY = getEnvVariable('DISCORD_PUBLIC_KEY');

// Discord (OAuth user-linking app — separate application for auth + guild membership)
export const DISCORD_OAUTH_CLIENT_ID = getEnvVariable('DISCORD_OAUTH_CLIENT_ID');
export const DISCORD_OAUTH_CLIENT_SECRET = getEnvVariable('DISCORD_OAUTH_CLIENT_SECRET');
export const DISCORD_OAUTH_BOT_TOKEN = getEnvVariable('DISCORD_OAUTH_BOT_TOKEN');
export const DISCORD_SERVER_ID = getEnvVariable('DISCORD_SERVER_ID');

// Apple Sign In
export const APPLE_CLIENT_ID = getEnvVariable('APPLE_CLIENT_ID');
export const APPLE_TEAM_ID = getEnvVariable('APPLE_TEAM_ID');
export const APPLE_KEY_ID = getEnvVariable('APPLE_KEY_ID');
export const APPLE_PRIVATE_KEY = getEnvVariable('APPLE_PRIVATE_KEY');

// Posts user feedback into a fixed Slack channel in the Kilo workspace.
// Expected to be a Slack Incoming Webhook URL.
export const SLACK_USER_FEEDBACK_WEBHOOK_URL = getEnvVariable('SLACK_USER_FEEDBACK_WEBHOOK_URL');
// Posts deploy threat alerts to a dedicated Slack channel.
// Expected to be a Slack Incoming Webhook URL.
export const SLACK_DEPLOY_THREAT_WEBHOOK_URL = getEnvVariable('SLACK_DEPLOY_THREAT_WEBHOOK_URL');

// AI Attribution Service
export const AI_ATTRIBUTION_ADMIN_SECRET = getEnvVariable('AI_ATTRIBUTION_ADMIN_SECRET');

// Abuse Detection Service
export const ABUSE_SERVICE_CF_ACCESS_CLIENT_ID = getEnvVariable(
  'ABUSE_SERVICE_CF_ACCESS_CLIENT_ID'
);
export const ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET = getEnvVariable(
  'ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET'
);
export const ABUSE_SERVICE_URL =
  getEnvVariable('ABUSE_SERVICE_URL') ||
  (process.env.NODE_ENV === 'production' ? 'https://abuse.kiloapps.io' : null);

// Validate CF Access credentials are present in production (not test/preview environments)
if (process.env.NODE_ENV === 'production') {
  if (!ABUSE_SERVICE_CF_ACCESS_CLIENT_ID) {
    throw new Error('ABUSE_SERVICE_CF_ACCESS_CLIENT_ID is required in production');
  }
  if (!ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET) {
    throw new Error('ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET is required in production');
  }
}

/**
 * RSA public key used for encrypting agent environment profile secrets.
 * Must be in PEM format, one line base64 encoded.
 * The corresponding private key is stored in the cloud-agent worker.
 */
export const AGENT_ENV_VARS_PUBLIC_KEY = getEnvVariable('AGENT_ENV_VARS_PUBLIC_KEY') || '';

// Gastown Service
export const GASTOWN_SERVICE_URL =
  getEnvVariable('GASTOWN_SERVICE_URL') ||
  (process.env.NODE_ENV === 'production' ? 'https://gastown.kiloapps.io' : null);
export const GASTOWN_CF_ACCESS_CLIENT_ID = getEnvVariable('GASTOWN_SERVICE_CF_ACCESS_CLIENT_ID');
export const GASTOWN_CF_ACCESS_CLIENT_SECRET = getEnvVariable(
  'GASTOWN_SERVICE_CF_ACCESS_CLIENT_SECRET'
);

if (process.env.NODE_ENV === 'production') {
  if (!GASTOWN_CF_ACCESS_CLIENT_ID) {
    throw new Error('GASTOWN_CF_ACCESS_CLIENT_ID is required in production');
  }
  if (!GASTOWN_CF_ACCESS_CLIENT_SECRET) {
    throw new Error('GASTOWN_CF_ACCESS_CLIENT_SECRET is required in production');
  }
}

// Cloudflare dashboard link construction (admin town inspector)
export const CLOUDFLARE_ACCOUNT_ID = getEnvVariable('CLOUDFLARE_ACCOUNT_ID');
export const CLOUDFLARE_TOWN_DO_NAMESPACE_ID = getEnvVariable('CLOUDFLARE_TOWN_DO_NAMESPACE_ID');
export const CLOUDFLARE_CONTAINER_DO_NAMESPACE_ID = getEnvVariable(
  'CLOUDFLARE_CONTAINER_DO_NAMESPACE_ID'
);

// KiloClaw Worker
export const KILOCLAW_API_URL = getEnvVariable('KILOCLAW_API_URL') || '';
export const KILOCLAW_INBOUND_EMAIL_DOMAIN =
  getEnvVariable('KILOCLAW_INBOUND_EMAIL_DOMAIN') || 'kiloclaw.ai';
export const COMPOSIO_AGENTS_API_BASE_URL =
  getEnvVariable('COMPOSIO_AGENTS_API_BASE_URL') || 'https://agents.composio.dev';
export const COMPOSIO_API_BASE_URL =
  getEnvVariable('COMPOSIO_API_BASE_URL') || 'https://backend.composio.dev';

/**
 * Per-instance worker URL template.
 *
 * Per-instance URLs are the default in BOTH production and dev/test so a
 * merge of the name-based routing feature flips them on automatically,
 * without forcing anyone to edit env files.
 *
 * Resolution rules (checked in order):
 *   1. `KILOCLAW_INSTANCE_URL_TEMPLATE=legacy` (case-insensitive) is the
 *      explicit **kill switch** — disables per-instance URLs entirely and
 *      falls back to the single-host `KILOCLAW_API_URL`. Operators can
 *      roll prod back without a code deploy; devs can disable locally.
 *      A non-empty sentinel is used (rather than empty string) because
 *      Vercel / Node env pipelines often coerce empty env entries into
 *      "unset", making an empty-string rollback unreliable.
 *   2. A non-empty `KILOCLAW_INSTANCE_URL_TEMPLATE` is used verbatim.
 *      Must contain `{label}`; missing placeholder is a misconfiguration
 *      warned about at render time (see `workerUrlForInstance`).
 *   3. Otherwise in `NODE_ENV=production`, default to the canonical
 *      `https://{label}.kiloclaw.ai` template.
 *   4. Otherwise (dev/test) derive a template from `KILOCLAW_API_URL`:
 *      if `KILOCLAW_API_URL` looks like a loopback URL (`http://localhost:<port>`
 *      / `http://127.0.0.1:<port>`), emit
 *      `http://{label}.kiloclaw.localhost:<port>` so the browser
 *      auto-resolves `*.kiloclaw.localhost` to `127.0.0.1` per RFC 6761.
 *      If `KILOCLAW_API_URL` is missing or unparsable, fall back to the
 *      same template with the wrangler dev port (`8795`) — matches
 *      `.dev.vars.example`.
 *
 * When the template ends up set and contains `{label}`, `getStatus`
 * emits a `workerUrl` pointing at the instance's own virtual host
 * (derived from its sandboxId) for instances whose
 * `controllerCapabilitiesVersion >= 2`. Pre-v2 instances keep falling
 * back to `KILOCLAW_API_URL`.
 *
 * Exported as a plain function so it's testable without forcing a
 * re-import of this entire module (which triggers production-only
 * validation of unrelated secrets).
 */
const DEFAULT_DEV_WRANGLER_PORT = '8795';

/**
 * Sentinel value for `KILOCLAW_INSTANCE_URL_TEMPLATE` that disables the
 * per-instance URL pattern entirely. Case-insensitive match. Picked as
 * a non-empty word because empty env values are unreliable across
 * Vercel / Node / dotenv pipelines (often dropped or indistinguishable
 * from "unset"), which would mean the kill switch silently fails open.
 */
const KILL_SWITCH_SENTINEL = 'legacy';

function deriveDevTemplateFromWorkerUrl(workerUrl: string | undefined): string {
  const fallback = `http://{label}.kiloclaw.localhost:${DEFAULT_DEV_WRANGLER_PORT}`;
  if (!workerUrl) return fallback;
  try {
    const parsed = new URL(workerUrl);
    // Only derive when we're pointed at a loopback dev worker. Anything
    // else (remote staging, preview domains, etc.) uses the same
    // fallback — operators can still override explicitly.
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      return fallback;
    }
    const port = parsed.port || DEFAULT_DEV_WRANGLER_PORT;
    return `${parsed.protocol}//{label}.kiloclaw.localhost:${port}`;
  } catch {
    return fallback;
  }
}

export function resolveInstanceUrlTemplate(
  envVar: string | undefined,
  nodeEnv: string | undefined,
  workerUrl: string | undefined
): string {
  // Explicit kill switch. Empty string falls through to the production
  // / dev defaults — operators must set `legacy` to disable, not "".
  if (envVar !== undefined && envVar.toLowerCase() === KILL_SWITCH_SENTINEL) {
    return '';
  }
  // Non-empty explicit override wins.
  if (envVar !== undefined && envVar !== '') return envVar;
  if (nodeEnv === 'production') return 'https://{label}.kiloclaw.ai';
  return deriveDevTemplateFromWorkerUrl(workerUrl);
}

export const KILOCLAW_INSTANCE_URL_TEMPLATE = resolveInstanceUrlTemplate(
  process.env.KILOCLAW_INSTANCE_URL_TEMPLATE,
  process.env.NODE_ENV,
  KILOCLAW_API_URL
);

// KiloClaw Early Bird Checkout
export const STRIPE_KILOCLAW_EARLYBIRD_PRICE_ID = getEnvVariable(
  'STRIPE_KILOCLAW_EARLYBIRD_PRICE_ID'
);
export const STRIPE_KILOCLAW_EARLYBIRD_COUPON_ID = getEnvVariable(
  'STRIPE_KILOCLAW_EARLYBIRD_COUPON_ID'
);
// Webhook Agent Ingest Worker
export const WEBHOOK_AGENT_URL =
  getEnvVariable('WEBHOOK_AGENT_URL') || 'https://hooks.kilosessions.ai';

// Model eval ingest Worker
export const MODEL_EVAL_INGEST_URL = getEnvVariable('MODEL_EVAL_INGEST_URL') || '';

// Session ingest worker (public share proxy)
export const SESSION_INGEST_WORKER_URL = getEnvVariable('SESSION_INGEST_WORKER_URL') || '';

// Google Web Risk API
export const GOOGLE_WEB_RISK_API_KEY = getEnvVariable('GOOGLE_WEB_RISK_API_KEY');

export const CREDIT_CATEGORIES_ENCRYPTION_KEY = getEnvVariable('CREDIT_CATEGORIES_ENCRYPTION_KEY');

// Agent observability ingest service
export const O11Y_SERVICE_URL = getEnvVariable('O11Y_SERVICE_URL') || '';
export const O11Y_KILO_GATEWAY_CLIENT_SECRET = getEnvVariable('O11Y_KILO_GATEWAY_CLIENT_SECRET');

// Security agent BetterStack heartbeat URLs
export const SECURITY_CLEANUP_BETTERSTACK_HEARTBEAT_URL = getEnvVariable(
  'SECURITY_CLEANUP_BETTERSTACK_HEARTBEAT_URL'
);

// Pylon chat widget (support chat on KiloClaw pages).
// PYLON_IDENTITY_SECRET is the shared secret from the Pylon dashboard used to HMAC-sign
// the user's email so the widget can verify the end user's identity.
export const PYLON_IDENTITY_SECRET = getEnvVariable('PYLON_IDENTITY_SECRET') || '';

// Pipe-delimited list of TLDs to block from new signups, each with a leading dot (e.g. ".shop|.top|.co.uk")
const blacklistTldsEnv = getEnvVariable('BLACKLIST_TLDS');
export const BLACKLIST_TLDS = blacklistTldsEnv
  ? blacklistTldsEnv
      .split('|')
      .map((tld: string) => tld.trim().toLowerCase())
      .filter(Boolean)
  : [];
