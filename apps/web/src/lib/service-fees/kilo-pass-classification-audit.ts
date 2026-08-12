import { getOrganizationKiloPassMetadata } from '@/lib/kilo-pass-org/stripe-metadata';
import { getKiloPassMetadataFromStripeMetadata } from '@/lib/kilo-pass/stripe-handlers-metadata';

export const SERVICE_FEE_KILO_PASS_CLASSIFICATION_EVENT =
  'service_fee.kilo_pass_classification_audit';

export const LIVE_PERSONAL_KILO_PASS_STATUSES = [
  'active',
  'past_due',
  'trialing',
  'unpaid',
] as const;

export const LIVE_ORG_KILO_PASS_STATES = ['active', 'cancel_at_period_end'] as const;

export type StripeSubscriptionItemSnapshot = {
  id: string;
  priceId: string | null;
  productId: string | null;
};

export type StripeSubscriptionSnapshot = {
  id: string;
  status: string;
  metadata: Record<string, string>;
  items: readonly StripeSubscriptionItemSnapshot[];
};

export type PersonalKiloPassAuditRow = {
  id: string;
  kiloUserId: string;
  stripeSubscriptionId: string | null;
  status: string;
  tier: string;
  cadence: string;
};

export type OrganizationKiloPassAuditRow = {
  id: string;
  organizationId: string;
  providerSubscriptionId: string | null;
  providerSeatAddOnItemId: string | null;
  state: string;
  purchaseChannel: string;
};

export type KiloPassClassificationIssueCode =
  | 'missing_stripe_subscription_id'
  | 'stripe_subscription_not_found'
  | 'missing_known_kilo_pass_price'
  | 'has_organization_kilo_pass_metadata'
  | 'has_personal_kilo_pass_metadata'
  | 'missing_personal_kilo_pass_metadata'
  | 'missing_organization_kilo_pass_metadata'
  | 'bound_add_on_item_not_found'
  | 'bound_add_on_item_is_seat'
  | 'bound_add_on_item_unknown_price'
  | 'ambiguous_kilo_pass_items'
  | 'unresolved_kilo_pass_item';

export type KiloPassClassificationIssue = {
  code: KiloPassClassificationIssueCode;
  severity: 'error' | 'warning';
};

export type KiloPassClassificationKind = 'personal_kilo_pass' | 'organization_kilo_pass';

export type KiloPassClassificationResult = {
  kind: KiloPassClassificationKind;
  recordId: string;
  stripeSubscriptionId: string | null;
  classifiable: boolean;
  resolvedItemId: string | null;
  issues: KiloPassClassificationIssue[];
};

export type KiloPassClassificationAuditInput = {
  generatedAtIso: string;
  knownKiloPassPriceIds: ReadonlySet<string>;
  seatProductIds: ReadonlySet<string>;
  personalRows: readonly PersonalKiloPassAuditRow[];
  organizationRows: readonly OrganizationKiloPassAuditRow[];
  subscriptionsById: ReadonlyMap<string, StripeSubscriptionSnapshot | null>;
};

export type KiloPassClassificationAuditReport = {
  generatedAtIso: string;
  personalReviewed: number;
  organizationReviewed: number;
  classifiableCount: number;
  unclassifiableCount: number;
  warningCount: number;
  results: KiloPassClassificationResult[];
};

export type RetrieveKiloPassSubscription = (
  subscriptionId: string
) => Promise<StripeSubscriptionSnapshot | null>;

export type KiloPassClassificationAuditStore = {
  listPersonalRows: () => Promise<readonly PersonalKiloPassAuditRow[]>;
  listOrganizationRows: () => Promise<readonly OrganizationKiloPassAuditRow[]>;
};

export function classifyPersonalKiloPassSubscription(input: {
  row: PersonalKiloPassAuditRow;
  subscription: StripeSubscriptionSnapshot | null | undefined;
  knownKiloPassPriceIds: ReadonlySet<string>;
}): KiloPassClassificationResult {
  const issues: KiloPassClassificationIssue[] = [];
  if (!input.row.stripeSubscriptionId) {
    issues.push({ code: 'missing_stripe_subscription_id', severity: 'error' });
    return personalResult(input.row, null, issues);
  }
  if (!input.subscription) {
    issues.push({ code: 'stripe_subscription_not_found', severity: 'error' });
    return personalResult(input.row, null, issues);
  }

  const personalMetadata = getKiloPassMetadataFromStripeMetadata(input.subscription.metadata);
  const organizationMetadata = getOrganizationKiloPassMetadata(input.subscription.metadata);
  const knownPriceItems = input.subscription.items.filter(
    item => item.priceId !== null && input.knownKiloPassPriceIds.has(item.priceId)
  );

  if (organizationMetadata) {
    issues.push({ code: 'has_organization_kilo_pass_metadata', severity: 'error' });
  }
  if (knownPriceItems.length === 0) {
    issues.push({ code: 'missing_known_kilo_pass_price', severity: 'error' });
  }
  if (!personalMetadata) {
    issues.push({
      code: 'missing_personal_kilo_pass_metadata',
      severity: knownPriceItems.length > 0 && !organizationMetadata ? 'warning' : 'error',
    });
  }

  return personalResult(input.row, knownPriceItems[0]?.id ?? null, issues);
}

