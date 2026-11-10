import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';
import {
  AUTO_ROUTERS,
  AutoRouterSchema,
  AutoRoutingDecisionResponseSchema,
  CLASSIFIER_WINNER_KV_KEY,
  ClassifierWinnerSchema,
  RoutingTableSchema,
  detectRequiredInputModalities,
  estimateRoutingTokens,
  normalizeClassifierInput,
  routingTableKvKey,
  type AutoRouter,
  type MirrorPayload,
} from '@kilocode/auto-routing-contracts';
import {
  Headers,
  Miniflare,
  Response,
  fetch,
  type Request,
  type MiniflareOptions,
  type WorkerOptions,
} from 'miniflare';
import * as z from 'zod';
import { parse as parseJsonc } from 'jsonc-parser';

const execFileAsync = promisify(execFile);

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptsDir, '../../..');
const ISOLATION_VIOLATION_HEADER = 'x-benchmark-isolation-violations';

// Must match services/auto-routing/wrangler.jsonc so the bundle runs under the production
// compatibility settings.
const COMPATIBILITY_DATE = '2026-05-15';
const COMPATIBILITY_FLAGS = ['nodejs_compat'];

const CLASSIFIER_URL = 'https://openrouter.ai/api/v1/systemone';
const CLASSIFIER_PATH = '/api/v1/systemone';
const USAGE_URL = 'http://benchmark-usage.invalid/api/internal/usage/record';
const MAX_BODY_BYTES = 64 * 1000 * 1000;

const EGRESS_SCRIPT = `export default { fetch: (request, env) => env.BROKER.fetch(request) };`;

const VersionSchema = z.enum(['baseline', 'candidate']);
type Version = z.infer<typeof VersionSchema>;

const KvSchema = z.record(z.string(), z.string());
const SnapshotSchema = z.object({
  baseline: z.object({ kv: KvSchema }),
  candidate: z.object({ kv: KvSchema }),
});
type Snapshot = z.infer<typeof SnapshotSchema>;

const RunIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const RouteRequestSchema = z.strictObject({
  runId: RunIdSchema,
  version: VersionSchema,
  router: AutoRouterSchema,
  messages: z.array(z.looseObject({ role: z.string().min(1) })).min(1),
});
const CloseRequestSchema = z.strictObject({ runId: RunIdSchema });

const CapabilityRowSchema = z.object({
  inputModalities: z.array(z.string()),
  contextLength: z.number().nullable(),
  isActive: z.boolean().nullable().optional(),
  absent: z.boolean().optional(),
});

const UsageRecordSchema = z.object({ core: z.object({ id: z.string(), cost: z.number() }) });

type VersionSummary = {
  classifierModel: string;
  classifierModelSource: 'classifier_model' | typeof CLASSIFIER_WINNER_KV_KEY;
  routers: Record<string, { tableVersion: string; models: number }>;
  tombstonedModels: string[];
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>
  ) {
    super(JSON.stringify(body));
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return fail(`${label} is not valid JSON`);
  }
}

// Every value the Worker could otherwise fetch from the benchmark origin or Postgres must be in
// the snapshot, so a decision can never degrade into an origin read.
function validateVersion(version: Version, kv: Record<string, string>): VersionSummary {
  const capabilitiesRaw = kv['model_capabilities_v2'];
  if (capabilitiesRaw === undefined) fail(`${version}: model_capabilities_v2 missing`);
  const capabilities = parseJson(capabilitiesRaw, `${version}: model_capabilities_v2`);
  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) {
    fail(`${version}: model_capabilities_v2 must be an object`);
  }
  const capabilityRows = new Map<string, z.infer<typeof CapabilityRowSchema>>();
  for (const [id, row] of Object.entries(capabilities)) {
    const parsed = CapabilityRowSchema.safeParse(row);
    if (!parsed.success) fail(`${version}: model_capabilities_v2 row ${id} is invalid`);
    capabilityRows.set(id, parsed.data);
  }

  const routers: VersionSummary['routers'] = {};
  const tombstoned = new Set<string>();
  for (const router of AUTO_ROUTERS) {
    const key = routingTableKvKey(router);
    const raw = kv[key];
    if (raw === undefined) fail(`${version}: ${key} missing`);
    const table = RoutingTableSchema.safeParse(parseJson(raw, `${version}: ${key}`));
    if (!table.success) fail(`${version}: ${key} fails RoutingTableSchema`);
    const models = new Set<string>();
    for (const route of Object.values(table.data.routes)) {
      for (const candidate of route) models.add(candidate.model);
    }
    const missing = [...models].filter(id => !capabilityRows.has(id));
    if (missing.length > 0) {
      fail(`${version}: ${router} table models lack capability rows: ${missing.join(', ')}`);
    }
    for (const id of models) {
      if (capabilityRows.get(id)?.absent === true) tombstoned.add(id);
    }
    routers[router] = { tableVersion: table.data.version, models: models.size };
  }

  const winnerRaw = kv[CLASSIFIER_WINNER_KV_KEY];
  if (winnerRaw === undefined) fail(`${version}: ${CLASSIFIER_WINNER_KV_KEY} missing`);
  const winner = ClassifierWinnerSchema.safeParse(
    parseJson(winnerRaw, `${version}: ${CLASSIFIER_WINNER_KV_KEY}`)
  );
  if (!winner.success) fail(`${version}: ${CLASSIFIER_WINNER_KV_KEY} fails ClassifierWinnerSchema`);

  const override = kv['classifier_model']?.trim() || null;
  return {
    classifierModel: override ?? winner.data.model,
    classifierModelSource: override === null ? CLASSIFIER_WINNER_KV_KEY : 'classifier_model',
    routers,
    tombstonedModels: [...tombstoned].sort(),
  };
}

