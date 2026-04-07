export const BILLING_FLOW = 'kiloclaw_lifecycle' as const;

export const BILLING_HEADER_NAMES = {
  runId: 'x-kiloclaw-billing-run-id',
  sweep: 'x-kiloclaw-billing-sweep',
  callId: 'x-kiloclaw-billing-call-id',
  attempt: 'x-kiloclaw-billing-attempt',
} as const;

export type BillingCorrelationContext = {
  billingFlow?: typeof BILLING_FLOW;
  billingRunId?: string;
  billingSweep?: string;
  billingCallId?: string;
  billingAttempt?: number;
};

type HeaderReader = {
  get(name: string): string | null;
};

function hasBillingCorrelation(context: BillingCorrelationContext): boolean {
  return (
    context.billingRunId !== undefined ||
    context.billingSweep !== undefined ||
    context.billingCallId !== undefined ||
    context.billingAttempt !== undefined
  );
}

export function normalizeBillingCorrelation(
  context: BillingCorrelationContext | null | undefined
): BillingCorrelationContext {
  if (!context || !hasBillingCorrelation(context)) {
    return {};
  }

  return {
    ...context,
    billingFlow: BILLING_FLOW,
  };
}

export function createBillingCorrelationHeaders(
  context: BillingCorrelationContext | null | undefined
): Record<string, string> {
  const normalized = normalizeBillingCorrelation(context);
  if (!hasBillingCorrelation(normalized)) {
    return {};
  }

  const headers: Record<string, string> = {};

  if (normalized.billingRunId) {
    headers[BILLING_HEADER_NAMES.runId] = normalized.billingRunId;
  }
  if (normalized.billingSweep) {
    headers[BILLING_HEADER_NAMES.sweep] = normalized.billingSweep;
  }
  if (normalized.billingCallId) {
    headers[BILLING_HEADER_NAMES.callId] = normalized.billingCallId;
  }
  if (normalized.billingAttempt !== undefined) {
    headers[BILLING_HEADER_NAMES.attempt] = String(normalized.billingAttempt);
  }

  return headers;
}

export function readBillingCorrelationHeaders(
  headers: HeaderReader
): BillingCorrelationContext | null {
  const billingRunId = headers.get(BILLING_HEADER_NAMES.runId) ?? undefined;
  const billingSweep = headers.get(BILLING_HEADER_NAMES.sweep) ?? undefined;
  const billingCallId = headers.get(BILLING_HEADER_NAMES.callId) ?? undefined;
  const rawAttempt = headers.get(BILLING_HEADER_NAMES.attempt);
  const parsedAttempt = rawAttempt === null ? undefined : Number.parseInt(rawAttempt, 10);
  const billingAttempt = Number.isFinite(parsedAttempt) ? parsedAttempt : undefined;

  const context = normalizeBillingCorrelation({
    billingRunId,
    billingSweep,
    billingCallId,
    billingAttempt,
  });

  return hasBillingCorrelation(context) ? context : null;
}
