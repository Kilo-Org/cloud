import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import { PolicySchema } from '../../src/policy/schema';
import { repoRoot, shippedPolicyDocuments } from './repo';
import {
  AUDIT_RELAY_DEPLOYMENTS,
  type WorkerConfig,
  internalWorkerProblems,
  parseWorkerConfig,
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

const consumer = (raw: Record<string, unknown>, path = PATH) =>
  parseWorkerConfig(path, { name: 'consumer', ...raw });

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
  it('lists every deployable config and skips test fixtures', () => {
    const paths = workerConfigPaths(repoRoot);
    expect(paths).toContain('services/sts/wrangler.jsonc');
    expect(paths).toContain('services/o11y/wrangler.jsonc');
    expect(paths).toContain('services/sts/wrangler.test.jsonc');
    expect(paths.filter(path => path.split('/').includes('test'))).toEqual([]);
  });

  it('reach STS only through SecretsBroker as their own Worker, and never reach the relay', () => {
    expect(workerConfigProblems(repoConfigs(), shippedPolicies())).toEqual([]);
  });

  it('agree with the deployment lists the check relies on', () => {
    expect(internalWorkerProblems(repoConfigs())).toEqual([]);
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
    expect(problemsOf(parseWorkerConfig(PATH, { services: [stsBinding('sts')] }))).toEqual([
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
      identity: { kind: 'fly-oidc', org: 'kilo', app: 'consumer' },
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

  it('accepts the audit relay as it binds STS in every environment', () => {
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
    const relay = parseWorkerConfig('services/audit-relay/wrangler.jsonc', {
      name: 'audit-relay',
      durable_objects: ownObjects,
      services: [relayBinding('sts')],
      env: {
        staging: {
          name: 'audit-relay-staging',
          durable_objects: ownObjects,
          services: [relayBinding('sts-staging')],
        },
        local: {
          name: 'audit-relay-local',
          durable_objects: ownObjects,
          services: [relayBinding('sts-local')],
        },
      },
    });
    const configs = [readWorkerConfig(repoRoot, 'services/sts/wrangler.jsonc'), relay];
    expect(workerConfigProblems(configs, shippedPolicies())).toEqual([]);
    expect(internalWorkerProblems(configs)).toEqual([]);
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
});
