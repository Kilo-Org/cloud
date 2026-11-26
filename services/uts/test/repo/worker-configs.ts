import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UTS_ENDPOINTS,
  UTS_SIGNER_KEYS_ENTRYPOINT,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import { FEED_DEPLOYMENTS, MINT_DEPLOYMENTS } from '../../src/env';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The two UTS Workers' configs; the test configs run only in the Workers test pool. */
export const MINT_CONFIG = 'services/uts/wrangler.jsonc';
export const MINT_TEST_CONFIG = 'services/uts/wrangler.test.jsonc';
export const FEED_CONFIG = 'services/uts-feed/wrangler.jsonc';
export const FEED_TEST_CONFIG = 'services/uts-feed/wrangler.test.jsonc';
const UTS_CONFIGS = new Set([MINT_CONFIG, MINT_TEST_CONFIG, FEED_CONFIG, FEED_TEST_CONFIG]);

/** The one name each test config deploys as, in the Workers test pool only. */
const TEST_CONFIG_NAMES: ReadonlyMap<string, string> = new Map([
  [MINT_TEST_CONFIG, 'uts-test'],
  [FEED_TEST_CONFIG, 'uts-feed-test'],
]);

/** Every UTS Durable Object class and the configs that alone may bind it. */
export const UTS_DURABLE_OBJECT_CLASSES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['UtsSignerDO', new Set([MINT_CONFIG, MINT_TEST_CONFIG])],
  ['UtsKeySetDO', new Set([MINT_CONFIG, MINT_TEST_CONFIG])],
  ['UtsAuditRelayDO', new Set([MINT_CONFIG, MINT_TEST_CONFIG])],
]);

/** The placement region of the identity store's primary (Frankfurt). */
export const MINT_PLACEMENT_REGION = 'aws:eu-central-1';

/** The entry every deployed mint block runs; `src/dev-index.ts` adds a local signing route. */
const MINT_DEPLOYED_ENTRY = 'src/index.ts';

/** Environment names in Wrangler (`env.<name>`) for each UTS environment; null is the top level. */
const WRANGLER_ENVIRONMENTS: ReadonlyMap<string | null, UtsEnvironment> = new Map([
  [null, 'production'],
  ['staging', 'staging'],
  ['local', 'development'],
]);

// Prefix match, wider than the deployment lists on purpose: a name that only looks like UTS
// fails here instead of slipping past an exact-name list.
const isUtsName = (name: string) => name === 'uts' || name.startsWith('uts-');
const isFeedName = (name: string) => name === 'uts-feed' || name.startsWith('uts-feed-');
const isMintName = (name: string) => isUtsName(name) && !isFeedName(name);

const UTS_HOSTS = new Set(
  Object.values(UTS_ENDPOINTS).flatMap(({ issuer, feedOrigin }) => [
    new URL(issuer).hostname,
    new URL(feedOrigin).hostname,
  ])
);

const ServiceBindingSchema = z.looseObject({
  binding: z.string(),
  service: z.string(),
  entrypoint: z.string().optional(),
  environment: z.string().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});

const ScriptReferenceSchema = z.looseObject({ script_name: z.string().optional() });
const ServiceReferenceSchema = z.looseObject({ service: z.string() });

const RouteSchema = z.union([
  z.string().transform(pattern => ({ pattern })),
  z.looseObject({ pattern: z.string() }),
]);

/**
 * Only the members these rules read; Wrangler validates the rest at deploy, and the STS
 * repository check (services/sts/test/repo) classifies every key.
 */
const BindingsShape = {
  vars: z.record(z.string(), z.unknown()).optional(),
  services: z.array(ServiceBindingSchema).optional(),
  durable_objects: z
    .looseObject({
      bindings: z.array(
        z.looseObject({
          name: z.string(),
          class_name: z.string(),
          script_name: z.string().optional(),
        })
      ),
    })
    .optional(),
  workflows: z.array(ScriptReferenceSchema).optional(),
  tail_consumers: z.array(ServiceReferenceSchema).optional(),
  streaming_tail_consumers: z.array(ServiceReferenceSchema).optional(),
  dispatch_namespaces: z
    .array(z.looseObject({ outbound: ServiceReferenceSchema.optional() }))
    .optional(),
  observability: z
    .looseObject({ traces: z.looseObject({ enabled: z.boolean().optional() }).optional() })
    .optional(),
};

