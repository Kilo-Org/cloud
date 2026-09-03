import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  onPremInstanceResourcesSchema,
  onPremInstanceTypesSchema,
  onPremProfileSchema,
} from '../../src/shared/onprem-protocol.js';

export const MANAGED_BY = 'kilo-onprem';
export const LAUNCH_GATE = 'kilo.ai/launch';
export const TERMINATION_FINALIZER = 'kilo.ai/termination-observed';
export const IDENTITY_SECRET = 'kilo-onprem-identity';
export const BROKER_SERVICE = 'kilo-onprem-broker';
export const PUBLIC_CA_CONFIG_MAP = 'kilo-onprem-ca';
export const SANDBOX_SERVICE_ACCOUNT = 'kilo-onprem-sandbox';
export const BROKER_PORT = 8443;
export const DENIED_PROBE_PORT = 18080;
export const CA_MOUNT_PATH = '/etc/kilo-onprem/ca/ca.crt';
export const RUNNER_VERSION = '1.0.0';

const nameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const absolutePathSchema = z
  .string()
  .min(2)
  .max(1024)
  .startsWith('/')
  .refine(value => !value.includes('\0'));
const localHttpHosts = new Set([
  'localhost',
  '127.0.0.1',
  'host.docker.internal',
  'host.lima.internal',
]);

export function isApprovedOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/' &&
      !value.includes('\\') &&
      !/\s/.test(value) &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && localHttpHosts.has(url.hostname)))
    );
  } catch {
    return false;
  }
}

