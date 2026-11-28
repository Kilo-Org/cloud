import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { getEnvVariable, requireEnv } from '@kilocode/web-shared/lib/dotenvx';
import 'server-only';

export const IS_IN_AUTOMATED_TEST = !!getEnvVariable('IS_IN_AUTOMATED_TEST');
export const PAID_CREDIT_EXPIRATION_EFFECTIVE_AT =
  getEnvVariable('PAID_CREDIT_EXPIRATION_EFFECTIVE_AT') || null;
export const NEXTAUTH_URL = APP_URL;
export const MAILGUN_API_KEY = getEnvVariable('MAILGUN_API_KEY');
export const MAILGUN_DOMAIN = getEnvVariable('MAILGUN_DOMAIN');
export const NEVERBOUNCE_API_KEY = getEnvVariable('NEVERBOUNCE_API_KEY');
export const WORKOS_API_KEY = getEnvVariable('WORKOS_API_KEY');
export const WORKOS_CLIENT_ID = getEnvVariable('WORKOS_CLIENT_ID');
export const GOOGLE_CLIENT_ID = getEnvVariable('GOOGLE_CLIENT_ID');
export const GOOGLE_CLIENT_SECRET = getEnvVariable('GOOGLE_CLIENT_SECRET');
export const ANACONDA_CLIENT_ID = getEnvVariable('ANACONDA_CLIENT_ID');
export const ANACONDA_CLIENT_SECRET = getEnvVariable('ANACONDA_CLIENT_SECRET');
export const OPENAI_CLIENT_ID = getEnvVariable('OPENAI_CLIENT_ID');
export const OPENAI_CLIENT_SECRET = getEnvVariable('OPENAI_CLIENT_SECRET');
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
export const USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID = getEnvVariable(
  'USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID'
);
export const USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY = getEnvVariable(
  'USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY'
);
export const GIT_TOKEN_SERVICE_API_URL = getEnvVariable('GIT_TOKEN_SERVICE_API_URL') || '';
// Admin-only GitHub access (used for admin dashboards)
export const GITHUB_ADMIN_STATS_TOKEN = getEnvVariable('GITHUB_ADMIN_STATS_TOKEN');
export const CONTRIBUTOR_CHAMPION_TEAM_EMAILS =
  getEnvVariable('CONTRIBUTOR_CHAMPION_TEAM_EMAILS') || '';
export const GITLAB_CLIENT_ID = getEnvVariable('GITLAB_CLIENT_ID');
export const GITLAB_CLIENT_SECRET = getEnvVariable('GITLAB_CLIENT_SECRET');
export const BITBUCKET_CLIENT_ID = getEnvVariable('BITBUCKET_CLIENT_ID');
export const BITBUCKET_CLIENT_SECRET = getEnvVariable('BITBUCKET_CLIENT_SECRET');
export const BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID = getEnvVariable(
  'BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID'
);
export const BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY = getEnvVariable(
  'BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY'
);
export const BITBUCKET_CODE_REVIEW_WEBHOOK_SIGNING_KEYS = getEnvVariable(
  'BITBUCKET_CODE_REVIEW_WEBHOOK_SIGNING_KEYS'
);
export const BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL =
  getEnvVariable('BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL') || '';
