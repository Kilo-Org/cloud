import {
  AdminSlackNotificationError,
  type AdminSlackNotification,
} from '@/lib/slack/admin-notifications';
import { assertServiceFeeAuditReadOnly } from '@/lib/service-fees/read-only';

export { assertServiceFeeAuditReadOnly } from '@/lib/service-fees/read-only';

export const SERVICE_FEE_RESTRICTED_COUPON_EVENT = 'service_fee.restricted_coupon_detected';
export const SERVICE_FEE_RESTRICTED_COUPON_NAMESPACE = 'service_fee';
export const SERVICE_FEE_RESTRICTED_COUPON_SENTRY_TAG = 'service_fee_restricted_coupon_detected';

const MAX_SLACK_COUPON_LINES = 20;

export type StripeCouponSnapshot = {
  id: string;
  valid: boolean;
  appliesToProductIds: readonly string[] | null;
};

export type RestrictedCouponFinding = {
  couponId: string;
  valid: boolean;
  intersectingProductIds: string[];
  appliesToProductCount: number;
};

export type RestrictedCouponAlertPayload = {
  namespace: typeof SERVICE_FEE_RESTRICTED_COUPON_NAMESPACE;
  event: typeof SERVICE_FEE_RESTRICTED_COUPON_EVENT;
  generatedAtIso: string;
  couponCount: number;
  couponIds: string[];
  intersectingProductIds: string[];
};

export type RestrictedCouponAuditReport = {
  generatedAtIso: string;
  couponReviewed: number;
  feeBearingProductCount: number;
  findings: RestrictedCouponFinding[];
  alert: RestrictedCouponAlertPayload | null;
};

export function parseRestrictedCouponAuditArgs(args: readonly string[]): { alert: boolean } {
  assertServiceFeeAuditReadOnly(args);
  if (args.length === 0) return { alert: true };
  if (args.length === 1 && args[0] === '--no-alert') return { alert: false };
  throw new Error(
    [
      'Usage:',
      '  pnpm --filter web script:run service-fees restricted-coupon-audit',
      '  pnpm --filter web script:run service-fees restricted-coupon-audit --no-alert',
    ].join('\n')
  );
}

export type RestrictedCouponAuditDeps = {
  generatedAtIso?: string;
  listCoupons: () => Promise<readonly StripeCouponSnapshot[]>;
  listFeeBearingProductIds: () => Promise<readonly string[]>;
  sendAlert?: (notification: AdminSlackNotification) => Promise<void>;
  capture?: (payload: RestrictedCouponAlertPayload) => void;
  log?: (event: Record<string, unknown>) => void;
};

export type StripePage<T> = {
  data: readonly T[];
  has_more: boolean;
};

export async function listAllStripePages<T extends { id: string }>(
  listPage: (startingAfter: string | undefined) => Promise<StripePage<T>>
): Promise<T[]> {
  const rows: T[] = [];
  let startingAfter: string | undefined;

  for (;;) {
    const page = await listPage(startingAfter);
    rows.push(...page.data);
    if (!page.has_more) return rows;
    const cursor = page.data.at(-1)?.id;
    if (!cursor) {
      throw new Error('stripe page is marked has_more without a cursor');
    }
    startingAfter = cursor;
  }
}

/**
 * Structural view of the Stripe coupon fields this audit reads. `applies_to`
 * is optional because Stripe list payloads may omit the nested object
 * entirely; a per-coupon retrieve returns the authoritative object.
 */
export type StripeCouponSnapshotSource = {
  id: string;
  valid: boolean;
  applies_to?: { products?: readonly string[] | null } | null;
};

/**
 * Snapshot from a coupon whose applies_to field is known to be resolved (a
 * list payload that serialized the field, or a per-coupon retrieve). A coupon
 * with no product restriction resolves to null product ids.
 */
export function couponSnapshotFromResolvedCoupon(
  coupon: StripeCouponSnapshotSource
): StripeCouponSnapshot {
  return {
    id: coupon.id,
    valid: coupon.valid,
    appliesToProductIds: coupon.applies_to?.products ?? null,
  };
}

