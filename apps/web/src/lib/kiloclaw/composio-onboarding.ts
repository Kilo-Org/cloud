import 'server-only';

import { eq } from 'drizzle-orm';
import { APP_URL } from '@/lib/constants';
import { encryptKiloClawSecret } from '@/lib/kiloclaw/encryption';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import {
  createComposioGoogleCalendarConnectLink,
  listComposioConnectedAccounts,
  type ComposioUserContextAuth,
} from '@/lib/kiloclaw/composio-client';
import {
  kiloclaw_composio_identities,
  kiloclaw_instances,
  type KiloClawComposioInstanceConfigSource,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';

import {
  ensureManagedComposioIdentity,
  getActiveManagedComposioIdentity,
  type DecryptedComposioIdentity,
  type ComposioOwnerScope,
} from '@/lib/kiloclaw/composio-identities';
import { workerInstanceId, type ActiveKiloClawInstance } from '@/lib/kiloclaw/instance-registry';

export type ComposioConnectionStatus = 'not_configured' | 'disconnected' | 'connected' | 'error';

export type ComposioSandboxConfigSource = KiloClawComposioInstanceConfigSource | null;

export type ProvisionComposioConfigToMark = { source: 'manual' | 'managed' } | null;

export function composioSecretsPatchSource(
  secrets: Record<string, string | null>
): 'upsert_manual' | 'clear' | 'none' {
  const touchedEntries = Object.entries(secrets).filter(
    ([key]) => key === 'composioUserApiKey' || key === 'composioOrg'
  );
  if (touchedEntries.length === 0) return 'none';
  if (touchedEntries.every(([, value]) => value === null)) return 'clear';
  if (touchedEntries.some(([, value]) => value !== null)) return 'upsert_manual';
  return 'none';
}

function composioUserContextAuth(
  identity: DecryptedComposioIdentity
): ComposioUserContextAuth | null {
  if (!identity.row.composio_project_id) return null;
  return {
    userApiKey: identity.userApiKey,
    orgId: identity.org,
    projectId: identity.row.composio_project_id,
  };
}

export function getComposioConnectCallbackUrl(params: {
  organizationId?: string;
  returnTo: string;
  popup?: boolean;
  attemptId?: string;
}): string {
  const url = new URL('/api/integrations/composio/callback', APP_URL);
  url.searchParams.set('returnTo', params.returnTo);
  if (params.organizationId) url.searchParams.set('organizationId', params.organizationId);
  if (params.popup) url.searchParams.set('popup', '1');
  if (params.attemptId) url.searchParams.set('attemptId', params.attemptId);
  return url.toString();
}

export async function markComposioInstanceConfig(params: {
  instanceId: string;
  source: KiloClawComposioInstanceConfigSource;
}): Promise<void> {
  await db
    .update(kiloclaw_instances)
    .set({ composio_config_source: params.source })
    .where(eq(kiloclaw_instances.id, params.instanceId));
}

export async function clearComposioInstanceConfig(instanceId: string): Promise<void> {
  await db
    .update(kiloclaw_instances)
    .set({ composio_config_source: null })
    .where(eq(kiloclaw_instances.id, instanceId));
}

export async function getComposioInstanceConfigSource(
  instanceId: string
): Promise<ComposioSandboxConfigSource> {
  const [row] = await db
    .select({ source: kiloclaw_instances.composio_config_source })
    .from(kiloclaw_instances)
    .where(eq(kiloclaw_instances.id, instanceId))
    .limit(1);
  return row?.source ?? null;
}

function hasComposioProvisionSecrets(secrets: Record<string, string> | undefined): boolean {
  return secrets?.composioUserApiKey !== undefined || secrets?.composioOrg !== undefined;
}

async function getReusableManagedComposioIdentityForProvision(params: {
  scope: ComposioOwnerScope;
  instanceId?: string | null;
}): Promise<Awaited<ReturnType<typeof getActiveManagedComposioIdentity>>> {
  const identity = await getActiveManagedComposioIdentity(params.scope);
  if (!identity) return null;

  if (params.instanceId) {
    const currentSource = await getComposioInstanceConfigSource(params.instanceId);
    if (currentSource === 'managed') return identity;
    return null;
  }

  return identity.row.google_calendar_connected_account_id ? identity : null;
}

export async function buildComposioProvisionSecrets(params: {
  scope: ComposioOwnerScope;
  instanceId?: string | null;
  secrets?: Record<string, string>;
}): Promise<{
  secrets?: Record<string, string>;
  configToMark: ProvisionComposioConfigToMark;
}> {
  if (hasComposioProvisionSecrets(params.secrets)) {
    return { secrets: params.secrets, configToMark: { source: 'manual' } };
  }

  const identity = await getReusableManagedComposioIdentityForProvision({
    scope: params.scope,
    instanceId: params.instanceId,
  });
  if (!identity) return { secrets: params.secrets, configToMark: null };

  return {
    secrets: {
      ...(params.secrets ?? {}),
      composioUserApiKey: identity.userApiKey,
      composioOrg: identity.org,
    },
    configToMark: { source: 'managed' },
  };
}

export async function completeManagedComposioGoogleCalendarConnection(params: {
  userId: string;
  instance: ActiveKiloClawInstance;
  scope: ComposioOwnerScope;
  connectedAccountId: string;
}): Promise<boolean> {
  const identity = await getActiveManagedComposioIdentity(params.scope);
  if (!identity) return false;
  const auth = composioUserContextAuth(identity);
  if (!auth) return false;

  const accounts = await listComposioConnectedAccounts({
    auth,
    userId: identity.consumerUserId,
  });
  const connected = accounts.some(
    account => account.id === params.connectedAccountId && account.status === 'ACTIVE'
  );
  if (!connected) return false;

  // Blocks callbacks after manual mode is recorded. The worker secret write
  // below is cross-service, so a manual save starting concurrently still races
  // until these writes share a common lock or transaction boundary.
  const sandboxConfigSource = await getComposioInstanceConfigSource(params.instance.id);
  if (sandboxConfigSource === 'manual') return false;

  const client = new KiloClawInternalClient();
  await client.patchSecrets(
    params.userId,
    {
      secrets: {
        composioUserApiKey: encryptKiloClawSecret(identity.userApiKey),
        composioOrg: encryptKiloClawSecret(identity.org),
      },
    },
    workerInstanceId(params.instance)
  );
  await db
    .update(kiloclaw_composio_identities)
    .set({ google_calendar_connected_account_id: params.connectedAccountId })
    .where(eq(kiloclaw_composio_identities.id, identity.row.id));
  await markComposioInstanceConfig({
    instanceId: params.instance.id,
    source: 'managed',
  });
  return true;
}

export async function createManagedComposioGoogleCalendarLink(params: {
  userId: string;
  instance: ActiveKiloClawInstance;
  scope: ComposioOwnerScope;
  organizationId?: string;
  returnTo: string;
  popup?: boolean;
  attemptId?: string;
}): Promise<{ redirectUrl: string; connectedAccountId: string }> {
  const identity = await ensureManagedComposioIdentity(params.scope);
  const auth = composioUserContextAuth(identity);
  if (!auth) {
    throw new Error('Managed Composio identity is missing project context');
  }

  return await createComposioGoogleCalendarConnectLink({
    auth,
    userId: identity.consumerUserId,
    callbackUrl: getComposioConnectCallbackUrl({
      organizationId: params.organizationId,
      returnTo: params.returnTo,
      popup: params.popup,
      attemptId: params.attemptId,
    }),
  });
}

export async function getManagedComposioGoogleCalendarStatus(params: {
  scope: ComposioOwnerScope;
  instance: ActiveKiloClawInstance | null;
  sandboxHasComposioSecrets: boolean;
}): Promise<{
  enabled: boolean;
  status: ComposioConnectionStatus;
  connectedAccountId: string | null;
  sandboxConfigSource: ComposioSandboxConfigSource;
}> {
  const sandboxConfigSource = params.instance
    ? await getComposioInstanceConfigSource(params.instance.id)
    : null;

  const identity = await getActiveManagedComposioIdentity(params.scope);
  if (!identity) {
    return { enabled: true, status: 'disconnected', connectedAccountId: null, sandboxConfigSource };
  }
  const knownConnectedAccountId = identity.row.google_calendar_connected_account_id;
  const auth = composioUserContextAuth(identity);
  if (!auth)
    return { enabled: true, status: 'error', connectedAccountId: null, sandboxConfigSource };

  try {
    const accounts = await listComposioConnectedAccounts({
      auth,
      userId: identity.consumerUserId,
    });
    const active = accounts.find(
      account =>
        account.status === 'ACTIVE' &&
        (!knownConnectedAccountId || account.id === knownConnectedAccountId)
    );
    if (active && params.sandboxHasComposioSecrets && sandboxConfigSource === 'managed') {
      return {
        enabled: true,
        status: 'connected',
        connectedAccountId: active.id,
        sandboxConfigSource,
      };
    }
    return { enabled: true, status: 'disconnected', connectedAccountId: null, sandboxConfigSource };
  } catch {
    return { enabled: true, status: 'error', connectedAccountId: null, sandboxConfigSource };
  }
}