export const LINKEDIN_CLIENT_ID = getEnvVariable('LINKEDIN_CLIENT_ID');
export const LINKEDIN_CLIENT_SECRET = getEnvVariable('LINKEDIN_CLIENT_SECRET');
export const NEXTAUTH_SECRET = getEnvVariable('NEXTAUTH_SECRET');
export const PAGES_AUTH_SECRET = getEnvVariable('PAGES_AUTH_SECRET');
export const PAGES_DEV_AUTH_SECRET = getEnvVariable('PAGES_DEV_AUTH_SECRET');
export const OPENROUTER_API_KEY = getEnvVariable('OPENROUTER_API_KEY');
export const MISTRAL_API_KEY = getEnvVariable('MISTRAL_API_KEY');
export const EXA_API_KEY = getEnvVariable('EXA_API_KEY');
export const INTERNAL_API_SECRET = getEnvVariable('INTERNAL_API_SECRET');
export const CODE_REVIEW_HEALTH_SECRET = getEnvVariable('CODE_REVIEW_HEALTH_SECRET');
export const UPTIME_PROBE_SECRET = getEnvVariable('UPTIME_PROBE_SECRET');
export const MODELS_HEALTH_SECRET = getEnvVariable('MODELS_HEALTH_SECRET');
export const CLOUD_AGENT_DISPATCH_HEALTH_SECRET = getEnvVariable(
  'CLOUD_AGENT_DISPATCH_HEALTH_SECRET'
);
export const USAGE_INGEST_URL = getEnvVariable('USAGE_INGEST_URL');
export const USAGE_INGEST_PUBLISH_SECRET = getEnvVariable('USAGE_INGEST_PUBLISH_SECRET');
// The STS issuer of this deployment's environment (https://sts.kiloapps.io, staging
// https://sts-staging.kiloapps.io): the STS canary route verifies tokens it issued, for the
// environment `STS_ISSUERS` names it under, and mints from it with the function's Vercel identity.
// Empty or not one of `STS_ISSUERS`: the route answers 503.
export const STS_URL = getEnvVariable('STS_URL') || '';

// Shared secret with the internal token-mint callers: the MCP catalog CI job
// (.github/workflows/kilo-mcp-catalog.yml) and the kilo-app changelog workflows
// (.github/workflows/kilo-app-release.yml and
// kilo-app-changelog-history.yml). It authenticates only the mint in
// app/api/internal/mcp-catalog/token; it is never accepted as a Kilo credential.
export const MCP_CATALOG_TOKEN_SECRET = getEnvVariable('MCP_CATALOG_TOKEN_SECRET');
// Shared secret with internal-bot workloads (bouncer watch, auto-routing
// benchmark). It authenticates only the mint in app/api/internal/bot-token;
// it is never accepted as a Kilo credential.
export const BOT_TOKEN_MINT_SECRET = getEnvVariable('BOT_TOKEN_MINT_SECRET');
export function isBoundedInternalServiceTokenIssuanceEnabled(): boolean {
  return getEnvVariable('BOUNDED_INTERNAL_SERVICE_TOKENS_ENABLED') === 'true';
}
export function isNativeResourceCredentialIssuanceEnabled(): boolean {
  return (
    getEnvVariable('NATIVE_RESOURCE_TOKENS_ENABLED') === 'true' &&
    isSharedResourceTokenIssuanceEnabled()
  );
}
export function isSharedResourceTokenIssuanceEnabled(): boolean {
  return getEnvVariable('SHARED_RESOURCE_TOKENS_ENABLED') === 'true';
}
const resourceTokenFamilyFlags = {
  'cloud-agent-next': 'CLOUD_AGENT_RESOURCE_TOKENS_ENABLED',
  chat: 'CHAT_RESOURCE_TOKENS_ENABLED',
  'delegated-resource': 'DELEGATED_RESOURCE_TOKENS_ENABLED',
  'workflow-gateway': 'WORKFLOW_GATEWAY_RESOURCE_TOKENS_ENABLED',
  'internal-bot': 'INTERNAL_BOT_RESOURCE_TOKENS_ENABLED',
} as const;

export type ResourceTokenFamily = keyof typeof resourceTokenFamilyFlags;

export function isResourceTokenIssuanceEnabled(family: ResourceTokenFamily): boolean {
  return (
    isSharedResourceTokenIssuanceEnabled() &&
    getEnvVariable(resourceTokenFamilyFlags[family]) === 'true'
  );
}

