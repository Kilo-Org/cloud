import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import { z } from 'zod';
import { PolicySchema } from '../../src/policy/schema';
import { repoRoot, shippedPolicyDocuments } from './repo';
import {
  AUDIT_RELAY_DEPLOYMENTS,
  CLASSIFIED_KEYS,
  type WorkerConfig,
  deployConfigEntries,
  internalWorkerProblems,
  stsVarProblems,
  parseWorkerConfig,
  trackedPaths,
  workerBindingPolicyProblems,
  workerConfigPaths,
  workerConfigProblems,
} from './worker-configs';

/**
 * Reads a config with Wrangler's own JSON, JSONC and TOML parser, the one a deploy uses. It lives
 * in this test file because wrangler's published types re-export from `@cloudflare/workers-utils`,
 * which wrangler does not ship, so type-aware lint sees the function as `error` typed everywhere
 * but `*.test.ts`.
 */
const readWorkerConfig = (root: string, path: string) =>
  parseWorkerConfig(path, experimental_readRawConfig({ config: join(root, path) }).rawConfig);

const ALL_ENVIRONMENTS = ['development', 'staging', 'production'];
const PATH = 'services/consumer/wrangler.jsonc';

const shippedPolicies = () =>
  shippedPolicyDocuments().map(({ document }) => PolicySchema.parse(document));

const repoConfigs = () => workerConfigPaths(repoRoot).map(path => readWorkerConfig(repoRoot, path));

const workerBindingPolicy = (workload: string, environments = ALL_ENVIRONMENTS) =>
  PolicySchema.parse({ workload, environments, identity: { kind: 'worker-binding' }, secrets: [] });

/** Every block of a secret-holding fixture inherits this unless it sets its own. */
const NO_TRACES = { observability: { enabled: true, traces: { enabled: false } } };

const consumer = (raw: Record<string, unknown>, path = PATH) =>
  parseWorkerConfig(path, { name: 'consumer', ...NO_TRACES, ...raw });

const stsFixture = () =>
  parseWorkerConfig('services/sts/wrangler.jsonc', {
    name: 'sts',
    ...NO_TRACES,
    vars: { STS_ENVIRONMENT: 'production' },
    queues: { producers: [{ binding: 'AUDIT_QUEUE', queue: 'kilo-audit' }] },
    env: {
      staging: {
        name: 'sts-staging',
        vars: { STS_ENVIRONMENT: 'staging' },
        queues: { producers: [{ binding: 'AUDIT_QUEUE', queue: 'kilo-audit-staging' }] },
      },
      local: {
        name: 'sts-local',
        vars: { STS_ENVIRONMENT: 'development' },
        queues: { producers: [{ binding: 'AUDIT_QUEUE', queue: 'kilo-audit-local' }] },
      },
    },
  });

const stsBinding = (service: string, extra: Record<string, unknown> = {}) => ({
  binding: 'STS',
  service,
  entrypoint: 'SecretsBroker',
  props: { caller: 'consumer' },
  ...extra,
});

const problemsOf = (...configs: WorkerConfig[]) =>
  workerConfigProblems(configs, [workerBindingPolicy('consumer')]);