function normalizeBrokerUrl(raw: string): string {
  const url = new URL(raw);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'];
  if (url.protocol !== 'http:' || !loopback.includes(url.hostname)) {
    fail('--broker-url must be an http loopback URL');
  }
  if (url.pathname !== '/' && url.pathname !== CLASSIFIER_PATH) {
    fail(`--broker-url path must be empty or ${CLASSIFIER_PATH}`);
  }
  return `${url.origin}${CLASSIFIER_PATH}`;
}

function findWranglerBin(workerRoot: string): string {
  for (
    let dir = path.join(workerRoot, 'services/auto-routing-benchmark/scripts');
    ;
    dir = path.dirname(dir)
  ) {
    const candidate = path.join(dir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    if (existsSync(candidate)) return candidate;
    if (dir === workerRoot) return fail(`wrangler is not installed in ${workerRoot}`);
  }
}

type WorkerBundle = {
  dir: string;
  entry: string;
  workerRoot: string;
  workerBundleSha256: string;
  manifest: NonNullable<WorkerOptions['config']['manifest']>;
};

const VersionIdentitySchema = z.looseObject({
  workerRoot: z.string(),
  workerBundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  bundleEntry: z.string(),
});
const ExecutionIdentitySchema = z.looseObject({
  schema_version: z.literal(1),
  identity_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  baseline: VersionIdentitySchema,
  candidate: VersionIdentitySchema,
  runtime: z.looseObject({
    observed: z.record(z.string(), z.unknown()),
    python: z.looseObject({ path: z.string() }),
    bootstrap: z.string(),
    tsx_esm_api: z.string(),
    tsx_options: z.object({ tsconfig: z.literal(false), cache: z.literal(false) }),
    compatibility_date: z.string(),
    compatibility_flags: z.array(z.string()),
  }),
  serving_argv: z.array(z.string()),
});
type ExecutionIdentity = z.infer<typeof ExecutionIdentitySchema>;
type ObservedRuntime = {
  node: string;
  versions: NodeJS.ProcessVersions;
  packages: Record<string, { root: string; version: string }>;
  workerd: { path: string; sha256: string; version: string };
};

const proofScript = path.join(scriptsDir, 'router-proof.py');

const SUBPROCESS_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'PYTHONDONTWRITEBYTECODE',
  'CI',
  'WRANGLER_SEND_METRICS',
  'WRANGLER_LOG_PATH',
  'WRANGLER_HOME',
  'XDG_CONFIG_HOME',
] as const;

function subprocessEnvironment(
  values: Partial<Record<(typeof SUBPROCESS_ENV_KEYS)[number], string | undefined>>
): NodeJS.ProcessEnv {
  const environment: Record<string, string> = {};
  for (const key of SUBPROCESS_ENV_KEYS) {
    const value = values[key];
    if (value !== undefined) environment[key] = value;
  }
  // Generated Worker bindings augment ProcessEnv; subprocesses must omit those production bindings.
  return environment as NodeJS.ProcessEnv;
}

async function proof(python: string, args: string[]): Promise<string> {
  const result = await execFileAsync(python, ['-I', proofScript, ...args], {
    maxBuffer: 256 * 1000 * 1000,
    env: subprocessEnvironment({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PYTHONDONTWRITEBYTECODE: '1',
    }),
  });
  return result.stdout;
}

