import { X509Certificate } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { onPremEnrollmentResponseSchema } from '../../src/shared/onprem-protocol.js';
import { BROKER_SERVICE, onPremConfigSchema } from '../src/kubernetes.js';
import { isMissingFile, prepareRunDirectory, privateOutput, readPrivate, run } from './local-io.js';
import {
  foundationManifests,
  installationConfig,
  installationManifests,
  type Manifest,
} from './local-manifests.js';
import { createInstallPreview } from './preview-local.js';

export { installationManifests } from './local-manifests.js';

export function isLoopbackKubernetesServer(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

async function certificates(runDirectory: string, brokerHostname: string) {
  const caKey = join(runDirectory, 'ca.key');
  const caCert = join(runDirectory, 'ca.crt');
  const key = join(runDirectory, 'tls.key');
  const cert = join(runDirectory, 'tls.crt');
  let existing = 0;
  for (const path of [caKey, caCert, key, cert]) {
    try {
      await readPrivate(path);
      existing++;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  if (existing !== 0 && existing !== 4) throw new Error('incomplete_local_ca');
  if (existing === 0) {
    await run([
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:3072',
      '-sha256',
      '-nodes',
      '-days',
      '3650',
      '-subj',
      '/CN=Kilo on-prem local CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-keyout',
      caKey,
      '-out',
      caCert,
    ]);
    const csr = join(runDirectory, 'tls.csr');
    const extensions = join(runDirectory, 'tls.extensions');
    await privateOutput(
      extensions,
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:github.com,DNS:api.github.com,DNS:${brokerHostname},DNS:${brokerHostname}.cluster.local\n`
    );
    await run([
      'openssl',
      'req',
      '-new',
      '-newkey',
      'rsa:3072',
      '-nodes',
      '-sha256',
      '-subj',
      '/CN=Kilo on-prem broker',
      '-keyout',
      key,
      '-out',
      csr,
    ]);
    await run([
      'openssl',
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      caCert,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-days',
      '365',
      '-sha256',
      '-extfile',
      extensions,
      '-out',
      cert,
    ]);
  }
  await run(['openssl', 'verify', '-CAfile', caCert, cert]);
  await run(['openssl', 'x509', '-checkend', '86400', '-noout', '-in', cert]);
  const [publicCa, certificate, privateKey] = await Promise.all([
    readPrivate(caCert),
    readPrivate(cert),
    readPrivate(key),
  ]);
  const leaf = new X509Certificate(certificate);
  if (
    !['github.com', 'api.github.com', brokerHostname].every(host => leaf.checkHost(host) === host)
  )
    throw new Error('broker_certificate_names_invalid');
  const publicKey = await run(['openssl', 'pkey', '-in', key, '-pubout']);
  if (
    publicKey.trim() !== (await run(['openssl', 'x509', '-in', cert, '-pubkey', '-noout'])).trim()
  )
    throw new Error('broker_certificate_key_mismatch');
  return { publicCa, certificate, privateKey };
}

export async function installLocal(args: string[]): Promise<void> {
  const flags = new Map<string, string>();
  const allowed = new Set([
    '--kubeconfig',
    '--context',
    '--config',
    '--enrollment',
    '--run-dir',
    '--approve',
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === '--approve' && (!value || !/^[a-f0-9]{64}$/.test(value)))
      throw new Error('local_install_approval_required');
    if (!key || !allowed.has(key) || !value || value.startsWith('--') || flags.has(key))
      throw new Error('explicit_install_arguments_required');
    flags.set(key, value);
  }
  const approvalHash = flags.get('--approve');
  if (!approvalHash) throw new Error('local_install_approval_required');
  const kubeconfig = flags.get('--kubeconfig');
  const context = flags.get('--context');
  const configFile = flags.get('--config');
  const enrollmentFile = flags.get('--enrollment');
  const runDirectory = flags.get('--run-dir');
  if (
    !kubeconfig ||
    !context ||
    !configFile ||
    !enrollmentFile ||
    !runDirectory ||
    context.length > 253 ||
    /\s/.test(context)
  )
    throw new Error('explicit_install_arguments_required');
  const preview = createInstallPreview(JSON.parse(await readPrivate(configFile)) as unknown);
  if (approvalHash !== preview.approvalHash) throw new Error('local_install_approval_mismatch');
  const local = preview.operatorConfig;
  process.umask(0o077);
  await readPrivate(kubeconfig);
  const enrollment = onPremEnrollmentResponseSchema.parse(
    JSON.parse(await readPrivate(enrollmentFile)) as unknown
  );
  if (Date.parse(enrollment.expiresAt) <= Date.now()) throw new Error('enrollment_expired');
  const kubectl = (argv: string[]) =>
    run([
      'kubectl',
      '--kubeconfig',
      kubeconfig,
      '--context',
      context,
      '--request-timeout=15s',
      ...argv,
    ]);
  const kubeConfigSchema = z.object({
    clusters: z
      .array(
        z.object({
          name: z.string(),
          cluster: z
            .object({
              server: z.string().refine(isLoopbackKubernetesServer),
              'insecure-skip-tls-verify': z.boolean().optional(),
              'proxy-url': z.string().optional(),
              'tls-server-name': z.string().optional(),
            })
            .passthrough(),
        })
      )
      .length(1),
    contexts: z.array(z.object({ name: z.literal(context) })).length(1),
    users: z
      .array(
        z.object({
          user: z
            .object({ exec: z.unknown().optional(), 'auth-provider': z.unknown().optional() })
            .passthrough(),
        })
      )
      .length(1),
  });
  const view = kubeConfigSchema.parse(
    JSON.parse(
      await kubectl(['config', 'view', '--minify', '--raw', '--flatten', '-o', 'json'])
    ) as unknown
  );
  const cluster = view.clusters[0]?.cluster;
  const user = view.users[0]?.user;
  if (
    !cluster ||
    cluster['insecure-skip-tls-verify'] ||
    cluster['proxy-url'] ||
    cluster['tls-server-name'] ||
    user?.exec ||
    user?.['auth-provider']
  )
    throw new Error('unsafe_kubeconfig');
  const version = z.object({
    serverVersion: z.object({ gitVersion: z.string().regex(/^v1\.36\.3\+k3s[0-9]+$/) }),
  });
  version.parse(JSON.parse(await kubectl(['version', '-o', 'json'])) as unknown);
  const nodes = z.object({
    items: z
      .array(
        z.object({
          status: z.object({
            nodeInfo: z.object({
              architecture: z.literal('arm64'),
              operatingSystem: z.literal('linux'),
              osImage: z.string().startsWith('Ubuntu 24.04'),
            }),
          }),
        })
      )
      .length(1),
  });
  nodes.parse(JSON.parse(await kubectl(['get', 'nodes', '-o', 'json'])) as unknown);
  z.object({ handler: z.literal('runsc') }).parse(
    JSON.parse(await kubectl(['get', 'runtimeclass', 'gvisor', '-o', 'json'])) as unknown
  );
  const cilium = z.object({
    spec: z.object({
      template: z.object({
        spec: z.object({ containers: z.array(z.object({ name: z.string(), image: z.string() })) }),
      }),
    }),
  });
  const cni = cilium.parse(
    JSON.parse(
      await kubectl(['get', 'daemonset', 'cilium', '-n', 'kube-system', '-o', 'json'])
    ) as unknown
  );
  if (
    !cni.spec.template.spec.containers.some(
      container =>
        container.name === 'cilium-agent' &&
        /\/cilium:v1\.20\.1(?:@sha256:[a-f0-9]{64})?$/.test(container.image)
    )
  )
    throw new Error('unsupported_cilium_version');
  const serviceAddressSchema = z.object({ spec: z.object({ clusterIP: z.ipv4() }) });
  const dns = serviceAddressSchema.parse(
    JSON.parse(
      await kubectl(['get', 'service', 'kube-dns', '-n', 'kube-system', '-o', 'json'])
    ) as unknown
  );
  if (local.dnsIPv4 && local.dnsIPv4 !== dns.spec.clusterIP)
    throw new Error('dns_service_mismatch');
  const repositoryRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
  await prepareRunDirectory(repositoryRoot, runDirectory, 'installation.json');
  const brokerHostname = `${BROKER_SERVICE}.${local.systemNamespace}.svc`;
  const tls = await certificates(runDirectory, brokerHostname);
  const outputDirectory = runDirectory;
  let fileIndex = 0;
  const existingSchema = z.object({
    metadata: z.object({ labels: z.record(z.string(), z.string()).optional() }),
  });
  async function getExisting(manifest: Manifest): Promise<unknown> {
    const output = await kubectl([
      'get',
      manifest.kind.toLowerCase(),
      manifest.metadata.name,
      ...(manifest.metadata.namespace ? ['-n', manifest.metadata.namespace] : []),
      '--ignore-not-found',
      '-o',
      'json',
    ]);
    if (!output.trim()) return null;
    const json: unknown = JSON.parse(output);
    const existing = existingSchema.parse(json);
    if (
      Object.entries(manifest.metadata.labels)
        .filter(([key]) => key.startsWith('kilo.ai/') || key === 'app.kubernetes.io/managed-by')
        .some(([key, value]) => existing.metadata.labels?.[key] !== value)
    )
      throw new Error('existing_resource_not_owned');
    return json;
  }
  async function apply(manifest: Manifest, onlyCreate = false): Promise<void> {
    const existing = await getExisting(manifest);
    if (existing && onlyCreate) return;
    const path = join(
      outputDirectory,
      `${String(fileIndex++).padStart(2, '0')}-${manifest.kind.toLowerCase()}-${manifest.metadata.name}.json`
    );
    await privateOutput(path, JSON.stringify(manifest));
    await kubectl(
      existing || !onlyCreate
        ? ['apply', '--server-side', '--field-manager=kilo-onprem-local', '-f', path]
        : ['create', '-f', path]
    );
  }
  const foundation = foundationManifests({
    installationId: enrollment.installationId,
    systemNamespace: local.systemNamespace,
    sandboxNamespace: local.sandboxNamespace,
  });
  for (const namespace of foundation.namespaces) await apply(namespace);
  await apply(foundation.identity, true);
  await apply(foundation.service);
  const serviceData = serviceAddressSchema.parse(await getExisting(foundation.service));
  const config = onPremConfigSchema.parse(
    installationConfig(local, {
      dnsIPv4: dns.spec.clusterIP,
      organizationId: enrollment.organizationId,
      installationId: enrollment.installationId,
      brokerClusterIp: serviceData.spec.clusterIP,
    })
  );
  await privateOutput(join(runDirectory, 'config.json'), JSON.stringify(config));
  for (const manifest of installationManifests(
    config,
    local.provisionerImage,
    tls,
    enrollment.bootstrapToken
  ))
    await apply(manifest);
  console.log(
    JSON.stringify({
      status: 'local_install_applied',
      installationId: config.installationId,
      systemNamespace: config.systemNamespace,
      sandboxNamespace: config.sandboxNamespace,
    })
  );
}

if (import.meta.main) {
  try {
    await installLocal(process.argv.slice(2));
  } catch (error) {
    const code =
      error instanceof Error &&
      (error.message === 'local_install_approval_required' ||
        error.message === 'local_install_approval_mismatch')
        ? error.message
        : 'local_install_failed';
    console.error(code);
    process.exitCode = 1;
  }
}
