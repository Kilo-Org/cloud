/**
 * Personal runtime candidate tooling (plan §5) — pure core.
 *
 * Command execution and context inspection live in
 * `runtime-personal-candidate-cli.ts`. This module holds the reviewable
 * contract: the personal store wrapper, source/toolchain inspection, personal
 * target validation, config rendering/validation, build-context resolution, and
 * the seal/verify comparison.
 *
 * It never writes production authority indexes, never rewrites the operator's
 * prepared config, and never admits a base without trusted CI evidence.
 */

import path from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';
import { z } from 'zod';

import {
  publishImmutableObject,
  RUNTIME_ARTIFACT_OBJECT_PREFIX,
  RUNTIME_ARTIFACT_RELEASE_PREFIX,
  type ArtifactObjectStore,
} from '../src/sandbox-control/runtime-artifact-store.js';
import {
  RUNTIME_BASE_ABI,
  parseTrustedRuntimeArtifactOrigin,
} from '../src/shared/runtime-release.js';
import { sha256 } from './publish-runtime.js';
import { type BaseEvidence, readNativeBaseEvidence } from './runtime-ci-release.js';

export const PERSONAL_CANDIDATE_FORMAT = 'kilo-runtime-personal-candidate-v1';
export const NATIVE_CONTAINER_CLASS = 'SandboxContainers';
export const NATIVE_CONTAINER_BINDING = 'SANDBOX_CONTAINERS';
export const PERSONAL_WRANGLER_CONFIG_NAME = 'wrangler.personal-candidate.jsonc';
export const DEFAULT_PERSONAL_CONFIG_PATH = '.wrangler/personal/wrangler.jsonc';

export const PERSONAL_PROVENANCE_PREFIX = 'runtime-artifacts/v1/personal/';

/** Writes the personal tooling may perform. Everything else is refused. */
export const ALLOWED_WRITE_PREFIXES = [
  RUNTIME_ARTIFACT_OBJECT_PREFIX,
  RUNTIME_ARTIFACT_RELEASE_PREFIX,
  PERSONAL_PROVENANCE_PREFIX,
] as const;
export const REFUSED_WRITE_PREFIXES = [
  'runtime-artifacts/v1/inputs/',
  'runtime-artifacts/v1/bases/',
] as const;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const managedImageSchema = z
  .string()
  .regex(/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/);

// ---------------------------------------------------------------------------
// Personal artifact store
// ---------------------------------------------------------------------------

/**
 * Wrap a store so personal publication can reuse shared content-addressed
 * objects and release evidence while it is structurally unable to write the
 * production authority indexes (`inputs/`, `bases/`) or any other prefix.
 * Reads pass through so trusted evidence stays readable.
 */
export function personalArtifactStore(base: ArtifactObjectStore): ArtifactObjectStore {
  const assertKey = (key: string) => {
    if (
      !/^runtime-artifacts\/v1\/[a-z0-9._/-]+$/.test(key) ||
      key.split('/').some(part => part === '.' || part === '..' || part.length === 0)
    )
      throw new Error('personal artifact keys must be canonical');
  };
  return {
    async putIfAbsent(key, bytes, contentType) {
      assertKey(key);
      const allowed = ALLOWED_WRITE_PREFIXES.some(prefix => key.startsWith(prefix));
      if (!allowed) {
        const refused = REFUSED_WRITE_PREFIXES.find(prefix => key.startsWith(prefix));
        throw new Error(
          refused !== undefined
            ? `personal tooling refused a production authority write under ${refused}`
            : 'personal tooling refused a write outside the shared/personal prefixes'
        );
      }
      return base.putIfAbsent(key, bytes, contentType);
    },
    getBytes: async key => {
      assertKey(key);
      return base.getBytes(key);
    },
  };
}

export function personalRuntimeEvidenceKey(inputSha: string): string {
  return `${PERSONAL_PROVENANCE_PREFIX}runtime-inputs/${hashSchema.parse(inputSha)}.json`;
}

export function personalCandidateKey(recordSha: string): string {
  return `${PERSONAL_PROVENANCE_PREFIX}candidates/${hashSchema.parse(recordSha)}.json`;
}