export const USER_DATA_EXPORT_WORKER_URL =
  getEnvVariable('USER_DATA_EXPORT_WORKER_URL') ||
  (process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:8818' : '');
export const CODE_REVIEW_WORKER_AUTH_TOKEN = getEnvVariable('CODE_REVIEW_WORKER_AUTH_TOKEN');
export const CODE_REVIEW_WORKER_SENDER_AUTH = getEnvVariable('CODE_REVIEW_WORKER_SENDER_AUTH');
export const IMPACT_ACCOUNT_SID = getEnvVariable('IMPACT_ACCOUNT_SID') || '';
export const IMPACT_AUTH_TOKEN = getEnvVariable('IMPACT_AUTH_TOKEN') || '';
export const IMPACT_CAMPAIGN_ID = getEnvVariable('IMPACT_CAMPAIGN_ID') || '';
export const IMPACT_ADVOCATE_TENANT_ALIAS = getEnvVariable('IMPACT_ADVOCATE_TENANT_ALIAS') || '';
export const IMPACT_ADVOCATE_ACCOUNT_SID = getEnvVariable('IMPACT_ADVOCATE_ACCOUNT_SID') || '';
export const IMPACT_ADVOCATE_AUTH_TOKEN = getEnvVariable('IMPACT_ADVOCATE_AUTH_TOKEN') || '';
export const IMPACT_ADVOCATE_KILO_PASS_PROGRAM_ID =
  getEnvVariable('IMPACT_ADVOCATE_KILO_PASS_PROGRAM_ID') || '';
export const IMPACT_ADVOCATE_KILO_PASS_WIDGET_ID =
  getEnvVariable('IMPACT_ADVOCATE_KILO_PASS_WIDGET_ID') || '';
export const IMPACT_ADVOCATE_API_BASE_URL =
  getEnvVariable('IMPACT_ADVOCATE_API_BASE_URL') || 'https://app.referralsaasquatch.com';
export const IMPACT_ADVOCATE_DEBUG_LOGGING =
  getEnvVariable('IMPACT_ADVOCATE_DEBUG_LOGGING') === 'true';

// Gates the Coding Plans UI on the /subscriptions route. Hidden by default so
// the feature can ship dark; set CODING_PLANS_PURCHASE_ENABLED=true to reveal it.
export const CODING_PLANS_PURCHASE_ENABLED =
  getEnvVariable('CODING_PLANS_PURCHASE_ENABLED') === 'true';

// Optional at module initialization so unrelated web processes can start
// without BytePlus control-plane credentials. BytePlus operations fail closed
// when either value is absent.
export const BYTEPLUS_CODING_PLAN_ACCESS_KEY_ID = getEnvVariable(
  'BYTEPLUS_CODING_PLAN_ACCESS_KEY_ID'
);
export const BYTEPLUS_CODING_PLAN_SECRET_ACCESS_KEY = getEnvVariable(
  'BYTEPLUS_CODING_PLAN_SECRET_ACCESS_KEY'
);

export function isLocalCodeReviewDevelopmentEnabled(): boolean {
  return (
    !!getEnvVariable('DEBUG_SHOW_DEV_UI') &&
    process.env.NODE_ENV !== 'production' &&
    !process.env.VERCEL_ENV
  );
}

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
export const ENKRYPT_API_KEY = getEnvVariable('ENKRYPT_API_KEY');
export const ENKRYPT_SYNC_ENABLED = getEnvVariable('ENKRYPT_SYNC_ENABLED') === 'true';
export const ENKRYPT_PUBLICATION_ENABLED = getEnvVariable('ENKRYPT_PUBLICATION_ENABLED') === 'true';

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

// Cloud managed code indexing. Disabled unless explicitly enabled.
export const CODE_INDEXING_ENABLED = getEnvVariable('CODE_INDEXING_ENABLED') === 'true';
// Comma-separated user ids that may use code indexing without being an admin.
export const CODE_INDEXING_ENABLED_USER_IDS = getEnvVariable('CODE_INDEXING_ENABLED_USER_IDS');

// Slack
export const SLACK_CLIENT_ID = getEnvVariable('SLACK_CLIENT_ID');
export const SLACK_CLIENT_SECRET = getEnvVariable('SLACK_CLIENT_SECRET');
export const SLACK_SIGNING_SECRET = getEnvVariable('SLACK_SIGNING_SECRET');
export const SLACK_ENCRYPTION_KEY = getEnvVariable('SLACK_ENCRYPTION_KEY');
/**
 * RSA keyset for encrypting Slack bot credentials at rest, as JSON or base64-encoded
 * JSON: `{ "active": { "keyId": "...", "publicKeyPem": "..." },
 * "decrypt": [{ "keyId": "...", "privateKeyPem": "..." }] }`.
 *
 * Unlike the GitLab/Bitbucket platform-credential keys, web holds the private half
 * because the Slack webhook path decrypts in-process. See
 * `apps/web/src/lib/integrations/platforms/slack/credential-keyset.ts`.
 */
export const SLACK_CREDENTIAL_KEYSET_JSON = getEnvVariable('SLACK_CREDENTIAL_KEYSET_JSON');
// Posts notifications from server-side Admin UI code to a fixed Slack channel.
// Expected to be a Slack Incoming Webhook URL. Keep this server-only.
export const SLACK_ADMIN_NOTIFICATIONS_WEBHOOK_URL = getEnvVariable(
  'SLACK_ADMIN_NOTIFICATIONS_WEBHOOK_URL'
);

// Linear (bot integration)
// The adapter stores installations (including OAuth tokens) via the configured
// Chat SDK state adapter. Since @chat-adapter/linear 4.28 it supports
// encryption-at-rest via an `encryptionKey` config option (or the
// LINEAR_ENCRYPTION_KEY env var), the same way @chat-adapter/slack does.
// Neither adapter is configured with a key yet, so both store their tokens in
// plaintext in the state adapter.
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
export const APPLE_APP_BUNDLE_ID = getEnvVariable('APPLE_APP_BUNDLE_ID');

// Native Google client is a separate OAuth client from the web GOOGLE_CLIENT_ID.
export const GOOGLE_IOS_CLIENT_ID = getEnvVariable('GOOGLE_IOS_CLIENT_ID');

// Play Integrity verification config
export const GOOGLE_PLAY_INTEGRITY_PACKAGE_NAME = getEnvVariable(
  'GOOGLE_PLAY_INTEGRITY_PACKAGE_NAME'
);
export const GOOGLE_PLAY_INTEGRITY_CERT_DIGESTS = getEnvVariable(
  'GOOGLE_PLAY_INTEGRITY_CERT_DIGESTS'
);
export const GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY = getEnvVariable(
  'GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY'
);

// Posts user feedback into a fixed Slack channel in the Kilo workspace.
// Expected to be a Slack Incoming Webhook URL.
export const SLACK_USER_FEEDBACK_WEBHOOK_URL = getEnvVariable('SLACK_USER_FEEDBACK_WEBHOOK_URL');

// AI Attribution Service
export const AI_ATTRIBUTION_ADMIN_SECRET = getEnvVariable('AI_ATTRIBUTION_ADMIN_SECRET');

// Bouncer: configurable signup and inference admission, plus payment and usage evidence.
export const BOUNCER_URL =
  getEnvVariable('BOUNCER_URL') ||
  (process.env.NODE_ENV === 'production' ? 'https://bouncer.kiloapps.io' : null);

/**
 * RSA public key used for encrypting agent environment profile secrets.
 * Must be in PEM format, one line base64 encoded.
 * The corresponding private key is stored in the cloud-agent worker.
 */
export const AGENT_ENV_VARS_PUBLIC_KEY = getEnvVariable('AGENT_ENV_VARS_PUBLIC_KEY') || '';

export const CLOUDFLARE_ACCOUNT_ID = getEnvVariable('CLOUDFLARE_ACCOUNT_ID');
// Cloudflare Containers GraphQL Analytics (admin reconciliation). Point-of-use only; do not throw at module load.
export const CLOUDFLARE_ANALYTICS_API_TOKEN = getEnvVariable('CLOUDFLARE_ANALYTICS_API_TOKEN');

// KiloClaw Worker
export const KILOCLAW_API_URL = getEnvVariable('KILOCLAW_API_URL') || '';
export const KILOCLAW_INBOUND_EMAIL_DOMAIN =
  getEnvVariable('KILOCLAW_INBOUND_EMAIL_DOMAIN') || 'kiloclaw.ai';
export const COMPOSIO_AGENTS_API_BASE_URL =
  getEnvVariable('COMPOSIO_AGENTS_API_BASE_URL') || 'https://agents.composio.dev';
export const COMPOSIO_API_BASE_URL =
  getEnvVariable('COMPOSIO_API_BASE_URL') || 'https://backend.composio.dev';

export type DeploymentEnvironment = { VERCEL_ENV?: string; VERCEL_TARGET_ENV?: string };

const deploymentEnvironment: DeploymentEnvironment = {
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_TARGET_ENV: process.env.VERCEL_TARGET_ENV,
};

// Vercel sets both values to `production` only on a production deployment of the production
// target; a staging, preview or local runtime never has both, whatever its NODE_ENV.
function isConfirmedVercelProduction(env: DeploymentEnvironment): boolean {
  return env.VERCEL_ENV === 'production' && env.VERCEL_TARGET_ENV === 'production';
}

// A fully qualified name (trailing dots) and any scheme or port still reach the same host.
function urlHost(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/\.+$/, '');
  } catch {
    return null;
  }
}

