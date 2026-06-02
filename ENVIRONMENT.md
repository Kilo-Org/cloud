# Environment Variables

This document lists all environment variables used in the Kilo Code cloud monorepo.

## Core / System

- `NODE_ENV` - Node environment (`development`, `production`, `test`); used by virtually every package. [SERVER]
- `CI` - Set to `true` in CI environments; detected by Next.js, Playwright, Vitest, and various tooling to alter behavior (non-interactive, skip prompts, etc.). [SERVER]
- `PORT` - Port for local dev servers. Next.js defaults to 3000; used by `apps/web/src/lib/constants.ts` and various test servers. [SERVER]
- `HOME` - User home directory; used by child processes spawned by services (OpenClaw resolves `~/.openclaw`, Expo devcert for mkcert certs). [SYSTEM]
- `PATH` - System executable search path; modified by tooling (OpenClaw, tsx, etc.) to locate CLIs. [SYSTEM]
- `TMUX` - Set when running inside a tmux session; used by `dev/local/tmux.ts` to detect tmux environment. [SYSTEM]
- `GITHUB_ACTIONS` - Set to `true` by GitHub Actions CI; detected by tooling (Rye log groups, Playwright, Vitest) to enable GitHub Actions-specific output/reporting. [SERVER]
- `NEXT_RUNTIME` - Set by Next.js to `'node'`, `'edge'`, or `'browser'`; used in `apps/web/src/instrumentation.ts` to select appropriate Sentry instrumentation. [SERVER]
- `DOTENV_CONFIG_QUIET` - Set by dotenv to suppress load output; set to `'true'` in `dev/seed/lib/preflight.ts:9` during seeding. [SERVER]

## App (apps/web)

### Configuration & Constant URLs

- `APP_URL_OVERRIDE` - Override for the base application URL; used in `apps/web/src/lib/constants.ts` and `next.config.mjs`. [SERVER]
- `KILOCLAW_INSTANCE_URL_TEMPLATE` - URL template for KiloClaw instances; used in `apps/web/src/lib/config.server.ts`. [SERVER]
- `NEXTAUTH_URL` - Base URL for NextAuth.js; used across many auth-related files. [SERVER]
- `NEXTAUTH_SECRET` - Secret key for NextAuth.js session encryption; used across many auth-related files. `[SECRET]`
- `DEBUG_SHOW_DEV_UI` - Enables dev-only UI elements (debug panels, admin buttons); checked in `apps/web/src/lib/constants.ts` and `apps/web/src/app/(app)/profile/page.tsx`. [SERVER]
- `TRPC_TIMING_LOGGING` - Enables tRPC timing logs in development; checked in `apps/web/src/lib/trpc/init.ts`. [SERVER]
- `JEST_MAX_WORKERS` - Limits max worker threads for Jest; read in `apps/web/jest.config.ts`. [SERVER]
- `JEST_SILENT` - When `false`, shows verbose Jest output; read in `apps/web/jest.config.ts` and `apps/web/.env.test`. [SERVER]
- `JEST_WORKER_ID` - Set by Jest to identify the current worker thread; used by db connection pooling and libraries to handle worker-specific state. [SERVER]
- `IS_SCRIPT` - Set to `'true'` by `apps/web/src/scripts/index.ts` to indicate a script-mode run (bypasses web server logic). Used by Drizzle in `packages/db/src/database-url.ts`. [SERVER]

### Analytics & Monitoring

- `NEXT_PUBLIC_POSTHOG_KEY` - PostHog public API key for client-side analytics; used in `apps/web/src/components/PostHogProvider.tsx`. [PUBLIC]
- `NEXT_PUBLIC_POSTHOG_DEBUG` - Enables PostHog debug logging; checked in `apps/web/src/components/PostHogProvider.tsx` and `apps/web/src/lib/stytch.ts`. [PUBLIC]
- `SENTRY_ORG` - Sentry organization slug for source map uploads; used in `apps/web/next.config.mjs`. `[SECRET]`
- `SENTRY_PROJECT` - Sentry project slug for source map uploads; used in `apps/web/next.config.mjs`. `[SECRET]`
- `SENTRY_AUTH_TOKEN` - Sentry auth token for source map uploads; used in `apps/web/next.config.mjs`. `[SECRET]`
- `NEXT_PUBLIC_SENTRY_DSN` - Sentry DSN for client-side error reporting; used in `apps/web/instrumentation-client.ts`, `sentry.edge.config.ts`, `sentry.server.config.ts`. `[PUBLIC]`

### Marketing Tags

- `NEXT_PUBLIC_GTM_ID` - Google Tag Manager container ID; rendered in `apps/web/src/app/layout.tsx` and exposed via `apps/web/src/app/api/marketing-tags/gtm/route.ts`. [PUBLIC]
- `NEXT_PUBLIC_IMPACT_UTT_ID` - Impact.com UTT (Universal Tracking Token) ID; rendered in `apps/web/src/app/layout.tsx` and exposed via `apps/web/src/app/api/marketing-tags/impact/route.ts`. [PUBLIC]

### Vercel & Build Info

