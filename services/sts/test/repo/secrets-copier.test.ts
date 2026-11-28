import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import { readAiAttributionSecret } from '../../../ai-attribution/src/secrets';
import { readAutoRoutingBenchmarkSecret } from '../../../auto-routing-benchmark/src/secrets';
import { readAutoRoutingSecret } from '../../../auto-routing/src/secrets';
import { readCodeReviewInfraSecret } from '../../../code-review-infra/src/secrets';
import { readKiloclawBillingSecret } from '../../../kiloclaw-billing/src/secrets';
import { readScimSyncSecret } from '../../../scim-sync/src/secrets';
import { readSessionSyncSecret } from '../../../session-sync/src/secrets';
import { readUserDataExportSecret } from '../../../user-data-export/src/secrets';
import { PolicySchema, type Policy } from '../../src/policy/schema';
import { repoRoot, SHARED_SECRET_NAMES, shippedPolicyDocuments } from './repo';
import { parseWorkerConfig } from './worker-configs';

/** No policy secret may carry an environment suffix (src/policy/schema.ts): the folder picks it. */
const ENVIRONMENT_SUFFIX = /_(PROD|PRODUCTION|STAGING|DEV|DEVELOPMENT)$/;

/**
 * Store items whose name is neither the binding's own nor its `_PROD` alias. Listed one row at a
 * time, keyed by `workload|policy entry`, and the same value `policy-reader-names.test.ts` pins as
 * its `STORE_SUFFIX_EXCEPTIONS` row: an item named after another app is a deliberate reuse, and a
 * rename must fail here rather than pass as a prefix match.
 */
const STORE_NAME_ALIASES: Readonly<Record<string, string>> = {
  'kilo-ai-attribution|ADMIN_SECRET': 'AI_ATTRIBUTION_ADMIN_SECRET_PROD',
};

/** One row of the copier table the PR body publishes. */
type CopierRow = {
  workload: string;
  /** The binding the Worker reads today, and the name the copier keeps or retires. */
  oldBinding: string;
  /** The Secrets Store `secret_name` behind that binding, or `—` for a plain Worker secret. */
  storeSecretName: string;
  /** The STS bundle name, which is also the Infisical key, and the path the copier copies into. */
  stsLookup: string;
  /** The entry services/sts/policy/<workload>.yaml grants. */
  policyEntry: string;
};

/**
 * Reads a config with Wrangler's own JSON, JSONC and TOML parser, the one a deploy uses. It lives
 * in this test file because wrangler's published types re-export from `@cloudflare/workers-utils`,
 * which wrangler does not ship, so type-aware lint sees the function as `error` typed everywhere
 * but `*.test.ts`.
 */
const readWorkerConfig = (path: string) =>
  parseWorkerConfig(path, experimental_readRawConfig({ config: join(repoRoot, path) }).rawConfig);

function shippedPolicies(): Map<string, Policy> {
  return new Map(
    shippedPolicyDocuments().map(({ document }) => {
      const policy = PolicySchema.parse(document);
      return [policy.workload, policy] as const;
    })
  );
}

/** The published table's path column: where the copier copies each value. */
const PUBLISHED_PATHS: Record<string, string> = {
  'session-sync|NEXTAUTH_SECRET': '/shared/NEXTAUTH_SECRET',
  'session-sync|SESSION_SYNC_SECRET': '/workloads/session-sync/SESSION_SYNC_SECRET',
  'session-sync|INTERNAL_API_SECRET': '/shared/INTERNAL_API_SECRET',
  'user-data-export|INTERNAL_API_SECRET': '/shared/INTERNAL_API_SECRET',
  'user-data-export|NEXTAUTH_SECRET': '/shared/NEXTAUTH_SECRET',
  'user-data-export|R2_ACCESS_KEY_ID': '/workloads/user-data-export/R2_ACCESS_KEY_ID',
  'user-data-export|R2_SECRET_ACCESS_KEY': '/workloads/user-data-export/R2_SECRET_ACCESS_KEY',
  'kilo-code-review-worker|INTERNAL_API_SECRET': '/shared/INTERNAL_API_SECRET',
  'kilo-code-review-worker|CALLBACK_TOKEN_SECRET': '/shared/CALLBACK_TOKEN_SECRET',
  'kilo-code-review-worker|BACKEND_AUTH_TOKEN':
    '/workloads/kilo-code-review-worker/BACKEND_AUTH_TOKEN',
  'kilo-ai-attribution|NEXTAUTH_SECRET': '/shared/NEXTAUTH_SECRET',
  'kilo-ai-attribution|ADMIN_SECRET': '/workloads/kilo-ai-attribution/ADMIN_SECRET',
  'auto-routing|INTERNAL_API_SECRET': '/shared/INTERNAL_API_SECRET',
  'auto-routing|OPENROUTER_API_KEY': '/shared/OPENROUTER_API_KEY',
  'auto-routing|O11Y_CF_AE_API_TOKEN': '/shared/O11Y_CF_AE_API_TOKEN',
  'auto-routing|NEXTAUTH_SECRET': '/shared/NEXTAUTH_SECRET',
  'auto-routing|AUTO_ROUTING_DECISION_SECRET':
    '/workloads/auto-routing/AUTO_ROUTING_DECISION_SECRET',
  'auto-routing-benchmark|INTERNAL_API_SECRET': '/shared/INTERNAL_API_SECRET',
  'auto-routing-benchmark|BOT_TOKEN_MINT_SECRET': '/shared/BOT_TOKEN_MINT_SECRET',
  'auto-routing-benchmark|OPENROUTER_API_KEY': '/shared/OPENROUTER_API_KEY',
  'cloudflare-scim-sync|WORKOS_API_KEY': '/workloads/cloudflare-scim-sync/WORKOS_API_KEY',
  'cloudflare-scim-sync|WORKOS_CLIENT_ID': '/workloads/cloudflare-scim-sync/WORKOS_CLIENT_ID',
  'cloudflare-scim-sync|INTERNAL_API_SECRET': '/shared/INTERNAL_API_SECRET',
  'kiloclaw-billing|INTERNAL_API_SECRET': '/shared/INTERNAL_API_SECRET',
  'kiloclaw-billing|SNOWFLAKE_PRIVATE_KEY_PEM':
    '/workloads/kiloclaw-billing/SNOWFLAKE_PRIVATE_KEY_PEM',
  'kiloclaw-billing|SNOWFLAKE_PUBLIC_KEY_FINGERPRINT':
    '/workloads/kiloclaw-billing/SNOWFLAKE_PUBLIC_KEY_FINGERPRINT',
};

