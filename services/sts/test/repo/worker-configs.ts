import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

/** [deployed Worker name, queue]: one right on an audit queue. */
type QueueGrant = readonly [worker: string, queue: string];

/** Each STS deployment produces only to its own environment's audit queue. */
export const AUDIT_QUEUE_PRODUCERS: readonly QueueGrant[] = [
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
export const AUDIT_QUEUE_CONSUMERS: readonly QueueGrant[] = [
  ['audit-relay', 'kilo-audit'],
  ['audit-relay', 'kilo-audit-dlq'],
  ['audit-relay-staging', 'kilo-audit-staging'],
  ['audit-relay-staging', 'kilo-audit-staging-dlq'],
  ['audit-relay-local', 'kilo-audit-local'],
  ['audit-relay-local', 'kilo-audit-local-dlq'],
];

export const AUDIT_QUEUE_DEAD_LETTERS: readonly QueueGrant[] = [
  ['audit-relay', 'kilo-audit-dlq'],
  ['audit-relay-staging', 'kilo-audit-staging-dlq'],
  ['audit-relay-local', 'kilo-audit-local-dlq'],
];

/**
 * The config (by top-level name) that alone may deploy each name the lists above grant rights to;
 * any other config deploying under one of these names would replace that Worker.
 */
const DEPLOYMENT_OWNERS: ReadonlyMap<string, string> = new Map<string, string>([
  ...[...STS_DEPLOYMENTS.keys()].map((name): [string, string] => [name, 'sts']),
  ...AUDIT_RELAY_DEPLOYMENTS.map((name): [string, string] => [name, 'audit-relay']),
  ['sts-test', 'sts-test'],
]);

const STS_ENTRYPOINT = 'SecretsBroker';

// Prefix matches, wider than the deployment lists on purpose: a binding to a name that only looks
// like STS or the relay fails here instead of slipping past an exact-name list.
const isStsName = (name: string) => name === 'sts' || name.startsWith('sts-');
const isAuditRelayName = (name: string) =>
  name === 'audit-relay' || name.startsWith('audit-relay-');
const isAuditQueue = (queue: string) => queue === 'kilo-audit' || queue.startsWith('kilo-audit-');

// A Wrangler config under one of these path segments is a test fixture no deploy reads.
const FIXTURE_SEGMENTS = new Set(['node_modules', 'test', 'tests', '__tests__', 'fixtures']);

const ServiceBindingSchema = z.object({
  binding: z.string(),
  service: z.string(),
  entrypoint: z.string().optional(),
  environment: z.string().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});

const DurableObjectBindingSchema = z.object({
  name: z.string(),
  class_name: z.string(),
  script_name: z.string().optional(),
});

const QueuesSchema = z.object({
  producers: z.array(z.object({ binding: z.string(), queue: z.string() })).optional(),
  consumers: z
    .array(z.object({ queue: z.string(), dead_letter_queue: z.string().optional() }))
    .optional(),
});

const BlockSchema = z.object({
  name: z.string().optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
  services: z.array(ServiceBindingSchema).optional(),
  durable_objects: z
    .object({ bindings: z.array(DurableObjectBindingSchema).optional() })
    .optional(),
  queues: QueuesSchema.optional(),
});

const WorkerConfigSchema = BlockSchema.extend({
  env: z.record(z.string(), BlockSchema).optional(),
});

export type WorkerConfig = { path: string; config: z.infer<typeof WorkerConfigSchema> };

type ServiceBinding = z.infer<typeof ServiceBindingSchema>;

type Block = {
  /** `null` for the top level, which is the production deployment. */
  env: string | null;
  where: string;
  /** The block's own `name`, as written. */
  name: string | undefined;
  /** The name the block deploys as; undefined when the config has no top-level name. */
  deployedName: string | undefined;
  vars: Record<string, unknown>;
  services: ServiceBinding[];
  durableObjects: Array<z.infer<typeof DurableObjectBindingSchema>>;
  queues: z.infer<typeof QueuesSchema>;
};

export function parseWorkerConfig(path: string, raw: unknown): WorkerConfig {
  const parsed = WorkerConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path}: ${z.prettifyError(parsed.error)}`);
  return { path, config: parsed.data };
}

/**
 * Every Wrangler config in the checkout that a deploy can read: tracked files, and untracked files
 * that are not ignored, so generated configs such as `wrangler.runtime-generated.json` stay out.
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
    .filter(path => !path.split('/').some(segment => FIXTURE_SEGMENTS.has(segment)))
    .filter(path => existsSync(join(root, path)))
    .sort();
}

function blocksOf({ path, config }: WorkerConfig): Block[] {
  const top: Block = {
    env: null,
    where: `${path} (top level)`,
    name: config.name,
    deployedName: config.name,
    vars: config.vars ?? {},
    services: config.services ?? [],
    durableObjects: config.durable_objects?.bindings ?? [],
    queues: config.queues ?? {},
  };
  // Wrangler inherits neither bindings nor vars into a named environment, so each block stands on
  // its own; an absent `name` deploys as `<top-level name>-<env>`.
  const named = Object.entries(config.env ?? {}).map(([env, block]): Block => ({
    env,
    where: `${path} (env.${env})`,
    name: block.name,
    deployedName: block.name ?? (config.name === undefined ? undefined : `${config.name}-${env}`),
    vars: block.vars ?? {},
    services: block.services ?? [],
    durableObjects: block.durable_objects?.bindings ?? [],
    queues: block.queues ?? {},
  }));
  return [top, ...named];
}

function stsBindingProblems(
  caller: string | undefined,
  block: Block,
  binding: ServiceBinding,
  workerBindingPolicies: ReadonlyMap<string, Policy>
): string[] {
  const problems: string[] = [];
  const where = `${block.where}: ${binding.binding}`;
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

function grantProblem(
  grants: readonly QueueGrant[],
  worker: string | undefined,
  queue: string,
  what: string
): string[] {
  if (grants.some(([granted, grantedQueue]) => granted === worker && grantedQueue === queue)) {
    return [];
  }
  const allowed = grants.filter(([, grantedQueue]) => grantedQueue === queue).map(([w]) => w);
  return [`${what}; ${allowed.length > 0 ? `only ${allowed.join(', ')} may` : 'no Worker may'}`];
}

/**
 * An audit batch is trusted as the producing STS deployment's own stream, so a foreign producer
 * could forge one, and a foreign consumer (or dead-letter target) would take batches from the relay.
 */
function auditQueueProblems(block: Block): string[] {
  const worker = block.deployedName;
  const problems: string[] = [];
  for (const { binding, queue } of block.queues.producers ?? []) {
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
  for (const { queue, dead_letter_queue: deadLetter } of block.queues.consumers ?? []) {
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

/**
 * Problems with how the repository's Worker configs reach STS and the audit relay. The only way in
 * is a `SecretsBroker` service binding whose `props.caller` names the binding Worker. STS trusts
 * `props` because only a deploy in the account can set them (design 6.4), so these rules keep one
 * config from claiming another Worker's caller name, from reaching another environment's STS, and
 * from reaching an internal Durable Object class or audit queue directly.
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
    let bindsSts = false;
    for (const block of blocks) {
      const deployed = block.deployedName ?? '';
      const owner = DEPLOYMENT_OWNERS.get(deployed);
      if (owner !== undefined && caller !== owner) {
        problems.push(
          `${block.where} deploys as ${deployed}, which only the ${owner} config deploys`
        );
      }
      problems.push(...auditQueueProblems(block));
      for (const object of block.durableObjects) {
        const script = object.script_name;
        if (script !== undefined && (isStsName(script) || isAuditRelayName(script))) {
          problems.push(
            `${block.where}: ${object.name} binds Durable Object class ${object.class_name} of ${script}; its Durable Objects are internal`
          );
        }
      }
      for (const binding of block.services) {
        if (isAuditRelayName(binding.service)) {
          problems.push(
            `${block.where}: ${binding.binding} binds ${binding.service}; no Worker binds the audit relay`
          );
        } else if (isStsName(binding.service)) {
          bindsSts = true;
          problems.push(...stsBindingProblems(caller, block, binding, workerBindingPolicies));
        }
      }
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
  const sts = configs.filter(({ config }) => config.name === 'sts');
  if (sts.length !== 1) problems.push(`expected one config named sts, found ${sts.length}`);
  const expectedSts = [...STS_DEPLOYMENTS]
    .map(([name, environment]) => `${name}=${environment}`)
    .sort()
    .join(', ');
  for (const worker of sts) {
    const deployed = blocksOf(worker)
      .map(block => `${block.deployedName}=${String(block.vars.STS_ENVIRONMENT)}`)
      .sort()
      .join(', ');
    if (deployed !== expectedSts) {
      problems.push(`${worker.path} deploys ${deployed}; STS_DEPLOYMENTS lists ${expectedSts}`);
    }
  }
  const expectedRelay = [...AUDIT_RELAY_DEPLOYMENTS].sort().join(', ');
  for (const worker of configs.filter(({ config }) => config.name === 'audit-relay')) {
    const deployed = blocksOf(worker)
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
