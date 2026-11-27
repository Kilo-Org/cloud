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

/**
 * The names STS resolves from `/shared`, the fallback folder of every policy
 * (src/policy/schema.ts `bundleFolder`); every other name resolves from `/workloads/kilo-ops`.
 */
const SHARED_NAMES: readonly string[] = ['O11Y_CF_AE_API_TOKEN'];

/** No policy secret may carry an environment suffix (src/policy/schema.ts): the folder picks it. */
const ENVIRONMENT_SUFFIX = /_(PROD|PRODUCTION|STAGING|DEV|DEVELOPMENT)$/;

/** The reader's own name union: a name outside it is a type error here, not a runtime failure. */
const NAMES: readonly KiloOpsSecretName[] = ['O11Y_CF_AE_API_TOKEN', 'GF_SECRET_KEY'];

/**
 * The store names the `dev` block reads. Two new entries have to exist in the account's Secrets
 * Store before `wrangler deploy --env dev` works, and neither may hold a production value: a config
 * that binds STS may not read a production-named store secret from a non-production block
 * (worker-configs.ts).
 */
const DEV_STORE_NAMES: readonly string[] = ['O11Y_CF_AE_API_TOKEN_DEV', 'GF_SECRET_KEY_DEV'];

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
 * Reads a config with Wrangler's own JSON, JSONC and TOML parser, the one a deploy uses. It lives
 * in this test file because wrangler's published types re-export from `@cloudflare/workers-utils`,
 * which wrangler does not ship, so type-aware lint sees the function as `error` typed everywhere
 * but `*.test.ts`.
 */
const readWorkerConfig = (path: string) =>
  parseWorkerConfig(path, experimental_readRawConfig({ config: join(repoRoot, path) }).rawConfig);

function shippedPolicy(workload: string): Policy {
  const found = shippedPolicyDocuments()
    .map(({ document }) => PolicySchema.parse(document))
    .find(policy => policy.workload === workload);
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

/** The bundle key STS reads, as src/policy/schema.ts `bundleFolder` places it. */
function stsLookup(name: string): string {
  return SHARED_NAMES.includes(name) ? `/shared/${name}` : `/workloads/${WORKLOAD}/${name}`;
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
      // Manifest <-> store name: the entry names the canonical name or its `_PROD` alias.
      expect([name, `${name}_PROD`], `${WORKLOAD}: ${binding}`).toContain(entry.secret_name);
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
      expect(row.stsLookup, `${WORKLOAD}: ${row.oldBinding}`).toBe(stsLookup(row.policyEntry));
    }

    // The `dev` block reads two new dev-only store entries, never a production copy.
    const devEntries = config.env?.['dev']?.secrets_store_secrets ?? [];
    expect(devEntries.map(entry => entry.secret_name).sort(), WORKLOAD).toEqual(
      [...DEV_STORE_NAMES].sort()
    );
    for (const entry of devEntries) {
      expect(entry.secret_name, `${WORKLOAD}: dev ${entry.binding}`).toMatch(ENVIRONMENT_SUFFIX);
      expect(
        rows.map(row => row.storeSecretName),
        `${WORKLOAD}: dev ${entry.binding} reads a production secret`
      ).not.toContain(entry.secret_name);
    }
  });
});
