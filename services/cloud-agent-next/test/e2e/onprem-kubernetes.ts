import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { decodeOnPremProviderRef, onPremProfileSchema } from '../../src/shared/onprem-protocol.js';
import { CheckError, ROOT, check, parse } from './multichat-real-support.js';

export const namespaceSchema = z
  .string()
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const nameSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9][a-z0-9.-]*$/);
export const imageIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._:/@-]+$/);

export function localUrl(raw: string, label: string, containerFacing = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CheckError(`${label}: invalid URL`);
  }
  check(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/[\s\\]/.test(raw),
    `${label}: credential-free HTTP(S) URL without query or fragment required`
  );
  if (containerFacing && ['host.docker.internal', 'host.lima.internal'].includes(url.hostname)) {
    url.hostname = '127.0.0.1';
  }
  check(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    `${label}: local endpoint required`
  );
  url.hostname = '127.0.0.1';
  return url;
}

export function readPrivateFile(path: string): string {
  const absolute = resolve(ROOT, path);
  check(realpathSync(dirname(absolute)) === dirname(absolute), 'Private file parent is symlinked');
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    check(
      stat.isFile() &&
        stat.uid === process.getuid?.() &&
        (stat.mode & 0o7777) === 0o600 &&
        stat.size <= 1_048_576,
      'Auth and kubeconfig must be owned, non-symlink, regular mode-0600 files under 1 MiB'
    );
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

const metadataSchema = z.object({
  name: nameSchema,
  namespace: namespaceSchema,
  uid: z.uuid(),
  labels: z.record(z.string(), z.string()),
});
const configMapSchema = z.object({
  metadata: metadataSchema,
  data: z.record(z.string(), z.string()),
});
const installedConfigSchema = z.object({
  organizationId: z.uuid(),
  installationId: z.uuid(),
  systemNamespace: namespaceSchema,
  sandboxNamespace: namespaceSchema,
  cloudUrl: z.string(),
  cloudIPv4: z.ipv4().refine(value => {
    const [first, second] = value.split('.').map(Number);
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }),
  profile: onPremProfileSchema,
  upstreams: z.object({
    backendBaseUrl: z.string(),
    providerBaseUrl: z.string(),
    sessionIngestBaseUrl: z.string(),
  }),
  localFixtureUpstreams: z
    .object({
      'github.com': z.string(),
      'api.github.com': z.string().optional(),
    })
    .optional(),
});
const allocationSchema = z.object({
  version: z.literal(1),
  organizationId: z.uuid(),
  installationId: z.uuid(),
  allocationId: z.uuid(),
  sandboxId: z.string(),
  providerRef: z.string(),
  launch: z.object({ profileId: z.string(), profileRevision: z.string() }).nullable(),
  pod: z.object({ namespace: namespaceSchema, name: nameSchema, uid: z.uuid() }).nullable(),
  registered: z.boolean(),
  gate: z.enum(['closed', 'opening', 'open']),
  stop: z.unknown().nullable(),
  termination: z.unknown().nullable(),
});
const podSchema = z.object({
  metadata: metadataSchema.extend({
    creationTimestamp: z.iso.datetime({ offset: true }),
    deletionTimestamp: z.string().nullish(),
  }),
  spec: z.object({
    runtimeClassName: nameSchema.optional(),
    containers: z.array(z.object({ name: nameSchema, image: onPremProfileSchema.shape.image })),
  }),
  status: z.object({
    phase: z.enum(['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown']),
    containerStatuses: z
      .array(
        z.object({
          name: nameSchema,
          imageID: imageIdSchema,
          restartCount: z.number().int().nonnegative(),
          state: z.object({ running: z.object({ startedAt: z.string() }).optional() }),
        })
      )
      .optional(),
  }),
});

export function kubernetesInspector(input: {
  kubeconfig: string;
  context: string;
  organizationId: string;
  installationId: string;
  systemNamespace: string;
  signal: AbortSignal;
}) {
  const kubeconfig = resolve(ROOT, input.kubeconfig);
  const fingerprint = createHash('sha256').update(readPrivateFile(kubeconfig)).digest('hex');
  const flags = ['--kubeconfig', kubeconfig, '--context', input.context];
  function command(args: string[]): unknown {
    check(!input.signal.aborted, 'Kubernetes inspection stopped');
    check(
      createHash('sha256').update(readPrivateFile(kubeconfig)).digest('hex') === fingerprint,
      'Kubeconfig changed during the run'
    );
    try {
      const text = execFileSync('kubectl', [...flags, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 8 * 1_048_576,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', NO_PROXY: '*' },
      });
      return JSON.parse(text) as unknown;
    } catch {
      throw new CheckError(
        'Explicit-context Kubernetes inspection failed; transport details omitted'
      );
    }
  }
  const view = parse(
    z.object({
      'current-context': z.string(),
      contexts: z
        .array(
          z.object({
            name: z.string(),
            context: z.object({ cluster: z.string(), user: z.string() }),
          })
        )
        .length(1),
      clusters: z
        .array(z.object({ name: z.string(), cluster: z.record(z.string(), z.unknown()) }))
        .length(1),
      users: z
        .array(z.object({ name: z.string(), user: z.record(z.string(), z.unknown()) }))
        .length(1),
    }),
    command(['config', 'view', '--minify', '-o', 'json']),
    'Kubeconfig view'
  );
  const context = view.contexts[0];
  const cluster = view.clusters[0];
  const user = view.users[0];
  check(
    context &&
      cluster &&
      user &&
      view['current-context'] === input.context &&
      context.name === input.context &&
      context.context.cluster === cluster.name &&
      context.context.user === user.name,
    'Kubeconfig context mismatch'
  );
  check(
    !cluster.cluster['insecure-skip-tls-verify'] &&
      !cluster.cluster['proxy-url'] &&
      !cluster.cluster['tls-server-name'] &&
      !user.user.exec &&
      !user.user['auth-provider'],
    'Kubeconfig must not use TLS bypass, proxies, server-name overrides, or credential plugins'
  );
  const server = localUrl(
    parse(z.string(), cluster.cluster.server, 'Kubernetes server'),
    'Kubernetes server'
  );
  check(
    server.protocol === 'https:' && server.pathname === '/',
    'Local HTTPS Kubernetes origin required'
  );

  function labels(component: string, allocationId?: string) {
    return {
      'app.kubernetes.io/managed-by': 'kilo-onprem',
      'kilo.ai/installation': input.installationId,
      'kilo.ai/component': component,
      ...(allocationId ? { 'kilo.ai/allocation': allocationId } : {}),
    };
  }
  function owned(
    metadata: z.infer<typeof metadataSchema>,
    component: string,
    allocationId?: string
  ) {
    check(
      Object.entries(labels(component, allocationId)).every(
        ([key, value]) => metadata.labels[key] === value
      ),
      'Kubernetes resource ownership mismatch'
    );
  }
  function configMaps(component: string) {
    const selector = Object.entries(labels(component))
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    return parse(
      z.object({ items: z.array(configMapSchema).max(4096) }),
      command([
        'get',
        'configmaps',
        '-n',
        input.systemNamespace,
        '-l',
        selector,
        '--request-timeout=10s',
        '-o',
        'json',
      ]),
      'Installation-scoped ConfigMaps'
    ).items;
  }
  const configurations = configMaps('config');
  const configuration = configurations[0];
  check(
    configurations.length === 1 && configuration,
    'Exactly one installation config is required'
  );
  owned(configuration.metadata, 'config');
  const config = parse(
    installedConfigSchema,
    JSON.parse(configuration.data['config.json'] ?? 'null') as unknown,
    'Installed onprem config'
  );
  check(
    config.installationId === input.installationId &&
      config.organizationId === input.organizationId &&
      config.systemNamespace === input.systemNamespace &&
      configuration.metadata.namespace === input.systemNamespace,
    'Installed onprem configuration identity mismatch'
  );
  check(
    config.profile.brokerUrl === `https://kilo-onprem-broker.${input.systemNamespace}.svc`,
    'Installed broker must use the installation-local Kubernetes service'
  );

  function inspect(sandboxId: string) {
    check(/^ses-[a-f0-9]{48}$/.test(sandboxId), 'An authoritative isolated sandbox ID is required');
    const matches = configMaps('ledger').flatMap(resource => {
      const value: unknown = JSON.parse(resource.data['ledger.json'] ?? 'null');
      const identity = parse(
        z.object({ sandboxId: z.string() }),
        value,
        'Allocation ledger identity'
      );
      if (identity.sandboxId !== sandboxId) return [];
      const ledger = parse(allocationSchema, value, 'Owned allocation ledger');
      owned(resource.metadata, 'ledger', ledger.allocationId);
      check(
        resource.metadata.namespace === input.systemNamespace &&
          ledger.organizationId === input.organizationId &&
          ledger.installationId === input.installationId,
        'Allocation ledger ownership mismatch'
      );
      return [ledger];
    });
    check(
      matches.length <= 1,
      'Multiple allocations match this run; replacement is not a warm pass'
    );
    const ledger = matches[0];
    if (!ledger?.pod || !ledger.launch || !ledger.registered || ledger.gate !== 'open')
      return undefined;
    check(!ledger.stop && !ledger.termination, 'Owned allocation is stopping or terminated');
    const ref = decodeOnPremProviderRef(ledger.providerRef);
    check(
      ref?.installationId === input.installationId &&
        ref.allocationId === ledger.allocationId &&
        ledger.launch.profileId === config.profile.id &&
        ledger.launch.profileRevision === config.profile.revision,
      'Allocation provider reference or pinned profile mismatch'
    );
    check(
      ledger.pod.namespace === config.sandboxNamespace,
      'Allocation points outside its sandbox namespace'
    );
    const pod = parse(
      podSchema,
      command([
        'get',
        'pod',
        ledger.pod.name,
        '-n',
        ledger.pod.namespace,
        '--request-timeout=10s',
        '-o',
        'json',
      ]),
      'Owned Pod'
    );
    owned(pod.metadata, 'sandbox', ledger.allocationId);
    check(
      pod.metadata.uid === ledger.pod.uid &&
        pod.metadata.name === ledger.pod.name &&
        pod.metadata.namespace === ledger.pod.namespace,
      'Pod identity differs from the authoritative ledger'
    );
    return {
      provider: 'onprem' as const,
      installationId: ref.installationId,
      allocationId: ref.allocationId,
      providerRef: ledger.providerRef,
      sandboxId,
      pod: {
        ...ledger.pod,
        createdAt: pod.metadata.creationTimestamp,
        deleting: Boolean(pod.metadata.deletionTimestamp),
        phase: pod.status.phase,
        runtimeClass: pod.spec.runtimeClassName ?? null,
        containers: pod.spec.containers.map(container => {
          const status = pod.status.containerStatuses?.find(item => item.name === container.name);
          return {
            ...container,
            imageID: status?.imageID ?? null,
            restartCount: status?.restartCount ?? null,
            running: Boolean(status?.state.running),
          };
        }),
      },
    };
  }
  return { server: server.origin, config, inspect };
}

export type OnPremIdentity = NonNullable<
  ReturnType<ReturnType<typeof kubernetesInspector>['inspect']>
>;