export function classifyOrganizationKiloPassSubscription(input: {
  row: OrganizationKiloPassAuditRow;
  subscription: StripeSubscriptionSnapshot | null | undefined;
  knownKiloPassPriceIds: ReadonlySet<string>;
  seatProductIds: ReadonlySet<string>;
}): KiloPassClassificationResult {
  const issues: KiloPassClassificationIssue[] = [];
  if (!input.row.providerSubscriptionId) {
    issues.push({ code: 'missing_stripe_subscription_id', severity: 'error' });
    return organizationResult(input.row, null, issues);
  }
  if (!input.subscription) {
    issues.push({ code: 'stripe_subscription_not_found', severity: 'error' });
    return organizationResult(input.row, null, issues);
  }

  const personalMetadata = getKiloPassMetadataFromStripeMetadata(input.subscription.metadata);
  const organizationMetadata = getOrganizationKiloPassMetadata(input.subscription.metadata);
  if (personalMetadata) {
    issues.push({ code: 'has_personal_kilo_pass_metadata', severity: 'error' });
  }
  if (!organizationMetadata) {
    issues.push({ code: 'missing_organization_kilo_pass_metadata', severity: 'error' });
  }

  const resolved = resolveOrganizationKiloPassItem({
    row: input.row,
    subscription: input.subscription,
    knownKiloPassPriceIds: input.knownKiloPassPriceIds,
    seatProductIds: input.seatProductIds,
  });
  issues.push(...resolved.issues);

  return organizationResult(input.row, resolved.itemId, issues);
}

export async function auditKiloPassClassifications(input: {
  generatedAtIso?: string;
  knownKiloPassPriceIds: ReadonlySet<string>;
  seatProductIds: ReadonlySet<string>;
  store: KiloPassClassificationAuditStore;
  retrieveSubscription: RetrieveKiloPassSubscription;
  log?: (event: Record<string, unknown>) => void;
}): Promise<KiloPassClassificationAuditReport> {
  const generatedAtIso = input.generatedAtIso ?? new Date().toISOString();
  const log = input.log ?? defaultLog;
  const personalRows = await input.store.listPersonalRows();
  const organizationRows = await input.store.listOrganizationRows();
  const subscriptionIds = uniqueIds([
    ...personalRows.map(row => row.stripeSubscriptionId),
    ...organizationRows.map(row => row.providerSubscriptionId),
  ]);
  const subscriptionsById = new Map<string, StripeSubscriptionSnapshot | null>();

  log({
    event: `${SERVICE_FEE_KILO_PASS_CLASSIFICATION_EVENT}.started`,
    mode: 'read_only',
    generatedAtIso,
    personalCandidates: personalRows.length,
    organizationCandidates: organizationRows.length,
    stripeSubscriptionIds: subscriptionIds.length,
  });

  for (const subscriptionId of subscriptionIds) {
    subscriptionsById.set(subscriptionId, await input.retrieveSubscription(subscriptionId));
  }

  const report = evaluateKiloPassClassificationAudit({
    generatedAtIso,
    knownKiloPassPriceIds: input.knownKiloPassPriceIds,
    seatProductIds: input.seatProductIds,
    personalRows,
    organizationRows,
    subscriptionsById,
  });

  for (const result of report.results) {
    if (result.issues.length === 0) continue;
    log({
      event: `${SERVICE_FEE_KILO_PASS_CLASSIFICATION_EVENT}.result`,
      kind: result.kind,
      recordId: result.recordId,
      stripeSubscriptionId: result.stripeSubscriptionId,
      classifiable: result.classifiable,
      resolvedItemId: result.resolvedItemId,
      issues: result.issues,
    });
  }

  log({
    event: `${SERVICE_FEE_KILO_PASS_CLASSIFICATION_EVENT}.completed`,
    mode: 'read_only',
    generatedAtIso: report.generatedAtIso,
    personalReviewed: report.personalReviewed,
    organizationReviewed: report.organizationReviewed,
    classifiableCount: report.classifiableCount,
    unclassifiableCount: report.unclassifiableCount,
    warningCount: report.warningCount,
  });

  return report;
}

