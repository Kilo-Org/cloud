import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import type { Env } from '../types.js';
import type { HonoContext } from '../hono-context.js';
import { selectedRuntimeCli } from '../shared/runtime-distribution.js';
import { classifyControlPlaneFailure } from '../telemetry/control-plane-failure.js';
import { loadRuntimeRelease } from './runtime-release-loader.js';
import { downloadedStartup } from './downloaded-startup.js';
import { selectStartup, startupRepositoryKey } from './startup-selection.js';
import {
  mintRuntimeArtifactGrant,
  validateRuntimeArtifactGrant,
} from './runtime-artifact-grant.js';
import { registerRuntimeArtifactRoutes } from './runtime-artifact-routes.js';
import { STARTUP_FAILURES, registerStartupFailureRoute } from './startup-failure.js';
import { mintSandboxLaunchCredential } from './credential.js';
import {
  RUNTIME_BASE_ABI,
  serializeRuntimeRelease,
  type RuntimeInventoryEntry,
  type RuntimeReleaseDescriptor,
} from './runtime-release.js';
import { runtimeArtifactObjectKey } from './runtime-artifact-keys.js';

const hashes: [string, string] = ['a'.repeat(64), 'b'.repeat(64)];
const secret = 'test-signing-secret';
const descriptor: RuntimeReleaseDescriptor = {
  format: 1,
  bootstrap: 1,
  platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
  abi: RUNTIME_BASE_ABI,
  cliVersion: '7.8.1',
  cliExecutable: 'package/bin/kilo',
  wrapperSdkVersion: '7.8.1',
  protocol: '1',
  artifacts: hashes.map((sha256, i) => ({
    role: i === 0 ? 'cli' : 'control',
    sha256,
    transferBytes: 1,
    expandedBytes: 1,
    fileCount: 1,
  })),
  caps: { maxTransferBytes: 100, maxExpandedBytes: 100, maxFileCount: 10 },
  inventory: [
    ['cli', 'package/bin/kilo', 0o755, 1, hashes[0]],
    ['control', 'usr/local/bin/wrapper', 0o755, 1, hashes[1]],
  ],
};
const text = JSON.stringify(descriptor);

