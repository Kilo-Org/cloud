import {
  customerBillingFailureSchema,
  type CustomerBillingFailure,
} from '@kilocode/session-ingest-contracts';

export function readCustomerBillingFailure(
  value: string | null | undefined
): CustomerBillingFailure | undefined {
  if (value == null) return undefined;
  try {
    const result = customerBillingFailureSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
