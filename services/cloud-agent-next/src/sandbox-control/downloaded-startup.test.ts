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

const interactiveOrgId = '9d278969-5453-4ae3-a51f-a8d2274a7b56';
const otherOrgId = '11111111-1111-4111-8111-111111111111';
const isolatedSandboxId = `sbx-${'c'.repeat(48)}`;
const webRoute = {
  createdOnPlatform: 'cloud-agent-web',
  clientProvenance: 'browser' as const,
  orgId: interactiveOrgId,
};
const scopedEnv = {
  RUNTIME_STARTUP_MODE: 'downloaded',
  NATIVE_RUNTIME_IMAGE: 'runtime-free',
  RUNTIME_RELEASE_DESCRIPTOR: text,
  RUNTIME_INTERACTIVE_ORG_IDS: interactiveOrgId,
} as const;
const isolatedCohort = {
  preparingRoutes: [webRoute],
  sandboxId: isolatedSandboxId,
  sandboxKind: 'isolated' as const,
};
const baseline = { mode: 'preinstalled', image: 'all-in-one' } as const;
const scopedDownloaded = { mode: 'downloaded', image: 'runtime-free', descriptor: text } as const;

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
  it('keeps preinstalled startup for SDK pins on a downloaded target', () => {
    for (const provider of ['cloudflare'] as const)
      expect(
        selectStartup(
          { RUNTIME_STARTUP_MODE: 'downloaded', RUNTIME_RELEASE_DESCRIPTOR: text },
          provider
        ).mode
      ).toBe('preinstalled');
  });
  it('selects downloaded startup for Vercel and requires its release descriptor', () => {
    expect(
      selectStartup(
        { RUNTIME_STARTUP_MODE: 'downloaded', RUNTIME_RELEASE_DESCRIPTOR: text },
        'vercel'
      )
    ).toMatchObject({ mode: 'downloaded', descriptor: text });
    expect(() => selectStartup({ RUNTIME_STARTUP_MODE: 'downloaded' }, 'vercel')).toThrow(
      'configuration'
    );
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
  it('keeps the configured target when no interactive org scope is configured', () => {
    expect(
      selectStartup(
        {
          RUNTIME_STARTUP_MODE: 'downloaded',
          NATIVE_RUNTIME_IMAGE: 'runtime-free',
          RUNTIME_RELEASE_DESCRIPTOR: text,
        },
        'cloudflare-containers'
      )
    ).toEqual(scopedDownloaded);
  });
  it('selects the configured target only for an exact isolated interactive web cohort', () => {
    expect(selectStartup(scopedEnv, 'cloudflare-containers', isolatedCohort)).toEqual(
      scopedDownloaded
    );
    expect(
      selectStartup(scopedEnv, 'cloudflare-containers', {
        preparingRoutes: [webRoute],
        sandboxId: `ses-${'a'.repeat(48)}`,
      })
    ).toEqual(scopedDownloaded);
    expect(
      selectStartup(scopedEnv, 'cloudflare-containers', {
        preparingRoutes: [webRoute],
        sandboxId: `istd-${'b'.repeat(48)}`,
      })
    ).toEqual(scopedDownloaded);
    expect(
      selectStartup(scopedEnv, 'cloudflare-containers', {
        preparingRoutes: [webRoute],
        sandboxId: `sbx-${'d'.repeat(48)}`,
        sandboxKind: 'isolated-standard',
      })
    ).toEqual(scopedDownloaded);
  });
  it.each([
    [
      'another organization',
      {
        preparingRoutes: [{ ...webRoute, orgId: otherOrgId }],
        sandboxId: isolatedSandboxId,
        sandboxKind: 'isolated' as const,
      },
    ],
    [
      'a non-web platform',
      {
        preparingRoutes: [{ ...webRoute, createdOnPlatform: 'cloud-agent' }],
        sandboxId: isolatedSandboxId,
        sandboxKind: 'isolated' as const,
      },
    ],
    [
      'a missing platform',
      {
        preparingRoutes: [{ clientProvenance: 'browser' as const, orgId: interactiveOrgId }],
        sandboxId: isolatedSandboxId,
        sandboxKind: 'isolated' as const,
      },
    ],
    [
      'a mobile provenance',
      {
        preparingRoutes: [{ ...webRoute, clientProvenance: 'mobile' as const }],
        sandboxId: isolatedSandboxId,
        sandboxKind: 'isolated' as const,
      },
    ],
    [
      'a missing provenance',
      {
        preparingRoutes: [{ createdOnPlatform: 'cloud-agent-web', orgId: interactiveOrgId }],
        sandboxId: isolatedSandboxId,
        sandboxKind: 'isolated' as const,
      },
    ],
    [
      'a missing organization',
      {
        preparingRoutes: [
          { createdOnPlatform: 'cloud-agent-web', clientProvenance: 'browser' as const },
        ],
        sandboxId: isolatedSandboxId,
        sandboxKind: 'isolated' as const,
      },
    ],
    [
      'mixed organizations',
      {
        preparingRoutes: [webRoute, { ...webRoute, orgId: otherOrgId }],
        sandboxId: isolatedSandboxId,
        sandboxKind: 'isolated' as const,
      },
    ],
    [
      'a shared sandbox',
      { preparingRoutes: [webRoute], sandboxId: isolatedSandboxId, sandboxKind: 'shared' as const },
    ],
    [
      'a code-review sandbox',
      {
        preparingRoutes: [webRoute],
        sandboxId: isolatedSandboxId,
        sandboxKind: 'code-review' as const,
      },
    ],
    [
      'mixed platforms',
      {
        preparingRoutes: [webRoute, { ...webRoute, createdOnPlatform: 'cloud-agent' }],
        sandboxId: isolatedSandboxId,
        sandboxKind: 'isolated' as const,
      },
    ],
    [
      'a sandbox without a kind or legacy isolation',
      { preparingRoutes: [webRoute], sandboxId: 'shared-owner' },
    ],
    [
      'a placed sandbox without a stored kind',
      { preparingRoutes: [webRoute], sandboxId: isolatedSandboxId },
    ],
    [
      'a legacy sandbox with a stored kind',
      {
        preparingRoutes: [webRoute],
        sandboxId: `ses-${'e'.repeat(48)}`,
        sandboxKind: 'isolated' as const,
      },
    ],
    [
      'no preparing routes',
      { preparingRoutes: [], sandboxId: isolatedSandboxId, sandboxKind: 'isolated' as const },
    ],
  ])('keeps %s on the baseline', (_name, cohort) => {
    expect(selectStartup(scopedEnv, 'cloudflare-containers', cohort)).toEqual(baseline);
  });
  it('does not require a descriptor for an excluded cohort', () => {
    expect(
      selectStartup(
        { ...scopedEnv, RUNTIME_RELEASE_DESCRIPTOR: undefined },
        'cloudflare-containers',
        {
          preparingRoutes: [{ ...webRoute, orgId: otherOrgId }],
          sandboxId: isolatedSandboxId,
          sandboxKind: 'isolated',
        }
      )
    ).toEqual(baseline);
    expect(() =>
      selectStartup(
        { ...scopedEnv, RUNTIME_RELEASE_DESCRIPTOR: undefined },
        'cloudflare-containers',
        isolatedCohort
      )
    ).toThrow('configuration');
  });
  it('keeps SDK pins on the baseline even for a matching cohort', () => {
    expect(selectStartup(scopedEnv, 'cloudflare', isolatedCohort)).toEqual(baseline);
  });
  it('applies the organization scope to native containers only', () => {
    expect(selectStartup(scopedEnv, 'vercel', {})).toMatchObject({
      mode: 'downloaded',
      descriptor: text,
    });
  });
  it('ignores an invalid interactive scope before native downloaded startup is selected', () => {
    for (const [env, provider] of [
      [{ ...scopedEnv, RUNTIME_INTERACTIVE_ORG_IDS: '*' }, 'cloudflare'],
      [
        {
          ...scopedEnv,
          RUNTIME_INTERACTIVE_ORG_IDS: '*',
          RUNTIME_STARTUP_MODE: 'preinstalled',
          NATIVE_RUNTIME_IMAGE: 'all-in-one',
        },
        'cloudflare-containers',
      ],
    ] as const)
      expect(selectStartup(env, provider, isolatedCohort)).toEqual(baseline);
  });
  it('keeps an empty configured scope on the baseline', () => {
    expect(
      selectStartup(
        { ...scopedEnv, RUNTIME_INTERACTIVE_ORG_IDS: '' },
        'cloudflare-containers',
        isolatedCohort
      )
    ).toEqual(baseline);
  });
  it.each(['*', 'not-a-uuid', `${interactiveOrgId},*`])(
    'rejects a non-UUID or wildcard interactive scope: %s',
    ids => {
      expect(() =>
        selectStartup(
          { ...scopedEnv, RUNTIME_INTERACTIVE_ORG_IDS: ids },
          'cloudflare-containers',
          isolatedCohort
        )
      ).toThrow('configuration');
    }
  );
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
  it.each([undefined, 'environment-builder'] as const)(
    'renders bounded %s commands using the Worker host',
    async mainProcess => {
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
        mainProcess,
      });
      expect(
        command.argv.some(arg =>
          arg.includes(
            mainProcess === 'environment-builder'
              ? 'kilocode-environment-builder.js'
              : 'kilocode-control-plane-supervisor.sh'
          )
        )
      ).toBe(true);
      expect(command.argv[0]).toBe('/bin/sh');
      expect(command.user).toBe('root');
      expect(command.argv.every(arg => new TextEncoder().encode(arg).byteLength < 128 * 1024)).toBe(
        true
      );
      // Do not include command or token values in assertion output.
      expect(command.argv.some(arg => arg.includes('https://worker.test'))).toBe(true);
    }
  );
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
