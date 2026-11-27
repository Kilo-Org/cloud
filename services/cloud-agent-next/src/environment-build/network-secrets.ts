import type { NetworkSecrets } from '@kilocode/worker-utils/network-secrets';
import type { EnvironmentBuildInput as ProfileBuildInput } from '@kilocode/cloud-agent-profile';
import {
  mintNetworkSecretGrants,
  networkSecretEnvironment,
  networkSecretGrantsSchema,
  networkSecretInfrastructureUrls,
} from '../network-secrets/grants.js';
import { builderNetworkSecretScope } from '../network-secrets/builder-scope.js';
import {
  admitNetworkSecretCredential,
  type NetworkSecretAuthority,
} from '../network-secrets/admission.js';
import type { CredentialAdmissionContext } from '../sandbox-control/credential-admission.js';
import { encodeCloudflareProviderRef } from '../sandbox-control/provider-ref.js';
import type { Env } from '../types.js';
import { readCloudAgentNextSecret } from '../secrets.js';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import type { NetworkSecretResolution } from '../network-secrets/contract.js';
import type { EnvironmentBuildTarget } from './target.js';
import { parseBuildInput, type BuildRow, type BuildStore } from './store.js';

export function networkSecretBuildRejection(
  secrets: NetworkSecrets | undefined,
  target: EnvironmentBuildTarget
): 'network_secrets_require_cloudflare' | null {
  return Object.keys(secrets ?? {}).length > 0 && target.provider !== 'cloudflare-containers'
    ? 'network_secrets_require_cloudflare'
    : null;
}

export function buildNetworkSecretGrants(
  environmentId: string,
  input: ProfileBuildInput,
  target: EnvironmentBuildTarget,
  excludedUrls: () => readonly string[]
): string | null {
  if (Object.keys(input.networkSecrets ?? {}).length === 0) return null;
  if (networkSecretBuildRejection(input.networkSecrets, target))
    throw new Error('Network secrets require a Cloudflare builder');
  const repositories = input.reference.repositories ?? [];
  const gitlabUrls = repositories.flatMap(repository =>
    repository.identity.platform === 'gitlab' ? [repository.identity.cloneUrl] : []
  );
  if (input.reference.repository?.platform === 'gitlab')
    gitlabUrls.push(input.reference.repository.cloneUrl);
  const grants = mintNetworkSecretGrants(
    builderNetworkSecretScope(environmentId),
    input.networkSecrets,
    [...excludedUrls(), ...gitlabUrls]
  );
  return JSON.stringify(grants);
}

export function readBuildNetworkSecretGrants(build: Pick<BuildRow, 'network_secret_grants'>) {
  return build.network_secret_grants == null
    ? []
    : networkSecretGrantsSchema.parse(JSON.parse(build.network_secret_grants));
}

export function buildNetworkSecretEnvironment(
  build: Pick<BuildRow, 'network_secret_grants'>
): Record<string, string> {
  return networkSecretEnvironment(readBuildNetworkSecretGrants(build));
}

function readAdmissionContext(input: {
  store: Pick<BuildStore, 'environment' | 'activeBuild'>;
  environmentId: string;
  physicalSandboxId: string;
  containerId: string;
  now: number;
}): CredentialAdmissionContext<NetworkSecretAuthority> {
  const scope = builderNetworkSecretScope(input.environmentId);
  const context: CredentialAdmissionContext<NetworkSecretAuthority> = {
    sandboxId: scope,
    ownerId: null,
    provider: 'cloudflare-containers',
    containmentEnabled: true,
    allocation: { kind: 'stopped', allocationId: null, providerRef: null },
    outboundContainerId: input.containerId,
    grants: [],
    liveSessionIds: [],
    identityBinding: '',
    available: false,
  };
  const environment = input.store.environment();
  if (environment?.environmentId !== input.environmentId || environment.deletedAt !== null)
    return context;
  const build = input.store.activeBuild();
  if (
    !build ||
    build.state !== 'preparing' ||
    !build.allocation_id ||
    build.deadline_at <= input.now
  )
    return context;
  const record = parseBuildInput(build);
  if (record.target?.provider === 'vercel') return context;
  const networkSecrets = readBuildNetworkSecretGrants(build);
  if (networkSecrets.length === 0) return context;
  const orgId =
    record.reference.owner.type === 'organization' ? record.reference.owner.id : undefined;
  return {
    ...context,
    ownerId: build.actor_user_id,
    available: true,
    identityBinding: build.id,
    ...(orgId ? { organizationId: orgId } : {}),
    allocation: {
      kind: 'connected',
      allocationId: build.allocation_id,
      providerRef: encodeCloudflareProviderRef({
        sandboxId: input.physicalSandboxId,
        containment: false,
        instanceId: build.allocation_id,
      }),
    },
    liveSessionIds: [build.id],
    grants: [
      {
        userId: build.actor_user_id,
        ...(orgId ? { orgId } : {}),
        sandboxId: scope,
        provider: 'cloudflare-containers',
        outboundContainerId: input.containerId,
        preparedAt: build.created_at,
        expiresAt: build.deadline_at,
        members: [{ sessionId: build.id }],
        networkSecrets,
      },
    ],
  };
}

export async function resolveBuilderNetworkSecret(input: {
  env: Env;
  /** The invocation's context, for a secret read's bundle revalidation. */
  ctx?: SecretsExecutionContext;
  store: Pick<BuildStore, 'environment' | 'activeBuild'>;
  environmentId: string;
  physicalSandboxId: string;
  request: { credential: string; outboundContainerId: string; url: string; method: string };
  now?: () => number;
}): Promise<NetworkSecretResolution | null> {
  const containerId = input.env.SANDBOX_CONTAINERS.idFromName(input.physicalSandboxId).toString();
  // A missing key stays optional: a build with no encrypted secrets needs none.
  const privateKey = await readCloudAgentNextSecret(
    input.env,
    'AGENT_ENV_VARS_PRIVATE_KEY',
    input.ctx
  ).catch(() => undefined);
  return admitNetworkSecretCredential(
    input.request.credential,
    {
      serial: operation => operation(),
      readContext: async () =>
        readAdmissionContext({ ...input, containerId, now: (input.now ?? Date.now)() }),
      authenticate: async context =>
        context.outboundContainerId === input.request.outboundContainerId
          ? { ok: true, isCurrent: () => true }
          : { ok: false, status: 403, code: 'invalid_identity' },
      grantAdmitted: () => true,
      now: input.now,
    },
    privateKey,
    networkSecretInfrastructureUrls(input.env),
    input.request.url
  );
}
