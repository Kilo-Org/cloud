import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StsEnvironment } from '@kilocode/sts-contracts';
import { z } from 'zod';
import type { Policy } from '../../src/policy/schema';

/**
 * Every deployed name of the STS Worker and the STS environment it serves. A consumer's top-level
 * (production) block binds `sts`; its `<env>` block binds `sts-<env>`.
 */
export const STS_DEPLOYMENTS: ReadonlyMap<string, StsEnvironment> = new Map<string, StsEnvironment>(
  [
    ['sts', 'production'],
    ['sts-staging', 'staging'],
    ['sts-local', 'development'],
  ]
);

/** Every deployed name of the audit relay. No other Worker binds it. */
export const AUDIT_RELAY_DEPLOYMENTS: readonly string[] = [
  'audit-relay',
  'audit-relay-staging',
  'audit-relay-local',
];

/** [deployed Worker name, resource]: one right on an audit queue or archive bucket. */
type Grant = readonly [worker: string, resource: string];

/** Each STS deployment produces only to its own environment's audit queue. */
export const AUDIT_QUEUE_PRODUCERS: readonly Grant[] = [
  ['sts', 'kilo-audit'],
  ['sts-staging', 'kilo-audit-staging'],
  ['sts-local', 'kilo-audit-local'],
  // services/sts/wrangler.test.jsonc, which only the Workers test pool runs.
  ['sts-test', 'kilo-audit-local'],
];

/**
 * Each relay deployment consumes its own environment's audit queue and dead-letter queue. Nothing
 * produces to a dead-letter queue: only the relay's own consumer moves messages there.
 */
export const AUDIT_QUEUE_CONSUMERS: readonly Grant[] = [
  ['audit-relay', 'kilo-audit'],
  ['audit-relay', 'kilo-audit-dlq'],
  ['audit-relay-staging', 'kilo-audit-staging'],
  ['audit-relay-staging', 'kilo-audit-staging-dlq'],
  ['audit-relay-local', 'kilo-audit-local'],
  ['audit-relay-local', 'kilo-audit-local-dlq'],
];

export const AUDIT_QUEUE_DEAD_LETTERS: readonly Grant[] = [
  ['audit-relay', 'kilo-audit-dlq'],
  ['audit-relay-staging', 'kilo-audit-staging-dlq'],
  ['audit-relay-local', 'kilo-audit-local-dlq'],
];

/**
 * Each relay deployment binds only its own environment's archive bucket. A foreign writer could
 * pre-write an archive key, which the 400-day object lock then keeps: a permanent stream stall or
 * a forged newest checkpoint.
 */
export const AUDIT_ARCHIVE_BUCKETS: readonly Grant[] = [
  ['audit-relay', 'kilo-audit-archive'],
  ['audit-relay-staging', 'kilo-audit-archive-staging'],
  ['audit-relay-local', 'kilo-audit-archive-local'],
  // services/audit-relay/wrangler.test.jsonc, which only the Workers test pool runs.
  ['audit-relay-test', 'kilo-audit-archive-test'],
];

/**
 * Archive buckets created in the EU jurisdiction. A binding without `jurisdiction: "eu"` names a
 * different, default-jurisdiction bucket that has none of the lock rules. The local and test
 * buckets are simulated and have no jurisdiction.
 */
export const EU_ARCHIVE_BUCKETS: readonly string[] = [
  'kilo-audit-archive',
  'kilo-audit-archive-staging',
];

/** Hostnames the STS and relay configs serve, with the config (by top-level name) that owns each. */
const INTERNAL_HOSTS: ReadonlyMap<string, string> = new Map([
  ['sts.kiloapps.io', 'sts'],
  ['sts-staging.kiloapps.io', 'sts'],
  ['audit-relay.kiloapps.io', 'audit-relay'],
  ['audit-relay-staging.kiloapps.io', 'audit-relay'],
]);

/**
 * The config (by top-level name) that alone may deploy each name the lists above grant rights to;
 * any other config deploying under one of these names would replace that Worker.
 */
const DEPLOYMENT_OWNERS: ReadonlyMap<string, string> = new Map<string, string>([
  ...[...STS_DEPLOYMENTS.keys()].map((name): [string, string] => [name, 'sts']),
  ...AUDIT_RELAY_DEPLOYMENTS.map((name): [string, string] => [name, 'audit-relay']),
  ['sts-test', 'sts-test'],
  ['audit-relay-test', 'audit-relay-test'],
]);

/**
 * Workloads with a worker-binding policy whose Worker config lives in another repository, which
 * this check cannot read; that repository's review covers the config's STS binding. No config here
 * may deploy under one of these names: it would replace that Worker and, with `props.caller` set to
 * its own top-level name, read that workload's bundle.
 */