export function evaluateKiloPassClassificationAudit(
  input: KiloPassClassificationAuditInput
): KiloPassClassificationAuditReport {
  const results: KiloPassClassificationResult[] = [];

  for (const row of input.personalRows) {
    const subscription = row.stripeSubscriptionId
      ? input.subscriptionsById.get(row.stripeSubscriptionId)
      : undefined;
    results.push(
      classifyPersonalKiloPassSubscription({
        row,
        subscription,
        knownKiloPassPriceIds: input.knownKiloPassPriceIds,
      })
    );
  }

  for (const row of input.organizationRows) {
    const subscription = row.providerSubscriptionId
      ? input.subscriptionsById.get(row.providerSubscriptionId)
      : undefined;
    results.push(
      classifyOrganizationKiloPassSubscription({
        row,
        subscription,
        knownKiloPassPriceIds: input.knownKiloPassPriceIds,
        seatProductIds: input.seatProductIds,
      })
    );
  }

  return {
    generatedAtIso: input.generatedAtIso,
    personalReviewed: input.personalRows.length,
    organizationReviewed: input.organizationRows.length,
    classifiableCount: results.filter(result => result.classifiable).length,
    unclassifiableCount: results.filter(result => !result.classifiable).length,
    warningCount: results.reduce(
      (count, result) => count + result.issues.filter(issue => issue.severity === 'warning').length,
      0
    ),
    results,
  };
}

function resolveOrganizationKiloPassItem(input: {
  row: OrganizationKiloPassAuditRow;
  subscription: StripeSubscriptionSnapshot;
  knownKiloPassPriceIds: ReadonlySet<string>;
  seatProductIds: ReadonlySet<string>;
}): { itemId: string | null; issues: KiloPassClassificationIssue[] } {
  const issues: KiloPassClassificationIssue[] = [];
  const boundItemId = input.row.providerSeatAddOnItemId;
  if (boundItemId && !boundItemId.startsWith('pending:')) {
    const boundItem = input.subscription.items.find(item => item.id === boundItemId);
    if (!boundItem) {
      issues.push({ code: 'bound_add_on_item_not_found', severity: 'error' });
      return { itemId: null, issues };
    }
    if (isSeatItem(boundItem, input.seatProductIds)) {
      issues.push({ code: 'bound_add_on_item_is_seat', severity: 'error' });
      return { itemId: boundItem.id, issues };
    }
    if (!boundItem.priceId || !input.knownKiloPassPriceIds.has(boundItem.priceId)) {
      issues.push({ code: 'bound_add_on_item_unknown_price', severity: 'error' });
      return { itemId: boundItem.id, issues };
    }
    return { itemId: boundItem.id, issues };
  }

  const knownNonSeatItems = input.subscription.items.filter(
    item =>
      item.priceId !== null &&
      input.knownKiloPassPriceIds.has(item.priceId) &&
      !isSeatItem(item, input.seatProductIds)
  );
  if (knownNonSeatItems.length === 1) {
    if (!boundItemId) {
      issues.push({ code: 'unresolved_kilo_pass_item', severity: 'warning' });
    }
    return { itemId: knownNonSeatItems[0]?.id ?? null, issues };
  }
  if (knownNonSeatItems.length > 1) {
    issues.push({ code: 'ambiguous_kilo_pass_items', severity: 'error' });
    return { itemId: null, issues };
  }

  issues.push({ code: 'unresolved_kilo_pass_item', severity: 'error' });
  return { itemId: null, issues };
}

function isSeatItem(
  item: StripeSubscriptionItemSnapshot,
  seatProductIds: ReadonlySet<string>
): boolean {
  return item.productId !== null && seatProductIds.has(item.productId);
}

function personalResult(
  row: PersonalKiloPassAuditRow,
  resolvedItemId: string | null,
  issues: KiloPassClassificationIssue[]
): KiloPassClassificationResult {
  return {
    kind: 'personal_kilo_pass',
    recordId: row.id,
    stripeSubscriptionId: row.stripeSubscriptionId,
    classifiable: issues.every(issue => issue.severity !== 'error'),
    resolvedItemId,
    issues,
  };
}

function organizationResult(
  row: OrganizationKiloPassAuditRow,
  resolvedItemId: string | null,
  issues: KiloPassClassificationIssue[]
): KiloPassClassificationResult {
  return {
    kind: 'organization_kilo_pass',
    recordId: row.id,
    stripeSubscriptionId: row.providerSubscriptionId,
    classifiable: issues.every(issue => issue.severity !== 'error'),
    resolvedItemId,
    issues,
  };
}

function uniqueIds(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function defaultLog(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}
