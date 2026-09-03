import { z } from 'zod';
import { onPremProfileSchema } from '../../src/shared/onprem-protocol.js';
import {
  BROKER_PORT,
  BROKER_SERVICE,
  DENIED_PROBE_PORT,
  IDENTITY_SECRET,
  PUBLIC_CA_CONFIG_MAP,
  SANDBOX_SERVICE_ACCOUNT,
  containerSecurityContext,
  onPremConfigSchema,
  ownedLabels,
  podSecurityContext,
  type OnPremConfig,
} from '../src/kubernetes.js';

export const localConfigSchema = z
  .object({
    cloudUrl: onPremConfigSchema.shape.cloudUrl,
    cloudIPv4: onPremConfigSchema.shape.cloudIPv4,
    dnsIPv4: onPremConfigSchema.shape.dnsIPv4.optional(),
    systemNamespace: onPremConfigSchema.shape.systemNamespace,
    sandboxNamespace: onPremConfigSchema.shape.sandboxNamespace,
    resources: onPremConfigSchema.shape.resources,
    instanceTypes: onPremConfigSchema.shape.instanceTypes,
    upstreams: onPremConfigSchema.shape.upstreams,
    localFixtureUpstreams: onPremConfigSchema.shape.localFixtureUpstreams,
    profile: onPremProfileSchema.omit({ brokerUrl: true }),
    provisionerImage: onPremProfileSchema.shape.image,
  })
  .strict()
  .refine(config => config.systemNamespace !== config.sandboxNamespace)
  .refine(config => config.profile.runtimeClass === 'gvisor');

export type LocalConfig = z.infer<typeof localConfigSchema>;

export type Manifest = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels: Record<string, string> };
  [key: string]: unknown;
};

export function installationConfig(
  local: LocalConfig,
  resolved: Pick<OnPremConfig, 'organizationId' | 'installationId' | 'dnsIPv4' | 'brokerClusterIp'>
): OnPremConfig {
  return {
    cloudUrl: local.cloudUrl,
    organizationId: resolved.organizationId,
    installationId: resolved.installationId,
    profile: {
      ...local.profile,
      brokerUrl: `https://${BROKER_SERVICE}.${local.systemNamespace}.svc`,
    },
    systemNamespace: local.systemNamespace,
    sandboxNamespace: local.sandboxNamespace,
    brokerClusterIp: resolved.brokerClusterIp,
    cloudIPv4: local.cloudIPv4,
    dnsIPv4: resolved.dnsIPv4,
    resources: local.resources,
    ...(local.instanceTypes === undefined ? {} : { instanceTypes: local.instanceTypes }),
    bootstrapTokenFile: onPremConfigSchema.shape.bootstrapTokenFile.parse(undefined),
    tls: onPremConfigSchema.shape.tls.parse(undefined),
    upstreams: local.upstreams,
    localFixtureUpstreams: local.localFixtureUpstreams,
  };
}

export function foundationManifests(
  config: Pick<OnPremConfig, 'installationId' | 'systemNamespace' | 'sandboxNamespace'>
): { namespaces: Manifest[]; identity: Manifest; service: Manifest } {
  return {
    namespaces: [config.systemNamespace, config.sandboxNamespace].map(namespace => ({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: namespace,
        labels: {
          ...ownedLabels(config.installationId, 'namespace'),
          'pod-security.kubernetes.io/enforce': 'restricted',
          'pod-security.kubernetes.io/enforce-version': 'v1.36',
          'pod-security.kubernetes.io/audit': 'restricted',
          'pod-security.kubernetes.io/audit-version': 'v1.36',
          'pod-security.kubernetes.io/warn': 'restricted',
          'pod-security.kubernetes.io/warn-version': 'v1.36',
        },
      },
    })),
    identity: {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: IDENTITY_SECRET,
        namespace: config.systemNamespace,
        labels: ownedLabels(config.installationId, 'identity'),
      },
      type: 'Opaque',
      data: {},
    },
    service: {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: BROKER_SERVICE,
        namespace: config.systemNamespace,
        labels: ownedLabels(config.installationId, 'broker'),
      },
      spec: {
        type: 'ClusterIP',
        ipFamilyPolicy: 'SingleStack',
        ipFamilies: ['IPv4'],
        publishNotReadyAddresses: true,
        selector: ownedLabels(config.installationId, 'provisioner'),
        ports: [
          { name: 'https', port: 443, targetPort: BROKER_PORT, protocol: 'TCP' },
          {
            name: 'diagnostic',
            port: DENIED_PROBE_PORT,
            targetPort: DENIED_PROBE_PORT,
            protocol: 'TCP',
          },
        ],
      },
    },
  };
}

