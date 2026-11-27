import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import {
  readCloudAgentNextSecret,
  readCloudAgentNextStoreSecret,
  type CloudAgentNextSecretName,
  type CloudAgentNextSecretsEnv,
  type CloudAgentNextStoreSecretName,
} from '../../../cloud-agent-next/src/secrets';
import { PolicySchema, type Policy } from '../../src/policy/schema';
import { repoRoot, shippedPolicyDocuments } from './repo';
import { parseWorkerConfig } from './worker-configs';

/**
 * The copier table this PR body publishes, proven against the three sources it claims to agree:
 * the shipped policy (its `secrets`), the reader (which binding each family reads today) and the
 * wrangler manifest (which of those bindings is a Secrets Store entry, and under which
 * `secret_name`).
 *
 * A read answers only from the one binding its family holds, so exactly one candidate returns its
 * own sentinel. A name the policy grants and the reader does not serve, or two names sharing one
 * binding, fails here instead of at cutover, where the legacy read keeps working and `sts` answers
 * `not_granted`.
 *
 * `INTERNAL_API_SECRET` has two families in this Worker: the inbound `x-internal-api-key` checks
 * read the plain Worker secret, and outbound BYOC and session calls read the Secrets Store copy
 * `INTERNAL_API_SECRET_PROD`. Both are rows, and both resolve to the one
 * `/shared/INTERNAL_API_SECRET` bundle key after the flip.
 */

const WORKLOAD = 'cloud-agent-next';
const CONFIG_PATH = 'services/cloud-agent-next/wrangler.jsonc';

/**
 * The names STS resolves from `/shared`, the fallback folder of every policy
 * (src/policy/schema.ts `bundleFolder`); every other name resolves from
 * `/workloads/cloud-agent-next`.
 */
const SHARED_NAMES: readonly string[] = ['INTERNAL_API_SECRET', 'NEXTAUTH_SECRET'];

/** No policy secret may carry an environment suffix (src/policy/schema.ts): the folder picks it. */
const ENVIRONMENT_SUFFIX = /_(PROD|PRODUCTION|STAGING|DEV|DEVELOPMENT)$/;

/**
 * The suffix a non-production block's store secret must carry, spelled as
 * `test/repo/worker-configs.ts` `NON_PRODUCTION_SECRET` spells it. The broad suffix above would
 * also accept `_PROD`, which is exactly what this row must reject.
 */
const NON_PRODUCTION_SECRET = /_(DEV|DEVELOPMENT|LOCAL|STAGING|TEST)$/;

/** The reader's own name unions: a name outside them is a type error here, not a runtime failure. */
const NAMES: readonly CloudAgentNextSecretName[] = [
  'INTERNAL_API_SECRET',
  'NEXTAUTH_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_LITE_APP_PRIVATE_KEY',
  'AGENT_ENV_VARS_PRIVATE_KEY',
  'SSEC_KEY',
  'R2_SECRET_ACCESS_KEY',
  'R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY',
];

const STORE_NAMES: readonly CloudAgentNextStoreSecretName[] = ['INTERNAL_API_SECRET'];

/** One row of the copier table: the four columns the PR body publishes. */
type CopierRow = {
  /** The binding the Worker reads today, and the name the copier keeps or retires. */
  oldBinding: string;
  /** The Secrets Store `secret_name` behind that binding, or `—` for a plain Worker secret. */
  storeSecretName: string;
  /** The STS bundle name, which is also the Infisical key in the folder below. */
  stsLookup: string;
  /** The entry services/sts/policy/cloud-agent-next.yaml grants. */
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
const envWith = (binding: string, value: string): CloudAgentNextSecretsEnv =>
  ({ [binding]: value }) as unknown as CloudAgentNextSecretsEnv;

/** The one binding a read answers from; every other candidate makes the read fail closed. */
async function serving<N extends string>(
  candidates: readonly string[],
  name: N,
  read: (env: CloudAgentNextSecretsEnv, name: N) => Promise<string>
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

describe('the secrets copier table for cloud-agent-next', () => {
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
    // The default deployment keeps reading the legacy bindings: merging is a runtime no-op.
    expect(config.vars?.SECRETS_SOURCE).toBe('secrets-store');
    const sts = (config.services ?? []).find(service => service.binding === 'STS');
    expect(sts?.service, WORKLOAD).toBe('sts');
    expect(sts?.entrypoint, WORKLOAD).toBe('SecretsBroker');
    expect(sts?.props?.caller, WORKLOAD).toBe(WORKLOAD);

    const storeEntries = config.secrets_store_secrets ?? [];
    const vars = new Set(Object.keys(config.vars ?? {}));
    // The binding a reader looks up is either a Secrets Store binding in this manifest or a plain
    // Worker secret; both kinds appear among the names, so this candidate set covers it.
    const candidates = [
      ...new Set([...policy.secrets, ...storeEntries.map(entry => entry.binding)]),
    ];

    const rows: CopierRow[] = [];
    for (const name of NAMES) {
      const binding = await serving(candidates, name, readCloudAgentNextSecret);
      // Manifest <-> reader: a plain secret is invisible here, but it may never be a var.
      expect(vars.has(binding), `${WORKLOAD}: ${name} -> ${binding} is a var, not a secret`).toBe(
        false
      );
      expect(
        storeEntries.some(entry => entry.binding === binding),
        `${WORKLOAD}: ${name} -> ${binding} is not the Secrets Store binding of this family`
      ).toBe(false);
      rows.push({
        oldBinding: binding,
        storeSecretName: '—',
        stsLookup: stsLookup(name),
        policyEntry: name,
      });
    }

    for (const name of STORE_NAMES) {
      const binding = await serving(candidates, name, readCloudAgentNextStoreSecret);
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

    // One-to-one: no two rows share a binding, and the manifest holds no production Secrets Store
    // binding the reader does not serve.
    expect(rows.map(row => row.oldBinding).sort(), WORKLOAD).toEqual(
      [...new Set(rows.map(row => row.oldBinding))].sort()
    );
    expect(storeEntries.map(entry => entry.binding).sort(), WORKLOAD).toEqual(
      rows
        .filter(row => row.storeSecretName !== '—')
        .map(row => row.oldBinding)
        .sort()
    );
    expect(rows, WORKLOAD).toHaveLength(NAMES.length + STORE_NAMES.length);
    // Every row is a policy entry the workload's policy grants, in the folder STS reads first.
    for (const row of rows) {
      expect(policy.secrets, `${WORKLOAD}: ${row.oldBinding}`).toContain(row.policyEntry);
      expect(row.stsLookup, `${WORKLOAD}: ${row.oldBinding}`).toBe(stsLookup(row.policyEntry));
    }

    // The `dev` block reads only non-production store secrets: a config that binds STS may not
    // read a production-named secret from a non-production block (worker-configs.ts).
    for (const entry of config.env?.['dev']?.secrets_store_secrets ?? []) {
      expect(entry.secret_name, `${WORKLOAD}: dev ${entry.binding}`).toMatch(NON_PRODUCTION_SECRET);
    }
  });
});

/** The bundle key STS reads, as src/policy/schema.ts `bundleFolder` places it. */
function stsLookup(name: string): string {
  return SHARED_NAMES.includes(name) ? `/shared/${name}` : `/workloads/${WORKLOAD}/${name}`;
}
