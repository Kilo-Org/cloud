import type { SandboxStatusSnapshot } from './sandbox-status.js';

export type WorkspaceBillingPayer = { type: 'user' | 'org'; id: string };
export type WorkspaceBillingActor = { type: 'user' | 'bot'; id: string };

/**
 * Read-only billing state of a workspace's compute allocation. It is produced
 * from stored sandbox state: reading it never admits work, starts a container
 * or opens a billing interval.
 */
export type WorkspaceBillingProjection = {
  payer: WorkspaceBillingPayer | null;
  actor: WorkspaceBillingActor | null;
  onBehalfOf: WorkspaceBillingPayer | null;
  /** The workspace's one metered SKU, or null when the provider has none. */
  sku: string | null;
  blocked: boolean | null;
  enforcementRequested: boolean;
  /** Start of the currently open metered interval, if any. */
  intervalStartedAt: number | null;
  /**
   * Internal meter instance key used to recover the last metered SKU while the
   * workspace sleeps. Never projected to a client.
   */
  meterInstanceId: string | null;
};

export type WorkspaceRuntimeStatus = {
  sandbox: SandboxStatusSnapshot;
  billing: WorkspaceBillingProjection | null;
};
