/**
 * Post-process worker-configuration.d.ts after `wrangler types`.
 *
 * Wrangler emits an unparameterized `Service` for cross-worker RPC bindings
 * and cannot declare worker secrets. This script patches the generated output
 * so the rest of the codebase gets accurate types without manual edits.
 *
 * Patches applied:
 *  1. GIT_TOKEN_SERVICE: Service → GitTokenService (typed RPC surface)
 *  2. Adds SENTRY_DSN?: string (worker secret, not a wrangler var)
 *  3. Prepends the GitTokenService type definitions
 */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'worker-configuration.d.ts';

let src = readFileSync(FILE, 'utf8');

// 1. Replace untyped Service binding with GitTokenService
src = src.replaceAll(/GIT_TOKEN_SERVICE:\s*Service\b[^;]*/g, 'GIT_TOKEN_SERVICE: GitTokenService');

// 2. Add SENTRY_DSN worker secret to Cloudflare.Env (if not already present)
if (!src.includes('SENTRY_DSN')) {
  // Insert before the closing brace of the last `interface Env {` block inside
  // the Cloudflare namespace (the one that has CF_VERSION_METADATA, HYPERDRIVE, etc.)
  src = src.replace(
    /(interface Env \{[\s\S]*?)((\n\t)\})/,
    '$1$3\tSENTRY_DSN?: string; // worker secret\n\t\tSENTRY_RELEASE?: string; // deploy-time --var$2'
  );
}

// 3. Prepend GitTokenService RPC types (before the Cloudflare namespace)
const GIT_TOKEN_TYPES = `\
// GIT_TOKEN_SERVICE RPC types (wrangler emits untyped \`Service\` for cross-worker bindings)
type GetTokenForRepoSuccess = {
\tsuccess: true;
\ttoken: string;
\tinstallationId: string;
\taccountLogin: string;
\tappType: 'standard' | 'lite';
};
type GetTokenForRepoFailure = {
\tsuccess: false;
\treason: 'database_not_configured' | 'invalid_repo_format' | 'no_installation_found' | 'invalid_org_id';
};
type GetTokenForRepoResult = GetTokenForRepoSuccess | GetTokenForRepoFailure;
type GitTokenService = {
\tgetTokenForRepo(params: { githubRepo: string; userId: string; orgId?: string }): Promise<GetTokenForRepoResult>;
\tgetToken(installationId: string, appType?: 'standard' | 'lite'): Promise<string>;
};
`;

if (!src.includes('type GitTokenService')) {
  src = src.replace(
    'declare namespace Cloudflare',
    GIT_TOKEN_TYPES + 'declare namespace Cloudflare'
  );
}

writeFileSync(FILE, src);
console.log('[patch-worker-types] patched', FILE);
