import { getWorkerDb } from '@kilocode/db';
import type { AppEnv } from '../types';
import {
  bootstrapProvisionSubscriptionWithDb,
  type BootstrapProvisionInput,
} from '../../../kiloclaw-billing/src/provision-bootstrap-shared.js';

const PLATFORM_BOOTSTRAP_ACTOR = {
  actorType: 'system',
  actorId: 'kiloclaw-platform-bootstrap',
} as const;

export class BootstrapProvisionFallbackError extends Error {
  rpcError: unknown;
  fallbackError: unknown;

  constructor(params: { rpcError: unknown; fallbackError: unknown }) {
    const fallbackMessage =
      params.fallbackError instanceof Error
        ? params.fallbackError.message
        : String(params.fallbackError);
    super(fallbackMessage);
    this.name = 'BootstrapProvisionFallbackError';
    this.rpcError = params.rpcError;
    this.fallbackError = params.fallbackError;
  }
}

export async function bootstrapProvisionedSubscriptionViaRpc(params: {
  env: AppEnv['Bindings'];
  input: BootstrapProvisionInput;
}) {
  if (!params.env.KILOCLAW_BILLING) {
    throw new Error('KILOCLAW_BILLING service binding is not configured');
  }

  return await params.env.KILOCLAW_BILLING.bootstrapProvisionSubscription({
    userId: params.input.userId,
    instanceId: params.input.instanceId,
    orgId: params.input.orgId,
  });
}

export async function bootstrapProvisionedSubscriptionLocally(params: {
  env: AppEnv['Bindings'];
  input: BootstrapProvisionInput;
}) {
  const connectionString = params.env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    throw new Error('HYPERDRIVE is not configured');
  }

  const db = getWorkerDb(connectionString);
  const subscription = await bootstrapProvisionSubscriptionWithDb({
    db,
    input: params.input,
    actor: PLATFORM_BOOTSTRAP_ACTOR,
    onChangeLogError: ({ subscriptionId, action, reason, error }) => {
      console.error('[platform] Failed to write local bootstrap change log', {
        subscriptionId,
        action,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  return { subscriptionId: subscription.id };
}

export async function bootstrapProvisionedSubscriptionWithFallback(params: {
  env: AppEnv['Bindings'];
  input: BootstrapProvisionInput;
}) {
  try {
    const result = await bootstrapProvisionedSubscriptionViaRpc(params);
    return { ...result, mode: 'rpc' as const };
  } catch (rpcError) {
    console.error('[platform] Subscription bootstrap RPC failed; attempting local fallback', {
      userId: params.input.userId,
      instanceId: params.input.instanceId,
      orgId: params.input.orgId,
      error: rpcError instanceof Error ? rpcError.message : String(rpcError),
    });

    try {
      const result = await bootstrapProvisionedSubscriptionLocally(params);
      return { ...result, mode: 'local_fallback' as const };
    } catch (fallbackError) {
      throw new BootstrapProvisionFallbackError({ rpcError, fallbackError });
    }
  }
}