// Cloudflare serves a Worker with `workers_dev` enabled at `<name>.<account>.workers.dev`, and a
// version preview at `<version>-<name>.<account>.workers.dev`.
function isWorkersDevHost(host: string, workerName: string): boolean {
  const firstLabel = host.split('.')[0] ?? '';
  return (
    host.endsWith('.workers.dev') &&
    (firstLabel === workerName || firstLabel.endsWith(`-${workerName}`))
  );
}

/**
 * A Worker URL whose production deployment has a built-in default. Production keeps its explicit
 * value or that default. Any other runtime uses only an explicit value off the production Worker:
 * unset, the production host, or (given `workersDevName`) that Worker's workers.dev host resolves
 * to '' (unconfigured), and the callers send nothing.
 */
export function resolveProductionDefaultedUrl(
  explicit: string | undefined,
  productionOrigin: string,
  env: DeploymentEnvironment,
  workersDevName?: string
): string {
  if (isConfirmedVercelProduction(env)) return explicit || productionOrigin;
  if (!explicit) return '';
  const host = urlHost(explicit);
  if (host === urlHost(productionOrigin)) return '';
  if (host !== null && workersDevName && isWorkersDevHost(host, workersDevName)) return '';
  return explicit;
}

/**
 * Per-instance worker URL template.
 *
 * Resolution rules (checked in order):
 *   1. `KILOCLAW_INSTANCE_URL_TEMPLATE=legacy` (case-insensitive) is the
 *      explicit **kill switch** — disables per-instance URLs entirely and
 *      falls back to the single-host `KILOCLAW_API_URL`. Operators can
 *      roll prod back without a code deploy; devs can disable locally.
 *      A non-empty sentinel is used (rather than empty string) because
 *      Vercel / Node env pipelines often coerce empty env entries into
 *      "unset", making an empty-string rollback unreliable.
 *   2. In the confirmed Vercel production deployment, a non-empty value is
 *      used verbatim, and unset defaults to the canonical
 *      `https://{label}.kiloclaw.ai` template.
 *   3. Anywhere else, only an explicit `http(s)` template is used, and never
 *      one on a host the production KiloClaw Worker serves (`kiloclaw.ai`,
 *      any `*.kiloclaw.ai`, `claw.kilosessions.ai`, `claw.kilo.ai`). Unset or
 *      refused means unconfigured (''), which keeps every instance on the
 *      legacy host (`KILOCLAW_LEGACY_WORKER_URL`).
 *      Local development sets `http://{label}.kiloclaw.localhost:8795`
 *      (`apps/web/.env.development.local.example`).
 *
 * A template missing `{label}` is a misconfiguration warned about at render
 * time (see `workerUrlForInstance`). When the template contains `{label}`,
 * `getStatus` emits a `workerUrl` pointing at the instance's own virtual host
 * (derived from its sandboxId) for instances whose
 * `controllerCapabilitiesVersion >= 2`. Pre-v2 instances keep falling back to
 * the legacy host (`KILOCLAW_LEGACY_WORKER_URL`).
 */
