import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from 'jsonc-parser';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sourceConfigPath = join(packageDir, 'wrangler.jsonc');
const targetConfigPath = join(packageDir, '.wrangler', 'wrangler.e2e-test.jsonc');
const defaultWorkerUrl = 'https://cloud-agent-e2e-test.engineering-e11.workers.dev';

const CALLBACK_QUEUE = 'cloud-agent-next-callback-queue';
const CALLBACK_QUEUE_E2E = 'cloud-agent-next-callback-queue-e2e-test';
const REPORT_QUEUE = 'cloud-agent-next-report-queue';
const SHARED_SANDBOX_OVERRIDES_KV_ID_E2E = '4d5f651fb14b4de682204eaa9fa60a7d';

const E2E_CONTAINER_CLASSES = new Set(['SandboxSmall']);
const E2E_MAX_INSTANCES = 20;

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
  config.main = '../src/index.ts';
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

  config.migrations = (config.migrations ?? [])
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

if (isMain) {
  const fakeLlmBaseUrl = process.env.FAKE_LLM_BASE_URL;
  const e2eUserId = process.env.E2E_USER_ID;
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  mkdirSync(dirname(targetConfigPath), { recursive: true });
  writeFileSync(targetConfigPath, `${JSON.stringify(rendered, null, 2)}\n`);
  console.log(`Rendered ${targetConfigPath}`);
}