- `VERCEL_ENV` - Vercel environment (`development`, `preview`, `production`); used in `apps/web/next.config.mjs`, `apps/web/src/lib/constants.ts`, and `apps/web/.env.test`. [SERVER]
- `VERCEL_URL` - Auto-injected by Vercel; current deployment URL. Used in `apps/web/src/lib/buildInfo.ts`. [SERVER]
- `VERCEL_GIT_COMMIT_SHA` - Auto-injected by Vercel; Git commit SHA of the current deployment. Used in `apps/web/src/lib/buildInfo.ts`. [SERVER]
- `NEXT_PUBLIC_VERCEL_URL` - Client-exposed Vercel deployment URL from build info. [PUBLIC]
- `NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF` - Client-exposed Git branch/ref from build info. [PUBLIC]
- `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` - Client-exposed Git commit SHA from build info. [PUBLIC]
- `NEXT_PUBLIC_VERCEL_GIT_REPO_OWNER` - Client-exposed Git repo owner from build info. [PUBLIC]
- `NEXT_PUBLIC_VERCEL_GIT_REPO_SLUG` - Client-exposed Git repo slug from build info. [PUBLIC]
- `GITHUB_SHA` - GitHub Actions commit SHA; used in `apps/web/src/lib/buildInfo.ts` during CI builds. [SERVER]

### Security & Auth

- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` - Cloudflare Turnstile public site key; used in `apps/web/src/components/auth/sign-in/TurnstileView.tsx`. [PUBLIC]
- `TURNSTILE_SECRET_KEY` - Cloudflare Turnstile secret key; used in test files. `[SECRET]`
- `NEXT_PUBLIC_STYTCH_PROJECT_ENV` - Stytch public project environment identifier; used in `apps/web/src/components/auth/StytchClient.tsx`. [PUBLIC]
- `NEXT_PUBLIC_STYTCH_PUBLIC_TOKEN` - Stytch public token for client SDKs; used in `apps/web/src/components/auth/StytchClient.tsx`. [PUBLIC]
- `STYTCH_PROJECT_ID` - Stytch project ID for secret-side SDK calls. `[SECRET]`
- `STYTCH_PROJECT_SECRET` - Stytch project secret. `[SECRET]`
- `STYTCH_PUBLIC_TOKEN` - Stytch legacy public token alias used in some test fixtures. [PUBLIC]
- `INTERNAL_API_SECRET` - Shared secret for internal API calls between services; used in `apps/web/src/lib/kiloclaw/cli-runs.test.ts`, `kiloclaw-router.test.ts`, dev seed scripts, and other service routers. `[SECRET]`
- `CALLBACK_TOKEN_SECRET` - Secret for signing callback tokens. Required for local development. `[SECRET]`
- `INTERNAL_SECRET` - Alias/fallback for `INTERNAL_API_SECRET`; used in KiloClaw E2E scripts (`services/kiloclaw/e2e/`). `[SECRET]`

### Social OAuth Clients

- `GITHUB_CLIENT_ID` - GitHub OAuth app client ID. `[PUBLIC]`
- `GITHUB_CLIENT_SECRET` - GitHub OAuth app client secret. `[SECRET]`
- `GITHUB_APP_ID` - GitHub App ID; used in integration adapter and tests. `[SECRET]`
- `GITHUB_APP_PRIVATE_KEY` - GitHub App private key (PEM); used in integration adapter and tests. `[SECRET]`
- `GITHUB_APP_CLIENT_ID` - GitHub OAuth Client ID for the app install/login flow; used in `apps/web/src/lib/integrations/platforms/github/app-selector.ts`. [PUBLIC]
- `GITHUB_LITE_APP_ID` - Lighter/secondary GitHub App ID for select integrations. `[SECRET]`
- `GITHUB_LITE_APP_PRIVATE_KEY` - Private key for the lite GitHub App. `[SECRET]`
- `GITHUB_LITE_APP_CLIENT_ID` - OAuth Client ID for the lite GitHub App install/login flow. [PUBLIC]
- `GITHUB_ADMIN_STATS_TOKEN` - Token for admin GitHub API stats lookups; used in `apps/web/src/scripts/backfill-pr-author-github-ids.ts`. `[SECRET]`
- `GITHUB_CLI_PAT` - GitHub personal access token for `gh` CLI operations inside contractors; used in `services/gastown/container/src/process-manager.ts`. `[SECRET]`
- `GITHUB_TOKEN` - Generic GitHub token for API calls used as fallback when `GIT_TOKEN` or `GITHUB_CLI_PAT` is absent; used in `services/gastown/container/src/process-manager.ts`. `[SECRET]`
- `GH_TOKEN` - Short alias for GitHub token; used in `services/gastown/container/plugin/mayor-tools.ts`. `[SECRET]`
- `GIT_TOKEN` - Dynamic git credential token (often a GitHub App installation token) scoped for git clone/push; propagated from Town DO to containers in `services/gastown/src/dos/town/container-dispatch.ts` and `services/gastown/container/src/agent-runner.ts`. `[SECRET]`
- `GOOGLE_WORKSPACE_OAUTH_CLIENT_ID` - Google Workspace OAuth client ID; used in tests and integration code. [PUBLIC]
- `GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET` - Google Workspace OAuth client secret. `[SECRET]`
- `GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI` - Redirect URI for Google Workspace OAuth flow. [SERVER]
- `GOOGLE_CLIENT_ID` - Primary Google OAuth client ID. `[PUBLIC]`
- `GOOGLE_CLIENT_SECRET` - Primary Google OAuth client secret. `[SECRET]`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` - Google service account email. `[SECRET]`
- `GOOGLE_WEB_RISK_API_KEY` - API key for Google Web Risk API. `[SECRET]`
- `GOOGLE_SHEETS_SPREADSHEET_ID` - ID of the Google Sheet used for specific app integrations. [SERVER]
- `GITLAB_CLIENT_ID` - GitLab OAuth app client ID. `[PUBLIC]`
- `GITLAB_CLIENT_SECRET` - GitLab OAuth app client secret. `[SECRET]`
- `LINKEDIN_CLIENT_ID` - LinkedIn OAuth app client ID. `[PUBLIC]`
- `LINKEDIN_CLIENT_SECRET` - LinkedIn OAuth app client secret. `[SECRET]`
- `DISCORD_CLIENT_ID` - Discord OAuth app client ID. `[PUBLIC]`
- `DISCORD_CLIENT_SECRET` - Discord OAuth app client secret. `[SECRET]`
- `DISCORD_BOT_TOKEN` - Discord bot token. `[SECRET]`
- `DISCORD_PUBLIC_KEY` - Discord app public key (for interactions). [PUBLIC]
- `DISCORD_OAUTH_CLIENT_ID` - Discord OAuth client ID for the bot/app. [PUBLIC]
- `DISCORD_OAUTH_CLIENT_SECRET` - Discord OAuth client secret for the bot/app. `[SECRET]`
- `DISCORD_OAUTH_BOT_TOKEN` - Discord bot OAuth token (separate from standard bot token). `[SECRET]`
- `DISCORD_SERVER_ID` - ID of the primary Discord guild/server. [SERVER]
- `DOLTHUB_APP_CLIENT_ID` - DoltHub OAuth app client ID. `[PUBLIC]`
- `DOLTHUB_APP_CLIENT_SECRET` - DoltHub OAuth app client secret. `[SECRET]`
- `DOLTHUB_APP_DEV_CLIENT_ID` - Dev-only DoltHub OAuth client ID; used in `apps/web/.env.test`. `[PUBLIC]`
- `DOLTHUB_APP_DEV_CLIENT_SECRET` - Dev-only DoltHub OAuth client secret; used in `apps/web/.env.test`. `[SECRET]`
- `DOLTHUB_TOKEN` - DoltHub personal access token; used by the `wl-sdk` package for Dolt operations. `[SECRET]`

