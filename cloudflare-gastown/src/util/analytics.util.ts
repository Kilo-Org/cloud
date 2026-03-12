export type GastownEventName =
  | 'bead.created'
  | 'bead.status_changed'
  | 'bead.closed'
  | 'bead.failed'
  | 'agent.spawned'
  | 'agent.exited'
  | 'agent.dispatch_failed'
  | 'review.submitted'
  | 'review.completed'
  | 'review.failed'
  | 'convoy.created'
  | 'convoy.landed'
  | 'escalation.created'
  | 'escalation.acknowledged'
  | 'nudge.queued'
  | 'nudge.delivered'
  | 'container.cold_start'
  | 'container.oom'
  | 'review.queue_depth_alert'
  | 'escalation.rate_spike'
  | 'agent.restart_loop';

export type GastownEventData = {
  event: GastownEventName;
  townId?: string;
  rigId?: string;
  agentId?: string;
  beadId?: string;
  convoyId?: string;
  role?: string; // 'polecat' | 'refinery' | 'mayor'
  beadType?: string;
  durationMs?: number; // e.g. bead completion time
  value?: number; // generic numeric value
  label?: string; // extra string label
};

/**
 * Write a single event to Cloudflare Analytics Engine.
 * Safe to call in development (where the binding is absent) — silently no-ops.
 */
export function writeEvent(
  env: { GASTOWN_AE?: AnalyticsEngineDataset },
  data: GastownEventData
): void {
  if (!env.GASTOWN_AE) return;
  try {
    env.GASTOWN_AE.writeDataPoint({
      blobs: [
        data.event,
        data.townId ?? '',
        data.rigId ?? '',
        data.agentId ?? '',
        data.beadId ?? '',
        data.convoyId ?? '',
        data.role ?? '',
        data.beadType ?? '',
        data.label ?? '',
      ],
      doubles: [data.durationMs ?? 0, data.value ?? 0],
      indexes: [data.event],
    });
  } catch {
    // Best-effort — never throw from analytics
  }
}