export function installationManifests(
  config: OnPremConfig,
  provisionerImage: string,
  tls: { publicCa: string; certificate: string; privateKey: string },
  bootstrapToken: string
): Manifest[] {
  const metadata = (name: string, namespace: string | undefined, component: string) => ({
    name,
    ...(namespace ? { namespace } : {}),
    labels: ownedLabels(config.installationId, component),
  });
  const serviceAccount = 'kilo-onprem-provisioner';
  const runtimeRole = `${config.systemNamespace}-runtime`;
  const subject = {
    kind: 'ServiceAccount',
    name: serviceAccount,
    namespace: config.systemNamespace,
  };
  const cpu = `${config.resources.cpuMillis}m`;
  const memory = `${config.resources.memoryMiB}Mi`;
  const disk = `${config.resources.diskMiB}Mi`;
  const capacity = config.resources.maxConcurrent + 1;
  const cloudUrl = new URL(config.cloudUrl);
  const cloudPort = Number(cloudUrl.port || (cloudUrl.protocol === 'https:' ? 443 : 80));
  const trustedHosts = [
    ...new Set([
      cloudUrl.hostname,
      ...Object.values(config.upstreams).map(value => new URL(value).hostname),
      ...Object.values(config.localFixtureUpstreams ?? {}).map(value => new URL(value).hostname),
    ]),
  ].filter(host => ['host.docker.internal', 'host.lima.internal'].includes(host));
  const sandboxSelector = {
    matchLabels: {
      'app.kubernetes.io/managed-by': 'kilo-onprem',
      'kilo.ai/installation': config.installationId,
    },
  };
  const systemSelector = { matchLabels: ownedLabels(config.installationId, 'provisioner') };
  const systemNamespaceSelector = {
    matchLabels: { 'kubernetes.io/metadata.name': config.systemNamespace },
  };
  const sandboxNamespaceSelector = {
    matchLabels: { 'kubernetes.io/metadata.name': config.sandboxNamespace },
  };
  return [
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: metadata(serviceAccount, config.systemNamespace, 'rbac'),
      automountServiceAccountToken: false,
    },
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: metadata(SANDBOX_SERVICE_ACCOUNT, config.sandboxNamespace, 'rbac'),
      automountServiceAccountToken: false,
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: metadata(serviceAccount, config.systemNamespace, 'rbac'),
      rules: [
        {
          apiGroups: [''],
          resources: ['secrets'],
          resourceNames: [IDENTITY_SECRET],
          verbs: ['get', 'update'],
        },
        {
          apiGroups: [''],
          resources: ['configmaps'],
          verbs: ['get', 'list', 'create', 'update', 'delete'],
        },
        {
          apiGroups: [''],
          resources: ['services'],
          resourceNames: [BROKER_SERVICE],
          verbs: ['get'],
        },
      ],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: metadata(serviceAccount, config.sandboxNamespace, 'rbac'),
      rules: [
        {
          apiGroups: [''],
          resources: ['pods'],
          verbs: ['get', 'list', 'create', 'patch', 'delete'],
        },
        { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'create', 'delete'] },
        {
          apiGroups: [''],
          resources: ['configmaps'],
          resourceNames: [PUBLIC_CA_CONFIG_MAP],
          verbs: ['get'],
        },
      ],
    },
    ...[config.systemNamespace, config.sandboxNamespace].map(namespace => ({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: metadata(serviceAccount, namespace, 'rbac'),
      subjects: [subject],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: serviceAccount },
    })),
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: metadata(runtimeRole, undefined, 'rbac'),
      rules: [
        {
          apiGroups: ['node.k8s.io'],
          resources: ['runtimeclasses'],
          resourceNames: [config.profile.runtimeClass],
          verbs: ['get'],
        },
        {
          apiGroups: ['authorization.k8s.io'],
          resources: ['selfsubjectaccessreviews'],
          verbs: ['create'],
        },
      ],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: metadata(runtimeRole, undefined, 'rbac'),
      subjects: [subject],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: runtimeRole },
    },
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: metadata('kilo-onprem-config', config.systemNamespace, 'config'),
      data: { 'config.json': JSON.stringify(config) },
    },
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: metadata(PUBLIC_CA_CONFIG_MAP, config.sandboxNamespace, 'ca'),
      immutable: true,
      data: { 'ca.crt': tls.publicCa },
    },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: metadata('kilo-onprem-tls', config.systemNamespace, 'tls'),
      type: 'kubernetes.io/tls',
      data: {
        'ca.crt': Buffer.from(tls.publicCa).toString('base64'),
        'tls.crt': Buffer.from(tls.certificate).toString('base64'),
        'tls.key': Buffer.from(tls.privateKey).toString('base64'),
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: metadata('kilo-onprem-enrollment', config.systemNamespace, 'enrollment'),
      type: 'Opaque',
      data: { 'bootstrap-token': Buffer.from(bootstrapToken).toString('base64') },
    },
    {
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: metadata('kilo-onprem-capacity', config.sandboxNamespace, 'quota'),
      spec: {
        hard: {
          pods: String(capacity),
          secrets: '512',
          configmaps: '4',
          'requests.cpu': `${config.resources.cpuMillis * capacity}m`,
          'limits.cpu': `${config.resources.cpuMillis * capacity}m`,
          'requests.memory': `${config.resources.memoryMiB * capacity}Mi`,
          'limits.memory': `${config.resources.memoryMiB * capacity}Mi`,
          'requests.ephemeral-storage': `${config.resources.diskMiB * capacity}Mi`,
          'limits.ephemeral-storage': `${config.resources.diskMiB * capacity}Mi`,
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: metadata('kilo-onprem-ledgers', config.systemNamespace, 'quota'),
      spec: { hard: { configmaps: '4096', secrets: '4', pods: '1' } },
    },
    {
      apiVersion: 'v1',
      kind: 'LimitRange',
      metadata: metadata('kilo-onprem-profile', config.sandboxNamespace, 'quota'),
      spec: {
        limits: [
          {
            type: 'Container',
            max: { cpu, memory, 'ephemeral-storage': disk },
            default: { cpu, memory, 'ephemeral-storage': disk },
            defaultRequest: { cpu, memory, 'ephemeral-storage': disk },
          },
        ],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata('default-deny', config.sandboxNamespace, 'network-policy'),
      spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata('approved-egress', config.sandboxNamespace, 'network-policy'),
      spec: {
        podSelector: sandboxSelector,
        policyTypes: ['Egress'],
        egress: [
          {
            to: [{ namespaceSelector: systemNamespaceSelector, podSelector: systemSelector }],
            ports: [{ protocol: 'TCP', port: BROKER_PORT }],
          },
          {
            to: [{ ipBlock: { cidr: `${config.cloudIPv4}/32` } }],
            ports: [{ protocol: 'TCP', port: cloudPort }],
          },
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
                },
                podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
              },
            ],
            ports: [
              { protocol: 'UDP', port: 53 },
              { protocol: 'TCP', port: 53 },
            ],
          },
        ],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata('trusted-ingress', config.systemNamespace, 'network-policy'),
      spec: {
        podSelector: systemSelector,
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [{ namespaceSelector: sandboxNamespaceSelector, podSelector: sandboxSelector }],
            ports: [
              { protocol: 'TCP', port: BROKER_PORT },
              { protocol: 'TCP', port: DENIED_PROBE_PORT },
            ],
          },
          {
            from: [{ namespaceSelector: systemNamespaceSelector, podSelector: systemSelector }],
            ports: [
              { protocol: 'TCP', port: BROKER_PORT },
              { protocol: 'TCP', port: DENIED_PROBE_PORT },
            ],
          },
        ],
      },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: metadata(serviceAccount, config.systemNamespace, 'provisioner'),
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: systemSelector,
        template: {
          metadata: { labels: ownedLabels(config.installationId, 'provisioner') },
          spec: {
            serviceAccountName: serviceAccount,
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            terminationGracePeriodSeconds: 30,
            securityContext: podSecurityContext(),
            ...(trustedHosts.length > 0
              ? { hostAliases: [{ ip: config.cloudIPv4, hostnames: trustedHosts }] }
              : {}),
            containers: [
              {
                name: 'provisioner',
                image: provisionerImage,
                imagePullPolicy: 'IfNotPresent',
                args: ['--config', '/etc/kilo-onprem/config/config.json'],
                securityContext: containerSecurityContext(),
                ports: [
                  { name: 'broker', containerPort: BROKER_PORT },
                  { name: 'diagnostic', containerPort: DENIED_PROBE_PORT },
                ],
                resources: {
                  requests: { cpu: '250m', memory: '256Mi', 'ephemeral-storage': '64Mi' },
                  limits: { cpu: '1000m', memory: '512Mi', 'ephemeral-storage': '128Mi' },
                },
                readinessProbe: {
                  httpGet: { path: '/livez', port: 'diagnostic' },
                  periodSeconds: 5,
                  timeoutSeconds: 2,
                },
                livenessProbe: {
                  httpGet: { path: '/livez', port: 'diagnostic' },
                  periodSeconds: 10,
                  timeoutSeconds: 2,
                  failureThreshold: 3,
                },
                startupProbe: {
                  httpGet: { path: '/livez', port: 'diagnostic' },
                  periodSeconds: 2,
                  timeoutSeconds: 2,
                  failureThreshold: 45,
                },
                volumeMounts: [
                  { name: 'config', mountPath: '/etc/kilo-onprem/config', readOnly: true },
                  { name: 'tls', mountPath: '/etc/kilo-onprem/tls', readOnly: true },
                  { name: 'enrollment', mountPath: '/etc/kilo-onprem/enrollment', readOnly: true },
                  {
                    name: 'kubernetes',
                    mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
                    readOnly: true,
                  },
                  { name: 'tmp', mountPath: '/tmp' },
                ],
              },
            ],
            volumes: [
              { name: 'config', configMap: { name: 'kilo-onprem-config', defaultMode: 0o440 } },
              { name: 'tls', secret: { secretName: 'kilo-onprem-tls', defaultMode: 0o440 } },
              {
                name: 'enrollment',
                secret: { secretName: 'kilo-onprem-enrollment', defaultMode: 0o440 },
              },
              { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } },
              {
                name: 'kubernetes',
                projected: {
                  defaultMode: 0o440,
                  sources: [
                    { serviceAccountToken: { path: 'token', expirationSeconds: 3600 } },
                    {
                      configMap: {
                        name: 'kube-root-ca.crt',
                        items: [{ key: 'ca.crt', path: 'ca.crt' }],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  ];
}
