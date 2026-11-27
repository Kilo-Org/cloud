import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import { readGitTokenServiceSecret } from '../../../git-token-service/src/secrets';
import { readKiloChatSecret } from '../../../kilo-chat/src/secrets';
import { readSecurityAutoAnalysisSecret } from '../../../security-auto-analysis/src/secrets';
import { readSessionIngestSecret } from '../../../session-ingest/src/secrets';
import { PolicySchema, type Policy } from '../../src/policy/schema';
import { repoRoot, SHARED_SECRET_NAMES, shippedPolicyDocuments } from './repo';
import { parseWorkerConfig } from './worker-configs';

/**
 * The names whose value is one value across Workloads, and so live in `/shared`
 * (`SHARED_SECRET_NAMES` in ./repo.ts); every other name resolves from the Worker's own
 * `/workloads/<workload>` folder (src/policy/schema.ts `bundleFolder`).
 */
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

type WorkerUnderTest<N extends string> = {
  workload: string;
  configPath: string;
  /** The reader's own name union; a name outside it is a type error here, not a runtime failure. */
  names: readonly N[];
  read: (env: Record<string, string>, name: N) => Promise<string>;
  /**
   * Production Secrets Store bindings that hold an identifier rather than a credential (a key id,
   * a public key). They are config-like reads left on `env` by design, so the reader never maps
   * them and the table does not carry them.
   */
  identifierStoreBindings?: readonly string[];
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
async function proveWorker<N extends string>(worker: WorkerUnderTest<N>): Promise<CopierRow[]> {
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
  const vars = Object.keys(config.vars ?? {});
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

    // A credential is never a var: a var is plaintext in the manifest and no reader maps it.
    expect(vars, `${worker.workload}: ${name}`).not.toContain(binding);
    const entry = storeEntries.find(candidate => candidate.binding === binding);
    rows.push({
      workload: worker.workload,
      oldBinding: binding,
      storeSecretName: entry?.secret_name ?? '—',
      stsLookup: SHARED_SECRET_NAMES.includes(name)
        ? `/shared/${name}`
        : `/workloads/${worker.workload}/${name}`,
      policyEntry: name,
    });
  }

  // One-to-one: no two policy entries share a binding, and every production Secrets Store binding
  // is either a row of this table or a declared identifier read.
  expect(new Set(rows.map(row => row.oldBinding)).size, worker.workload).toBe(rows.length);
  const identifierBindings = worker.identifierStoreBindings ?? [];
  for (const entry of storeEntries) {
    expect(
      [...rows.map(row => row.oldBinding), ...identifierBindings],
      `${worker.workload}: ${entry.binding}`
    ).toContain(entry.binding);
  }
  for (const binding of identifierBindings) {
    expect(
      rows.map(row => row.oldBinding),
      `${worker.workload}: ${binding}`
    ).not.toContain(binding);
    expect(
      storeEntries.map(entry => entry.binding),
      `${worker.workload}: ${binding}`
    ).toContain(binding);
  }
  return rows;
}

describe('the secrets copier table for batch D', () => {
  it('maps every policy secret to one binding and one store name in its wrangler manifest', async () => {
    const securityAutoAnalysis = await proveWorker({
      workload: 'security-auto-analysis',
      configPath: 'services/security-auto-analysis/wrangler.jsonc',
      names: ['INTERNAL_API_SECRET', 'CALLBACK_TOKEN_SECRET', 'NEXTAUTH_SECRET'],
      read: readSecurityAutoAnalysisSecret,
    });
    const sessionIngest = await proveWorker({
      workload: 'session-ingest',
      configPath: 'services/session-ingest/wrangler.jsonc',
      names: ['NEXTAUTH_SECRET', 'INTERNAL_API_SECRET', 'SESSION_SHARE_JWT_SECRET'],
      read: readSessionIngestSecret,
    });
    const kiloChat = await proveWorker({
      workload: 'kilo-chat',
      configPath: 'services/kilo-chat/wrangler.jsonc',
      names: [
        'NEXTAUTH_SECRET',
        'GATEWAY_TOKEN_SECRET',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'INTERNAL_API_SECRET',
      ],
      read: readKiloChatSecret,
    });
    const gitTokenService = await proveWorker({
      workload: 'git-token-service',
      configPath: 'services/git-token-service/wrangler.jsonc',
      names: [
        'NEXTAUTH_SECRET',
        'SCM_SESSION_CAPABILITY_ENCRYPTION_KEY',
        'BITBUCKET_CLIENT_ID',
        'BITBUCKET_CLIENT_SECRET',
        'GITHUB_APP_PRIVATE_KEY',
        'GITHUB_LITE_APP_PRIVATE_KEY',
        'GITHUB_APP_CLIENT_SECRET',
        'GITLAB_CLIENT_SECRET',
        'BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY',
        'USER_GITHUB_APP_TOKEN_ACTIVE_PRIVATE_KEY',
      ],
      read: readGitTokenServiceSecret,
      // A key id names a credential, it is not one; services/sts/policy/git-token-service.yaml
      // lists it with the other public identifiers that stay on `env`.
      identifierStoreBindings: ['BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID'],
    });

    const rows = [...securityAutoAnalysis, ...sessionIngest, ...kiloChat, ...gitTokenService];

    // No two rows name the same Worker binding, and every row is a policy entry the workload's
    // policy grants under the canonical name its STS folder resolves.
    expect(rows.map(row => `${row.workload}|${row.oldBinding}`)).toEqual([
      ...new Set(rows.map(row => `${row.workload}|${row.oldBinding}`)),
    ]);
    expect(rows).toHaveLength(3 + 3 + 5 + 10);
    const policies = shippedPolicies();
    for (const row of rows) {
      expect(policies.get(row.workload)?.secrets, row.workload).toContain(row.policyEntry);
    }
  });
});
