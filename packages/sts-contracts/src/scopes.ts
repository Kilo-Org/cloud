import { AudienceSchema, ScopeSchema, scopeAudience } from './token';

/**
 * STS service-token scopes by audience (design 5.3 scope model, 6.3 default deny). STS mints, and
 * a verifier accepts, an STS token only for a scope listed under its own audience here.
 */
export type StsScopeRegistry = Readonly<Record<string, { readonly scopes: readonly string[] }>>;

/**
 * The STS canary's denied probe: a scope no policy can ever grant. The web app's canary route asks
 * STS for it every run; STS identifies the function and refuses the token by policy, which it
 * records as an `ai.kilo.sts.token.denied` row (services/usage-ingest README, "STS canary").
 */
export const STS_DENIED_PROBE = { audience: 'canary', scope: 'canary:denied-probe' } as const;

/**
 * Registered scopes no policy may grant: the STS policy loader refuses a policy that lists one,
 * or lists its audience. Being registered, a request for one passes the registry check and is
 * refused as an audience no policy lists (`audience_not_allowed`), never as `unknown_scope`.
 */
export const STS_RESERVED_SCOPES: readonly string[] = [STS_DENIED_PROBE.scope];

/**
 * The AI Gateway forwards a provider request to the AI Gateway Secure Proxy. Only the `ai-gateway`
 * workload may send it; the Secure Proxy accepts it only from that service caller.
 */
export const STS_SECURE_PROXY_FORWARD = {
  audience: 'ai-gateway-secure-proxy',
  scope: 'ai-gateway-secure-proxy:request.forward',
} as const;

/** A publisher (the AI Gateway or the web app) sends usage to Usage Ingest's publisher routes. */
export const STS_USAGE_PUBLISH = {
  audience: 'usage-ingest',
  scope: 'usage-ingest:usage.publish',
} as const;

/** Usage Ingest's queue consumer records usage at the web app's private record routes. */
export const STS_USAGE_RECORD = { audience: 'web', scope: 'web:usage.record' } as const;

/** The AI Gateway and the web app write API metrics to O11y's ingestion endpoint. */
export const STS_O11Y_API_METRICS_WRITE = {
  audience: 'o11y',
  scope: 'o11y:api-metrics.write',
} as const;

/** The web app's admin alerts router reads O11y's alerting configuration and baselines. */
export const STS_O11Y_ALERTING_READ = { audience: 'o11y', scope: 'o11y:alerting.read' } as const;

/** The web app's admin alerts router changes O11y's alerting configuration and baselines. */
export const STS_O11Y_ALERTING_WRITE = { audience: 'o11y', scope: 'o11y:alerting.write' } as const;

/** The web app asks Security Sync to enqueue a manual sync. Only the `web` workload may send it. */
export const STS_SECURITY_SYNC_MANUAL_SYNC = {
  audience: 'security-sync',
  scope: 'security-sync:manual-sync.enqueue',
} as const;

/** The web app asks Security Sync to enqueue a finding dismissal. Only the `web` workload may send it. */
export const STS_SECURITY_SYNC_DISMISS_FINDING = {
  audience: 'security-sync',
  scope: 'security-sync:dismiss-finding.enqueue',
} as const;

/**
 * Security Sync asks the web app to dispatch security notifications. Only the Security Sync
 * Worker's workload (`cloudflare-security-sync`) may send it.
 */
export const STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH = {
  audience: 'web',
  scope: 'web:security-notifications.dispatch',
} as const;

/**
 * The web app and the AI gateway call Bouncer (repo Kilo-Org/bouncer) for verdicts: `decide`,
 * `charge-decide` and `release`. Bouncer's `ROUTE_SCOPES` (`src/api-auth.ts`) names the scope of
 * each route; the four Bouncer pairs here match it.
 */
export const STS_BOUNCER_DECIDE = { audience: 'bouncer', scope: 'bouncer:decide' } as const;

/** The web app and the AI gateway report usage and credit events to Bouncer. */
export const STS_BOUNCER_USAGE_WRITE = {
  audience: 'bouncer',
  scope: 'bouncer:usage.write',
} as const;

/** The web app asks Bouncer whether a signup may proceed. */
export const STS_BOUNCER_SIGNUP_DECIDE = {
  audience: 'bouncer',
  scope: 'bouncer:signup.decide',
} as const;

/** The signup-history import job writes signup history to Bouncer; no app holds this scope. */
export const STS_BOUNCER_SIGNUP_HISTORY = {
  audience: 'bouncer',
  scope: 'bouncer:signup.history',
} as const;

/**
 * Security Auto Analysis pushes a finding's lifecycle event to the web app's
 * `POST /api/internal/security-agent/notifications`. Only the `security-auto-analysis` workload
 * may send it.
 */