### Billing & Stripe

- `STRIPE_SECRET_KEY` - Stripe secret API key (`sk_*`). `[SECRET]`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` - Stripe publishable key for client-side 3DS and payment Element initialization. `[PUBLIC]`
- `STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID` - Stripe product ID for Teams subscription. [SERVER]
- `STRIPE_ENTERPRISE_SUBSCRIPTION_PRODUCT_ID` - Stripe product ID for Enterprise subscription. [SERVER]
- `STRIPE_TEAMS_MONTHLY_PRICE_ID` - Stripe price ID for Teams monthly plan (test). [SERVER]
- `STRIPE_TEAMS_ANNUAL_PRICE_ID` - Stripe price ID for Teams annual plan (test). [SERVER]
- `STRIPE_ENTERPRISE_MONTHLY_PRICE_ID` - Stripe price ID for Enterprise monthly plan (test). [SERVER]
- `STRIPE_ENTERPRISE_ANNUAL_PRICE_ID` - Stripe price ID for Enterprise annual plan (test). [SERVER]
- `STRIPE_TOP_UP_PRICE_ID` - Stripe price ID for credit top-up purchases. [SERVER]
- `STRIPE_KILO_PASS_TIER_19_MONTHLY_PRICE_ID` - Stripe price ID for Kilo Pass $19/mo tier. [SERVER]
- `STRIPE_KILO_PASS_TIER_19_YEARLY_PRICE_ID` - Stripe price ID for Kilo Pass $19/yr tier. [SERVER]
- `STRIPE_KILO_PASS_TIER_49_MONTHLY_PRICE_ID` - Stripe price ID for Kilo Pass $49/mo tier. [SERVER]
- `STRIPE_KILO_PASS_TIER_49_YEARLY_PRICE_ID` - Stripe price ID for Kilo Pass $49/yr tier. [SERVER]
- `STRIPE_KILO_PASS_TIER_199_MONTHLY_PRICE_ID` - Stripe price ID for Kilo Pass $199/mo tier. [SERVER]
- `STRIPE_KILO_PASS_TIER_199_YEARLY_PRICE_ID` - Stripe price ID for Kilo Pass $199/yr tier. [SERVER]
- `STRIPE_KILOCLAW_2026_03_19_STANDARD_INTRO_PRICE_ID` - Legacy KiloClaw Standard intro price ID (pre-rollout). [SERVER]
- `STRIPE_KILOCLAW_2026_03_19_STANDARD_PRICE_ID` - Legacy KiloClaw Standard recurring price ID (pre-rollout). [SERVER]
- `STRIPE_KILOCLAW_2026_03_19_COMMIT_PRICE_ID` - Legacy KiloClaw Commit price ID (pre-rollout). [SERVER]
- `STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID` - Current KiloClaw Standard recurring price ID. [SERVER]
- `STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID` - Current KiloClaw Commit price ID. [SERVER]
- `STRIPE_KILOCLAW_EARLYBIRD_PRICE_ID` - KiloClaw early-bird price ID (test-only). [SERVER]
- `STRIPE_KILOCLAW_EARLYBIRD_COUPON_ID` - Coupon ID for KiloClaw early-bird pricing. [SERVER]
- `CHURNKEY_API_SECRET` - Secret for Churnkey (cancellation flows). `[SECRET]`
- `NEXT_PUBLIC_CHURNKEY_APP_ID` - Public app ID for Churnkey widget. [PUBLIC]

### Apple / In-App Purchases

- `APPLE_APP_APPLE_ID` - Apple App ID for IAP verification. `[SECRET]`
- `APPLE_IAP_ENVIRONMENT` - Apple IAP environment (`Sandbox` or `Production`). [SERVER]
- `APPLE_IAP_KEY_ID` - Apple IAP key identifier. `[SECRET]`
- `APPLE_IAP_ISSUER_ID` - Apple IAP issuer (team) ID. `[SECRET]`
- `APPLE_IAP_PRIVATE_KEY` - Apple IAP private key (PEM/ES256) for receipt validation. `[SECRET]`
- `APPLE_ROOT_CERTIFICATES_PEM` - Apple root CA certs (PEM) for validating IAP receipts. [SERVER]

### Ablation / Experimentation

- `NEXT_PUBLIC_CLOUD_AGENT_NEXT_ENABLE_LOCAL_FAKE_MODEL` - Feature flag for local fake model routing in the Cloud Agent Next UI. [PUBLIC]
- `GLOBAL_KILO_BACKEND` - Override to select the global backend region/endpoint; used in `next.config.mjs`. [SERVER]
- `ANALYZE` - Next.js bundle analyzer switch; enables `@next/bundle-analyzer` in `next.config.mjs`. [SERVER]

### Database

- `POSTGRES_URL` - Primary Postgres connection string. `[SECRET]`
- `POSTGRES_SCRIPT_URL` - Alternate Postgres URL used by one-off scripts/backfills in `src/scripts/` and tests. `[SECRET]`
- `POSTGRES_URL_PRODUCTION` - Production Postgres connection string override; used by `packages/db/src/database-url.ts`. `[SECRET]`
- `POSTGRES_CONNECT_TIMEOUT` - Postgres connect timeout in ms (default/typical: 10000). [SERVER]
- `POSTGRES_MAX_QUERY_TIME` - Max allowed query time in ms. [SERVER]
- `USE_PRODUCTION_DB` - Forces use of the production DB URL in non-production contexts; used by `packages/db/src/database-url.ts`. [SERVER]
- `DATABASE_CA` - CA certificate content (PEM) for TLS connections to Postgres; used by `packages/db/src/database-url.ts` in tests and scripts. [SERVER]
- `DATABASE_URL` - Generic/alternate Postgres URL used by E2E tests and some services (`cloud-agent`, `kiloclaw`). `[SECRET]`

### Redis & Queue

- `REDIS_URL` - Redis connection URL; used by `apps/web/src/lib/redis.ts` and bot state. `[SECRET]`

### Encryption & Secrets

- `BYOK_ENCRYPTION_KEY` - Base64 encryption key for Bring-Your-Own-Key encryption of sensitive app data. `[SECRET]`
- `CREDIT_CATEGORIES_ENCRYPTION_KEY` - Encryption key for credit category labels/values. `[SECRET]`
- `AGENT_ENV_VARS_PUBLIC_KEY` - RSA public key (base64) used to encrypt agent environment variables. [SERVER]
- `AGENT_ENV_VARS_PRIVATE_KEY` - Legacy alias for the above — the actual private key used to decrypt agent env vars (kept server-side). `[SECRET]`

### Internal Services

- `WEBHOOK_AGENT_URL` - URL for the webhook agent worker. [SERVER]
- `MODEL_EVAL_INGEST_URL` - URL for model evaluation ingest worker. [SERVER]
- `SESSION_INGEST_WORKER_URL` - URL for the session ingest worker. [SERVER]
- `NEXT_PUBLIC_SESSION_INGEST_WS_URL` - WebSocket URL for session ingest from the browser. [PUBLIC]
- `CODE_REVIEW_WORKER_URL` - URL for the code review worker. [SERVER]
- `CODE_REVIEW_WORKER_AUTH_TOKEN` - Auth token for the code review worker. `[SECRET]`
- `AUTO_TRIAGE_URL` - URL for the auto-triage worker. [SERVER]
- `AUTO_TRIAGE_AUTH_TOKEN` - Auth token for the auto-triage worker. `[SECRET]`
- `AUTO_FIX_URL` - URL for the auto-fix worker. [SERVER]
- `AUTO_FIX_AUTH_TOKEN` - Auth token for the auto-fix worker. `[SECRET]`
- `APP_BUILDER_URL` - URL for the App Builder worker. [SERVER]
- `APP_BUILDER_AUTH_TOKEN` - Auth token for the App Builder worker. `[SECRET]`
- `KILOCLAW_API_URL` - Base URL for KiloClaw API; used heavily by `apps/web/src/routers/kiloclaw-router.ts` and tests. [SERVER]
- `USER_DEPLOYMENTS_API_BASE_URL` - Base URL for user deployments dispatcher. [SERVER]
- `USER_DEPLOYMENTS_API_AUTH_KEY` - Auth key for user deployments API. `[SECRET]`
- `USER_DEPLOYMENTS_DISPATCHER_URL` - URL for the deployments dispatcher (local dev). [SERVER]
- `USER_DEPLOYMENTS_ENV_VARS_PUBLIC_KEY` - Public key for encrypting user deployment env vars. [SERVER]
- `USER_DEPLOYMENTS_ENV_VARS_PRIVATE_KEY` - Private key counterpart for decrypting user deployment env vars. `[SECRET]`
- `CLOUD_AGENT_API_URL` - URL for Cloud Agent Next API; used by App Builder chat and other clients. [SERVER]
- `CLOUD_AGENT_NEXT_API_URL` - Alias for `CLOUD_AGENT_API_URL` in local dev overrides. [SERVER]
- `NEXT_PUBLIC_CLOUD_AGENT_WS_URL` - WebSocket URL for Cloud Agent (legacy) from browser. [PUBLIC]
- `NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL` - WebSocket URL for Cloud Agent Next from browser. [PUBLIC]
- `CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME` - R2 bucket for cloud agent file attachments. [SERVER]
- `GASTOWN_SERVICE_URL` - URL for the Gastown service. [SERVER]
- `NEXT_PUBLIC_GASTOWN_URL` - Client-side base URL for Gastown. [PUBLIC]
- `O11Y_SERVICE_URL` - URL for the observability (O11Y) service. [SERVER]
- `O11Y_KILO_GATEWAY_CLIENT_SECRET` - Client secret for the O11Y Kilo Gateway. `[SECRET]`
- `ABUSE_SERVICE_URL` - URL for the abuse detection service. [SERVER]
- `ABUSE_SERVICE_CF_ACCESS_CLIENT_ID` - Cloudflare Access client ID for abuse service. [PUBLIC]
- `ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET` - Cloudflare Access client secret for abuse service. `[SECRET]`
- `CRON_SECRET` - Shared secret for authenticated cron endpoints; used in `dev/discord-gateway-cron.ts` and `.env.test`. `[SECRET]`
- `WORKOS_API_KEY` - WorkOS API key for enterprise SSO. `[SECRET]`
- `WORKOS_CLIENT_ID` - WorkOS client ID for enterprise SSO. [PUBLIC]

### AI Providers

- `OPENROUTER_API_KEY` - Primary OpenRouter API key for model inference through the AI gateway; provider definition in `apps/web/src/lib/ai-gateway/providers/provider-definitions.ts` pointing to `https://openrouter.ai/api/v1`. `[SECRET]`
- `OPENAI_API_KEY` - OpenAI API key; used in `apps/web/src/lib/ai-gateway/embeddings/embedding-providers.ts` for the `text-embedding-3-small` embedding model, and as a provider config in `apps/web/src/lib/config.server.ts`. `[SECRET]`
- `MISTRAL_API_KEY` - Mistral API key; used in `apps/web/src/lib/ai-gateway/embeddings/embedding-providers.ts` for `codestral-embed-2505` and `mistral-embed` embeddings, in the FIM completions proxy at `apps/web/src/app/api/fim/completions/route.ts` (routes Mistral Codestral vs. La Plateforme keys), and as a provider config in `apps/web/src/lib/config.server.ts`. `[SECRET]`
- `XAI_API_KEY` - xAI / Grok API key; referenced in `.env.local.example` as "your-xai-grok-key" and in Grok model naming (`x-ai/grok-*`). No direct `process.env.XAI_API_KEY` call was found outside `.env` files, so actual runtime wiring is likely via `OPENROUTER_API_KEY` routing through OpenRouter to Grok models. `[SECRET]`
- `INCEPTION_API_KEY` - Inception Labs API key; used in `apps/web/src/app/api/fim/completions/route.ts` and `apps/web/src/app/api/edit/completions/route.ts` as a fill-in-the-middle (FIM) provider, with endpoint `https://api.inceptionlabs.ai/v1/fim/completions`. Defined in `apps/web/src/lib/config.server.ts`. `[SECRET]`
- `AI_ATTRIBUTION_ADMIN_SECRET` - Admin secret for the AI Attribution service (`apps/web/src/lib/ai-attribution-service.ts`); sent as `X-Admin-Secret` header. `[SECRET]`
- `ARTIFICIAL_ANALYSIS_API_KEY` - API key for Artificial Analysis (`apps/web/src/lib/model-stats/sync-artificial-analysis.ts`); sent as `x-api-key` header for model benchmarking data sync. `[SECRET]`
- `GIGAPOTATO_API_KEY` - Only appears in `.env.local.example` and `apps/web/.env.test`; no production usage found. Presumed API key for the Gigapotato API provider. `[SECRET]`
- `GIGAPOTATO_API_URL` - Only appears in `.env.local.example` and `apps/web/.env.test`; no production usage found. Presumed base URL for the Gigapotato provider. [SERVER]
- `GENLABS_API_KEY` - Only appears in `.env.local.example` and `apps/web/.env.test`; no production usage found. Presumed API key for the GenLabs provider. `[SECRET]`
- `FAKE_LLM_URL` - URL for a fake/local LLM server used in `services/cloud-agent-next` E2E tests (`test/e2e/client.ts`, `test/e2e/fake-llm-server.ts`, `test/e2e/README.md`); defaults to `http://localhost:8811`. [SERVER]