describe('startup selection and preflight', () => {
  it('preserves absent configuration for each provider', () => {
    for (const provider of ['cloudflare', 'cloudflare-containers', 'vercel'] as const)
      expect(selectStartup({}, provider)).toEqual({ mode: 'preinstalled', image: 'all-in-one' });
  });
  it.each([
    [{ RUNTIME_STARTUP_MODE: 'invalid' }, 'cloudflare-containers'],
    [{ NATIVE_RUNTIME_IMAGE: 'runtime-free' }, 'cloudflare-containers'],
    [{ RUNTIME_STARTUP_MODE: 'downloaded' }, 'cloudflare-containers'],
  ] as const)('rejects unsupported configuration before provider work: %s', (env, provider) => {
    expect(() => selectStartup(env, provider)).toThrow('configuration');
  });
  it('keeps preinstalled startup for SDK and Vercel pins on a downloaded target', () => {
    for (const provider of ['cloudflare', 'vercel'] as const)
      expect(
        selectStartup(
          { RUNTIME_STARTUP_MODE: 'downloaded', RUNTIME_RELEASE_DESCRIPTOR: text },
          provider
        ).mode
      ).toBe('preinstalled');
  });
  it('keeps image and mode independent and isolates downloaded snapshot keys', () => {
    for (const image of ['all-in-one', 'runtime-free'])
      expect(
        selectStartup(
          {
            RUNTIME_STARTUP_MODE: 'downloaded',
            RUNTIME_RELEASE_DESCRIPTOR: text,
            NATIVE_RUNTIME_IMAGE: image,
          },
          'cloudflare-containers'
        ).mode
      ).toBe('downloaded');
    expect(startupRepositoryKey('repo', 'preinstalled')).toBe('repo');
    expect(startupRepositoryKey('repo', 'downloaded')).not.toBe('repo');
  });
  it('checks both payload objects and leaves storage failures transient', async () => {
    const keys: string[] = [];
    await expect(
      loadRuntimeRelease(text, {
        async head(key) {
          keys.push(key);
          return { size: 1 };
        },
      })
    ).resolves.toEqual(descriptor);
    expect(keys).toEqual(hashes.map(runtimeArtifactObjectKey));
    await expect(
      loadRuntimeRelease(text, {
        async head() {
          return null;
        },
      })
    ).rejects.toMatchObject({ permanentReason: 'invalid_configuration' });
    await expect(
      loadRuntimeRelease(text, {
        async head() {
          throw new Error('storage unavailable');
        },
      })
    ).rejects.toThrow('storage unavailable');
    await expect(
      loadRuntimeRelease('{}', {
        async head() {
          throw new Error('must not read');
        },
      })
    ).rejects.toMatchObject({ permanentReason: 'invalid_configuration' });
  });
  it('renders bounded commands using the Worker host and the latest first-connect deadline', async () => {
    const deadlineAt = Date.now() + 420123;
    const command = await downloadedStartup({
      env: {
        WORKER_URL: 'https://worker.test',
        NEXTAUTH_SECRET: secret,
        RUNTIME_RELEASE_BUCKET: {
          async head() {
            return { size: 1 };
          },
        } as unknown as R2Bucket,
      },
      descriptor: text,
      sandboxId: 'sbx_test',
      allocationId: crypto.randomUUID(),
      deadlineAt,
    });
    expect(command.argv[0]).toBe('/bin/sh');
    expect(command.argv.every(arg => new TextEncoder().encode(arg).byteLength < 128 * 1024)).toBe(
      true
    );
    // Do not include command or token values in assertion output.
    expect(command.argv.some(arg => arg.includes('https://worker.test'))).toBe(true);
  });
  it('rejects an escaped bootstrap argument above the Linux limit even when the descriptor fits', async () => {
    const large = structuredClone(descriptor);
    const control = large.artifacts.find(artifact => artifact.role === 'control')!;
    control.fileCount = 14;
    control.expandedBytes = 14;
    large.caps.maxFileCount = 20;
    large.inventory = [
      large.inventory[0]!,
      ...Array.from({ length: 14 }, (_, index): RuntimeInventoryEntry => [
        'control',
        `usr/local/bin/${index}-${"'".repeat(4000)}`,
        0o755,
        1,
        hashes[1],
      ]),
    ];
    const bytes = serializeRuntimeRelease(large);
    expect(bytes.byteLength).toBeLessThanOrEqual(65536);
    let checked = 0;
    await expect(
      downloadedStartup({
        env: {
          WORKER_URL: 'https://worker.test',
          NEXTAUTH_SECRET: secret,
          RUNTIME_RELEASE_BUCKET: {
            async head() {
              checked++;
              return { size: 1 };
            },
          } as unknown as R2Bucket,
        },
        descriptor: new TextDecoder().decode(bytes),
        sandboxId: 'sbx_test',
        allocationId: crypto.randomUUID(),
        deadlineAt: Date.now() + 420000,
      })
    ).rejects.toMatchObject({ permanentReason: 'invalid_configuration' });
    expect(checked).toBe(2);
  });

  it('uses only the bootstrap-selected absolute CLI; absence retains preinstalled PATH behavior', () => {
    expect(selectedRuntimeCli({})).toBe('kilo');
    expect(
      selectedRuntimeCli({
        KILO_RUNTIME_CLI_PATH: '/opt/kilo-cloud/cli/hash/generation/package/bin/kilo',
      })
    ).toBe('/opt/kilo-cloud/cli/hash/generation/package/bin/kilo');
    for (const path of ['kilo', '/tmp/kilo', '/opt/kilo-cloud/cli/../kilo'])
      expect(() => selectedRuntimeCli({ KILO_RUNTIME_CLI_PATH: path })).toThrow(
        'Invalid selected runtime CLI'
      );
  });
});

