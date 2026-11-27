// Renders the deployed e2e Worker config from this package's production
// wrangler.jsonc, and the fake-LLM Worker config, and runs the fence that the
// deploy scripts run on the files they deploy (test/e2e/deploy/e2e-worker-fence.mjs).
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { renderRuntimeTarget } from './runtime-target.js';
import {
  buildE2eWorkerConfig,
  buildFakeLlmConfig,
} from '../test/e2e/deploy/render-e2e-worker-config.mjs';
import {
  collectProduction,
  fakeLlmViolations,
  violations,
} from '../test/e2e/deploy/e2e-worker-fence.mjs';

type RenderedConfig = Record<string, unknown> & {
  routes?: unknown[];
  triggers?: unknown;
  vars?: Record<string, unknown>;
  secrets_store_secrets?: unknown[];
  queues?: { consumers?: Array<Record<string, unknown>> };
};

const PROBE_HOST = 'cloud-agent-e2e.fence-probe.test';
const FAKE_HOST = 'fake-llm.fence-probe.test';
const access = { aud: 'a'.repeat(64), teamDomain: 'fence-probe.cloudflareaccess.com' };

const source = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const fakeLlmSource = parse(
  readFileSync(new URL('../test/e2e/wrangler.fake-llm.jsonc', import.meta.url), 'utf8')
);
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
    fakeLlmHostname: FAKE_HOST,
  });

const configured = { workerHostname: PROBE_HOST, fakeLlmHostname: FAKE_HOST };

