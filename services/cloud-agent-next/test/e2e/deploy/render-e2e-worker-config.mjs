import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from 'jsonc-parser';

import { requireE2eInternalSecret as requireSharedE2eInternalSecret } from '../e2e-internal-secret.ts';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sourceConfigPath = join(packageDir, 'wrangler.jsonc');
const targetConfigPath = join(packageDir, '.wrangler', 'wrangler.e2e-test.jsonc');
const localTargetConfigPath = join(packageDir, '.wrangler', 'wrangler.e2e-local.jsonc');
const packageDevVarsPath = join(packageDir, '.dev.vars');
const localDevVarsPath = join(packageDir, '.wrangler', '.dev.vars');
const e2eEntryPath = '../src/e2e-entry.ts';
const defaultWorkerUrl = 'https://cloud-agent-e2e-test.engineering-e11.workers.dev';

// Wrangler resolves `.dev.vars` relative to the selected config's directory and
// prefers `${configDir}/.dev.vars.${env}` over `${configDir}/.dev.vars`, so with
// `.wrangler/wrangler.e2e-local.jsonc` the shadowing file is
// `.wrangler/.dev.vars.dev`; the renderer refuses that conflict.
const LOCAL_DEV_VARS_ENV = 'dev';
// The alphabet keeps the plain `INTERNAL_API_SECRET=<value>` dotenv line
// unambiguous without quoting. It is a `.dev.vars` constraint, so it lives in
// the renderer only; the shared rules (`requireE2eInternalSecret`) apply to the
// deployed upload and the driver too.
const E2E_INTERNAL_SECRET_PATTERN = /^[A-Za-z0-9._~-]+$/;

const CALLBACK_QUEUE = 'cloud-agent-next-callback-queue';
const CALLBACK_QUEUE_E2E = 'cloud-agent-next-callback-queue-e2e-test';
const REPORT_QUEUE = 'cloud-agent-next-report-queue';
const SHARED_SANDBOX_OVERRIDES_KV_ID_E2E = '4d5f651fb14b4de682204eaa9fa60a7d';

const E2E_CONTAINER_CLASSES = new Set(['SandboxSmall']);
const E2E_MAX_INSTANCES = 20;

const E2E_CALLBACK_CLASS = 'E2eCallbackSink';
const E2E_CALLBACK_BINDING = 'E2E_CALLBACK_SINK';
const E2E_CALLBACK_MIGRATION = {
  new_sqlite_classes: [E2E_CALLBACK_CLASS],
  tag: 'v10-e2e',
};

const STRICTLY_PUBLIC_FETCH_FLAG = 'global_fetch_strictly_public';

/**
 * The callback sink is a new class, so it needs both a binding and a migration.
 * The migration is inserted directly after the production `v10` tag — never
 * appended after the cloned production migrations — so every production tag
 * keeps its position when production later adds a new one.
 */
function insertCallbackMigration(migrations) {
  const cloned = (migrations ?? []).map(entry => structuredClone(entry));
  const v10Index = cloned.findIndex(entry => entry.tag === 'v10');
  if (v10Index === -1) {
    throw new Error(
      "cannot insert the e2e migration: the production anchor tag 'v10' is missing from the source migrations; refusing to append after cloned production migrations"
    );
  }
  cloned.splice(v10Index + 1, 0, structuredClone(E2E_CALLBACK_MIGRATION));
  return cloned;
}

function withCallbackBinding(durableObjects) {
  return {
    ...durableObjects,
    bindings: [
      ...(durableObjects?.bindings ?? []),
      { class_name: E2E_CALLBACK_CLASS, name: E2E_CALLBACK_BINDING },
    ],
  };
}

/**
 * The Worker delivers callbacks to its own public origin, which requires the
 * strict-public fetch flag. It belongs only in the rendered e2e configs.
 */
function withStrictlyPublicFetch(config) {
  const flags = config.compatibility_flags ?? ['nodejs_compat'];
  config.compatibility_flags = flags.includes(STRICTLY_PUBLIC_FETCH_FLAG)
    ? flags
    : [...flags, STRICTLY_PUBLIC_FETCH_FLAG];
  return config;
}