async function packageInfo(name: string, from = import.meta.url) {
  const entry = createRequire(from).resolve(name);
  for (let directory = path.dirname(entry); ; directory = path.dirname(directory)) {
    const packageJson = path.join(directory, 'package.json');
    if (existsSync(packageJson)) {
      const parsed = z
        .object({ name: z.string(), version: z.string() })
        .safeParse(JSON.parse(await readFile(packageJson, 'utf8')));
      if (parsed.success && parsed.data.name === name) {
        return { root: await realpath(directory), version: parsed.data.version };
      }
    }
    if (path.dirname(directory) === directory)
      return fail(`Cannot identify runtime package ${name}`);
  }
}

async function observedRuntime(): Promise<ObservedRuntime> {
  const miniflare = await packageInfo('miniflare');
  const workerd = z
    .object({ default: z.string() })
    .parse(createRequire(path.join(miniflare.root, 'package.json'))('workerd'));
  const workerdPath = await realpath(workerd.default);
  const workerdVersion = await execFileAsync(workerdPath, ['--version'], {
    env: subprocessEnvironment({ PATH: process.env.PATH }),
  });
  return {
    node: process.version,
    versions: process.versions,
    workerd: {
      path: workerdPath,
      sha256: createHash('sha256')
        .update(await readFile(workerdPath))
        .digest('hex'),
      version: workerdVersion.stdout.trim(),
    },
    packages: {
      miniflare,
      workerd: await packageInfo('workerd', path.join(miniflare.root, 'package.json')),
      tsx: await packageInfo('tsx'),
      zod: await packageInfo('zod'),
      contracts: await packageInfo('@kilocode/auto-routing-contracts'),
    },
  };
}

function rejectRuntimeOverrides() {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('MINIFLARE_') ||
      key.startsWith('WORKERD_') ||
      key.startsWith('ESBUILD_') ||
      (key.startsWith('TSX_') && key !== 'TSX_DISABLE_CACHE') ||
      ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS'].includes(key)
    ) {
      fail(`${key} overrides are forbidden in proof execution`);
    }
  }
  if (process.env.TSX_DISABLE_CACHE !== '1') {
    fail('Use the configuration-free prepared bootstrap or router-proof.py prepare launcher');
  }
}

// Wrangler's own offline bundling gives the Worker the exact production module resolution and
// nodejs_compat handling, without a Cloudflare login or any upload.
async function buildWorkerBundle(workDir: string, workerRoot: string): Promise<void> {
  await mkdir(workDir, { recursive: true });
  await mkdir(path.join(workDir, 'home'), { recursive: true });
  const outDir = path.join(workDir, 'bundle');
  const productionConfig: unknown = parseJsonc(
    await readFile(path.join(workerRoot, 'services/auto-routing/wrangler.jsonc'), 'utf8')
  );
  const compatibility = z
    .object({
      compatibility_date: z.literal(COMPATIBILITY_DATE),
      compatibility_flags: z.array(z.string()),
    })
    .parse(productionConfig);
  if (!isDeepStrictEqual(compatibility.compatibility_flags, COMPATIBILITY_FLAGS)) {
    fail(`${workerRoot}: production compatibility settings differ from the proof runtime`);
  }
  const tsconfigSource = path.join(workerRoot, 'services/auto-routing-benchmark/tsconfig.json');
  const compilerConfig: unknown = parseJsonc(await readFile(tsconfigSource, 'utf8'));
  z.object({ extends: z.never().optional() }).parse(compilerConfig);
  const configPath = path.join(workDir, 'wrangler.jsonc');
  // Wrangler resolves `tsconfig` against the config directory, so the build uses a byte-identical
  // copy of the inventoried config instead of a path it would rewrite.
  await copyFile(tsconfigSource, path.join(workDir, 'tsconfig.json'));
  await writeFile(
    configPath,
    JSON.stringify({
      name: 'auto-routing-benchmark-isolated',
      main: path.join(
        workerRoot,
        'services/auto-routing-benchmark/scripts/router-isolated-worker.ts'
      ),
      tsconfig: './tsconfig.json',
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: COMPATIBILITY_FLAGS,
      durable_objects: {
        bindings: [
          { name: 'AUTO_ROUTING_DECISION_CACHE', class_name: 'AutoRoutingDecisionCacheDO' },
          { name: 'AUTO_ROUTING_MODE_CONFIG', class_name: 'AutoRoutingModeConfigDO' },
        ],
      },
      migrations: [
        {
          tag: 'v1',
          new_sqlite_classes: ['AutoRoutingDecisionCacheDO', 'AutoRoutingModeConfigDO'],
        },
      ],
    })
  );
  try {
    await execFileAsync(
      process.execPath,
      [
        findWranglerBin(workerRoot),
        'deploy',
        '--dry-run',
        '--outdir',
        outDir,
        '--config',
        configPath,
        '--metafile',
        path.join(workDir, 'bundle-meta.json'),
      ],
      {
        cwd: workDir,
        env: subprocessEnvironment({
          PATH: process.env.PATH,
          HOME: path.join(workDir, 'home'),
          TMPDIR: process.env.TMPDIR,
          CI: '1',
          WRANGLER_SEND_METRICS: 'false',
          WRANGLER_LOG_PATH: path.join(workDir, 'wrangler.log'),
          WRANGLER_HOME: path.join(workDir, 'wrangler-home'),
          XDG_CONFIG_HOME: path.join(workDir, 'home', '.config'),
        }),
        maxBuffer: 16 * 1000 * 1000,
      }
    );
  } catch (error) {
    const output = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
    return fail(`Worker bundling failed: ${output || String(error)}`);
  }
  const entry = (await readdir(outDir)).find(name => name === 'router-isolated-worker.js');
  if (entry === undefined) fail('Worker bundle output is missing router-isolated-worker.js');
}

