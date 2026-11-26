import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UTS_ENDPOINTS,
  UTS_FEED_READER_ENTRYPOINT,
  UTS_FEED_READS_ENTRYPOINT,
  UTS_SIGNER_KEYS_ENTRYPOINT,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import { FEED_DEPLOYMENTS, MINT_DEPLOYMENTS } from '../../src/env';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * The two UTS Workers' configs; the mint Worker's development config, which only `wrangler dev`
 * runs; and the test configs, which run only in the Workers test pool.
 */
export const MINT_CONFIG = 'services/uts/wrangler.jsonc';
export const MINT_DEV_CONFIG = 'services/uts/wrangler.dev.jsonc';
export const MINT_TEST_CONFIG = 'services/uts/wrangler.test.jsonc';
export const FEED_CONFIG = 'services/uts-feed/wrangler.jsonc';
export const FEED_TEST_CONFIG = 'services/uts-feed/wrangler.test.jsonc';
const UTS_CONFIGS = new Set([
  MINT_CONFIG,
  MINT_DEV_CONFIG,
  MINT_TEST_CONFIG,
  FEED_CONFIG,
  FEED_TEST_CONFIG,
]);

/**
 * Every UTS Durable Object class and the configs that alone may bind it. Only the mint Worker
 * binds the feed objects, so only it writes feed entries; the feed Worker reads them through the
 * mint Worker's `FeedReads` entrypoint (design 5.7).
 */
export const UTS_DURABLE_OBJECT_CLASSES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['UtsSignerDO', new Set([MINT_CONFIG, MINT_DEV_CONFIG, MINT_TEST_CONFIG])],
  ['UtsKeySetDO', new Set([MINT_CONFIG, MINT_DEV_CONFIG, MINT_TEST_CONFIG])],
  ['UtsFeedDO', new Set([MINT_CONFIG, MINT_DEV_CONFIG, MINT_TEST_CONFIG])],
]);

/** The mint Worker entrypoints the feed Worker binds, each once per block. */
export const MINT_ENTRYPOINTS: readonly string[] = [
  UTS_SIGNER_KEYS_ENTRYPOINT,
  UTS_FEED_READS_ENTRYPOINT,
];

const FEED_DEPLOYMENT_NAMES = new Set(Object.values(FEED_DEPLOYMENTS));

/** The placement region of the identity store's primary (Frankfurt). */
export const MINT_PLACEMENT_REGION = 'aws:eu-central-1';

/** The entry every deployed mint block runs. */
const MINT_DEPLOYED_ENTRY = 'src/index.ts';

/** The development entry, which adds the local signing route; only `MINT_DEV_CONFIG` runs it. */
const MINT_DEV_ENTRY = 'src/dev-index.ts';
const MINT_DEV_ENTRY_PATH = join(dirname(MINT_CONFIG), MINT_DEV_ENTRY);

/**
 * The development config's build command. Wrangler runs it before `dev`, `deploy` and
 * `versions upload`, with `WRANGLER_COMMAND` set to the command, so it fails all but `dev`.
 */
export const MINT_DEV_BUILD_COMMAND =
  'test "$WRANGLER_COMMAND" = dev || { echo \'wrangler.dev.jsonc runs only under wrangler dev; deploy wrangler.jsonc\' >&2; exit 1; }';

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
type ServiceBinding = z.infer<typeof ServiceBindingSchema>;

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
  build: z.looseObject({ command: z.string().optional() }).optional(),
  workers_dev: z.boolean().optional(),
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
 * The `SignerKeys` and `FeedReads` entrypoints answer one caller per environment: the feed
 * Worker, whose bindings name the mint deployment of its own environment at those named
 * entrypoints and carry its own deployed name as `props.caller`. The mint Worker's test config
 * binds itself. Nothing else binds the mint Worker, at any entrypoint.
 */
