import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROKER_SERVICE, IDENTITY_SECRET, PUBLIC_CA_CONFIG_MAP } from '../src/kubernetes.js';
import { prepareRunDirectory, privateOutput, readPrivate } from './local-io.js';
import {
  foundationManifests,
  installationConfig,
  installationManifests,
  localConfigSchema,
  type LocalConfig,
  type Manifest,
} from './local-manifests.js';

type InstallPreviewBody = {
  kind: 'KiloOnPremInstallPreview';
  formatVersion: 1;
  reviewOnly: true;
  notice: string;
  operatorConfig: LocalConfig;
  lateBoundFields: {
    field: string;
    previewValue: string | null;
    locations: string[];
    resolution: string;
  }[];
  manifests: Manifest[];
};

export type InstallPreview = InstallPreviewBody & { approvalHash: string };

export function installPreviewApprovalHash(body: InstallPreviewBody): string {
  const canonical = JSON.stringify(body, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    );
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function createInstallPreview(input: unknown): InstallPreview {
  const local = localConfigSchema.parse(input);
  const placeholders = {
    organizationId: '<ORGANIZATION_ID_FROM_ENROLLMENT>',
    installationId: '<INSTALLATION_ID_FROM_ENROLLMENT>',
    dnsIPv4: '<CLUSTER_DNS_IPV4>',
    brokerClusterIp: '<BROKER_SERVICE_IPV4>',
    publicCa: '<PUBLIC_CA_PEM>',
    certificate: '<BROKER_CERTIFICATE_PEM>',
    privateKey: '<BROKER_PRIVATE_KEY_PEM>',
    bootstrapToken: '<ONE_TIME_BOOTSTRAP_TOKEN>',
  };
  const config = installationConfig(local, {
    organizationId: placeholders.organizationId,
    installationId: placeholders.installationId,
    dnsIPv4: local.dnsIPv4 ?? placeholders.dnsIPv4,
    brokerClusterIp: placeholders.brokerClusterIp,
  });
  const foundation = foundationManifests(config);
  const body: InstallPreviewBody = {
    kind: 'KiloOnPremInstallPreview',
    formatVersion: 1,
    reviewOnly: true,
    notice:
      'Review only, not a Kubernetes manifest or List. Do not use kubectl apply. Run install:local with --approve and this approval hash only after review.',
    operatorConfig: local,
    lateBoundFields: [
      {
        field: 'organizationId',
        previewValue: placeholders.organizationId,
        locations: ['ConfigMap/kilo-onprem-config.data.config.json: organizationId'],
        resolution: 'Read from the private enrollment file only after approval at install time.',
      },
      {
        field: 'installationId',
        previewValue: placeholders.installationId,
        locations: [
          'ConfigMap/kilo-onprem-config.data.config.json: installationId',
          'All kilo.ai/installation ownership labels and selectors',
        ],
        resolution: 'Read from the private enrollment file only after approval at install time.',
      },
      {
        field: 'dnsIPv4',
        previewValue: config.dnsIPv4,
        locations: ['ConfigMap/kilo-onprem-config.data.config.json: dnsIPv4'],
        resolution:
          'Discover from Service/kube-dns in kube-system at install time; a configured dnsIPv4 must match.',
      },
      {
        field: 'brokerClusterIp',
        previewValue: placeholders.brokerClusterIp,
        locations: [
          `Service/${BROKER_SERVICE}.spec.clusterIP (assigned by Kubernetes, omitted in manifests)`,
          'ConfigMap/kilo-onprem-config.data.config.json: brokerClusterIp',
        ],
        resolution: 'Read the owned broker Service IPv4 address after creating or applying it.',
      },
      {
        field: 'publicCa',
        previewValue: placeholders.publicCa,
        locations: [
          `ConfigMap/${PUBLIC_CA_CONFIG_MAP}.data.ca.crt (plain placeholder)`,
          'Secret/kilo-onprem-tls.data.ca.crt (base64 of placeholder)',
        ],
        resolution:
          'Generate or validate private local TLS files only after approval at install time.',
      },
      {
        field: 'certificate',
        previewValue: placeholders.certificate,
        locations: ['Secret/kilo-onprem-tls.data.tls.crt (base64 of placeholder)'],
        resolution:
          'Generate or validate the broker certificate only after approval at install time.',
      },
      {
        field: 'privateKey',
        previewValue: placeholders.privateKey,
        locations: ['Secret/kilo-onprem-tls.data.tls.key (base64 of placeholder)'],
        resolution:
          'Generate or validate the private broker key only after approval at install time.',
      },
      {
        field: 'bootstrapToken',
        previewValue: placeholders.bootstrapToken,
        locations: ['Secret/kilo-onprem-enrollment.data.bootstrap-token (base64 of placeholder)'],
        resolution: 'Read the one-time token from the private enrollment file only after approval.',
      },
      {
        field: 'identityCredential',
        previewValue: null,
        locations: [`Secret/${IDENTITY_SECRET}.data (empty on creation)`],
        resolution:
          'Create only if absent; retain existing owned identity data. The provisioner persists its credential before exchanging the bootstrap token. Preview never reads it.',
      },
      {
        field: 'caPrivateKey',
        previewValue: null,
        locations: ['Local run directory: ca.key (never installed in Kubernetes)'],
        resolution:
          'Generate or validate only after approval at install time. Preview never reads it.',
      },
    ],
    manifests: [
      ...foundation.namespaces,
      foundation.identity,
      foundation.service,
      ...installationManifests(
        config,
        local.provisionerImage,
        placeholders,
        placeholders.bootstrapToken
      ),
    ],
  };
  return { ...body, approvalHash: installPreviewApprovalHash(body) };
}

export async function previewLocal(args: string[]): Promise<void> {
  const flags = new Map<string, string>();
  const allowed = new Set(['--config', '--run-dir']);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !allowed.has(key) || !value || value.startsWith('--') || flags.has(key))
      throw new Error('explicit_preview_arguments_required');
    flags.set(key, value);
  }
  const configFile = flags.get('--config');
  const runDirectory = flags.get('--run-dir');
  if (!configFile || !runDirectory) throw new Error('explicit_preview_arguments_required');
  const preview = createInstallPreview(JSON.parse(await readPrivate(configFile)) as unknown);
  const repositoryRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
  await prepareRunDirectory(repositoryRoot, runDirectory, 'install-preview.json');
  const previewPath = join(runDirectory, 'install-preview.json');
  await privateOutput(previewPath, `${JSON.stringify(preview, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: 'local_install_preview',
      previewPath,
      approvalHash: preview.approvalHash,
    })
  );
}

if (import.meta.main) {
  try {
    await previewLocal(process.argv.slice(2));
  } catch {
    console.error('local_install_preview_failed');
    process.exitCode = 1;
  }
}