async function loadBundle(
  preparedDirectory: string,
  version: Version,
  identity: ExecutionIdentity
): Promise<WorkerBundle> {
  const versionIdentity = identity[version];
  const dir = path.join(preparedDirectory, version, 'bundle');
  const entry = path.join(preparedDirectory, versionIdentity.bundleEntry);
  const modules: WorkerBundle['manifest']['modules'] = {};
  async function visit(directory: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) await visit(filename);
      else if (item.isFile() && !item.name.endsWith('.map')) {
        const type =
          item.name.endsWith('.js') || item.name.endsWith('.mjs')
            ? 'esm'
            : item.name.endsWith('.wasm')
              ? 'wasm'
              : item.name.endsWith('.txt') || item.name.endsWith('.html')
                ? 'text'
                : 'data';
        modules[path.relative(dir, filename)] = { type, contents: await readFile(filename) };
      } else if (!item.isFile()) fail('Prepared bundle contains a non-regular file');
    }
  }
  await visit(dir);
  const entryModule = modules[path.relative(dir, entry)];
  if (entryModule === undefined) fail(`${version}: prepared entry is missing`);
  const workerBundleSha256 = createHash('sha256').update(entryModule.contents).digest('hex');
  if (workerBundleSha256 !== versionIdentity.workerBundleSha256) {
    fail(`${version}: compiled Worker bytes changed while loading`);
  }
  return {
    dir,
    entry,
    workerRoot: versionIdentity.workerRoot,
    workerBundleSha256,
    manifest: { mainModule: path.relative(dir, entry), modulesRoot: dir, modules },
  };
}

async function sealDirectory(directory: string, readOnly = true): Promise<void> {
  if (!readOnly) await chmod(directory, 0o755);
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) await sealDirectory(filename, readOnly);
    else if (item.isFile()) await chmod(filename, readOnly ? 0o444 : 0o644);
    else if (readOnly) fail('Prepared execution cannot contain symlinks');
  }
  if (readOnly) await chmod(directory, 0o555);
}