const EnvironmentSchema = z.looseObject({
  ...BindingsShape,
  name: z.string().optional(),
  main: z.string().optional(),
  route: RouteSchema.optional(),
  routes: z.array(RouteSchema).optional(),
  placement: z
    .looseObject({ region: z.string().optional(), mode: z.string().optional() })
    .optional(),
  migrations: z
    .array(
      z.looseObject({
        transferred_classes: z.array(z.looseObject({ from_script: z.string() })).optional(),
      })
    )
    .optional(),
  exports: z.record(z.string(), z.looseObject({ transfer_from: z.string().optional() })).optional(),
  previews: z.looseObject(BindingsShape).optional(),
});

const WorkerConfigSchema = EnvironmentSchema.extend({
  env: z.record(z.string(), EnvironmentSchema).optional(),
});

export type WorkerConfig = { path: string; config: z.infer<typeof WorkerConfigSchema> };
type Environment = z.infer<typeof EnvironmentSchema>;
type Bindings = z.infer<z.ZodObject<typeof BindingsShape>>;

type Block = {
  where: string;
  /** Wrangler environment name; null for the top level, which is production. */
  env: string | null;
  preview: boolean;
  /** The name the block deploys as; undefined for a preview or a config without a name. */
  deployedName: string | undefined;
  bindings: Bindings;
  block: Environment | null;
  /** Wrangler inherits `observability` and `placement` into an env block that leaves them out. */
  tracesEnabled: boolean | undefined;
  placementRegion: string | undefined;
};

export function parseWorkerConfig(path: string, raw: unknown): WorkerConfig {
  const parsed = WorkerConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path}: ${z.prettifyError(parsed.error)}`);
  return { path, config: parsed.data };
}

/** Every Wrangler config in the checkout, tracked or untracked, test fixtures included. */
export function workerConfigPaths(root: string): string[] {
  const listed = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ':(glob)**/wrangler*.json',
      ':(glob)**/wrangler*.jsonc',
      ':(glob)**/wrangler*.toml',
    ],
    { cwd: root, encoding: 'utf8' }
  );
  return [...new Set(listed.split('\0').filter(Boolean))]
    .filter(path => existsSync(join(root, path)))
    .sort();
}

function blocksOf({ path, config }: WorkerConfig): Block[] {
  const blocks: Block[] = [];
  const add = (env: string | null, block: Environment) => {
    const where = `${path} (${env === null ? 'top level' : `env.${env}`})`;
    const deployedName =
      env === null
        ? block.name
        : (block.name ?? (config.name === undefined ? undefined : `${config.name}-${env}`));
    const tracesEnabled = (block.observability ?? config.observability)?.traces?.enabled;
    const placementRegion = (block.placement ?? config.placement)?.region;
    blocks.push({
      where,
      env,
      preview: false,
      deployedName,
      bindings: block,
      block,
      tracesEnabled,
      placementRegion,
    });
    if (block.previews !== undefined) {
      blocks.push({
        where: `${where} previews`,
        env,
        preview: true,
        deployedName: undefined,
        bindings: block.previews,
        block: null,
        tracesEnabled: (block.previews.observability ?? block.observability ?? config.observability)
          ?.traces?.enabled,
        placementRegion: undefined,
      });
    }
  };
  add(null, config);
  for (const [env, block] of Object.entries(config.env ?? {})) add(env, block);
  return blocks;
}

/** Script names a block reaches other than through a service binding. */
function scriptReferences(block: Block): Array<[what: string, script: string]> {
  const { bindings } = block;
  const references: Array<[string, string | undefined]> = [
    ...(bindings.durable_objects?.bindings ?? []).map((object): [string, string | undefined] => [
      `Durable Object binding ${object.name}`,
      object.script_name,
    ]),
    ...(bindings.workflows ?? []).map((workflow): [string, string | undefined] => [
      'a workflow',
      workflow.script_name,
    ]),
    ...[...(bindings.tail_consumers ?? []), ...(bindings.streaming_tail_consumers ?? [])].map(
      (consumer): [string, string] => ['a tail consumer', consumer.service]
    ),
    ...(bindings.dispatch_namespaces ?? []).map((namespace): [string, string | undefined] => [
      'a dispatch namespace outbound',
      namespace.outbound?.service,
    ]),
    ...(block.block?.migrations ?? []).flatMap(migration =>
      (migration.transferred_classes ?? []).map((transfer): [string, string] => [
        'a migration transferred_classes',
        transfer.from_script,
      ])
    ),
    ...Object.entries(block.block?.exports ?? {}).map(
      ([name, entry]): [string, string | undefined] => [
        `export ${name} transfer_from`,
        entry.transfer_from,
      ]
    ),
  ];
  return references.filter(
    (reference): reference is [string, string] => reference[1] !== undefined
  );
}

function durableObjectProblems(path: string, block: Block): string[] {
  const problems: string[] = [];
  for (const object of block.bindings.durable_objects?.bindings ?? []) {
    const owners = UTS_DURABLE_OBJECT_CLASSES.get(object.class_name);
    if (owners !== undefined && !owners.has(path)) {
      problems.push(
        `${block.where}: ${object.name} names UTS Durable Object class ${object.class_name}; only ${[...owners].join(', ')} may`
      );
    }
  }
  if (UTS_CONFIGS.has(path)) return problems;
  for (const [what, script] of scriptReferences(block)) {
    if (isUtsName(script)) {
      problems.push(
        `${block.where}: ${what} names ${script}; UTS classes and handlers are internal`
      );
    }
  }
  return problems;
}

/**
 * The `SignerKeys` entrypoint answers one caller per environment: the feed Worker, whose binding
 * names the mint deployment of its own environment at that named entrypoint and carries its own
 * deployed name as `props.caller`. The mint Worker's test config binds itself. Nothing else binds
 * the mint Worker, at any entrypoint.
 */
function serviceBindingProblems(path: string, block: Block): string[] {
  const problems: string[] = [];
  for (const binding of block.bindings.services ?? []) {
    const where = `${block.where}: ${binding.binding}`;
    if (!isMintName(binding.service)) continue;
    if (path === MINT_TEST_CONFIG && binding.service === block.deployedName) continue;
    if (path !== FEED_CONFIG) {
      problems.push(
        `${where} binds the UTS mint Worker ${binding.service}; only the feed Worker may`
      );
      continue;
    }
    if (block.preview) {
      problems.push(`${where} binds ${binding.service}; a preview runs unreviewed code`);
      continue;
    }
    const environment = WRANGLER_ENVIRONMENTS.get(block.env);
    if (environment === undefined) {
      problems.push(`${where}: env.${block.env} is not a UTS environment`);
      continue;
    }
    if (binding.service !== MINT_DEPLOYMENTS[environment]) {
      problems.push(
        `${where} binds ${binding.service}; this block must bind ${MINT_DEPLOYMENTS[environment]}`
      );
    }
    if (binding.entrypoint !== UTS_SIGNER_KEYS_ENTRYPOINT) {
      problems.push(
        `${where} binds entrypoint ${binding.entrypoint ?? '(default)'}; bind ${UTS_SIGNER_KEYS_ENTRYPOINT}`
      );
    }
    if (binding.environment !== undefined) {
      problems.push(
        `${where} names service environment ${binding.environment}; bind the deployed name`
      );
    }
    const caller = binding.props?.caller;
    if (caller !== block.deployedName || caller !== FEED_DEPLOYMENTS[environment]) {
      problems.push(
        `${where} sets props.caller ${JSON.stringify(caller)}; expected ${FEED_DEPLOYMENTS[environment]}, the block's own deployed name`
      );
    }
  }
  return problems;
}

