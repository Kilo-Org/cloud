import { describe, expect, test } from 'bun:test';
import { encodeOnPremProviderRef } from '../../src/shared/onprem-protocol.js';
import { installationManifests, isLoopbackKubernetesServer } from '../scripts/install-local.js';
import {
  configMapSchema,
  containersTerminated,
  isApprovedOrigin,
  onPremConfigSchema,
  podIsRunning,
  podSchema,
  resourceListSchema,
} from './kubernetes.js';
import { acceptOperation, type LaunchOperation } from './ledger.js';
import { allocationPod, matchesApprovedPod } from './provisioner.js';

const now = Date.parse('2026-09-02T12:00:00Z');
const installationId = '22222222-2222-4222-8222-222222222222';
const allocationId = '11111111-1111-4111-8111-111111111111';
const config = onPremConfigSchema.parse({
  cloudUrl: 'http://host.docker.internal:8790',
  organizationId: '33333333-3333-4333-8333-333333333333',
  installationId,
  cloudIPv4: '192.168.5.2',
  dnsIPv4: '10.43.0.10',
  brokerClusterIp: '10.43.0.20',
  profile: {
    id: 'local',
    revision: 'v1',
    runtimeClass: 'gvisor',
    image: 'kilo-runtime:qualified',
    brokerUrl: 'https://kilo-onprem-broker.kilo-onprem-system.svc',
    maxLifetimeMs: 600_000,
  },
  upstreams: {
    backendBaseUrl: 'http://host.docker.internal:3000',
    providerBaseUrl: 'http://host.docker.internal:3000',
    sessionIngestBaseUrl: 'http://host.docker.internal:8792',
  },
});
const providerRef = encodeOnPremProviderRef({ installationId, allocationId });
const operation: LaunchOperation = {
  id: '44444444-4444-4444-8444-444444444444',
  allocationId,
  providerRef,
  sandboxId: 'sandbox-test',
  revision: 1,
  type: 'launch',
  profileId: 'local',
  profileRevision: 'v1',
  hardStopAt: now + 600_000,
  notAfter: now + 120_000,
  bootstrap: {
    SANDBOX_CONTROL_URL: 'ws://host.docker.internal:8790/sandbox-control/sandbox-test',
    SANDBOX_CONTROL_CREDENTIAL: 'allocation-test-capability',
    PROVIDER_INSTANCE_ID: providerRef,
    KILO_PLATFORM: 'cloud-agent',
    KILO_DISABLE_AUTOUPDATE: 'true',
    KILO_DEBUG_SESSION_INGEST: '1',
  },
};