### Vector DBs

- `QDRANT_HOST` - Qdrant vector DB host. [SERVER]
- `QDRANT_API_KEY` - Qdrant API key. `[SECRET]`
- `MILVUS_ADDRESS` - Milvus vector DB address. [SERVER]
- `MILVUS_TOKEN` - Milvus auth token. `[SECRET]`

### Email & Notifications

- `MAILGUN_API_KEY` - Mailgun API key for transactional email. `[SECRET]`
- `MAILGUN_DOMAIN` - Mailgun sending domain. [SERVER]
- `NEVERBOUNCE_API_KEY` - NeverBounce API key for email verification. `[SECRET]`

### Slack

- `SLACK_CLIENT_ID` - Slack OAuth app client ID. [PUBLIC]
- `SLACK_CLIENT_SECRET` - Slack OAuth app client secret. `[SECRET]`
- `SLACK_SIGNING_SECRET` - Slack request signing secret for webhooks. `[SECRET]`
- `SLACK_USER_FEEDBACK_WEBHOOK_URL` - Slack incoming webhook for user feedback. [SERVER]
- `SLACK_DEPLOY_THREAT_WEBHOOK_URL` - Slack incoming webhook for deploy threat alerts. [SERVER]

### Feature Flags

- `KILOCLAW_BILLING_ENFORCEMENT` - Feature flag controlling KiloClaw billing enforcement. [SERVER]
- `BRIEFING_DEBUG` - Enables verbose debug logging for the KiloClaw morning briefing plugin; checked in `services/kiloclaw/plugins/kiloclaw-morning-briefing/src/index.ts`. [SERVER]
- `KILOCLAW_DISABLE_AI_COAUTHOR` - Disables AI co-author features in Gastown; checked in `services/gastown/container/src/control-server.ts`. [SERVER]
- `KILOCLAW_GOOGLE_LEGACY_MIGRATION_FAILED` - Set when the legacy Google migration flow fails in the KiloClaw controller. [SERVER]
- `KILOCLAW_GOOGLE_LEGACY_MIGRATION_REASON` - Human-readable reason for legacy Google migration failure in the KiloClaw controller. [SERVER]
- `IMPACT_ADVOCATE_DEBUG_LOGGING` - Enables verbose Impact Advocate debug logs. [SERVER]
- `IMPACT_REFERRAL_DEBUG` - Enables verbose Impact referral debug logs. [SERVER]

