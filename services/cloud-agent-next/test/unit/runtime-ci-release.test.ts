import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  localDirectoryArtifactStore,
  packageRuntimeRelease,
  sha256,
  writeTarEntries,
} from '../../scripts/publish-runtime.js';
import {
  prepareCandidateRelease,
  releaseBundleSchema,
  selectReleaseTarget,
  verifyReleaseBundle,
  type BaseEvidence,
} from '../../scripts/runtime-ci-release.js';
import type { RuntimeInputs } from '../../scripts/runtime-ci-inputs.js';
import { assertTrustedRuntimeCI } from '../../scripts/runtime-ci-command.js';
import { RUNTIME_BASE_ABI } from '../../src/shared/runtime-release.js';
import { unstable_readConfig } from 'wrangler';
import type { ArtifactObjectStore } from '../../src/sandbox-control/runtime-artifact-store.js';

const encode = (value: string) => new TextEncoder().encode(value);
const inputs: RuntimeInputs = {
  runtimeSha256: sha256(encode('runtime-a')),
  baseSha256: sha256(encode('base-a')),
  cliVersion: '7.8.1',
  wrapperSdkVersion: '7.8.1',
};
const base: BaseEvidence = {
  format: 'kilo-native-base-v1',
  inputSha256: inputs.baseSha256,
  image: `registry.cloudflare.com/${'a'.repeat(32)}/test-native-base@sha256:${'b'.repeat(64)}`,
  sourceSha: 'c'.repeat(40),
  platform: 'linux/amd64',
  abi: RUNTIME_BASE_ABI,
};
const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function packaged(control = 'control-a') {
  return packageRuntimeRelease({
    cliTarball: gzipSync(
      writeTarEntries([{ path: 'package/bin/kilo', mode: 0o755, bytes: encode('test-cli') }])
    ),
    cliVersion: inputs.cliVersion,
    cliExecutable: 'package/bin/kilo',
    wrapperSdkVersion: inputs.wrapperSdkVersion,
    protocol: 'control-plane-v1',
    abi: RUNTIME_BASE_ABI,
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
    caps: { maxTransferBytes: 4096, maxExpandedBytes: 4096, maxFileCount: 20 },
    controlEntries: [{ path: 'wrapper.js', mode: 0o644, bytes: encode(control) }],
  });
}