const originSchema = z.string().max(2048).refine(isApprovedOrigin);
export const onPremConfigSchema = z
  .object({
    cloudUrl: originSchema,
    organizationId: z.uuid(),
    installationId: z.uuid(),
    profile: onPremProfileSchema,
    systemNamespace: nameSchema.default('kilo-onprem-system'),
    sandboxNamespace: nameSchema.default('kilo-onprem-sandboxes'),
    brokerClusterIp: z.ipv4(),
    cloudIPv4: z.ipv4(),
    dnsIPv4: z.ipv4(),
    resources: z
      .object({
        cpuMillis: onPremInstanceResourcesSchema.shape.cpuMillis.default(1000),
        memoryMiB: onPremInstanceResourcesSchema.shape.memoryMiB.default(2048),
        diskMiB: onPremInstanceResourcesSchema.shape.diskMiB.default(4096),
        maxConcurrent: z.number().int().min(1).max(8).default(2),
      })
      .strict()
      .default({ cpuMillis: 1000, memoryMiB: 2048, diskMiB: 4096, maxConcurrent: 2 }),
    instanceTypes: onPremInstanceTypesSchema.optional(),
    bootstrapTokenFile: absolutePathSchema.default('/etc/kilo-onprem/enrollment/bootstrap-token'),
    tls: z
      .object({
        certFile: absolutePathSchema.default('/etc/kilo-onprem/tls/tls.crt'),
        keyFile: absolutePathSchema.default('/etc/kilo-onprem/tls/tls.key'),
        caFile: absolutePathSchema.default('/etc/kilo-onprem/tls/ca.crt'),
      })
      .strict()
      .default({
        certFile: '/etc/kilo-onprem/tls/tls.crt',
        keyFile: '/etc/kilo-onprem/tls/tls.key',
        caFile: '/etc/kilo-onprem/tls/ca.crt',
      }),
    upstreams: z
      .object({
        backendBaseUrl: originSchema,
        providerBaseUrl: originSchema,
        sessionIngestBaseUrl: originSchema,
      })
      .strict(),
    localFixtureUpstreams: z
      .object({
        'github.com': originSchema
          .refine(value => isApprovedOrigin(value) && localHttpHosts.has(new URL(value).hostname))
          .optional(),
        'api.github.com': originSchema
          .refine(value => isApprovedOrigin(value) && localHttpHosts.has(new URL(value).hostname))
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(config => config.systemNamespace !== config.sandboxNamespace)
  .refine(
    config => config.profile.brokerUrl === `https://${BROKER_SERVICE}.${config.systemNamespace}.svc`
  )
  .refine(config => config.profile.runtimeClass === 'gvisor')
  .refine(config => config.brokerClusterIp !== config.cloudIPv4);

export type OnPremConfig = z.infer<typeof onPremConfigSchema>;

export const metadataSchema = z
  .object({
    name: z.string().min(1),
    namespace: z.string().optional(),
    uid: z.string().min(1),
    resourceVersion: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
    finalizers: z.array(z.string()).optional(),
    deletionTimestamp: z.string().nullable().optional(),
    ownerReferences: z
      .array(
        z
          .object({
            apiVersion: z.string(),
            kind: z.string(),
            name: z.string(),
            uid: z.string(),
            controller: z.boolean().optional(),
            blockOwnerDeletion: z.boolean().optional(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

const containerStateSchema = z
  .object({
    running: z.object({ startedAt: z.string().optional() }).passthrough().optional(),
    waiting: z.object({ reason: z.string().optional() }).passthrough().optional(),
    terminated: z
      .object({
        exitCode: z.number().int(),
        finishedAt: z.string().nullable().optional(),
        startedAt: z.string().nullable().optional(),
        reason: z.string().optional(),
        containerID: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const containerStatusSchema = z
  .object({
    name: z.string(),
    containerID: z.string().optional(),
    state: containerStateSchema,
    restartCount: z.number().int().optional(),
  })
  .passthrough();

export const podSchema = z
  .object({
    apiVersion: z.literal('v1'),
    kind: z.literal('Pod'),
    metadata: metadataSchema,
    spec: z
      .object({
        nodeName: z.string().optional(),
        runtimeClassName: z.string().optional(),
        restartPolicy: z.string(),
        schedulingGates: z.array(z.object({ name: z.string() }).strict()).optional(),
        containers: z.array(z.object({ name: z.string(), image: z.string() }).passthrough()).min(1),
        initContainers: z.array(z.unknown()).optional(),
        ephemeralContainers: z.array(z.unknown()).optional(),
        activeDeadlineSeconds: z.number().int().positive().optional(),
      })
      .passthrough(),
    status: z
      .object({
        phase: z.string().optional(),
        reason: z.string().optional(),
        podIP: z.union([z.ipv4(), z.literal('')]).optional(),
        containerStatuses: z.array(containerStatusSchema).optional(),
        initContainerStatuses: z.array(containerStatusSchema).optional(),
        ephemeralContainerStatuses: z.array(containerStatusSchema).optional(),
        conditions: z
          .array(
            z
              .object({ type: z.string(), status: z.string(), reason: z.string().optional() })
              .passthrough()
          )
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type Pod = z.infer<typeof podSchema>;

export const configMapSchema = z
  .object({
    apiVersion: z.literal('v1'),
    kind: z.literal('ConfigMap'),
    metadata: metadataSchema,
    data: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export const secretSchema = z
  .object({
    apiVersion: z.literal('v1'),
    kind: z.literal('Secret'),
    metadata: metadataSchema,
    type: z.string().optional(),
    immutable: z.boolean().optional(),
    data: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export type Secret = z.infer<typeof secretSchema>;

export function resourcePageSchema<T>(item: z.ZodType<T>, kind: 'Pod' | 'ConfigMap') {
  const resource = z.preprocess(
    value =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? { apiVersion: 'v1', kind, ...value }
        : value,
    item
  );
  return z.object({
    apiVersion: z.literal('v1'),
    kind: z.literal(`${kind}List`),
    items: z.array(resource).max(4096),
    metadata: z
      .object({ resourceVersion: z.string().min(1).optional(), continue: z.string().optional() })
      .passthrough()
      .optional(),
  });
}

export function resourceListSchema<T>(item: z.ZodType<T>, kind: 'Pod' | 'ConfigMap') {
  return resourcePageSchema(item, kind).refine(
    list => !list.metadata?.continue,
    'Resource list is incomplete'
  );
}

export class KubernetesError extends Error {
  constructor(readonly status: number) {
    super('kubernetes_request_failed');
    this.name = 'KubernetesError';
  }
}

export async function readBoundedJson(response: Response, maxBytes = 1_048_576): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('response_body_missing');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) throw new Error('response_body_too_large');
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error('response_body_invalid');
  } finally {
    reader.releaseLock();
  }
}

export function namespacedPath(namespace: string, resource: string, name?: string): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/${resource}${name ? `/${encodeURIComponent(name)}` : ''}`;
}

export function createKubernetesClient(signal?: AbortSignal) {
  const credentialDirectory = '/var/run/secrets/kubernetes.io/serviceaccount';
  async function request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    patch = false
  ): Promise<T> {
    const attempts = method === 'GET' ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) throw new KubernetesError(0);
      try {
        const [rawToken, ca] = await Promise.all([
          readFile(`${credentialDirectory}/token`, 'utf8'),
          readFile(`${credentialDirectory}/ca.crt`, 'utf8'),
        ]);
        const token = rawToken.trim();
        if (!/^[A-Za-z0-9._-]{32,16384}$/.test(token))
          throw new Error('service_account_token_invalid');
        const response = await fetch(`https://kubernetes.default.svc${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(body === undefined
              ? {}
              : { 'content-type': patch ? 'application/json-patch+json' : 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'manual',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
            : AbortSignal.timeout(5000),
          tls: { ca, rejectUnauthorized: true },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new KubernetesError(response.status);
        }
        const parsed = schema.safeParse(await readBoundedJson(response, 8 * 1_048_576));
        if (!parsed.success) throw new Error('kubernetes_response_invalid');
        return parsed.data;
      } catch (error) {
        if (
          error instanceof KubernetesError &&
          error.status !== 401 &&
          error.status !== 429 &&
          error.status < 500
        )
          throw error;
        if (attempt + 1 === attempts) {
          throw error instanceof KubernetesError ? error : new KubernetesError(0);
        }
        await Bun.sleep(250 * 2 ** attempt);
      }
    }
    throw new KubernetesError(0);
  }
  return {
    async get<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
      try {
        return await request('GET', path, schema);
      } catch (error) {
        if (error instanceof KubernetesError && error.status === 404) return null;
        throw error;
      }
    },
    create: <T>(path: string, body: unknown, schema: z.ZodType<T>) =>
      request('POST', path, schema, body),
    replace: <T>(path: string, body: unknown, schema: z.ZodType<T>) =>
      request('PUT', path, schema, body),
    patch: <T>(path: string, body: unknown, schema: z.ZodType<T>) =>
      request('PATCH', path, schema, body, true),
    async remove(
      path: string,
      uid: string,
      gracePeriodSeconds = 10,
      resourceVersion?: string
    ): Promise<void> {
      try {
        await request('DELETE', path, z.unknown(), {
          apiVersion: 'v1',
          kind: 'DeleteOptions',
          gracePeriodSeconds,
          preconditions: { uid, ...(resourceVersion === undefined ? {} : { resourceVersion }) },
        });
      } catch (error) {
        if (!(error instanceof KubernetesError && error.status === 404)) throw error;
      }
    },
  };
}

export type KubernetesClient = ReturnType<typeof createKubernetesClient>;

export function ownedLabels(installationId: string, component: string, allocationId?: string) {
  return {
    'app.kubernetes.io/managed-by': MANAGED_BY,
    'kilo.ai/installation': installationId,
    'kilo.ai/component': component,
    ...(allocationId ? { 'kilo.ai/allocation': allocationId } : {}),
  };
}

export function isOwned(
  metadata: z.infer<typeof metadataSchema>,
  installationId: string,
  component: string,
  allocationId?: string
): boolean {
  return Object.entries(ownedLabels(installationId, component, allocationId)).every(
    ([key, value]) => metadata.labels?.[key] === value
  );
}

export function labelQuery(installationId: string, component: string): string {
  return `?labelSelector=${encodeURIComponent(
    Object.entries(ownedLabels(installationId, component))
      .map(([key, value]) => `${key}=${value}`)
      .join(',')
  )}`;
}

export function podName(allocationId: string): string {
  return `kilo-${z.uuid().parse(allocationId).toLowerCase()}`;
}

export function bootstrapName(allocationId: string): string {
  return `${podName(allocationId)}-bootstrap`;
}

export function ledgerName(allocationId: string): string {
  return `${podName(allocationId)}-ledger`;
}

export function podSecurityContext() {
  return {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    seccompProfile: { type: 'RuntimeDefault' },
  };
}

export function containerSecurityContext() {
  return {
    allowPrivilegeEscalation: false,
    privileged: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  };
}

export function sandboxSpec(
  config: OnPremConfig,
  activeDeadlineSeconds: number,
  env: unknown[],
  command: string[]
) {
  const cpu =
    config.resources.cpuMillis % 1000 === 0
      ? String(config.resources.cpuMillis / 1000)
      : `${config.resources.cpuMillis}m`;
  const binaryQuantity = (value: number) =>
    value % 1024 === 0 ? `${value / 1024}Gi` : `${value}Mi`;
  const memory = binaryQuantity(config.resources.memoryMiB);
  const disk = binaryQuantity(config.resources.diskMiB);
  const cloudHostname = new URL(config.cloudUrl).hostname;
  return {
    runtimeClassName: config.profile.runtimeClass,
    restartPolicy: 'Never',
    activeDeadlineSeconds,
    terminationGracePeriodSeconds: 10,
    automountServiceAccountToken: false,
    serviceAccountName: SANDBOX_SERVICE_ACCOUNT,
    enableServiceLinks: false,
    shareProcessNamespace: false,
    securityContext: podSecurityContext(),
    hostAliases: [
      { ip: config.brokerClusterIp, hostnames: ['github.com', 'api.github.com'] },
      ...(z.ipv4().safeParse(cloudHostname).success
        ? []
        : [{ ip: config.cloudIPv4, hostnames: [cloudHostname] }]),
    ],
    dnsPolicy: 'None',
    dnsConfig: {
      nameservers: [config.dnsIPv4],
      searches: [
        `${config.systemNamespace}.svc.cluster.local`,
        'svc.cluster.local',
        'cluster.local',
      ],
      options: [{ name: 'ndots', value: '1' }],
    },
    containers: [
      {
        name: 'sandbox',
        image: config.profile.image,
        imagePullPolicy: 'IfNotPresent',
        command,
        env,
        securityContext: containerSecurityContext(),
        resources: {
          requests: { cpu, memory, 'ephemeral-storage': disk },
          limits: { cpu, memory, 'ephemeral-storage': disk },
        },
        volumeMounts: [
          { name: 'work', mountPath: '/workspace' },
          { name: 'home', mountPath: '/home' },
          { name: 'tmp', mountPath: '/tmp' },
          { name: 'cache', mountPath: '/var/cache/kilo' },
          { name: 'ca', mountPath: '/etc/kilo-onprem/ca', readOnly: true },
        ],
      },
    ],
    volumes: [
      { name: 'work', emptyDir: { sizeLimit: disk } },
      { name: 'home', emptyDir: { sizeLimit: disk } },
      { name: 'tmp', emptyDir: { sizeLimit: `${Math.min(512, config.resources.diskMiB)}Mi` } },
      { name: 'cache', emptyDir: { sizeLimit: disk } },
      { name: 'ca', configMap: { name: PUBLIC_CA_CONFIG_MAP, defaultMode: 0o444 } },
    ],
  };
}

export function fixedRuntimeEnv(config: OnPremConfig, hardStopAt: number) {
  return [
    { name: 'KILO_ONPREM_BROKER_URL', value: config.profile.brokerUrl },
    { name: 'KILO_ONPREM_CA_CERT', value: CA_MOUNT_PATH },
    { name: 'KILO_ONPREM_HARD_STOP_AT', value: String(hardStopAt) },
    { name: 'NODE_EXTRA_CA_CERTS', value: CA_MOUNT_PATH },
    { name: 'GIT_SSL_CAINFO', value: CA_MOUNT_PATH },
    { name: 'WRAPPER_LOG_PATH', value: '/tmp/kilocode-control-wrapper.log' },
    { name: 'HOME', value: '/home/kilo' },
  ];
}

export function hasLaunchGate(pod: Pod): boolean {
  return pod.spec.schedulingGates?.some(gate => gate.name === LAUNCH_GATE) ?? false;
}

export function containersTerminated(pod: Pod): boolean {
  if (
    pod.status?.phase === 'Unknown' ||
    ['NodeLost', 'ContainerStatusUnknown'].includes(pod.status?.reason ?? '') ||
    pod.status?.conditions?.some(condition =>
      ['NodeLost', 'ContainerStatusUnknown'].includes(condition.reason ?? '')
    )
  )
    return false;
  const statuses = pod.status?.containerStatuses ?? [];
  if (statuses.length !== pod.spec.containers.length) return false;
  if ((pod.spec.initContainers?.length ?? 0) > 0 || (pod.spec.ephemeralContainers?.length ?? 0) > 0)
    return false;
  return pod.spec.containers.every(container => {
    const status = statuses.find(item => item.name === container.name);
    const terminated = status?.state.terminated;
    return (
      terminated !== undefined &&
      !status?.state.running &&
      !status?.state.waiting &&
      !['NodeLost', 'ContainerStatusUnknown'].includes(terminated.reason ?? '') &&
      Boolean(terminated.containerID || status?.containerID) &&
      Number.isFinite(Date.parse(terminated.finishedAt ?? '')) &&
      Date.parse(terminated.finishedAt ?? '') > 0
    );
  });
}

export function neverScheduled(pod: Pod): boolean {
  return (
    hasLaunchGate(pod) &&
    !pod.spec.nodeName &&
    !pod.status?.containerStatuses?.length &&
    !pod.status?.initContainerStatuses?.length &&
    !pod.status?.ephemeralContainerStatuses?.length &&
    !pod.status?.conditions?.some(
      condition => condition.type === 'PodScheduled' && condition.status === 'True'
    )
  );
}

export function podIsRunning(pod: Pod): boolean {
  return (
    !pod.metadata.deletionTimestamp &&
    !hasLaunchGate(pod) &&
    pod.status?.phase === 'Running' &&
    Boolean(pod.spec.nodeName) &&
    Boolean(pod.status.podIP) &&
    pod.spec.containers.length === 1 &&
    pod.status.containerStatuses?.length === 1 &&
    Boolean(pod.status.containerStatuses[0]?.state.running) &&
    pod.status.containerStatuses[0]?.name === 'sandbox' &&
    (pod.status.containerStatuses[0]?.restartCount ?? 0) === 0
  );
}

export async function removeTerminationFinalizer(kube: KubernetesClient, pod: Pod): Promise<void> {
  if (!pod.metadata.finalizers?.includes(TERMINATION_FINALIZER)) return;
  await kube.patch(
    namespacedPath(pod.metadata.namespace ?? '', 'pods', pod.metadata.name),
    [
      { op: 'test', path: '/metadata/uid', value: pod.metadata.uid },
      { op: 'test', path: '/metadata/resourceVersion', value: pod.metadata.resourceVersion },
      {
        op: 'replace',
        path: '/metadata/finalizers',
        value: pod.metadata.finalizers.filter(value => value !== TERMINATION_FINALIZER),
      },
    ],
    podSchema
  );
}
