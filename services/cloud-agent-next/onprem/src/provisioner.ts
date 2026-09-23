import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  ON_PREM_CLOCK_SKEW_MS,
  ON_PREM_MAX_BATCH_SIZE,
  ON_PREM_PROTOCOL_VERSION,
  onPremEnrollResponseSchema,
  onPremExchangeRequestSchema,
  onPremExchangeResponseSchema,
  encodeOnPremProviderRef,
  type OnPremExchangeResponse,
} from '../../src/shared/onprem-protocol.js';
import {
  onPremCredentialRequestSchema,
  onPremCredentialResolveRequestSchema,
  onPremCredentialResolutionSchema,
  type OnPremCredentialRequest,
} from '../../src/shared/onprem-credential-protocol.js';
import {
  BROKER_SERVICE,
  CA_MOUNT_PATH,
  DENIED_PROBE_PORT,
  IDENTITY_SECRET,
  LAUNCH_GATE,
  PUBLIC_CA_CONFIG_MAP,
  RUNNER_VERSION,
  TERMINATION_FINALIZER,
  bootstrapName,
  configMapSchema,
  containersTerminated,
  createKubernetesClient,
  fixedRuntimeEnv,
  hasLaunchGate,
  isOwned,
  labelQuery,
  ledgerName,
  namespacedPath,
  neverScheduled,
  ownedLabels,
  podIsRunning,
  podName,
  podSchema,
  readBoundedJson,
  removeTerminationFinalizer,
  resourceListSchema,
  sandboxSpec,
  secretSchema,
  type KubernetesClient,
  type OnPremConfig,
  type Pod,
  type Secret,
} from './kubernetes.js';
import {
  acceptOperation,
  acknowledgeReports,
  approvedBootstrap,
  canOpenGate,
  ledgerSchema,
  newLedger,
  operationDigest,
  pinPod,
  policyDigest,
  queueReport,
  requestStop,
  sha256,
  terminationEvidence,
  type AllocationLedger,
  type LaunchOperation,
} from './ledger.js';

import type { BrokerAllocation } from './broker.js';
import { listResources } from './kubernetes-pagination.js';
import { createLedgerRetention, type LedgerRecord } from './ledger-retention.js';
type Health = { ready: boolean; diagnosticCode: string | null };
type ExchangeDelivery = {
  response: OnPremExchangeResponse;
  sent: ReadonlySet<string>;
  receivedAt: number;
};

export async function readPrivateFile(path: string, maxBytes = 1_048_576): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes || (info.mode & 0o027) !== 0)
    throw new Error('private_file_required');
  const content = await readFile(path, 'utf8');
  if (Buffer.byteLength(content) > maxBytes) throw new Error('private_file_too_large');
  return content;
}

async function cloudPost<T>(
  config: OnPremConfig,
  credential: string,
  route: string,
  body: unknown,
  schema: z.ZodType<T>
): Promise<T> {
  try {
    const prefix = `/onprem/organizations/${config.organizationId}/installations/${config.installationId}`;
    const response = await fetch(new URL(`${prefix}/${route}`, config.cloudUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('cloud_request_failed');
    }
    const parsed = schema.safeParse(await readBoundedJson(response));
    if (!parsed.success) throw new Error('cloud_response_invalid');
    return parsed.data;
  } catch {
    throw new Error('cloud_request_failed');
  }
}

function identityFlag(secret: Secret, key: string): boolean {
  return secret.data?.[key] === Buffer.from('true').toString('base64');
}

async function loadIdentity(
  kube: KubernetesClient,
  config: OnPremConfig
): Promise<{ secret: Secret; credential: string }> {
  const path = namespacedPath(config.systemNamespace, 'secrets', IDENTITY_SECRET);
  for (let attempt = 0; attempt < 3; attempt++) {
    const secret = await kube.get(path, secretSchema);
    if (
      !secret ||
      !isOwned(secret.metadata, config.installationId, 'identity') ||
      secret.metadata.namespace !== config.systemNamespace ||
      secret.immutable ||
      secret.metadata.deletionTimestamp
    )
      throw new Error('identity_secret_invalid');
    const encoded = secret.data?.managementCredential;
    if (encoded) {
      const credential = Buffer.from(encoded, 'base64').toString('utf8');
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(credential) ||
        Buffer.from(credential, 'base64url').length !== 32
      )
        throw new Error('identity_credential_invalid');
      return { secret, credential };
    }
    if (identityFlag(secret, 'enrolled') || identityFlag(secret, 'revoked'))
      throw new Error('identity_credential_missing');
    const credential = randomBytes(32).toString('base64url');
    try {
      const saved = await kube.replace(
        path,
        {
          ...secret,
          data: {
            ...secret.data,
            managementCredential: Buffer.from(credential).toString('base64'),
          },
        },
        secretSchema
      );
      if (saved.data?.managementCredential !== Buffer.from(credential).toString('base64'))
        throw new Error('identity_write_invalid');
      return { secret: saved, credential };
    } catch {
      if (attempt === 2) throw new Error('identity_persistence_failed');
      await Bun.sleep(250 * 2 ** attempt);
    }
  }
  throw new Error('identity_persistence_failed');
}

function recordFromResource(
  resource: z.infer<typeof configMapSchema>,
  config: OnPremConfig
): LedgerRecord {
  try {
    const value = resource.data?.['ledger.json'];
    if (!value || value.length > 524_288) throw new Error('ledger_invalid');
    const ledger = ledgerSchema.parse(JSON.parse(value) as unknown);
    if (
      ledger.organizationId !== config.organizationId ||
      ledger.installationId !== config.installationId ||
      resource.metadata.name !== ledgerName(ledger.allocationId) ||
      resource.metadata.namespace !== config.systemNamespace ||
      !isOwned(resource.metadata, config.installationId, 'ledger', ledger.allocationId) ||
      resource.metadata.deletionTimestamp
    )
      throw new Error('ledger_owner_mismatch');
    return { resource, ledger };
  } catch {
    throw new Error('ledger_invalid');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsTemplate(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item: unknown, index) => containsTemplate(actual[index], item))
    );
  if (isObject(expected))
    return (
      isObject(actual) &&
      Object.entries(expected).every(([key, value]) => containsTemplate(actual[key], value))
    );
  return actual === expected;
}