describe('artifact access', () => {
  it('scopes a grant to two hashes, an audience and the exact allocation deadline', () => {
    const expiresAt = Date.now() + 420123;
    const token = mintRuntimeArtifactGrant(hashes, secret, expiresAt);
    const decoded = jwt.decode(token);
    expect(typeof decoded === 'object' && decoded?.exp === expiresAt / 1000).toBe(true);
    expect(validateRuntimeArtifactGrant(`Bearer ${token}`, secret)?.hashes).toEqual(hashes);
    expect(validateRuntimeArtifactGrant(`Bearer ${token}`, 'wrong')).toBeUndefined();
    const logToken = jwt.sign({ type: 'runtime_artifact_read', hashes }, secret, {
      audience: 'cloud-agent-control-log-upload',
      expiresIn: 60,
    });
    expect(validateRuntimeArtifactGrant(`Bearer ${logToken}`, secret)).toBeUndefined();
    const expired = jwt.sign({ type: 'runtime_artifact_read', hashes, exp: 1 }, secret, {
      audience: 'cloud-agent-runtime-artifact-read',
    });
    expect(validateRuntimeArtifactGrant(`Bearer ${expired}`, secret)).toBeUndefined();
    expect(validateRuntimeArtifactGrant(`Bearer ${'x'.repeat(5000)}`, secret)).toBeUndefined();
  });
  it('serves only the selected payload keys and handles unavailable storage', async () => {
    const app = new Hono<HonoContext>();
    registerRuntimeArtifactRoutes(app);
    const keys: string[] = [];
    const env = {
      NEXTAUTH_SECRET: secret,
      RUNTIME_RELEASE_BUCKET: {
        async get(key: string) {
          keys.push(key);
          return { body: 'payload', size: 7 };
        },
      },
    } as unknown as Env;
    const token = mintRuntimeArtifactGrant(hashes, secret, Date.now() + 60000);
    const headers = { Authorization: `Bearer ${token}` };
    expect(
      (await app.request(`/sandbox-artifacts/v1/objects/${hashes[0]}`, { headers }, env)).status
    ).toBe(200);
    expect(
      (await app.request(`/sandbox-artifacts/v1/objects/${'c'.repeat(64)}`, { headers }, env))
        .status
    ).toBe(403);
    expect((await app.request(`/sandbox-artifacts/v1/objects/${hashes[0]}`, {}, env)).status).toBe(
      401
    );
    expect(keys).toEqual([runtimeArtifactObjectKey(hashes[0])]);
  });
  it('reports an unavailable signing secret as retryable', async () => {
    const app = new Hono<HonoContext>();
    registerRuntimeArtifactRoutes(app);
    const env = {
      NEXTAUTH_SECRET: {
        async get() {
          throw new Error('secrets store unavailable');
        },
      },
    } as unknown as Env;
    const token = mintRuntimeArtifactGrant(hashes, secret, Date.now() + 60000);
    const response = await app.request(
      `/sandbox-artifacts/v1/objects/${hashes[0]}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(response.status).toBe(503);
  });
});

describe('startup failure admission', () => {
  it('rejects unsigned and cross-sandbox bindings before DO lookup', async () => {
    const app = new Hono<HonoContext>();
    registerStartupFailureRoute(app);
    let lookups = 0;
    const env = {
      NEXTAUTH_SECRET: secret,
      SANDBOX_CONTROL: {
        getByName() {
          lookups++;
          throw new Error('must not look up');
        },
      },
    } as unknown as Env;
    const allocationId = crypto.randomUUID();
    const token = mintSandboxLaunchCredential(
      { sandboxId: 'sbx_other', allocationId, credential: 'a'.repeat(64) },
      secret
    );
    for (const Authorization of ['Bearer invalid', `Bearer ${token}`]) {
      const response = await app.request(
        '/sandbox-control/sbx_test/startup-failure',
        {
          method: 'POST',
          headers: { Authorization },
          body: JSON.stringify({ allocationId, code: 'artifact_invalid' }),
        },
        env
      );
      expect(response.status).toBe(401);
    }
    expect(lookups).toBe(0);
  });
  it('requires matching allocation, bounded body and known code before dispatch', async () => {
    const app = new Hono<HonoContext>();
    registerStartupFailureRoute(app);
    let dispatches = 0;
    const env = {
      NEXTAUTH_SECRET: secret,
      SANDBOX_CONTROL: {
        getByName() {
          return {
            async reportStartupFailure() {
              dispatches++;
              return true;
            },
          };
        },
      },
    } as unknown as Env;
    const allocationId = crypto.randomUUID();
    const token = mintSandboxLaunchCredential(
      { sandboxId: 'sbx_test', allocationId, credential: 'a'.repeat(64) },
      secret
    );
    for (const [body, status] of [
      [JSON.stringify({ allocationId, code: 'artifact_invalid' }), 204],
      [JSON.stringify({ allocationId: crypto.randomUUID(), code: 'artifact_invalid' }), 400],
      [JSON.stringify({ allocationId, code: 'unknown' }), 400],
      ['x'.repeat(1025), 413],
    ] as const)
      expect(
        (
          await app.request(
            '/sandbox-control/sbx_test/startup-failure',
            { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body },
            env
          )
        ).status
      ).toBe(status);
    expect(dispatches).toBe(1);
  });
  it('maps only permanent codes to the public pre-dispatch contract', () => {
    for (const value of Object.values(STARTUP_FAILURES)) {
      if (value.reason !== null)
        expect(classifyControlPlaneFailure(value.reason, 'pre_dispatch', 'failed')).toEqual({
          stage: 'pre_dispatch',
          code: 'wrapper_start_failed',
        });
    }
    expect(STARTUP_FAILURES.base_incompatible.reason).toBeNull();
  });
});
