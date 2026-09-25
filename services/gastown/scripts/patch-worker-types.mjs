/**
 * Post-process worker-configuration.d.ts after `wrangler types`.
 *
 * Wrangler emits an unparameterized `Service` for cross-worker RPC bindings
 * and cannot declare worker secrets. This script patches the generated output
 * so the rest of the codebase gets accurate types without manual edits.
 *
 * Patches applied:
 *  1. Service bindings → typed RPC surfaces
 *  2. Adds worker secrets omitted from Wrangler vars
 *  3. Widens the deployment-time billing flag for local test fixtures
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = 'worker-configuration.d.ts';

const ENV_ANCHOR = 'interface __BaseEnv_Env {';

// Each field is guarded on a typed property declaration for its name, so an
// unrelated bare mention elsewhere in the file cannot suppress it, while a
// wrangler-generated var (e.g. `SENTRY_DSN: "https://…"`, which `wrangler types`
// emits as a literal) still counts as already declared.
const SENTRY_FIELDS = [
  {
    name: 'SENTRY_DSN',
    declaration: /\bSENTRY_DSN\??\s*:/,
    line: '\tSENTRY_DSN?: string; // worker secret',
  },
  {
    name: 'SENTRY_RELEASE',
    declaration: /\bSENTRY_RELEASE\??\s*:/,
    line: '\tSENTRY_RELEASE?: string; // deploy-time --var',
  },
];

const RPC_TYPES = `\
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
type WastelandRpcSuccess<T> = { success: true; data: T };
type WastelandRpcFailure = {
\tsuccess: false;
\tcode: 'NOT_FOUND' | 'PRECONDITION_FAILED' | 'INTERNAL_SERVER_ERROR' | 'UPSTREAM_ERROR';
\tmessage: string;
};
type WastelandRpcResult<T> = WastelandRpcSuccess<T> | WastelandRpcFailure;
type WastelandService = {
\tbrowseWantedBoard(params: {
\t\twastelandId: string;
\t\tuserId: string;
\t\tstatus?: 'open' | 'claimed' | 'in_review' | 'completed' | 'validated' | 'withdrawn';
\t\tsearch?: string;
\t\tsort?: 'priority' | 'activity';
\t\tlimit?: number;
\t\tincludeForkBranches?: boolean;
\t}): Promise<WastelandRpcResult<Array<Record<string, unknown>>>>;
\tclaimWantedItem(params: { wastelandId: string; userId: string; itemId: string }): Promise<WastelandRpcResult<{ success: true; pr_url: string | null }>>;
\tpostWantedItem(params: {
\t\twastelandId: string;
\t\tuserId: string;
\t\ttitle: string;
\t\tdescription: string;
\t\tpriority?: 'low' | 'medium' | 'high' | 'critical';
\t\ttype?: 'feature' | 'bug' | 'docs' | 'other';
\t\tpublish?: boolean;
\t}): Promise<WastelandRpcResult<{ success: true; wantedId: string; pr_url: string | null }>>;
\tmarkWantedItemDone(params: { wastelandId: string; userId: string; itemId: string; evidence: string }): Promise<WastelandRpcResult<{ success: true; pr_url: string | null }>>;
};
type ContainerUsageService = import("@kilocode/container-usage").ContainerUsageRpcMethods;
`;

export function patchWorkerTypes(src) {
  let patched = src;

  // 1. Replace untyped Service bindings with their RPC surfaces.
  patched = patched.replaceAll(/GIT_TOKEN_SERVICE:\s*Service\b[^;]*/g, 'GIT_TOKEN_SERVICE: GitTokenService');
  patched = patched.replaceAll(/WASTELAND_SERVICE:\s*Service\b[^;]*/g, 'WASTELAND_SERVICE: WastelandService');
  patched = patched.replaceAll(
    /CONTAINER_USAGE:\s*Service\b[^;]*/g,
    'CONTAINER_USAGE: ContainerUsageService'
  );
  patched = patched.replaceAll(
    'GASTOWN_BILLING_ENABLED: "true"',
    'GASTOWN_BILLING_ENABLED: "false" | "true"'
  );

  // 2. Add each missing SENTRY worker secret to Cloudflare.Env. Guard per
  // field, because wrangler may emit SENTRY_DSN (as a var) without
  // SENTRY_RELEASE (deploy-time --var only).
  const missing = SENTRY_FIELDS.filter(field => !field.declaration.test(patched));
  if (missing.length > 0) {
    if (!patched.includes(ENV_ANCHOR)) {
      const names = missing.map(field => field.name).join(', ');
      throw new Error(
        `[patch-worker-types] cannot add ${names} to ${FILE}: ` +
          `anchor ${JSON.stringify(ENV_ANCHOR)} not found`
      );
    }
    patched = patched.replace(
      ENV_ANCHOR,
      `${ENV_ANCHOR}\n${missing.map(field => field.line).join('\n')}`
    );
  }

  // 3. Prepend GitTokenService RPC types (before the Cloudflare namespace)
  if (!patched.includes('type GitTokenService')) {
    patched = patched.replace(
      'declare namespace Cloudflare',
      RPC_TYPES + 'declare namespace Cloudflare'
    );
  }

  return patched;
}

function main() {
  const src = readFileSync(FILE, 'utf8');
  writeFileSync(FILE, patchWorkerTypes(src));
  console.log('[patch-worker-types] patched', FILE);
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