async function prepareExecution(
  preparedDirectory: string,
  baselineRoot: string,
  candidateRoot: string,
  python: string
): Promise<void> {
  for (const root of [baselineRoot, candidateRoot, repositoryRoot]) {
    const relative = path.relative(root, preparedDirectory);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
      fail('Prepared execution must be outside every source root');
    }
  }
  await mkdir(preparedDirectory, { recursive: false });
  const descriptor = path.join(preparedDirectory, 'descriptor.json');
  const inputs = path.join(preparedDirectory, 'inputs.json');
  try {
    await writeFile(
      descriptor,
      JSON.stringify({
        roots: {
          baseline: baselineRoot,
          candidate: candidateRoot,
          host: await realpath(repositoryRoot),
        },
        node: await realpath(process.execPath),
        node_builtin_modules: builtinModules,
        tsx_esm_api: await realpath(fileURLToPath(import.meta.resolve('tsx/esm/api'))),
        runtime_script: await realpath(fileURLToPath(import.meta.url)),
        observed: await observedRuntime(),
        compatibility_date: COMPATIBILITY_DATE,
        compatibility_flags: COMPATIBILITY_FLAGS,
      })
    );
    await proof(python, ['capture', '--descriptor', descriptor, '--output', inputs]);
    await buildWorkerBundle(path.join(preparedDirectory, 'baseline'), baselineRoot);
    await buildWorkerBundle(path.join(preparedDirectory, 'candidate'), candidateRoot);
    for (const version of ['baseline', 'candidate']) {
      const directory = path.join(preparedDirectory, version);
      for (const name of await readdir(directory)) {
        if (!['bundle', 'wrangler.jsonc', 'bundle-meta.json'].includes(name)) {
          await rm(path.join(directory, name), { recursive: true, force: true });
        }
      }
    }
    const identity = await proof(python, [
      'finalize',
      '--prepared',
      preparedDirectory,
      '--inputs',
      inputs,
    ]);
    const preparedIdentity = ExecutionIdentitySchema.parse(
      parseJson(identity, 'prepared execution identity')
    );
    await rm(descriptor);
    await rm(inputs);
    await sealDirectory(preparedDirectory);
    console.log(
      JSON.stringify({
        event: 'router_runtime_prepared',
        execution_manifest: path.join(preparedDirectory, 'execution.json'),
        identity: preparedIdentity,
      })
    );
  } catch (error) {
    await sealDirectory(preparedDirectory, false);
    await rm(preparedDirectory, { recursive: true, force: true });
    throw error;
  }
}

type Instance = {
  mf: Miniflare;
  token: string;
  denials: string[];
  usageRecords: { id: string; costMicrodollars: number }[];
  inflight: Set<Promise<unknown>>;
  poisoned: string | null;
};

type Runtime = {
  snapshotSha256: string;
  health: () => Record<string, unknown>;
  route: (input: z.infer<typeof RouteRequestSchema>) => Promise<string>;
  close: (runId: string) => Promise<Record<string, unknown>>;
  dispose: () => Promise<void>;
};

