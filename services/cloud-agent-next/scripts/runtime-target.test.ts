import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { parse } from 'jsonc-parser';
import { selectRuntimeTarget, renderRuntimeTarget } from './runtime-target.js';
import {
  buildE2eWorkerConfig,
  buildLocalE2eWorkerConfig,
} from '../test/e2e/deploy/render-e2e-worker-config.mjs';

const startup = { mode: 'downloaded', image: 'runtime-free' } as const;
const release = {
  descriptorSha256: 'e'.repeat(64),
  bucket: 'runtime-test',
  baseImage:
    'registry.cloudflare.com/' + 'c'.repeat(32) + '/kilo-runtime-base@sha256:' + 'd'.repeat(64),
};
const baseline = () => ({
  vars: { EXISTING: 'keep' },
  containers: [
    {
      class_name: 'SandboxContainers',
      scheduling_policy: 'durable_object',
      images: { 'runtime-free': { dockerfile: './Dockerfile.containers.runtime-free' } },
    },
  ],
  env: {
    isolated: {
      vars: { EXISTING: 'isolated' },
      containers: [
        {
          class_name: 'SandboxContainers',
          scheduling_policy: 'durable_object',
          images: { 'runtime-free': { dockerfile: './Dockerfile.containers.runtime-free' } },
        },
      ],
    },
  },
});

it('renders the selected runtime-free digest and retains unrelated target settings', () => {
  const original = baseline();
  const output = renderRuntimeTarget({
    config: original,
    environment: 'production',
    startup,
    release,
  });
  expect(output.containers?.[0].images?.app).toBeUndefined();
  expect(output.containers?.[0].images?.['runtime-free']).toEqual({ image: release.baseImage });
  expect(output.vars).toMatchObject({
    EXISTING: 'keep',
    RUNTIME_STARTUP_MODE: 'downloaded',
    NATIVE_RUNTIME_IMAGE: 'runtime-free',
    RUNTIME_RELEASE_DESCRIPTOR: release.descriptorSha256,
  });
  expect(output.r2_buckets).toContainEqual({
    binding: 'RUNTIME_RELEASE_BUCKET',
    bucket_name: release.bucket,
  });
  expect(original.containers[0].images['runtime-free']).toEqual({
    dockerfile: './Dockerfile.containers.runtime-free',
  });
});
it('isolated rendering leaves production selection and vars untouched', () => {
  const output = renderRuntimeTarget({
    config: baseline(),
    environment: 'isolated',
    startup,
    release,
  });
  expect(output.vars).toEqual({ EXISTING: 'keep' });
  expect(output.env?.isolated).toMatchObject({
    vars: {
      EXISTING: 'isolated',
      RUNTIME_STARTUP_MODE: 'downloaded',
      NATIVE_RUNTIME_IMAGE: 'runtime-free',
    },
    containers: [{ images: { 'runtime-free': { image: release.baseImage } } }],
  });
});
it.each([
  { mode: 'downloaded', image: 'all-in-one' },
  { mode: 'preinstalled', image: 'all-in-one' },
])('rejects retired deployment selection %s', startup => {
  expect(() => selectRuntimeTarget({ default: startup, targets: {} }, 'production')).toThrow();
});
it.each([
  { ids: [] },
  { ids: ['*'] },
  { ids: ['not-an-org-id'] },
  { ids: ['9d278969-5453-4ae3-a51f-a8d2274a7b56'] },
])('rejects obsolete interactive org scope $ids', ({ ids: interactiveOrgIds }) => {
  expect(() =>
    selectRuntimeTarget({ default: { ...startup, interactiveOrgIds }, targets: {} }, 'production')
  ).toThrow();
});
it('renders the published Kilo v2 release for its organization scope', () => {
  const kilo2 = {
    orgIds: ['9d278969-5453-4ae3-a51f-a8d2274a7b56', '11111111-1111-4111-8111-111111111111'],
  };
  const output = renderRuntimeTarget({
    config: baseline(),
    environment: 'production',
    startup: { ...startup, kilo2 },
    release: { ...release, kilo2DescriptorSha256: 'f'.repeat(64) },
  });
  expect(output.vars).toMatchObject({
    RUNTIME_RELEASE_DESCRIPTOR: release.descriptorSha256,
    RUNTIME_KILO2_ORG_IDS: kilo2.orgIds.join(','),
    RUNTIME_RELEASE_DESCRIPTOR_KILO2: 'f'.repeat(64),
  });
  expect(
    renderRuntimeTarget({
      config: baseline(),
      environment: 'production',
      startup,
      release: { ...release, kilo2DescriptorSha256: 'f'.repeat(64) },
    }).vars
  ).not.toHaveProperty('RUNTIME_KILO2_ORG_IDS');
  expect(() =>
    renderRuntimeTarget({
      config: baseline(),
      environment: 'production',
      startup: { ...startup, kilo2 },
      release,
    })
  ).toThrow('Kilo v2 runtime handoff');
  for (const invalid of [{ orgIds: [] }, { orgIds: ['*'] }, { ...kilo2, descriptorSha256: 'f' }])
    expect(() =>
      selectRuntimeTarget({ default: { ...startup, kilo2: invalid }, targets: {} }, 'production')
    ).toThrow();
  expect(() =>
    renderRuntimeTarget({
      config: { ...baseline(), vars: { RUNTIME_KILO2_ORG_IDS: kilo2.orgIds[0] } },
      environment: 'production',
      startup,
      release,
    })
  ).toThrow('configuration drift');
});
it('rejects manual cohort settings and secondary image drift', () => {
  const scopedVars = { ...baseline(), vars: { RUNTIME_INTERACTIVE_ORG_IDS: '*' } };
  expect(() =>
    renderRuntimeTarget({ config: scopedVars, environment: 'production', startup, release })
  ).toThrow('configuration drift');
  const imageDrift = baseline();
  Object.assign(imageDrift.containers[0].images, { 'runtime-free': { image: release.baseImage } });
  expect(() =>
    renderRuntimeTarget({ config: imageDrift, environment: 'production', startup, release })
  ).toThrow('configuration drift');
});
it('rejects manual Worker settings and image drift before rendering', () => {
  const varsDrift = { ...baseline(), vars: { RUNTIME_STARTUP_MODE: 'downloaded' } };
  expect(() =>
    renderRuntimeTarget({ config: varsDrift, environment: 'production', startup, release })
  ).toThrow('configuration drift');
  const imageDrift = baseline();
  imageDrift.containers[0].images['runtime-free'].dockerfile = './other';
  expect(() =>
    renderRuntimeTarget({ config: imageDrift, environment: 'production', startup, release })
  ).toThrow('configuration drift');
});
it('rejects an invalid startup pair in the target catalog', () => {
  expect(() =>
    selectRuntimeTarget(
      { default: { mode: 'preinstalled', image: 'runtime-free' }, targets: {} },
      'production'
    )
  ).toThrow();
});