export async function publishPersonalProvenance(
  store: ArtifactObjectStore,
  key: string,
  value: unknown
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  await publishImmutableObject(store, {
    key,
    bytes,
    expectedSha256: sha256(bytes),
    contentType: 'application/json',
  });
}

// ---------------------------------------------------------------------------
// Source and toolchain facts
// ---------------------------------------------------------------------------

export type CommandRunner = (
  program: string,
  args: string[],
  options?: { cwd?: string }
) => Promise<{ stdout: string }>;

export type SourceFacts = {
  commitSha: string;
  treeSha: string;
  branch: string;
  branchHeadSha: string;
  dirty: boolean;
};

/**
 * Read the ACTUAL committed source identity from the admitted checkout:
 * HEAD, `HEAD^{tree}`, the named branch head, and the working-tree state.
 */
export async function readSourceFacts(
  runner: CommandRunner,
  checkoutRoot: string,
  branch: string
): Promise<SourceFacts> {
  const git = async (args: string[]) =>
    (await runner('git', args, { cwd: checkoutRoot })).stdout.trim();
  const commitSha = await git(['rev-parse', 'HEAD']);
  const treeSha = await git(['rev-parse', 'HEAD^{tree}']);
  await git(['check-ref-format', '--branch', branch]);
  const branchHeadSha = await git(['rev-parse', `refs/heads/${branch}`]);
  const dirty = (await git(['status', '--porcelain'])).length > 0;
  return { commitSha, treeSha, branch, branchHeadSha, dirty };
}

/** Fail unless the facts are an exact, clean, named feature-branch checkout. */
export function assertFeatureSource(
  source: Pick<SourceFacts, 'branch' | 'branchHeadSha'>,
  expectedSha: string
): void {
  sourceShaSchema.parse(expectedSha);
  sourceShaSchema.parse(source.branchHeadSha);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(source.branch) ||
    source.branch.startsWith('refs/') ||
    source.branch === 'HEAD'
  )
    throw new Error('a named feature branch is required; detached HEAD is refused');
  if (source.branch === 'main' || source.branch === 'master')
    throw new Error(
      `refusing mainline branch ${source.branch}; the personal candidate is feature-only`
    );
  if (source.branchHeadSha !== expectedSha)
    throw new Error(`branch ${source.branch} does not resolve to the requested feature SHA`);
}

export function assertAdmittedSource(source: SourceFacts, expectedSha: string): void {
  assertFeatureSource(source, expectedSha);
  sourceShaSchema.parse(source.treeSha);
  if (source.dirty) throw new Error('the admitted checkout is dirty; refuse to admit it');
  if (source.commitSha !== expectedSha)
    throw new Error('the admitted checkout HEAD does not match the requested feature SHA');
}

export type Toolchain = { bun: string; pnpm: string; lockSha256: string };

export async function readToolchain(
  runner: CommandRunner,
  checkoutRoot: string,
  readFile: (absolutePath: string) => Promise<Uint8Array>
): Promise<Toolchain> {
  const bun = (await runner('bun', ['--version'], { cwd: checkoutRoot })).stdout.trim();
  const pnpm = (await runner('pnpm', ['--version'], { cwd: checkoutRoot })).stdout.trim();
  const lockSha256 = sha256(await readFile(path.join(checkoutRoot, 'pnpm-lock.yaml')));
  if (bun.length === 0 || pnpm.length === 0)
    throw new Error('could not read the bun/pnpm toolchain versions');
  return { bun, pnpm, lockSha256 };
}

// ---------------------------------------------------------------------------
// Trusted native base
// ---------------------------------------------------------------------------

/**
 * Resolve trusted base evidence from the protected CI index (READ ONLY) and
 * re-verify the registry digest. There is no digest-claim escape: a missing
 * record or an absent verifier refuses qualification.
 */
export async function admitTrustedNativeBase(options: {
  store: ArtifactObjectStore;
  baseSha256: string;
  accountId: string;
  verify?: (base: BaseEvidence) => Promise<void>;
}): Promise<BaseEvidence> {
  const base = await readNativeBaseEvidence(options.store, options.baseSha256);
  if (base === null)
    throw new Error(
      'no trusted native base evidence exists for the current base inputs; runtime-only candidates are qualified, base changes are refused'
    );
  if (!base.image.startsWith(`registry.cloudflare.com/${options.accountId}/`))
    throw new Error('trusted base evidence belongs to a different account');
  if (options.verify === undefined)
    throw new Error(
      'a registry/base verifier is required; refusing trusted evidence without re-verification'
    );
  await options.verify(base);
  return base;
}

