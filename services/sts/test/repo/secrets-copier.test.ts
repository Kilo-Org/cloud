import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import { readAiAttributionSecret } from '../../../ai-attribution/src/secrets';
import { readAutoRoutingBenchmarkSecret } from '../../../auto-routing-benchmark/src/secrets';
import { readAutoRoutingSecret } from '../../../auto-routing/src/secrets';
import { readKiloclawBillingSecret } from '../../../kiloclaw-billing/src/secrets';
import { readScimSyncSecret } from '../../../scim-sync/src/secrets';
import { PolicySchema, type Policy } from '../../src/policy/schema';
import { repoRoot, shippedPolicyDocuments } from './repo';
import { parseWorkerConfig } from './worker-configs';

/** No policy secret may carry an environment suffix (src/policy/schema.ts): the folder picks it. */
const ENVIRONMENT_SUFFIX = /_(PROD|PRODUCTION|STAGING|DEV|DEVELOPMENT)$/;

/**
 * Names the copier places in `/shared` although only one batch policy grants them: the value is
 * also held outside STS, so it is already a shared Infisical value rather than a Workload one.
 * `BOT_TOKEN_MINT_SECRET` authenticates apps/web's `POST /api/internal/bot-token` mint as well as
 * this Worker. Every other single-holder name resolves from its own `/workloads/<workload>` folder.
 */
const SHARED_ELSEWHERE: readonly string[] = ['BOT_TOKEN_MINT_SECRET'];

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

/** Which shipped policies grant each name: several holders means the value is a shared one. */
function holdersBySecretName(): Map<string, string[]> {
  const holders = new Map<string, string[]>();
  for (const policy of shippedPolicies().values()) {
    for (const name of policy.secrets) {
      holders.set(name, [...(holders.get(name) ?? []), policy.workload]);
    }
  }
  return holders;
}

const HOLDERS = holdersBySecretName();

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
  const holders = HOLDERS;

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
    // The item's name is its own (the store carries names such as
    // `AI_ATTRIBUTION_ADMIN_SECRET_PROD` beside the binding), so the table records it verbatim.
    if (entry !== undefined) {
      expect(entry.secret_name, `${worker.workload}: ${name}`).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(entry.secret_name, `${worker.workload}: ${name}`).not.toMatch(
        /_(DEV|DEVELOPMENT|STAGING)$/
      );
    }
    // Folder: a name several policies grant cannot live in one Workload's folder, and a name only
    // this Workload grants stays in its own unless the value is shared outside STS.
    const shared = (holders.get(name)?.length ?? 0) > 1 || SHARED_ELSEWHERE.includes(name);
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
        names: ['INTERNAL_API_SECRET', 'SNOWFLAKE_PRIVATE_KEY_PEM', 'SNOWFLAKE_PUBLIC_KEY_FINGERPRINT'],
        read: readKiloclawBillingSecret,
      })),
    ];

    // No two rows name the same Worker binding, and every row is a policy entry the workload's
    // policy grants.
    const policies = shippedPolicies();
    expect(rows.map(row => `${row.workload}|${row.oldBinding}`)).toEqual([
      ...new Set(rows.map(row => `${row.workload}|${row.oldBinding}`)),
    ]);
    expect(rows).toHaveLength(2 + 5 + 3 + 3 + 3);
    for (const row of rows) {
      expect(policies.get(row.workload)?.secrets, row.workload).toContain(row.policyEntry);
    }
  });
});