### Impact.com Affiliate/Advocate

- `IMPACT_ACCOUNT_SID` - Impact.com account SID for API auth. `[SECRET]`
- `IMPACT_AUTH_TOKEN` - Impact.com API auth token for affiliate/click events. `[SECRET]`
- `IMPACT_ADVOCATE_ACCOUNT_SID` - Impact.com account SID for Advocate (referral) API. `[SECRET]`
- `IMPACT_ADVOCATE_AUTH_TOKEN` - Impact.com Advocate API auth token. `[SECRET]`
- `IMPACT_ADVOCATE_PROGRAM_ID` - Impact.com Advocate program ID. [SERVER]
- `IMPACT_ADVOCATE_TENANT_ALIAS` - Impact.com Advocate tenant alias. [SERVER]
- `IMPACT_ADVOCATE_WIDGET_ID` - Impact.com Advocate widget ID. [SERVER]
- `IMPACT_CAMPAIGN_ID` - Impact.com campaign ID for event tracking. [SERVER]

### R2 / Object Storage

- `R2_ACCOUNT_ID` - Cloudflare R2 account ID for CLI session storage. [SERVER]
- `R2_ACCESS_KEY_ID` - R2 access key ID for CLI session storage. `[SECRET]`
- `R2_SECRET_ACCESS_KEY` - R2 secret access key for CLI session storage. `[SECRET]`
- `R2_CLI_SESSIONS_BUCKET_NAME` - R2 bucket name for CLI session blobs. [SERVER]

