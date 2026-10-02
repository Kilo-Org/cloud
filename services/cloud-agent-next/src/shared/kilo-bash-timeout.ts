export const KILO_BASH_DEFAULT_TIMEOUT_MS_DEFAULT = 240_000;

export function resolveKiloBashDefaultTimeoutMs(value?: string | number | null): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : KILO_BASH_DEFAULT_TIMEOUT_MS_DEFAULT;
}