function onlyKeys(value: unknown, keys: string[]): boolean {
  return isObject(value) && Object.keys(value).every(key => keys.includes(key));
}

const bootstrapKeys = [
  'SANDBOX_CONTROL_URL',
  'SANDBOX_CONTROL_CREDENTIAL',
  'PROVIDER_INSTANCE_ID',
  'KILO_PLATFORM',
  'KILO_DISABLE_AUTOUPDATE',
  'KILO_DEBUG_SESSION_INGEST',
];

export function allocationPod(config: OnPremConfig, ledger: AllocationLedger) {
  if (!ledger.launch) throw new Error('launch_intent_missing');
  const env = bootstrapKeys.map(name => ({
    name,
    valueFrom: {
      secretKeyRef: { name: bootstrapName(ledger.allocationId), key: name, optional: false },
    },
  }));
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName(ledger.allocationId),
      namespace: config.sandboxNamespace,
      labels: ownedLabels(config.installationId, 'sandbox', ledger.allocationId),
      annotations: {
        'kilo.ai/launch-digest': ledger.launch.digest,
        'kilo.ai/policy-digest': ledger.launch.policyDigest,
      },
      finalizers: [TERMINATION_FINALIZER],
    },
    spec: {
      ...sandboxSpec(
        config,
        ledger.launch.activeDeadlineSeconds,
        [...env, ...fixedRuntimeEnv(config, ledger.launch.hardStopAt)],
        ['/usr/local/bin/kilo-onprem-entry']
      ),
      schedulingGates: [{ name: LAUNCH_GATE }],
    },
  };
}

function matchesSandboxSpec(pod: Pod, expected: ReturnType<typeof sandboxSpec>): boolean {
  if (!pod.metadata.finalizers?.includes(TERMINATION_FINALIZER)) return false;
  const fixed = {
    ...expected,
    activeDeadlineSeconds: pod.spec.activeDeadlineSeconds,
    schedulingGates: pod.spec.schedulingGates,
  };
  if (
    !containsTemplate(pod.spec, fixed) ||
    !pod.spec.activeDeadlineSeconds ||
    pod.spec.activeDeadlineSeconds > expected.activeDeadlineSeconds
  )
    return false;
  if (pod.spec.schedulingGates?.some(gate => gate.name !== LAUNCH_GATE)) return false;
  if (
    pod.spec.serviceAccount !== undefined &&
    pod.spec.serviceAccount !== expected.serviceAccountName
  )
    return false;
  if ((pod.spec.initContainers?.length ?? 0) > 0 || (pod.spec.ephemeralContainers?.length ?? 0) > 0)
    return false;
  if (
    !onlyKeys(pod.spec, [
      ...Object.keys(fixed),
      'nodeName',
      'serviceAccount',
      'schedulerName',
      'tolerations',
      'priority',
      'preemptionPolicy',
      'overhead',
      'os',
    ])
  )
    return false;
  const container = pod.spec.containers[0];
  const expectedContainer = expected.containers[0];
  if (
    !container ||
    !expectedContainer ||
    !onlyKeys(container, [
      ...Object.keys(expectedContainer),
      'terminationMessagePath',
      'terminationMessagePolicy',
    ])
  )
    return false;
  if (!onlyKeys(container.securityContext, Object.keys(expectedContainer.securityContext)))
    return false;
  const security = container.securityContext;
  if (!isObject(security) || !onlyKeys(security.capabilities, ['drop'])) return false;
  return onlyKeys(pod.spec.securityContext, [
    ...Object.keys(expected.securityContext),
    'fsGroupChangePolicy',
    'supplementalGroupsPolicy',
  ]);
}

export function matchesApprovedPod(
  config: OnPremConfig,
  ledger: AllocationLedger,
  pod: Pod
): boolean {
  if (
    !ledger.launch ||
    !isOwned(pod.metadata, config.installationId, 'sandbox', ledger.allocationId) ||
    pod.metadata.namespace !== config.sandboxNamespace ||
    pod.metadata.name !== podName(ledger.allocationId)
  )
    return false;
  if (ledger.pod && ledger.pod.uid !== pod.metadata.uid) return false;
  if (
    pod.metadata.annotations?.['kilo.ai/launch-digest'] !== ledger.launch.digest ||
    pod.metadata.annotations?.['kilo.ai/policy-digest'] !== ledger.launch.policyDigest
  )
    return false;
  return matchesSandboxSpec(pod, allocationPod(config, ledger).spec);
}

async function checkPermissions(kube: KubernetesClient, config: OnPremConfig): Promise<void> {
  const checks = [
    {
      group: 'node.k8s.io',
      resource: 'runtimeclasses',
      name: config.profile.runtimeClass,
      verbs: ['get'],
    },
    {
      namespace: config.systemNamespace,
      resource: 'secrets',
      name: IDENTITY_SECRET,
      verbs: ['get', 'update'],
    },
    {
      namespace: config.systemNamespace,
      resource: 'configmaps',
      verbs: ['get', 'list', 'create', 'update', 'delete'],
    },
    {
      namespace: config.systemNamespace,
      resource: 'services',
      name: BROKER_SERVICE,
      verbs: ['get'],
    },
    {
      namespace: config.sandboxNamespace,
      resource: 'pods',
      verbs: ['get', 'list', 'create', 'patch', 'delete'],
    },
    { namespace: config.sandboxNamespace, resource: 'secrets', verbs: ['get', 'create', 'delete'] },
    {
      namespace: config.sandboxNamespace,
      resource: 'configmaps',
      name: PUBLIC_CA_CONFIG_MAP,
      verbs: ['get'],
    },
  ];
  const reviewSchema = z.object({
    status: z.object({ allowed: z.boolean(), denied: z.boolean().optional() }),
  });
  for (const check of checks) {
    const { verbs, ...resourceAttributes } = check;
    for (const verb of verbs) {
      const review = await kube.create(
        '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
        {
          apiVersion: 'authorization.k8s.io/v1',
          kind: 'SelfSubjectAccessReview',
          spec: { resourceAttributes: { ...resourceAttributes, verb } },
        },
        reviewSchema
      );
      if (!review.status.allowed || review.status.denied) throw new Error('permissions_missing');
    }
  }
}

