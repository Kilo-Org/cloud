/**
 * What a balance read must do for one request, decided without touching a database.
 *
 * A benchmark case is special in two ways, and both are money:
 * - `fresh` reads the primary. The same payer may have been debited by an earlier case request
 *   in the same run, and a replica lag would admit the next request on a stale balance.
 * - `noAutoTopUp` never requests the usage funding mode, so no purchase starts on the payer's
 *   behalf.
 *
 * Every other request keeps the existing replica read and usage-funded top-up.
 */
export type GatewayBalanceRead = {
  /** Read the primary rather than the replica. */
  fresh: boolean;
  /** Pass `'usage'` to `getBalanceAndOrgSettings` so an auto top-up may be scheduled. */
  fundUsage: boolean;
};

export function gatewayBalanceRead(input: {
  isFreeModel: boolean;
  benchmark: boolean;
}): GatewayBalanceRead {
  if (input.isFreeModel) return { fresh: input.benchmark, fundUsage: false };
  if (input.benchmark) return { fresh: true, fundUsage: false };
  return { fresh: false, fundUsage: true };
}

/**
 * The pre-provider payer decision a benchmark request may rotate on.
 *
 * Only an authoritative credit refusal — the account cannot fund this call — is
 * `payment_refused`. Identity, membership and allowance failures are `payer_unavailable`, which
 * the Worker keeps and pauses rather than rotating. A provider response never reaches this
 * function, so a provider 402 can never become a rotatable refusal.
 */
export type PayerRefusalReason = 'payment_refused' | 'payer_unavailable';

export function benchmarkPayerRefusal(input: {
  /** `paidUsageRejection` produced a refusal for this route. */
  creditsBlocked: boolean;
  /** The signed payer identity resolved to a billable account. */
  payerResolved: boolean;
  /** The organization membership/allowance behind the payer is usable. */
  membershipUsable: boolean;
}): PayerRefusalReason | null {
  if (!input.payerResolved || !input.membershipUsable) return 'payer_unavailable';
  return input.creditsBlocked ? 'payment_refused' : null;
}
