import { APP_URL } from '@/lib/constants';
import { getEnvVariable } from '@/lib/dotenvx';
import 'server-only';
// centralized place to normalize and export environment variables
// this file only works on the sever and is meant to be an easier
// way to see what environment variables are used vs searching the full
// codebase for process.env.*

export const IS_IN_AUTOMATED_TEST = !!getEnvVariable('IS_IN_AUTOMATED_TEST');
export const NEXTAUTH_URL = APP_URL;
export const CUSTOMERIO_EMAIL_API_KEY = getEnvVariable('CUSTOMERIO_EMAIL_API_KEY');
export const WORKOS_API_KEY = getEnvVariable('WORKOS_API_KEY');
export const WORKOS_CLIENT_ID = getEnvVariable('WORKOS_CLIENT_ID');
export const GOOGLE_CLIENT_ID = getEnvVariable('GOOGLE_CLIENT_ID');
export const GOOGLE_CLIENT_SECRET = getEnvVariable('GOOGLE_CLIENT_SECRET');
export const GITHUB_CLIENT_ID = getEnvVariable('GITHUB_CLIENT_ID');
export const GITHUB_CLIENT_SECRET = getEnvVariable('GITHUB_CLIENT_SECRET');
// Admin-only GitHub access (used for admin dashboards)
export const GITHUB_ADMIN_STATS_TOKEN = getEnvVariable('GITHUB_ADMIN_STATS_TOKEN');
export const GITLAB_CLIENT_ID = getEnvVariable('GITLAB_CLIENT_ID');
export const GITLAB_CLIENT_SECRET = getEnvVariable('GITLAB_CLIENT_SECRET');
export const LINKEDIN_CLIENT_ID = getEnvVariable('LINKEDIN_CLIENT_ID');
export const LINKEDIN_CLIENT_SECRET = getEnvVariable('LINKEDIN_CLIENT_SECRET');
export const TURNSTILE_SECRET_KEY = getEnvVariable('TURNSTILE_SECRET_KEY');
export const NEXTAUTH_SECRET = getEnvVariable('NEXTAUTH_SECRET');
export const OPENROUTER_API_KEY = getEnvVariable('OPENROUTER_API_KEY');
export const MISTRAL_API_KEY = getEnvVariable('MISTRAL_API_KEY');
export const OPENAI_API_KEY = getEnvVariable('OPENAI_API_KEY');
export const INTERNAL_API_SECRET = getEnvVariable('INTERNAL_API_SECRET');
export const CODE_REVIEW_WORKER_AUTH_TOKEN = getEnvVariable('CODE_REVIEW_WORKER_AUTH_TOKEN');
export const MANAGED_INDEXING_ENABLED = true;

if (!NEXTAUTH_SECRET) throw new Error('NEXTAUTH_SECRET is required JWT signing');
if (!TURNSTILE_SECRET_KEY) throw new Error('NEXTAUTH_SECRET is required JWT signing');

export const STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID = getEnvVariable(
  'STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID'
);

export const STRIPE_ENTERPRISE_SUBSCRIPTION_PRODUCT_ID = getEnvVariable(
  'STRIPE_ENTERPRISE_SUBSCRIPTION_PRODUCT_ID'
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
export const BYOK_ENCRYPTION_KEY = getEnvVariable('BYOK_ENCRYPTION_KEY') || '';

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
// Posts user feedback into a fixed Slack channel in the Kilo workspace.
// Expected to be a Slack Incoming Webhook URL.
export const SLACK_USER_FEEDBACK_WEBHOOK_URL = getEnvVariable('SLACK_USER_FEEDBACK_WEBHOOK_URL');
// Posts deploy threat alerts to a dedicated Slack channel.
// Expected to be a Slack Incoming Webhook URL.
export const SLACK_DEPLOY_THREAT_WEBHOOK_URL = getEnvVariable('SLACK_DEPLOY_THREAT_WEBHOOK_URL');
export const ENABLE_MILVUS_DUAL_WRITE = true;

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

// Webhook Agent Ingest Worker
export const WEBHOOK_AGENT_URL =
  getEnvVariable('WEBHOOK_AGENT_URL') || 'https://hooks.kilosessions.ai';

// Session ingest worker (public share proxy)
export const SESSION_INGEST_WORKER_URL = getEnvVariable('SESSION_INGEST_WORKER_URL') || '';

// Google Web Risk API
export const GOOGLE_WEB_RISK_API_KEY = getEnvVariable('GOOGLE_WEB_RISK_API_KEY');

export const CREDIT_CATEGORIES_ENCRYPTION_KEY = getEnvVariable('CREDIT_CATEGORIES_ENCRYPTION_KEY');

// Agent observability ingest service
export const O11Y_SERVICE_URL = getEnvVariable('O11Y_SERVICE_URL') || '';
export const O11Y_KILO_GATEWAY_CLIENT_SECRET = getEnvVariable('O11Y_KILO_GATEWAY_CLIENT_SECRET');

// Security agent BetterStack heartbeat URLs
export const SECURITY_SYNC_BETTERSTACK_HEARTBEAT_URL = getEnvVariable(
  'SECURITY_SYNC_BETTERSTACK_HEARTBEAT_URL'
);
export const SECURITY_CLEANUP_BETTERSTACK_HEARTBEAT_URL = getEnvVariable(
  'SECURITY_CLEANUP_BETTERSTACK_HEARTBEAT_URL'
);