export const STS_WEB_SECURITY_NOTIFICATIONS_LIFECYCLE = {
  audience: 'web',
  scope: 'web:security-notifications.lifecycle',
} as const;

/**
 * The container usage meter asks the web app to send an organization's compute balance alert
 * (`/api/internal/organizations/compute-balance-alert`). Only the `container-usage-meter` workload
 * may send it.
 */
export const STS_WEB_COMPUTE_BALANCE_ALERT = {
  audience: 'web',
  scope: 'web:compute-balance-alert.send',
} as const;

/**
 * SCIM Sync applies directory changes over the web app's `/api/internal/scim/*` routes. Only the
 * `cloudflare-scim-sync` workload may send it.
 */
export const STS_WEB_SCIM_SYNC = { audience: 'web', scope: 'web:scim.sync' } as const;

/**
 * User Data Export tells the web app that an export is ready
 * (`/api/internal/user-data-exports/ready`). Only the `user-data-export` workload may send it.
 */
export const STS_WEB_USER_DATA_EXPORT_READY = {
  audience: 'web',
  scope: 'web:user-data-exports.ready',
} as const;

/** The auto-routing benchmark writes pool pins at the web app. Only `auto-routing-benchmark` may send it. */
export const STS_WEB_AUTO_ROUTING_POOL_PINS_WRITE = {
  audience: 'web',
  scope: 'web:auto-routing.pool-pins.write',
} as const;

/** The auto-routing benchmark reads usage receipts from the web app. Only `auto-routing-benchmark` may send it. */
export const STS_WEB_USAGE_RECEIPTS_READ = {
  audience: 'web',
  scope: 'web:usage.receipts.read',
} as const;

/**
 * The auto-routing benchmark reads the production routing profile from the web app. Only
 * `auto-routing-benchmark` may send it.
 */
export const STS_WEB_AUTO_ROUTING_PRODUCTION_PROFILE_READ = {
  audience: 'web',
  scope: 'web:auto-routing.production-profile.read',
} as const;

/**
 * The auto-routing benchmark's grader records its own LLM usage at the web app's
 * `/api/internal/usage/record`. Only `auto-routing-benchmark` may send it.
 */
export const STS_WEB_USAGE_RECORD_BENCHMARK_GRADER = {
  audience: 'web',
  scope: 'web:usage.benchmark-grader.record',
} as const;

/**
 * The auto-routing classifier records its own LLM usage at the web app's
 * `/api/internal/usage/record`. Only the `auto-routing` workload may send it.
 */
export const STS_WEB_USAGE_RECORD_CLASSIFIER = {
  audience: 'web',
  scope: 'web:usage.classifier.record',
} as const;

/**
 * The AI gateway in the US region hands a usage write (usage record and Enkrypt record) to the
 * Frankfurt web app. Only the `ai-gateway` workload may send it: the web app runs in Frankfurt
 * only, and STS refuses a workload its own audience.
 */
export const STS_WEB_USAGE_RECORD_REGION_HANDOFF = {
  audience: 'web',
  scope: 'web:usage.region-handoff.record',
} as const;

/**
 * The AI gateway in the US region reads a Claude payer state from the Frankfurt web app's primary
 * (`/api/internal/claude-billing/payer-state`). Only the `ai-gateway` workload may send it.
 */
export const STS_WEB_CLAUDE_BILLING_PAYER_STATE_READ = {
  audience: 'web',
  scope: 'web:claude-billing.payer-state.read',
} as const;

/**
 * The notifications Worker reads the glanceable agents snapshot from the web app
 * (`/api/internal/glanceable-agents-snapshot`). Only the `notifications` workload may send it.
 */
export const STS_WEB_GLANCEABLE_SNAPSHOT_READ = {
  audience: 'web',
  scope: 'web:glanceable-snapshot.read',
} as const;

/**
 * Cloud Agent reads a BYOC connection or Vercel credential enrollment at the web app's
 * `/api/internal/byoc/*` `GET` routes. Only the `cloud-agent-next` workload may send it.
 */
export const STS_WEB_BYOC_CREDENTIALS_READ = {
  audience: 'web',
  scope: 'web:byoc-credentials.read',
} as const;

/**
 * Cloud Agent projects a Vercel build status onto a BYOC credential
 * (`PATCH /api/internal/byoc/vercel-credentials/{credentialId}`). Only the `cloud-agent-next`
 * workload may send it.
 */
export const STS_WEB_BYOC_CREDENTIALS_WRITE = {
  audience: 'web',
  scope: 'web:byoc-credentials.write',
} as const;