export const EXTERNAL_WORKLOADS: ReadonlyMap<string, string> = new Map([
  // watch/wrangler.jsonc there binds `sts` from its top-level (production) block.
  ['bouncer-watch', 'Kilo-Org/bouncer'],
]);

const STS_ENTRYPOINT = 'SecretsBroker';

// Prefix matches, wider than the deployment lists on purpose: a binding to a name that only looks
// like STS or the relay fails here instead of slipping past an exact-name list.
const isStsName = (name: string) => name === 'sts' || name.startsWith('sts-');
const isAuditRelayName = (name: string) =>
  name === 'audit-relay' || name.startsWith('audit-relay-');
const isInternalName = (name: string) => isStsName(name) || isAuditRelayName(name);
const isAuditQueue = (queue: string) => queue === 'kilo-audit' || queue.startsWith('kilo-audit-');
const isArchiveBucket = (bucket: string) =>
  bucket === 'kilo-audit-archive' || bucket.startsWith('kilo-audit-archive-');

/**
 * Keys of a Wrangler environment that name no other Worker, queue, bucket or route: build and
 * runtime settings of the Worker itself, and bindings by id to resource kinds STS and the relay do
 * not use. Every other key Wrangler accepts is modelled below and checked; a key in neither list is
 * reported, and `worker-configs.test.ts` fails when Wrangler's schema gains a key nobody classified.
 */
export const INERT_ENVIRONMENT_KEYS: readonly string[] = [
  'access',
  'account_id',
  'agent_memory',
  'ai',
  'ai_search',
  'ai_search_namespaces',
  'analytics_engine_datasets',
  'artifacts',
  'assets',
  'base_dir',
  'browser',
  'build',
  'cache',
  'cloudchamber',
  'compatibility_date',
  'compatibility_flags',
  'compliance_region',
  'connect',
  'containers',
  'd1_databases',
  'define',
  'find_additional_modules',
  'first_party_worker',
  'flagship',
  'hyperdrive',
  'images',
  'jsx_factory',
  'jsx_fragment',
  'keep_names',
  'kv_namespaces',
  'limits',
  'logfwdr',
  'logpush',
  'main',
  'media',
  'minify',
  'mtls_certificates',
  'no_bundle',
  'pipelines',
  'placement',
  'preserve_file_names',
  'preview_urls',
  'python_modules',
  'ratelimits',
  'rules',
  'secrets',
  'send_email',
  'stream',
  'tsconfig',
  'unsafe_hello_world',
  'upload_source_maps',
  'vectorize',
  'version_metadata',
  'vpc_networks',
  'vpc_services',
  'worker_loaders',
  'workers_dev',
];

/** Top-level keys that are not environment keys; none of them binds or routes anything. */
export const INERT_TOP_LEVEL_KEYS: readonly string[] = [
  '$schema',
  'addresses',
  'alias',
  'data_blobs',
  'dependencies_instrumentation',
  'dev',
  'keep_vars',
  'pages_build_output_dir',
  'send_metrics',
  'site',
  'text_blobs',
  'wasm_modules',
];

/** Keys of a Durable Object export entry; `transfer_from` is the only one that names a script. */
export const EXPORT_KEYS: readonly string[] = [
  'cache',
  'container',
  'renamed_to',
  'state',
  'storage',
  'transfer_from',
  'transferred_to',
  'type',
];

const ServiceBindingSchema = z.strictObject({
  binding: z.string(),
  service: z.string(),
  entrypoint: z.string().optional(),
  environment: z.string().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  remote: z.boolean().optional(),
});

const DurableObjectBindingSchema = z.strictObject({
  name: z.string(),
  class_name: z.string(),
  script_name: z.string().optional(),
  environment: z.string().optional(),
});

const QueueProducerSchema = z.strictObject({
  binding: z.string(),
  queue: z.string(),
  delivery_delay: z.number().optional(),
  remote: z.boolean().optional(),
});

const QueueConsumerSchema = z.strictObject({
  queue: z.string(),
  type: z.string().optional(),
  max_batch_size: z.number().optional(),
  max_batch_timeout: z.number().optional(),
  max_retries: z.number().optional(),
  dead_letter_queue: z.string().optional(),
  max_concurrency: z.number().nullable().optional(),
  visibility_timeout_ms: z.number().optional(),
  retry_delay: z.number().optional(),
});

const QueuesSchema = z.strictObject({
  producers: z.array(QueueProducerSchema).optional(),
  consumers: z.array(QueueConsumerSchema).optional(),
});

const R2BucketSchema = z.strictObject({
  binding: z.string(),
  bucket_name: z.string().optional(),
  preview_bucket_name: z.string().optional(),
  jurisdiction: z.string().optional(),
  local_dev: z.unknown().optional(),
  remote: z.boolean().optional(),
});

