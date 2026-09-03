import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLocal } from '../scripts/install-local.js';
import { localConfigSchema, type LocalConfig, type Manifest } from '../scripts/local-manifests.js';
import {
  createInstallPreview,
  installPreviewApprovalHash,
  previewLocal,
  type InstallPreview,
} from '../scripts/preview-local.js';

const repositoryRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const examplePath = new URL('../operator.local.example.json', import.meta.url);
const originalReadFile = fs.readFile.bind(fs);
const originalSpawn = Bun.spawn.bind(Bun);
let example: LocalConfig;
let exampleContents: string;

beforeAll(async () => {
  exampleContents = await fs.readFile(examplePath, 'utf8');
  example = localConfigSchema.parse(JSON.parse(exampleContents) as unknown);
});

function findManifest(preview: InstallPreview, kind: string, name: string): Manifest {
  const manifest = preview.manifests.find(
    item => item.kind === kind && item.metadata.name === name
  );
  if (!manifest) throw new Error('test_manifest_missing');
  return manifest;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reverseObjectKeys(entry)])
  );
}

describe('local installation review', () => {
  test('includes the complete installation without presenting an applyable Kubernetes List', () => {
    const preview = createInstallPreview(example);
    const system = example.systemNamespace;
    const sandbox = example.sandboxNamespace;
    expect(preview.kind).toBe('KiloOnPremInstallPreview');
    expect(preview.formatVersion).toBe(1);
    expect(preview.reviewOnly).toBe(true);
    expect(preview.notice).toContain('Do not use kubectl apply');
    expect(preview).not.toHaveProperty('apiVersion');
    expect(preview).not.toHaveProperty('items');
    expect(
      preview.manifests
        .map(item => `${item.kind}/${item.metadata.namespace ?? ''}/${item.metadata.name}`)
        .sort()
    ).toEqual(
      [
        `Namespace//${system}`,
        `Namespace//${sandbox}`,
        `Secret/${system}/kilo-onprem-identity`,
        `Service/${system}/kilo-onprem-broker`,
        `ServiceAccount/${system}/kilo-onprem-provisioner`,
        `ServiceAccount/${sandbox}/kilo-onprem-sandbox`,
        `Role/${system}/kilo-onprem-provisioner`,
        `Role/${sandbox}/kilo-onprem-provisioner`,
        `RoleBinding/${system}/kilo-onprem-provisioner`,
        `RoleBinding/${sandbox}/kilo-onprem-provisioner`,
        `ClusterRole//${system}-runtime`,
        `ClusterRoleBinding//${system}-runtime`,
        `ConfigMap/${system}/kilo-onprem-config`,
        `ConfigMap/${sandbox}/kilo-onprem-ca`,
        `Secret/${system}/kilo-onprem-tls`,
        `Secret/${system}/kilo-onprem-enrollment`,
        `ResourceQuota/${sandbox}/kilo-onprem-capacity`,
        `ResourceQuota/${system}/kilo-onprem-ledgers`,
        `LimitRange/${sandbox}/kilo-onprem-profile`,
        `NetworkPolicy/${sandbox}/default-deny`,
        `NetworkPolicy/${sandbox}/approved-egress`,
        `NetworkPolicy/${system}/trusted-ingress`,
        `Deployment/${system}/kilo-onprem-provisioner`,
      ].sort()
    );
    for (const namespace of [system, sandbox]) {
      expect(findManifest(preview, 'Namespace', namespace).metadata.labels).toEqual({
        'app.kubernetes.io/managed-by': 'kilo-onprem',
        'kilo.ai/installation': '<INSTALLATION_ID_FROM_ENROLLMENT>',
        'kilo.ai/component': 'namespace',
        'pod-security.kubernetes.io/enforce': 'restricted',
        'pod-security.kubernetes.io/enforce-version': 'v1.36',
        'pod-security.kubernetes.io/audit': 'restricted',
        'pod-security.kubernetes.io/audit-version': 'v1.36',
        'pod-security.kubernetes.io/warn': 'restricted',
        'pod-security.kubernetes.io/warn-version': 'v1.36',
      });
    }
    expect(findManifest(preview, 'Secret', 'kilo-onprem-identity').data).toEqual({});
    expect(findManifest(preview, 'Service', 'kilo-onprem-broker')).toMatchObject({
      spec: {
        type: 'ClusterIP',
        ipFamilyPolicy: 'SingleStack',
        ipFamilies: ['IPv4'],
        publishNotReadyAddresses: true,
        selector: { 'kilo.ai/installation': '<INSTALLATION_ID_FROM_ENROLLMENT>' },
        ports: [
          { name: 'https', port: 443, targetPort: 8443, protocol: 'TCP' },
          { name: 'diagnostic', port: 18080, targetPort: 18080, protocol: 'TCP' },
        ],
      },
    });
  });

  test('preserves the exact named runtime authority without cluster-admin or exec', () => {
    const preview = createInstallPreview(example);
    const name = `${example.systemNamespace}-runtime`;
    expect(findManifest(preview, 'ClusterRole', name).rules).toEqual([
      {
        apiGroups: ['node.k8s.io'],
        resources: ['runtimeclasses'],
        resourceNames: ['gvisor'],
        verbs: ['get'],
      },
      {
        apiGroups: ['authorization.k8s.io'],
        resources: ['selfsubjectaccessreviews'],
        verbs: ['create'],
      },
    ]);
    expect(findManifest(preview, 'ClusterRoleBinding', name)).toMatchObject({
      subjects: [
        {
          kind: 'ServiceAccount',
          name: 'kilo-onprem-provisioner',
          namespace: example.systemNamespace,
        },
      ],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name },
    });
    const rbac = JSON.stringify(preview.manifests.filter(item => item.kind.includes('Role')));
    expect(rbac).not.toContain('pods/exec');
    expect(rbac).not.toContain('cluster-admin');
    expect(rbac).not.toContain('"*"');
  });

  test('uses documented placeholders for every secret value and unresolved identity/address', () => {
    const preview = createInstallPreview(example);
    const tls = findManifest(preview, 'Secret', 'kilo-onprem-tls').data as Record<string, string>;
    const enrollment = findManifest(preview, 'Secret', 'kilo-onprem-enrollment').data as Record<
      string,
      string
    >;
    expect(
      Object.fromEntries(
        Object.entries(tls).map(([key, value]) => [key, Buffer.from(value, 'base64').toString()])
      )
    ).toEqual({
      'ca.crt': '<PUBLIC_CA_PEM>',
      'tls.crt': '<BROKER_CERTIFICATE_PEM>',
      'tls.key': '<BROKER_PRIVATE_KEY_PEM>',
    });
    expect(Buffer.from(enrollment['bootstrap-token'], 'base64').toString()).toBe(
      '<ONE_TIME_BOOTSTRAP_TOKEN>'
    );
    expect(findManifest(preview, 'ConfigMap', 'kilo-onprem-ca').data).toEqual({
      'ca.crt': '<PUBLIC_CA_PEM>',
    });
    const data = findManifest(preview, 'ConfigMap', 'kilo-onprem-config').data as Record<
      string,
      string
    >;
    expect(JSON.parse(data['config.json'])).toMatchObject({
      organizationId: '<ORGANIZATION_ID_FROM_ENROLLMENT>',
      installationId: '<INSTALLATION_ID_FROM_ENROLLMENT>',
      dnsIPv4: '<CLUSTER_DNS_IPV4>',
      brokerClusterIp: '<BROKER_SERVICE_IPV4>',
      profile: { brokerUrl: `https://kilo-onprem-broker.${example.systemNamespace}.svc` },
      instanceTypes: example.instanceTypes,
    });
    expect(preview.lateBoundFields.map(field => field.field)).toEqual([
      'organizationId',
      'installationId',
      'dnsIPv4',
      'brokerClusterIp',
      'publicCa',
      'certificate',
      'privateKey',
      'bootstrapToken',
      'identityCredential',
      'caPrivateKey',
    ]);
    for (const field of preview.lateBoundFields) {
      expect(field.locations.length).toBeGreaterThan(0);
      expect(field.resolution.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(preview)).not.toContain('-----BEGIN');
    const pinnedDns = createInstallPreview({ ...example, dnsIPv4: '192.0.2.53' });
    expect(pinnedDns.lateBoundFields.find(field => field.field === 'dnsIPv4')).toMatchObject({
      previewValue: '192.0.2.53',
      resolution: expect.stringContaining('must match'),
    });
  });

  test.each([
    { bootstrapToken: 'not-a-real-secret' },
    { enrollment: { bootstrapToken: 'not-a-real-secret' } },
    { kubeconfig: '/private/not-a-real-kubeconfig' },
    { organizationId: '11111111-1111-4111-8111-111111111111' },
    { installationId: '22222222-2222-4222-8222-222222222222' },
    { brokerClusterIp: '192.0.2.20' },
    { tls: { privateKey: 'not-a-real-secret' } },
    { bootstrapTokenFile: '/private/not-a-real-token' },
    { cloudUrl: 'https://operator:not-a-real-secret@example.test' },
    { upstreams: { backendBaseUrl: 'https://example.test/?token=not-a-real-secret' } },
  ])('rejects credential inputs and caller-supplied installation identity: %j', additions => {
    expect(() => createInstallPreview({ ...example, ...additions })).toThrow();
  });

  test('normalizes defaults and object key order without time or random data in approval', () => {
    const first = createInstallPreview(example);
    expect(first.approvalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(createInstallPreview(reverseObjectKeys(example))).toEqual(first);
    const implicit = createInstallPreview({
      ...example,
      resources: undefined,
      systemNamespace: undefined,
      sandboxNamespace: undefined,
    });
    expect(createInstallPreview(implicit.operatorConfig)).toEqual(implicit);
    const { approvalHash, ...body } = first;
    expect(installPreviewApprovalHash(body)).toBe(approvalHash);
    expect(installPreviewApprovalHash(reverseObjectKeys(body) as typeof body)).toBe(approvalHash);
  });

  const changes: [string, (local: LocalConfig) => unknown][] = [
    [
      'provisioner image',
      local => ({ ...local, provisionerImage: `${local.provisionerImage}-next` }),
    ],
    [
      'sandbox image',
      local => ({ ...local, profile: { ...local.profile, image: `${local.profile.image}-next` } }),
    ],
    ['system namespace', local => ({ ...local, systemNamespace: `${local.systemNamespace}-next` })],
    [
      'sandbox namespace',
      local => ({ ...local, sandboxNamespace: `${local.sandboxNamespace}-next` }),
    ],
    [
      'profile revision',
      local => ({
        ...local,
        profile: { ...local.profile, revision: `${local.profile.revision}-next` },
      }),
    ],
    [
      'absolute lifetime',
      local => ({ ...local, profile: { ...local.profile, maxLifetimeMs: 600_000 } }),
    ],
    [
      'instance type catalog',
      local => ({
        ...local,
        instanceTypes: [
          {
            id: 'medium',
            displayName: 'Medium',
            resources: { cpuMillis: 2000, memoryMiB: 4096, diskMiB: 8192 },
          },
        ],
      }),
    ],
    ['instance type catalog removal', local => ({ ...local, instanceTypes: [] })],
    ['CPU limit', local => ({ ...local, resources: { ...local.resources, cpuMillis: 2000 } })],
    ['memory limit', local => ({ ...local, resources: { ...local.resources, memoryMiB: 2304 } })],
    ['disk limit', local => ({ ...local, resources: { ...local.resources, diskMiB: 8192 } })],
    [
      'concurrency limit',
      local => ({ ...local, resources: { ...local.resources, maxConcurrent: 2 } }),
    ],
    ['control origin', local => ({ ...local, cloudUrl: 'http://host.docker.internal:9999' })],
    ['control IPv4', local => ({ ...local, cloudIPv4: '192.0.2.2' })],
    ['DNS pin', local => ({ ...local, dnsIPv4: '192.0.2.53' })],
    [
      'backend destination',
      local => ({
        ...local,
        upstreams: { ...local.upstreams, backendBaseUrl: 'http://localhost:9999' },
      }),
    ],
    [
      'provider destination',
      local => ({
        ...local,
        upstreams: { ...local.upstreams, providerBaseUrl: 'http://localhost:9999' },
      }),
    ],
    [
      'ingest destination',
      local => ({
        ...local,
        upstreams: { ...local.upstreams, sessionIngestBaseUrl: 'http://localhost:9999' },
      }),
    ],
    [
      'Git fixture destination',
      local => ({
        ...local,
        localFixtureUpstreams: {
          ...local.localFixtureUpstreams,
          'github.com': 'http://localhost:9999',
        },
      }),
    ],
  ];

  test.each(changes)('requires new approval for changed %s', (_name, change) => {
    expect(createInstallPreview(change(example)).approvalHash).not.toBe(
      createInstallPreview(example).approvalHash
    );
  });

  test('hashes rendered permissions as well as normalized operator configuration', () => {
    const { approvalHash, ...body } = createInstallPreview(example);
    const changedPermissions = {
      ...body,
      manifests: body.manifests.map(manifest =>
        manifest.kind === 'ClusterRole'
          ? {
              ...manifest,
              rules: [{ apiGroups: [''], resources: ['pods/exec'], verbs: ['create'] }],
            }
          : manifest
      ),
    };
    expect(installPreviewApprovalHash(changedPermissions)).not.toBe(approvalHash);
    expect(
      installPreviewApprovalHash({
        ...body,
        operatorConfig: { ...body.operatorConfig, provisionerImage: 'changed:local' },
      })
    ).not.toBe(approvalHash);
  });
});

describe('local installer CLI boundaries', () => {
  let directory: string;
  let configFile: string;
  let runDirectory: string;
  let restorers: (() => void)[];

  function restoreAfterTest<T extends { mockRestore(): void }>(mock: T): T {
    restorers.push(() => mock.mockRestore());
    return mock;
  }

  function guardSideEffects(allowLocalGit = false) {
    const spawn = restoreAfterTest(
      spyOn(Bun, 'spawn').mockImplementation(((
        command: string[],
        options?: Parameters<typeof Bun.spawn>[1]
      ) => {
        if (
          !allowLocalGit ||
          !Array.isArray(command) ||
          command.length !== 5 ||
          command.slice(0, 4).join(' ') !== 'git check-ignore --quiet --' ||
          !command[4]?.startsWith(`${directory}/`) ||
          !command[4].endsWith('/install-preview.json') ||
          options?.cwd !== repositoryRoot
        )
          throw new Error('forbidden_test_spawn');
        return originalSpawn(command, options);
      }) as typeof Bun.spawn)
    );
    const spawnSync = restoreAfterTest(
      spyOn(Bun, 'spawnSync').mockImplementation(() => {
        throw new Error('forbidden_test_spawn_sync');
      })
    );
    const denyNetwork = () => {
      throw new Error('forbidden_test_network');
    };
    const fetch = restoreAfterTest(
      spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(denyNetwork, { preconnect: denyNetwork })
      )
    );
    const read = restoreAfterTest(
      spyOn(fs, 'readFile').mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
        if (args[0] !== configFile) throw new Error('forbidden_test_file_read');
        return originalReadFile(...args);
      }) as typeof fs.readFile)
    );
    return { spawn, spawnSync, fetch, read };
  }

  function installArguments() {
    return [
      '--kubeconfig',
      join(directory, 'missing.kubeconfig'),
      '--context',
      'test-local',
      '--config',
      configFile,
      '--enrollment',
      join(directory, 'missing-enrollment.json'),
      '--run-dir',
      runDirectory,
    ];
  }

  async function expectInstallRefused(args: string[], code: string, readsConfig: boolean) {
    const before = await fs.readdir(directory, { recursive: true });
    const originalConfig = await originalReadFile(configFile, 'utf8');
    const effects = guardSideEffects();
    const write = restoreAfterTest(
      spyOn(fs, 'writeFile').mockImplementation(() => {
        throw new Error('forbidden_test_write');
      })
    );
    const mkdir = restoreAfterTest(
      spyOn(fs, 'mkdir').mockImplementation(() => {
        throw new Error('forbidden_test_mkdir');
      })
    );
    await rejects(installLocal(args), new Error(code));
    expect(effects.spawn).not.toHaveBeenCalled();
    expect(effects.spawnSync).not.toHaveBeenCalled();
    expect(effects.fetch).not.toHaveBeenCalled();
    expect(effects.read.mock.calls.map(call => call[0])).toEqual(readsConfig ? [configFile] : []);
    expect(write).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(await fs.readdir(directory, { recursive: true })).toEqual(before);
    expect(await originalReadFile(configFile, 'utf8')).toBe(originalConfig);
  }

  async function runCli(
    script: 'install-local.ts' | 'preview-local.ts',
    args: string[],
    commandPath = ''
  ) {
    const child = originalSpawn(
      [
        process.execPath,
        '--no-env-file',
        join(repositoryRoot, 'services/cloud-agent-next/onprem/scripts', script),
        ...args,
      ],
      {
        cwd: directory,
        env: { PATH: commandPath },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  beforeAll(async () => {
    await fs.mkdir(join(repositoryRoot, '.tmp'), { recursive: true, mode: 0o700 });
  });

  beforeEach(async () => {
    restorers = [];
    directory = await fs.mkdtemp(join(repositoryRoot, '.tmp', 'onprem-preview-test-'));
    configFile = join(directory, 'operator.json');
    runDirectory = join(directory, 'review');
    await fs.writeFile(configFile, exampleContents, { mode: 0o600, flag: 'wx' });
  });

  afterEach(async () => {
    for (const restore of restorers.reverse()) restore();
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('previews offline and writes only a private, reproducible review artifact', async () => {
    const effects = guardSideEffects(true);
    const output = restoreAfterTest(spyOn(console, 'log').mockImplementation(() => {}));
    const args = ['--config', configFile, '--run-dir', runDirectory];
    await previewLocal(args);
    const previewPath = join(runDirectory, 'install-preview.json');
    const contents = await originalReadFile(previewPath, 'utf8');
    const preview = createInstallPreview(example);
    expect(JSON.parse(contents)).toEqual(preview);
    expect((await fs.lstat(runDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.lstat(previewPath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(directory, { recursive: true })).sort()).toEqual([
      'operator.json',
      'review',
      'review/install-preview.json',
    ]);
    await previewLocal(args);
    expect(await originalReadFile(previewPath, 'utf8')).toBe(contents);
    expect(output.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [
        JSON.stringify({
          status: 'local_install_preview',
          previewPath,
          approvalHash: preview.approvalHash,
        }),
      ])
    );
    expect(effects.spawn).toHaveBeenCalledTimes(2);
    expect(effects.spawnSync).not.toHaveBeenCalled();
    expect(effects.fetch).not.toHaveBeenCalled();
    expect(effects.read.mock.calls.map(call => call[0])).toEqual([configFile, configFile]);
    expect(await originalReadFile(configFile, 'utf8')).toBe(exampleContents);
  });

  test('preview main works with only Git on PATH and no enrollment or inherited environment', async () => {
    const git = Bun.which('git');
    if (!git) throw new Error('test_git_required');
    const commandPath = join(directory, 'commands');
    await fs.mkdir(commandPath, { mode: 0o700 });
    await fs.symlink(git, join(commandPath, 'git'));
    const result = await runCli(
      'preview-local.ts',
      ['--config', configFile, '--run-dir', runDirectory],
      commandPath
    );
    const previewPath = join(runDirectory, 'install-preview.json');
    const preview = createInstallPreview(example);
    expect(result).toEqual({
      stdout: `${JSON.stringify({
        status: 'local_install_preview',
        previewPath,
        approvalHash: preview.approvalHash,
      })}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(JSON.parse(await fs.readFile(previewPath, 'utf8'))).toEqual(preview);
    expect(await fs.readdir(runDirectory)).toEqual(['install-preview.json']);
  });

  test('does not read or replace pre-existing enrollment, kubeconfig or TLS artifacts', async () => {
    await fs.mkdir(runDirectory, { mode: 0o700 });
    const decoys = [
      'enrollment.json',
      'local.kubeconfig',
      'ca.key',
      'ca.crt',
      'tls.key',
      'tls.crt',
      'config.json',
    ];
    for (const file of decoys) {
      await fs.writeFile(join(runDirectory, file), `NOT_SECRET_TEST_FIXTURE:${file}`, {
        mode: 0o600,
      });
    }
    const effects = guardSideEffects(true);
    restoreAfterTest(spyOn(console, 'log').mockImplementation(() => {}));
    await previewLocal(['--config', configFile, '--run-dir', runDirectory]);
    expect(effects.read.mock.calls.map(call => call[0])).toEqual([configFile]);
    expect(effects.spawn).toHaveBeenCalledTimes(1);
    expect(effects.spawnSync).not.toHaveBeenCalled();
    expect(effects.fetch).not.toHaveBeenCalled();
    for (const file of decoys) {
      expect(await originalReadFile(join(runDirectory, file), 'utf8')).toBe(
        `NOT_SECRET_TEST_FIXTURE:${file}`
      );
    }
    expect(
      await originalReadFile(join(runDirectory, 'install-preview.json'), 'utf8')
    ).not.toContain('NOT_SECRET_TEST_FIXTURE');
    expect((await fs.readdir(runDirectory)).sort()).toEqual(
      [...decoys, 'install-preview.json'].sort()
    );
  });

  test.each([
    { approval: [] },
    { approval: ['--approve'] },
    { approval: ['--approve', ''] },
    { approval: ['--approve', 'a'.repeat(63)] },
    { approval: ['--approve', 'a'.repeat(65)] },
    { approval: ['--approve', `${'a'.repeat(64)}\n`] },
    { approval: ['--approve', 'A'.repeat(64)] },
    { approval: ['--approve', 'g'.repeat(64)] },
    { approval: ['--approve', 'yes'] },
  ])(
    'refuses missing or malformed approval before reads, writes or commands: %j',
    async ({ approval }) => {
      await expectInstallRefused(
        [...installArguments(), ...approval],
        'local_install_approval_required',
        false
      );
    }
  );

  test('recomputes approval instead of trusting an edited review file', async () => {
    const preview = createInstallPreview(example);
    const forgedHash = `${preview.approvalHash[0] === '0' ? '1' : '0'}${preview.approvalHash.slice(1)}`;
    await fs.mkdir(runDirectory, { mode: 0o700 });
    const artifact = join(runDirectory, 'install-preview.json');
    const forgedContents = JSON.stringify({ ...preview, approvalHash: forgedHash, manifests: [] });
    await fs.writeFile(artifact, forgedContents, { mode: 0o600 });
    await expectInstallRefused(
      [...installArguments(), '--approve', forgedHash],
      'local_install_approval_mismatch',
      true
    );
    expect(await originalReadFile(artifact, 'utf8')).toBe(forgedContents);
  });

  test('rejects stale approval after operator config changes before reading credentials', async () => {
    const oldApproval = createInstallPreview(example).approvalHash;
    await fs.writeFile(
      configFile,
      JSON.stringify({ ...example, provisionerImage: 'changed:local' })
    );
    await expectInstallRefused(
      [...installArguments(), '--approve', oldApproval],
      'local_install_approval_mismatch',
      true
    );
  });

  test.each(['--yes', '--dry-run', '--approve=hash'])(
    'has no install bypass via %s',
    async flag => {
      await expectInstallRefused(
        [...installArguments(), flag, 'true'],
        'explicit_install_arguments_required',
        false
      );
    }
  );

  test.each(['--kubeconfig', '--enrollment', '--approve', '--yes', '--config'])(
    'rejects extra or duplicate preview flags: %s',
    async flag => {
      const effects = guardSideEffects();
      await rejects(
        previewLocal(['--config', configFile, '--run-dir', runDirectory, flag, 'not-secret']),
        new Error('explicit_preview_arguments_required')
      );
      expect(effects.read).not.toHaveBeenCalled();
      expect(effects.spawn).not.toHaveBeenCalled();
      expect(await fs.readdir(directory)).toEqual(['operator.json']);
    }
  );

  test.each(['relative', 'public', 'symlink'])(
    'refuses an unsafe operator path: %s',
    async kind => {
      let path = configFile;
      if (kind === 'relative') path = 'operator.json';
      if (kind === 'public') await fs.chmod(path, 0o644);
      if (kind === 'symlink') {
        path = join(directory, 'operator-link.json');
        await fs.symlink(configFile, path);
      }
      const effects = guardSideEffects();
      await rejects(previewLocal(['--config', path, '--run-dir', runDirectory]));
      expect(effects.read).not.toHaveBeenCalled();
      expect(effects.spawn).not.toHaveBeenCalled();
      await rejects(fs.lstat(runDirectory), { code: 'ENOENT' });
    }
  );

  test.each(['relative', 'tmp-root', 'outside'])(
    'requires an absolute directory below repository .tmp: %s',
    async kind => {
      const path =
        kind === 'relative'
          ? '.tmp/review'
          : kind === 'tmp-root'
            ? join(repositoryRoot, '.tmp')
            : join(directory, '../../onprem-review-not-allowed');
      const effects = guardSideEffects();
      await rejects(
        previewLocal(['--config', configFile, '--run-dir', path]),
        new Error('ignored_run_directory_required')
      );
      expect(effects.spawn).not.toHaveBeenCalled();
      expect(await fs.readdir(directory)).toEqual(['operator.json']);
    }
  );

  test('does not create a review directory when Git does not confirm the artifact is ignored', async () => {
    const effects = guardSideEffects(true);
    effects.spawn.mockImplementation(
      () =>
        ({
          stdout: new Blob().stream(),
          stderr: new Blob().stream(),
          exited: Promise.resolve(1),
        }) as ReturnType<typeof Bun.spawn>
    );
    await rejects(
      previewLocal(['--config', configFile, '--run-dir', runDirectory]),
      new Error('local_command_failed')
    );
    expect(effects.spawn.mock.calls.map(call => call[0])).toEqual([
      ['git', 'check-ignore', '--quiet', '--', join(runDirectory, 'install-preview.json')],
    ]);
    expect(await fs.readdir(directory)).toEqual(['operator.json']);
  });

  test.each(['public', 'symlink'])('refuses an unsafe review directory: %s', async kind => {
    if (kind === 'public') {
      await fs.mkdir(runDirectory, { mode: 0o700 });
      await fs.chmod(runDirectory, 0o755);
    } else {
      const target = join(directory, 'symlink-target');
      await fs.mkdir(target, { mode: 0o700 });
      await fs.symlink(target, runDirectory);
    }
    guardSideEffects(true);
    await rejects(previewLocal(['--config', configFile, '--run-dir', runDirectory]));
    expect(await fs.readdir(runDirectory)).toEqual([]);
  });

  test.each(['public', 'symlink'])(
    'refuses to overwrite an unsafe review artifact: %s',
    async kind => {
      await fs.mkdir(runDirectory, { mode: 0o700 });
      const path = join(runDirectory, 'install-preview.json');
      if (kind === 'public') {
        await fs.writeFile(path, 'do not replace');
        await fs.chmod(path, 0o644);
      } else {
        await fs.symlink(configFile, path);
      }
      guardSideEffects(true);
      await rejects(
        previewLocal(['--config', configFile, '--run-dir', runDirectory]),
        new Error('private_output_required')
      );
      expect(await originalReadFile(configFile, 'utf8')).toBe(exampleContents);
      if (kind === 'public') expect(await originalReadFile(path, 'utf8')).toBe('do not replace');
    }
  );

  test('CLI errors are allowlisted without raw parser errors or credential-like input', async () => {
    const args = installArguments();
    expect(await runCli('install-local.ts', args)).toEqual({
      stdout: '',
      stderr: 'local_install_approval_required\n',
      exitCode: 1,
    });
    expect(
      await runCli('install-local.ts', [...args, '--approve', 'not-secret-invalid-hash'])
    ).toEqual({
      stdout: '',
      stderr: 'local_install_approval_required\n',
      exitCode: 1,
    });
    expect(await runCli('install-local.ts', [...args, '--approve', '0'.repeat(64)])).toEqual({
      stdout: '',
      stderr: 'local_install_approval_mismatch\n',
      exitCode: 1,
    });
    await fs.writeFile(configFile, '{"bootstrapToken":"NOT_SECRET_TEST_FIXTURE"');
    expect(await runCli('install-local.ts', [...args, '--approve', '0'.repeat(64)])).toEqual({
      stdout: '',
      stderr: 'local_install_failed\n',
      exitCode: 1,
    });
    expect(
      await runCli('preview-local.ts', ['--config', configFile, '--run-dir', runDirectory])
    ).toEqual({
      stdout: '',
      stderr: 'local_install_preview_failed\n',
      exitCode: 1,
    });
    expect(await fs.readdir(directory)).toEqual(['operator.json']);
  });
});