/**
 * Cloud Agent refreshes a hosted workspace's pull request summary
 * (`POST /api/internal/cloud-agent-next/hosted-workspace-pull-request/refresh`). Only the
 * `cloud-agent-next` workload may send it.
 */
export const STS_WEB_HOSTED_WORKSPACE_PULL_REQUESTS_REFRESH = {
  audience: 'web',
  scope: 'web:hosted-workspace-pull-requests.refresh',
} as const;

/**
 * Cloud Agent calls back the web app when a bot session ends
 * (`/api/internal/bot-session-callback/{id}`). Only the `cloud-agent-next` workload may send it.
 */
export const STS_WEB_BOT_SESSION_CALLBACK = {
  audience: 'web',
  scope: 'web:bot-session.callback',
} as const;

/**
 * Cloud Agent calls back the web app with a security analysis result
 * (`/api/internal/security-analysis-callback/{id}`). Only the `cloud-agent-next` workload may
 * send it.
 */
export const STS_WEB_SECURITY_ANALYSIS_CALLBACK = {
  audience: 'web',
  scope: 'web:security-analysis.callback',
} as const;

/**
 * Cloud Agent reports a code review agent's status to the web app
 * (`/api/internal/code-review-status/{reviewId}`). Only the `cloud-agent-next` workload may send
 * it.
 */
export const STS_WEB_CODE_REVIEW_AGENT_CALLBACK = {
  audience: 'web',
  scope: 'web:code-review.agent-callback',
} as const;

/**
 * The Code Review Worker writes a review's status to the web app
 * (`POST /api/internal/code-review-status/{reviewId}`). Only the `kilo-code-review-worker`
 * workload may send it.
 */
export const STS_WEB_CODE_REVIEW_STATUS_CALLBACK = {
  audience: 'web',
  scope: 'web:code-review.status-callback',
} as const;

/**
 * Cloud Agent calls back Webhook Agent Ingest when an execution ends (`/api/callbacks/execution`).
 * Only the `cloud-agent-next` workload may send it.
 */
export const STS_WEBHOOK_AGENT_INGEST_EXECUTION_CALLBACK = {
  audience: 'webhook-agent-ingest',
  scope: 'webhook-agent-ingest:execution.callback',
} as const;

/**
 * Cloud Agent calls back Security Auto Analysis with an analysis result
 * (`/internal/security-analysis-callback/{id}`). Only the `cloud-agent-next` workload may send it.
 */
export const STS_SECURITY_AUTO_ANALYSIS_ANALYSIS_CALLBACK = {
  audience: 'security-auto-analysis',
  scope: 'security-auto-analysis:analysis.callback',
} as const;

/**
 * Cloud Agent calls back Security Auto Analysis with a remediation result
 * (`/internal/security-remediation-callback/{attemptId}`). Only the `cloud-agent-next` workload
 * may send it.
 */
export const STS_SECURITY_AUTO_ANALYSIS_REMEDIATION_CALLBACK = {
  audience: 'security-auto-analysis',
  scope: 'security-auto-analysis:remediation.callback',
} as const;

/** The web app dispatches a review to the Code Review Worker. Only the `web` workload may send it. */
export const STS_CODE_REVIEW_DISPATCH = {
  audience: 'code-review',
  scope: 'code-review:review.dispatch',
} as const;

/** The web app reads a review's status from the Code Review Worker. Only the `web` workload may send it. */
export const STS_CODE_REVIEW_STATUS_READ = {
  audience: 'code-review',
  scope: 'code-review:review.status-read',
} as const;

/** The web app cancels a review at the Code Review Worker. Only the `web` workload may send it. */
export const STS_CODE_REVIEW_CANCEL = {
  audience: 'code-review',
  scope: 'code-review:review.cancel',
} as const;

/** The web app retries a review from fresh at the Code Review Worker. Only the `web` workload may send it. */
export const STS_CODE_REVIEW_RETRY_FRESH = {
  audience: 'code-review',
  scope: 'code-review:review.retry-fresh',
} as const;

/**
 * The web app invalidates a user's session access at Session Ingest's service-only
 * `POST /internal/session-access/invalidate`. Only the `web` workload may send it. UTS's user
 * scopes under the same audience (`session-ingest:sessions.*`) are a separate registry and never
 * verify as STS tokens.
 */
export const STS_SESSION_INGEST_SESSION_ACCESS_INVALIDATE = {
  audience: 'session-ingest',
  scope: 'session-ingest:session-access.invalidate',
} as const;

/**
 * The web app calls Security Auto Analysis's web-called `/internal/*` routes, except the Cloud
 * Agent callbacks (`/internal/security-analysis-callback/*` and
 * `/internal/security-remediation-callback/*`), which accept only their own callback scopes. Only
 * the `web` workload may send it.
 */