function mintBindingProblems(path: string, block: Block, binding: ServiceBinding): string[] {
  const where = `${block.where}: ${binding.binding}`;
  if (path === MINT_TEST_CONFIG && binding.service === block.deployedName) return [];
  if (path !== FEED_CONFIG) {
    return [`${where} binds the UTS mint Worker ${binding.service}; only the feed Worker may`];
  }
  if (block.preview) return [`${where} binds ${binding.service}; a preview runs unreviewed code`];
  const environment = WRANGLER_ENVIRONMENTS.get(block.env);
  if (environment === undefined) return [`${where}: env.${block.env} is not a UTS environment`];
  const problems: string[] = [];
  if (binding.service !== MINT_DEPLOYMENTS[environment]) {
    problems.push(
      `${where} binds ${binding.service}; this block must bind ${MINT_DEPLOYMENTS[environment]}`
    );
  }
  if (binding.entrypoint === undefined || !MINT_ENTRYPOINTS.includes(binding.entrypoint)) {
    problems.push(
      `${where} binds entrypoint ${binding.entrypoint ?? '(default)'}; bind ${MINT_ENTRYPOINTS.join(' or ')}`
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
  return problems;
}

/**
 * A Worker verifier reads the revocation feed through the feed Worker's `FeedReader` entrypoint,
 * bound by a feed deployment's name with its own deployed name as `props.caller`, so no reader
 * poses as another (design 5.6). The feed Worker's test config binds itself; the UTS Workers do
 * not read the feed this way, and no preview does.
 */
function feedReaderProblems(path: string, block: Block, binding: ServiceBinding): string[] {
  const where = `${block.where}: ${binding.binding}`;
  if (path === FEED_TEST_CONFIG && binding.service === block.deployedName) return [];
  if (UTS_CONFIGS.has(path)) return [`${where} binds the feed Worker; a UTS Worker does not`];
  if (block.preview) return [`${where} binds ${binding.service}; a preview runs unreviewed code`];
  const problems: string[] = [];
  if (!FEED_DEPLOYMENT_NAMES.has(binding.service)) {
    problems.push(`${where} binds ${binding.service}, which is not a feed Worker deployment`);
  }
  if (binding.entrypoint !== UTS_FEED_READER_ENTRYPOINT) {
    problems.push(
      `${where} binds entrypoint ${binding.entrypoint ?? '(default)'}; bind ${UTS_FEED_READER_ENTRYPOINT}`
    );
  }
  if (binding.environment !== undefined) {
    problems.push(
      `${where} names service environment ${binding.environment}; bind the deployed name`
    );
  }
  const caller = binding.props?.caller;
  if (block.deployedName === undefined || caller !== block.deployedName) {
    problems.push(
      `${where} sets props.caller ${JSON.stringify(caller)}; expected the block's own deployed name`
    );
  }
  return problems;
}

function serviceBindingProblems(path: string, block: Block): string[] {
  return (block.bindings.services ?? []).flatMap(binding => {
    if (isFeedName(binding.service)) return feedReaderProblems(path, block, binding);
    if (isMintName(binding.service)) return mintBindingProblems(path, block, binding);
    return [];
  });
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
 * under a UTS name or routes a UTS hostname, no config reaches a UTS class or handler by script
 * name, and only the development config runs the development entry.
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
      const main = block.preview ? undefined : (block.block?.main ?? worker.config.main);
      if (
        worker.path !== MINT_DEV_CONFIG &&
        main !== undefined &&
        join(dirname(worker.path), main) === MINT_DEV_ENTRY_PATH
      ) {
        problems.push(
          `${block.where} runs ${MINT_DEV_ENTRY_PATH}; only ${MINT_DEV_CONFIG} may, and it cannot deploy`
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

function expectedDeployments(
  names: Readonly<Record<UtsEnvironment, string>>,
  environments: readonly UtsEnvironment[]
): string {
  return environments
    .map(environment => `${names[environment]}=${environment}`)
    .sort()
    .join(', ');
}

/** Problems with the development config; `utsConfigProblems` lists its rules. */
function devConfigProblems(dev: WorkerConfig): string[] {
  const { config } = dev;
  const problems: string[] = [];
  const deployed = deployments(dev);
  const expected = expectedDeployments(MINT_DEPLOYMENTS, ['development']);
  if (deployed !== expected) {
    problems.push(`${MINT_DEV_CONFIG} deploys ${deployed}; expected ${expected}`);
  }
  if (config.main !== MINT_DEV_ENTRY) {
    problems.push(`${MINT_DEV_CONFIG}: main is ${String(config.main)}; expected ${MINT_DEV_ENTRY}`);
  }
  if (config.build?.command !== MINT_DEV_BUILD_COMMAND) {
    problems.push(
      `${MINT_DEV_CONFIG}: build.command must be the command that fails every Wrangler command but dev`
    );
  }
  if (config.workers_dev !== false) problems.push(`${MINT_DEV_CONFIG}: workers_dev must be false`);
  if (config.route !== undefined || (config.routes ?? []).length > 0) {
    problems.push(`${MINT_DEV_CONFIG}: the development config has no routes`);
  }
  return problems;
}

/**
 * Problems inside the UTS Workers' own configs: each deployed config deploys exactly its names
 * with matching `UTS_ENVIRONMENT`; traces stay off in every block, since the signer and feed
 * objects hold private keys; every mint block of `wrangler.jsonc` runs the deployed entry, keeps
 * its objects in the `eu` jurisdiction, and places its fetch handler next to the identity store;
 * the development config is one block that runs the development entry under the development name,
 * unrouted, behind the build command that fails every command but `dev`; the feed Worker runs
 * without placement, binds no Durable Object, and binds each mint entrypoint once.
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
    const expected = expectedDeployments(MINT_DEPLOYMENTS, ['production', 'staging']);
    if (deployments(mint) !== expected)
      problems.push(`${MINT_CONFIG} deploys ${deployments(mint)}; expected ${expected}`);
    for (const block of blocksOf(mint)) {
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
  const dev = byPath.get(MINT_DEV_CONFIG);
  if (dev !== undefined) problems.push(...devConfigProblems(dev));
  const feed = byPath.get(FEED_CONFIG);
  if (feed !== undefined) {
    const expected = expectedDeployments(FEED_DEPLOYMENTS, [
      'production',
      'staging',
      'development',
    ]);
    if (deployments(feed) !== expected)
      problems.push(`${FEED_CONFIG} deploys ${deployments(feed)}; expected ${expected}`);
    for (const block of blocksOf(feed)) {
      if ((block.block?.placement ?? feed.config.placement) !== undefined) {
        problems.push(`${block.where}: the feed Worker runs without placement`);
      }
      if ((block.bindings.durable_objects?.bindings ?? []).length > 0) {
        problems.push(`${block.where}: the feed Worker binds no Durable Object`);
      }
      const mintEntrypoints = (block.bindings.services ?? [])
        .filter(binding => isMintName(binding.service))
        .map(binding => binding.entrypoint ?? '(default)')
        .sort();
      if (mintEntrypoints.join(',') !== [...MINT_ENTRYPOINTS].sort().join(',')) {
        problems.push(
          `${block.where}: binds the mint Worker at ${mintEntrypoints.join(', ') || 'no entrypoint'}; expected ${MINT_ENTRYPOINTS.join(' and ')} once each`
        );
      }
    }
  }
  return problems;
}
