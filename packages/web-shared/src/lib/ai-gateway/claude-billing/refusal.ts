import * as z from 'zod';

// Compatibility responses can omit billing details. Record their status without
// treating an unrelated permission failure as proof that the connection ended.
export const CLAUDE_BILLING_REFUSALS = {
  spendingLimit: 'linked_organization_spend_limit_reached',
  billingUnavailable: 'linked_organization_billing_unavailable',
  notBillable: 'user_profile_not_billable',
  notAuthorized: 'user_profile_billing_not_authorized',
  forbiddenWithoutCode: 'permission_error',
  paymentRequiredWithoutCode: 'billing_error',
} as const;

export type ClaudeBillingRefusal =
  (typeof CLAUDE_BILLING_REFUSALS)[keyof typeof CLAUDE_BILLING_REFUSALS];

const recognizedRefusalCodes: ReadonlySet<string> = new Set(Object.values(CLAUDE_BILLING_REFUSALS));

const refusalBodySchema = z.object({
  error: z.object({
    code: z.string().optional(),
    details: z.object({ error_code: z.string().optional() }).optional(),
  }),
});

export function readClaudeBillingRefusalCode(body: unknown): string | null {
  const parsed = refusalBodySchema.safeParse(body);
  if (!parsed.success) return null;
  return parsed.data.error.details?.error_code ?? parsed.data.error.code ?? null;
}

// Anthropic is still consolidating its 402 codes, so a code Kilo does not know
// is reported by its status. A status-only refusal remains visible without
// changing the connection state.
export function claudeBillingRefusalCodeFor(status: number, body: unknown): string | null {
  const code = readClaudeBillingRefusalCode(body);
  if (code && recognizedRefusalCodes.has(code)) return code;
  if (status === 403) return CLAUDE_BILLING_REFUSALS.forbiddenWithoutCode;
  if (status === 402) return CLAUDE_BILLING_REFUSALS.paymentRequiredWithoutCode;
  return null;
}

type ClaudeBillingRefusalClass = 'payment_required' | 'forbidden';

/** The class of Anthropic refusal each code describes. */
const refusalClassOf: Record<ClaudeBillingRefusal, ClaudeBillingRefusalClass> = {
  [CLAUDE_BILLING_REFUSALS.spendingLimit]: 'payment_required',
  [CLAUDE_BILLING_REFUSALS.billingUnavailable]: 'payment_required',
  [CLAUDE_BILLING_REFUSALS.paymentRequiredWithoutCode]: 'payment_required',
  [CLAUDE_BILLING_REFUSALS.notBillable]: 'forbidden',
  [CLAUDE_BILLING_REFUSALS.notAuthorized]: 'forbidden',
  [CLAUDE_BILLING_REFUSALS.forbiddenWithoutCode]: 'forbidden',
};

/** The refusals that carry their status class and nothing else. */
const statusOnlyRefusalClass = new Map<string, ClaudeBillingRefusalClass>([
  [CLAUDE_BILLING_REFUSALS.forbiddenWithoutCode, 'forbidden'],
  [CLAUDE_BILLING_REFUSALS.paymentRequiredWithoutCode, 'payment_required'],
]);

/**
 * The stored codes a status-only refusal must not replace. Those codes name the
 * same status class, so a later status-only refusal from the same connection —
 * the compatibility API sends only `billing_error` — keeps the specific
 * explanation the customer already had.
 */
export function specificRefusalCodesFor(statusOnlyCode: string): string[] {
  const statusClass = statusOnlyRefusalClass.get(statusOnlyCode);
  if (!statusClass) return [];
  return Object.values(CLAUDE_BILLING_REFUSALS).filter(
    code => !statusOnlyRefusalClass.has(code) && refusalClassOf[code] === statusClass
  );
}

export function isClaudeBillingConnectionDead(code: string): boolean {
  return (
    code === CLAUDE_BILLING_REFUSALS.notBillable || code === CLAUDE_BILLING_REFUSALS.notAuthorized
  );
}

/** True for the responses that are never worth retrying on another payer. */
export function isClaudeBillingRefusedStatus(status: number): boolean {
  return status === 402 || status === 403;
}