const PRODUCTION_INSTANCE_URL_TEMPLATE = 'https://{label}.kiloclaw.ai';

/**
 * Sentinel value for `KILOCLAW_INSTANCE_URL_TEMPLATE` that disables the
 * per-instance URL pattern entirely. Case-insensitive match. Picked as
 * a non-empty word because empty env values are unreliable across
 * Vercel / Node / dotenv pipelines (often dropped or indistinguishable
 * from "unset"), which would mean the kill switch silently fails open.
 */
const KILL_SWITCH_SENTINEL = 'legacy';

// Refuses the hosts routed to the production KiloClaw Worker (services/kiloclaw/wrangler.jsonc)
// and its documented browser host `claw.kilo.ai` (services/kiloclaw/README.md). Accepts a
// per-instance template (`{label}`) or a plain URL.
function isNonProductionKiloClawUrl(value: string): boolean {
  const url = value.replaceAll('{label}', 'label');
  const host = urlHost(url);
  return (
    host !== null &&
    /^https?:\/\//i.test(url) &&
    host !== 'kiloclaw.ai' &&
    !host.endsWith('.kiloclaw.ai') &&
    host !== 'claw.kilosessions.ai' &&
    host !== 'claw.kilo.ai'
  );
}

export function resolveInstanceUrlTemplate(
  envVar: string | undefined,
  env: DeploymentEnvironment
): string {
  // Explicit kill switch. Empty string counts as unset — operators must set
  // `legacy` to disable, not "".
  if (envVar !== undefined && envVar.toLowerCase() === KILL_SWITCH_SENTINEL) {
    return '';
  }
  if (isConfirmedVercelProduction(env)) return envVar || PRODUCTION_INSTANCE_URL_TEMPLATE;
  return envVar && isNonProductionKiloClawUrl(envVar) ? envVar : '';
}

