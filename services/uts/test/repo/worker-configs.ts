import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STS_ISSUERS } from '@kilocode/sts-contracts';
import {
  UTS_ENDPOINTS,
  UTS_FEED_READER_ENTRYPOINT,
  UTS_FEED_READS_ENTRYPOINT,
  UTS_MINT_DEPLOYMENTS,
  UTS_SIGNER_KEYS_ENTRYPOINT,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import { FEED_DEPLOYMENTS, SECRETS_SOURCE_VALUES } from '../../src/env';

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

/** The one name each test config deploys as, in the Workers test pool only. */
const TEST_CONFIG_NAMES: ReadonlyMap<string, string> = new Map([
  [MINT_TEST_CONFIG, 'uts-test'],
  [FEED_TEST_CONFIG, 'uts-feed-test'],
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
  ['UtsAuditRelayDO', new Set([MINT_CONFIG, MINT_DEV_CONFIG, MINT_TEST_CONFIG])],
  ['UtsManagerAuthDO', new Set([MINT_CONFIG, MINT_DEV_CONFIG, MINT_TEST_CONFIG])],
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

/** The UTS audit queue of each environment; only the mint Worker of that environment sends to it. */
const UTS_AUDIT_QUEUES: Readonly<Record<UtsEnvironment, string>> = {
  production: 'kilo-audit-uts',
  staging: 'kilo-audit-uts-staging',
  development: 'kilo-audit-uts-local',
};

/**
 * The identity store's three Hyperdrive configs in each deployed environment (README "Deploys"):
 * the primary, the PAT lookup config and the read replica. A deployed block binds exactly these,
 * never a local connection string.
 */
export const IDENTITY_STORE_HYPERDRIVE: Readonly<
  Record<'production' | 'staging', Readonly<Record<string, string>>>
> = {
  production: {
    IDENTITY_STORE: '314ea5eee7314e09b59728ff5453e9d9',
    IDENTITY_STORE_PAT: 'f041609cd77043d7b81bdd9265f46cec',
    IDENTITY_STORE_REPLICA: '4194e3ece2b442e381ec6d82f9bc0dcf',
  },
  staging: {
    IDENTITY_STORE: '5dd523ea0fa447ebaf442a0300d8f848',
    IDENTITY_STORE_PAT: '48227f1c669742618bb7bc6adf9a416c',
    IDENTITY_STORE_REPLICA: '5fa4d303a52e4274a9750b20e2f507f0',
  },
};

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
  hyperdrive: z
    .array(
      z.looseObject({
        binding: z.string(),
        id: z.string(),
        localConnectionString: z.string().optional(),
      })
    )
    .optional(),
  queues: z
    .looseObject({
      producers: z.array(z.looseObject({ binding: z.string(), queue: z.string() })).optional(),
    })
    .optional(),
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
    .looseObject({
      head_sampling_rate: z.number().optional(),
      logs: z.looseObject({ head_sampling_rate: z.number().optional() }).optional(),
      traces: z.looseObject({ enabled: z.boolean().optional() }).optional(),
      redact_query_string: z.boolean().optional(),
    })
    .optional(),
};

const EnvironmentSchema = z.looseObject({
  ...BindingsShape,
  name: z.string().optional(),
  main: z.string().optional(),
  compatibility_date: z.string().optional(),
  compatibility_flags: z.array(z.string()).optional(),
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
  if (binding.service !== UTS_MINT_DEPLOYMENTS[environment]) {
    problems.push(
      `${where} binds ${binding.service}; this block must bind ${UTS_MINT_DEPLOYMENTS[environment]}`
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

/** A mint block produces only to its own environment's UTS audit queue. */
function auditQueueProblems(
  where: string,
  bindings: Bindings,
  environment: UtsEnvironment
): string[] {
  const produced = (bindings.queues?.producers ?? [])
    .map(producer => `${producer.binding}=${producer.queue}`)
    .join(', ');
  const expected = `AUDIT_QUEUE=${UTS_AUDIT_QUEUES[environment]}`;
  return produced === expected
    ? []
    : [`${where}: produces to ${produced || 'nothing'}; expected ${expected}`];
}

function hyperdriveProblems(
  where: string,
  bindings: Bindings,
  environment: 'production' | 'staging'
): string[] {
  const bound = (bindings.hyperdrive ?? [])
    .map(config =>
      config.localConnectionString === undefined
        ? `${config.binding}=${config.id}`
        : `${config.binding}=${config.id} with a local connection string`
    )
    .sort()
    .join(', ');
  const expected = Object.entries(IDENTITY_STORE_HYPERDRIVE[environment])
    .map(([binding, id]) => `${binding}=${id}`)
    .sort()
    .join(', ');
  return bound === expected
    ? []
    : [`${where}: binds Hyperdrive ${bound || 'nothing'}; expected ${expected}`];
}

/** The STS deployment whose bundle each deployed mint block reads. */
const STS_SERVICES = { production: 'sts', staging: 'sts-staging' } as const;

/**
 * A deployed mint block names its secrets source (`src/env.ts` refuses to start without one) and
 * binds its own environment's STS exactly once as caller `uts`, so flipping `SECRETS_SOURCE` to
 * `sts`, or back, changes one var and no binding.
 */
function secretsSourceProblems(
  where: string,
  bindings: Bindings,
  environment: 'production' | 'staging'
): string[] {
  const problems: string[] = [];
  const source = bindings.vars?.SECRETS_SOURCE;
  if (!SECRETS_SOURCE_VALUES.some(value => value === source)) {
    problems.push(
      `${where}: SECRETS_SOURCE resolves to ${String(source)}; it must be one of ${SECRETS_SOURCE_VALUES.join(', ')}`
    );
  }
  const bound = (bindings.services ?? [])
    .filter(binding => binding.binding === 'STS')
    .map(
      binding =>
        `${binding.service}/${binding.entrypoint ?? '(default)'}/${String(binding.props?.caller)}`
    )
    .join(', ');
  const expected = `${STS_SERVICES[environment]}/SecretsBroker/uts`;
  if (bound !== expected) {
    problems.push(`${where}: binds STS as ${bound || 'nothing'}; expected ${expected}`);
  }
  return problems;
}

/** A sign-in method's client id var (src/signin/providers/config.ts); each needs a runtime secret. */
const SIGN_IN_CLIENT_ID_VAR = /^SIGNIN_[A-Z]+_CLIENT_ID$/;

/**
 * Production holds the sign-in client secrets only in its `/workloads/uts` bundle, never as Worker
 * secrets, so a production block that sets a sign-in client id reads `SECRETS_SOURCE` `sts`: under
 * `worker` that provider would be misconfigured (its routes answer 500). A change that adds the
 * client ids, and never changes the source, therefore fails here until the flip is on its base
 * branch, and a rollback removes the client ids before the source goes back (README, "Production
 * sign-in providers").
 */
function productionSignInProblems(where: string, bindings: Bindings): string[] {
  const vars = bindings.vars ?? {};
  const clientIds = Object.keys(vars)
    .filter(name => SIGN_IN_CLIENT_ID_VAR.test(name))
    .sort();
  if (clientIds.length === 0 || vars.SECRETS_SOURCE === 'sts') return [];
  return [
    `${where}: sets ${clientIds.join(', ')} with SECRETS_SOURCE ${String(vars.SECRETS_SOURCE)}; production holds the client secrets only in its STS bundle, so it sets a sign-in client id only under sts`,
  ];
}

/** Problems with the development config; `utsConfigProblems` lists its rules. */
function devConfigProblems(dev: WorkerConfig): string[] {
  const { config } = dev;
  const problems: string[] = [];
  const deployed = deployments(dev);
  const expected = expectedDeployments(UTS_MINT_DEPLOYMENTS, ['development']);
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
  problems.push(...auditQueueProblems(MINT_DEV_CONFIG, config, 'development'));
  return problems;
}

/**
 * The feed Worker's HTTPS switch and STS issuer in one block: `FEED_HTTPS_ENABLED` is absent (off)
 * or exactly `true`, and `STS_URL`, when set, is the STS issuer of the block's own environment, so
 * a deployed block can never accept another environment's service tokens. A loopback stand-in is
 * set only on the command line of a local run, never here.
 */
function feedHttpsProblems(block: Block): string[] {
  const problems: string[] = [];
  const vars = block.bindings.vars ?? {};
  const enabled = vars.FEED_HTTPS_ENABLED;
  if (enabled !== undefined && enabled !== 'true') {
    problems.push(
      `${block.where}: FEED_HTTPS_ENABLED is ${JSON.stringify(enabled)}; it is exactly "true" or absent (off)`
    );
  }
  const environment = WRANGLER_ENVIRONMENTS.get(block.env);
  if (
    vars.STS_URL !== undefined &&
    (environment === undefined || vars.STS_URL !== STS_ISSUERS[environment])
  ) {
    problems.push(
      `${block.where}: STS_URL is ${JSON.stringify(vars.STS_URL)}; it must be the STS issuer of ${String(environment)}`
    );
  }
  return problems;
}

/**
 * The home-widget exchange's switch in one mint block: `HOME_WIDGET_GRANT_ENABLED` is absent (off)
 * or exactly `true`, and production keeps it off until the widget moves to UTS (phase 4).
 */
function homeWidgetSwitchProblems(block: Block, environment: UtsEnvironment | undefined): string[] {
  const enabled = block.bindings.vars?.HOME_WIDGET_GRANT_ENABLED;
  if (enabled === undefined) return [];
  if (enabled !== 'true') {
    return [
      `${block.where}: HOME_WIDGET_GRANT_ENABLED is ${JSON.stringify(enabled)}; it is exactly "true" or absent (off)`,
    ];
  }
  return environment === 'production'
    ? [`${block.where}: HOME_WIDGET_GRANT_ENABLED stays off in production`]
    : [];
}

/**
 * The configs that run the jose verification path: every mint Worker config, and the feed
 * Worker's, which verifies STS tokens for its HTTPS feed (`@kilocode/verify`). The rule below
 * covers only these: asserted repo-wide it would fail Workers that reach jose through a package
 * with an older date, such as services/ai-attribution, which is not this rule's subject.
 */
const JOSE_CONFIGS: ReadonlySet<string> = new Set([
  MINT_CONFIG,
  MINT_DEV_CONFIG,
  MINT_TEST_CONFIG,
  FEED_CONFIG,
  FEED_TEST_CONFIG,
]);

/**
 * The first compatibility date that carries workerd's fix for jose's verification path: jose's
 * `verifyCompact` returns a promise it does not await, so a verification error is briefly
 * unhandled and workerd reported it as a duplicate unhandled rejection although the caller caught
 * it (panva/jose#892). The flag below is the default from this date on.
 */
export const JOSE_UNHANDLED_REJECTION_DATE = '2026-03-03';

/** The flag that fixes that report; workerd refuses it at or above `JOSE_UNHANDLED_REJECTION_DATE`. */
export const JOSE_UNHANDLED_REJECTION_FLAG = 'unhandled_rejection_after_microtask_checkpoint';

/**
 * A jose-verifying config lists the flag exactly when its date is before the fix, so the Worker
 * behaves the same whether or not the date carries it: before `JOSE_UNHANDLED_REJECTION_DATE` the
 * flag is what keeps a caught verification failure from surfacing as an unhandled rejection, and
 * from that date on the flag is the default, listed or not, and workerd refuses an explicit listing.
 * Dates and flags are inherited from the top level, as Wrangler inherits them into an env block.
 */
function joseCompatibilityProblems({ path, config }: WorkerConfig): string[] {
  const problems: string[] = [];
  for (const block of blocksOf({ path, config })) {
    const date = block.block?.compatibility_date ?? config.compatibility_date;
    const flags = block.block?.compatibility_flags ?? config.compatibility_flags ?? [];
    const listed = flags.includes(JOSE_UNHANDLED_REJECTION_FLAG);
    if (date === undefined) {
      problems.push(
        `${block.where}: compatibility_date resolves to undefined; set one, so the ${JOSE_UNHANDLED_REJECTION_FLAG} rule for jose's verification errors applies (panva/jose#892)`
      );
    } else if (date < JOSE_UNHANDLED_REJECTION_DATE) {
      if (!listed) {
        problems.push(
          `${block.where}: compatibility_date ${date} is before ${JOSE_UNHANDLED_REJECTION_DATE}, so compatibility_flags must list ${JOSE_UNHANDLED_REJECTION_FLAG} (panva/jose#892)`
        );
      }
    } else if (listed) {
      problems.push(
        `${block.where}: compatibility_date ${date} is ${JOSE_UNHANDLED_REJECTION_DATE} or later, where ${JOSE_UNHANDLED_REJECTION_FLAG} is the default and workerd refuses the listing; drop it (panva/jose#892)`
      );
    }
  }
  return problems;
}

/**
 * The largest head sample of the feed Worker's logs: each HTTPS feed read is one invocation, so the
 * approved log budget allows 1 to 5 percent of them.
 */
export const FEED_MAX_LOG_SAMPLING_RATE = 0.05;

/**
 * Problems inside the UTS Workers' own configs: each deployed config deploys exactly its names
 * with matching `UTS_ENVIRONMENT`; traces stay off in every block, since the signer and feed
 * objects hold private keys; every mint block of `wrangler.jsonc` runs the deployed entry, keeps
 * its objects in the `eu` jurisdiction, places its fetch handler next to the identity store,
 * keeps query strings (a provider callback's authorization code) out of its logs, offers the
 * home-widget exchange only with `HOME_WIDGET_GRANT_ENABLED` exactly `true`, never in production,
 * names its secrets source and binds its own environment's STS as caller `uts`, and in production
 * sets a sign-in client id only under `SECRETS_SOURCE` `sts`;
 * the development config is one block that runs the development entry under the development name,
 * unrouted, behind the build command that fails every command but `dev`; the feed Worker runs
 * without placement, binds no Durable Object, binds each mint entrypoint once, keeps at most a
 * `FEED_MAX_LOG_SAMPLING_RATE` head sample of its logs, and turns its HTTPS feed on only with
 * `FEED_HTTPS_ENABLED` exactly `true` and the STS issuer of its own environment; and every
 * jose-verifying config lists `unhandled_rejection_after_microtask_checkpoint` exactly when its
 * compatibility date is before 2026-03-03, the date the flag became workerd's default (jose#892).
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
    if (JOSE_CONFIGS.has(path)) problems.push(...joseCompatibilityProblems(worker));
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
    const expected = expectedDeployments(UTS_MINT_DEPLOYMENTS, ['production', 'staging']);
    if (deployments(mint) !== expected)
      problems.push(`${MINT_CONFIG} deploys ${deployments(mint)}; expected ${expected}`);
    for (const block of blocksOf(mint)) {
      const environment = WRANGLER_ENVIRONMENTS.get(block.env);
      // Each block produces only to its own environment's UTS audit queue, the one queue whose
      // batches the audit relay reads as UTS streams (services/audit-relay/src/relay).
      if (environment !== undefined && !block.preview) {
        problems.push(...auditQueueProblems(block.where, block.bindings, environment));
        if (environment === 'production' || environment === 'staging') {
          problems.push(...hyperdriveProblems(block.where, block.bindings, environment));
          problems.push(...secretsSourceProblems(block.where, block.bindings, environment));
        }
        if (environment === 'production') {
          problems.push(...productionSignInProblems(block.where, block.bindings));
        }
      }
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
      // A provider callback's query carries its authorization code; no log may keep it.
      const redacted = (block.block?.observability ?? mint.config.observability)
        ?.redact_query_string;
      if (redacted !== true) {
        problems.push(
          `${block.where}: observability.redact_query_string resolves to ${String(redacted)}; it must be true`
        );
      }
      problems.push(...homeWidgetSwitchProblems(block, environment));
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
      if ((block.bindings.queues?.producers ?? []).length > 0) {
        problems.push(`${block.where}: the feed Worker produces to no queue`);
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
      // Cloudflare samples logs at `logs.head_sampling_rate`, else the observability-wide rate,
      // else keeps every invocation.
      const observability = block.block?.observability ?? feed.config.observability;
      const logRate =
        observability?.logs?.head_sampling_rate ?? observability?.head_sampling_rate ?? 1;
      if (logRate > FEED_MAX_LOG_SAMPLING_RATE) {
        problems.push(
          `${block.where}: observability.logs.head_sampling_rate resolves to ${logRate}; the feed Worker keeps at most ${FEED_MAX_LOG_SAMPLING_RATE} of its invocation logs`
        );
      }
      problems.push(...feedHttpsProblems(block));
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