export const STS_SECURITY_AUTO_ANALYSIS_INTERNAL_CALL = {
  audience: 'security-auto-analysis',
  scope: 'security-auto-analysis:internal.call',
} as const;

/**
 * The web app calls Model Eval Ingest's web-called `/internal/*` routes. Only the `web` workload
 * may send it.
 */
export const STS_MODEL_EVAL_INGEST_INTERNAL_CALL = {
  audience: 'model-eval-ingest',
  scope: 'model-eval-ingest:internal.call',
} as const;

/**
 * The web app calls Webhook Agent Ingest's web-called `/internal/*` routes. Only the `web`
 * workload may send it.
 */
export const STS_WEBHOOK_AGENT_INGEST_INTERNAL_CALL = {
  audience: 'webhook-agent-ingest',
  scope: 'webhook-agent-ingest:internal.call',
} as const;

/**
 * The web app calls Session Sync's web-called `/internal/*` routes. Only the `web` workload may
 * send it.
 */
export const STS_SESSION_SYNC_INTERNAL_CALL = {
  audience: 'session-sync',
  scope: 'session-sync:internal.call',
} as const;

/**
 * The web app calls the Notifications Worker's web-called `/internal/*` routes. Only the `web`
 * workload may send it.
 */
export const STS_NOTIFICATIONS_INTERNAL_CALL = {
  audience: 'notifications',
  scope: 'notifications:internal.call',
} as const;

/** The web app reads Auto Routing's admin routes. Only the `web` workload may send it. */
export const STS_AUTO_ROUTING_ADMIN_READ = {
  audience: 'auto-routing',
  scope: 'auto-routing:admin.read',
} as const;

/** The web app writes through Auto Routing's admin routes. Only the `web` workload may send it. */
export const STS_AUTO_ROUTING_ADMIN_WRITE = {
  audience: 'auto-routing',
  scope: 'auto-routing:admin.write',
} as const;

/** The AI Gateway asks Auto Routing for a routing decision. Only the `ai-gateway` workload may send it. */
export const STS_AUTO_ROUTING_DECIDE = {
  audience: 'auto-routing',
  scope: 'auto-routing:decide',
} as const;

/**
 * Reads the Auto Routing Benchmark's routing tables. Only the `web`, `ai-gateway` and
 * `auto-routing` workloads may send it: Auto Routing from
 * `services/auto-routing/src/benchmark-origin.ts`; the AI Gateway through web-shared's
 * `auto-routing-table-cache.ts` and `auto-routing-benchmark-admin-client.ts`
 * (`/admin/routing-table`); the web app from the admin `benchmark-routing-table` route,
 * `models-router` and `custom-router-benchmarks-router`. One shared scope fits because all three
 * read the same read-only data, and the token's subject names the caller.
 */
export const STS_AUTO_ROUTING_BENCHMARK_ROUTING_TABLES_READ = {
  audience: 'auto-routing-benchmark',
  scope: 'auto-routing-benchmark:routing-tables.read',
} as const;

/** The web app reads the Auto Routing Benchmark's admin routes. Only the `web` workload may send it. */
export const STS_AUTO_ROUTING_BENCHMARK_ADMIN_READ = {
  audience: 'auto-routing-benchmark',
  scope: 'auto-routing-benchmark:admin.read',
} as const;

/**
 * The web app writes through the Auto Routing Benchmark's admin routes. Only the `web` workload
 * may send it.
 */
export const STS_AUTO_ROUTING_BENCHMARK_ADMIN_WRITE = {
  audience: 'auto-routing-benchmark',
  scope: 'auto-routing-benchmark:admin.write',
} as const;

/**
 * Prepares a Cloud Agent session through the internal `prepareSession` tRPC procedure
 * (`services/cloud-agent-next/src/router/handlers/session-prepare.ts`). Only the `web` and
 * `kilo-code-review-worker` workloads may send it: the web app's `CloudAgentNextClient`
 * (`apps/web/src/lib/cloud-agent-next/cloud-agent-client.ts`) and the Code Review Worker's
 * `CodeReviewOrchestrator` (`services/code-review-infra/src/code-review-orchestrator.ts`).
 * Security Auto Analysis and Webhook Agent Ingest reach the procedure over a service binding,
 * outside STS.
 */
export const STS_CLOUD_AGENT_NEXT_SESSION_PREPARE = {
  audience: 'cloud-agent-next',
  scope: 'cloud-agent-next:session.prepare',
} as const;

/**
 * Points an existing Cloud Agent session at a new callback target through the internal
 * `updateSession` tRPC procedure
 * (`services/cloud-agent-next/src/router/handlers/session-prepare.ts`). Only the
 * `kilo-code-review-worker` workload may send it, from the `CodeReviewOrchestrator` follow-up
 * review (`services/code-review-infra/src/code-review-orchestrator.ts`). The web app's
 * `CloudAgentNextClient.updateSession` has no caller, so `web` is not a sender.
 */
