// Names-only readback of both deployed e2e Workers, compared with what the
// configs the deploy just used must produce. Read-only Cloudflare API GETs:
// deployments (versions and percentages), the active version's bindings,
// workers.dev and preview flags, schedules and custom domains. Variables
// (plain_text, json) are left out; every other binding is compared by name,
// type and its target (Durable Object class, queue, Secrets Store secret name).
// It prints the readback as JSON, names only, so it can be compared with a
// recorded baseline, then every difference, and fails on any.
//
// CLI, run by the deploy job after both deploys:
//   node test/e2e/deploy/readback-e2e-workers.mjs <rendered e2e config> <rendered fake-LLM config>
// Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, E2E_WORKER_HOSTNAME,
// E2E_FAKE_LLM_HOSTNAME. Uses only Node built-ins.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const E2E_WORKER = 'cloud-agent-e2e-test';
export const FAKE_LLM_WORKER = 'fake-llm';

// Worker secrets each Worker must hold; the deploy refuses any other name.
const WORKER_SECRETS = {
  [E2E_WORKER]: ['INTERNAL_API_SECRET'],
  [FAKE_LLM_WORKER]: ['FAKE_LLM_ADMIN_TOKEN'],
};
// The Access service token, uploaded by an operator after this readback has
// proved the closed deploy; present or not, it is no finding here.
const LATER_SECRETS = new Set(['E2E_ACCESS_CLIENT_ID', 'E2E_ACCESS_CLIENT_SECRET']);
const VARIABLE_TYPES = new Set(['plain_text', 'json']);

/** Bindings a deployed config produces, as `name:type[:target]`, sorted. */
function configBindings(config, secrets) {
  return [
    ...(config.durable_objects?.bindings ?? []).map(
      binding => `${binding.name}:durable_object_namespace:${binding.class_name}`
    ),
    ...(config.queues?.producers ?? []).map(
      producer => `${producer.binding}:queue:${producer.queue}`
    ),
    ...(config.secrets_store_secrets ?? []).map(
      secret => `${secret.binding}:secrets_store_secret:${secret.secret_name}`
    ),
    ...(config.version_metadata ? [`${config.version_metadata.binding}:version_metadata`] : []),
    ...secrets.map(name => `${name}:secret_text`),
  ].sort();
}

/** What the readback of one Worker must be. */
function expectedWorker(config, secrets, hostname) {
  return {
    versions: [100],
    subdomain: { enabled: false, previews_enabled: false },
    schedules: [],
    domains: [`${hostname} enabled=true previews=false`],
    bindings: configBindings(config, secrets),
  };
}

export function expectedReadback({ e2eConfig, fakeConfig, workerHostname, fakeLlmHostname }) {
  return {
    [E2E_WORKER]: expectedWorker(e2eConfig, WORKER_SECRETS[E2E_WORKER], workerHostname),
    [FAKE_LLM_WORKER]: expectedWorker(fakeConfig, WORKER_SECRETS[FAKE_LLM_WORKER], fakeLlmHostname),
  };
}

function bindingName(binding) {
  const target =
    binding.type === 'durable_object_namespace'
      ? binding.class_name
      : binding.type === 'queue'
        ? binding.queue_name
        : binding.type === 'secrets_store_secret'
          ? binding.secret_name
          : undefined;
  return [binding.name, binding.type, ...(target === undefined ? [] : [target])].join(':');
}

/** Reduce the API results of one Worker to names only. */
export function namesOnly({ deployments, version, subdomain, schedules, domains }) {
  const active = deployments?.deployments?.[0];
  return {
    versions: (active?.versions ?? []).map(entry => entry.percentage),
    subdomain: {
      enabled: subdomain?.enabled,
      previews_enabled: subdomain?.previews_enabled,
    },
    schedules: (schedules?.schedules ?? []).map(schedule => schedule.cron).sort(),
    domains: (domains ?? [])
      .map(
        domain =>
          `${domain.hostname} enabled=${domain.enabled !== false} previews=${domain.previews_enabled === true}`
      )
      .sort(),
    bindings: (version?.resources?.bindings ?? [])
      .filter(
        binding =>
          !VARIABLE_TYPES.has(binding.type) &&
          !(binding.type === 'secret_text' && LATER_SECRETS.has(binding.name))
      )
      .map(bindingName)
      .sort(),
  };
}

