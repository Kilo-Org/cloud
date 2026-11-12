import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureRuntime } from '../test/runtime-installer/fixtures.js';
import { localDirectoryArtifactStore, publishRuntimeRelease } from './publish-runtime.js';
import { publishRuntimeHandoff, loadRuntimeHandoff, runtimeHandoffKey } from './runtime-handoff.js';
import { runtimeBaseInputId, type RuntimeBase } from './runtime-base.js';
import { prepareRuntimeDeployment } from './prepare-runtime-deploy.js';
import { RUNTIME_BASE_ABI } from '../src/sandbox-control/runtime-release.js';
import {
  runtimeArtifactObjectKey,
  runtimeArtifactReleaseKey,
} from '../src/sandbox-control/runtime-artifact-keys.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-handoff-test-'));
  temporary.push(root);
  const store = localDirectoryArtifactStore(root);
  const packaged = await fixtureRuntime();
  const published = await publishRuntimeRelease(store, packaged);
  const base: RuntimeBase = {
    format: 1,
    inputId: 'b'.repeat(64),
    platform: 'linux/amd64',
    abi: RUNTIME_BASE_ABI,
    image:
      'registry.cloudflare.com/' + 'c'.repeat(32) + '/kilo-runtime-base@sha256:' + 'd'.repeat(64),
  };
  const sourceSha = 'a'.repeat(40);
  return { root, store, packaged, published, base, sourceSha };
}
describe('retained exact-SHA handoff', () => {
  it('reuses bytes on retry and survives a branch moving or disappearing', async () => {
    const f = await fixture();
    const input = { ...f, descriptor: f.packaged.descriptor };
    const first = await publishRuntimeHandoff(input);
    const before = await f.store.getBytes(runtimeHandoffKey(f.sourceSha));
    expect(await publishRuntimeHandoff(input)).toEqual(first);
    expect(await f.store.getBytes(runtimeHandoffKey(f.sourceSha))).toEqual(before);
    const loaded = await loadRuntimeHandoff(f.store, f.sourceSha, f.base.inputId);
    expect(loaded.handoff.sourceSha).toBe(f.sourceSha);
    expect(loaded.descriptor).toEqual(f.packaged.descriptor);
    await expect(loadRuntimeHandoff(f.store, 'e'.repeat(40), f.base.inputId)).rejects.toThrow(
      'Exact-SHA'
    );
  });
  for (const fault of ['missing', 'corrupt'])
    it(fault + ' payload blocks handoff publication', async () => {
      const f = await fixture();
      const target = path.join(f.root, runtimeArtifactObjectKey(f.packaged.control.sha256));
      if (fault === 'missing') await fs.rm(target);
      else await fs.writeFile(target, 'corrupt');
      await expect(
        publishRuntimeHandoff({ ...f, descriptor: f.packaged.descriptor })
      ).rejects.toThrow('payload');
      expect(await f.store.getBytes(runtimeHandoffKey(f.sourceSha))).toBeNull();
    });
  it('rejects descriptor corruption and base-input drift', async () => {
    const f = await fixture();
    await publishRuntimeHandoff({ ...f, descriptor: f.packaged.descriptor });
    await expect(loadRuntimeHandoff(f.store, f.sourceSha, 'f'.repeat(64))).rejects.toThrow(
      'inputs'
    );
    await fs.writeFile(
      path.join(f.root, runtimeArtifactReleaseKey(f.published.descriptor.sha256)),
      'corrupt'
    );
    await expect(loadRuntimeHandoff(f.store, f.sourceSha, f.base.inputId)).rejects.toThrow(
      'descriptor'
    );
  });
  it('rejects an immutable exact-SHA conflict', async () => {
    const f = await fixture();
    await publishRuntimeHandoff({ ...f, descriptor: f.packaged.descriptor });
    const base = { ...f.base, image: f.base.image.replace('d'.repeat(64), 'e'.repeat(64)) };
    await expect(
      publishRuntimeHandoff({ ...f, base, descriptor: f.packaged.descriptor })
    ).rejects.toThrow('stored-byte');
  });
});
describe('Kilo v2 release in the handoff', () => {
  const kilo2Org = '9d278969-5453-4ae3-a51f-a8d2274a7b56';
  async function withKilo2() {
    const f = await fixture();
    const kilo2 = await fixtureRuntime('B', 'B', { cliExecutable: 'package/bin/kilo2' });
    const published = await publishRuntimeRelease(f.store, kilo2);
    return { ...f, kilo2, kilo2Published: published };
  }
  const prepare = (f: Awaited<ReturnType<typeof fixture>>, kilo2?: { orgIds: string[] }) =>
    prepareRuntimeDeployment({
      config: {
        r2_buckets: [{ binding: 'RUNTIME_RELEASE_BUCKET', bucket_name: 'runtime-test' }],
        vars: {},
        containers: [
          {
            class_name: 'SandboxContainers',
            scheduling_policy: 'durable_object',
            images: { 'runtime-free': { dockerfile: './Dockerfile.containers.runtime-free' } },
          },
        ],
      },
      startup: { mode: 'downloaded', image: 'runtime-free', ...(kilo2 ? { kilo2 } : {}) },
      environment: 'production',
      sourceSha: f.sourceSha,
      bucket: 'runtime-test',
      accountId: 'c'.repeat(32),
      baseInputId: f.base.inputId,
      store: f.store,
      verifyBase: () => {},
    });

  it('records the v2 release and renders it only for a v2 catalog target', async () => {
    const f = await withKilo2();
    const handoff = await publishRuntimeHandoff({
      ...f,
      descriptor: f.packaged.descriptor,
      kilo2Descriptor: f.kilo2.descriptor,
    });
    expect(handoff.kilo2DescriptorSha256).toBe(f.kilo2Published.descriptor.sha256);
    const loaded = await loadRuntimeHandoff(f.store, f.sourceSha, f.base.inputId);
    expect(loaded.kilo2Descriptor).toEqual(f.kilo2.descriptor);
    const rendered = await prepare(f, { orgIds: [kilo2Org] });
    expect(rendered?.vars).toMatchObject({
      RUNTIME_RELEASE_DESCRIPTOR: f.published.descriptor.sha256,
      RUNTIME_RELEASE_DESCRIPTOR_KILO2: f.kilo2Published.descriptor.sha256,
      RUNTIME_KILO2_ORG_IDS: kilo2Org,
    });
    expect((await prepare(f))?.vars).not.toHaveProperty('RUNTIME_RELEASE_DESCRIPTOR_KILO2');
  });
  it('rejects a v2 target when the handoff has no v2 release', async () => {
    const f = await fixture();
    await publishRuntimeHandoff({ ...f, descriptor: f.packaged.descriptor });
    await expect(prepare(f, { orgIds: [kilo2Org] })).rejects.toThrow('Kilo v2 runtime handoff');
  });
  it('rejects swapped or corrupt harness releases before writing the handoff', async () => {
    const f = await withKilo2();
    await expect(
      publishRuntimeHandoff({
        ...f,
        descriptor: f.packaged.descriptor,
        kilo2Descriptor: f.packaged.descriptor,
      })
    ).rejects.toThrow('Kilo v2 release');
    await expect(publishRuntimeHandoff({ ...f, descriptor: f.kilo2.descriptor })).rejects.toThrow(
      'Kilo v1 release'
    );
    await fs.writeFile(
      path.join(f.root, runtimeArtifactReleaseKey(f.kilo2Published.descriptor.sha256)),
      'corrupt'
    );
    await expect(
      publishRuntimeHandoff({
        ...f,
        descriptor: f.packaged.descriptor,
        kilo2Descriptor: f.kilo2.descriptor,
      })
    ).rejects.toThrow('descriptor');
    expect(await f.store.getBytes(runtimeHandoffKey(f.sourceSha))).toBeNull();
  });
});
describe('deployment preparation', () => {
  const config = () => ({
    r2_buckets: [{ binding: 'RUNTIME_RELEASE_BUCKET', bucket_name: 'runtime-test' }],
    vars: {},
    containers: [
      {
        class_name: 'SandboxContainers',
        scheduling_policy: 'durable_object',
        images: {
          'runtime-free': {
            dockerfile: './Dockerfile.containers.runtime-free',
          },
        },
      },
    ],
  });
  it('rejects mixed image fields before base verification', async () => {
    const f = await fixture();
    await publishRuntimeHandoff({ ...f, descriptor: f.packaged.descriptor });
    const changed = config();
    Object.assign(changed.containers[0].images['runtime-free'], { image: f.base.image });
    let verified = false;
    await expect(
      prepareRuntimeDeployment({
        config: changed,
        startup: { mode: 'downloaded', image: 'runtime-free' },
        environment: 'production',
        sourceSha: f.sourceSha,
        bucket: 'runtime-test',
        accountId: 'c'.repeat(32),
        baseInputId: f.base.inputId,
        store: f.store,
        verifyBase: () => {
          verified = true;
        },
      })
    ).rejects.toThrow('configuration drift');
    expect(verified).toBe(false);
  });
  it('rejects preinstalled before touching publication storage', async () => {
    const f = await fixture();
    let reads = 0;
    await expect(
      prepareRuntimeDeployment({
        config: config(),
        startup: { mode: 'preinstalled', image: 'all-in-one' } as never,
        environment: 'production',
        sourceSha: f.sourceSha,
        bucket: 'runtime-test',
        accountId: 'c'.repeat(32),
        baseInputId: f.base.inputId,
        store: {
          ...f.store,
          getBytes: async () => {
            reads++;
            throw new Error('storage unavailable');
          },
        },
        verifyBase: () => {
          throw new Error('must not verify base');
        },
      })
    ).rejects.toThrow();
    expect(reads).toBe(0);
  });
  it('renders the verified digest and descriptor only after verification', async () => {
    const f = await fixture();
    await publishRuntimeHandoff({ ...f, descriptor: f.packaged.descriptor });
    const order: string[] = [];
    const result = await prepareRuntimeDeployment({
      config: config(),
      startup: {
        mode: 'downloaded',
        image: 'runtime-free',
      },
      environment: 'production',
      sourceSha: f.sourceSha,
      bucket: 'runtime-test',
      accountId: 'c'.repeat(32),
      baseInputId: f.base.inputId,
      store: f.store,
      verifyBase: base => {
        expect(base).toEqual(f.base);
        order.push('verified');
      },
    });
    expect(order).toEqual(['verified']);
    expect(result?.containers?.[0].images?.app).toBeUndefined();
    expect(result?.containers?.[0].images?.['runtime-free']).toEqual({ image: f.base.image });
    expect(result?.vars?.RUNTIME_INTERACTIVE_ORG_IDS).toBeUndefined();
    expect(result?.vars?.RUNTIME_RELEASE_DESCRIPTOR).toBe(f.published.descriptor.sha256);
  });
  it('configuration drift prevents base verification and deployment', async () => {
    const f = await fixture();
    await publishRuntimeHandoff({ ...f, descriptor: f.packaged.descriptor });
    const changed = config();
    changed.containers[0].images['runtime-free'].dockerfile = './untrusted';
    let verified = false;
    await expect(
      prepareRuntimeDeployment({
        config: changed,
        startup: { mode: 'downloaded', image: 'runtime-free' },
        environment: 'production',
        sourceSha: f.sourceSha,
        bucket: 'runtime-test',
        accountId: 'c'.repeat(32),
        baseInputId: f.base.inputId,
        store: f.store,
        verifyBase: () => {
          verified = true;
        },
      })
    ).rejects.toThrow('configuration drift');
    expect(verified).toBe(false);
  });
  it('rejects bucket drift before any publication lookup', async () => {
    const f = await fixture();
    const changed = config();
    changed.r2_buckets[0].bucket_name = 'other-runtime';
    let reads = 0;
    await expect(
      prepareRuntimeDeployment({
        config: changed,
        environment: 'production',
        startup: { mode: 'downloaded', image: 'runtime-free' },
        sourceSha: f.sourceSha,
        bucket: 'runtime-test',
        accountId: 'c'.repeat(32),
        baseInputId: f.base.inputId,
        store: {
          ...f.store,
          getBytes: async () => {
            reads++;
            throw new Error('must not query storage');
          },
        },
        verifyBase: () => {},
      })
    ).rejects.toThrow('bucket binding changed');
    expect(reads).toBe(0);
  });
  it('rejects runtime-free with preinstalled', async () => {
    const f = await fixture();
    await expect(
      prepareRuntimeDeployment({
        config: config(),
        startup: { mode: 'preinstalled', image: 'runtime-free' } as never,
        environment: 'production',
        sourceSha: f.sourceSha,
        bucket: 'runtime-test',
        accountId: 'c'.repeat(32),
        baseInputId: f.base.inputId,
        store: f.store,
        verifyBase: () => {},
      })
    ).rejects.toThrow();
  });
});
describe('base input matrix', () => {
  it('runtime and unrelated changes reuse the base; base changes get a new identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-inputs-'));
    temporary.push(root);
    const recipe = path.join(root, 'Dockerfile.containers.runtime-free');
    await fs.writeFile(recipe, 'FROM debian:trixie-slim\nRUN true\n');
    const initial = await runtimeBaseInputId(root);
    for (const file of ['wrapper.ts', 'kilo-cli-version.ts', 'worker.ts']) {
      await fs.writeFile(path.join(root, file), 'changed');
      expect(await runtimeBaseInputId(root)).toBe(initial);
    }
    await fs.appendFile(recipe, 'RUN false\n');
    expect(await runtimeBaseInputId(root)).not.toBe(initial);
    await fs.appendFile(recipe, 'COPY undeclared /tmp/file\n');
    await expect(runtimeBaseInputId(root)).rejects.toThrow('Declare and hash');
  });
});
