// The post-deploy readback (test/e2e/deploy/readback-e2e-workers.mjs) compares
// names-only Cloudflare API results with what the deployed configs produce.
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
  diffReadback,
  E2E_WORKER,
  expectedReadback,
  FAKE_LLM_WORKER,
  namesOnly,
} from '../test/e2e/deploy/readback-e2e-workers.mjs';

const WORKER_HOST = 'cloud-agent-e2e.readback-probe.test';
const FAKE_HOST = 'fake-llm.readback-probe.test';

const prepared = renderRuntimeTarget({
  config: parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')),
  environment: 'production',
  startup: { mode: 'downloaded', image: 'runtime-free' },
  release: {
    descriptorSha256: 'e'.repeat(64),
    bucket: 'cloud-agent-runtime-readback-probe',
    baseImage:
      'registry.cloudflare.com/' + 'c'.repeat(32) + '/kilo-runtime-base@sha256:' + 'd'.repeat(64),
  },
});
const e2eConfig = buildE2eWorkerConfig(prepared, {
  workerHostname: WORKER_HOST,
  access: { aud: 'a'.repeat(64), teamDomain: 'probe.cloudflareaccess.com' },
  fakeLlmHostname: FAKE_HOST,
});
const fakeConfig = buildFakeLlmConfig(
  parse(readFileSync(new URL('../test/e2e/wrangler.fake-llm.jsonc', import.meta.url), 'utf8')),
  { hostname: FAKE_HOST, access: { aud: 'f'.repeat(64), teamDomain: 'probe.cloudflareaccess.com' } }
);
const expected = expectedReadback({
  e2eConfig,
  fakeConfig,
  workerHostname: WORKER_HOST,
  fakeLlmHostname: FAKE_HOST,
});

type ApiBinding = Record<string, string>;

/** API results a correct deploy of `config` returns. */
function apiResults(config: typeof e2eConfig, secrets: string[], hostname: string) {
  const bindings: ApiBinding[] = [
    ...config.durable_objects.bindings.map((b: { name: string; class_name: string }) => ({
      name: b.name,
      type: 'durable_object_namespace',
      class_name: b.class_name,
      namespace_id: 'ns',
    })),
    ...(config.queues?.producers ?? []).map((p: { binding: string; queue: string }) => ({
      name: p.binding,
      type: 'queue',
      queue_name: p.queue,
    })),
    ...(config.secrets_store_secrets ?? []).map(
      (s: { binding: string; store_id: string; secret_name: string }) => ({
        name: s.binding,
        type: 'secrets_store_secret',
        store_id: s.store_id,
        secret_name: s.secret_name,
      })
    ),
    ...(config.version_metadata
      ? [{ name: config.version_metadata.binding, type: 'version_metadata' }]
      : []),
    ...secrets.map(name => ({ name, type: 'secret_text' })),
    { name: 'WORKER_URL', type: 'plain_text', text: `https://${hostname}` },
  ];
  return {
    deployments: { deployments: [{ versions: [{ version_id: 'v', percentage: 100 }] }] },
    version: { resources: { bindings } },
    subdomain: { enabled: false, previews_enabled: false },
    schedules: { schedules: [] as Array<{ cron: string }> },
    domains: [{ hostname, enabled: true, previews_enabled: false, service: 'x' }],
  };
}

const goodE2e = () =>
  apiResults(
    e2eConfig,
    ['INTERNAL_API_SECRET', 'E2E_ACCESS_CLIENT_ID', 'E2E_ACCESS_CLIENT_SECRET'],
    WORKER_HOST
  );
const goodFake = () => apiResults(fakeConfig, ['FAKE_LLM_ADMIN_TOKEN'], FAKE_HOST);
const read = (e2e = goodE2e(), fake = goodFake()) => ({
  [E2E_WORKER]: namesOnly(e2e),
  [FAKE_LLM_WORKER]: namesOnly(fake),
});

describe('post-deploy readback', () => {
  it('passes a deploy that matches the configs, variables left out', () => {
    expect(diffReadback(expected, read())).toEqual([]);
    expect(read()[FAKE_LLM_WORKER].bindings).toEqual([
      'FAKE_LLM:durable_object_namespace:FakeLlmState',
      'FAKE_LLM_ADMIN_TOKEN:secret_text',
      'NEXTAUTH_SECRET:secrets_store_secret:NEXTAUTH_SECRET_DEV',
    ]);
  });

  it('flags a live schedule, an open workers.dev or preview URL, and a split deployment', () => {
    const e2e = goodE2e();
    e2e.schedules = { schedules: [{ cron: '*/5 * * * *' }] };
    e2e.subdomain = { enabled: true, previews_enabled: false };
    const fake = goodFake();
    fake.subdomain = { enabled: false, previews_enabled: true };
    fake.deployments = {
      deployments: [
        {
          versions: [
            { version_id: 'a', percentage: 90 },
            { version_id: 'b', percentage: 10 },
          ],
        },
      ],
    };
    expect(diffReadback(expected, read(e2e, fake))).toEqual([
      `${E2E_WORKER} subdomain: expected {"enabled":false,"previews_enabled":false}, read {"enabled":true,"previews_enabled":false}`,
      `${E2E_WORKER} schedules: expected [], read ["*/5 * * * *"]`,
      `${FAKE_LLM_WORKER} versions: expected [100], read [90,10]`,
      `${FAKE_LLM_WORKER} subdomain: expected {"enabled":false,"previews_enabled":false}, read {"enabled":false,"previews_enabled":true}`,
    ]);
  });

  it('flags a production binding, a missing secret and an extra domain', () => {
    const e2e = goodE2e();
    e2e.version.resources.bindings = [
      ...e2e.version.resources.bindings.filter(b => b.name !== 'INTERNAL_API_SECRET'),
      { name: 'HYPERDRIVE', type: 'hyperdrive', id: 'x' },
    ];
    e2e.domains.push({
      hostname: 'cloud-agent.kiloapps.ai',
      enabled: true,
      previews_enabled: false,
      service: 'x',
    });
    const fake = goodFake();
    fake.version.resources.bindings = fake.version.resources.bindings.map(b =>
      b.type === 'secrets_store_secret' ? { ...b, secret_name: 'NEXTAUTH_SECRET' } : b
    );
    const lines = diffReadback(expected, read(e2e, fake));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(new RegExp(`^${E2E_WORKER} domains: `));
    expect(lines[1]).toMatch(/HYPERDRIVE:hyperdrive/);
    expect(lines[2]).toMatch(/NEXTAUTH_SECRET:secrets_store_secret:NEXTAUTH_SECRET"/);
  });

  it('ignores only the Access secret texts, not another binding with their names', () => {
    const e2e = goodE2e();
    e2e.version.resources.bindings.push({
      name: 'E2E_ACCESS_CLIENT_ID',
      type: 'secrets_store_secret',
      store_id: 'x',
      secret_name: 'E2E_ACCESS_CLIENT_ID_PROD',
    });
    const lines = diffReadback(expected, read(e2e));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/E2E_ACCESS_CLIENT_ID:secrets_store_secret:E2E_ACCESS_CLIENT_ID_PROD/);
  });
});
