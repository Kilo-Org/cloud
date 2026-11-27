// Renders the deployed e2e Worker config from this package's production
// wrangler.jsonc and runs the fence that deploy-e2e-worker.sh runs on the file it
// deploys (test/e2e/deploy/e2e-worker-fence.mjs).
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { renderRuntimeTarget } from './runtime-target.js';
import { buildE2eWorkerConfig } from '../test/e2e/deploy/render-e2e-worker-config.mjs';
import { collectProduction, violations } from '../test/e2e/deploy/e2e-worker-fence.mjs';

type RenderedConfig = Record<string, unknown> & {
  routes?: unknown[];
  vars?: Record<string, unknown>;
  secrets_store_secrets?: unknown[];
  queues?: { consumers?: Array<Record<string, unknown>> };
};

const PROBE_HOST = 'cloud-agent-e2e.fence-probe.test';
const access = { aud: 'a'.repeat(64), teamDomain: 'fence-probe.cloudflareaccess.com' };

const source = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const prepared = renderRuntimeTarget({
  config: source,
  environment: 'production',
  startup: { mode: 'downloaded', image: 'runtime-free' },
  release: {
    descriptorSha256: 'e'.repeat(64),
    bucket: 'cloud-agent-runtime-fence-probe',
    baseImage:
      'registry.cloudflare.com/' + 'c'.repeat(32) + '/kilo-runtime-base@sha256:' + 'd'.repeat(64),
  },
});
const production = collectProduction([prepared]);

const render = (workerHostname?: string): RenderedConfig =>
  buildE2eWorkerConfig(prepared, {
    ...(workerHostname === undefined ? {} : { workerHostname, access }),
    kiloOpenRouterBase: 'https://fake.fence-probe.test/api/openrouter',
  });

describe('deployed e2e Worker fence', () => {
  it('binds no production resource and has no public address', () => {
    const config = render();
    expect(violations(config, production)).toEqual([]);
    expect(config.routes).toBeUndefined();
    expect(config.vars?.WORKER_URL).toBeUndefined();
  });

  it('reaches its Access hostname through one custom domain and nothing else', () => {
    const config = render(PROBE_HOST);
    expect(violations(config, production)).toEqual([]);
    expect(config.routes).toEqual([{ pattern: PROBE_HOST, custom_domain: true }]);
    expect(config.vars).toMatchObject({
      WORKER_URL: `https://${PROBE_HOST}`,
      E2E_ACCESS_AUD: access.aud,
      E2E_ACCESS_TEAM_DOMAIN: access.teamDomain,
    });
  });

  // Intended switch: production binds the production-labelled signing secret;
  // the e2e Worker binds only the development key.
  it('binds only the development signing key', () => {
    expect(render().secrets_store_secrets).toEqual([
      {
        binding: 'NEXTAUTH_SECRET',
        store_id: '342a86d9e3a94da698e82d0c6e2a36f0',
        secret_name: 'NEXTAUTH_SECRET_DEV',
      },
    ]);
  });

  it('drops a dead-letter queue the source adds to the callback consumer', () => {
    // The production source has no callback dead-letter queue today; add one.
    const withDeadLetter = structuredClone(prepared) as typeof prepared & {
      queues: { consumers: Array<Record<string, unknown>> };
    };
    withDeadLetter.queues.consumers[0].dead_letter_queue = 'cloud-agent-next-callback-queue-dlq';
    const config = buildE2eWorkerConfig(withDeadLetter, {
      kiloOpenRouterBase: 'https://fake.fence-probe.test/api/openrouter',
    }) as RenderedConfig;
    expect(config.queues?.consumers?.[0]).not.toHaveProperty('dead_letter_queue');
  });

  it('refuses a hostname that is public or overlaps production, or lacks Access', () => {
    for (const host of [
      'cloud-agent-e2e-test.engineering-e11.workers.dev',
      'cloud-agent.kiloapps.ai',
      'preview.cloud-agent.kiloapps.ai',
      '*.fence-probe.test',
      'https://cloud-agent-e2e.fence-probe.test',
    ]) {
      expect(() => render(host), host).toThrow(/E2E_WORKER_HOSTNAME/);
    }
    for (const partial of [
      { ...access, aud: '' },
      { ...access, teamDomain: 'example.com' },
    ]) {
      expect(() =>
        buildE2eWorkerConfig(prepared, {
          workerHostname: PROBE_HOST,
          access: partial,
          kiloOpenRouterBase: 'https://fake.fence-probe.test/api/openrouter',
        })
      ).toThrow(/E2E_ACCESS_/);
    }
  });

  it('flags every key outside the allowlist and every production queue or secret', () => {
    const found = violations(prepared, production);
    for (const expected of [
      'workers_dev: must be false',
      'triggers.crons: must be empty',
      'logpush: not allowed',
      'services: not allowed',
      'hyperdrive: not allowed',
      'r2_buckets: not allowed',
      'ai: not allowed',
      'routes: overlaps a production host',
      'queues: production cloud-agent-next-callback-queue',
      'queues: production cloud-agent-next-report-queue-dlq',
      'secrets_store_secrets: INTERNAL_API_SECRET_PROD',
    ]) {
      expect(found).toContain(expected);
    }
    const extra = {
      ...render(),
      vpc_services: [{ binding: 'VPC', service_id: 'x' }],
      ratelimits: [{ name: 'LIMIT', namespace_id: '1' }],
      worker_loaders: [{ binding: 'LOADER' }],
      services: [],
    };
    expect(violations(extra, production)).toEqual([
      'vpc_services: not allowed',
      'ratelimits: not allowed',
      'worker_loaders: not allowed',
      'services: not allowed',
    ]);
  });

  it('flags a development environment and a route without Access', () => {
    const config = render(PROBE_HOST);
    const vars: Record<string, unknown> = { ...config.vars, ENVIRONMENT: 'development' };
    delete vars.E2E_ACCESS_AUD;
    delete vars.E2E_ACCESS_TEAM_DOMAIN;
    expect(violations({ ...config, vars }, production)).toEqual([
      'vars.ENVIRONMENT: must not be development',
      'vars.E2E_ACCESS_AUD: required with a route',
      'vars.E2E_ACCESS_TEAM_DOMAIN: required with a route',
    ]);
  });
});
