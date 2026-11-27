import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import { readCodeReviewInfraSecret } from '../../../code-review-infra/src/secrets';
import { readSecuritySyncSecret } from '../../../security-sync/src/secrets';
import { readSessionSyncSecret } from '../../../session-sync/src/secrets';
import { readUserDataExportSecret } from '../../../user-data-export/src/secrets';
import { readWebhookAgentIngestSecret } from '../../../webhook-agent-ingest/src/secrets';
import { PolicySchema, type Policy } from '../../src/policy/schema';
import { repoRoot, shippedPolicyDocuments } from './repo';
import { parseWorkerConfig } from './worker-configs';

/**
 * The three names STS serves from `/shared`; every other name resolves from the Worker's own
 * `/workloads/<workload>` folder (src/policy/schema.ts `bundleFolder`). A copier row's STS lookup
 * name is therefore the canonical name itself, placed in the folder this list selects.
 */
const SHARED_NAMES: readonly string[] = [
  'INTERNAL_API_SECRET',
  'NEXTAUTH_SECRET',
  'CALLBACK_TOKEN_SECRET',
];

/** No policy secret may carry an environment suffix (src/policy/schema.ts): the folder picks it. */
const ENVIRONMENT_SUFFIX = /_(PROD|PRODUCTION|STAGING|DEV|DEVELOPMENT)$/;

/** One row of the copier table the PR body publishes. */
type CopierRow = {
  workload: string;
  /** The binding the Worker reads today, and the name the copier keeps or retires. */
  oldBinding: string;
  /** The Secrets Store `secret_name` behind that binding, or `—` for a plain Worker secret. */
  storeSecretName: string;
  /** The STS bundle name, which is also the Infisical key in the target path below. */
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
    // Manifest ↔ store name: a Secrets Store binding names the secret after the binding or after
    // its `_PROD` alias, and nothing else.
    if (entry !== undefined) {
      expect([binding, `${binding}_PROD`], `${worker.workload}: ${name}`).toContain(
        entry.secret_name
      );
    }
    const shared = SHARED_NAMES.includes(name);
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
        workload: 'cloudflare-security-sync',
        configPath: 'services/security-sync/wrangler.jsonc',
        names: ['INTERNAL_API_SECRET'],
        read: readSecuritySyncSecret,
      })),
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
        workload: 'cloudflare-webhook-agent-ingest',
        configPath: 'services/webhook-agent-ingest/wrangler.jsonc',
        names: ['INTERNAL_API_SECRET', 'CALLBACK_TOKEN_SECRET', 'NEXTAUTH_SECRET'],
        read: readWebhookAgentIngestSecret,
      })),
      ...(await proveWorker({
        workload: 'kilo-code-review-worker',
        configPath: 'services/code-review-infra/wrangler.jsonc',
        names: ['INTERNAL_API_SECRET', 'CALLBACK_TOKEN_SECRET', 'BACKEND_AUTH_TOKEN'],
        read: readCodeReviewInfraSecret,
      })),
    ];

    // No two rows name the same Worker binding, and every row is a policy entry the workload's
    // policy grants.
    const policies = shippedPolicies();
    expect(rows.map(row => `${row.workload}|${row.oldBinding}`)).toEqual([
      ...new Set(rows.map(row => `${row.workload}|${row.oldBinding}`)),
    ]);
    expect(rows).toHaveLength(1 + 3 + 4 + 3 + 3);
    for (const row of rows) {
      expect(policies.get(row.workload)?.secrets, row.workload).toContain(row.policyEntry);
    }
  });
});