export const STS_CLOUD_AGENT_NEXT_SESSION_UPDATE = {
  audience: 'cloud-agent-next',
  scope: 'cloud-agent-next:session.update',
} as const;

/**
 * Deletes a Cloud Agent session's runtime resources through the internal `cleanupSession` tRPC
 * procedure (`services/cloud-agent-next/src/router/handlers/session-management.ts`). Only the
 * `web` workload may send it, through `CloudAgentNextClient.cleanupSession` after a failed
 * initiate: from `apps/web/src/lib/bot/tools/spawn-cloud-agent-session.ts`,
 * `apps/web/src/lib/cloud-agent-next/run-session.ts` and
 * `apps/web/src/lib/security-agent/services/analysis-service.ts`.
 */
export const STS_CLOUD_AGENT_NEXT_SESSION_CLEANUP = {
  audience: 'cloud-agent-next',
  scope: 'cloud-agent-next:session.cleanup',
} as const;

/**
 * Skips Cloud Agent's balance check (`x-skip-balance-check`). The caller asserts that the session
 * does not bill the Kilo balance, an authority separate from the action's own. The scope is not
 * tied to a session or an owner: it names only the calling workload. STS policy decides which
 * workloads can mint it; today `web` and `kilo-code-review-worker`. Under STS (decisions M243 and
 * M246), the token grants no new authority: it only replaces the legacy internal key as the proof
 * where a bypass exists today.
 * - (1) In a request with an STS action token, which today means only `session.prepare` through
 *   the authority preflight, the bypass token's workload must equal the action token's workload.
 *   `updateSession` never reads `x-skip-balance-check`, so a bypass sent with `session.update`
 *   (as the code-review worker does today) has no effect.
 * - (2) In a request with no action token, authenticated by a user Bearer, the header is honoured
 *   only when `x-kilo-balance-bypass-authorization` holds a valid STS token: STS key-set
 *   signature, audience `cloud-agent-next`, this scope, not expired. The user-Bearer callers
 *   that rely on it are the `CodeReviewOrchestrator`'s `initiateFromKilocodeSessionV2` and
 *   `sendMessageV2` (`services/code-review-infra/src/code-review-orchestrator.ts`) and the web
 *   app's skipped-balance `CloudAgentNextClient`
 *   (`apps/web/src/lib/cloud-agent-next/cloud-agent-client.ts`).
 * - (3) With neither a valid action token nor a user Bearer, it is never honoured.
 * - (4) Each honoured bypass logs the workload and the user subject; each refusal logs a reason;
 *   neither logs token data.
 * - (5) The token is honoured only where a bypass exists today, both under
 *   `services/cloud-agent-next/src`: `middleware/balance.ts` and the authority preflight in
 *   `router/handlers/session-creation-preflight.ts`. The two public Kilo prompt mutations in
 *   `kilo-facade/user-kilo-facade.ts` always refuse `x-skip-balance-check` with a 400 (M246), for
 *   every caller, a valid bypass token included; they are not token-check points.
 * Webhook Agent Ingest sends the bypass over a service binding, outside STS.
 */
export const STS_CLOUD_AGENT_NEXT_BALANCE_BYPASS = {
  audience: 'cloud-agent-next',
  scope: 'cloud-agent-next:balance.bypass',
} as const;

/**
 * Reads whether code review compute billing is on for a user or organization
 * (`GET /internal/code-review/billing/{type}/{id}`). Only the `web` workload may send it, from
 * `apps/web/src/lib/code-reviews/compute-billing.ts`.
 */
export const STS_CLOUD_AGENT_NEXT_CODE_REVIEW_BILLING_READ = {
  audience: 'cloud-agent-next',
  scope: 'cloud-agent-next:code-review-billing.read',
} as const;

/**
 * Reads an owner's Cloud Agent container billing mode for one instance size. The route is
 * `GET /internal/containers/billing/{type}/{id}/{instance}` and accepts any billing owner type;
 * the only sender calls `GET /internal/containers/billing/user/{id}/{instance}`. Only the `web`
 * workload may send it, from `apps/web/src/lib/cloud-agent/compute-billing-mode.ts`.
 */
export const STS_CLOUD_AGENT_NEXT_CONTAINER_BILLING_READ = {
  audience: 'cloud-agent-next',
  scope: 'cloud-agent-next:container-billing.read',
} as const;

