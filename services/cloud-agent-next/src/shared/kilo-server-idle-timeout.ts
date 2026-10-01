export const KILO_SERVER_IDLE_TIMEOUT_MS_DEFAULT = 15 * 60 * 1000;

export function resolveKiloServerIdleTimeoutMs(value?: string | number | null): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : KILO_SERVER_IDLE_TIMEOUT_MS_DEFAULT;
}
