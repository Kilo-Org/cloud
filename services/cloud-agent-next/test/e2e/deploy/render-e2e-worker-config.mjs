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
const E2E_WORKER_NAME = 'cloud-agent-e2e-test';

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

// Keys copied from the source config unchanged. They carry runtime settings, not
// account resources. Every other top-level key is left out on purpose: routes,
// schedules, service bindings, Hyperdrive, R2, KV, D1, AI, analytics, Secrets
// Store and logpush all reach production. A binding added to wrangler.jsonc later
// stays out of the e2e Worker until it is reviewed here.
const COPIED_KEYS = [
  'account_id',
  'compatibility_date',
  'compatibility_flags',
  'upload_source_maps',
  'version_metadata',
  'rules',
  'observability',
  'placement',
];

// The one Secrets Store secret the e2e Worker binds: the development signing key.
const E2E_SIGNING_SECRET = {
  binding: 'NEXTAUTH_SECRET',
  store_id: '342a86d9e3a94da698e82d0c6e2a36f0',
  secret_name: 'NEXTAUTH_SECRET_DEV',
};

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Native Cloudflare Containers is the only runtime, so the E2E Worker boots the
// same `SandboxContainers` class as production.
const E2E_CONTAINER_CLASSES = new Set(['SandboxContainers']);
// Preserve the deployed E2E Worker's old migration history. These namespaces
// were omitted before v15 and must be created under a new E2E tag.
const HISTORICALLY_OMITTED_CLASSES = new Set([
  'SandboxSmall',
  'SandboxDIND',
  'SandboxCodeReview',
  'SandboxContainment',
  'SandboxSmallContainment',
  'SandboxCodeReviewContainment',
  'SandboxContainers',
]);
const E2E_RUNTIME_MIGRATION = {
  tag: 'v15-e2e',
  // This applied migration must stay fixed when the current container set changes.
  // The retired containment classes stay exported as tombstones, so it remains valid.
  new_sqlite_classes: ['SandboxContainment', 'SandboxSmallContainment', 'SandboxContainers'],
};

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
 * The Worker delivers callbacks to its own origin, which requires the
 * strict-public fetch flag. With it, those requests re-enter Cloudflare's front
 * door like any Internet request, including the Access application in front of
 * the e2e hostname. It belongs only in the rendered e2e configs.
 */
function withStrictlyPublicFetch(config) {
  const flags = config.compatibility_flags ?? ['nodejs_compat'];
  config.compatibility_flags = flags.includes(STRICTLY_PUBLIC_FETCH_FLAG)
    ? flags
    : [...flags, STRICTLY_PUBLIC_FETCH_FLAG];
  return config;
}

function routeHost(route) {
  return String(typeof route === 'string' ? route : route.pattern)
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')[0]
    .toLowerCase();
}