describe('deployed e2e Worker fence', () => {
  it('binds no production resource and has no public address', () => {
    const config = render();
    expect(violations(config, production)).toEqual([]);
    expect(violations(config, production, { fakeLlmHostname: FAKE_HOST })).toEqual([]);
    expect(config.routes).toBeUndefined();
    expect(config.vars?.WORKER_URL).toBeUndefined();
  });

  it('reaches its Access hostname through one custom domain and nothing else', () => {
    const config = render(PROBE_HOST);
    expect(violations(config, production)).toEqual([]);
    expect(violations(config, production, configured)).toEqual([]);
    expect(config.routes).toEqual([{ pattern: PROBE_HOST, custom_domain: true }]);
    expect(config.vars).toMatchObject({
      WORKER_URL: `https://${PROBE_HOST}`,
      E2E_ACCESS_AUD: access.aud,
      E2E_ACCESS_TEAM_DOMAIN: access.teamDomain,
    });
  });

  it('sends model traffic and validation only to the fake-LLM Access hostname', () => {
    expect(render(PROBE_HOST).vars).toMatchObject({
      E2E_FAKE_LLM_URL: `https://${FAKE_HOST}`,
      KILO_OPENROUTER_BASE: `https://${FAKE_HOST}/api/openrouter`,
      E2E_MODEL_VALIDATION_BASE_URL: `https://${FAKE_HOST}`,
    });
  });

  // An empty list, not an absent key, is what clears live schedules on deploy.
  it('renders triggers.crons present and empty while the source has schedules', () => {
    expect(render().triggers).toEqual({ crons: [] });
    expect((source.triggers?.crons ?? []).length).toBeGreaterThan(0);
  });

  it('flags a config with no triggers and a config with schedules', () => {
    const { triggers: _triggers, ...withoutTriggers } = render();
    expect(violations(withoutTriggers, production)).toEqual([
      'triggers.crons: must be present and empty',
    ]);
    expect(violations({ ...render(), triggers: {} }, production)).toEqual([
      'triggers.crons: must be present and empty',
    ]);
    expect(violations({ ...render(), triggers: { crons: ['*/5 * * * *'] } }, production)).toEqual([
      'triggers.crons: must be present and empty',
    ]);
  });

  it('flags workers.dev and preview URLs that are not false', () => {
    for (const [key, value] of [
      ['workers_dev', true],
      ['workers_dev', undefined],
      ['preview_urls', true],
      ['preview_urls', undefined],
    ] as const) {
      const config: RenderedConfig = { ...render(PROBE_HOST) };
      if (value === undefined) delete config[key];
      else config[key] = value;
      expect(violations(config, production, configured), `${key}=${value}`).toEqual([
        `${key}: must be false`,
      ]);
    }
  });

  it('flags a callback origin that is not the configured Worker hostname', () => {
    const config = render(PROBE_HOST);
    for (const workerUrl of [
      'https://cloud-agent-e2e-test.engineering-e11.workers.dev',
      'https://other.fence-probe.test',
      `http://${PROBE_HOST}`,
      undefined,
    ]) {
      const vars: Record<string, unknown> = { ...config.vars, WORKER_URL: workerUrl };
      if (workerUrl === undefined) delete vars.WORKER_URL;
      expect(violations({ ...config, vars }, production, configured), String(workerUrl)).toEqual([
        'vars.WORKER_URL: must be https://<configured Worker hostname> or absent',
      ]);
    }
    // A configured hostname that differs from the rendered one fails on both.
    expect(
      violations(config, production, { ...configured, workerHostname: 'other.fence-probe.test' })
    ).toEqual([
      'routes: not the configured hostname',
      'vars.WORKER_URL: must be https://<configured Worker hostname> or absent',
    ]);
    // An unset hostname allows no route at all.
    expect(violations(config, production, { fakeLlmHostname: FAKE_HOST })).toEqual([
      'routes: none allowed without a configured hostname',
      'vars.WORKER_URL: must be https://<configured Worker hostname> or absent',
    ]);
  });

  it('flags a fake-LLM origin that is public or not the configured hostname', () => {
    const config = render(PROBE_HOST);
    for (const fakeUrl of [
      'https://fake-llm.engineering-e11.workers.dev',
      `https://${FAKE_HOST}/`,
      `http://${FAKE_HOST}`,
      'https://cloud-agent.kiloapps.ai',
    ]) {
      const vars = {
        ...config.vars,
        E2E_FAKE_LLM_URL: fakeUrl,
        KILO_OPENROUTER_BASE: `${fakeUrl}/api/openrouter`,
        E2E_MODEL_VALIDATION_BASE_URL: fakeUrl,
      };
      expect(violations({ ...config, vars }, production, configured), fakeUrl).toEqual([
        'vars.E2E_FAKE_LLM_URL: must be https://<configured fake-LLM hostname>',
      ]);
    }
    expect(
      violations(config, production, { ...configured, fakeLlmHostname: 'other.fence-probe.test' })
    ).toEqual(['vars.E2E_FAKE_LLM_URL: must be https://<configured fake-LLM hostname>']);
    const stray = {
      ...config.vars,
      KILO_OPENROUTER_BASE: 'https://fake-llm.engineering-e11.workers.dev/api/openrouter',
      E2E_MODEL_VALIDATION_BASE_URL: 'https://fake-llm.engineering-e11.workers.dev',
    };
    expect(violations({ ...config, vars: stray }, production, configured)).toEqual([
      'vars.KILO_OPENROUTER_BASE: must be the fake-LLM origin',
      'vars.E2E_MODEL_VALIDATION_BASE_URL: must be the fake-LLM origin',
    ]);
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
      fakeLlmHostname: FAKE_HOST,
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
      expect(() => buildE2eWorkerConfig(prepared, { fakeLlmHostname: host }), host).toThrow(
        /E2E_FAKE_LLM_HOSTNAME/
      );
    }
    expect(() => buildE2eWorkerConfig(prepared, {})).toThrow(/E2E_FAKE_LLM_HOSTNAME/);
    expect(() =>
      buildE2eWorkerConfig(prepared, {
        workerHostname: PROBE_HOST,
        access,
        fakeLlmHostname: PROBE_HOST,
      })
    ).toThrow(/differ/);
    for (const partial of [
      { ...access, aud: '' },
      { ...access, teamDomain: 'example.com' },
    ]) {
      expect(() =>
        buildE2eWorkerConfig(prepared, {
          workerHostname: PROBE_HOST,
          access: partial,
          fakeLlmHostname: FAKE_HOST,
        })
      ).toThrow(/E2E_ACCESS_/);
    }
  });

  it('flags every key outside the allowlist and every production queue or secret', () => {
    const found = violations(prepared, production);
    for (const expected of [
      'workers_dev: must be false',
      'triggers.crons: must be present and empty',
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

describe('fake-LLM Worker fence', () => {
  const fakeAccess = { aud: 'f'.repeat(64), teamDomain: 'fence-probe.cloudflareaccess.com' };
  const renderFake = () =>
    buildFakeLlmConfig(fakeLlmSource, { hostname: FAKE_HOST, access: fakeAccess });

  it('keeps the checked-in config without any public address', () => {
    expect(fakeLlmSource.workers_dev).toBe(false);
    expect(fakeLlmSource.preview_urls).toBe(false);
    expect(fakeLlmViolations(fakeLlmSource, production)).toEqual([]);
  });

  it('renders exactly the one configured Access hostname and its Access gate', () => {
    const config = renderFake();
    expect(config.routes).toEqual([{ pattern: FAKE_HOST, custom_domain: true }]);
    expect(config.main).toBe('../fake-llm-worker.ts');
    expect(config.vars).toEqual({
      E2E_ACCESS_AUD: fakeAccess.aud,
      E2E_ACCESS_TEAM_DOMAIN: fakeAccess.teamDomain,
    });
    expect(fakeLlmViolations(config, production, { hostname: FAKE_HOST })).toEqual([]);
  });

  it('flags workers.dev and preview URLs that are not false', () => {
    for (const [key, value] of [
      ['workers_dev', true],
      ['workers_dev', undefined],
      ['preview_urls', true],
      ['preview_urls', undefined],
    ] as const) {
      const config: Record<string, unknown> = { ...fakeLlmSource };
      if (value === undefined) delete config[key];
      else config[key] = value;
      expect(fakeLlmViolations(config, production), `${key}=${value}`).toEqual([
        `${key}: must be false`,
      ]);
    }
  });

  it('flags any host other than the configured one', () => {
    const config = renderFake();
    expect(fakeLlmViolations(config, production)).toEqual([
      'routes: none allowed without a configured hostname',
    ]);
    expect(fakeLlmViolations(config, production, { hostname: 'other.fence-probe.test' })).toEqual([
      'routes: not the configured hostname',
    ]);
    const extraRoute = {
      ...config,
      routes: [...config.routes, { pattern: 'fake-llm.engineering-e11.workers.dev/*' }],
    };
    expect(fakeLlmViolations(extraRoute, production, { hostname: FAKE_HOST })).toEqual([
      'routes: at most the one Access custom domain',
      'routes: only a custom domain',
      'routes: workers.dev host',
      'routes: not the configured hostname',
    ]);
    expect(
      fakeLlmViolations(
        { ...config, secrets_store_secrets: [{ secret_name: 'NEXTAUTH_SECRET' }] },
        production,
        { hostname: FAKE_HOST }
      )
    ).toEqual(['secrets_store_secrets: NEXTAUTH_SECRET']);
  });

  it('refuses to render a public or production hostname, or without its Access gate', () => {
    for (const host of [
      'fake-llm.engineering-e11.workers.dev',
      'https://fake-llm.fence-probe.test',
      undefined,
    ]) {
      expect(
        () => buildFakeLlmConfig(fakeLlmSource, { hostname: host, access: fakeAccess }),
        String(host)
      ).toThrow(/E2E_FAKE_LLM_HOSTNAME/);
    }
    expect(() =>
      buildFakeLlmConfig(fakeLlmSource, { hostname: FAKE_HOST, access: { ...fakeAccess, aud: '' } })
    ).toThrow(/E2E_FAKE_LLM_ACCESS_AUD/);
  });

  it('flags a rendered config without its Access gate or in development', () => {
    const config = renderFake();
    const vars: Record<string, unknown> = { ...config.vars, ENVIRONMENT: 'development' };
    delete vars.E2E_ACCESS_AUD;
    delete vars.E2E_ACCESS_TEAM_DOMAIN;
    expect(fakeLlmViolations({ ...config, vars }, production, { hostname: FAKE_HOST })).toEqual([
      'vars.ENVIRONMENT: must not be development',
      'vars.E2E_ACCESS_AUD: required with a route',
      'vars.E2E_ACCESS_TEAM_DOMAIN: required with a route',
    ]);
  });
});
