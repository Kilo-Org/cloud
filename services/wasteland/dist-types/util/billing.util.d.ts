export type BillableEvent = 'billing.wasteland_created' | 'billing.wasteland_deleted' | 'billing.api_operation' | 'billing.credential_stored' | 'billing.credential_deleted' | 'billing.member_added' | 'billing.member_removed';
/**
 * Categorises the API operation for metering granularity.
 * Write operations (mutations that modify DoltHub state) are metered
 * individually; reads are not metered today.
 */
export type BillingOperationKind = 'claim' | 'done' | 'post' | 'config_update' | 'member_update';
type BillingEnv = {
    WASTELAND_AE?: AnalyticsEngineDataset;
};
type MeterEventInput = {
    event: BillableEvent;
    userId: string;
    wastelandId: string;
    /** Free-form label for sub-categorisation (e.g. operation kind). */
    label?: string;
    /** Numeric value associated with the event (e.g. member count). */
    value?: number;
};
/**
 * Record a billable event in the Analytics Engine.
 *
 * Uses `delivery: 'billing'` so billing-specific queries can filter on
 * the delivery channel without scanning the full event stream.
 *
 * Best-effort — never throws.
 */
export declare function meterEvent(env: BillingEnv, input: MeterEventInput): void;
export {};