/**
 * Proves one Worker's rows against the three sources the copier table claims to agree: the shipped
 * policy (its `secrets`), the reader (which binding serves each name) and the wrangler manifest
 * (which of those bindings is a Secrets Store secret, and under which `secret_name`).
 */
async function proveWorker<N extends string>(worker: {
  workload: string;
  configPath: string;
  /** The reader's own name union; a name outside it is a type error here, not a runtime failure. */
  names: readonly N[];
  read: (env: Record<string, string>, name: N) => Promise<string>;
}): Promise<CopierRow[]> {
  const policy = shippedPolicies().get(worker.workload);
  if (policy === undefined) throw new Error(`no shipped policy for ${worker.workload}`);
  // Policy ↔ reader: every name the policy grants is a name the reader serves, exactly once.
  expect([...policy.secrets].sort(), worker.workload).toEqual([...worker.names].sort());
  for (const name of worker.names) {
    expect(name, `${worker.workload}: ${name}`).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(name, `${worker.workload}: ${name}`).not.toMatch(ENVIRONMENT_SUFFIX);
  }

  const { config } = readWorkerConfig(worker.configPath);
  const storeEntries = config.secrets_store_secrets ?? [];
  // The binding a reader looks up is either a Secrets Store binding in this manifest or a plain
  // Worker secret; both kinds appear among the policy names, so this candidate set covers it.
  const candidates = [...new Set([...policy.secrets, ...storeEntries.map(entry => entry.binding)])];

  const rows: CopierRow[] = [];
  for (const name of worker.names) {
    // Reader ↔ manifest, behaviourally: a read answers only when the env carries the one binding
    // this name maps to, so exactly one candidate returns its own sentinel and every other read
    // fails closed.
    const sentinelFor = (binding: string) => `sentinel:${binding}`;
    const serving: string[] = [];
    for (const candidate of candidates) {
      const value = await worker.read({ [candidate]: sentinelFor(candidate) }, name).then(
        read => read,
        () => undefined
      );
      if (value === sentinelFor(candidate)) serving.push(candidate);
    }
    expect(serving, `${worker.workload}: ${name}`).toHaveLength(1);
    const binding = serving.at(0);
    if (binding === undefined) throw new Error(`no binding serves ${worker.workload}: ${name}`);

    const entry = storeEntries.find(candidate => candidate.binding === binding);
    // Manifest ↔ store name: a production block binds the live item, never a dev or staging copy.
    // The item's name is the binding's own name or its `_PROD` alias, or the one alias this table
    // names for it; the table records it verbatim.
    const alias = STORE_NAME_ALIASES[`${worker.workload}|${name}`];
    if (entry !== undefined && alias !== undefined) {
      expect(entry.secret_name, `${worker.workload}: ${name}`).toBe(alias);
    } else if (entry !== undefined) {
      expect([binding, `${binding}_PROD`], `${worker.workload}: ${name}`).toContain(
        entry.secret_name
      );
    } else {
      // A plain Worker secret carries the policy name itself: a `_PROD` binding with no store entry
      // would mean the copier copies a name the deployment does not hold.
      expect(binding, `${worker.workload}: ${name}`).toBe(name);
    }
    // Folder: a shared value lives in `/shared`, a Workload's own credential in its own folder.
    const shared = SHARED_SECRET_NAMES.includes(name);
    rows.push({
      workload: worker.workload,
      oldBinding: binding,
      storeSecretName: entry?.secret_name ?? '—',
      stsLookup: shared ? `/shared/${name}` : `/workloads/${worker.workload}/${name}`,
      policyEntry: name,
    });
  }

  // One-to-one: no two policy entries share a binding, and the manifest holds no Secrets Store
  // binding the reader does not serve.
  expect(new Set(rows.map(row => row.oldBinding)).size, worker.workload).toBe(rows.length);
  for (const entry of storeEntries) {
    expect(
      rows.map(row => row.oldBinding),
      `${worker.workload}: ${entry.binding}`
    ).toContain(entry.binding);
  }
  return rows;
}