## Services

### KiloClaw Controller

- `KILOCODE_API_KEY` - API key used by the KiloClaw controller for internal gateway identity. `[SECRET]`
- `FLY_MACHINE_ID` - Fly.io machine ID; auto-injected by the Fly runtime, used in `services/kiloclaw/controller/src/checkin.ts` for machine identity. [SERVER]
- `KILOCLAW_MACHINE_CPU_KIND` - CPU architecture label used in KiloClaw gateway health checks/tests. [SERVER]
- `KILOCLAW_RUNTIME_PROVIDER` - Runtime provider identifier used in KiloClaw gateway tests (e.g. `fly`). [SERVER]
- `OPENCLAW_OAUTH_DIR` - Directory path for OpenClaw OAuth credentials; managed by OpenClaw runtime. [SERVER]
- `OPENCLAW_STATE_DIR` - Directory path for OpenClaw persistent state; managed by OpenClaw runtime. [SERVER]
- `GOG_KEYRING_PASSWORD` - Password for the legacy Google keyring migration in KiloClaw controller. `[SECRET]`
- `KILOCLAW_PROVISION_LOCK_POOL_MAX` - Max concurrency for KiloClaw provision locks; used in `apps/web/src/lib/kiloclaw/provision-lock.ts`. [SERVER]
- `OPENCLAW_GATEWAY_TOKEN` - Token for authenticating with the OpenClaw gateway. Used by `kiloclaw` plugins (kilo-chat, morning-briefing) and OpenClaw internals. `[SECRET]`
- `KILOCLAW_KILO_CLI` - Set by the KiloClaw controller route when the Kilo CLI is invoking a run; gates CLI-specific code paths in `services/kiloclaw/controller/src/routes/kilo-cli-run.ts`. [SERVER]
- `KILO_API_KEY` - API key for the Kilo API; used by CLI run route and customizer plugin tests. `[SECRET]`