/**
 * Snapshot from a coupon list payload, or null when the payload omitted
 * applies_to entirely. An omission must never be treated as "unrestricted":
 * that would silently hide exactly the coupons this audit exists to find, so
 * the caller must retrieve the coupon individually instead.
 */
export function couponSnapshotFromListCoupon(
  coupon: StripeCouponSnapshotSource
): StripeCouponSnapshot | null {
  if (coupon.applies_to === undefined) return null;
  return couponSnapshotFromResolvedCoupon(coupon);
}

export type ListCouponSnapshotsDeps = {
  listPage: (startingAfter: string | undefined) => Promise<StripePage<StripeCouponSnapshotSource>>;
  retrieveCoupon: (couponId: string) => Promise<StripeCouponSnapshotSource>;
  log?: (event: Record<string, unknown>) => void;
};

/**
 * Lists every coupon (paginated, read-only) and guarantees each snapshot
 * carries the real applies_to restriction. applies_to is a nested object, not
 * an expandable ID reference, so when a list payload omits the field the
 * coupon is re-fetched with an authoritative read-only coupons.retrieve.
 */
export async function listCouponSnapshotsEnsuringAppliesTo(
  deps: ListCouponSnapshotsDeps
): Promise<StripeCouponSnapshot[]> {
  const log = deps.log ?? defaultLog;
  const coupons = await listAllStripePages(deps.listPage);
  const snapshots: StripeCouponSnapshot[] = [];
  let retrievedCount = 0;

  for (const coupon of coupons) {
    const fromList = couponSnapshotFromListCoupon(coupon);
    if (fromList) {
      snapshots.push(fromList);
      continue;
    }
    retrievedCount += 1;
    snapshots.push(couponSnapshotFromResolvedCoupon(await deps.retrieveCoupon(coupon.id)));
  }

  if (retrievedCount > 0) {
    log({
      event: `${SERVICE_FEE_RESTRICTED_COUPON_EVENT}.applies_to_retrieved`,
      mode: 'read_only',
      retrievedCount,
      couponCount: coupons.length,
    });
  }

  return snapshots;
}

export function findRestrictedFeeBearingCoupons(input: {
  coupons: readonly StripeCouponSnapshot[];
  feeBearingProductIds: ReadonlySet<string>;
}): RestrictedCouponFinding[] {
  const findings: RestrictedCouponFinding[] = [];

  for (const coupon of input.coupons) {
    if (!coupon.appliesToProductIds || coupon.appliesToProductIds.length === 0) continue;
    const intersectingProductIds = uniqueSorted(
      coupon.appliesToProductIds.filter(productId => input.feeBearingProductIds.has(productId))
    );
    if (intersectingProductIds.length === 0) continue;
    findings.push({
      couponId: coupon.id,
      valid: coupon.valid,
      intersectingProductIds,
      appliesToProductCount: coupon.appliesToProductIds.length,
    });
  }

  return findings.sort((left, right) => left.couponId.localeCompare(right.couponId));
}

