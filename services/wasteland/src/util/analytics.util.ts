/**
 * Controller-level event names emitted from HTTP handlers.
 * Internal DO events use string literals directly.
 */
export type WastelandEventName =
  | 'wasteland.created'
  | 'wasteland.deleted'
  | 'credential.stored'
  | 'credential.deleted'
  | 'member.added'
  | 'member.removed'
  | 'wanted.browse'
  | 'wanted.claim'
  | 'wanted.done'
  | 'wanted.post'
  | 'wanted.sync'
  // Controller-level events (HTTP) use string to avoid maintaining
  // a massive union — event names are derived from route patterns.
  | (string & {});

export type WastelandDelivery = 'http' | 'trpc' | 'internal' | 'billing';

export type WastelandEventData = {
  event: WastelandEventName;
  delivery?: WastelandDelivery;
  route?: string;
  error?: string;
  userId?: string;
  wastelandId?: string;
  memberId?: string;
  durationMs?: number;
  value?: number;
  label?: string;
};

/**
 * Write a single event to Cloudflare Analytics Engine.
 * Safe to call in development (where the binding is absent) — silently no-ops.
 */
export function writeEvent(
  env: { WASTELAND_AE?: AnalyticsEngineDataset },
  data: WastelandEventData
): void {
  if (!env.WASTELAND_AE) return;
  try {
    env.WASTELAND_AE.writeDataPoint({
      blobs: [
        data.event, // blob1
        data.userId ?? '', // blob2
        data.delivery ?? '', // blob3
        data.route ?? '', // blob4
        data.error ?? '', // blob5
        data.wastelandId ?? '', // blob6
        data.memberId ?? '', // blob7
        data.label ?? '', // blob8
      ],
      doubles: [
        data.durationMs ?? 0, // double1
        data.value ?? 0, // double2
      ],
      indexes: [data.event],
    });
  } catch {
    // Best-effort — never throw from analytics
  }
}