describe('the secrets copier table for the Workers that read STS', () => {
  it('maps every policy secret to one binding and one store name in its wrangler manifest', async () => {
    const rows = [
      ...(await proveWorker({
        workload: 'session-sync',
        configPath: 'services/session-sync/wrangler.jsonc',
        names: ['NEXTAUTH_SECRET', 'SESSION_SYNC_SECRET', 'INTERNAL_API_SECRET'],
        read: readSessionSyncSecret,
      })),
      ...(await proveWorker({
        workload: 'user-data-export',
        configPath: 'services/user-data-export/wrangler.jsonc',
        names: [
          'INTERNAL_API_SECRET',
          'NEXTAUTH_SECRET',
          'R2_ACCESS_KEY_ID',
          'R2_SECRET_ACCESS_KEY',
        ],
        read: readUserDataExportSecret,
      })),
      ...(await proveWorker({
        workload: 'kilo-code-review-worker',
        configPath: 'services/code-review-infra/wrangler.jsonc',
        names: ['INTERNAL_API_SECRET', 'CALLBACK_TOKEN_SECRET', 'BACKEND_AUTH_TOKEN'],
        read: readCodeReviewInfraSecret,
      })),
      ...(await proveWorker({
        workload: 'kilo-ai-attribution',
        configPath: 'services/ai-attribution/wrangler.jsonc',
        names: ['NEXTAUTH_SECRET', 'ADMIN_SECRET'],
        read: readAiAttributionSecret,
      })),
      ...(await proveWorker({
        workload: 'auto-routing',
        configPath: 'services/auto-routing/wrangler.jsonc',
        names: [
          'INTERNAL_API_SECRET',
          'OPENROUTER_API_KEY',
          'O11Y_CF_AE_API_TOKEN',
          'NEXTAUTH_SECRET',
          'AUTO_ROUTING_DECISION_SECRET',
        ],
        read: readAutoRoutingSecret,
      })),
      ...(await proveWorker({
        workload: 'auto-routing-benchmark',
        configPath: 'services/auto-routing-benchmark/wrangler.jsonc',
        names: ['INTERNAL_API_SECRET', 'BOT_TOKEN_MINT_SECRET', 'OPENROUTER_API_KEY'],
        read: readAutoRoutingBenchmarkSecret,
      })),
      ...(await proveWorker({
        workload: 'cloudflare-scim-sync',
        configPath: 'services/scim-sync/wrangler.jsonc',
        names: ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'INTERNAL_API_SECRET'],
        read: readScimSyncSecret,
      })),
      ...(await proveWorker({
        workload: 'kiloclaw-billing',
        configPath: 'services/kiloclaw-billing/wrangler.jsonc',
        names: [
          'INTERNAL_API_SECRET',
          'SNOWFLAKE_PRIVATE_KEY_PEM',
          'SNOWFLAKE_PUBLIC_KEY_FINGERPRINT',
        ],
        read: readKiloclawBillingSecret,
      })),
    ];

    // No two rows name the same Worker binding, and every row is a policy entry the workload's
    // policy grants.
    const policies = shippedPolicies();
    expect(rows.map(row => `${row.workload}|${row.oldBinding}`)).toEqual([
      ...new Set(rows.map(row => `${row.workload}|${row.oldBinding}`)),
    ]);
    expect(rows).toHaveLength(3 + 4 + 3 + 2 + 5 + 3 + 3 + 3);
    for (const row of rows) {
      expect(policies.get(row.workload)?.secrets, row.workload).toContain(row.policyEntry);
    }
    // The published path column, made executable: the copier copies each value into exactly this
    // folder, so a row whose folder differs from the table is a documentation bug that would
    // misplace the value.
    expect(
      Object.fromEntries(rows.map(row => [`${row.workload}|${row.policyEntry}`, row.stsLookup]))
    ).toEqual(PUBLISHED_PATHS);
    // The plain-Worker-secret rows and the store rows both appear: the table's second column must
    // not claim a store item for a name the manifest does not bind one to.
    expect(rows.filter(row => row.storeSecretName === '—').map(row => row.policyEntry)).toEqual([
      'INTERNAL_API_SECRET',
      'NEXTAUTH_SECRET',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'INTERNAL_API_SECRET',
      'CALLBACK_TOKEN_SECRET',
      'BACKEND_AUTH_TOKEN',
      'INTERNAL_API_SECRET',
      'SNOWFLAKE_PRIVATE_KEY_PEM',
      'SNOWFLAKE_PUBLIC_KEY_FINGERPRINT',
    ]);
  });
});