const WorkflowSchema = z.strictObject({
  binding: z.string(),
  name: z.string(),
  class_name: z.string(),
  script_name: z.string().optional(),
  concurrency: z.unknown().optional(),
  default_retention: z.unknown().optional(),
  limits: z.unknown().optional(),
  schedules: z.unknown().optional(),
});

const TailConsumerSchema = z.strictObject({
  service: z.string(),
  environment: z.string().optional(),
});

const StreamingTailConsumerSchema = z.strictObject({ service: z.string() });

const DispatchOutboundSchema = z.strictObject({
  service: z.string(),
  environment: z.string().optional(),
  parameters: z.array(z.string()).optional(),
});

const DispatchNamespaceSchema = z.strictObject({
  binding: z.string(),
  namespace: z.string(),
  outbound: DispatchOutboundSchema.optional(),
  remote: z.boolean().optional(),
});

const ObservabilitySchema = z.looseObject({
  traces: z.looseObject({ enabled: z.boolean().optional() }).optional(),
});

const TriggersSchema = z.looseObject({ crons: z.array(z.string()).optional() });

const SecretsStoreSecretSchema = z.strictObject({
  binding: z.string(),
  store_id: z.string(),
  secret_name: z.string(),
});

const RouteObjectSchema = z.strictObject({
  pattern: z.string(),
  zone_id: z.string().optional(),
  zone_name: z.string().optional(),
  custom_domain: z.boolean().optional(),
  enabled: z.boolean().optional(),
  previews_enabled: z.boolean().optional(),
});

const RouteSchema = z.union([z.string().transform(pattern => ({ pattern })), RouteObjectSchema]);

const ExportSchema = z.looseObject({ transfer_from: z.string().optional() });

const TransferredClassSchema = z.strictObject({
  from: z.string(),
  from_script: z.string(),
  to: z.string(),
});

const MigrationSchema = z.strictObject({
  tag: z.string(),
  new_classes: z.array(z.string()).optional(),
  new_sqlite_classes: z.array(z.string()).optional(),
  renamed_classes: z.array(z.strictObject({ from: z.string(), to: z.string() })).optional(),
  transferred_classes: z.array(TransferredClassSchema).optional(),
  deleted_classes: z.array(z.string()).optional(),
});

/** Keys that bind another Worker, queue or bucket; the same set applies inside `previews`. */
const BINDING_SHAPE = {
  vars: z.record(z.string(), z.unknown()).optional(),
  services: z.array(ServiceBindingSchema).optional(),
  durable_objects: z.strictObject({ bindings: z.array(DurableObjectBindingSchema) }).optional(),
  queues: QueuesSchema.optional(),
  r2_buckets: z.array(R2BucketSchema).optional(),
  workflows: z.array(WorkflowSchema).optional(),
  tail_consumers: z.array(TailConsumerSchema).optional(),
  streaming_tail_consumers: z.array(StreamingTailConsumerSchema).optional(),
  dispatch_namespaces: z.array(DispatchNamespaceSchema).optional(),
  unsafe: z.unknown().optional(),
  observability: ObservabilitySchema.optional(),
  secrets_store_secrets: z.array(SecretsStoreSecretSchema).optional(),
};

const ENVIRONMENT_SHAPE = {
  ...BINDING_SHAPE,
  name: z.string().optional(),
  route: RouteSchema.optional(),
  routes: z.array(RouteSchema).optional(),
  migrations: z.array(MigrationSchema).optional(),
  exports: z.record(z.string(), ExportSchema).optional(),
  triggers: TriggersSchema.optional(),
  previews: z.looseObject(BINDING_SHAPE).optional(),
};

// Loose at the block level so an unclassified key reaches the rules as a problem with its path;
// every modelled value is strict, so an unknown field inside a binding fails the parse.
const EnvironmentSchema = z.looseObject(ENVIRONMENT_SHAPE);

const WorkerConfigSchema = z.looseObject({
  ...ENVIRONMENT_SHAPE,
  env: z.record(z.string(), EnvironmentSchema).optional(),
});

const PREVIEW_KEYS = new Set([...Object.keys(BINDING_SHAPE), ...INERT_ENVIRONMENT_KEYS]);
const ENVIRONMENT_KEYS = new Set([...Object.keys(ENVIRONMENT_SHAPE), ...INERT_ENVIRONMENT_KEYS]);
const TOP_LEVEL_KEYS = new Set([...ENVIRONMENT_KEYS, ...INERT_TOP_LEVEL_KEYS, 'env']);