export const KILOCLAW_INSTANCE_URL_TEMPLATE = resolveInstanceUrlTemplate(
  process.env.KILOCLAW_INSTANCE_URL_TEMPLATE,
  deploymentEnvironment
);

/**
 * The single-host KiloClaw URL the browser uses when no per-instance host applies. Production
 * keeps `KILOCLAW_API_URL` or `https://claw.kilo.ai`. Anywhere else only an explicit `http(s)`
 * `KILOCLAW_API_URL` off the production KiloClaw hosts is used; otherwise '' (no usable URL).
 * This is the browser-facing value only: the server-side KiloClaw clients keep reading
 * `KILOCLAW_API_URL`.
 */
export function resolveLegacyWorkerUrl(
  apiUrl: string | undefined,
  env: DeploymentEnvironment
): string {
  if (isConfirmedVercelProduction(env)) return apiUrl || 'https://claw.kilo.ai';
  return apiUrl && isNonProductionKiloClawUrl(apiUrl) ? apiUrl : '';
}

export const KILOCLAW_LEGACY_WORKER_URL = resolveLegacyWorkerUrl(
  KILOCLAW_API_URL,
  deploymentEnvironment
);

// KiloClaw Early Bird Checkout
export const STRIPE_KILOCLAW_EARLYBIRD_PRICE_ID = getEnvVariable(
  'STRIPE_KILOCLAW_EARLYBIRD_PRICE_ID'
);
export const STRIPE_KILOCLAW_EARLYBIRD_COUPON_ID = getEnvVariable(
  'STRIPE_KILOCLAW_EARLYBIRD_COUPON_ID'
);
// Webhook Agent Ingest Worker (services/webhook-agent-ingest/wrangler.jsonc enables workers.dev)
export const WEBHOOK_AGENT_URL = resolveProductionDefaultedUrl(
  getEnvVariable('WEBHOOK_AGENT_URL'),
  'https://hooks.kilosessions.ai',
  deploymentEnvironment,
  'cloudflare-webhook-agent-ingest'
);

// Model eval ingest Worker
export const MODEL_EVAL_INGEST_URL = getEnvVariable('MODEL_EVAL_INGEST_URL') || '';

// Session ingest worker (public share proxy)
export const SESSION_INGEST_WORKER_URL = getEnvVariable('SESSION_INGEST_WORKER_URL') || '';
export const SESSION_INGEST_SENDER_AUTH = getEnvVariable('SESSION_INGEST_SENDER_AUTH');

// Push-notifications worker (internal dispatch)
export const NOTIFICATIONS_WORKER_URL = getEnvVariable('NOTIFICATIONS_WORKER_URL') || '';

// Auto routing worker
export const AUTO_ROUTING_WORKER_URL = getEnvVariable('AUTO_ROUTING_WORKER_URL') || '';
export const AUTO_ROUTING_DECISION_SECRET = getEnvVariable('AUTO_ROUTING_DECISION_SECRET') || '';

