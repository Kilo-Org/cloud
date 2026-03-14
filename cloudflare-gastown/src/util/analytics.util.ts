/**
 * Controller-level event names emitted from HTTP/tRPC handlers.
 * Internal DO events (bead lifecycle, agent dispatch) use `GastownInternalEventName`.
 */
export type GastownEventName =
  // DO-internal lifecycle events
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
  // Controller-level events (HTTP + tRPC) use string to avoid maintaining
  // a massive union — event names are derived from route patterns.
  | (string & {});

export type GastownDelivery = 'http' | 'trpc' | 'internal';

export type GastownEventData = {
  event: GastownEventName;
  delivery?: GastownDelivery;
  route?: string;
  error?: string;
  userId?: string;
  townId?: string;
  rigId?: string;
  agentId?: string;
  beadId?: string;
  convoyId?: string;
  role?: string; // 'polecat' | 'refinery' | 'mayor'
  beadType?: string;
  durationMs?: number;
  value?: number;
  label?: string;
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
        data.event, // blob1
        data.userId ?? '', // blob2
        data.delivery ?? '', // blob3
        data.route ?? '', // blob4
        data.error ?? '', // blob5
        data.townId ?? '', // blob6
        data.rigId ?? '', // blob7
        data.agentId ?? '', // blob8
        data.beadId ?? '', // blob9
        data.label ?? '', // blob10
        data.convoyId ?? '', // blob11
        data.role ?? '', // blob12
        data.beadType ?? '', // blob13
      ],
      doubles: [data.durationMs ?? 0, data.value ?? 0],
      indexes: [data.event],
    });
  } catch {
    // Best-effort — never throw from analytics
  }
}