async function createRuntime(options: {
  snapshotBytes: Buffer;
  snapshot: Snapshot;
  summaries: Record<Version, VersionSummary>;
  brokerUrl: string;
  bundles: Record<Version, WorkerBundle>;
  executionIdentity: ExecutionIdentity;
  observed: ObservedRuntime;
}): Promise<Runtime> {
  const { snapshot, brokerUrl, bundles } = options;
  const snapshotSha256 = createHash('sha256').update(options.snapshotBytes).digest('hex');
  const instances = new Map<string, Promise<Instance>>();
  const closedRuns = new Set<string>();

  const instanceKey = (runId: string, version: Version, router: AutoRouter) =>
    `${runId}\u0000${version}\u0000${router}`;

  async function createInstance(runId: string, version: Version): Promise<Instance> {
    const bundle = bundles[version];
    const token = randomBytes(32).toString('hex');
    const denials: string[] = [];
    const usageRecords: Instance['usageRecords'] = [];

    // The only network path out of the Worker. Anything but the exact classifier POST is denied
    // and recorded, which poisons the instance.
    async function egress(request: Request): Promise<Response> {
      if (request.method === 'POST' && request.url === CLASSIFIER_URL) {
        const headers = new Headers(request.headers);
        for (const name of ['authorization', 'host', 'content-length', 'connection']) {
          headers.delete(name);
        }
        headers.set('accept-encoding', 'identity');
        headers.set('x-benchmark-run', runId);
        const upstream = await fetch(brokerUrl, {
          method: 'POST',
          headers,
          body: await request.arrayBuffer(),
          redirect: 'manual',
        });
        const responseHeaders = new Headers(upstream.headers);
        for (const name of ['content-encoding', 'content-length', 'transfer-encoding']) {
          responseHeaders.delete(name);
        }
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      }
      if (request.method === 'POST' && request.url === USAGE_URL) {
        const usage = UsageRecordSchema.safeParse(await request.json());
        if (usage.success) {
          usageRecords.push({ id: usage.data.core.id, costMicrodollars: usage.data.core.cost });
          return Response.json({
            status: 'recorded',
            result: {
              usageId: usage.data.core.id,
              createdAt: new Date().toISOString(),
              newMicrodollarsUsed: null,
            },
          });
        }
      }
      denials.push(`${request.method} ${request.url}`);
      return new Response('Outbound request denied', { status: 403 });
    }

    const miniflareOptions: MiniflareOptions = {
      host: '127.0.0.1',
      port: 0,
      cf: false,
      workers: [
        {
          config: {
            name: 'router',
            type: 'worker',
            manifest: bundle.manifest,
            compatibilityDate: COMPATIBILITY_DATE,
            compatibilityFlags: COMPATIBILITY_FLAGS,
            exports: {
              AutoRoutingDecisionCacheDO: { type: 'durable-object', storage: 'sqlite' },
              AutoRoutingModeConfigDO: { type: 'durable-object', storage: 'sqlite' },
            },
            env: {
              AUTO_ROUTING_CONFIG: { type: 'kv' },
              AUTO_ROUTING_DECISION_CACHE: {
                type: 'durable-object',
                worker: 'router',
                exportName: 'AutoRoutingDecisionCacheDO',
              },
              AUTO_ROUTING_MODE_CONFIG: {
                type: 'durable-object',
                worker: 'router',
                exportName: 'AutoRoutingModeConfigDO',
              },
              AUTO_ROUTING_CLASSIFIER_METRICS_V2: {
                type: 'analytics-engine-dataset',
                name: 'benchmark_local_metrics',
              },
              BENCHMARK_INTERNAL_TOKEN: { type: 'text', value: token },
              O11Y_CF_ACCOUNT_ID: { type: 'text', value: 'benchmark-local' },
              KILO_WEB_API_BASE_URL: { type: 'text', value: new URL(USAGE_URL).origin },
              KILO_AI_GATEWAY_BASE_URL: { type: 'text', value: 'http://benchmark-gateway.invalid' },
            },
          },
          dev: { outboundService: { type: 'worker', worker: 'egress' } },
        },
        {
          config: {
            name: 'egress',
            type: 'worker',
            manifest: {
              mainModule: 'egress.js',
              modulesRoot: bundle.dir,
              modules: { 'egress.js': { type: 'esm', contents: EGRESS_SCRIPT } },
            },
            compatibilityDate: COMPATIBILITY_DATE,
            env: { BROKER: { type: 'fetcher', handler: egress } },
          },
        },
      ],
    };
    const mf = new Miniflare(miniflareOptions);
    try {
      await mf.ready;
      const kv = await mf.getKVNamespace('AUTO_ROUTING_CONFIG', 'router');
      for (const [key, value] of Object.entries(snapshot[version].kv)) await kv.put(key, value);
      const health = await mf.dispatchFetch('http://router.local/health', {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!health.ok) fail(`Worker health check returned ${health.status}`);
    } catch (error) {
      await mf.dispose();
      throw error;
    }
    return { mf, token, denials, usageRecords, inflight: new Set(), poisoned: null };
  }

  function getInstance(runId: string, version: Version, router: AutoRouter): Promise<Instance> {
    const key = instanceKey(runId, version, router);
    let instance = instances.get(key);
    if (instance === undefined) {
      instance = createInstance(runId, version);
      instances.set(key, instance);
      instance.catch(() => instances.delete(key));
    }
    return instance;
  }

  function buildPayload(input: z.infer<typeof RouteRequestSchema>): {
    payload: MirrorPayload;
    bodyBytes: number;
  } {
    const body = { model: `kilo-auto/${input.router}`, messages: input.messages };
    const normalized = normalizeClassifierInput('chat_completions', body);
    if (!normalized) {
      throw new HttpError(400, { error: 'messages_not_classifiable' });
    }
    const requiredInputModalities = detectRequiredInputModalities(body);
    const promptTokensEstimate = estimateRoutingTokens(body);
    const bodyBytes = Buffer.byteLength(JSON.stringify(body));
    return {
      bodyBytes,
      payload: {
        input: normalized,
        router: input.router,
        ...(requiredInputModalities.length > 0 || promptTokensEstimate > 0
          ? {
              constraints: {
                ...(requiredInputModalities.length > 0 ? { requiredInputModalities } : {}),
                ...(promptTokensEstimate > 0 ? { promptTokensEstimate } : {}),
              },
            }
          : {}),
        userId: `benchmark-run:${input.runId}`,
        organizationId: null,
        sessionId: input.runId,
        machineId: null,
        clientRequestId: null,
        mode: null,
        userAgent: null,
        bodyBytes,
      },
    };
  }

  return {
    snapshotSha256,
    health: () => ({
      status: 'ok',
      snapshotSha256,
      executionIdentity: options.executionIdentity,
      runtime: options.observed,
      versions: {
        baseline: {
          ...options.summaries.baseline,
          workerRoot: bundles.baseline.workerRoot,
          workerBundleSha256: bundles.baseline.workerBundleSha256,
        },
        candidate: {
          ...options.summaries.candidate,
          workerRoot: bundles.candidate.workerRoot,
          workerBundleSha256: bundles.candidate.workerBundleSha256,
        },
      },
      activeInstances: instances.size,
      closedRuns: closedRuns.size,
    }),

    async route(input) {
      if (closedRuns.has(input.runId)) throw new HttpError(409, { error: 'run_closed' });
      const { payload } = buildPayload(input);
      const instance = await getInstance(input.runId, input.version, input.router);
      if (instance.poisoned !== null) {
        throw new HttpError(500, { error: 'isolation_violation', detail: instance.poisoned });
      }
      const call = (async () => {
        const response = await instance.mf.dispatchFetch('http://router.local/decide', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${instance.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(300_000),
        });
        return { status: response.status, text: await response.text(), response };
      })();
      instance.inflight.add(call);
      try {
        const { status, text, response } = await call;
        const violations = response.headers.get(ISOLATION_VIOLATION_HEADER);
        if (violations !== null || instance.denials.length > 0) {
          instance.poisoned = JSON.stringify({ bindings: violations, denied: instance.denials });
          throw new HttpError(500, { error: 'isolation_violation', detail: instance.poisoned });
        }
        if (status !== 200) {
          throw new HttpError(502, {
            error: 'router_worker_error',
            status,
            body: text.slice(0, 2000),
          });
        }
        if (
          !AutoRoutingDecisionResponseSchema.safeParse(parseJson(text, 'decide response')).success
        ) {
          throw new HttpError(502, {
            error: 'invalid_decision_response',
            body: text.slice(0, 2000),
          });
        }
        return text;
      } finally {
        instance.inflight.delete(call);
      }
    },

    async close(runId) {
      closedRuns.add(runId);
      const prefix = `${runId}\u0000`;
      const closed: Record<string, unknown>[] = [];
      const errors: unknown[] = [];
      for (const [key, pending] of [...instances]) {
        if (!key.startsWith(prefix)) continue;
        const [, version, router] = key.split('\u0000');
        const instance = await pending.catch(() => null);
        if (instance === null) {
          instances.delete(key);
          continue;
        }
        await Promise.allSettled([...instance.inflight]);
        try {
          await instance.mf.dispose();
          instances.delete(key);
          closed.push({
            version,
            router,
            usageRecords: instance.usageRecords,
            denials: instance.denials,
          });
        } catch (error) {
          errors.push(error);
          console.error(
            JSON.stringify({ event: 'router_runtime_close_error', error: String(error) })
          );
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Router runtime close failed');
      return { runId, closed };
    },

    async dispose() {
      const pending = [...instances.values()];
      instances.clear();
      await Promise.allSettled(pending);
      for (const settled of await Promise.allSettled(
        pending.map(async item => {
          const instance = await item;
          await instance.mf.dispose();
        })
      )) {
        if (settled.status === 'rejected')
          console.error(
            JSON.stringify({ event: 'router_runtime_dispose_error', error: String(settled.reason) })
          );
      }
    },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer: unknown = chunk;
    if (!Buffer.isBuffer(buffer)) throw new HttpError(400, { error: 'invalid_body_chunk' });
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, { error: 'body_too_large' });
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, { error: 'invalid_json' });
  }
}

function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function main(preparedIdentity: unknown): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'prepare-only': { type: 'string' },
      'prepared-execution': { type: 'string' },
      python: { type: 'string' },
      snapshot: { type: 'string' },
      'broker-url': { type: 'string' },
      port: { type: 'string' },
      'baseline-root': { type: 'string' },
      'candidate-root': { type: 'string' },
    },
    strict: true,
  });
  rejectRuntimeOverrides();
  if (values['prepare-only']) {
    if (
      values['prepared-execution'] ||
      values.snapshot ||
      values['broker-url'] ||
      values.port !== undefined
    ) {
      fail('Preparation cannot be combined with serving options');
    }
    const target = path.resolve(values['prepare-only']);
    const parent = await realpath(path.dirname(target));
    return prepareExecution(
      path.join(parent, path.basename(target)),
      await realpath(path.resolve(values['baseline-root'] ?? repositoryRoot)),
      await realpath(path.resolve(values['candidate-root'] ?? repositoryRoot)),
      values.python ?? 'python3'
    );
  }
  if (
    !values['prepared-execution'] ||
    values['baseline-root'] ||
    values['candidate-root'] ||
    values.python
  ) {
    fail('Serving requires --prepared-execution and forbids source-root or Python overrides');
  }
  if ((await realpath(process.cwd())) !== (await realpath(repositoryRoot))) {
    fail('Serving cwd must be the prepared host source root');
  }
  if (!values.snapshot || !values['broker-url'] || values.port === undefined) {
    fail(
      'Usage: router-runtime.ts --prepare-only DIR [--baseline-root DIR] [--candidate-root DIR] [--python PATH], or --prepared-execution PATH --snapshot FILE --broker-url URL --port N'
    );
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port must be 0-65535');

  const snapshotBytes = await readFile(values.snapshot);
  const snapshotResult = SnapshotSchema.safeParse(JSON.parse(snapshotBytes.toString('utf8')));
  if (!snapshotResult.success) fail(`Snapshot is invalid: ${snapshotResult.error.message}`);
  const snapshot = snapshotResult.data;
  const summaries = {
    baseline: validateVersion('baseline', snapshot.baseline.kv),
    candidate: validateVersion('candidate', snapshot.candidate.kv),
  };

  const suppliedPath = await realpath(path.resolve(values['prepared-execution']));
  const suppliedStat = await stat(suppliedPath);
  if (!suppliedStat.isDirectory() && path.basename(suppliedPath) !== 'execution.json') {
    fail('Prepared execution must be a directory or execution.json');
  }
  const preparedDirectory = suppliedStat.isDirectory() ? suppliedPath : path.dirname(suppliedPath);
  const initialIdentity = ExecutionIdentitySchema.parse(preparedIdentity);
  if (
    process.execArgv.length !== 0 ||
    !process.argv[1] ||
    (await realpath(process.argv[1])) !== initialIdentity.runtime.bootstrap
  ) {
    fail('Serving must use the exact prepared JavaScript bootstrap');
  }
  const observed = await observedRuntime();
  if (
    !isDeepStrictEqual(observed, initialIdentity.runtime.observed) ||
    initialIdentity.runtime.compatibility_date !== COMPATIBILITY_DATE ||
    !isDeepStrictEqual(initialIdentity.runtime.compatibility_flags, COMPATIBILITY_FLAGS)
  ) {
    fail('Observed runtime or compatibility settings differ from prepared execution');
  }
  const bundles = {
    baseline: await loadBundle(preparedDirectory, 'baseline', initialIdentity),
    candidate: await loadBundle(preparedDirectory, 'candidate', initialIdentity),
  };
  const assertExecution = async () => {
    const current = ExecutionIdentitySchema.parse(
      JSON.parse(await proof(initialIdentity.runtime.python.path, ['identity', suppliedPath]))
    );
    if (!isDeepStrictEqual(current, initialIdentity)) fail('Prepared execution identity drift');
  };
  await assertExecution();
  const runtime = await createRuntime({
    snapshotBytes,
    snapshot,
    summaries,
    brokerUrl: normalizeBrokerUrl(values['broker-url']),
    bundles,
    executionIdentity: initialIdentity,
    observed,
  });

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const { method, url } = request;
        if (method === 'GET' && url === '/health') {
          await assertExecution();
          return send(response, 200, JSON.stringify(runtime.health()));
        }
        if (method === 'POST' && url === '/route') {
          const input = RouteRequestSchema.safeParse(await readJsonBody(request));
          if (!input.success) {
            throw new HttpError(400, { error: 'invalid_request', issues: input.error.issues });
          }
          await assertExecution();
          const result = await runtime.route(input.data);
          await assertExecution();
          return send(response, 200, result);
        }
        if (method === 'POST' && url === '/close') {
          const input = CloseRequestSchema.safeParse(await readJsonBody(request));
          if (!input.success) {
            throw new HttpError(400, { error: 'invalid_request', issues: input.error.issues });
          }
          return send(response, 200, JSON.stringify(await runtime.close(input.data.runId)));
        }
        throw new HttpError(404, { error: 'not_found' });
      } catch (error) {
        if (error instanceof HttpError)
          return send(response, error.status, JSON.stringify(error.body));
        console.error(JSON.stringify({ event: 'router_runtime_error', error: String(error) }));
        send(response, 500, JSON.stringify({ error: 'internal_error', detail: String(error) }));
      }
    })();
  });

  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    server.close();
    void runtime.dispose().finally(() => process.exit(code));
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));

  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(port, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  console.log(
    JSON.stringify({
      event: 'router_runtime_listening',
      port: typeof address === 'object' && address !== null ? address.port : port,
      snapshotSha256: runtime.snapshotSha256,
    })
  );
}

export async function run(preparedIdentity: unknown = undefined): Promise<void> {
  try {
    await main(preparedIdentity);
  } catch (error) {
    console.error(JSON.stringify({ event: 'router_runtime_failed', error: String(error) }));
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fail('Use router-proof.py prepare or the prepared JavaScript bootstrap');
}