function routeProblems(path: string, block: Block): string[] {
  if (path === MINT_CONFIG || path === FEED_CONFIG) return [];
  const routes = [
    ...(block.block?.route === undefined ? [] : [block.block.route]),
    ...(block.block?.routes ?? []),
  ];
  return routes
    .map(({ pattern }) => pattern.replace(/^[a-z*]+:\/\//, '').split('/')[0])
    .filter(host =>
      [...UTS_HOSTS].some(
        uts => host === uts || (host.startsWith('*') && uts.endsWith(host.slice(1)))
      )
    )
    .map(host => `${block.where}: route ${host} covers a UTS hostname`);
}

/**
 * Problems with how the repository's Worker configs reach UTS (design 5.7): only the mint Worker
 * binds the signer objects, only the feed Worker binds the mint Worker, no other config deploys
 * under a UTS name or routes a UTS hostname, and no config reaches a UTS class or handler by
 * script name.
 */
export function workerConfigProblems(configs: readonly WorkerConfig[]): string[] {
  const problems: string[] = [];
  for (const worker of configs) {
    for (const block of blocksOf(worker)) {
      problems.push(...durableObjectProblems(worker.path, block));
      problems.push(...serviceBindingProblems(worker.path, block));
      problems.push(...routeProblems(worker.path, block));
      if (
        !UTS_CONFIGS.has(worker.path) &&
        block.deployedName !== undefined &&
        isUtsName(block.deployedName)
      ) {
        problems.push(
          `${block.where} deploys as ${block.deployedName}; only the UTS configs deploy UTS names`
        );
      }
    }
  }
  return problems;
}

/** What one UTS config deploys: its blocks as `<deployed name>=<UTS_ENVIRONMENT>`. */
function deployments(worker: WorkerConfig): string {
  return blocksOf(worker)
    .filter(block => !block.preview)
    .map(block => `${String(block.deployedName)}=${String(block.bindings.vars?.UTS_ENVIRONMENT)}`)
    .sort()
    .join(', ');
}

function expectedDeployments(names: Readonly<Record<UtsEnvironment, string>>): string {
  return Object.entries(names)
    .map(([environment, name]) => `${name}=${environment}`)
    .sort()
    .join(', ');
}

/**
 * Problems inside the two UTS Workers' own configs: each deploys exactly its three names with
 * matching `UTS_ENVIRONMENT`; traces stay off in every block, since the signer objects hold
 * private keys; the mint Worker's deployed blocks keep the signer and key-set shard objects in the
 * `eu` jurisdiction
 * (staging, production) and its fetch handler placed next to the identity store; the feed Worker
 * runs without placement and binds no Durable Object.
 */
export function utsConfigProblems(configs: readonly WorkerConfig[]): string[] {
  const problems: string[] = [];
  const byPath = new Map(configs.map(worker => [worker.path, worker]));
  for (const path of UTS_CONFIGS) {
    const worker = byPath.get(path);
    if (worker === undefined) {
      problems.push(`${path} is missing`);
      continue;
    }
    for (const block of blocksOf(worker)) {
      if (block.tracesEnabled !== false) {
        problems.push(
          `${block.where}: observability.traces.enabled resolves to ${String(block.tracesEnabled)}; it must be false`
        );
      }
      if (block.preview) problems.push(`${block.where}: a UTS Worker has no preview deployments`);
    }
  }
  const mint = byPath.get(MINT_CONFIG);
  if (mint !== undefined) {
    const expected = expectedDeployments(MINT_DEPLOYMENTS);
    if (deployments(mint) !== expected)
      problems.push(`${MINT_CONFIG} deploys ${deployments(mint)}; expected ${expected}`);
    for (const block of blocksOf(mint)) {
      const environment = WRANGLER_ENVIRONMENTS.get(block.env);
      if (environment === 'development') continue;
      const main = block.block?.main ?? mint.config.main;
      if (main !== MINT_DEPLOYED_ENTRY) {
        problems.push(
          `${block.where}: main resolves to ${String(main)}; a deployed block uses ${MINT_DEPLOYED_ENTRY}`
        );
      }
      if (block.bindings.vars?.DO_JURISDICTION !== 'eu') {
        problems.push(`${block.where}: DO_JURISDICTION must be eu`);
      }
      if (block.placementRegion !== MINT_PLACEMENT_REGION) {
        problems.push(
          `${block.where}: placement.region resolves to ${String(block.placementRegion)}; expected ${MINT_PLACEMENT_REGION}`
        );
      }
    }
  }
  const feed = byPath.get(FEED_CONFIG);
  if (feed !== undefined) {
    const expected = expectedDeployments(FEED_DEPLOYMENTS);
    if (deployments(feed) !== expected)
      problems.push(`${FEED_CONFIG} deploys ${deployments(feed)}; expected ${expected}`);
    for (const block of blocksOf(feed)) {
      if ((block.block?.placement ?? feed.config.placement) !== undefined) {
        problems.push(`${block.where}: the feed Worker runs without placement`);
      }
      if ((block.bindings.durable_objects?.bindings ?? []).length > 0) {
        problems.push(`${block.where}: the feed Worker binds no Durable Object yet`);
      }
      const signerKeys = (block.bindings.services ?? []).filter(binding =>
        isMintName(binding.service)
      );
      if (signerKeys.length !== 1) {
        problems.push(
          `${block.where}: binds the mint Worker ${signerKeys.length} times; expected once`
        );
      }
    }
  }
  // The test configs run only in the Workers test pool; each deploys only its own name, so neither
  // can take a deployed UTS name and the rights (an audit queue producer) granted to that name.
  for (const [path, name] of TEST_CONFIG_NAMES) {
    const worker = byPath.get(path);
    if (worker === undefined) continue;
    const names = blocksOf(worker)
      .map(block => String(block.deployedName))
      .sort()
      .join(', ');
    if (names !== name) problems.push(`${path} deploys ${names}; expected only ${name}`);
  }
  return problems;
}