function probeScript(config: OnPremConfig): string {
  return `const fs = await import('node:fs');
if (process.getuid() !== 1000 || fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')) process.exit(10);
const cli = Bun.spawn(['/usr/local/bin/kilo', '--version'], { stdout: 'ignore', stderr: 'ignore', timeout: 10000 });
if (await cli.exited !== 0) process.exit(11);
const ca = fs.readFileSync(${JSON.stringify(CA_MOUNT_PATH)}, 'utf8');
const allowed = await fetch(${JSON.stringify(`${config.profile.brokerUrl}/healthz`)}, { tls: { ca, rejectUnauthorized: true }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
if (allowed.status !== 200) process.exit(12);
let reachable = false;
try { await fetch(${JSON.stringify(`http://${config.brokerClusterIp}:${DENIED_PROBE_PORT}/healthz`)}, { redirect: 'manual', signal: AbortSignal.timeout(2500) }); reachable = true; } catch {}
process.exit(reachable ? 13 : 0);`;
}

async function deniedEndpointIsReachable(config: OnPremConfig): Promise<boolean> {
  try {
    const response = await fetch(`http://${config.brokerClusterIp}:${DENIED_PROBE_PORT}/healthz`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    if (response.status !== 200) return false;
    const result = await readBoundedJson(response, 1024);
    return z
      .object({ probe: z.literal('kilo-onprem-network-control') })
      .strict()
      .safeParse(result).success;
  } catch {
    return false;
  }
}

async function runPreflight(config: OnPremConfig, signal: AbortSignal): Promise<Health> {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
  const kube = createKubernetesClient(boundedSignal);
  const deadline = Date.now() + 90_000;
  const path = namespacedPath(config.sandboxNamespace, 'pods', 'kilo-onprem-preflight');
  let probe: Pod | null = null;
  try {
    await checkPermissions(kube, config);
    const runtime = await kube.get(
      `/apis/node.k8s.io/v1/runtimeclasses/${encodeURIComponent(config.profile.runtimeClass)}`,
      z.object({ handler: z.literal('runsc') })
    );
    if (!runtime) return { ready: false, diagnosticCode: 'runtime_unavailable' };
    const service = await kube.get(
      namespacedPath(config.systemNamespace, 'services', BROKER_SERVICE),
      z.object({ spec: z.object({ clusterIP: z.ipv4() }) })
    );
    if (service?.spec.clusterIP !== config.brokerClusterIp)
      return { ready: false, diagnosticCode: 'broker_service_mismatch' };
    const ca = await kube.get(
      namespacedPath(config.sandboxNamespace, 'configmaps', PUBLIC_CA_CONFIG_MAP),
      configMapSchema
    );
    if (
      !ca ||
      !isOwned(ca.metadata, config.installationId, 'ca') ||
      ca.data?.['ca.crt'] !== (await readFile(config.tls.caFile, 'utf8'))
    )
      return { ready: false, diagnosticCode: 'broker_ca_mismatch' };
    if (!(await deniedEndpointIsReachable(config)))
      return { ready: false, diagnosticCode: 'network_control_unreachable' };
    probe = await kube.get(path, podSchema);
    if (probe) {
      if (!isOwned(probe.metadata, config.installationId, 'probe'))
        return { ready: false, diagnosticCode: 'probe_owner_mismatch' };
      await kube.remove(path, probe.metadata.uid);
      const stopped = await kube.get(path, podSchema);
      if (stopped?.metadata.uid === probe.metadata.uid && containersTerminated(stopped))
        await removeTerminationFinalizer(kube, stopped);
      return { ready: false, diagnosticCode: 'previous_probe_cleanup_pending' };
    }
    const expectedSpec = sandboxSpec(
      config,
      90,
      [{ name: 'NODE_EXTRA_CA_CERTS', value: CA_MOUNT_PATH }],
      ['/usr/local/bin/bun', '-e', probeScript(config)]
    );
    probe = await kube.create(
      namespacedPath(config.sandboxNamespace, 'pods'),
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: 'kilo-onprem-preflight',
          namespace: config.sandboxNamespace,
          labels: ownedLabels(config.installationId, 'probe'),
          finalizers: [TERMINATION_FINALIZER],
        },
        spec: expectedSpec,
      },
      podSchema
    );
    const uid = probe.metadata.uid;
    while (!signal.aborted && Date.now() < deadline) {
      const current = await kube.get(path, podSchema);
      if (
        !current ||
        current.metadata.uid !== uid ||
        !isOwned(current.metadata, config.installationId, 'probe') ||
        !matchesSandboxSpec(current, expectedSpec)
      )
        throw new Error('probe_identity_changed');
      probe = current;
      if (containersTerminated(current)) {
        const passed =
          current.status?.containerStatuses?.[0]?.state.terminated?.exitCode === 0 &&
          (await deniedEndpointIsReachable(config));
        await kube.remove(path, uid);
        const deleting = await kube.get(path, podSchema);
        if (deleting?.metadata.uid === uid && containersTerminated(deleting))
          await removeTerminationFinalizer(kube, deleting);
        return { ready: passed, diagnosticCode: passed ? null : 'runtime_policy_probe_failed' };
      }
      await Bun.sleep(1000);
    }
    if (probe) await kube.remove(path, probe.metadata.uid);
    return { ready: false, diagnosticCode: 'runtime_policy_probe_timeout' };
  } catch {
    if (probe && isOwned(probe.metadata, config.installationId, 'probe'))
      await kube.remove(path, probe.metadata.uid).catch(() => undefined);
    return { ready: false, diagnosticCode: 'runtime_policy_probe_failed' };
  }
}

