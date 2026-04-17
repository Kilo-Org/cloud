/**
 * RPC method types for the KILOCLAW_BILLING service binding.
 *
 * `wrangler types` only sees `Fetcher` for service bindings; the actual RPC
 * shape comes from the kiloclaw-billing worker's WorkerEntrypoint and is
 * declared here so the generated file can be freely regenerated.
 *
 * Keep in sync with: services/kiloclaw-billing/src/index.ts (KiloClawBillingService).
 */

export type BootstrapProvisionSubscriptionParams = {
  userId: string;
  instanceId: string;
  orgId?: string | null;
};

export type BootstrapProvisionSubscriptionResult = {
  subscriptionId: string;
};

export type KiloClawBillingBinding = Fetcher & {
  bootstrapProvisionSubscription(
    params: BootstrapProvisionSubscriptionParams
  ): Promise<BootstrapProvisionSubscriptionResult>;
};
