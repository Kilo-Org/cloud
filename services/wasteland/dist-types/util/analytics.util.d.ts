/**
 * Controller-level event names emitted from HTTP handlers.
 * Internal DO events use string literals directly.
 */
export type WastelandEventName = 'wasteland.created' | 'wasteland.deleted' | 'credential.stored' | 'credential.deleted' | 'member.added' | 'member.removed' | 'wanted.browse' | 'wanted.claim' | 'wanted.done' | 'wanted.post' | 'wanted.sync' | (string & {});
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
export declare function writeEvent(env: {
    WASTELAND_AE?: AnalyticsEngineDataset;
}, data: WastelandEventData): void;