describe('repository Worker configs', () => {
  it('lists every config a deploy can read, test fixtures included', () => {
    const paths = workerConfigPaths(repoRoot);
    expect(paths).toContain('services/sts/wrangler.jsonc');
    expect(paths).toContain('services/o11y/wrangler.jsonc');
    expect(paths).toContain('services/sts/wrangler.test.jsonc');
    // cloud-agent-e2e-deploy.yml deploys this one to the account.
    expect(paths).toContain('services/cloud-agent-next/test/e2e/wrangler.fake-llm.jsonc');
    expect(paths.filter(path => path.includes('node_modules/'))).toEqual([]);
  });

  it('keep every nested Worker config under test/fixtures, out of the production deploy', () => {
    // deploy-workers.yml deploys every directory holding a wrangler.jsonc that this find lists, and
    // runs Wrangler there with no --config.
    const workflow = readFileSync(join(repoRoot, '.github/workflows/deploy-workers.yml'), 'utf8');
    const discovery = workflow
      .split('\n')
      .filter(line => line.includes('find services -name "wrangler.jsonc"'));
    expect(discovery).toHaveLength(1);
    expect(discovery[0]).toContain('-not -path "*/node_modules/*"');
    expect(discovery[0]).toContain('-not -path "*/test/fixtures/*"');

    const entries = deployConfigEntries(repoRoot);
    const paths = entries.map(entry => entry.path);
    // Wrangler takes a wrangler.json in the service directory or any parent before the service's
    // own wrangler.jsonc, so one there, in services/ or at the root replaces the config checked here.
    expect(paths.filter(path => /^(services\/([^/]+\/)?)?wrangler\.json$/.test(path))).toEqual([]);
    // The find lists a directory named wrangler.jsonc as a Worker to deploy.
    expect(entries.filter(entry => entry.directory).map(entry => entry.path)).toEqual([]);
    // wrangler deploy follows a .wrangler/deploy/config.json there to the config it names, through
    // a symlinked .wrangler or deploy directory too, so nothing under .wrangler there is tracked.
    // A local build writes an ignored, untracked redirect, so this one reads tracked files only.
    expect(
      trackedPaths(repoRoot).filter(path => /^(services\/([^/]+\/)?)?\.wrangler(\/|$)/.test(path))
    ).toEqual([]);

    // Only a service's own top-level config is a Worker to deploy; any other wrangler.jsonc under
    // services/, a broken symlink included, must sit where that find skips it.
    const nested = paths.filter(
      path => path.endsWith('/wrangler.jsonc') && !/^services\/[^/]+\/wrangler\.jsonc$/.test(path)
    );
    expect(nested).toContain('services/sts/test/fixtures/runtime/wrangler.jsonc');
    expect(nested.filter(path => !/^services\/[^/]+\/test\/fixtures\//.test(path))).toEqual([]);
  });

  it('reach STS only through SecretsBroker as their own Worker, and never reach the relay', () => {
    expect(workerConfigProblems(repoConfigs(), shippedPolicies())).toEqual([]);
  });

  it('agree with the deployment lists the check relies on', () => {
    expect(internalWorkerProblems(repoConfigs())).toEqual([]);
  });

  it('set every var STS reads in each STS deployment, with the issuer verifiers expect', () => {
    expect(stsVarProblems(repoConfigs())).toEqual([]);
  });

  it('bind STS as every worker-binding policy, unless its Worker is listed as external', () => {
    expect(workerBindingPolicyProblems(repoConfigs(), shippedPolicies())).toEqual([]);
  });
});

describe("Wrangler's config schema", () => {
  const schemaPath = join(
    dirname(createRequire(import.meta.url).resolve('wrangler/package.json')),
    'config-schema.json'
  );
  const schema: unknown = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const NodeSchema = z.record(z.string(), z.unknown());
  const at = (...path: string[]) =>
    path.reduce<unknown>((node, key) => NodeSchema.parse(node)[key], schema);
  const keysOf = (node: unknown) =>
    Object.keys(z.object({ properties: NodeSchema }).parse(node).properties);
  const definition = (name: string) => at('definitions', name);
  const environment = (...path: string[]) =>
    at('definitions', 'RawEnvironment', 'properties', ...path);
  const wranglerKeys: Record<string, string[]> = {
    environment: keysOf(definition('RawEnvironment')),
    topLevel: keysOf(definition('RawConfig')),
    previews: keysOf(definition('PreviewsConfig')),
    'services[]': keysOf(environment('services', 'items')),
    'durable_objects.bindings[]': keysOf(at('definitions', 'DurableObjectBindings', 'items')),
    queues: keysOf(environment('queues')),
    'queues.producers[]': keysOf(environment('queues', 'properties', 'producers', 'items')),
    'queues.consumers[]': keysOf(environment('queues', 'properties', 'consumers', 'items')),
    'r2_buckets[]': keysOf(environment('r2_buckets', 'items')),
    'workflows[]': keysOf(definition('WorkflowBinding')),
    'tail_consumers[]': keysOf(definition('TailConsumer')),
    'streaming_tail_consumers[]': keysOf(definition('StreamingTailConsumer')),
    'dispatch_namespaces[]': keysOf(environment('dispatch_namespaces', 'items')),
    'dispatch_namespaces[].outbound': keysOf(definition('DispatchNamespaceOutbound')),
    'routes[]': ['CustomDomainRoute', 'ZoneIdRoute', 'ZoneNameRoute'].flatMap(name =>
      keysOf(definition(name))
    ),
    'migrations[]': keysOf(definition('DurableObjectMigration')),
    'migrations[].transferred_classes[]': keysOf(
      at('definitions', 'DurableObjectMigration', 'properties', 'transferred_classes', 'items')
    ),
    'exports.*': [
      ...z
        .array(z.unknown())
        .parse(at('definitions', 'DurableObjectExport', 'anyOf'))
        .flatMap(keysOf),
      ...keysOf(definition('WorkerEntrypointExport')),
    ],
    'secrets_store_secrets[]': keysOf(environment('secrets_store_secrets', 'items')),
    'hyperdrive[]': keysOf(environment('hyperdrive', 'items')),
  };

  it('has no key the check leaves unclassified, at any level the check models', () => {
    expect(Object.keys(CLASSIFIED_KEYS).sort()).toEqual(Object.keys(wranglerKeys).sort());
    for (const [level, keys] of Object.entries(wranglerKeys)) {
      expect(
        keys.filter(key => !(CLASSIFIED_KEYS[level] ?? []).includes(key)),
        level
      ).toEqual([]);
    }
  });
});

describe('reading a Worker config', () => {
  it('reads TOML with the parser a deploy uses, every env block included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sts-worker-config-'));
    try {
      writeFileSync(
        join(dir, 'wrangler.toml'),
        [
          'name = "consumer"',
          '[[services]]',
          'binding = "STS"',
          'service = "sts"',
          'entrypoint = "SecretsBroker"',
          'props = { caller = "consumer" }',
          '[observability.traces]',
          'enabled = false',
          '[[env.staging.durable_objects.bindings]]',
          'name = "SIGNER"',
          'class_name = "SignerDO"',
          'script_name = "sts-staging"',
        ].join('\n')
      );
      expect(problemsOf(readWorkerConfig(dir, 'wrangler.toml'))).toEqual([
        'wrangler.toml (env.staging): SIGNER binds Durable Object class SignerDO of sts-staging; its Durable Objects are internal',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('worker config rules', () => {
  it('accepts a consumer that binds the STS deployment of each environment', () => {
    const config = consumer({
      services: [stsBinding('sts')],
      durable_objects: { bindings: [{ name: 'OWN', class_name: 'OwnDO' }] },
      env: {
        staging: { services: [stsBinding('sts-staging')] },
        local: { name: 'consumer-local', services: [stsBinding('sts-local')] },
        preview: { name: 'consumer-preview', services: [] },
      },
    });
    expect(problemsOf(config)).toEqual([]);
  });

  it('refuses a Durable Object binding into any STS or audit-relay deployment', () => {
    const internal = ['sts', 'sts-staging', 'sts-local', ...AUDIT_RELAY_DEPLOYMENTS];
    const config = consumer({
      durable_objects: {
        bindings: internal.map(script => ({
          name: 'SIGNER',
          class_name: 'SignerDO',
          script_name: script,
        })),
      },
    });
    expect(problemsOf(config)).toEqual(
      internal.map(
        script =>
          `${PATH} (top level): SIGNER binds Durable Object class SignerDO of ${script}; its Durable Objects are internal`
      )
    );
  });

  it("refuses a config outside services/sts that binds one of STS's own classes", () => {
    const config = consumer({
      durable_objects: {
        bindings: [
          { name: 'TOKENS', class_name: 'TokenSignerDO' },
          { name: 'SIGNER', class_name: 'SignerDO' },
        ],
      },
    });
    expect(problemsOf(config)).toEqual([
      `${PATH} (top level): TOKENS binds Durable Object class TokenSignerDO, which only STS defines and binds`,
    ]);
    const own = parseWorkerConfig('services/sts/test/fixtures/x/wrangler.jsonc', {
      name: 'secrets-broker-x-test',
      ...NO_TRACES,
      durable_objects: { bindings: [{ name: 'TOKENS', class_name: 'TokenSignerDO' }] },
    });
    expect(problemsOf(own)).toEqual([]);
  });

  it('refuses an STS block whose vars readConfig would refuse or whose issuer differs', () => {
    const vars = {
      STS_ENVIRONMENT: 'staging',
      STS_ISSUER: 'https://sts-staging.kiloapps.io',
      MANAGER_BASE_URL: 'https://eu.infisical.com',
      MANAGER_PROJECT_ID: 'project',
      MANAGER_PROJECT_SLUG: '',
      MANAGER_ENVIRONMENT_SLUG: 'staging',
      MANAGER_IDENTITY_ID: 'identity',
      DO_JURISDICTION: 'eu',
      TOKEN_SIGNING_KIDS_REVOKED: '',
      MIGRATION_PROXY_AUDIENCE: '',
      CF_DEPLOY_ACCOUNT_ID: '',
      LEASE_REPLICA_SWEEP_BINDINGS: '',
    };
    const sts = (blockVars: Record<string, string>) =>
      parseWorkerConfig('services/sts/wrangler.jsonc', { name: 'sts', vars: blockVars });
    expect(stsVarProblems([sts(vars)])).toEqual([]);
    expect(stsVarProblems([sts({ ...vars, TOKEN_SIGNING_KIDS_REVOKED: 'a'.repeat(43) })])).toEqual(
      []
    );
    const { TOKEN_SIGNING_KIDS_REVOKED: _omitted, ...withoutKids } = vars;
    expect(stsVarProblems([sts(withoutKids)])).toEqual([
      expect.stringContaining('TOKEN_SIGNING_KIDS_REVOKED'),
    ]);
    expect(stsVarProblems([sts({ ...vars, TOKEN_SIGNING_KIDS_REVOKED: 'not-a-kid' })])).toEqual([
      expect.stringContaining('vars do not pass EnvVarsSchema'),
    ]);
    expect(
      stsVarProblems([
        sts({
          ...vars,
          MANAGER_PROJECT_SLUG: 'kilo-project',
          MIGRATION_PROXY_AUDIENCE: 'https://migration-proxy-staging.kiloapps.io',
          CF_DEPLOY_ACCOUNT_ID: 'e115e769bcdd4c3d66af59d3332cb394',
        }),
      ])
    ).toEqual([]);
    for (const bad of [
      { MANAGER_PROJECT_SLUG: 'Kilo Project' },
      { MIGRATION_PROXY_AUDIENCE: 'http://migration-proxy-staging.kiloapps.io' },
      { MIGRATION_PROXY_AUDIENCE: 'migration-proxy-staging' },
      { CF_DEPLOY_ACCOUNT_ID: 'cfat_not-an-account-id' },
      { LEASE_REPLICA_SWEEP_BINDINGS: 'REPLICA' },
      { LEASE_REPLICA_SWEEP_BINDINGS: 'LEASE_SWEEP_A,LEASE_SWEEP_A' },
    ]) {
      expect(stsVarProblems([sts({ ...vars, ...bad })]), JSON.stringify(bad)).toEqual([
        expect.stringContaining('vars do not pass EnvVarsSchema'),
      ]);
    }
    expect(stsVarProblems([sts({ ...vars, STS_ISSUER: 'https://sts.kiloapps.io' })])).toEqual([
      'services/sts/wrangler.jsonc (top level): STS_ISSUER is https://sts.kiloapps.io, expected https://sts-staging.kiloapps.io',
    ]);
  });

  it('refuses an STS block that sweeps a replica it has no Hyperdrive binding for', () => {
    const vars = {
      STS_ENVIRONMENT: 'staging',
      STS_ISSUER: 'https://sts-staging.kiloapps.io',
      MANAGER_BASE_URL: 'https://eu.infisical.com',
      MANAGER_PROJECT_ID: 'project',
      MANAGER_PROJECT_SLUG: '',
      MANAGER_ENVIRONMENT_SLUG: 'staging',
      MANAGER_IDENTITY_ID: 'identity',
      DO_JURISDICTION: 'eu',
      TOKEN_SIGNING_KIDS_REVOKED: '',
      MIGRATION_PROXY_AUDIENCE: '',
      CF_DEPLOY_ACCOUNT_ID: '',
      LEASE_REPLICA_SWEEP_BINDINGS: 'LEASE_SWEEP_EU_WEST, LEASE_SWEEP_EU_NORTH',
    };
    const sts = (hyperdrive: string[]) =>
      parseWorkerConfig('services/sts/wrangler.jsonc', {
        name: 'sts',
        vars,
        hyperdrive: hyperdrive.map(binding => ({ binding, id: `${binding.toLowerCase()}-id` })),
      });
    expect(stsVarProblems([sts(['LEASE_SWEEP_EU_WEST', 'LEASE_SWEEP_EU_NORTH'])])).toEqual([]);
    expect(stsVarProblems([sts(['LEASE_SWEEP_EU_WEST'])])).toEqual([
      'services/sts/wrangler.jsonc (top level): LEASE_REPLICA_SWEEP_BINDINGS names LEASE_SWEEP_EU_NORTH, which is no Hyperdrive binding of this block',
    ]);
  });

  it('refuses an STS binding at any entrypoint other than SecretsBroker', () => {
    expect(
      problemsOf(
        consumer({
          services: [
            stsBinding('sts', { entrypoint: undefined }),
            stsBinding('sts', { entrypoint: 'BundleRpc' }),
          ],
        })
      )
    ).toEqual([
      `${PATH} (top level): STS binds sts at entrypoint (default); only SecretsBroker is public`,
      `${PATH} (top level): STS binds sts at entrypoint BundleRpc; only SecretsBroker is public`,
    ]);
  });

  it('refuses every service binding to the audit relay', () => {
    const config = consumer({
      services: [{ binding: 'RELAY', service: 'audit-relay', entrypoint: 'SecretsBroker' }],
      env: { staging: { services: [{ binding: 'RELAY', service: 'audit-relay-staging' }] } },
    });
    expect(problemsOf(config)).toEqual([
      `${PATH} (top level): RELAY binds audit-relay; no Worker binds the audit relay`,
      `${PATH} (env.staging): RELAY binds audit-relay-staging; no Worker binds the audit relay`,
    ]);
  });

  it('pins production to sts and every other env block to sts-<env>', () => {
    const config = consumer({
      services: [stsBinding('sts-staging')],
      env: {
        staging: { services: [stsBinding('sts')] },
        dev: { services: [stsBinding('sts-dev')] },
        preview: { services: [stsBinding('sts-local')] },
      },
    });
    expect(problemsOf(config)).toEqual([
      `${PATH} (top level): STS binds sts-staging; this block must bind sts`,
      `${PATH} (env.staging): STS binds sts; this block must bind sts-staging`,
      `${PATH} (env.dev): STS does not deploy sts-dev, so env dev cannot bind it`,
      `${PATH} (env.preview): STS binds sts-local; this block must bind sts-preview`,
      `${PATH} (env.preview): STS does not deploy sts-preview, so env preview cannot bind it`,
    ]);
  });

  it('refuses a service environment on an STS binding', () => {
    expect(
      problemsOf(consumer({ services: [stsBinding('sts', { environment: 'staging' })] }))
    ).toEqual([
      `${PATH} (top level): STS names service environment staging; bind the deployed name sts`,
    ]);
  });

  it('requires props.caller to be the top-level name in every env block', () => {
    const config = consumer({
      services: [stsBinding('sts', { props: {} })],
      env: { staging: { services: [stsBinding('sts-staging', { props: { caller: 'o11y' } })] } },
    });
    expect(problemsOf(config)).toEqual([
      `${PATH} (top level): STS sets props.caller undefined; expected the top-level name consumer`,
      `${PATH} (env.staging): STS sets props.caller "o11y"; expected the top-level name consumer`,
    ]);
  });

  it('requires every env block of a config that binds STS to deploy as <name>-<env>', () => {
    const config = consumer({
      services: [stsBinding('sts')],
      env: {
        staging: { name: 'o11y-staging', services: [stsBinding('sts-staging')] },
        local: { name: 'consumer', services: [stsBinding('sts-local')] },
        preview: { name: 'o11y' },
      },
    });
    expect(problemsOf(config)).toEqual([
      `${PATH} (env.staging) deploys as o11y-staging; a config that binds STS as consumer names it consumer-staging or leaves it out`,
      `${PATH} (env.local) deploys as consumer; a config that binds STS as consumer names it consumer-local or leaves it out`,
      `${PATH} (env.preview) deploys as o11y; a config that binds STS as consumer names it consumer-preview or leaves it out`,
    ]);
    expect(problemsOf(consumer({ env: { staging: { name: 'other-staging' } } }))).toEqual([]);
  });

  it('requires top-level names to be unique across the repository', () => {
    const other = 'services/copy/wrangler.jsonc';
    expect(problemsOf(consumer({}), consumer({}, other))).toEqual([
      `top-level name consumer is shared by ${PATH}, ${other}`,
    ]);
  });

  it('refuses a config that binds STS without a top-level name', () => {
    const nameless = parseWorkerConfig(PATH, { ...NO_TRACES, services: [stsBinding('sts')] });
    expect(problemsOf(nameless)).toEqual([
      `${PATH} (top level): a config with no top-level name binds STS`,
    ]);
  });

  it('requires a worker-binding policy that lists the environment the binding reaches', () => {
    const config = consumer({
      services: [stsBinding('sts')],
      env: { staging: { services: [stsBinding('sts-staging')] } },
    });
    const fly = PolicySchema.parse({
      workload: 'consumer',
      environments: ALL_ENVIRONMENTS,
      identity: { kind: 'fly-oidc', org: 'kilo', orgId: '10', app: 'consumer', appId: '20' },
      secrets: [],
    });
    expect(workerConfigProblems([config], [])).toEqual([
      `${PATH} (top level): caller consumer has no worker-binding policy`,
      `${PATH} (env.staging): caller consumer has no worker-binding policy`,
    ]);
    expect(workerConfigProblems([config], [fly])).toEqual([
      `${PATH} (top level): caller consumer has no worker-binding policy`,
      `${PATH} (env.staging): caller consumer has no worker-binding policy`,
    ]);
    expect(
      workerConfigProblems([config], [workerBindingPolicy('consumer', ['production'])])
    ).toEqual([
      `${PATH} (env.staging): policy consumer does not list staging, which sts-staging serves`,
    ]);
  });

  it('accepts the audit relay as it binds STS, its queues and its archive in every environment', () => {
    const relayBinding = (service: string) => ({
      binding: 'STS',
      service,
      entrypoint: 'SecretsBroker',
      props: { caller: 'audit-relay' },
    });
    const ownObjects = {
      bindings: [
        { name: 'AUDIT_STREAM', class_name: 'StreamDO' },
        { name: 'AUDIT_SIGNER', class_name: 'SignerDO' },
      ],
    };
    const relayQueues = (queue: string) => ({
      consumers: [{ queue, dead_letter_queue: `${queue}-dlq` }, { queue: `${queue}-dlq` }],
    });
    const archive = (bucket_name: string, jurisdiction?: string) => [
      { binding: 'AUDIT_ARCHIVE', bucket_name, ...(jurisdiction ? { jurisdiction } : {}) },
    ];
    const relay = parseWorkerConfig('services/audit-relay/wrangler.jsonc', {
      name: 'audit-relay',
      ...NO_TRACES,
      triggers: { crons: ['0 * * * *'] },
      durable_objects: ownObjects,
      queues: relayQueues('kilo-audit'),
      r2_buckets: archive('kilo-audit-archive', 'eu'),
      services: [relayBinding('sts')],
      env: {
        staging: {
          name: 'audit-relay-staging',
          triggers: { crons: ['0 * * * *'] },
          durable_objects: ownObjects,
          queues: relayQueues('kilo-audit-staging'),
          r2_buckets: archive('kilo-audit-archive-staging', 'eu'),
          services: [relayBinding('sts-staging')],
        },
        local: {
          name: 'audit-relay-local',
          triggers: { crons: [] },
          durable_objects: ownObjects,
          queues: relayQueues('kilo-audit-local'),
          r2_buckets: archive('kilo-audit-archive-local'),
          services: [relayBinding('sts-local')],
        },
      },
    });
    const relayTest = parseWorkerConfig('services/audit-relay/wrangler.test.jsonc', {
      name: 'audit-relay-test',
      durable_objects: ownObjects,
      r2_buckets: archive('kilo-audit-archive-test'),
    });
    const configs = [stsFixture(), relay, relayTest];
    expect(workerConfigProblems(configs, shippedPolicies())).toEqual([]);
    expect(internalWorkerProblems(configs)).toEqual([]);
  });

  it('refuses a producer on an audit queue outside the STS deployment of that environment', () => {
    const audit = (queue: string) => ({ producers: [{ binding: 'AUDIT', queue }] });
    const foreign = consumer({
      queues: {
        producers: [
          { binding: 'AUDIT', queue: 'kilo-audit' },
          { binding: 'JOBS', queue: 'jobs' },
        ],
      },
      env: {
        staging: { queues: audit('kilo-audit-staging') },
        local: { queues: audit('kilo-audit-local-dlq') },
      },
    });
    const crossed = parseWorkerConfig('services/sts/wrangler.jsonc', {
      name: 'sts',
      ...NO_TRACES,
      queues: audit('kilo-audit-staging'),
      env: { local: { name: 'sts-local', queues: audit('kilo-audit-local') } },
    });
    const relay = parseWorkerConfig('services/audit-relay/wrangler.jsonc', {
      name: 'audit-relay',
      ...NO_TRACES,
      queues: audit('kilo-audit'),
    });
    expect(problemsOf(foreign, crossed, relay)).toEqual([
      `${PATH} (top level): AUDIT produces to kilo-audit; only sts may`,
      `${PATH} (env.staging): AUDIT produces to kilo-audit-staging; only sts-staging may`,
      `${PATH} (env.local): AUDIT produces to kilo-audit-local-dlq; no Worker may`,
      'services/sts/wrangler.jsonc (top level): AUDIT produces to kilo-audit-staging; only sts-staging may',
      'services/audit-relay/wrangler.jsonc (top level): AUDIT produces to kilo-audit; only sts may',
    ]);
  });

  it('refuses a consumer or dead-letter target on an audit queue outside the relay', () => {
    const foreign = consumer({
      queues: {
        consumers: [{ queue: 'kilo-audit' }, { queue: 'jobs', dead_letter_queue: 'kilo-audit' }],
      },
    });
    const crossed = parseWorkerConfig('services/audit-relay/wrangler.jsonc', {
      name: 'audit-relay',
      ...NO_TRACES,
      queues: {
        consumers: [{ queue: 'kilo-audit-staging', dead_letter_queue: 'kilo-audit-staging-dlq' }],
      },
    });
    expect(problemsOf(foreign, crossed)).toEqual([
      `${PATH} (top level) consumes kilo-audit; only audit-relay may`,
      `${PATH} (top level) dead-letters jobs into kilo-audit; no Worker may`,
      'services/audit-relay/wrangler.jsonc (top level) consumes kilo-audit-staging; only audit-relay-staging may',
      'services/audit-relay/wrangler.jsonc (top level) dead-letters kilo-audit-staging into kilo-audit-staging-dlq; only audit-relay-staging may',
    ]);
  });

  it('refuses another config deploying under an STS or relay name', () => {
    const config = consumer({
      env: {
        x: { name: 'sts', queues: { producers: [{ binding: 'AUDIT', queue: 'kilo-audit' }] } },
        y: { name: 'audit-relay-local' },
        z: { name: 'sts-test' },
      },
    });
    expect(problemsOf(config)).toEqual([
      `${PATH} (env.x) deploys as sts, which only the sts config deploys`,
      `${PATH} (env.y) deploys as audit-relay-local, which only the audit-relay config deploys`,
      `${PATH} (env.z) deploys as sts-test, which only the sts-test config deploys`,
    ]);
  });

  it('refuses a config deploying under the name of a workload whose config lives elsewhere', () => {
    const impostor = parseWorkerConfig('services/impostor/wrangler.jsonc', {
      name: 'bouncer-watch',
      ...NO_TRACES,
      services: [stsBinding('sts', { props: { caller: 'bouncer-watch' } })],
    });
    const renamed = consumer({ env: { x: { name: 'bouncer-watch' } } });
    const policies = [
      workerBindingPolicy('consumer'),
      workerBindingPolicy('bouncer-watch', ['production']),
    ];
    expect(workerConfigProblems([impostor, renamed], policies)).toEqual([
      'services/impostor/wrangler.jsonc (top level) deploys as bouncer-watch, whose config lives in Kilo-Org/bouncer',
      `${PATH} (env.x) deploys as bouncer-watch, whose config lives in Kilo-Org/bouncer`,
    ]);
  });

  it('refuses unsafe bindings in any block', () => {
    const unsafe = {
      bindings: [{ type: 'durable_object_namespace', class_name: 'SignerDO', script_name: 'sts' }],
    };
    const config = consumer({
      unsafe,
      env: { staging: { unsafe } },
      previews: { unsafe },
    });
    expect(problemsOf(config)).toEqual([
      `${PATH} (top level): unsafe is refused; no rule here can read its bindings`,
      `${PATH} (top level) previews: unsafe is refused; no rule here can read its bindings`,
      `${PATH} (env.staging): unsafe is refused; no rule here can read its bindings`,
    ]);
  });

  it('reports a key it does not model instead of ignoring it', () => {
    const config = consumer({
      durable_object_bindings: [{ name: 'SIGNER', class_name: 'SignerDO', script_name: 'sts' }],
      env: { staging: { dev: { port: 1 }, legacy_env: true } },
      previews: { routes: ['sts.kiloapps.io'] },
    });
    const hint = 'classify it in test/repo/worker-configs.ts';
    expect(problemsOf(config)).toEqual([
      `${PATH} (top level): unmodelled key durable_object_bindings; ${hint}`,
      `${PATH} (top level) previews: unmodelled key routes; ${hint}`,
      `${PATH} (env.staging): unmodelled key dev; ${hint}`,
      `${PATH} (env.staging): unmodelled key legacy_env; ${hint}`,
    ]);
  });

  it('fails the parse on an unknown field inside a modelled binding', () => {
    expect(() => consumer({ services: [{ ...stsBinding('sts'), script_name: 'sts' }] })).toThrow(
      /Unrecognized key: "script_name"/
    );
    expect(() =>
      consumer({ r2_buckets: [{ binding: 'A', bucket_name: 'a', bucket: 'kilo-audit-archive' }] })
    ).toThrow(/Unrecognized key: "bucket"/);
  });

  it('lets a preview bind no STS, audit queue or archive bucket', () => {
    const config = consumer({
      services: [stsBinding('sts')],
      previews: {
        services: [stsBinding('sts')],
        queues: { producers: [{ binding: 'AUDIT', queue: 'kilo-audit' }] },
        r2_buckets: [{ binding: 'A', bucket_name: 'kilo-audit-archive', jurisdiction: 'eu' }],
      },
    });
    expect(problemsOf(config)).toEqual([
      `${PATH} (top level) previews: AUDIT produces to kilo-audit; only sts may`,
      `${PATH} (top level) previews: A names kilo-audit-archive in bucket_name; only audit-relay may`,
      `${PATH} (top level) previews: STS binds sts; a preview runs unreviewed code and binds no STS`,
    ]);
  });

  it('refuses every other reference into STS or relay classes and handlers', () => {
    const config = consumer({
      workflows: [
        { binding: 'WF', name: 'wf', class_name: 'Flow', script_name: 'sts' },
        { binding: 'OWN', name: 'own', class_name: 'Flow' },
      ],
      tail_consumers: [{ service: 'audit-relay' }, { service: 'o11y' }],
      streaming_tail_consumers: [{ service: 'sts-staging' }],
      dispatch_namespaces: [{ binding: 'D', namespace: 'ns', outbound: { service: 'sts' } }],
      migrations: [
        {
          tag: 'v1',
          transferred_classes: [{ from: 'SignerDO', from_script: 'sts', to: 'Mine' }],
        },
      ],
      exports: {
        Mine: {
          type: 'durable-object',
          state: 'expecting-transfer',
          storage: 'sqlite',
          transfer_from: 'sts',
        },
        Other: { type: 'worker-entrypoint', via: 'sts' },
      },
    });
    const internal = 'its classes and handlers are internal';
    expect(problemsOf(config)).toEqual([
      `${PATH} (top level): workflow WF script_name names sts; ${internal}`,
      `${PATH} (top level): a tail consumer names audit-relay; ${internal}`,
      `${PATH} (top level): a tail consumer names sts-staging; ${internal}`,
      `${PATH} (top level): dispatch namespace D outbound names sts; ${internal}`,
      `${PATH} (top level): migration v1 transferred_classes SignerDO from_script names sts; ${internal}`,
      `${PATH} (top level): export Mine transfer_from names sts; ${internal}`,
      `${PATH} (top level): export Other has unmodelled key via`,
    ]);
  });

  it('lets only the relay bind its own archive bucket, in the EU outside local and test', () => {
    const foreign = consumer({
      r2_buckets: [
        { binding: 'ARCHIVE', bucket_name: 'kilo-audit-archive', jurisdiction: 'eu' },
        {
          binding: 'SCRATCH',
          bucket_name: 'scratch',
          preview_bucket_name: 'kilo-audit-archive-local',
        },
      ],
    });
    const relay = parseWorkerConfig('services/audit-relay/wrangler.jsonc', {
      name: 'audit-relay',
      ...NO_TRACES,
      r2_buckets: [{ binding: 'AUDIT_ARCHIVE', bucket_name: 'kilo-audit-archive' }],
      env: {
        staging: {
          name: 'audit-relay-staging',
          r2_buckets: [
            { binding: 'AUDIT_ARCHIVE', bucket_name: 'kilo-audit-archive', jurisdiction: 'eu' },
          ],
        },
        local: {
          name: 'audit-relay-local',
          r2_buckets: [{ binding: 'AUDIT_ARCHIVE', bucket_name: 'kilo-audit-archive-local' }],
        },
      },
    });
    expect(problemsOf(foreign, relay)).toEqual([
      `${PATH} (top level): ARCHIVE names kilo-audit-archive in bucket_name; only audit-relay may`,
      `${PATH} (top level): SCRATCH names kilo-audit-archive-local in preview_bucket_name; only audit-relay-local may`,
      'services/audit-relay/wrangler.jsonc (top level): AUDIT_ARCHIVE names kilo-audit-archive in bucket_name without jurisdiction eu; only the EU bucket exists and carries the lock rules',
      'services/audit-relay/wrangler.jsonc (env.staging): AUDIT_ARCHIVE names kilo-audit-archive in bucket_name; only audit-relay may',
    ]);
  });

  it('refuses a route that covers an STS or relay hostname from another config', () => {
    const config = consumer({
      routes: [
        { pattern: 'sts.kiloapps.io/v1/*', zone_name: 'kiloapps.io' },
        '*.kiloapps.io/*',
        'o11y.kiloapps.io',
      ],
      env: { staging: { route: 'audit-relay-staging.kiloapps.io' } },
    });
    const covers = (pattern: string, host: string, owner: string) =>
      `route ${pattern} covers ${host}, which only the ${owner} config serves`;
    expect(problemsOf(config)).toEqual([
      `${PATH} (top level): ${covers('sts.kiloapps.io/v1/*', 'sts.kiloapps.io', 'sts')}`,
      `${PATH} (top level): ${covers('*.kiloapps.io/*', 'sts.kiloapps.io', 'sts')}`,
      `${PATH} (top level): ${covers('*.kiloapps.io/*', 'sts-staging.kiloapps.io', 'sts')}`,
      `${PATH} (top level): ${covers('*.kiloapps.io/*', 'audit-relay.kiloapps.io', 'audit-relay')}`,
      `${PATH} (top level): ${covers('*.kiloapps.io/*', 'audit-relay-staging.kiloapps.io', 'audit-relay')}`,
      `${PATH} (env.staging): ${covers('audit-relay-staging.kiloapps.io', 'audit-relay-staging.kiloapps.io', 'audit-relay')}`,
    ]);
  });

  it('requires traces off in every block of STS, the relay and every config that binds STS', () => {
    const sts = parseWorkerConfig('services/sts/wrangler.jsonc', {
      name: 'sts',
      observability: { enabled: true },
      env: {
        staging: { name: 'sts-staging', observability: { traces: { enabled: true } } },
        local: { name: 'sts-local', observability: { traces: { enabled: false } } },
      },
    });
    const bindsSts = consumer({
      observability: undefined,
      services: [stsBinding('sts')],
      previews: { observability: { traces: { enabled: true } } },
    });
    const unrelated = parseWorkerConfig('services/other/wrangler.jsonc', {
      name: 'other',
      observability: { enabled: true },
    });
    const why =
      'it must be false, as a trace records outbound URLs and Durable Object SQL bindings';
    expect(problemsOf(sts, bindsSts, unrelated)).toEqual([
      `services/sts/wrangler.jsonc (top level): observability.traces.enabled resolves to undefined; ${why}`,
      `services/sts/wrangler.jsonc (env.staging): observability.traces.enabled resolves to true; ${why}`,
      `${PATH} (top level): observability.traces.enabled resolves to undefined; ${why}`,
      `${PATH} (top level) previews: observability.traces.enabled resolves to true; ${why}`,
    ]);
  });

  it('keeps production secrets of the shared store out of the non-production blocks of a config that binds STS', () => {
    const store = '342a86d9e3a94da698e82d0c6e2a36f0';
    const secrets = [
      { binding: 'A', store_id: store, secret_name: 'O11Y_SLACK_WEBHOOK_PAGE' },
      { binding: 'B', store_id: store, secret_name: 'O11Y_SLACK_WEBHOOK_PAGE_DEV' },
      { binding: 'C', store_id: 'another-store', secret_name: 'O11Y_SLACK_WEBHOOK_PAGE' },
    ];
    const config = consumer({
      services: [stsBinding('sts')],
      secrets_store_secrets: secrets,
      previews: {
        secrets_store_secrets: [{ binding: 'P', store_id: store, secret_name: 'O11Y_TOKEN' }],
      },
      env: { local: { services: [stsBinding('sts-local')], secrets_store_secrets: secrets } },
    });
    const unrelated = parseWorkerConfig('services/other/wrangler.jsonc', {
      name: 'other',
      env: { local: { secrets_store_secrets: secrets } },
    });
    const rule =
      'a non-production block reads only a _DEV, _DEVELOPMENT, _LOCAL, _STAGING or _TEST secret there';
    expect(problemsOf(config, unrelated)).toEqual([
      `${PATH} (top level) previews: P reads O11Y_TOKEN from the production Secrets Store; ${rule}`,
      `${PATH} (env.local): A reads O11Y_SLACK_WEBHOOK_PAGE from the production Secrets Store; ${rule}`,
    ]);
  });

  it('runs no production schedule from a non-production block of a config that binds STS', () => {
    const config = consumer({
      services: [stsBinding('sts')],
      triggers: { crons: ['* * * * *'] },
      env: {
        local: { services: [stsBinding('sts-local')] },
        dev: { triggers: { crons: ['*/5 * * * *'] } },
        staging: { services: [stsBinding('sts-staging')], triggers: { crons: ['0 * * * *'] } },
        ci: { triggers: { crons: [] } },
      },
    });
    expect(problemsOf(config)).toEqual([
      `${PATH} (env.local) inherits the production crons ["* * * * *"]; set triggers.crons to []`,
      `${PATH} (env.dev) sets triggers.crons ["*/5 * * * *"]; only staging may run schedules outside production, so set []`,
    ]);
    const withoutCrons = consumer({
      services: [stsBinding('sts')],
      env: { local: { services: [stsBinding('sts-local')] } },
    });
    expect(problemsOf(withoutCrons)).toEqual([]);
  });
});

describe('deployment lists', () => {
  const stsConfig = (stagingEnvironment: string) =>
    parseWorkerConfig('services/sts/wrangler.jsonc', {
      name: 'sts',
      vars: { STS_ENVIRONMENT: 'production' },
      env: {
        staging: { name: 'sts-staging', vars: { STS_ENVIRONMENT: stagingEnvironment } },
        local: { name: 'sts-local', vars: { STS_ENVIRONMENT: 'development' } },
      },
    });

  it('requires the STS config to deploy exactly the listed names and environments', () => {
    expect(internalWorkerProblems([stsConfig('staging')])).toEqual([]);
    expect(internalWorkerProblems([stsConfig('production')])).toEqual([
      'services/sts/wrangler.jsonc deploys sts-local=development, sts-staging=production, sts=production; STS_DEPLOYMENTS lists sts-local=development, sts-staging=staging, sts=production',
    ]);
    expect(internalWorkerProblems([])).toEqual(['expected one config named sts, found 0']);
  });

  it('requires an audit-relay config, once it exists, to deploy exactly the listed names', () => {
    const relay = parseWorkerConfig('services/audit-relay/wrangler.jsonc', {
      name: 'audit-relay',
      env: { staging: {}, dev: {} },
    });
    expect(internalWorkerProblems([stsConfig('staging'), relay])).toEqual([
      'services/audit-relay/wrangler.jsonc deploys audit-relay, audit-relay-dev, audit-relay-staging; AUDIT_RELAY_DEPLOYMENTS lists audit-relay, audit-relay-local, audit-relay-staging',
    ]);
  });

  it('ties every worker-binding policy to a config here that binds STS, or to a listed external workload', () => {
    const bound = consumer({ services: [stsBinding('sts')] });
    const unbound = parseWorkerConfig('services/other/wrangler.jsonc', { name: 'other' });
    const fly = PolicySchema.parse({
      workload: 'flyer',
      environments: ALL_ENVIRONMENTS,
      identity: { kind: 'fly-oidc', org: 'kilo', orgId: '10', app: 'flyer', appId: '20' },
      secrets: [],
    });
    const policies = [
      workerBindingPolicy('consumer'),
      workerBindingPolicy('other'),
      workerBindingPolicy('absent'),
      workerBindingPolicy('bouncer-watch', ['production']),
      fly,
    ];
    const hint = 'list it in EXTERNAL_WORKLOADS if another repository holds its config';
    expect(workerBindingPolicyProblems([bound, unbound], policies)).toEqual([
      `policy other has no config here that binds STS as other; ${hint}`,
      `policy absent has no config here that binds STS as absent; ${hint}`,
    ]);
    expect(workerBindingPolicyProblems([bound], [workerBindingPolicy('consumer')])).toEqual([
      'EXTERNAL_WORKLOADS lists bouncer-watch (Kilo-Org/bouncer), which has no worker-binding policy',
    ]);
  });
});
