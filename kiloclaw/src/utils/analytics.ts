/**
 * Cloudflare Analytics Engine instrumentation for KiloClaw.
 *
 * Single dataset (kiloclaw_events) receives events from three layers:
 * HTTP route handlers, DO lifecycle operations, and reconciliation
 * corrective actions.
 *
 * Blob layout:
 *   blob1  = event name
 *   blob2  = userId
 *   blob3  = delivery ('http' | 'do' | 'reconcile')
 *   blob4  = route (HTTP route pattern, empty for DO/reconcile)
 *   blob5  = error (error message or HTTP status >= 400)
 *   blob6  = flyAppName
 *   blob7  = flyMachineId
 *   blob8  = sandboxId
 *   blob9  = instance status at time of event
 *   blob10 = openclawVersion
 *   blob11 = imageTag (trackedImageTag)
 *   blob12 = flyRegion
 *   blob13 = label (free-form, e.g. reconcile sub-action)
 *
 *   double1 = durationMs (operation wall-clock time)
 *   double2 = value (generic numeric, e.g. machine uptime)
 *
 *   index1  = event name (same as blob1, for fast SQL filtering)
 */

/**
 * Known event names. The open `(string & {})` allows arbitrary HTTP-derived
 * event names while preserving autocomplete for known events.
 */
export type KiloClawEventName =
  // DO lifecycle (emitted from index.ts via emitEvent)
  | 'instance.provisioned'
  | 'instance.started'
  | 'instance.provisioning_failed'
  | 'instance.start_capacity_recovery'
  | 'instance.manual_start_succeeded'
  | 'instance.manual_start_failed'
  | 'instance.crash_recovery_succeeded'
  | 'instance.crash_recovery_failed'
  | 'instance.stopped'
  | 'instance.restarting'
  | 'instance.destroy_started'
  // Snapshot restore events (emitted from DO and queue worker)
  | 'instance.restore_enqueued'
  | 'instance.restore_started'
  | 'instance.restore_completed'
  | 'instance.restore_retry_scheduled'
  | 'instance.restore_failed'
  // Reconcile events (emitted via ReconcileContext.log as `reconcile.{action}`)
  // All reconcileLog actions are automatically prefixed — see log.ts.
  | 'reconcile.sync_status'
  | 'reconcile.sync_status_failed'
  | 'reconcile.mark_stopped'
  | 'reconcile.replace_lost_volume'
  | 'reconcile.recover_machine_from_metadata'
  | 'reconcile.api_key_refreshed'
  | 'reconcile.auto_destroy_stale_provision'
  | 'reconcile.repair_mount'
  | 'reconcile.recover_bound_machine_for_destroy'
  | 'reconcile.restart_self_healed'
  | 'reconcile.destroy_complete'
  // Region capacity management
  | 'region.capacity_eviction'
  // HTTP-derived (open string) and additional reconcile.* events
  | (string & {});

export type KiloClawDelivery = 'http' | 'do' | 'reconcile' | 'queue';

export type KiloClawEventData = {
  event: KiloClawEventName;
  delivery?: KiloClawDelivery;
  route?: string;
  error?: string;
  userId?: string;
  sandboxId?: string;
  flyAppName?: string;
  flyMachineId?: string;
  status?: string;
  openclawVersion?: string;
  imageTag?: string;
  flyRegion?: string;
  label?: string;
  durationMs?: number;
  value?: number;
  instanceId?: string;
  channelId?: string;
};

/**
 * Write a single event to Cloudflare Analytics Engine.
 * Safe to call when the binding is absent (dev) — silently no-ops.
 * Best-effort: never throws.
 */
export function writeEvent(
  env: { KILOCLAW_AE?: AnalyticsEngineDataset },
  data: KiloClawEventData
): void {
  if (!env.KILOCLAW_AE) return;
  try {
    env.KILOCLAW_AE.writeDataPoint({
      blobs: [
        data.event, // blob1
        data.userId ?? '', // blob2
        data.delivery ?? '', // blob3
        data.route ?? '', // blob4
        data.error ?? '', // blob5
        data.flyAppName ?? '', // blob6
        data.flyMachineId ?? '', // blob7
        data.sandboxId ?? '', // blob8
        data.status ?? '', // blob9
        data.openclawVersion ?? '', // blob10
        data.imageTag ?? '', // blob11
        data.flyRegion ?? '', // blob12
        data.label ?? '', // blob13
      ],
      doubles: [data.durationMs ?? 0, data.value ?? 0],
      indexes: [data.event],
    });
  } catch {
    // Best-effort — never throw from analytics
  }
}

/**
 * Structural type for extracting event context from DO mutable state.
 * Uses a structural type rather than importing InstanceMutableState
 * to avoid circular dependencies between analytics and DO modules.
 */
export type EventContextSource = {
  userId: string | null;
  sandboxId: string | null;
  flyAppName: string | null;
  flyMachineId: string | null;
  status: string | null;
  openclawVersion: string | null;
  trackedImageTag: string | null;
  flyRegion: string | null;
};

/**
 * Extract common event dimensions from DO state. Used by reconcile.ts
 * and other extracted modules that receive state as a parameter.
 */
export function eventContextFromState(state: EventContextSource): Partial<KiloClawEventData> {
  return {
    userId: state.userId ?? undefined,
    sandboxId: state.sandboxId ?? undefined,
    flyAppName: state.flyAppName ?? undefined,
    flyMachineId: state.flyMachineId ?? undefined,
    status: state.status ?? undefined,
    openclawVersion: state.openclawVersion ?? undefined,
    imageTag: state.trackedImageTag ?? undefined,
    flyRegion: state.flyRegion ?? undefined,
  };
}
