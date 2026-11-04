import { DEFAULT_BILLING_HEARTBEAT_SECONDS } from '@kilocode/container-usage';

export function billingHeartbeatSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_BILLING_HEARTBEAT_SECONDS;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : DEFAULT_BILLING_HEARTBEAT_SECONDS;
}
