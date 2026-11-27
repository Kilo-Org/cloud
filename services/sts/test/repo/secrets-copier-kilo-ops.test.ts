import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import {
  readKiloOpsSecret,
  type KiloOpsSecretName,
  type KiloOpsSecretsEnv,
} from '../../../kilo-ops/src/secrets';
import { PolicySchema, type Policy } from '../../src/policy/schema';
import { repoRoot, shippedPolicyDocuments } from './repo';
import { parseWorkerConfig } from './worker-configs';

/**
 * The copier table this PR body publishes, proven against the three sources it claims to agree:
 * the shipped policy (its `secrets`), the reader (which binding each name reads today) and the
 * wrangler manifest (the Secrets Store entry behind each binding, and its `secret_name`).
 *
 * A read answers only from the one binding it holds, so exactly one candidate returns its own
 * sentinel. A name the policy grants and the reader does not serve, or two names sharing one
 * binding, fails here instead of at cutover, where the legacy read keeps working and `sts` answers
 * `not_granted`.
 *
 * Both secrets are Secrets Store entries, and each entry's `secret_name` is the canonical name the
 * bundle serves, not the binding name: `CF_ANALYTICS_API_KEY` holds `O11Y_CF_AE_API_TOKEN`.
 */

const WORKLOAD = 'kilo-ops';
const CONFIG_PATH = 'services/kilo-ops/wrangler.jsonc';

/** No policy secret may carry an environment suffix (src/policy/schema.ts): the folder picks it. */
const ENVIRONMENT_SUFFIX = /_(PROD|PRODUCTION|STAGING|DEV|DEVELOPMENT)$/;

/** The reader's own name union: a name outside it is a type error here, not a runtime failure. */
const NAMES: readonly KiloOpsSecretName[] = ['O11Y_CF_AE_API_TOKEN', 'GF_SECRET_KEY'];

/** One row of the copier table: the four columns the PR body publishes. */
type CopierRow = {
  /** The binding the Worker reads today, and the name the copier keeps or retires. */
  oldBinding: string;
  /** The Secrets Store `secret_name` behind that binding. */
  storeSecretName: string;
  /** The STS bundle name, which is also the Infisical key in the folder below. */
  stsLookup: string;
  /** The entry services/sts/policy/kilo-ops.yaml grants. */
  policyEntry: string;
};

/**
 * The copier table this PR publishes, row for row. The reader, the policy and the manifest are
 * derived from the files; this literal is what they are compared against, so a row that changes in
 * any of the three fails here. Without it the comparison would only restate the derivation.
 */
const EXPECTED_ROWS: readonly CopierRow[] = [
  {
    oldBinding: 'CF_ANALYTICS_API_KEY',
    storeSecretName: 'O11Y_CF_AE_API_TOKEN',
    stsLookup: '/shared/O11Y_CF_AE_API_TOKEN',
    policyEntry: 'O11Y_CF_AE_API_TOKEN',
  },
  {
    oldBinding: 'GF_SECRET_KEY',
    storeSecretName: 'GF_SECRET_KEY',
    stsLookup: '/workloads/kilo-ops/GF_SECRET_KEY',
    policyEntry: 'GF_SECRET_KEY',
  },
];

/**
 * The entry the `dev` block reads, by binding. It has to exist in the account's Secrets Store
 * before `wrangler deploy --env dev` works, and it may not hold a production value: a config that
 * binds STS may not read a production-named store secret from a non-production block
 * (worker-configs.ts). Nothing else is bound there: no dev-scoped Analytics Engine token can be
 * minted, so dev runs that proxy off (src/worker.ts, `secretConfigured`).
 */
const EXPECTED_DEV_ENTRIES: readonly { binding: string; secret_name: string }[] = [
  { binding: 'GF_SECRET_KEY', secret_name: 'GF_SECRET_KEY_DEV' },
];

/**
 * Reads a config with Wrangler's own JSON, JSONC and TOML parser, the one a deploy uses. It lives
 * in this test file because wrangler's published types re-export from `@cloudflare/workers-utils`,
 * which wrangler does not ship, so type-aware lint sees the function as `error` typed everywhere
 * but `*.test.ts`.
 */
const readWorkerConfig = (path: string) =>
  parseWorkerConfig(path, experimental_readRawConfig({ config: join(repoRoot, path) }).rawConfig);

function shippedPolicies(): Policy[] {
  return shippedPolicyDocuments().map(({ document }) => PolicySchema.parse(document));
}

function shippedPolicy(workload: string): Policy {
  const found = shippedPolicies().find(policy => policy.workload === workload);
  if (found === undefined) throw new Error(`no shipped policy for ${workload}`);
  return found;
}

/**
 * A legacy env that holds one binding and nothing else: the reader sees exactly the candidates
 * this test offers, and the cast only builds the partial shape the deployed env has.
 */
const envWith = (binding: string, value: string): KiloOpsSecretsEnv =>
  ({ [binding]: value }) as unknown as KiloOpsSecretsEnv;