/**
 * Reads whether an organization or a user is enrolled in Vercel compute
 * (`GET /internal/byoc/vercel-enrollment/{organizationId}` and
 * `GET /internal/byoc/vercel-enrollment/user/{userId}`). Only the `web` workload may send it, from
 * `apps/web/src/lib/cloud-agent-next/cloud-agent-internal-api.ts`.
 */
export const STS_CLOUD_AGENT_NEXT_BYOC_ENROLLMENT_READ = {
  audience: 'cloud-agent-next',
  scope: 'cloud-agent-next:byoc-enrollment.read',
} as const;

/**
 * Reads the current Vercel runtime wrapper identity: version, release date and digest
 * (`GET /internal/byoc/vercel-runtime-identity`). Only the `web` workload may send it, from
 * `apps/web/src/lib/cloud-agent-next/cloud-agent-internal-api.ts`.
 */
export const STS_CLOUD_AGENT_NEXT_BYOC_RUNTIME_IDENTITY_READ = {
  audience: 'cloud-agent-next',
  scope: 'cloud-agent-next:byoc-runtime-identity.read',
} as const;

/**
 * Starts a BYOC Vercel snapshot build for an enrolled owner
 * (`POST /internal/byoc/vercel-snapshot-build/start`). Only the `web` workload may send it, from
 * `apps/web/src/lib/cloud-agent-next/cloud-agent-internal-api.ts`.
 */
export const STS_CLOUD_AGENT_NEXT_BYOC_SNAPSHOT_BUILD_START = {
  audience: 'cloud-agent-next',
  scope: 'cloud-agent-next:byoc-snapshot-build.start',
} as const;

/**
 * Cleans up a BYOC Vercel snapshot build's resources
 * (`POST /internal/byoc/vercel-snapshot-build/cleanup`). Only the `web` workload may send it, from
 * `apps/web/src/lib/cloud-agent-next/cloud-agent-internal-api.ts`.
 */
export const STS_CLOUD_AGENT_NEXT_BYOC_SNAPSHOT_BUILD_CLEANUP = {
  audience: 'cloud-agent-next',
  scope: 'cloud-agent-next:byoc-snapshot-build.cleanup',
} as const;

/**
 * Closes a removed organization member's live Cloud Agent streams
 * (`POST /internal/streams/close`). Only the `web` workload may send it, from organization member
 * removal through `apps/web/src/lib/cloud-agent-next/cloud-agent-internal-api.ts`.
 */
export const STS_CLOUD_AGENT_NEXT_STREAMS_CLOSE = {
  audience: 'cloud-agent-next',
  scope: 'cloud-agent-next:streams.close',
} as const;

/**
 * Reads the approval binding and command of the oldest pending permission on an owned session for
 * the home widget (`POST /internal/widgets/approval-key`). Only the `web` workload may send it,
 * from the glanceable agents snapshot through
 * `apps/web/src/lib/cloud-agent-next/cloud-agent-internal-api.ts`.
 */
export const STS_CLOUD_AGENT_NEXT_WIDGET_APPROVAL_KEY_READ = {
  audience: 'cloud-agent-next',
  scope: 'cloud-agent-next:widget-approval-key.read',
} as const;

/**
 * A GitHub Actions job asks the web app to mint the one-hour catalog API token
 * (`POST /api/internal/mcp-catalog/token`): the MCP catalog dump and the kilo-app changelog jobs.
 */
export const STS_WEB_MCP_CATALOG_TOKEN_MINT = {
  audience: 'web',
  scope: 'web:mcp-catalog-token.mint',
} as const;

/**
 * Kilo-Org/kilocode's watch-opencode-releases job asks the community contributions dashboard to
 * sync a new upstream opencode release (`POST /api/opencode/sync`).
 */
export const STS_COMMUNITY_CONTRIBUTIONS_DASHBOARD_OPENCODE_SYNC = {
  audience: 'community-contributions-dashboard',
  scope: 'community-contributions-dashboard:opencode.sync',
} as const;

