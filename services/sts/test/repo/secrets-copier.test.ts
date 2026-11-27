import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import { readCodeReviewInfraSecret } from '../../../code-review-infra/src/secrets';
import { readSessionSyncSecret } from '../../../session-sync/src/secrets';
import { readUserDataExportSecret } from '../../../user-data-export/src/secrets';
import { PolicySchema, type Policy } from '../../src/policy/schema';
import { repoRoot, shippedPolicyDocuments } from './repo';
import { parseWorkerConfig } from './worker-configs';

/** No policy secret may carry an environment suffix (src/policy/schema.ts): the folder picks it. */
const ENVIRONMENT_SUFFIX = /_(PROD|PRODUCTION|STAGING|DEV|DEVELOPMENT)$/;

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
 * Names whose value is shared beyond the policies that grant it today. `apps/web` verifies the
 * Worker's callbacks with the same `CALLBACK_TOKEN_SECRET` (`apps/web/src/lib/web-config.server.ts`),
 * so the value lives in `/shared` rather than the Workload's own folder. STS resolves a Workload
 * folder before `/shared`, so a `/workloads/<workload>` copy would shadow the shared value for that
 * Worker alone, silently.
 */
const SHARED_ELSEWHERE: Record<string, true> = { CALLBACK_TOKEN_SECRET: true };

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
    // The item's name is the binding's own name or its `_PROD` alias; the table records it verbatim.
    if (entry !== undefined) {
      expect([binding, `${binding}_PROD`], `${worker.workload}: ${name}`).toContain(
        entry.secret_name
      );
    } else {
      // A plain Worker secret carries the policy name itself: a `_PROD` binding with no store entry
      // would mean the copier copies a name the deployment does not hold.
      expect(binding, `${worker.workload}: ${name}`).toBe(name);
    }
    // Folder: a name several policies grant cannot live in one Workload's folder, and a name only
    // this Workload grants stays in its own unless its value is shared outside STS.
    const shared = (HOLDERS.get(name)?.length ?? 0) > 1 || SHARED_ELSEWHERE[name] === true;
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
    ];

    // No two rows name the same Worker binding, and every row is a policy entry the workload's
    // policy grants.
    const policies = shippedPolicies();
    expect(rows.map(row => `${row.workload}|${row.oldBinding}`)).toEqual([
      ...new Set(rows.map(row => `${row.workload}|${row.oldBinding}`)),
    ]);
    expect(rows).toHaveLength(3 + 4 + 3);
    for (const row of rows) {
      expect(policies.get(row.workload)?.secrets, row.workload).toContain(row.policyEntry);
      // The published table's fourth column is the lookup name; the path column is derived from
      // how many policies grant the name, so a value copied anywhere else is a copier mistake.
      expect(row.stsLookup.split('/').at(-1), row.workload).toBe(row.policyEntry);
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
    ]);
  });
});