// ---------------------------------------------------------------------------
// Personal target (operator-prepared config, read-only input)
// ---------------------------------------------------------------------------

const imageSpecSchema = z
  .object({ dockerfile: z.string().optional(), image: z.string().optional() })
  .passthrough();
const containerEntrySchema = z
  .object({
    class_name: z.string(),
    image: z.string().optional(),
    images: z.record(z.string(), imageSpecSchema).optional(),
  })
  .passthrough();
const migrationSchema = z.record(z.string(), z.unknown());
const queueBindingSchema = z
  .object({ queue: z.string().min(1), dead_letter_queue: z.string().min(1).optional() })
  .passthrough();
const personalConfigSchema = z
  .object({
    name: z.string(),
    account_id: z.string().regex(/^[a-f0-9]{32}$/),
    main: z.string(),
    routes: z.unknown().optional(),
    vars: z.record(z.string(), z.unknown()).default({}),
    r2_buckets: z.array(z.object({ binding: z.string(), bucket_name: z.string() }).passthrough()),
    containers: z.array(containerEntrySchema),
    durable_objects: z
      .object({
        bindings: z.array(
          z
            .object({
              class_name: z.string(),
              name: z.string(),
              script_name: z.string().optional(),
            })
            .passthrough()
        ),
      })
      .passthrough()
      .optional(),
    migrations: z.array(migrationSchema).default([]),
    env: z.record(z.string(), z.unknown()).optional(),
    queues: z
      .object({
        consumers: z.array(queueBindingSchema).optional(),
        producers: z.array(queueBindingSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type PersonalTarget = {
  workerName: string;
  accountId: string;
  bucket: string;
  className: string;
  bindingName: string;
  origin: string;
  migrationsSha256: string;
  preparedConfigSha256: string;
};

const PERSONAL_NAME_PATTERN = /^cloud-agent-next-[a-z0-9][a-z0-9-]*-test$/;
const FORBIDDEN_NAME_PATTERN = /(^|-)(production|prod|staging|e2e)(-|$)/;

export function isPersonalWorkerName(name: string): boolean {
  return PERSONAL_NAME_PATTERN.test(name) && !FORBIDDEN_NAME_PATTERN.test(name);
}

function assertOwnDurableBindings(bindings: readonly { script_name?: string }[]): void {
  if (bindings.some(binding => binding.script_name !== undefined))
    throw new Error('personal Durable Object bindings must not redirect to another script');
}

/**
 * Validate an OPERATOR-PREPARED personal config. The config is an input only:
 * this reads it and never writes it. The committed source supplies the account,
 * release bucket, and exact migration lineage; the operator config supplies the
 * personal Worker name, origin, native class and binding.
 */
export function selectPersonalTarget(
  operatorConfigSource: string,
  committedConfigSource: string,
  options: { origin: string; bucket?: string }
): PersonalTarget {
  const operator = personalConfigSchema.parse(
    parseJsonc(operatorConfigSource, undefined, { allowTrailingComma: true })
  );
  const committed = personalConfigSchema.parse(
    parseJsonc(committedConfigSource, undefined, { allowTrailingComma: true })
  );
  if (!isPersonalWorkerName(operator.name))
    throw new Error('the target Worker name is not an explicit personal test name');
  if (operator.routes !== undefined || operator.route !== undefined)
    throw new Error('the personal config must not declare production routes or custom domains');
  if (operator.account_id !== committed.account_id)
    throw new Error('the personal config account does not match the committed source account');
  const origin = parseTrustedRuntimeArtifactOrigin(options.origin);
  if (origin === null) throw new Error('the requested origin must be a bare trusted HTTPS origin');
  const operatorWorkerUrl = operator.vars.WORKER_URL;
  if (typeof operatorWorkerUrl !== 'string' || operatorWorkerUrl !== origin)
    throw new Error('the personal config WORKER_URL must equal the requested artifact origin');
  const host = new URL(origin).hostname;
  if (host !== `${operator.name}.engineering-e11.workers.dev`)
    throw new Error('the artifact origin host does not match the target Worker name');
  assertOwnDurableBindings(operator.durable_objects?.bindings ?? []);
  const productionQueues = new Set(
    [...(committed.queues?.consumers ?? []), ...(committed.queues?.producers ?? [])].flatMap(
      entry => [
        entry.queue,
        ...(entry.dead_letter_queue === undefined ? [] : [entry.dead_letter_queue]),
      ]
    )
  );
  if (
    [...(operator.queues?.consumers ?? []), ...(operator.queues?.producers ?? [])].some(
      entry =>
        productionQueues.has(entry.queue) ||
        (entry.dead_letter_queue !== undefined && productionQueues.has(entry.dead_letter_queue))
    )
  )
    throw new Error('personal queue bindings must not use production queues');

  const native = operator.containers.find(entry => entry.class_name === NATIVE_CONTAINER_CLASS);
  if (native === undefined) throw new Error(`the personal config has no ${NATIVE_CONTAINER_CLASS}`);
  if (native.image !== undefined)
    throw new Error('the native class must not declare a top-level image');
  if (native.images === undefined || !('app' in native.images))
    throw new Error('the personal config native class must declare images.app');

  const binding = (operator.durable_objects?.bindings ?? []).find(
    entry => entry.name === NATIVE_CONTAINER_BINDING
  );
  if (binding === undefined || binding.class_name !== NATIVE_CONTAINER_CLASS)
    throw new Error(
      `the personal config must bind ${NATIVE_CONTAINER_BINDING} to ${NATIVE_CONTAINER_CLASS}`
    );
  if (binding.script_name !== undefined)
    throw new Error('the native class binding must not redirect to another script');

  const committedBucket = committed.r2_buckets.find(
    entry => entry.binding === 'RUNTIME_RELEASE_BUCKET'
  )?.bucket_name;
  const operatorBucket = operator.r2_buckets.find(
    entry => entry.binding === 'RUNTIME_RELEASE_BUCKET'
  )?.bucket_name;
  if (options.bucket !== undefined && options.bucket !== committedBucket)
    throw new Error('the personal candidate must use the committed shared runtime bucket');
  const bucket = committedBucket;
  if (bucket === undefined) throw new Error('the committed source has no RUNTIME_RELEASE_BUCKET');
  if (operatorBucket !== bucket)
    throw new Error('the personal config release bucket does not match the intended bucket');
  if (
    operator.r2_buckets.some(
      entry => entry.binding !== 'RUNTIME_RELEASE_BUCKET' && entry.bucket_name === bucket
    )
  )
    throw new Error('the personal release bucket must be separate from session storage');

  const committedMigrations = JSON.stringify(committed.migrations);
  if (JSON.stringify(operator.migrations) !== committedMigrations)
    throw new Error('the personal config migration lineage does not match the committed source');

  return {
    workerName: operator.name,
    accountId: operator.account_id,
    bucket,
    className: NATIVE_CONTAINER_CLASS,
    bindingName: NATIVE_CONTAINER_BINDING,
    origin,
    migrationsSha256: sha256(new TextEncoder().encode(committedMigrations)),
    preparedConfigSha256: sha256(new TextEncoder().encode(operatorConfigSource)),
  };
}

// ---------------------------------------------------------------------------
// Candidate configuration rendering and validation
// ---------------------------------------------------------------------------

export type PersonalConfigOptions = {
  descriptor: string;
  target: PersonalTarget;
  image: string;
};

/**
 * Render the sealed candidate config: the committed production config rebased
 * for `.wrangler/`, renamed to the personal Worker, native class reduced to a
 * single `images.app.image` from the ADMITTED base evidence, descriptor/origin
 * set explicitly, and the committed migration lineage carried through.
 */
export function renderPersonalCandidateConfig(
  operatorConfigSource: unknown,
  options: PersonalConfigOptions
): Record<string, unknown> {
  if (options.descriptor.length === 0) throw new Error('a runtime release descriptor is required');
  const origin = parseTrustedRuntimeArtifactOrigin(options.target.origin);
  if (origin === null) throw new Error('the artifact origin must be a bare trusted HTTPS origin');
  managedImageSchema.parse(options.image);

  const config = personalConfigSchema.parse(structuredClone(operatorConfigSource));
  if (config.name !== options.target.workerName || config.vars.WORKER_URL !== options.target.origin)
    throw new Error('candidate rendering requires the validated operator-prepared target');
  delete config.dev;
  delete config.env;
  delete config.routes;
  let matched = 0;
  config.containers = config.containers.map(entry => {
    const next = { ...entry };
    if (next.class_name !== options.target.className) return next;
    matched += 1;
    delete next.image;
    next.images = { app: { image: options.image } };
    return next;
  });
  if (matched !== 1)
    throw new Error(
      `the committed config must declare exactly one ${options.target.className} container class`
    );

  config.vars = {
    ...config.vars,
    WORKER_URL: origin,
    RUNTIME_RELEASE_DESCRIPTOR: options.descriptor,
    RUNTIME_ARTIFACT_ORIGIN: origin,
  };
  return config;
}

const explicitConfigSchema = z
  .object({
    name: z.string(),
    account_id: z.string(),
    main: z.string(),
    routes: z.unknown().optional(),
    vars: z.record(z.string(), z.unknown()),
    r2_buckets: z.array(z.object({ binding: z.string(), bucket_name: z.string() }).passthrough()),
    containers: z.array(containerEntrySchema),
    durable_objects: personalConfigSchema.shape.durable_objects,
    migrations: z.array(migrationSchema).optional(),
  })
  .passthrough();

export function assertExplicitNativeConfig(
  config: unknown,
  options: { descriptor: string; target: PersonalTarget }
): void {
  const parsed = explicitConfigSchema.parse(config);
  assertOwnDurableBindings(parsed.durable_objects?.bindings ?? []);
  if (parsed.name !== options.target.workerName)
    throw new Error('the candidate config targets a different Worker name');
  if (!/^(?:\.\.\/)*src\/index\.ts$/.test(parsed.main))
    throw new Error('the candidate config must use the production entrypoint, not the e2e entry');
  if (parsed.routes !== undefined) throw new Error('the candidate config must not declare routes');
  if (parsed.account_id !== options.target.accountId)
    throw new Error('the candidate account does not match the target');
  if (parsed.vars.WORKER_URL !== options.target.origin)
    throw new Error('the candidate control-plane URL does not match the target');
  if (
    sha256(new TextEncoder().encode(JSON.stringify(parsed.migrations))) !==
    options.target.migrationsSha256
  )
    throw new Error('the candidate migration lineage does not match the target');
  if (parsed.vars.RUNTIME_RELEASE_DESCRIPTOR !== options.descriptor)
    throw new Error('the candidate config does not embed the exact release descriptor');
  const configuredOrigin = parsed.vars.RUNTIME_ARTIFACT_ORIGIN;
  if (
    typeof configuredOrigin !== 'string' ||
    parseTrustedRuntimeArtifactOrigin(configuredOrigin) !== options.target.origin
  )
    throw new Error('the candidate config does not embed the trusted artifact origin');
  const bucket = parsed.r2_buckets.find(entry => entry.binding === 'RUNTIME_RELEASE_BUCKET');
  if (bucket?.bucket_name !== options.target.bucket)
    throw new Error('the candidate config release bucket does not match the target');
  const native = parsed.containers.filter(entry => entry.class_name === options.target.className);
  if (native.length !== 1)
    throw new Error(`the candidate config must declare exactly one ${options.target.className}`);
  const entry = native[0];
  if (entry.image !== undefined)
    throw new Error('the native class must not declare a top-level image');
  const imageKeys = Object.keys(entry.images ?? {});
  if (imageKeys.length !== 1 || imageKeys[0] !== 'app')
    throw new Error('the native class must declare images.app only');
  const app = entry.images?.app ?? {};
  const hasImage = typeof app.image === 'string' && app.image.length > 0;
  const hasDockerfile = typeof app.dockerfile === 'string' && app.dockerfile.length > 0;
  if (hasImage === hasDockerfile)
    throw new Error('the native images.app must declare exactly one of image or dockerfile');
  if (hasDockerfile)
    throw new Error(
      'a sealed managed candidate must use the admitted base image, not a Dockerfile'
    );
  const migrates = (parsed.migrations ?? []).some(migration =>
    Object.values(migration).some(
      value => Array.isArray(value) && value.includes(options.target.className)
    )
  );
  if (!migrates)
    throw new Error('the candidate config is missing the native class migration lineage');
  const bound = (parsed.durable_objects?.bindings ?? []).some(
    entry =>
      entry.name === options.target.bindingName &&
      entry.class_name === options.target.className &&
      entry.script_name === undefined
  );
  if (!bound) throw new Error('the candidate config is missing the native class binding');
}

// ---------------------------------------------------------------------------
// Build context
// ---------------------------------------------------------------------------

export type BuildContext = {
  main: { path: string; sha256: string };
  dockerfile: { path: string; sha256: string } | null;
  cwd: string;
};

export type BuildContextReader = (absolutePath: string) => Promise<Uint8Array>;

const buildContextConfigSchema = z
  .object({
    main: z.string(),
    containers: z.array(containerEntrySchema),
    env: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export function buildContextNativeContainers(
  config: unknown,
  className = NATIVE_CONTAINER_CLASS
): z.infer<typeof containerEntrySchema>[] {
  const parsed = buildContextConfigSchema.parse(config);
  const envDev = parsed.env?.dev as { containers?: unknown } | undefined;
  const containers = envDev?.containers ?? parsed.containers;
  return z
    .array(containerEntrySchema)
    .parse(containers)
    .filter(entry => entry.class_name === className);
}

/**
 * Resolve the entrypoint, native Dockerfile and cwd a Wrangler build would use
 * from the config's location, and hash the resolved bytes. Identical config
 * bytes at a different location resolve different paths, so relocation outside
 * the admitted checkout cannot pass verification.
 */
export async function resolveBuildContext(
  configPath: string,
  config: unknown,
  options: { read: BuildContextReader; className?: string; admittedRoot: string }
): Promise<BuildContext> {
  const parsed = buildContextConfigSchema.parse(config);
  const cwd = path.dirname(path.resolve(configPath));
  const mainPath = path.resolve(cwd, parsed.main);
  const admittedRoot = path.resolve(options.admittedRoot);
  if (!(mainPath === path.join(admittedRoot, 'src', 'index.ts')))
    throw new Error('the candidate entrypoint must resolve to the admitted src/index.ts');
  const native = buildContextNativeContainers(config, options.className);
  if (native.length !== 1)
    throw new Error('the candidate config must declare exactly one native container class');
  const dockerfile = native[0].images?.app?.dockerfile;
  let dockerfileContext: BuildContext['dockerfile'] = null;
  if (typeof dockerfile === 'string' && dockerfile.length > 0) {
    const dockerfilePath = path.resolve(cwd, dockerfile);
    if (!dockerfilePath.startsWith(`${admittedRoot}${path.sep}`))
      throw new Error('the native Dockerfile must stay inside the admitted checkout');
    dockerfileContext = {
      path: dockerfilePath,
      sha256: sha256(await options.read(dockerfilePath)),
    };
  }
  return {
    main: { path: mainPath, sha256: sha256(await options.read(mainPath)) },
    dockerfile: dockerfileContext,
    cwd: admittedRoot,
  };
}

// ---------------------------------------------------------------------------
// Seal
// ---------------------------------------------------------------------------

const candidateRecordSchema = z
  .object({
    format: z.literal(PERSONAL_CANDIDATE_FORMAT),
    source: z
      .object({ sha: sourceShaSchema, tree: sourceShaSchema, branch: z.string().min(1) })
      .strict(),
    inputs: z
      .object({
        runtimeSha256: hashSchema,
        baseSha256: hashSchema,
        cliVersion: z.string().min(1),
        wrapperSdkVersion: z.string().min(1),
      })
      .strict(),
    toolchain: z
      .object({ bun: z.string().min(1), pnpm: z.string().min(1), lockSha256: hashSchema })
      .strict(),
    descriptorSha256: hashSchema,
    artifacts: z.object({ cliSha256: hashSchema, controlSha256: hashSchema }).strict(),
    bundle: z.object({ sha256: hashSchema }).strict(),
    base: z
      .object({
        format: z.literal('kilo-native-base-v1'),
        inputSha256: hashSchema,
        image: managedImageSchema,
        sourceSha: sourceShaSchema,
        platform: z.literal('linux/amd64'),
        abi: z.literal(RUNTIME_BASE_ABI),
      })
      .strict(),
    target: z
      .object({
        workerName: z.string().min(1),
        accountId: z.string().regex(/^[a-f0-9]{32}$/),
        origin: z.string().min(1),
        className: z.string().min(1),
        bindingName: z.string().min(1),
        bucket: z.string().min(1),
        migrationsSha256: hashSchema,
        preparedConfigSha256: hashSchema,
      })
      .strict(),
    config: z
      .object({
        path: z.string().min(1),
        sha256: hashSchema,
        buildContext: z
          .object({
            main: z.object({ path: z.string().min(1), sha256: hashSchema }).strict(),
            dockerfile: z
              .object({ path: z.string().min(1), sha256: hashSchema })
              .strict()
              .nullable(),
            cwd: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    status: z.enum(['VERIFIED']),
  })
  .strict();
export type SealedCandidateRecord = z.infer<typeof candidateRecordSchema>;

export function sealCandidateRecord(record: unknown): {
  record: SealedCandidateRecord;
  bytes: Uint8Array;
  sha256: string;
} {
  const parsed = candidateRecordSchema.parse(record);
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  return { record: parsed, bytes, sha256: sha256(bytes) };
}

export function parseSealedCandidateRecord(value: unknown): SealedCandidateRecord {
  return candidateRecordSchema.parse(value);
}

/** The current, re-inspected facts a seal is verified against. */
export type CandidateContext = {
  inputs: SealedCandidateRecord['inputs'];
  source: SourceFacts & { expectedSha: string };
  toolchain: Toolchain;
  descriptorSha256: string;
  artifacts: { cliSha256: string; controlSha256: string };
  bundleSha256: string;
  base: BaseEvidence;
  target: PersonalTarget;
  configPath: string;
  configSha256: string;
  buildContext: BuildContext;
};

/** Deterministic JSON with sorted object keys, for order-insensitive compare. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Compare a sealed record with freshly inspected facts. Any source/tree,
 * toolchain, descriptor, artifact, bundle, base, target, config byte, or
 * resolved build-context drift fails. The sealed record is never modified.
 */
export function verifySealedCandidate(
  sealed: SealedCandidateRecord,
  current: CandidateContext
): void {
  if (current.source.dirty)
    throw new Error('verify: the admitted checkout has uncommitted changes');
  if (
    sealed.source.sha !== current.source.expectedSha ||
    sealed.source.sha !== current.source.commitSha
  )
    throw new Error('verify: source commit drifted from the sealed record');
  if (sealed.source.tree !== current.source.treeSha)
    throw new Error('verify: source tree drifted from the sealed record');
  if (sealed.source.branch !== current.source.branch)
    throw new Error('verify: source branch drifted from the sealed record');
  if (stable(sealed.toolchain) !== stable(current.toolchain))
    throw new Error('verify: toolchain drifted from the sealed record');
  if (stable(sealed.inputs) !== stable(current.inputs))
    throw new Error('verify: runtime inputs drifted from the sealed record');
  if (sealed.descriptorSha256 !== current.descriptorSha256)
    throw new Error('verify: release descriptor drifted from the sealed record');
  if (stable(sealed.artifacts) !== stable(current.artifacts))
    throw new Error('verify: runtime artifacts drifted from the sealed record');
  if (sealed.bundle.sha256 !== current.bundleSha256)
    throw new Error('verify: Worker bundle drifted from the sealed record');
  if (stable(sealed.base) !== stable(current.base))
    throw new Error('verify: admitted base drifted from the sealed record');
  if (stable(sealed.target) !== stable(current.target))
    throw new Error('verify: target drifted from the sealed record');
  if (sealed.config.path !== path.resolve(current.configPath))
    throw new Error('verify: candidate config was relocated outside the admitted context');
  if (sealed.config.sha256 !== current.configSha256)
    throw new Error('verify: candidate config bytes drifted from the sealed record');
  if (stable(sealed.config.buildContext) !== stable(current.buildContext))
    throw new Error('verify: resolved build context drifted from the sealed record');
}