/**
 * The pilot pair (decision D6c): usage-ingest's canary calls the web app and the web app calls
 * usage-ingest back, each with a token of the other's canary scope. `canary` holds only the
 * reserved denied probe. The UTS scopes are those UTS and its feed accept from a service: the web
 * app reads the revocation feed and ends or revokes a subject's sessions and credentials;
 * `uts:token-exchange` authenticates kilo-mcp's RFC 8693 exchange. The service-only scopes of
 * phase 4 are the Secure Proxy forward (`STS_SECURE_PROXY_FORWARD`), the usage publish to Usage
 * Ingest (`STS_USAGE_PUBLISH`), the usage record at the web app (`STS_USAGE_RECORD`), O11y's
 * API-metrics write and alerting read and write (`STS_O11Y_*`), Security Sync's manual sync and
 * finding dismissal (`STS_SECURITY_SYNC_*`), the web app's security notification dispatch
 * (`STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH`), and the Bouncer scopes (`STS_BOUNCER_*`). The CI
 * scopes are the web app's catalog token mint (`STS_WEB_MCP_CATALOG_TOKEN_MINT`) and the
 * community contributions dashboard's opencode sync
 * (`STS_COMMUNITY_CONTRIBUTIONS_DASHBOARD_OPENCODE_SYNC`).
 * The phase 2 C1 scopes are each one sender's call to the web app (the other `STS_WEB_*` pairs),
 * Cloud Agent's callbacks to Webhook Agent Ingest and Security Auto Analysis, the web app's calls
 * to the Code Review Worker (`STS_CODE_REVIEW_*`), its session access invalidation at Session
 * Ingest, and its calls to other Workers' web-called `/internal/*` routes (`STS_*_INTERNAL_CALL`).
 * The Cloud Agent scopes (`STS_CLOUD_AGENT_NEXT_*`) are the web app's and the Code Review
 * Worker's calls to Cloud Agent's internal routes and procedures, one scope per action.
 * STS mints each one only where a policy grants it (default deny).
 */
export const STS_SCOPE_REGISTRY: StsScopeRegistry = {
  web: {
    scopes: [
      'web:sts.canary',
      STS_USAGE_RECORD.scope,
      STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH.scope,
      STS_WEB_SECURITY_NOTIFICATIONS_LIFECYCLE.scope,
      STS_WEB_COMPUTE_BALANCE_ALERT.scope,
      STS_WEB_SCIM_SYNC.scope,
      STS_WEB_USER_DATA_EXPORT_READY.scope,
      STS_WEB_AUTO_ROUTING_POOL_PINS_WRITE.scope,
      STS_WEB_USAGE_RECEIPTS_READ.scope,
      STS_WEB_AUTO_ROUTING_PRODUCTION_PROFILE_READ.scope,
      STS_WEB_USAGE_RECORD_BENCHMARK_GRADER.scope,
      STS_WEB_USAGE_RECORD_CLASSIFIER.scope,
      STS_WEB_USAGE_RECORD_REGION_HANDOFF.scope,
      STS_WEB_CLAUDE_BILLING_PAYER_STATE_READ.scope,
      STS_WEB_GLANCEABLE_SNAPSHOT_READ.scope,
      STS_WEB_BYOC_CREDENTIALS_READ.scope,
      STS_WEB_BYOC_CREDENTIALS_WRITE.scope,
      STS_WEB_HOSTED_WORKSPACE_PULL_REQUESTS_REFRESH.scope,
      STS_WEB_BOT_SESSION_CALLBACK.scope,
      STS_WEB_SECURITY_ANALYSIS_CALLBACK.scope,
      STS_WEB_CODE_REVIEW_AGENT_CALLBACK.scope,
      STS_WEB_CODE_REVIEW_STATUS_CALLBACK.scope,
      STS_WEB_MCP_CATALOG_TOKEN_MINT.scope,
    ],
  },
  'usage-ingest': { scopes: ['usage-ingest:sts.canary', STS_USAGE_PUBLISH.scope] },
  [STS_DENIED_PROBE.audience]: { scopes: [STS_DENIED_PROBE.scope] },
  'uts-feed': { scopes: ['uts-feed:revocation.read'] },
  uts: {
    scopes: [
      'uts:subjects.revoke',
      'uts:browser-sessions.end',
      'uts:api-credentials.revoke',
      'uts:token-exchange',
    ],
  },
  [STS_SECURE_PROXY_FORWARD.audience]: { scopes: [STS_SECURE_PROXY_FORWARD.scope] },
  o11y: {
    scopes: [
      STS_O11Y_API_METRICS_WRITE.scope,
      STS_O11Y_ALERTING_READ.scope,
      STS_O11Y_ALERTING_WRITE.scope,
    ],
  },
  'security-sync': {
    scopes: [STS_SECURITY_SYNC_MANUAL_SYNC.scope, STS_SECURITY_SYNC_DISMISS_FINDING.scope],
  },
  [STS_BOUNCER_DECIDE.audience]: {
    scopes: [
      STS_BOUNCER_DECIDE.scope,
      STS_BOUNCER_USAGE_WRITE.scope,
      STS_BOUNCER_SIGNUP_DECIDE.scope,
      STS_BOUNCER_SIGNUP_HISTORY.scope,
    ],
  },
  'webhook-agent-ingest': {
    scopes: [
      STS_WEBHOOK_AGENT_INGEST_EXECUTION_CALLBACK.scope,
      STS_WEBHOOK_AGENT_INGEST_INTERNAL_CALL.scope,
    ],
  },
  'security-auto-analysis': {
    scopes: [
      STS_SECURITY_AUTO_ANALYSIS_ANALYSIS_CALLBACK.scope,
      STS_SECURITY_AUTO_ANALYSIS_REMEDIATION_CALLBACK.scope,
      STS_SECURITY_AUTO_ANALYSIS_INTERNAL_CALL.scope,
    ],
  },
  'code-review': {
    scopes: [
      STS_CODE_REVIEW_DISPATCH.scope,
      STS_CODE_REVIEW_STATUS_READ.scope,
      STS_CODE_REVIEW_CANCEL.scope,
      STS_CODE_REVIEW_RETRY_FRESH.scope,
    ],
  },
  'session-ingest': {
    scopes: [STS_SESSION_INGEST_SESSION_ACCESS_INVALIDATE.scope],
  },
  'model-eval-ingest': {
    scopes: [STS_MODEL_EVAL_INGEST_INTERNAL_CALL.scope],
  },
  'session-sync': { scopes: [STS_SESSION_SYNC_INTERNAL_CALL.scope] },
  notifications: { scopes: [STS_NOTIFICATIONS_INTERNAL_CALL.scope] },
  'auto-routing': {
    scopes: [
      STS_AUTO_ROUTING_ADMIN_READ.scope,
      STS_AUTO_ROUTING_ADMIN_WRITE.scope,
      STS_AUTO_ROUTING_DECIDE.scope,
    ],
  },
  // `auto-routing-benchmark:case-inference` and `:gateway-assignment` live in
  // packages/auto-routing-contracts/src/benchmark-inference.ts.
  'auto-routing-benchmark': {
    scopes: [
      STS_AUTO_ROUTING_BENCHMARK_ROUTING_TABLES_READ.scope,
      STS_AUTO_ROUTING_BENCHMARK_ADMIN_READ.scope,
      STS_AUTO_ROUTING_BENCHMARK_ADMIN_WRITE.scope,
    ],
  },
  'cloud-agent-next': {
    scopes: [
      STS_CLOUD_AGENT_NEXT_SESSION_PREPARE.scope,
      STS_CLOUD_AGENT_NEXT_SESSION_UPDATE.scope,
      STS_CLOUD_AGENT_NEXT_SESSION_CLEANUP.scope,
      STS_CLOUD_AGENT_NEXT_BALANCE_BYPASS.scope,
      STS_CLOUD_AGENT_NEXT_CODE_REVIEW_BILLING_READ.scope,
      STS_CLOUD_AGENT_NEXT_CONTAINER_BILLING_READ.scope,
      STS_CLOUD_AGENT_NEXT_BYOC_ENROLLMENT_READ.scope,
      STS_CLOUD_AGENT_NEXT_BYOC_RUNTIME_IDENTITY_READ.scope,
      STS_CLOUD_AGENT_NEXT_BYOC_SNAPSHOT_BUILD_START.scope,
      STS_CLOUD_AGENT_NEXT_BYOC_SNAPSHOT_BUILD_CLEANUP.scope,
      STS_CLOUD_AGENT_NEXT_STREAMS_CLOSE.scope,
      STS_CLOUD_AGENT_NEXT_WIDGET_APPROVAL_KEY_READ.scope,
    ],
  },
  'community-contributions-dashboard': {
    scopes: [STS_COMMUNITY_CONTRIBUTIONS_DASHBOARD_OPENCODE_SYNC.scope],
  },
};