// Auto routing benchmark worker
export const AUTO_ROUTING_BENCHMARK_WORKER_URL = resolveProductionDefaultedUrl(
  getEnvVariable('AUTO_ROUTING_BENCHMARK_WORKER_URL'),
  'https://auto-routing-benchmark.kiloapps.io',
  deploymentEnvironment
);
// The credential switches of the auto-routing and benchmark Worker senders
// (ai-gateway/auto-routing-sender.ts), one per sender app and edge: absent, empty or `legacy`
// sends the internal secret; `sts` an STS service token. `kilocode-ai-gateway` reads only
// AUTO_ROUTING_DECIDE_SENDER_AUTH and GATEWAY_ROUTING_TABLES_SENDER_AUTH
// (ai-gateway/auto-routing-gateway-sender.ts); `kilocode-app` only the other three
// (apps/web/src/lib/auto-routing-sender.ts).
export const AUTO_ROUTING_DECIDE_SENDER_AUTH = getEnvVariable('AUTO_ROUTING_DECIDE_SENDER_AUTH');
export const GATEWAY_ROUTING_TABLES_SENDER_AUTH = getEnvVariable(
  'GATEWAY_ROUTING_TABLES_SENDER_AUTH'
);
export const AUTO_ROUTING_ADMIN_SENDER_AUTH = getEnvVariable('AUTO_ROUTING_ADMIN_SENDER_AUTH');
export const AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH = getEnvVariable(
  'AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH'
);
export const WEB_ROUTING_TABLES_SENDER_AUTH = getEnvVariable('WEB_ROUTING_TABLES_SENDER_AUTH');

// Security Agent sync Worker command ingress
export const SECURITY_SYNC_WORKER_URL = getEnvVariable('SECURITY_SYNC_WORKER_URL') || '';
// Security Agent auto-analysis Worker command ingress
export const SECURITY_AUTO_ANALYSIS_WORKER_URL =
  getEnvVariable('SECURITY_AUTO_ANALYSIS_WORKER_URL') || '';

// Google Web Risk API
export const GOOGLE_WEB_RISK_API_KEY = getEnvVariable('GOOGLE_WEB_RISK_API_KEY');

export const CREDIT_CATEGORIES_ENCRYPTION_KEY = getEnvVariable('CREDIT_CATEGORIES_ENCRYPTION_KEY');
export const CREDIT_CATEGORIES_ENCRYPTION_KEY_V2 = getEnvVariable(
  'CREDIT_CATEGORIES_ENCRYPTION_KEY_V2'
);

// Agent observability ingest service
export const O11Y_SERVICE_URL = getEnvVariable('O11Y_SERVICE_URL') || '';
export const O11Y_KILO_GATEWAY_CLIENT_SECRET = getEnvVariable('O11Y_KILO_GATEWAY_CLIENT_SECRET');
export const O11Y_API_METRICS_SENDER_AUTH = getEnvVariable('O11Y_API_METRICS_SENDER_AUTH');
export const O11Y_ALERTING_SENDER_AUTH = getEnvVariable('O11Y_ALERTING_SENDER_AUTH');
// The credential the AI Gateway's US-region senders present to the web app's own /api/internal/*
// routes (web-internal-sts.ts): absent, empty or `legacy` sends the internal secret; `sts` an STS
// service token.
export const WEB_INTERNAL_SENDER_AUTH = getEnvVariable('WEB_INTERNAL_SENDER_AUTH');

// Pylon chat widget (support chat on Code Reviewer pages).
// PYLON_IDENTITY_SECRET is the shared secret from the Pylon dashboard used to HMAC-sign
// the user's email so the widget can verify the end user's identity.
export const PYLON_IDENTITY_SECRET = getEnvVariable('PYLON_IDENTITY_SECRET') || '';

/**
 * Binary session-bound MFA step-up switch.
 *
 * `'true'` enforces step-up on the admin surfaces; anything else, including
 * unset, leaves the application exactly as it was before step-up. This is an
 * environment variable rather than a release toggle so security posture does
 * not depend on PostHog.
 */
export function isAdminStepUpEnabled(): boolean {
  // Exact match: no trimming or casing variants, so a typo stays off.
  return getEnvVariable('ADMIN_STEP_UP_ENABLED') === 'true';
}