/** Every difference between two readbacks, one line each. */
export function diffReadback(expected, actual) {
  const lines = [];
  for (const [worker, want] of Object.entries(expected)) {
    const got = actual[worker] ?? {};
    for (const field of Object.keys(want)) {
      const a = JSON.stringify(want[field]);
      const b = JSON.stringify(got[field]);
      if (a !== b) lines.push(`${worker} ${field}: expected ${a}, read ${b}`);
    }
  }
  return lines;
}

async function readWorker(api, script) {
  const deployments = await api(`/workers/scripts/${script}/deployments`);
  const versionId = deployments?.deployments?.[0]?.versions?.[0]?.version_id;
  return {
    versionId,
    names: namesOnly({
      deployments,
      version: versionId
        ? await api(`/workers/scripts/${script}/versions/${versionId}`)
        : undefined,
      subdomain: await api(`/workers/scripts/${script}/subdomain`),
      schedules: await api(`/workers/scripts/${script}/schedules`),
      domains: await api(`/workers/domains?service=${encodeURIComponent(script)}`),
    }),
  };
}

// Each GET has its own bound; a 5xx, a 429 or a timeout is retried twice.
const READ_TIMEOUT_MS = 30_000;
const READ_RETRIES = 2;

const isMain = (() => {
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  const [e2ePath, fakePath] = process.argv.slice(2);
  const {
    CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID,
    E2E_WORKER_HOSTNAME,
    E2E_FAKE_LLM_HOSTNAME,
  } = process.env;
  if (
    !e2ePath ||
    !fakePath ||
    !CLOUDFLARE_API_TOKEN ||
    !/^[a-f0-9]{32}$/.test(CLOUDFLARE_ACCOUNT_ID ?? '') ||
    !E2E_WORKER_HOSTNAME ||
    !E2E_FAKE_LLM_HOSTNAME
  ) {
    console.error(
      'Usage: readback-e2e-workers.mjs <rendered e2e config> <rendered fake-LLM config>, with CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, E2E_WORKER_HOSTNAME and E2E_FAKE_LLM_HOSTNAME set'
    );
    process.exit(2);
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}`;
  const api = async path => {
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await fetch(`${base}${path}`, {
          headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt <= READ_RETRIES) continue;
        throw new Error(
          `GET ${path.split('?')[0]}: ${error instanceof Error ? error.name : 'failed'}`
        );
      }
      if ((response.status === 429 || response.status >= 500) && attempt <= READ_RETRIES) {
        await response.body?.cancel();
        continue;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success !== true) {
        const codes = (body.errors ?? []).map(error => error.code).join(',');
        throw new Error(
          `GET ${path.split('?')[0]}: HTTP ${response.status}, error codes ${codes || 'none'}`
        );
      }
      return body.result;
    }
  };
  try {
    const expected = expectedReadback({
      e2eConfig: JSON.parse(readFileSync(e2ePath, 'utf8')),
      fakeConfig: JSON.parse(readFileSync(fakePath, 'utf8')),
      workerHostname: E2E_WORKER_HOSTNAME,
      fakeLlmHostname: E2E_FAKE_LLM_HOSTNAME,
    });
    const reads = {
      [E2E_WORKER]: await readWorker(api, E2E_WORKER),
      [FAKE_LLM_WORKER]: await readWorker(api, FAKE_LLM_WORKER),
    };
    // Outside the comparison: the version a rollback would leave.
    for (const [worker, read] of Object.entries(reads)) {
      console.log(`Active version of ${worker}: ${read.versionId ?? 'none'}`);
    }
    const actual = Object.fromEntries(
      Object.entries(reads).map(([worker, read]) => [worker, read.names])
    );
    console.log(JSON.stringify(actual, null, 2));
    const differences = diffReadback(expected, actual);
    if (differences.length > 0) {
      console.error(`Readback differs from the deployed configs:\n  ${differences.join('\n  ')}`);
      process.exit(1);
    }
    console.log('Readback matches the deployed configs.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