describe('local execution policy', () => {
  test('cloud HTTP exceptions and Kubernetes loopback targeting are deliberately separate', () => {
    expect(isApprovedOrigin('http://host.docker.internal:8790')).toBe(true);
    expect(isApprovedOrigin('https://cloud.example.test')).toBe(true);
    expect(isApprovedOrigin('http://192.168.5.2:8790')).toBe(false);
    expect(isApprovedOrigin('http://host.docker.internal.evil.test')).toBe(false);
    expect(isApprovedOrigin('https://user:token@cloud.example.test')).toBe(false);
    expect(isLoopbackKubernetesServer('https://127.0.0.1:6443')).toBe(true);
    expect(isLoopbackKubernetesServer('https://[::1]:6443')).toBe(true);
    expect(isLoopbackKubernetesServer('https://host.docker.internal:6443')).toBe(false);
    expect(isLoopbackKubernetesServer('https://127.0.0.1.evil.test:6443')).toBe(false);
    expect(isLoopbackKubernetesServer('http://127.0.0.1:6443')).toBe(false);
  });

  test('parses typed Kubernetes list items without per-item type metadata', () => {
    const item = {
      metadata: {
        name: 'ledger',
        namespace: 'test',
        uid: crypto.randomUUID(),
        resourceVersion: '1',
      },
      data: { 'ledger.json': '{}' },
    };
    const list = {
      apiVersion: 'v1',
      kind: 'ConfigMapList',
      items: [item],
      metadata: { continue: '' },
    };
    const schema = resourceListSchema(configMapSchema, 'ConfigMap');
    expect(schema.parse(list).items[0]).toMatchObject({ apiVersion: 'v1', kind: 'ConfigMap' });
    expect(schema.safeParse({ ...list, kind: 'PodList' }).success).toBe(false);
    expect(schema.safeParse({ ...list, items: [{ ...item, kind: 'Secret' }] }).success).toBe(false);
    expect(schema.safeParse({ ...list, metadata: { continue: 'next-page' } }).success).toBe(false);
  });

  test('Pod admission cannot silently replace gVisor, image, security or bootstrap', () => {
    const ledger = acceptOperation(null, operation, config, now);
    const manifest = allocationPod(config, ledger);
    const pod = podSchema.parse({
      ...manifest,
      metadata: { ...manifest.metadata, uid: crypto.randomUUID(), resourceVersion: '1' },
    });
    expect(matchesApprovedPod(config, ledger, pod)).toBe(true);
    expect(
      matchesApprovedPod(config, ledger, {
        ...pod,
        spec: { ...pod.spec, runtimeClassName: 'runc' },
      })
    ).toBe(false);
    expect(
      matchesApprovedPod(config, ledger, {
        ...pod,
        spec: { ...pod.spec, automountServiceAccountToken: true },
      })
    ).toBe(false);
    expect(
      matchesApprovedPod(config, ledger, {
        ...pod,
        spec: {
          ...pod.spec,
          containers: [{ ...pod.spec.containers[0]!, image: 'unapproved:latest' }],
        },
      })
    ).toBe(false);
    const unsafe = structuredClone(pod);
    unsafe.spec.containers[0]!.securityContext = {
      ...manifest.spec.containers[0]!.securityContext,
      capabilities: { drop: ['ALL'], add: ['SYS_ADMIN'] },
    };
    expect(matchesApprovedPod(config, ledger, unsafe)).toBe(false);
    expect(
      matchesApprovedPod(config, ledger, { ...pod, metadata: { ...pod.metadata, finalizers: [] } })
    ).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain(operation.bootstrap.SANDBOX_CONTROL_CREDENTIAL);
  });

  test('announced instance types do not change sandbox execution or namespace limits', () => {
    const advertised = onPremConfigSchema.parse({
      ...config,
      instanceTypes: [
        {
          id: 'large',
          displayName: 'Large',
          resources: { cpuMillis: 4000, memoryMiB: 8192, diskMiB: 16384 },
        },
      ],
    });
    const ledger = acceptOperation(null, operation, config, now);
    expect(allocationPod(advertised, ledger)).toEqual(allocationPod(config, ledger));
    const tls = {
      publicCa: 'public-test-ca',
      certificate: 'public-test-cert',
      privateKey: 'private-test-key',
    };
    const limits = (local: typeof config) =>
      installationManifests(local, 'kilo-provisioner:qualified', tls, 'bootstrap-test').filter(
        manifest => manifest.kind === 'ResourceQuota' || manifest.kind === 'LimitRange'
      );
    expect(limits(advertised)).toEqual(limits(config));
  });

  test('accepts Kubernetes quantity and default normalization without weakening policy', () => {
    const local = {
      ...config,
      resources: { ...config.resources, memoryMiB: 1024, diskMiB: 1024 },
    };
    const ledger = acceptOperation(null, operation, local, now);
    const manifest = allocationPod(local, ledger);
    const spec: Record<string, unknown> = structuredClone(manifest.spec);
    delete spec.hostNetwork;
    delete spec.hostPID;
    delete spec.hostIPC;
    spec.serviceAccount = manifest.spec.serviceAccountName;
    spec.containers = [
      {
        ...manifest.spec.containers[0],
        resources: {
          requests: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '1Gi' },
          limits: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '1Gi' },
        },
      },
    ];
    spec.volumes = manifest.spec.volumes.map(volume =>
      'emptyDir' in volume && volume.emptyDir?.sizeLimit !== '512Mi'
        ? { ...volume, emptyDir: { sizeLimit: '1Gi' } }
        : volume
    );
    const pod = podSchema.parse({
      ...manifest,
      metadata: { ...manifest.metadata, uid: crypto.randomUUID(), resourceVersion: '2' },
      spec,
    });
    expect(matchesApprovedPod(local, ledger, pod)).toBe(true);
    expect(
      matchesApprovedPod(local, ledger, { ...pod, spec: { ...pod.spec, hostNetwork: true } })
    ).toBe(false);
    expect(
      matchesApprovedPod(local, ledger, { ...pod, spec: { ...pod.spec, serviceAccount: 'other' } })
    ).toBe(false);
    const unsafe = structuredClone(pod);
    const security: Record<string, unknown> = { ...manifest.spec.containers[0]!.securityContext };
    delete security.allowPrivilegeEscalation;
    unsafe.spec.containers[0]!.securityContext = security;
    expect(matchesApprovedPod(local, ledger, unsafe)).toBe(false);
  });

  test('gate removal alone is not active evidence', () => {
    const ledger = acceptOperation(null, operation, config, now);
    const manifest = allocationPod(config, ledger);
    const pending = podSchema.parse({
      ...manifest,
      metadata: { ...manifest.metadata, uid: crypto.randomUUID(), resourceVersion: '1' },
      spec: { ...manifest.spec, schedulingGates: [] },
      status: { phase: 'Pending' },
    });
    expect(podIsRunning(pending)).toBe(false);
    const running = podSchema.parse({
      ...pending,
      spec: { ...pending.spec, nodeName: 'local-node' },
      status: {
        phase: 'Running',
        podIP: '10.42.0.8',
        containerStatuses: [
          {
            name: 'sandbox',
            restartCount: 0,
            state: { running: { startedAt: new Date(now).toISOString() } },
          },
        ],
      },
    });
    expect(podIsRunning(running)).toBe(true);
    expect(
      podIsRunning({
        ...running,
        spec: { ...running.spec, schedulingGates: manifest.spec.schedulingGates },
      })
    ).toBe(false);
    expect(
      podIsRunning({
        ...running,
        metadata: { ...running.metadata, deletionTimestamp: new Date(now).toISOString() },
      })
    ).toBe(false);
    expect(podIsRunning({ ...running, status: { ...running.status, containerStatuses: [] } })).toBe(
      false
    );
  });

  test('preserves unknown termination evidence with nullable Kubernetes timestamps', () => {
    const ledger = acceptOperation(null, operation, config, now);
    const manifest = allocationPod(config, ledger);
    const pod = podSchema.parse({
      ...manifest,
      metadata: { ...manifest.metadata, uid: crypto.randomUUID(), resourceVersion: '3' },
      status: {
        phase: 'Failed',
        containerStatuses: [
          {
            name: 'sandbox',
            state: {
              terminated: {
                reason: 'ContainerStatusUnknown',
                exitCode: 137,
                startedAt: null,
                finishedAt: null,
              },
            },
          },
        ],
      },
    });
    expect(containersTerminated(pod)).toBe(false);
  });

  test('cloud bootstrap cannot redirect control or substitute a provider identity', () => {
    expect(
      acceptOperation(
        null,
        {
          ...operation,
          bootstrap: { ...operation.bootstrap, SANDBOX_CONTROL_URL: 'ws://127.0.0.1:6443/' },
        },
        config,
        now
      ).stop?.reason
    ).toBe('bootstrap_not_approved');
    expect(
      acceptOperation(
        null,
        { ...operation, bootstrap: { ...operation.bootstrap, PROVIDER_INSTANCE_ID: 'different' } },
        config,
        now
      ).stop?.reason
    ).toBe('bootstrap_not_approved');
    expect(
      onPremConfigSchema.safeParse({
        ...config,
        profile: { ...config.profile, runtimeClass: 'runc' },
      }).success
    ).toBe(false);
  });

  test('trusted Secret read/update authority is name-scoped and excludes exec', () => {
    const manifests = installationManifests(
      config,
      'kilo-provisioner:qualified',
      {
        publicCa: 'public-test-ca',
        certificate: 'public-test-cert',
        privateKey: 'private-test-key',
      },
      'bootstrap-test'
    );
    const roles = manifests.filter(manifest => manifest.kind === 'Role');
    const trusted = roles.find(manifest => manifest.metadata.namespace === config.systemNamespace)!;
    expect(trusted.rules).toContainEqual({
      apiGroups: [''],
      resources: ['secrets'],
      resourceNames: ['kilo-onprem-identity'],
      verbs: ['get', 'update'],
    });
    expect(trusted.rules).toContainEqual({
      apiGroups: [''],
      resources: ['configmaps'],
      verbs: ['get', 'list', 'create', 'update', 'delete'],
    });
    const sandboxRole = roles.find(
      manifest => manifest.metadata.namespace === config.sandboxNamespace
    );
    expect(sandboxRole?.rules).toContainEqual({
      apiGroups: [''],
      resources: ['configmaps'],
      resourceNames: ['kilo-onprem-ca'],
      verbs: ['get'],
    });
    expect(JSON.stringify(roles)).not.toContain('deletecollection');
    expect(JSON.stringify(roles)).not.toContain('pods/exec');
    const publicCa = manifests.find(
      manifest =>
        manifest.kind === 'ConfigMap' && manifest.metadata.namespace === config.sandboxNamespace
    )!;
    expect(JSON.stringify(publicCa)).not.toContain('private-test-key');
    const network = manifests.filter(
      manifest =>
        manifest.kind === 'NetworkPolicy' && manifest.metadata.namespace === config.sandboxNamespace
    );
    expect(JSON.stringify(network)).not.toContain('18080');
    const trustedIngress = manifests.find(manifest => manifest.metadata.name === 'trusted-ingress');
    expect(trustedIngress).toMatchObject({
      spec: {
        ingress: expect.arrayContaining([
          expect.objectContaining({
            from: expect.arrayContaining([
              expect.objectContaining({
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.sandboxNamespace },
                },
              }),
            ]),
            ports: expect.arrayContaining([{ protocol: 'TCP', port: 18080 }]),
          }),
        ]),
      },
    });
    const deployment = manifests.find(manifest => manifest.kind === 'Deployment')!;
    expect(JSON.stringify(deployment)).not.toContain('runtimeClassName');
  });
});
