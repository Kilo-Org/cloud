import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import { URL } from 'node:url';
import { parse } from 'jsonc-parser';
import { selectRuntimeTarget, renderRuntimeTarget } from './runtime-target.js';

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
      images: { app: { dockerfile: './Dockerfile.containers' } },
    },
  ],
  env: {
    isolated: {
      vars: { EXISTING: 'isolated' },
      containers: [
        {
          class_name: 'SandboxContainers',
          scheduling_policy: 'durable_object',
          images: { app: { dockerfile: './Dockerfile.containers' } },
        },
      ],
    },
  },
});

it('the committed catalog keeps all targets preinstalled/all-in-one', async () => {
  const catalog: unknown = JSON.parse(
    await fs.readFile(new URL('../runtime-targets.json', import.meta.url), 'utf8')
  );
  for (const target of ['production', 'dev', 'isolated'])
    expect(selectRuntimeTarget(catalog, target)).toEqual({
      mode: 'preinstalled',
      image: 'all-in-one',
    });
});
it('renders both real Wrangler targets without publication credentials', async () => {
  const raw: unknown = parse(
    await fs.readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
  );
  for (const environment of ['production', 'dev']) {
    const output = renderRuntimeTarget({
      config: raw,
      environment,
      startup: { mode: 'preinstalled', image: 'all-in-one' },
    });
    const target = environment === 'production' ? output : output.env?.dev;
    expect(target).toMatchObject({
      vars: { RUNTIME_STARTUP_MODE: 'preinstalled', NATIVE_RUNTIME_IMAGE: 'all-in-one' },
    });
  }
});
it('renders the selected runtime-free digest and retains unrelated target settings', () => {
  const original = baseline();
  const output = renderRuntimeTarget({
    config: original,
    environment: 'production',
    startup,
    release,
  });
  expect(output.containers?.[0].images?.app).toEqual({ dockerfile: './Dockerfile.containers' });
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
  expect(original.containers[0].images.app).toEqual({ dockerfile: './Dockerfile.containers' });
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
it('supports independent image rollback, then mode rollback', () => {
  const imageRollback = renderRuntimeTarget({
    config: baseline(),
    environment: 'production',
    startup: { mode: 'downloaded', image: 'all-in-one' },
    release,
  });
  expect(imageRollback.vars?.RUNTIME_STARTUP_MODE).toBe('downloaded');
  expect(imageRollback.containers?.[0].images?.app).toEqual({
    dockerfile: './Dockerfile.containers',
  });
  const modeRollback = renderRuntimeTarget({
    config: baseline(),
    environment: 'production',
    startup: { mode: 'preinstalled', image: 'all-in-one' },
  });
  expect(modeRollback.vars?.RUNTIME_STARTUP_MODE).toBe('preinstalled');
  expect(modeRollback.vars?.RUNTIME_RELEASE_DESCRIPTOR).toBeUndefined();
  expect(modeRollback.vars?.RUNTIME_INTERACTIVE_ORG_IDS).toBeUndefined();
  expect(modeRollback.containers?.[0].images?.['runtime-free']).toBeUndefined();
});
it('renders scoped startup without replacing the baseline image or changing provider enrollment', () => {
  const config = baseline();
  Object.assign(config.vars, { CLOUDFLARE_CONTAINERS_ORG_IDS: '*' });
  const output = renderRuntimeTarget({
    config,
    environment: 'production',
    startup: { ...startup, interactiveOrgIds: ['9d278969-5453-4ae3-a51f-a8d2274a7b56'] },
    release,
  });
  expect(output.vars).toMatchObject({
    RUNTIME_INTERACTIVE_ORG_IDS: '9d278969-5453-4ae3-a51f-a8d2274a7b56',
    CLOUDFLARE_CONTAINERS_ORG_IDS: '*',
  });
  expect(output.containers?.[0].images).toEqual({
    app: { dockerfile: './Dockerfile.containers' },
    'runtime-free': { image: release.baseImage },
  });
});
it.each([{ ids: [] }, { ids: ['*'] }, { ids: ['not-an-org-id'] }])(
  'rejects invalid interactive org scope $ids',
  ({ ids: interactiveOrgIds }) => {
    expect(() =>
      selectRuntimeTarget({ default: { ...startup, interactiveOrgIds }, targets: {} }, 'production')
    ).toThrow();
  }
);
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
  imageDrift.containers[0].images.app.dockerfile = './other';
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
  const fallback = { mode: 'preinstalled', image: 'all-in-one' };
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