/** The one binding a read answers from; every other candidate makes the read fail closed. */
async function serving<N extends string>(
  candidates: readonly string[],
  name: N,
  read: (env: KiloOpsSecretsEnv, name: N) => Promise<string>
): Promise<string> {
  const served: string[] = [];
  for (const candidate of candidates) {
    const sentinel = `sentinel:${candidate}`;
    const value = await read(envWith(candidate, sentinel), name).then(
      answer => answer,
      () => undefined
    );
    if (value === sentinel) served.push(candidate);
  }
  expect(served, name).toHaveLength(1);
  const binding = served.at(0);
  if (binding === undefined) throw new Error(`no binding serves ${name}`);
  return binding;
}

/**
 * The bundle key STS reads: another shipped policy granting the same name puts it in the fallback
 * folder `/shared`, otherwise it is this workload's own entry in `/workloads/kilo-ops`
 * (src/policy/schema.ts `bundleFolder`). EXPECTED_ROWS pins the result, so a wrong folder fails.
 */
function stsLookup(name: string): string {
  const elsewhere = shippedPolicies().filter(
    policy => policy.workload !== WORKLOAD && policy.secrets.includes(name)
  );
  return elsewhere.length > 0 ? `/shared/${name}` : `/workloads/${WORKLOAD}/${name}`;
}

describe('the secrets copier table for kilo-ops', () => {
  it('maps every policy secret to one binding and one store name in its wrangler manifest', async () => {
    const policy = shippedPolicy(WORKLOAD);
    expect(policy.identity.kind).toBe('worker-binding');
    expect(policy.environments).toEqual(['production']);

    // Policy <-> reader: every policy entry is a name the reader serves, exactly once, canonical.
    expect([...policy.secrets].sort(), WORKLOAD).toEqual([...NAMES].sort());
    for (const name of NAMES) {
      expect(name, `${WORKLOAD}: ${name}`).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(name, `${WORKLOAD}: ${name}`).not.toMatch(ENVIRONMENT_SUFFIX);
    }

    const { config } = readWorkerConfig(CONFIG_PATH);
    // The default deployment keeps reading the Secrets Store bindings: merging is a runtime no-op.
    expect(config.vars?.SECRETS_SOURCE).toBe('secrets-store');
    const sts = (config.services ?? []).find(service => service.binding === 'STS');
    expect(sts?.service, WORKLOAD).toBe('sts');
    expect(sts?.entrypoint, WORKLOAD).toBe('SecretsBroker');
    expect(sts?.props?.caller, WORKLOAD).toBe(WORKLOAD);

    const storeEntries = config.secrets_store_secrets ?? [];
    const vars = new Set(Object.keys(config.vars ?? {}));
    const candidates = [
      ...new Set([...policy.secrets, ...storeEntries.map(entry => entry.binding)]),
    ];

    const rows: CopierRow[] = [];
    for (const name of NAMES) {
      const binding = await serving(candidates, name, readKiloOpsSecret);
      expect(vars.has(binding), `${WORKLOAD}: ${name} -> ${binding} is a var, not a secret`).toBe(
        false
      );
      const entry = storeEntries.find(candidate => candidate.binding === binding);
      if (entry === undefined) {
        throw new Error(`${WORKLOAD}: ${name} -> ${binding} is not a Secrets Store binding`);
      }
      // Manifest <-> store name: the entry names the canonical name, never a suffixed alias.
      expect(entry.secret_name, `${WORKLOAD}: ${binding}`).toBe(name);
      rows.push({
        oldBinding: binding,
        storeSecretName: entry.secret_name,
        stsLookup: stsLookup(name),
        policyEntry: name,
      });
    }

    // One-to-one: no two policy entries share a binding, every row is a policy entry, and the
    // manifest holds no production Secrets Store binding the reader does not serve.
    expect(rows.map(row => row.oldBinding).sort(), WORKLOAD).toEqual(
      [...new Set(rows.map(row => row.oldBinding))].sort()
    );
    expect(storeEntries.map(entry => entry.binding).sort(), WORKLOAD).toEqual(
      rows.map(row => row.oldBinding).sort()
    );
    expect(rows, WORKLOAD).toHaveLength(NAMES.length);
    for (const row of rows) {
      expect(policy.secrets, `${WORKLOAD}: ${row.oldBinding}`).toContain(row.policyEntry);
    }
    // The published table itself: derived rows must equal it row for row, so a moved folder, a
    // changed store name or a repointed binding fails here rather than at cutover.
    expect(rows, WORKLOAD).toEqual(EXPECTED_ROWS);

    // The `dev` block binds exactly one dev-only store entry, for the Grafana key — nothing for the
    // Analytics Engine proxy, whose dev deployment runs off, and never a production name.
    const devEntries = config.env?.['dev']?.secrets_store_secrets ?? [];
    expect(
      devEntries
        .map(entry => ({ binding: entry.binding, secret_name: entry.secret_name }))
        .sort((a, b) => a.binding.localeCompare(b.binding)),
      WORKLOAD
    ).toEqual([...EXPECTED_DEV_ENTRIES].sort((a, b) => a.binding.localeCompare(b.binding)));
    for (const entry of devEntries) {
      expect(entry.secret_name, `${WORKLOAD}: dev ${entry.binding}`).toMatch(ENVIRONMENT_SUFFIX);
      expect(
        EXPECTED_ROWS.map(row => row.storeSecretName),
        `${WORKLOAD}: dev ${entry.binding} reads a production secret`
      ).not.toContain(entry.secret_name);
    }
  });
});
