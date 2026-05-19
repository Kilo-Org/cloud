import 'server-only';

import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { APP_URL } from '@/lib/constants';
import { encryptKiloClawSecret } from '@/lib/kiloclaw/encryption';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import {
  createComposioGoogleCalendarConnectLink,
  listComposioConnectedAccounts,
} from '@/lib/kiloclaw/composio-client';
import {
  kiloclaw_composio_instance_configs,
  type KiloClawComposioInstanceConfigSource,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';

import {
  ensureManagedComposioIdentity,
  getActiveManagedComposioIdentity,
  type ComposioOwnerScope,
} from '@/lib/kiloclaw/composio-identities';
import type { ActiveKiloClawInstance } from '@/lib/kiloclaw/instance-registry';

export type ComposioConnectionStatus = 'not_configured' | 'disconnected' | 'connected' | 'error';

export type ComposioSandboxConfigSource = KiloClawComposioInstanceConfigSource | null;

export function getComposioConnectCallbackUrl(params: {
  organizationId?: string;
  returnTo: string;
}): string {
  const url = new URL('/api/integrations/composio/callback', APP_URL);
  url.searchParams.set('returnTo', params.returnTo);
  if (params.organizationId) url.searchParams.set('organizationId', params.organizationId);
  return url.toString();
}

export async function applyManagedComposioCredentials(params: {
  userId: string;
  instance: ActiveKiloClawInstance;
  scope: ComposioOwnerScope;
}): Promise<void> {
  const identity = await ensureManagedComposioIdentity(params.scope);
  const client = new KiloClawInternalClient();
  await client.patchSecrets(
    params.userId,
    {
      secrets: {
        composioUserApiKey: encryptKiloClawSecret(identity.userApiKey),
        composioOrg: encryptKiloClawSecret(identity.org),
      },
    },
    params.instance.id
  );
  await markComposioInstanceConfig({
    instanceId: params.instance.id,
    source: 'managed',
    composioIdentityId: identity.row.id,
  });
}

export async function markComposioInstanceConfig(params: {
  instanceId: string;
  source: 'manual';
}): Promise<void>;
export async function markComposioInstanceConfig(params: {
  instanceId: string;
  source: 'managed';
  composioIdentityId: string;
}): Promise<void>;
export async function markComposioInstanceConfig(params: {
  instanceId: string;
  source: KiloClawComposioInstanceConfigSource;
  composioIdentityId?: string;
}): Promise<void> {
  await db
    .insert(kiloclaw_composio_instance_configs)
    .values({
      instance_id: params.instanceId,
      source: params.source,
      composio_identity_id: params.source === 'managed' ? params.composioIdentityId : null,
    })
    .onConflictDoUpdate({
      target: kiloclaw_composio_instance_configs.instance_id,
      set: {
        source: params.source,
        composio_identity_id: params.source === 'managed' ? params.composioIdentityId : null,
        updated_at: new Date().toISOString(),
      },
    });
}

export async function clearComposioInstanceConfig(instanceId: string): Promise<void> {
  await db
    .delete(kiloclaw_composio_instance_configs)
    .where(eq(kiloclaw_composio_instance_configs.instance_id, instanceId));
}

export async function getComposioInstanceConfigSource(
  instanceId: string
): Promise<ComposioSandboxConfigSource> {
  const [row] = await db
    .select({ source: kiloclaw_composio_instance_configs.source })
    .from(kiloclaw_composio_instance_configs)
    .where(eq(kiloclaw_composio_instance_configs.instance_id, instanceId))
    .limit(1);
  return row?.source ?? null;
}

export async function completeManagedComposioGoogleCalendarConnection(params: {
  userId: string;
  instance: ActiveKiloClawInstance;
  scope: ComposioOwnerScope;
  connectedAccountId: string;
}): Promise<boolean> {
  const identity = await getActiveManagedComposioIdentity(params.scope);
  if (!identity?.apiKey) return false;

  const accounts = await listComposioConnectedAccounts({
    apiKey: identity.apiKey,
    userId: identity.consumerUserId,
  });
  const connected = accounts.some(
    account => account.id === params.connectedAccountId && account.status === 'ACTIVE'
  );
  if (!connected) return false;

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
    params.instance.id
  );
  await markComposioInstanceConfig({
    instanceId: params.instance.id,
    source: 'managed',
    composioIdentityId: identity.row.id,
  });
  return true;
}

export async function createManagedComposioGoogleCalendarLink(params: {
  userId: string;
  instance: ActiveKiloClawInstance;
  scope: ComposioOwnerScope;
  organizationId?: string;
  returnTo: string;
}): Promise<{ redirectUrl: string; connectedAccountId: string }> {
  const identity = await ensureManagedComposioIdentity(params.scope);
  if (!identity.apiKey) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Managed Composio identity is missing an API key',
    });
  }

  return await createComposioGoogleCalendarConnectLink({
    apiKey: identity.apiKey,
    userId: identity.consumerUserId,
    callbackUrl: getComposioConnectCallbackUrl({
      organizationId: params.organizationId,
      returnTo: params.returnTo,
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
  if (!identity?.apiKey) {
    return { enabled: true, status: 'disconnected', connectedAccountId: null, sandboxConfigSource };
  }

  try {
    const accounts = await listComposioConnectedAccounts({
      apiKey: identity.apiKey,
      userId: identity.consumerUserId,
    });
    const active = accounts.find(account => account.status === 'ACTIVE');
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