export async function auditRestrictedCoupons(
  input: RestrictedCouponAuditDeps
): Promise<RestrictedCouponAuditReport> {
  const generatedAtIso = input.generatedAtIso ?? new Date().toISOString();
  const log = input.log ?? defaultLog;
  const [coupons, feeBearingProductIds] = await Promise.all([
    input.listCoupons(),
    input.listFeeBearingProductIds(),
  ]);

  log({
    event: `${SERVICE_FEE_RESTRICTED_COUPON_EVENT}.started`,
    mode: 'read_only',
    generatedAtIso,
    couponCandidates: coupons.length,
    feeBearingProductCount: feeBearingProductIds.length,
  });

  const report = evaluateRestrictedCouponAudit({
    generatedAtIso,
    coupons,
    feeBearingProductIds: new Set(feeBearingProductIds),
  });

  for (const finding of report.findings) {
    log({
      event: `${SERVICE_FEE_RESTRICTED_COUPON_EVENT}.finding`,
      couponId: finding.couponId,
      valid: finding.valid,
      intersectingProductIds: finding.intersectingProductIds,
      appliesToProductCount: finding.appliesToProductCount,
    });
  }

  if (report.alert) {
    input.capture?.(report.alert);
    if (input.sendAlert) {
      try {
        await input.sendAlert(
          buildRestrictedCouponSlackNotification(report.alert, report.findings)
        );
        log({
          event: `${SERVICE_FEE_RESTRICTED_COUPON_EVENT}.alerted`,
          couponCount: report.alert.couponCount,
          couponIds: report.alert.couponIds,
        });
      } catch (error) {
        log({
          event: `${SERVICE_FEE_RESTRICTED_COUPON_EVENT}.alert_failed`,
          kind: error instanceof AdminSlackNotificationError ? error.kind : 'unknown',
          status: error instanceof AdminSlackNotificationError ? error.status : undefined,
          couponCount: report.alert.couponCount,
        });
        throw error;
      }
    }
  }

  log({
    event: `${SERVICE_FEE_RESTRICTED_COUPON_EVENT}.completed`,
    mode: 'read_only',
    generatedAtIso: report.generatedAtIso,
    couponReviewed: report.couponReviewed,
    feeBearingProductCount: report.feeBearingProductCount,
    findingCount: report.findings.length,
  });

  return report;
}

export function evaluateRestrictedCouponAudit(input: {
  generatedAtIso: string;
  coupons: readonly StripeCouponSnapshot[];
  feeBearingProductIds: ReadonlySet<string>;
}): RestrictedCouponAuditReport {
  const findings = findRestrictedFeeBearingCoupons(input);
  return {
    generatedAtIso: input.generatedAtIso,
    couponReviewed: input.coupons.length,
    feeBearingProductCount: input.feeBearingProductIds.size,
    findings,
    alert:
      findings.length === 0
        ? null
        : buildRestrictedCouponAlertPayload({
            generatedAtIso: input.generatedAtIso,
            findings,
          }),
  };
}

export function buildRestrictedCouponAlertPayload(input: {
  generatedAtIso: string;
  findings: readonly RestrictedCouponFinding[];
}): RestrictedCouponAlertPayload {
  return {
    namespace: SERVICE_FEE_RESTRICTED_COUPON_NAMESPACE,
    event: SERVICE_FEE_RESTRICTED_COUPON_EVENT,
    generatedAtIso: input.generatedAtIso,
    couponCount: input.findings.length,
    couponIds: input.findings.map(finding => finding.couponId),
    intersectingProductIds: uniqueSorted(
      input.findings.flatMap(finding => finding.intersectingProductIds)
    ),
  };
}

export function buildRestrictedCouponSlackNotification(
  payload: RestrictedCouponAlertPayload,
  findings: readonly RestrictedCouponFinding[]
): AdminSlackNotification {
  const preview = findings.slice(0, MAX_SLACK_COUPON_LINES);
  const remaining = findings.length - preview.length;
  const lines = preview.map(finding => {
    const products = finding.intersectingProductIds.join(',');
    return `• \`${finding.couponId}\` products=\`${products}\` valid=${finding.valid}`;
  });
  if (remaining > 0) {
    lines.push(`• +${remaining} more`);
  }

  return {
    text: `${SERVICE_FEE_RESTRICTED_COUPON_EVENT}: ${payload.couponCount} coupon(s) apply to fee-bearing products`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*${SERVICE_FEE_RESTRICTED_COUPON_EVENT}*`,
            `${payload.couponCount} coupon(s) have \`applies_to.products\` intersecting fee-bearing Kilo Pass or top-up products.`,
            `products=${payload.intersectingProductIds.map(id => `\`${id}\``).join(', ') || '(none)'}`,
          ].join('\n'),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: lines.join('\n') || '• (none)',
        },
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function defaultLog(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}