export async function createProvisioner(
  config: OnPremConfig,
  revokeAllocation: (providerRef: string) => void
) {
  const kube = createKubernetesClient();
  const identity = await loadIdentity(kube, config);
  const records = new Map<string, LedgerRecord>();
  const retention = createLedgerRetention(kube, config);
  const nextReconcile = new Map<string, number>();
  const authorityDenied = new Set<string>();
  const hardStopTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let revoked = identityFlag(identity.secret, 'revoked');
  let enrolled = identityFlag(identity.secret, 'enrolled');
  let health: Health = { ready: false, diagnosticCode: 'preflight_pending' };
  let lastExchangeAt = 0;
  let retentionTime = 0;
  let stateHealthy = false;
  let shuttingDown = false;

  function revoke(ref: string) {
    authorityDenied.add(ref);
    revokeAllocation(ref);
  }

  function trackHardStop(ledger: AllocationLedger) {
    if (!ledger.launch || ledger.stop || hardStopTimers.has(ledger.allocationId)) return;
    const timer = setTimeout(
      () => {
        revoke(ledger.providerRef);
        void (async () => {
          const current = await readRecord(ledger.allocationId);
          if (current && !current.ledger.termination)
            await reconcileStop(await persistStop(current, 'lifetime_expired'));
        })().catch(() => {
          stateHealthy = false;
        });
      },
      Math.max(0, ledger.launch.hardStopAt - Date.now())
    );
    timer.unref();
    hardStopTimers.set(ledger.allocationId, timer);
  }

  async function markIdentity(key: 'enrolled' | 'revoked') {
    const current = await loadIdentity(kube, config);
    if (
      current.credential !== identity.credential ||
      current.secret.metadata.uid !== identity.secret.metadata.uid
    )
      throw new Error('identity_changed');
    if (!identityFlag(current.secret, key))
      await kube.replace(
        namespacedPath(config.systemNamespace, 'secrets', IDENTITY_SECRET),
        {
          ...current.secret,
          data: { ...current.secret.data, [key]: Buffer.from('true').toString('base64') },
        },
        secretSchema
      );
  }

  function forgetRecord(record: LedgerRecord) {
    const { allocationId, providerRef } = record.ledger;
    const timer = hardStopTimers.get(allocationId);
    if (timer) clearTimeout(timer);
    hardStopTimers.delete(allocationId);
    nextReconcile.delete(allocationId);
    authorityDenied.delete(providerRef);
    records.delete(allocationId);
    retention.forget(allocationId);
  }

  async function readRecord(
    allocationId: string,
    updateCache = true
  ): Promise<LedgerRecord | null> {
    const resource = await kube.get(
      namespacedPath(config.systemNamespace, 'configmaps', ledgerName(allocationId)),
      configMapSchema
    );
    const cached = records.get(allocationId);
    if (!resource) {
      if (cached) {
        if (!retention.isPending(cached)) throw new Error('ledger_missing');
        forgetRecord(cached);
      }
      return null;
    }
    if (cached && cached.resource.metadata.uid !== resource.metadata.uid)
      throw new Error('ledger_replaced');
    const record = recordFromResource(resource, config);
    if (updateCache) records.set(allocationId, record);
    return record;
  }

  async function save(
    record: LedgerRecord | null,
    ledger: AllocationLedger,
    updateCache = true
  ): Promise<LedgerRecord> {
    const parsed = ledgerSchema.safeParse(ledger);
    if (!parsed.success) throw new Error('ledger_write_invalid');
    if (record && JSON.stringify(record.ledger) === JSON.stringify(ledger)) return record;
    const body = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: record?.resource.metadata ?? {
        name: ledgerName(ledger.allocationId),
        namespace: config.systemNamespace,
        labels: ownedLabels(config.installationId, 'ledger', ledger.allocationId),
      },
      data: { 'ledger.json': JSON.stringify(ledger) },
    };
    const resource = record
      ? await kube.replace(
          namespacedPath(config.systemNamespace, 'configmaps', ledgerName(ledger.allocationId)),
          body,
          configMapSchema
        )
      : await kube.create(
          namespacedPath(config.systemNamespace, 'configmaps'),
          body,
          configMapSchema
        );
    const saved = recordFromResource(resource, config);
    if (JSON.stringify(saved.ledger) !== JSON.stringify(ledger))
      throw new Error('ledger_write_changed');
    if (updateCache) records.set(ledger.allocationId, saved);
    trackHardStop(ledger);
    return saved;
  }

  async function persistStop(record: LedgerRecord, reason: string): Promise<LedgerRecord> {
    revoke(record.ledger.providerRef);
    return save(record, requestStop(record.ledger, reason, Date.now()));
  }

  async function getOwnedPod(ledger: AllocationLedger): Promise<Pod | null> {
    const pod = await kube.get(
      namespacedPath(config.sandboxNamespace, 'pods', podName(ledger.allocationId)),
      podSchema
    );
    if (
      pod &&
      (!isOwned(pod.metadata, config.installationId, 'sandbox', ledger.allocationId) ||
        pod.metadata.namespace !== config.sandboxNamespace ||
        (ledger.pod && ledger.pod.uid !== pod.metadata.uid))
    )
      throw new Error('pod_identity_conflict');
    return pod;
  }

  async function cleanupBootstrap(ledger: AllocationLedger): Promise<void> {
    const path = namespacedPath(
      config.sandboxNamespace,
      'secrets',
      bootstrapName(ledger.allocationId)
    );
    const secret = await kube.get(path, secretSchema);
    if (!secret) return;
    if (
      !isOwned(secret.metadata, config.installationId, 'bootstrap', ledger.allocationId) ||
      (ledger.bootstrapUid && secret.metadata.uid !== ledger.bootstrapUid) ||
      !ledger.pod ||
      secret.metadata.annotations?.['kilo.ai/pod-uid'] !== ledger.pod.uid
    )
      throw new Error('bootstrap_identity_conflict');
    await kube.remove(path, secret.metadata.uid, 0);
  }

  async function reconcileStop(record: LedgerRecord): Promise<void> {
    let ledger = record.ledger;
    revoke(ledger.providerRef);
    let pod: Pod | null;
    try {
      pod = await getOwnedPod(ledger);
    } catch {
      await save(record, queueReport(ledger, 'unknown', Date.now(), 'pod_identity_conflict'));
      return;
    }
    if (pod && !ledger.pod) {
      if (
        !ledger.launch ||
        pod.metadata.annotations?.['kilo.ai/launch-digest'] !== ledger.launch.digest
      ) {
        await save(record, queueReport(ledger, 'unknown', Date.now(), 'pod_intent_unknown'));
        return;
      }
      ledger = pinPod(ledger, pod);
      record = await save(record, ledger);
    }
    if (pod && !pod.metadata.deletionTimestamp) {
      await kube.remove(
        namespacedPath(config.sandboxNamespace, 'pods', pod.metadata.name),
        pod.metadata.uid
      );
      pod = await getOwnedPod(ledger);
    }
    const evidence = terminationEvidence(ledger, pod);
    if (
      !evidence ||
      !Number.isFinite(evidence.observedAt) ||
      evidence.observedAt > Date.now() + ON_PREM_CLOCK_SKEW_MS
    ) {
      await save(
        record,
        queueReport(
          ledger,
          'unknown',
          Date.now(),
          pod ? 'termination_unconfirmed' : 'pod_absence_unconfirmed'
        )
      );
      return;
    }
    ledger = { ...ledger, termination: evidence };
    record = await save(record, queueReport(ledger, 'terminal', evidence.observedAt));
    if (pod) await removeTerminationFinalizer(kube, pod);
    await cleanupBootstrap(record.ledger);
    const [remainingPod, remainingSecret] = await Promise.all([
      getOwnedPod(record.ledger),
      kube.get(
        namespacedPath(config.sandboxNamespace, 'secrets', bootstrapName(ledger.allocationId)),
        secretSchema
      ),
    ]);
    if (!remainingPod && !remainingSecret)
      await save(record, { ...record.ledger, cleanupComplete: true });
  }

  async function reconcile(record: LedgerRecord): Promise<void> {
    const current = await readRecord(record.ledger.allocationId);
    if (!current) throw new Error('ledger_missing');
    record = current;
    let ledger = record.ledger;
    if (revoked || authorityDenied.has(ledger.providerRef))
      record = await persistStop(record, revoked ? 'installation_revoked' : 'authority_revoked');
    else if (ledger.launch && ledger.launch.hardStopAt <= Date.now())
      record = await persistStop(record, 'lifetime_expired');
    else if (ledger.launch && ledger.gate !== 'open' && ledger.launch.notAfter <= Date.now())
      record = await persistStop(record, 'launch_expired');
    else if (ledger.launch && ledger.launch.policyDigest !== policyDigest(config))
      record = await persistStop(record, 'profile_changed');
    ledger = record.ledger;
    if (ledger.stop) {
      await reconcileStop(record);
      return;
    }
    if (!ledger.createRequested) return;
    let pod: Pod | null;
    try {
      pod = await getOwnedPod(ledger);
      if (!pod) {
        record = await persistStop(record, 'pod_absence_unconfirmed');
        await save(
          record,
          queueReport(record.ledger, 'unknown', Date.now(), 'pod_absence_unconfirmed')
        );
        return;
      }
      if (
        !matchesApprovedPod(config, ledger, pod) ||
        !pod.metadata.finalizers?.includes(TERMINATION_FINALIZER)
      )
        throw new Error('pod_template_changed');
      if (!ledger.pod && (!hasLaunchGate(pod) || !neverScheduled(pod)))
        throw new Error('unregistered_pod_executed');
      ledger = pinPod(ledger, pod);
    } catch {
      await persistStop(record, 'pod_identity_conflict');
      return;
    }
    if (pod.metadata.deletionTimestamp || containersTerminated(pod)) {
      record = await save(record, ledger);
      record = await persistStop(record, 'pod_stopped');
      await reconcileStop(record);
      return;
    }
    if (!hasLaunchGate(pod)) {
      if (!ledger.registered || ledger.gate === 'closed') {
        await persistStop(await save(record, ledger), 'unexpected_gate_release');
        return;
      }
      ledger = { ...ledger, gate: 'open' };
    }
    const running = ledger.gate === 'open' && podIsRunning(pod);
    await save(
      record,
      queueReport(
        ledger,
        running ? 'active' : 'pending',
        Date.now(),
        running ? undefined : hasLaunchGate(pod) ? 'awaiting_registration' : 'pod_starting'
      )
    );
  }

  async function ensureBootstrap(
    record: LedgerRecord,
    operation: LaunchOperation
  ): Promise<LedgerRecord> {
    const ledger = record.ledger;
    if (!ledger.pod || !ledger.launch) throw new Error('pod_identity_missing');
    const bootstrap = approvedBootstrap(operation, config);
    const data = Object.fromEntries(
      Object.entries(bootstrap).map(([key, value]) => [key, Buffer.from(value).toString('base64')])
    );
    const name = bootstrapName(ledger.allocationId);
    const path = namespacedPath(config.sandboxNamespace, 'secrets', name);
    let secret = await kube.get(path, secretSchema);
    if (!secret) {
      if (ledger.bootstrapUid) throw new Error('bootstrap_missing');
      secret = await kube.create(
        namespacedPath(config.sandboxNamespace, 'secrets'),
        {
          apiVersion: 'v1',
          kind: 'Secret',
          type: 'Opaque',
          immutable: true,
          metadata: {
            name,
            namespace: config.sandboxNamespace,
            labels: ownedLabels(config.installationId, 'bootstrap', ledger.allocationId),
            annotations: {
              'kilo.ai/pod-uid': ledger.pod.uid,
              'kilo.ai/launch-digest': ledger.launch.digest,
            },
            ownerReferences: [
              {
                apiVersion: 'v1',
                kind: 'Pod',
                name: ledger.pod.name,
                uid: ledger.pod.uid,
                blockOwnerDeletion: false,
              },
            ],
          },
          data,
        },
        secretSchema
      );
    }
    if (
      !isOwned(secret.metadata, config.installationId, 'bootstrap', ledger.allocationId) ||
      secret.metadata.namespace !== config.sandboxNamespace ||
      secret.metadata.deletionTimestamp ||
      !secret.immutable ||
      secret.metadata.annotations?.['kilo.ai/pod-uid'] !== ledger.pod.uid ||
      secret.metadata.annotations?.['kilo.ai/launch-digest'] !== ledger.launch.digest ||
      secret.metadata.ownerReferences?.length !== 1 ||
      secret.metadata.ownerReferences[0]?.uid !== ledger.pod.uid ||
      secret.metadata.ownerReferences[0]?.name !== ledger.pod.name ||
      secret.metadata.ownerReferences[0]?.kind !== 'Pod' ||
      (ledger.bootstrapUid && ledger.bootstrapUid !== secret.metadata.uid) ||
      Object.keys(secret.data ?? {}).length !== Object.keys(data).length ||
      Object.entries(data).some(([key, value]) => secret.data?.[key] !== value)
    )
      throw new Error('bootstrap_identity_conflict');
    return save(record, { ...ledger, bootstrapUid: secret.metadata.uid });
  }

  async function handleLaunch(operation: LaunchOperation): Promise<void> {
    let record = await readRecord(operation.allocationId);
    let ledger = acceptOperation(record?.ledger ?? null, operation, config, Date.now());
    if (revoked || !health.ready || !stateHealthy || Date.now() - lastExchangeAt > 30_000)
      ledger = requestStop(
        ledger,
        revoked ? 'installation_revoked' : 'installation_not_ready',
        Date.now()
      );
    if (ledger.stop) revoke(ledger.providerRef);
    record = await save(record, ledger);
    if (ledger.stop) {
      await reconcileStop(record);
      return;
    }
    if (!ledger.launch || ledger.launch.digest !== operationDigest(operation))
      throw new Error('launch_identity_conflict');
    if (!ledger.createRequested) {
      const count = [...records.values()].filter(
        item => item.ledger.createRequested && !item.ledger.termination
      ).length;
      if (count >= config.resources.maxConcurrent) {
        await persistStop(record, 'capacity_exhausted');
        return;
      }
      const existingPod = await getOwnedPod(ledger);
      const existingSecret = await kube.get(
        namespacedPath(config.sandboxNamespace, 'secrets', bootstrapName(ledger.allocationId)),
        secretSchema
      );
      if (existingPod || existingSecret) {
        await persistStop(record, 'unexpected_native_resource');
        return;
      }
      record = await save(record, { ...ledger, createRequested: true });
      const pod = await kube.create(
        namespacedPath(config.sandboxNamespace, 'pods'),
        allocationPod(config, record.ledger),
        podSchema
      );
      if (!matchesApprovedPod(config, record.ledger, pod) || !neverScheduled(pod)) {
        await persistStop(record, 'pod_template_changed');
        return;
      }
      ledger = pinPod(record.ledger, pod);
      await save(record, queueReport(ledger, 'pending', Date.now(), 'awaiting_registration'));
      return;
    }
    if (!canOpenGate(ledger, config, Date.now())) return;
    const pod = await getOwnedPod(ledger);
    if (!pod || !matchesApprovedPod(config, ledger, pod) || pod.metadata.deletionTimestamp) {
      await persistStop(record, 'pod_identity_conflict');
      return;
    }
    if (!hasLaunchGate(pod)) {
      if (ledger.gate === 'closed') await persistStop(record, 'unexpected_gate_release');
      return;
    }
    record = await ensureBootstrap(record, operation);
    const fresh = await readRecord(ledger.allocationId);
    if (
      !fresh ||
      !canOpenGate(fresh.ledger, config, Date.now()) ||
      revoked ||
      authorityDenied.has(ledger.providerRef)
    )
      return;
    record = await save(fresh, { ...fresh.ledger, gate: 'opening' });
    const gated = await getOwnedPod(record.ledger);
    if (
      !gated ||
      !matchesApprovedPod(config, record.ledger, gated) ||
      gated.metadata.deletionTimestamp ||
      !canOpenGate(record.ledger, config, Date.now())
    ) {
      await persistStop(record, 'gate_release_unconfirmed');
      return;
    }
    if (!hasLaunchGate(gated)) return;
    const authorized = await readRecord(ledger.allocationId);
    if (
      !authorized ||
      authorized.resource.metadata.resourceVersion !== record.resource.metadata.resourceVersion ||
      !canOpenGate(authorized.ledger, config, Date.now()) ||
      revoked ||
      authorityDenied.has(ledger.providerRef)
    )
      return;
    const remaining = Math.min(
      gated.spec.activeDeadlineSeconds ?? 1,
      record.ledger.launch?.activeDeadlineSeconds ?? 1,
      Math.floor((operation.hardStopAt - Date.now()) / 1000)
    );
    if (remaining < 1) {
      await persistStop(record, 'lifetime_expired');
      return;
    }
    const opened = await kube.patch(
      namespacedPath(config.sandboxNamespace, 'pods', gated.metadata.name),
      [
        { op: 'test', path: '/metadata/uid', value: gated.metadata.uid },
        { op: 'test', path: '/metadata/resourceVersion', value: gated.metadata.resourceVersion },
        { op: 'test', path: '/spec/schedulingGates', value: [{ name: LAUNCH_GATE }] },
        { op: 'replace', path: '/spec/activeDeadlineSeconds', value: remaining },
        { op: 'remove', path: '/spec/schedulingGates' },
      ],
      podSchema
    );
    if (opened.metadata.uid !== record.ledger.pod?.uid || hasLaunchGate(opened))
      throw new Error('gate_release_unconfirmed');
    await save(record, { ...record.ledger, gate: 'open' });
  }

  async function handleDelivery(delivery: ExchangeDelivery): Promise<void> {
    const { response, sent } = delivery;
    lastExchangeAt = delivery.receivedAt;
    if (response.revoked) {
      revoked = true;
      health = { ready: false, diagnosticCode: 'installation_revoked' };
      for (const record of records.values()) revoke(record.ledger.providerRef);
      await markIdentity('revoked');
      for (const record of records.values())
        if (!record.ledger.stop) await persistStop(record, 'installation_revoked');
    }
    const stops = response.operations.filter(operation => operation.type === 'stop');
    for (const operation of stops) revoke(operation.providerRef);
    for (const operation of stops) {
      const record = await readRecord(operation.allocationId);
      const ledger = acceptOperation(record?.ledger ?? null, operation, config, Date.now());
      await save(
        record,
        ledger.termination ? queueReport(ledger, 'terminal', ledger.termination.observedAt) : ledger
      );
    }
    for (const record of records.values())
      if (record.ledger.stop && !record.ledger.termination) await reconcile(record);
    if (Math.abs(response.serverTime - delivery.receivedAt) > ON_PREM_CLOCK_SKEW_MS) {
      health = { ready: false, diagnosticCode: 'clock_skew' };
      return;
    }
    retentionTime = response.serverTime;
    const acknowledged = new Set(response.acknowledgedReportIds);
    for (const cached of records.values()) {
      if (!cached.ledger.reports.some(report => sent.has(report.id) && acknowledged.has(report.id)))
        continue;
      const record = await readRecord(cached.ledger.allocationId);
      if (record)
        await save(
          record,
          acknowledgeReports(
            record.ledger,
            acknowledged,
            sent,
            Math.max(Date.now(), response.serverTime)
          )
        );
    }
    if (revoked) return;
    for (const operation of response.operations)
      if (operation.type === 'launch') await handleLaunch(operation);
  }

  async function discover(): Promise<void> {
    const list = await listResources(
      kube,
      namespacedPath(config.systemNamespace, 'configmaps') +
        labelQuery(config.installationId, 'ledger'),
      configMapSchema,
      'ConfigMap'
    );
    const pods = await listResources(
      kube,
      namespacedPath(config.sandboxNamespace, 'pods') +
        labelQuery(config.installationId, 'sandbox'),
      podSchema,
      'Pod'
    );
    const discovered = list.map(resource => recordFromResource(resource, config));
    const found = new Set<string>();
    for (const record of discovered) {
      const cached = records.get(record.ledger.allocationId);
      if (cached && cached.resource.metadata.uid !== record.resource.metadata.uid)
        throw new Error('ledger_replaced');
      if (found.has(record.ledger.allocationId)) throw new Error('ledger_list_duplicate');
      found.add(record.ledger.allocationId);
    }
    const missing = [...records.values()].filter(record => !found.has(record.ledger.allocationId));
    if (missing.some(record => !retention.isPending(record))) throw new Error('ledger_missing');
    for (const record of missing) forgetRecord(record);
    for (const record of discovered) {
      records.set(record.ledger.allocationId, record);
      trackHardStop(record.ledger);
      if (record.ledger.stop) revoke(record.ledger.providerRef);
      if (await retention.retire(record, retentionTime)) forgetRecord(record);
    }
    for (const pod of pods) {
      const allocationId = pod.metadata.labels?.['kilo.ai/allocation'];
      if (
        !allocationId ||
        !z.uuid().safeParse(allocationId).success ||
        pod.metadata.name !== podName(allocationId)
      )
        throw new Error('orphan_pod_invalid');
      if (!records.has(allocationId)) {
        const existing = await readRecord(allocationId);
        if (existing) continue;
        const operation = {
          id: crypto.randomUUID(),
          type: 'stop',
          revision: 0,
          reason: 'orphaned_native_resource',
          allocationId,
          sandboxId: 'orphaned_native_resource',
          providerRef: encodeOnPremProviderRef({
            installationId: config.installationId,
            allocationId,
          }),
        } as const;
        revoke(operation.providerRef);
        const orphan = pinPod(
          requestStop(newLedger(operation, config), operation.reason, Date.now()),
          pod
        );
        await save(null, { ...orphan, gate: 'opening' });
      }
    }
  }

  async function resolveAllocation(peerIp: string): Promise<BrokerAllocation | null> {
    if (
      shuttingDown ||
      revoked ||
      !stateHealthy ||
      !health.ready ||
      Date.now() - lastExchangeAt > 30_000
    )
      return null;
    const ip = peerIp.startsWith('::ffff:') ? peerIp.slice(7) : peerIp;
    if (!z.ipv4().safeParse(ip).success) return null;
    try {
      const list = await kube.get(
        namespacedPath(config.sandboxNamespace, 'pods') +
          labelQuery(config.installationId, 'sandbox') +
          `&fieldSelector=${encodeURIComponent(`status.podIP=${ip}`)}`,
        resourceListSchema(podSchema, 'Pod')
      );
      if (list?.items.length !== 1) return null;
      const allocationId = list.items[0]?.metadata.labels?.['kilo.ai/allocation'];
      if (!allocationId || !z.uuid().safeParse(allocationId).success) return null;
      let record = await readRecord(allocationId, false);
      if (
        !record ||
        record.ledger.stop ||
        record.ledger.termination ||
        !record.ledger.launch ||
        record.ledger.launch.hardStopAt <= Date.now() ||
        record.ledger.gate !== 'open' ||
        !record.ledger.registered ||
        !record.ledger.pod ||
        (record.ledger.pod.ip && record.ledger.pod.ip !== ip)
      )
        return null;
      const pod = await getOwnedPod(record.ledger);
      if (
        !pod ||
        !matchesApprovedPod(config, record.ledger, pod) ||
        !podIsRunning(pod) ||
        pod.status?.podIP !== ip ||
        pod.metadata.uid !== record.ledger.pod.uid ||
        authorityDenied.has(record.ledger.providerRef) ||
        revoked
      )
        return null;
      if (!record.ledger.pod.ip) record = await save(record, pinPod(record.ledger, pod), false);
      const current = await readRecord(allocationId, false);
      if (
        !current?.ledger.launch ||
        current.ledger.stop ||
        current.ledger.launch.hardStopAt <= Date.now() ||
        current.ledger.pod?.ip !== ip ||
        current.ledger.pod.uid !== pod.metadata.uid ||
        revoked ||
        authorityDenied.has(current.ledger.providerRef)
      )
        return null;
      return {
        providerRef: current.ledger.providerRef,
        podUid: pod.metadata.uid,
        hardStopAt: current.ledger.launch.hardStopAt,
      };
    } catch {
      return null;
    }
  }

  async function resolveCredential(allocation: BrokerAllocation, request: OnPremCredentialRequest) {
    if (
      shuttingDown ||
      revoked ||
      authorityDenied.has(allocation.providerRef) ||
      allocation.hardStopAt <= Date.now()
    )
      return null;
    try {
      const candidate = [...records.values()].find(
        record =>
          record.ledger.providerRef === allocation.providerRef &&
          record.ledger.pod?.uid === allocation.podUid
      );
      if (!candidate) return null;
      const record = await readRecord(candidate.ledger.allocationId, false);
      const ip = record?.ledger.pod?.ip;
      if (!ip) return null;
      const fresh = await resolveAllocation(ip);
      if (
        !fresh ||
        fresh.providerRef !== allocation.providerRef ||
        fresh.podUid !== allocation.podUid
      )
        return null;
      const input = onPremCredentialResolveRequestSchema.parse({
        ...onPremCredentialRequestSchema.parse(request),
        providerRef: allocation.providerRef,
        podUid: allocation.podUid,
      });
      const resolution = await cloudPost(
        config,
        identity.credential,
        'credentials/resolve',
        input,
        onPremCredentialResolutionSchema
      );
      const current = await readRecord(candidate.ledger.allocationId, false);
      if (
        !current ||
        current.ledger.stop ||
        current.ledger.termination ||
        revoked ||
        authorityDenied.has(allocation.providerRef) ||
        resolution.expiresAt <= Date.now() ||
        resolution.expiresAt > allocation.hardStopAt
      )
        return null;
      return resolution;
    } catch {
      return null;
    }
  }

  async function run(signal: AbortSignal): Promise<void> {
    const mailbox: { delivery: ExchangeDelivery | null } = { delivery: null };
    let exchanging = false;
    let exchangeFailure = false;
    let nextExchangeAt = 0;
    let backoff = 1000;
    let nextDiscoveryAt = 0;
    let nextPreflightAt = 0;
    let preflight: Promise<void> | null = null;
    let managementTask: Promise<void> | null = null;
    function failedState() {
      stateHealthy = false;
      nextDiscoveryAt = Math.min(nextDiscoveryAt, Date.now() + 5000);
    }
    try {
      while (!signal.aborted) {
        if (mailbox.delivery) {
          const received = mailbox.delivery;
          mailbox.delivery = null;
          try {
            await handleDelivery(received);
          } catch {
            failedState();
          }
          nextExchangeAt = received.receivedAt + received.response.pollAfterMs;
          backoff = 1000;
        }
        if (Date.now() >= nextDiscoveryAt) {
          nextDiscoveryAt = Date.now() + 5000;
          try {
            await discover();
            stateHealthy = true;
            nextDiscoveryAt = Date.now() + 30_000;
          } catch {
            failedState();
          }
        }
        for (const record of records.values()) {
          if (
            record.ledger.cleanupComplete ||
            Date.now() < (nextReconcile.get(record.ledger.allocationId) ?? 0)
          )
            continue;
          nextReconcile.set(
            record.ledger.allocationId,
            Date.now() + (record.ledger.stop ? 10_000 : 1000)
          );
          try {
            await reconcile(record);
          } catch {
            failedState();
          }
        }
        if (!preflight && !revoked && stateHealthy && Date.now() >= nextPreflightAt) {
          preflight = runPreflight(config, signal)
            .then(result => {
              if (!revoked) health = result;
              nextPreflightAt = Date.now() + (result.ready ? 300_000 : 30_000);
            })
            .finally(() => {
              preflight = null;
            });
        }
        if (exchangeFailure) {
          exchangeFailure = false;
          nextExchangeAt =
            Date.now() + backoff + Math.floor(Math.random() * Math.min(1000, backoff / 4));
          backoff = Math.min(60_000, backoff * 2);
        }
        if (!exchanging && !mailbox.delivery && Date.now() >= nextExchangeAt) {
          exchanging = true;
          const reports = [...records.values()]
            .flatMap(record => record.ledger.reports)
            .sort((left, right) => left.observedAt - right.observedAt)
            .slice(0, ON_PREM_MAX_BATCH_SIZE);
          const request = onPremExchangeRequestSchema.parse({
            protocolVersion: ON_PREM_PROTOCOL_VERSION,
            runnerVersion: RUNNER_VERSION,
            instanceTypes: config.instanceTypes,
            ready: !revoked && stateHealthy && health.ready,
            diagnosticCode: revoked
              ? 'installation_revoked'
              : stateHealthy
                ? health.diagnosticCode
                : 'local_state_unavailable',
            reports,
          });
          managementTask = (async () => {
            if (!enrolled) {
              const bootstrap = (await readPrivateFile(config.bootstrapTokenFile, 1024)).trim();
              if (!/^[A-Za-z0-9_-]{32,512}$/.test(bootstrap))
                throw new Error('bootstrap_token_invalid');
              const response = await cloudPost(
                config,
                bootstrap,
                'enroll',
                {
                  protocolVersion: ON_PREM_PROTOCOL_VERSION,
                  credentialHash: sha256(identity.credential),
                  runnerVersion: RUNNER_VERSION,
                  profile: config.profile,
                },
                onPremEnrollResponseSchema
              );
              if (response.installationId !== config.installationId)
                throw new Error('enrollment_identity_mismatch');
              await markIdentity('enrolled');
              enrolled = true;
            }
            const response = await cloudPost(
              config,
              identity.credential,
              'exchange',
              request,
              onPremExchangeResponseSchema
            );
            if (response.revoked) {
              revoked = true;
              for (const record of records.values()) revoke(record.ledger.providerRef);
            }
            mailbox.delivery = {
              response,
              sent: new Set(reports.map(report => report.id)),
              receivedAt: Date.now(),
            };
          })()
            .catch(() => {
              exchangeFailure = true;
            })
            .finally(() => {
              exchanging = false;
            });
        }
        await Bun.sleep(1000);
      }
    } finally {
      shuttingDown = true;
      for (const timer of hardStopTimers.values()) clearTimeout(timer);
      for (const record of records.values()) revoke(record.ledger.providerRef);
      await Promise.allSettled([managementTask, preflight].filter(task => task !== null));
    }
  }

  return {
    run,
    resolveAllocation,
    resolveCredential,
    health: () => ({
      ready: !revoked && stateHealthy && health.ready && Date.now() - lastExchangeAt <= 30_000,
      diagnosticCode: revoked
        ? 'installation_revoked'
        : !stateHealthy
          ? 'local_state_unavailable'
          : Date.now() - lastExchangeAt > 30_000
            ? 'management_unavailable'
            : health.diagnosticCode,
    }),
  };
}