/** Whether `scope` is registered under `audience`. Inherited object keys never match. */
export function isRegisteredStsScope(
  audience: string,
  scope: string,
  registry: StsScopeRegistry = STS_SCOPE_REGISTRY
): boolean {
  if (!Object.hasOwn(registry, audience)) return false;
  return registry[audience]?.scopes.includes(scope) ?? false;
}

/** Every rule a registry breaks: an invalid audience or scope, a scope under another audience, a duplicate. */
export function stsScopeRegistryProblems(registry: StsScopeRegistry): string[] {
  const problems: string[] = [];
  for (const [audience, entry] of Object.entries(registry)) {
    if (!AudienceSchema.safeParse(audience).success) {
      problems.push(`audience ${JSON.stringify(audience)} is not a valid audience`);
    }
    const seen = new Set<string>();
    for (const scope of entry.scopes) {
      if (!ScopeSchema.safeParse(scope).success) {
        problems.push(`${audience}: scope ${JSON.stringify(scope)} is not a valid scope`);
      } else if (scopeAudience(scope) !== audience) {
        problems.push(`${audience}: scope ${scope} belongs to audience ${scopeAudience(scope)}`);
      }
      if (seen.has(scope)) problems.push(`${audience}: scope ${scope} is listed twice`);
      seen.add(scope);
    }
  }
  return problems;
}