/**
 * The keys this module accepts at each level of a config, for the test that compares them with
 * the keys Wrangler's own schema accepts.
 */
export const CLASSIFIED_KEYS: Readonly<Record<string, readonly string[]>> = {
  environment: [...ENVIRONMENT_KEYS],
  topLevel: [...TOP_LEVEL_KEYS],
  previews: [...PREVIEW_KEYS],
  'services[]': Object.keys(ServiceBindingSchema.shape),
  'durable_objects.bindings[]': Object.keys(DurableObjectBindingSchema.shape),
  queues: Object.keys(QueuesSchema.shape),
  'queues.producers[]': Object.keys(QueueProducerSchema.shape),
  'queues.consumers[]': Object.keys(QueueConsumerSchema.shape),
  'r2_buckets[]': Object.keys(R2BucketSchema.shape),
  'workflows[]': Object.keys(WorkflowSchema.shape),
  'tail_consumers[]': Object.keys(TailConsumerSchema.shape),
  'streaming_tail_consumers[]': Object.keys(StreamingTailConsumerSchema.shape),
  'dispatch_namespaces[]': Object.keys(DispatchNamespaceSchema.shape),
  'dispatch_namespaces[].outbound': Object.keys(DispatchOutboundSchema.shape),
  'routes[]': Object.keys(RouteObjectSchema.shape),
  'migrations[]': Object.keys(MigrationSchema.shape),
  'migrations[].transferred_classes[]': Object.keys(TransferredClassSchema.shape),
  'exports.*': EXPORT_KEYS,
  'secrets_store_secrets[]': Object.keys(SecretsStoreSecretSchema.shape),
};

export type WorkerConfig = { path: string; config: z.infer<typeof WorkerConfigSchema> };

type Bindings = z.infer<z.ZodObject<typeof BINDING_SHAPE>>;
type ServiceBinding = z.infer<typeof ServiceBindingSchema>;
type Environment = z.infer<typeof EnvironmentSchema>;

type Block = {
  /** `null` for the top level, which is the production deployment. */
  env: string | null;
  /** A `previews` block: the bindings of unreviewed preview deployments of this block. */
  preview: boolean;
  where: string;
  /** The block's own `name`, as written. */
  name: string | undefined;
  /** The name the block deploys as; undefined for a preview or a config with no top-level name. */
  deployedName: string | undefined;
  unknownKeys: string[];
  bindings: Bindings;
  routes: Array<z.infer<typeof RouteSchema>>;
  migrations: Array<z.infer<typeof MigrationSchema>>;
  exports: Record<string, z.infer<typeof ExportSchema>>;
  /**
   * The observability settings the block deploys with. Wrangler inherits `observability` whole
   * into a named environment that leaves it out, so this is the block's own or the top level's.
   */
  observability: z.infer<typeof ObservabilitySchema> | undefined;
  /** The block's own `triggers`; a named environment that leaves it out inherits the top level's. */
  triggers: z.infer<typeof TriggersSchema> | undefined;
};