export function buildE2eWorkerConfig(sourceConfig, overrides) {
  const { workerUrl, kiloOpenRouterBase } = overrides;
  const e2eUserId = overrides.e2eUserId?.trim();
  if (!e2eUserId) {
    throw new Error(
      'E2E_USER_ID is required: this render enrolls it in CONTROL_PLANE_IDS and ' +
        'WORKTREE_CREATION_ENABLED_IDS, and the e2e Worker writes to production ' +
        'Postgres and R2. Pass an explicit Kilo user id; pass * only to ' +
        'deliberately enrol every authenticated Kilo user.'
    );
  }
  const config = structuredClone(sourceConfig);

  config.$schema = '../node_modules/wrangler/config-schema.json';
  config.name = 'cloud-agent-e2e-test';
  config.main = e2eEntryPath;
  config.workers_dev = true;

  delete config.dev;
  delete config.env;
  delete config.routes;

  const removedContainerClasses = new Set(
    (config.containers ?? [])
      .map(entry => entry.class_name)
      .filter(className => !E2E_CONTAINER_CLASSES.has(className))
  );

  config.containers = (config.containers ?? [])
    .filter(entry => E2E_CONTAINER_CLASSES.has(entry.class_name))
    .map(entry => ({
      ...entry,
      image:
        typeof entry.image === 'string' && entry.image.startsWith('./')
          ? `../${entry.image.slice(2)}`
          : entry.image,
      max_instances: E2E_MAX_INSTANCES,
      ssh: { ...(entry.ssh ?? {}), enabled: true },
    }));

  config.durable_objects = {
    ...config.durable_objects,
    bindings: (config.durable_objects?.bindings ?? []).filter(
      binding => !removedContainerClasses.has(binding.class_name)
    ),
  };

  const survivingMigrations = (config.migrations ?? [])
    .map(entry => {
      const migration = { ...entry };
      if (entry.new_sqlite_classes) {
        migration.new_sqlite_classes = entry.new_sqlite_classes.filter(
          className => !removedContainerClasses.has(className)
        );
      }
      if (entry.new_classes) {
        migration.new_classes = entry.new_classes.filter(
          className => !removedContainerClasses.has(className)
        );
      }
      return migration;
    })
    .filter(
      entry => (entry.new_sqlite_classes?.length ?? 0) + (entry.new_classes?.length ?? 0) > 0
    );
  config.migrations = insertCallbackMigration(survivingMigrations);

  config.durable_objects = withCallbackBinding(config.durable_objects);
  withStrictlyPublicFetch(config);

  config.vars = {
    ...config.vars,
    WORKER_URL: workerUrl,
    KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
    KILO_OPENROUTER_BASE: kiloOpenRouterBase,
    WS_ALLOWED_ORIGINS: 'https://app.kilo.ai,https://api.kilo.ai,http://localhost:3000',
    PER_SESSION_SANDBOX_ORG_IDS: '*',
    TOOL_CGROUP_ORG_IDS: '*',
    TOOL_CGROUP_MODE: 'enforce',
    TOOL_CGROUP_RESERVE_MB: '1024',
    TOOL_CGROUP_CPU_WEIGHT: '50',
    CONTROL_PLANE_IDS: e2eUserId,
    WORKTREE_CREATION_ENABLED_IDS: e2eUserId,
    CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'false',
    CLOUD_AGENT_CONTAINER_BILLING_USER_IDS: '',
    CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: '',
    CREDENTIAL_CONTAINMENT_ENABLED: 'false',
  };

  config.secrets_store_secrets = config.secrets_store_secrets ?? [];
  if (!config.secrets_store_secrets.some(secret => secret.binding === 'NEXTAUTH_SECRET')) {
    config.secrets_store_secrets.unshift({
      binding: 'NEXTAUTH_SECRET',
      store_id: '342a86d9e3a94da698e82d0c6e2a36f0',
      secret_name: 'NEXTAUTH_SECRET',
    });
  }

  config.kv_namespaces = (config.kv_namespaces ?? []).map(kvNamespace =>
    kvNamespace.binding === 'SHARED_SANDBOX_OVERRIDES'
      ? { ...kvNamespace, id: SHARED_SANDBOX_OVERRIDES_KV_ID_E2E }
      : kvNamespace
  );

  config.queues = {
    ...config.queues,
    producers: (config.queues?.producers ?? [])
      .filter(producer => producer.binding !== 'CLOUD_AGENT_REPORT_QUEUE')
      .map(producer =>
        producer.queue === CALLBACK_QUEUE ? { ...producer, queue: CALLBACK_QUEUE_E2E } : producer
      ),
    consumers: (config.queues?.consumers ?? [])
      .filter(consumer => consumer.queue !== REPORT_QUEUE)
      .map(consumer =>
        consumer.queue === CALLBACK_QUEUE ? { ...consumer, queue: CALLBACK_QUEUE_E2E } : consumer
      ),
  };

  return config;
}