### KiloClaw Plugins

- `KILOCLAW_CONTROLLER_URL` - Base URL for the KiloClaw controller service; used across plugins (kilo-chat, morning-briefing) and tests. [SERVER]
- `KILOCLAW_SANDBOX_ID` - Sandbox identifier for isolated KiloClaw execution environments; used by morning-briefing plugin. [SERVER]
- `KILOCLAW_USER_LOCATION` - User location string used by the morning briefing plugin for timezone-aware scheduling. [SERVER]
- `KILOCLAW_USER_TIMEZONE` - User timezone string used by the morning briefing plugin. [SERVER]
- `LINEAR_API_KEY` - Linear API key for issue integration in the morning briefing plugin. `[SECRET]`
- `KILOCHAT_BASE_URL` - Base URL for the KiloChat service. [SERVER]
- `KILO_API_URL` - Kilo API base URL used by the customizer Exa web search plugin. [SERVER]
- `KILOCODE_API_BASE_URL` - KiloCode API base URL for the customizer plugin. [SERVER]
- `KILOCODE_ORGANIZATION_ID` - Organization ID for KiloCode API calls. [SERVER]
- `OPENCODE_CONFIG_CONTENT` - JSON/Toml/YAML string containing OpenCode configuration injected into agent environments at runtime (used as an alternative to `KILO_CONFIG_CONTENT`). [SERVER]
- `KILO_CONFIG_CONTENT` - JSON/Toml/YAML string containing Kilo configuration injected into agent environments at runtime (session config, skills, etc.); read by `@kilocode/sdk` and Gastown process manager. [SERVER]

### Cloud Agent Services

- `KILOCODE_TOKEN` - Auth token for KiloCode/Session service identity; used by `cloud-agent-next` wrapper and Gastown containers. `[SECRET]`
- `KILOCODE_TOKEN_FILE` - Path to a file containing the KiloCode token (alternative to the env var). [SERVER]
- `KILO_SESSION_ID` - Legacy/session-wrapper session identifier. [SERVER]
- `KILO_SESSION_INGEST_URL` - URL for ingesting session data from the cloud agent wrapper. [SERVER]
- `INGEST_URL` - URL for telemetry/event ingest from `cloud-agent/wrapper`. [SERVER]
- `KILO_PLATFORM` - Target platform identifier for the cloud-agent wrapper (`darwin`, `linux`, etc.). [SERVER]
- `CLI_LOG_PATH` - File path for the cloud-agent wrapper's local CLI log output. [SERVER]
- `WRAPPER_LOG_PATH` - File path for the cloud-agent-next wrapper's log output. [SERVER]
- `KILO_BIN_PATH` - Path or name of the `kilo` CLI binary; used by `services/cloud-agent-next/scripts/update-default-slash-commands.mjs`. [SERVER]
- `UPSTREAM_BRANCH` - Default upstream branch name for the cloud-agent wrapper workspace. [SERVER]
- `WORKSPACE_PATH` - Filesystem path of the agent workspace. [SERVER]
- `SESSION_ID` - Reserved session identifier for the `cloud-agent-next` runtime; reserved in `RESERVED_ENV_VARS`. [SERVER]
- `HOME` - Reserved in `RESERVED_ENV_VARS` for cloud-agent-next session home management. [SYSTEM]

### Gastown