export function parseWorkerConfig(path: string, raw: unknown): WorkerConfig {
  const parsed = WorkerConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path}: ${z.prettifyError(parsed.error)}`);
  return { path, config: parsed.data };
}

/**
 * Every Wrangler config in the checkout that a deploy can read, tracked or untracked, test
 * fixtures included (`cloud-agent-e2e-deploy.yml` deploys `test/e2e/wrangler.fake-llm.jsonc`).
 * Ignored files stay out: they are configs a script renders at deploy time from a tracked config
 * this scan already reads (`wrangler.runtime-generated.json`, `.wrangler/wrangler.e2e-test.jsonc`).
 */
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

/** A `wrangler.json` or `wrangler.jsonc` entry, of any file type, that the deploy job can reach. */
export type DeployConfigEntry = { path: string; directory: boolean };

/**
 * Every entry named `wrangler.json` or `wrangler.jsonc` under `services/`, by `lstat` (a broken
 * symlink and a directory count, symlinked directories are not followed), ignored or not, skipping
 * `node_modules` as the deploy job's `find` does, plus a `wrangler.json` at the repository root.
 * The deploy runs Wrangler in `services/<svc>/` with no `--config`, and Wrangler takes the first
 * `wrangler.json` there or in any parent before it looks for `wrangler.jsonc`.
 */
export function deployConfigEntries(root: string): DeployConfigEntry[] {
  const entries: DeployConfigEntry[] = [];
  const rootConfig = lstatSync(join(root, 'wrangler.json'), { throwIfNoEntry: false });
  if (rootConfig) entries.push({ path: 'wrangler.json', directory: rootConfig.isDirectory() });
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = `${dir}/${entry.name}`;
      if (/^wrangler\.jsonc?$/.test(entry.name)) {
        entries.push({ path, directory: entry.isDirectory() });
      }
      if (entry.isDirectory()) walk(path);
    }
  };
  walk('services');
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** Every path the index tracks: a symlink is one entry, whatever it points at. */
export function trackedPaths(root: string): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(listed.split('\0').filter(Boolean))].sort();
}

function blockOf(
  where: string,
  env: string | null,
  block: Environment,
  allowed: ReadonlySet<string>,
  deployedName: string | undefined,
  inheritedObservability: z.infer<typeof ObservabilitySchema> | undefined
): Block[] {
  const observability = block.observability ?? inheritedObservability;
  const own: Block = {
    env,
    preview: false,
    where,
    name: block.name,
    deployedName,
    unknownKeys: Object.keys(block).filter(key => !allowed.has(key)),
    bindings: block,
    routes: [...(block.route === undefined ? [] : [block.route]), ...(block.routes ?? [])],
    migrations: block.migrations ?? [],
    exports: block.exports ?? {},
    observability,
    triggers: block.triggers,
  };
  if (block.previews === undefined) return [own];
  const preview: Block = {
    env,
    preview: true,
    where: `${where} previews`,
    name: undefined,
    deployedName: undefined,
    unknownKeys: Object.keys(block.previews).filter(key => !PREVIEW_KEYS.has(key)),
    bindings: block.previews,
    routes: [],
    migrations: [],
    exports: {},
    observability: block.previews.observability ?? observability,
    triggers: undefined,
  };
  return [own, preview];
}

function blocksOf({ path, config }: WorkerConfig): Block[] {
  // Wrangler inherits neither bindings nor vars into a named environment, so each block stands on
  // its own; an absent `name` deploys as `<top-level name>-<env>`.
  return [
    ...blockOf(
      `${path} (top level)`,
      null,
      config,
      TOP_LEVEL_KEYS,
      config.name,
      config.observability
    ),
    ...Object.entries(config.env ?? {}).flatMap(([env, block]) =>
      blockOf(
        `${path} (env.${env})`,
        env,
        block,
        ENVIRONMENT_KEYS,
        block.name ?? (config.name === undefined ? undefined : `${config.name}-${env}`),
        config.observability
      )
    ),
  ];
}

function stsBindingProblems(
  caller: string | undefined,
  block: Block,
  binding: ServiceBinding,
  workerBindingPolicies: ReadonlyMap<string, Policy>
): string[] {
  const where = `${block.where}: ${binding.binding}`;
  if (block.preview) {
    return [`${where} binds ${binding.service}; a preview runs unreviewed code and binds no STS`];
  }
  const problems: string[] = [];
  const expected = block.env === null ? 'sts' : `sts-${block.env}`;
  if (binding.entrypoint !== STS_ENTRYPOINT) {
    problems.push(
      `${where} binds ${binding.service} at entrypoint ${binding.entrypoint ?? '(default)'}; only ${STS_ENTRYPOINT} is public`
    );
  }
  if (binding.environment !== undefined) {
    problems.push(
      `${where} names service environment ${binding.environment}; bind the deployed name ${expected}`
    );
  }
  if (binding.service !== expected) {
    problems.push(`${where} binds ${binding.service}; this block must bind ${expected}`);
  }
  if (!STS_DEPLOYMENTS.has(expected)) {
    problems.push(
      `${block.where}: STS does not deploy ${expected}, so env ${block.env} cannot bind it`
    );
  }
  if (caller === undefined) {
    problems.push(`${block.where}: a config with no top-level name binds STS`);
    return problems;
  }
  if (binding.props?.caller !== caller) {
    problems.push(
      `${where} sets props.caller ${JSON.stringify(binding.props?.caller)}; expected the top-level name ${caller}`
    );
  }
  const policy = workerBindingPolicies.get(caller);
  const served = STS_DEPLOYMENTS.get(binding.service);
  if (policy === undefined) {
    problems.push(`${block.where}: caller ${caller} has no worker-binding policy`);
  } else if (served !== undefined && !policy.environments.includes(served)) {
    problems.push(
      `${block.where}: policy ${caller} does not list ${served}, which ${binding.service} serves`
    );
  }
  return problems;
}

/** The account's one Secrets Store; production and non-production secrets share it by suffix. */
const PRODUCTION_SECRETS_STORE = '342a86d9e3a94da698e82d0c6e2a36f0';
const NON_PRODUCTION_SECRET = /_(DEV|DEVELOPMENT|LOCAL|STAGING|TEST)$/;

/**
 * Settings that keep a secret-holding Worker's material out of places STS does not control: the
 * Worker that holds secrets (STS, the relay, or any config that binds STS) records no traces,
 * since a trace keeps outbound URLs (a Slack webhook URL is a secret) and Durable Object SQL
 * bindings (STS writes its webhook secret through one). A non-production block of a config that
 * binds STS reads no production secret from the shared Secrets Store and runs no production
 * schedule, so an accidental `wrangler deploy --env local` cannot act as production.
 */
function secretHolderProblems(
  blocks: readonly Block[],
  bindsSts: boolean,
  productionCrons: readonly string[]
): string[] {
  const problems: string[] = [];
  for (const block of blocks) {
    const traces = block.observability?.traces?.enabled;
    if (traces !== false) {
      problems.push(
        `${block.where}: observability.traces.enabled resolves to ${String(traces)}; it must be false, as a trace records outbound URLs and Durable Object SQL bindings`
      );
    }
    if (!bindsSts || (block.env === null && !block.preview)) continue;
    for (const secret of block.bindings.secrets_store_secrets ?? []) {
      if (
        secret.store_id === PRODUCTION_SECRETS_STORE &&
        !NON_PRODUCTION_SECRET.test(secret.secret_name)
      ) {
        problems.push(
          `${block.where}: ${secret.binding} reads ${secret.secret_name} from the production Secrets Store; a non-production block reads only a _DEV, _DEVELOPMENT, _LOCAL, _STAGING or _TEST secret there`
        );
      }
    }
    if (block.preview || productionCrons.length === 0) continue;
    const crons = block.triggers?.crons;
    if (crons === undefined) {
      problems.push(
        `${block.where} inherits the production crons ${JSON.stringify(productionCrons)}; set triggers.crons to []`
      );
    } else if (block.env !== 'staging' && crons.length > 0) {
      problems.push(
        `${block.where} sets triggers.crons ${JSON.stringify(crons)}; only staging may run schedules outside production, so set []`
      );
    }
  }
  return problems;
}

function grantProblem(
  grants: readonly Grant[],
  worker: string | undefined,
  resource: string,
  what: string
): string[] {
  if (
    grants.some(([granted, grantedResource]) => granted === worker && grantedResource === resource)
  ) {
    return [];
  }
  const allowed = grants.filter(([, granted]) => granted === resource).map(([name]) => name);
  return [`${what}; ${allowed.length > 0 ? `only ${allowed.join(', ')} may` : 'no Worker may'}`];
}

/**
 * An audit batch is trusted as the producing STS deployment's own stream, so a foreign producer
 * could forge one, and a foreign consumer (or dead-letter target) would take batches from the relay.
 */
function auditQueueProblems(block: Block): string[] {
  const worker = block.deployedName;
  const { producers = [], consumers = [] } = block.bindings.queues ?? {};
  const problems: string[] = [];
  for (const { binding, queue } of producers) {
    if (!isAuditQueue(queue)) continue;
    problems.push(
      ...grantProblem(
        AUDIT_QUEUE_PRODUCERS,
        worker,
        queue,
        `${block.where}: ${binding} produces to ${queue}`
      )
    );
  }
  for (const { queue, dead_letter_queue: deadLetter } of consumers) {
    if (isAuditQueue(queue)) {
      problems.push(
        ...grantProblem(AUDIT_QUEUE_CONSUMERS, worker, queue, `${block.where} consumes ${queue}`)
      );
    }
    if (deadLetter !== undefined && isAuditQueue(deadLetter)) {
      problems.push(
        ...grantProblem(
          AUDIT_QUEUE_DEAD_LETTERS,
          worker,
          deadLetter,
          `${block.where} dead-letters ${queue} into ${deadLetter}`
        )
      );
    }
  }
  return problems;
}

function archiveBucketProblems(block: Block): string[] {
  const problems: string[] = [];
  for (const bucket of block.bindings.r2_buckets ?? []) {
    for (const [field, name] of [
      ['bucket_name', bucket.bucket_name],
      ['preview_bucket_name', bucket.preview_bucket_name],
    ] as const) {
      if (name === undefined || !isArchiveBucket(name)) continue;
      const what = `${block.where}: ${bucket.binding} names ${name} in ${field}`;
      const refused = grantProblem(AUDIT_ARCHIVE_BUCKETS, block.deployedName, name, what);
      problems.push(...refused);
      if (
        refused.length === 0 &&
        EU_ARCHIVE_BUCKETS.includes(name) &&
        bucket.jurisdiction !== 'eu'
      ) {
        problems.push(
          `${what} without jurisdiction eu; only the EU bucket exists and carries the lock rules`
        );
      }
    }
  }
  return problems;
}

/** References that reach into another Worker's classes or handlers rather than its public entrypoint. */
function internalReferenceProblems(block: Block): string[] {
  const { bindings } = block;
  const references: Array<[what: string, target: string | undefined]> = [
    ...(bindings.workflows ?? []).map((workflow): [string, string | undefined] => [
      `workflow ${workflow.binding} script_name`,
      workflow.script_name,
    ]),
    ...[...(bindings.tail_consumers ?? []), ...(bindings.streaming_tail_consumers ?? [])].map(
      (consumer): [string, string] => ['a tail consumer', consumer.service]
    ),
    ...(bindings.dispatch_namespaces ?? []).map((namespace): [string, string | undefined] => [
      `dispatch namespace ${namespace.binding} outbound`,
      namespace.outbound?.service,
    ]),
    ...block.migrations.flatMap(migration =>
      (migration.transferred_classes ?? []).map((transfer): [string, string] => [
        `migration ${migration.tag} transferred_classes ${transfer.from} from_script`,
        transfer.from_script,
      ])
    ),
  ];
  const problems = references
    .filter((reference): reference is [string, string] => {
      const target = reference[1];
      return target !== undefined && isInternalName(target);
    })
    .map(
      ([what, target]) =>
        `${block.where}: ${what} names ${target}; its classes and handlers are internal`
    );
  for (const object of bindings.durable_objects?.bindings ?? []) {
    const script = object.script_name;
    if (script !== undefined && isInternalName(script)) {
      problems.push(
        `${block.where}: ${object.name} binds Durable Object class ${object.class_name} of ${script}; its Durable Objects are internal`
      );
    }
  }
  for (const [name, entry] of Object.entries(block.exports)) {
    for (const key of Object.keys(entry).filter(key => !EXPORT_KEYS.includes(key))) {
      problems.push(`${block.where}: export ${name} has unmodelled key ${key}`);
    }
    const from = entry.transfer_from;
    if (from !== undefined && from.split(/[^a-z0-9-]+/).some(isInternalName)) {
      problems.push(
        `${block.where}: export ${name} transfer_from names ${from}; its classes and handlers are internal`
      );
    }
  }
  return problems;
}

function routeProblems(block: Block, owner: string | undefined): string[] {
  const problems: string[] = [];
  for (const { pattern } of block.routes) {
    const host = pattern.replace(/^[a-z*]+:\/\//, '').split('/')[0];
    for (const [internal, internalOwner] of INTERNAL_HOSTS) {
      const covers =
        host === internal || (host.startsWith('*') && internal.endsWith(host.slice(1)));
      if (covers && owner !== internalOwner) {
        problems.push(
          `${block.where}: route ${pattern} covers ${internal}, which only the ${internalOwner} config serves`
        );
      }
    }
  }
  return problems;
}

/** A preview binds no STS, so only the deployed blocks count. */
function bindsStsAnywhere(blocks: readonly Block[]): boolean {
  return blocks.some(
    block =>
      !block.preview && (block.bindings.services ?? []).some(binding => isStsName(binding.service))
  );
}

/**
 * Problems with how the repository's Worker configs reach STS and the audit relay. The only way in
 * is a `SecretsBroker` service binding whose `props.caller` names the binding Worker. STS trusts
 * `props` because only a deploy in the account can set them (design 6.4), so these rules keep one
 * config from claiming another Worker's caller name, from reaching another environment's STS, and
 * from reaching an internal class, audit queue, archive bucket or hostname directly.
 */
export function workerConfigProblems(
  configs: readonly WorkerConfig[],
  policies: readonly Policy[]
): string[] {
  const problems: string[] = [];
  const workerBindingPolicies = new Map(
    policies
      .filter(policy => policy.identity.kind === 'worker-binding')
      .map(policy => [policy.workload, policy])
  );

  const pathsByName = new Map<string, string[]>();
  for (const { path, config } of configs) {
    if (config.name === undefined) continue;
    pathsByName.set(config.name, [...(pathsByName.get(config.name) ?? []), path]);
  }
  for (const [name, paths] of pathsByName) {
    if (paths.length > 1) problems.push(`top-level name ${name} is shared by ${paths.join(', ')}`);
  }

  for (const worker of configs) {
    const caller = worker.config.name;
    const blocks = blocksOf(worker);
    const bindsSts = bindsStsAnywhere(blocks);
    for (const block of blocks) {
      for (const key of block.unknownKeys) {
        problems.push(
          `${block.where}: unmodelled key ${key}; classify it in test/repo/worker-configs.ts`
        );
      }
      if (block.bindings.unsafe !== undefined) {
        problems.push(`${block.where}: unsafe is refused; no rule here can read its bindings`);
      }
      const owner = DEPLOYMENT_OWNERS.get(block.deployedName ?? '');
      if (owner !== undefined && caller !== owner) {
        problems.push(
          `${block.where} deploys as ${block.deployedName}, which only the ${owner} config deploys`
        );
      }
      const external = EXTERNAL_WORKLOADS.get(block.deployedName ?? '');
      if (external !== undefined) {
        problems.push(
          `${block.where} deploys as ${block.deployedName}, whose config lives in ${external}`
        );
      }
      problems.push(...routeProblems(block, caller));
      problems.push(...internalReferenceProblems(block));
      problems.push(...auditQueueProblems(block));
      problems.push(...archiveBucketProblems(block));
      for (const binding of block.bindings.services ?? []) {
        if (isAuditRelayName(binding.service)) {
          problems.push(
            `${block.where}: ${binding.binding} binds ${binding.service}; no Worker binds the audit relay`
          );
        } else if (isStsName(binding.service)) {
          problems.push(...stsBindingProblems(caller, block, binding, workerBindingPolicies));
        }
      }
    }
    if (caller === 'sts' || caller === 'audit-relay' || bindsSts) {
      problems.push(...secretHolderProblems(blocks, bindsSts, worker.config.triggers?.crons ?? []));
    }
    // `props.caller` is the top-level name in every block, so every block of a config that binds
    // STS must deploy as that Worker: the top level as itself, each env block as `<name>-<env>`.
    if (!bindsSts || caller === undefined) continue;
    for (const block of blocks) {
      if (
        block.env !== null &&
        block.name !== undefined &&
        block.name !== `${caller}-${block.env}`
      ) {
        problems.push(
          `${block.where} deploys as ${block.name}; a config that binds STS as ${caller} names it ${caller}-${block.env} or leaves it out`
        );
      }
    }
  }
  return problems;
}

/**
 * Problems with the deployment lists above: the one STS config must deploy exactly STS_DEPLOYMENTS
 * with matching `STS_ENVIRONMENT` vars, and an audit-relay config, once the repository has one,
 * exactly AUDIT_RELAY_DEPLOYMENTS.
 */
export function internalWorkerProblems(configs: readonly WorkerConfig[]): string[] {
  const problems: string[] = [];
  const deployments = (worker: WorkerConfig) => blocksOf(worker).filter(block => !block.preview);
  const sts = configs.filter(({ config }) => config.name === 'sts');
  if (sts.length !== 1) problems.push(`expected one config named sts, found ${sts.length}`);
  const expectedSts = [...STS_DEPLOYMENTS]
    .map(([name, environment]) => `${name}=${environment}`)
    .sort()
    .join(', ');
  for (const worker of sts) {
    const deployed = deployments(worker)
      .map(block => `${block.deployedName}=${String(block.bindings.vars?.STS_ENVIRONMENT)}`)
      .sort()
      .join(', ');
    if (deployed !== expectedSts) {
      problems.push(`${worker.path} deploys ${deployed}; STS_DEPLOYMENTS lists ${expectedSts}`);
    }
  }
  const expectedRelay = [...AUDIT_RELAY_DEPLOYMENTS].sort().join(', ');
  for (const worker of configs.filter(({ config }) => config.name === 'audit-relay')) {
    const deployed = deployments(worker)
      .map(block => String(block.deployedName))
      .sort()
      .join(', ');
    if (deployed !== expectedRelay) {
      problems.push(
        `${worker.path} deploys ${deployed}; AUDIT_RELAY_DEPLOYMENTS lists ${expectedRelay}`
      );
    }
  }
  return problems;
}

/**
 * Problems with the worker-binding policies: each one's workload is a config here that binds STS
 * under that top-level name, or is listed in EXTERNAL_WORKLOADS, so a policy whose Worker lives in
 * another repository is always one the deploy-name rule above protects. Every listed external
 * workload has a worker-binding policy.
 */
export function workerBindingPolicyProblems(
  configs: readonly WorkerConfig[],
  policies: readonly Policy[]
): string[] {
  const problems: string[] = [];
  const workloads = policies
    .filter(policy => policy.identity.kind === 'worker-binding')
    .map(policy => policy.workload);
  for (const workload of workloads) {
    if (EXTERNAL_WORKLOADS.has(workload)) continue;
    const bindsHere = configs.some(
      worker => worker.config.name === workload && bindsStsAnywhere(blocksOf(worker))
    );
    if (!bindsHere) {
      problems.push(
        `policy ${workload} has no config here that binds STS as ${workload}; list it in EXTERNAL_WORKLOADS if another repository holds its config`
      );
    }
  }
  for (const [workload, repository] of EXTERNAL_WORKLOADS) {
    if (!workloads.includes(workload)) {
      problems.push(
        `EXTERNAL_WORKLOADS lists ${workload} (${repository}), which has no worker-binding policy`
      );
    }
  }
  return problems;
}