describe('CI runtime candidate publication', () => {
  let directory: string;
  let store: ArtifactObjectStore;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-release-test-'));
    store = localDirectoryArtifactStore(directory);
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('publishes verified candidates once and performs no build or writes on a hit', async () => {
    const packageRuntime = vi.fn(packaged);
    const buildBase = vi.fn(async () => base);
    const verifyBase = vi.fn(async () => {});
    const options = { store, inputs, packageRuntime, buildBase, verifyBase };
    const first = await prepareCandidateRelease(options);
    expect(first.runtimeReused).toBe(false);
    expect(first.baseReused).toBe(false);
    expect(
      await store.getBytes(`runtime-artifacts/v1/inputs/${inputs.runtimeSha256}.json`)
    ).not.toBeNull();
    expect(
      await store.getBytes(`runtime-artifacts/v1/bases/${inputs.baseSha256}.json`)
    ).not.toBeNull();
    const put = vi.spyOn(store, 'putIfAbsent');
    const second = await prepareCandidateRelease(options);
    expect(second).toEqual({ ...first, runtimeReused: true, baseReused: true });
    expect(packageRuntime).toHaveBeenCalledTimes(1);
    expect(buildBase).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
  });

  it('reuses the same CLI and base when only the control source changes', async () => {
    const first = await prepareCandidateRelease({
      store,
      inputs,
      packageRuntime: packaged,
      buildBase: async () => base,
      verifyBase: async () => {},
    });
    const nextInputs = { ...inputs, runtimeSha256: sha256(encode('runtime-b')) };
    const second = await prepareCandidateRelease({
      store,
      inputs: nextInputs,
      packageRuntime: () => packaged('control-b'),
      buildBase: async () => {
        throw new Error('base must be reused');
      },
      verifyBase: async () => {},
    });
    expect(second.base).toEqual(first.base);
    expect(second.baseReused).toBe(true);
    const descriptorA = JSON.parse(new TextDecoder().decode(first.descriptorBytes));
    const descriptorB = JSON.parse(new TextDecoder().decode(second.descriptorBytes));
    expect(descriptorB.artifacts[0]).toEqual(descriptorA.artifacts[0]);
    expect(descriptorB.artifacts[1].sha256).not.toBe(descriptorA.artifacts[1].sha256);
  });

  it.each([1, 2, 3, 4, 5])(
    'recovers after interruption at publication write %i',
    async failedWrite => {
      let write = 0;
      const interrupted: ArtifactObjectStore = {
        getBytes: key => store.getBytes(key),
        putIfAbsent: async (...args) => {
          write += 1;
          if (write === failedWrite) throw new Error('injected write failure');
          return store.putIfAbsent(...args);
        },
      };
      const options = {
        inputs,
        packageRuntime: packaged,
        buildBase: async () => base,
        verifyBase: async () => {},
      };
      await expect(prepareCandidateRelease({ ...options, store: interrupted })).rejects.toThrow(
        'injected write failure'
      );
      if (failedWrite <= 4)
        expect(
          await store.getBytes(`runtime-artifacts/v1/inputs/${inputs.runtimeSha256}.json`)
        ).toBeNull();
      const recovered = await prepareCandidateRelease({ ...options, store });
      expect(recovered.base.image).toBe(base.image);
      expect(
        await store.getBytes(`runtime-artifacts/v1/inputs/${inputs.runtimeSha256}.json`)
      ).not.toBeNull();
    }
  );

  it('fails closed on a corrupted cached payload instead of silently rebuilding', async () => {
    const prepared = await prepareCandidateRelease({
      store,
      inputs,
      packageRuntime: packaged,
      buildBase: async () => base,
      verifyBase: async () => {},
    });
    const descriptor = JSON.parse(new TextDecoder().decode(prepared.descriptorBytes));
    await fs.writeFile(
      path.join(directory, `runtime-artifacts/v1/objects/${descriptor.artifacts[0].sha256}`),
      'corrupted'
    );
    await expect(
      prepareCandidateRelease({
        store,
        inputs,
        packageRuntime: async () => {
          throw new Error('unexpected rebuild');
        },
        buildBase: async () => base,
        verifyBase: async () => {},
      })
    ).rejects.toThrow('verification failed');
  });

  it('does not retain a base completion record when registry verification fails', async () => {
    await expect(
      prepareCandidateRelease({
        store,
        inputs,
        packageRuntime: packaged,
        buildBase: async () => base,
        verifyBase: async () => {
          throw new Error('registry object is missing');
        },
      })
    ).rejects.toThrow('registry object is missing');
    expect(await store.getBytes(`runtime-artifacts/v1/bases/${inputs.baseSha256}.json`)).toBeNull();
  });
});