const isMain = (() => {
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();

/**
 * Rebase one relative container image for a config written under `.wrangler/`.
 * Only `./`-relative images move; absolute or registry references stay.
 */
function rebaseImage(image) {
  return typeof image === 'string' && image.startsWith('./') ? `../${image.slice(2)}` : image;
}

function rebaseContainers(containers) {
  return (containers ?? []).map(entry => ({ ...entry, image: rebaseImage(entry.image) }));
}

/**
 * Local e2e config for `wrangler dev --env dev`. It keeps the preserved `env.dev`
 * but rebases every relative path for the `.wrangler/` location: the top-level
 * and `env.dev` container images both resolve one directory up. The callback
 * binding is a DO binding, so it must be written into `env.dev` too; migrations
 * are inherited from the top level, where the e2e tag is inserted directly after
 * `v10`. The surface secret is not rendered here: it is delivered through the
 * generated `.wrangler/.dev.vars` (see `renderLocal`).
 */
export function buildLocalE2eWorkerConfig(sourceConfig) {
  const config = structuredClone(sourceConfig);

  config.$schema = '../node_modules/wrangler/config-schema.json';
  config.main = e2eEntryPath;
  config.containers = rebaseContainers(config.containers);
  // Wrangler dev synthesizes the request origin from the configured route, so
  // keeping the production route makes the Worker see itself at
  // `http://cloud-agent-next.kilosessions.ai` and its callback self-fetch 404s.
  // The deployed e2e config already drops routes; local parity does the same so
  // the origin is the incoming host (the public tunnel).
  delete config.routes;
  config.migrations = insertCallbackMigration(config.migrations);
  config.durable_objects = withCallbackBinding(config.durable_objects);
  withStrictlyPublicFetch(config);

  if (config.env?.dev) {
    config.env.dev.containers = rebaseContainers(config.env.dev.containers);
    config.env.dev.durable_objects = withCallbackBinding(config.env.dev.durable_objects);
  }

  return config;
}

/**
 * Validate the value the local e2e Worker will read as `INTERNAL_API_SECRET`.
 * The shared rules (`requireE2eInternalSecret`) reject an empty value, the
 * insecure development default, values shorter than the shared minimum, and any
 * whitespace, so a local and a deployed value accept the same secrets. This
 * renderer adds one check the deployed paths deliberately do not: the
 * `[A-Za-z0-9._~-]` alphabet, because only here the value becomes a plain
 * `INTERNAL_API_SECRET=<value>` dotenv line that must be unambiguous without
 * quoting. A group start with no exported value fails loudly instead of
 * publishing a known secret over the public tunnel.
 */
export function requireE2eInternalSecret(raw) {
  const value = requireSharedE2eInternalSecret(raw);
  if (!E2E_INTERNAL_SECRET_PATTERN.test(value)) {
    throw new Error(
      `E2E_INTERNAL_API_SECRET must match ${E2E_INTERNAL_SECRET_PATTERN} so the dotenv line is unambiguous.`
    );
  }
  return value;
}

/**
 * Under `wrangler dev --env dev`, Wrangler loads `.dev.vars` beside the selected
 * config, so a `.dev.vars.dev` next to the generated `.wrangler/.dev.vars`
 * shadows it and the rendered secret would be silently ignored. Refuse instead
 * of managing two files that must agree. A `.dev.vars.dev` at the package root
 * is not read for this config and is not a conflict.
 */
export function assertNoConflictingDevVars(localDevVarsPath, envName) {
  const conflicting = `${localDevVarsPath}.${envName}`;
  if (existsSync(conflicting)) {
    throw new Error(
      `Refusing to render: ${conflicting} exists and takes precedence over the generated ${localDevVarsPath} under --env ${envName}; remove or rename it so exactly one e2e secret file is in play.`
    );
  }
  return conflicting;
}

/**
 * Upsert the secret into dotenv content and preserve every other line, because
 * `.dev.vars` also carries multi-line private keys. The alphabet validation
 * makes the written line unambiguous without quoting.
 */
export function buildLocalDevVarsContent(existingContent, secret) {
  const lines = String(existingContent ?? '').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const line = `INTERNAL_API_SECRET=${secret}`;
  const index = lines.findIndex(candidate => /^\s*INTERNAL_API_SECRET\s*=/.test(candidate));
  if (index === -1) lines.push(line);
  else lines[index] = line;
  return `${lines.join('\n')}\n`;
}

function localRenderPaths() {
  return {
    packageDir,
    sourceConfigPath,
    targetConfigPath: localTargetConfigPath,
    packageDevVarsPath,
    localDevVarsPath,
  };
}

/**
 * Wrangler loads `.dev.vars` beside the selected config, so a config under
 * `.wrangler/` cannot see the package-root file the tunnels rewrite. Start from
 * that file so the generated one carries every other binding, then add the
 * secret; a missing package file is not an error (worker bindings can be
 * supplied another way).
 */
function readLocalDevVarsSource(paths) {
  if (existsSync(paths.packageDevVarsPath)) return readFileSync(paths.packageDevVarsPath, 'utf8');
  if (existsSync(paths.localDevVarsPath)) return readFileSync(paths.localDevVarsPath, 'utf8');
  return '';
}

/**
 * Render the local e2e config and the `.dev.vars` beside it. Every validation
 * runs before the first write, so an invalid secret never leaves a half-written
 * config or a modified `.wrangler/.dev.vars`.
 */
export function renderLocal({
  internalApiSecret,
  paths = localRenderPaths(),
  log = message => console.log(message),
}) {
  const secret = requireE2eInternalSecret(internalApiSecret);
  assertNoConflictingDevVars(paths.localDevVarsPath, LOCAL_DEV_VARS_ENV);
  const sourceConfig = parse(readFileSync(paths.sourceConfigPath, 'utf8'));
  const rendered = buildLocalE2eWorkerConfig(sourceConfig);
  const devVars = buildLocalDevVarsContent(readLocalDevVarsSource(paths), secret);

  mkdirSync(dirname(paths.targetConfigPath), { recursive: true });
  writeFileSync(paths.targetConfigPath, `${JSON.stringify(rendered, null, 2)}\n`);
  mkdirSync(dirname(paths.localDevVarsPath), { recursive: true });
  writeFileSync(paths.localDevVarsPath, devVars);
  log(`Rendered ${paths.targetConfigPath}`);
  log(`Wrote INTERNAL_API_SECRET to ${paths.localDevVarsPath}`);
}

if (isMain) {
  const isLocal = process.argv.includes('--local');
  // Only the deployed render consumes it, as the enrollment id for
  // CONTROL_PLANE_IDS / WORKTREE_CREATION_ENABLED_IDS. It no longer authorizes
  // the surface.
  const e2eUserId = process.env.E2E_USER_ID;
  if (isLocal) {
    try {
      renderLocal({
        internalApiSecret: process.env.E2E_INTERNAL_API_SECRET,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else {
    const fakeLlmBaseUrl = process.env.FAKE_LLM_BASE_URL;
    const workerUrl = process.env.WORKER_URL ?? defaultWorkerUrl;

    if (!fakeLlmBaseUrl) {
      console.error('FAKE_LLM_BASE_URL is required (https://<fake-host>/api/openrouter).');
      process.exit(1);
    }
    let parsedFakeLlmBaseUrl;
    try {
      parsedFakeLlmBaseUrl = new URL(fakeLlmBaseUrl);
    } catch {
      console.error('FAKE_LLM_BASE_URL must be a valid absolute URL.');
      process.exit(1);
    }
    if (
      parsedFakeLlmBaseUrl.protocol !== 'https:' ||
      parsedFakeLlmBaseUrl.pathname !== '/api/openrouter' ||
      parsedFakeLlmBaseUrl.search !== '' ||
      parsedFakeLlmBaseUrl.hash !== '' ||
      parsedFakeLlmBaseUrl.username !== '' ||
      parsedFakeLlmBaseUrl.password !== ''
    ) {
      console.error(
        'FAKE_LLM_BASE_URL must be https://<host>/api/openrouter with no query, fragment or credentials, e.g. https://fake-llm.engineering-e11.workers.dev/api/openrouter'
      );
      process.exit(1);
    }

    const kiloOpenRouterBase = `${parsedFakeLlmBaseUrl.origin}${parsedFakeLlmBaseUrl.pathname}`;
    const sourceConfig = parse(readFileSync(sourceConfigPath, 'utf8'));
    let rendered;
    try {
      rendered = buildE2eWorkerConfig(sourceConfig, {
        workerUrl,
        kiloOpenRouterBase,
        e2eUserId,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }

    mkdirSync(dirname(targetConfigPath), { recursive: true });
    writeFileSync(targetConfigPath, `${JSON.stringify(rendered, null, 2)}\n`);
    console.log(`Rendered ${targetConfigPath}`);
  }
}