function hostsOverlap(a, b) {
  const pattern = host =>
    new RegExp(`^${host.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return a === b || pattern(a).test(b) || pattern(b).test(a);
}

/**
 * The optional private hostname of the e2e Worker: one custom domain that an
 * Access application must protect. It must be a plain hostname that no route of
 * the source config covers, and never a `workers.dev` address.
 */
export function requireE2eWorkerHostname(hostname, sourceConfig) {
  if (typeof hostname !== 'string' || !HOSTNAME_PATTERN.test(hostname)) {
    throw new Error(
      'E2E_WORKER_HOSTNAME must be a plain lowercase hostname without scheme, port, path or wildcard.'
    );
  }
  if (hostname === 'workers.dev' || hostname.endsWith('.workers.dev')) {
    throw new Error('E2E_WORKER_HOSTNAME must not be a workers.dev address.');
  }
  const sourceRoutes = sourceConfig.routes ?? (sourceConfig.route ? [sourceConfig.route] : []);
  if (sourceRoutes.some(route => hostsOverlap(routeHost(route), hostname))) {
    throw new Error('E2E_WORKER_HOSTNAME overlaps a production route of the source config.');
  }
  return hostname;
}

/** Only the callback queue, renamed to the e2e queue; every other queue is production's. */
function callbackQueueOnly(queues) {
  const rename = entry => ({ ...entry, queue: CALLBACK_QUEUE_E2E });
  return {
    producers: (queues?.producers ?? []).filter(p => p.queue === CALLBACK_QUEUE).map(rename),
    consumers: (queues?.consumers ?? []).filter(c => c.queue === CALLBACK_QUEUE).map(rename),
  };
}

/**
 * Render the deployed e2e Worker. It owns its Durable Objects, container and
 * callback queue, binds only the development signing key, and has no public
 * address: `workers.dev` and preview URLs are off, and the only possible route is
 * the optional Access-protected custom domain.
 */
export function buildE2eWorkerConfig(sourceConfig, overrides) {
  const { workerHostname, kiloOpenRouterBase } = overrides;
  const source = structuredClone(sourceConfig);
  const hostname =
    workerHostname === undefined ? undefined : requireE2eWorkerHostname(workerHostname, source);

  /** @type {Record<string, any>} */
  const config = {
    $schema: '../node_modules/wrangler/config-schema.json',
    name: E2E_WORKER_NAME,
    main: e2eEntryPath,
  };
  for (const key of COPIED_KEYS) {
    if (source[key] !== undefined) config[key] = source[key];
  }
  config.workers_dev = false;
  config.preview_urls = false;
  // The scheduled handlers read and delete report data over Hyperdrive; an empty
  // list also removes schedules a previous deploy left on the script.
  config.triggers = { crons: [] };
  if (hostname !== undefined) {
    config.routes = [{ pattern: hostname, custom_domain: true }];
  }

  const removedContainerClasses = new Set(
    (source.containers ?? [])
      .map(entry => entry.class_name)
      .filter(className => !E2E_CONTAINER_CLASSES.has(className))
  );

  config.containers = (source.containers ?? [])
    .filter(entry => E2E_CONTAINER_CLASSES.has(entry.class_name))
    .map(entry => rebaseContainers([entry])[0]);

  // Only this script's own namespaces: a binding with `script_name` would reach
  // another Worker's objects.
  config.durable_objects = {
    bindings: (source.durable_objects?.bindings ?? []).filter(
      binding =>
        binding.script_name === undefined && !removedContainerClasses.has(binding.class_name)
    ),
  };

  const runtimeAnchorIndex = (source.migrations ?? []).findIndex(entry => entry.tag === 'v15');
  if (runtimeAnchorIndex === -1) {
    throw new Error(
      "cannot insert the e2e runtime migration: production anchor tag 'v15' is missing"
    );
  }
  const survivingMigrations = (source.migrations ?? [])
    .map((entry, index) => {
      const omittedMigrationClasses = new Set([
        ...removedContainerClasses,
        ...(index <= runtimeAnchorIndex ? HISTORICALLY_OMITTED_CLASSES : []),
      ]);
      const migration = { ...entry };
      if (entry.new_sqlite_classes) {
        migration.new_sqlite_classes = entry.new_sqlite_classes.filter(
          className => !omittedMigrationClasses.has(className)
        );
      }
      if (entry.new_classes) {
        migration.new_classes = entry.new_classes.filter(
          className => !omittedMigrationClasses.has(className)
        );
      }
      if (entry.deleted_classes) {
        migration.deleted_classes = entry.deleted_classes.filter(
          className => !omittedMigrationClasses.has(className)
        );
      }
      return migration;
    })
    .filter(
      entry =>
        (entry.new_sqlite_classes?.length ?? 0) +
          (entry.new_classes?.length ?? 0) +
          (entry.deleted_classes?.length ?? 0) >
        0
    );
  config.migrations = insertCallbackMigration(survivingMigrations);
  const anchorIndex = config.migrations.findIndex(entry => entry.tag === 'v15');
  if (anchorIndex === -1) {
    throw new Error(
      "cannot insert the e2e runtime migration: production anchor tag 'v15' is empty"
    );
  }
  config.migrations.splice(anchorIndex + 1, 0, structuredClone(E2E_RUNTIME_MIGRATION));

  config.durable_objects = withCallbackBinding(config.durable_objects);
  withStrictlyPublicFetch(config);

  const vars = {
    ...source.vars,
    KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
    // The e2e stack validates its models against the fake Worker, which serves
    // the same route shape as the official backend. Production never sets this.
    E2E_MODEL_VALIDATION_BASE_URL: new URL(kiloOpenRouterBase).origin,
    KILO_OPENROUTER_BASE: kiloOpenRouterBase,
    WS_ALLOWED_ORIGINS: 'https://app.kilo.ai,https://api.kilo.ai,http://localhost:3000',
    TOOL_CGROUP_ORG_IDS: '*',
    TOOL_CGROUP_MODE: 'enforce',
    TOOL_CGROUP_RESERVE_MB: '1024',
    TOOL_CGROUP_CPU_WEIGHT: '50',
    // The suite runs every scenario through one funded test account, so its own
    // churn would trip the per-account concurrent-container cap.
    CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED: 'true',
  };
  // Without its hostname the Worker has no address, so it must not inherit
  // production's.
  if (hostname === undefined) delete vars.WORKER_URL;
  else vars.WORKER_URL = `https://${hostname}`;
  config.vars = vars;

  config.secrets_store_secrets = [structuredClone(E2E_SIGNING_SECRET)];
  config.queues = callbackQueueOnly(source.queues);

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
  return (containers ?? []).map(entry => ({
    ...entry,
    ...(typeof entry.image === 'string' ? { image: rebaseImage(entry.image) } : {}),
    ...(entry.images
      ? {
          images: Object.fromEntries(
            Object.entries(entry.images).map(([name, image]) => [
              name,
              { ...image, dockerfile: rebaseImage(image.dockerfile) },
            ])
          ),
        }
      : {}),
  }));
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
    const workerHostname = process.env.E2E_WORKER_HOSTNAME || undefined;

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
    const runtimeConfigPath = join(packageDir, 'wrangler.runtime-generated.json');
    if (!existsSync(runtimeConfigPath)) {
      throw new Error(
        'Prepare the exact-SHA runtime deployment before rendering deployed E2E configuration (scripts/prepare-runtime-deploy.ts production <source-sha>).'
      );
    }
    const sourceConfig = parse(readFileSync(runtimeConfigPath, 'utf8'));
    if (
      sourceConfig.vars?.RUNTIME_STARTUP_MODE !== 'downloaded' ||
      sourceConfig.vars?.NATIVE_RUNTIME_IMAGE !== 'runtime-free' ||
      !sourceConfig.vars?.RUNTIME_RELEASE_DESCRIPTOR
    ) {
      throw new Error(
        'Deployed E2E requires a verified downloaded runtime-free deployment configuration.'
      );
    }
    let rendered;
    try {
      rendered = buildE2eWorkerConfig(sourceConfig, {
        workerHostname,
        kiloOpenRouterBase,
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
