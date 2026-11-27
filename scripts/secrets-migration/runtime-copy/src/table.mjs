// The reviewed row table of the runtime copier (M122): worker | binding | store/secret | Infisical
// target. Each row copies one production Secrets Store binding of one source Worker into one
// Create-only Infisical production target: in that Worker's own workload folder, or (M142) one of
// the exact core.mjs SHARED_TARGETS, created once by the first table Worker that binds it; a later
// Worker binding the same store entry proves parity in checks.mjs and creates nothing. secrets-
// cutover posts the rows in ~/.omp/progress/secrets-phase234-files/coordination.md (section
// "M122/M122b Worker runtime source handoff to kc-ci-sts"); each change is a reviewed edit of this
// file plus, for a new Worker, its checks.mjs `WORKER_SOURCES` entry. Never a runtime parameter.
//
// Not here (M142): /shared/OPENROUTER_API_KEY, which secrets-cutover alone creates; the
// Notifications Expo token, its own one-shot run; the per-script Worker secrets, which have no
// copier route (M68). A Worker's rows can run only once its reader and STS policy are on main
// (checks.mjs `source_not_on_main`). Remove a row whose target already exists: Create-only
// refuses it.

import { tableOf } from './core.mjs';

const STORE = '342a86d9e3a94da698e82d0c6e2a36f0';
const row = (worker, binding, secretName, target) =>
  Object.freeze({ worker, binding, storeId: STORE, secretName, target });

/** The validated table: rows, problems, one batch per Worker and the Workers in table order. */
export const TABLE = tableOf(
  Object.freeze([
    row(
      'session-sync',
      'SESSION_SYNC_SECRET',
      'SESSION_SYNC_SECRET_PROD',
      '/workloads/session-sync/SESSION_SYNC_SECRET'
    ),
    row(
      'session-ingest',
      'SESSION_SHARE_JWT_SECRET_PROD',
      'SESSION_SHARE_JWT_SECRET_PROD',
      '/workloads/session-ingest/SESSION_SHARE_JWT_SECRET'
    ),
    row(
      'kilo-ai-attribution',
      'ADMIN_SECRET',
      'AI_ATTRIBUTION_ADMIN_SECRET_PROD',
      '/workloads/kilo-ai-attribution/ADMIN_SECRET'
    ),
    // M142: both auto-routing rows are shared targets. kilo-ops binds the same O11Y store entry
    // (as CF_ANALYTICS_API_KEY) and only proves parity.
    row(
      'auto-routing',
      'AUTO_ROUTING_DECISION_SECRET',
      'AUTO_ROUTING_DECISION_SECRET_PROD',
      '/shared/AUTO_ROUTING_DECISION_SECRET'
    ),
    row(
      'auto-routing',
      'O11Y_CF_AE_API_TOKEN',
      'O11Y_CF_AE_API_TOKEN',
      '/shared/O11Y_CF_AE_API_TOKEN'
    ),
    row(
      'cloudflare-scim-sync',
      'WORKOS_API_KEY',
      'WORKOS_API_KEY',
      '/workloads/cloudflare-scim-sync/WORKOS_API_KEY'
    ),
    row(
      'cloudflare-scim-sync',
      'WORKOS_CLIENT_ID',
      'WORKOS_CLIENT_ID',
      '/workloads/cloudflare-scim-sync/WORKOS_CLIENT_ID'
    ),
    row(
      'kilo-chat',
      'GATEWAY_TOKEN_SECRET',
      'GATEWAY_TOKEN_SECRET',
      '/workloads/kilo-chat/GATEWAY_TOKEN_SECRET'
    ),
    row(
      'kilo-chat',
      'R2_ACCESS_KEY_ID',
      'R2_ACCESS_KEY_ID_KILOCHAT_MEDIA',
      '/workloads/kilo-chat/R2_ACCESS_KEY_ID'
    ),
    row(
      'kilo-chat',
      'R2_SECRET_ACCESS_KEY',
      'R2_SECRET_ACCESS_KEY_KILOCHAT_MEDIA',
      '/workloads/kilo-chat/R2_SECRET_ACCESS_KEY'
    ),
    row(
      'git-token-service',
      'SCM_SESSION_CAPABILITY_ENCRYPTION_KEY',
      'SCM_SESSION_CAPABILITY_ENCRYPTION_KEY_PROD',
      '/workloads/git-token-service/SCM_SESSION_CAPABILITY_ENCRYPTION_KEY'
    ),
    row(
      'git-token-service',
      'BITBUCKET_CLIENT_ID',
      'BITBUCKET_CLIENT_ID_PROD',
      '/workloads/git-token-service/BITBUCKET_CLIENT_ID'
    ),
    row(
      'git-token-service',
      'BITBUCKET_CLIENT_SECRET',
      'BITBUCKET_CLIENT_SECRET_PROD',
      '/workloads/git-token-service/BITBUCKET_CLIENT_SECRET'
    ),
    row('kilo-ops', 'GF_SECRET_KEY', 'GF_SECRET_KEY', '/workloads/kilo-ops/GF_SECRET_KEY'),
  ])
);