- `GASTOWN_TOWN_ID` - Unique identifier for a Gastown town (isolated environment/agent pool). [SERVER]
- `GASTOWN_RIG_ID` - Rig (hardware profile) identifier for Gastown scheduling. [SERVER]
- `GASTOWN_AGENT_ID` - Unique identifier for an individual Gastown agent instance. [SERVER]
- `GASTOWN_AGENT_ROLE` - Role assigned to a Gastown agent (e.g. `coder`, `reviewer`). [SERVER]
- `GASTOWN_API_URL` - Base URL for the Gastown control API. [SERVER]
- `GASTOWN_CONTAINER_TOKEN` - Auth token for Gastown container authentication; refreshed via `token-refresh.ts`. `[SECRET]`
- `GASTOWN_SESSION_TOKEN` - Per-session auth token for Gastown. `[SECRET]`
- `GASTOWN_ORGANIZATION_ID` - Organization ID associated with the Gastown town. [SERVER]
- `GASTOWN_GIT_AUTHOR_NAME` - Git author name used by agents in Gastown for commits. [SERVER]
- `GASTOWN_GIT_AUTHOR_EMAIL` - Git author email used by agents in Gastown for commits. [SERVER]
- `AGENT_IDLE_TIMEOUT_MS` - Timeout in ms before an idle Gastown agent is terminated; used in `services/gastown/container/src/process-manager.ts`. [SERVER]
- `REFINERY_IDLE_TIMEOUT_MS` - Timeout in ms before an idle Refinery sub-process is killed; used in `services/gastown/container/src/process-manager.ts`. [SERVER]

### Deploy Infra (Dispatcher)

- `LOCAL_AUTH_TOKEN` - Auth token for the local deployment dispatcher env. `[SECRET]`
- `STAGING_AUTH_TOKEN` - Auth token for the staging deployment dispatcher env. `[SECRET]`
- `PROD_AUTH_TOKEN` - Auth token for the production deployment dispatcher env. `[SECRET]`

### Other Services

- `DOCKER_SOCKET` - Path or URL for the Docker daemon socket; used by `services/cloud-agent-next/scripts/docker-privileged-proxy.mjs`. [SERVER]
- `DOCKER_PROXY_SOCKET` - Path to the Docker privileged proxy socket. [SERVER]
- `SECRET` - Generic secret env var used in `services/kiloclaw/src/auth/sandbox-id-adversarial.test.ts` for sandbox auth tests. `[SECRET]`

## Mobile

- `API_BASE_URL` - Base HTTPS URL for the mobile app's API (e.g. `https://api.kilo.ai`). Bundled into the binary. [PUBLIC]
- `WEB_BASE_URL` - Base HTTPS URL for the mobile in-app web views (e.g. `https://app.kilo.ai`). Bundled into the binary. [PUBLIC]
- `CLOUD_AGENT_WS_URL` - WebSocket URL for cloud-agent streaming in the mobile app. Bundled into the binary. [PUBLIC]
- `SESSION_INGEST_WS_URL` - WebSocket URL for session ingest from the mobile app. Bundled into the binary. [PUBLIC]
- `APPSFLYER_DEV_KEY` - AppsFlyer development key for mobile attribution. Bundled into the binary (not secret — it's a device-level SDK key). [PUBLIC]
- `APPSFLYER_APP_ID` - AppsFlyer app ID for mobile attribution tracking. [PUBLIC]
- `KILO_CHAT_URL` - Base URL for Kilo Chat in the mobile app. Bundled into the binary. [PUBLIC]
- `EVENT_SERVICE_URL` - WebSocket URL for the event service from mobile. Bundled into the binary. [PUBLIC]
- `NOTIFICATIONS_URL` - HTTP URL for the push-notifications backend from mobile. [PUBLIC]
- `MOBILE_DEV_HOST` - LAN host override for mobile dev (replaces `localhost` on physical devices); read in `dev/local/mobile-env.ts`. [SERVER]

## Tests / Dev

- `IS_IN_AUTOMATED_TEST` - Set to `1` to put the app in automated-test mode (e.g. skip Turnstile challenges). [SERVER]
- `AUTH_TOKEN` - Generic auth token used in `services/app-builder/src/_integration_tests/git-test-helpers.ts` to authenticate integration tests against local services. `[SECRET]`
- `CANDIDATE_TAG` - Tag string used by `scripts/test-rollout-bucket.mjs` to test rollout bucket assignment. [SERVER]
- `PERCENT` - Percentage value (0-100) used by `scripts/test-rollout-bucket.mjs` when testing rollout bucket logic. [SERVER]
- `SNOWFLAKE_MAX_POLL_ATTEMPTS` - Max poll attempts for Snowflake job completion in `services/kiloclaw-billing/src/snowflake.ts`. [SERVER]
- `CF_AE_TOKEN` - Cloudflare Account/Enterprise API token for the local dev CLI (`dev/local/cli.ts`). `[SECRET]`
- `KILO_PORT_OFFSET` - Port offset for the local dev tmux dashboard; applied by `dev/local/cli.ts` and `dev/local/services.ts` to prevent port conflicts. [SERVER]

## E2E

- `DATABASE_URL` - Postgres URL for E2E test runs across `cloud-agent-next` and `kiloclaw` E2E suites. `[SECRET]`
- `WORKER_URL` - Base URL of the worker under test (Kiloclaw E2E). [SERVER]
- `E2E_GIT_URL` - Git server URL for E2E tests (clones repos during runs). [SERVER]
- `E2E_MODEL` - Model identifier string for E2E inference tests (e.g. a fake/small model name). [SERVER]
- `KILOCLAW_USER_LOCATION` - User location parameter for lifecycle tests of the morning briefing plugin. [SERVER]
- `KILOCLAW_USER_TIMEZONE` - User timezone parameter for lifecycle tests of the morning briefing plugin. [SERVER]