it('an unlisted constructor environment inherits the default rather than the prototype', () => {
  const fallback = { mode: 'downloaded', image: 'runtime-free' };
  expect(selectRuntimeTarget({ default: fallback, targets: {} }, 'constructor')).toEqual(fallback);
});
it('rejects a misspelled mode in the catalog before publication lookup', () => {
  expect(() =>
    selectRuntimeTarget(
      { default: { mode: 'downlaoded', image: 'all-in-one' }, targets: {} },
      'production'
    )
  ).toThrow();
});

it('keeps verified downloaded runtime selection in deployed E2E configuration', () => {
  const source = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const prepared = renderRuntimeTarget({
    config: source,
    environment: 'production',
    startup,
    release,
  });
  const output = buildE2eWorkerConfig(prepared, {
    workerUrl: 'https://e2e.example.test',
    kiloOpenRouterBase: 'https://fake.example.test/api/openrouter',
  });
  expect(output.vars).toMatchObject({
    RUNTIME_STARTUP_MODE: 'downloaded',
    NATIVE_RUNTIME_IMAGE: 'runtime-free',
    RUNTIME_RELEASE_DESCRIPTOR: release.descriptorSha256,
  });
  expect(output.containers[0].images).toEqual({
    'runtime-free': { image: release.baseImage, dockerfile: undefined },
  });
  expect(output.r2_buckets).toContainEqual({
    binding: 'RUNTIME_RELEASE_BUCKET',
    bucket_name: release.bucket,
  });
});

it('rebases only the runtime-free base for local HTTP E2E startup', () => {
  const source = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const output = buildLocalE2eWorkerConfig(source);
  expect(output.env.dev.containers[0].images).toEqual({
    'runtime-free': { dockerfile: '../Dockerfile.containers.runtime-free' },
  });
  expect(output.env.dev.r2_buckets).toContainEqual({
    binding: 'RUNTIME_RELEASE_BUCKET',
    bucket_name: 'cloud-agent-runtime-dev',
  });
});