describe('CI runtime deployment contract', () => {
  it('uses the dedicated release bucket and rejects a missing or shared binding', async () => {
    const source = await fs.readFile(path.join(serviceRoot, 'wrangler.jsonc'), 'utf8');
    const selected = selectReleaseTarget(source, 'production');
    expect(selected.bucket).toBe('kilocode-cloud-agent-releases');
    const sessionBucket = selected.config.r2_buckets.find(
      binding => binding.binding === 'R2_BUCKET'
    );
    const releaseBucket = selected.config.r2_buckets.find(
      binding => binding.binding === 'RUNTIME_RELEASE_BUCKET'
    );
    expect(releaseBucket?.bucket_name).not.toBe(sessionBucket?.bucket_name);
    const missing = {
      ...selected.config,
      r2_buckets: selected.config.r2_buckets.filter(
        binding => binding.binding !== 'RUNTIME_RELEASE_BUCKET'
      ),
    };
    expect(() => selectReleaseTarget(JSON.stringify(missing), 'production')).toThrow(
      'requires the selected environment RUNTIME_RELEASE_BUCKET'
    );
    const shared = {
      ...selected.config,
      r2_buckets: selected.config.r2_buckets.map(binding =>
        binding.binding === 'RUNTIME_RELEASE_BUCKET'
          ? { ...binding, bucket_name: sessionBucket?.bucket_name }
          : binding
      ),
    };
    expect(() => selectReleaseTarget(JSON.stringify(shared), 'production')).toThrow(
      'dedicated bucket'
    );
  });

  it('passes the generated deployment configuration through the installed Wrangler validator', async () => {
    const source = await fs.readFile(path.join(serviceRoot, 'wrangler.jsonc'), 'utf8');
    const selected = selectReleaseTarget(source, 'production');
    const filename = path.join(serviceRoot, `wrangler.runtime-schema-${randomUUID()}.json`);
    const file = await fs.open(filename, 'wx');
    try {
      await file.writeFile(JSON.stringify(selected.config));
      const parsed = unstable_readConfig({ config: filename }, { hideWarnings: true });
      const original = unstable_readConfig(
        { config: path.join(serviceRoot, 'wrangler.jsonc') },
        { hideWarnings: true }
      );
      expect(parsed.name).toBe(original.name);
      expect(parsed.main).toBe(original.main);
      expect(parsed.containers).toEqual(original.containers);
      expect(parsed.r2_buckets).toEqual(original.r2_buckets);
      expect(parsed.vars).toEqual(original.vars);
    } finally {
      await file.close();
      await fs.rm(filename, { force: true });
    }
  });

  it('keeps every committed production binding and image unchanged', async () => {
    const source = await fs.readFile(path.join(serviceRoot, 'wrangler.jsonc'), 'utf8');
    const selected = selectReleaseTarget(source, 'production');
    const descriptorBytes = encode('{}');
    const bundle = releaseBundleSchema.parse({
      format: 'kilo-runtime-ci-v1',
      mode: 'candidate',
      sourceSha: 'd'.repeat(40),
      environment: 'production',
      accountId: selected.accountId,
      bucket: selected.bucket,
      configSha256: sha256(encode(source)),
      runtimeInputSha256: inputs.runtimeSha256,
      descriptorSha256: sha256(descriptorBytes),
      base: {
        ...base,
        image: `registry.cloudflare.com/${selected.accountId}/test-native-base@sha256:${'b'.repeat(64)}`,
      },
    });
    const options = {
      sourceSha: bundle.sourceSha,
      environment: 'production',
      configSource: source,
      inputs,
      descriptorBytes,
    };
    expect(verifyReleaseBundle(bundle, options)).toEqual(selected.config);
    expect(Object.hasOwn(selected.config.vars ?? {}, 'RUNTIME_RELEASE_DESCRIPTOR')).toBe(false);
    expect(() => verifyReleaseBundle(bundle, { ...options, sourceSha: 'e'.repeat(40) })).toThrow(
      'does not match'
    );
    expect(() =>
      verifyReleaseBundle(bundle, {
        ...options,
        inputs: { ...inputs, runtimeSha256: 'f'.repeat(64) },
      })
    ).toThrow('does not match');
    expect(() => selectReleaseTarget(source, 'staging')).toThrow('no committed env.staging');
    const activated = JSON.stringify({
      ...selected.config,
      vars: { ...selected.config.vars, RUNTIME_RELEASE_DESCRIPTOR: '' },
    });
    expect(() => selectReleaseTarget(activated, 'production')).toThrow('descriptor must be absent');
  });

  it.each([
    {},
    {
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/heads/feature',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
    },
    { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'pull_request' },
  ])('rejects local, feature-branch, and PR publication contexts', environment => {
    expect(() => assertTrustedRuntimeCI(environment)).toThrow('trusted main CI');
  });

  it('admits scheduled and manual execution from main', () => {
    for (const GITHUB_EVENT_NAME of ['schedule', 'workflow_dispatch'])
      expect(() =>
        assertTrustedRuntimeCI({
          GITHUB_ACTIONS: 'true',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_EVENT_NAME,
        })
      ).not.toThrow();
  });
});
