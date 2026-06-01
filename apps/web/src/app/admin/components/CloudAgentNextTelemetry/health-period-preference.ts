import { safeLocalStorage } from '@/lib/localStorage';

const HEALTH_PERIOD_STORAGE_KEY = 'cloud-agent-next:admin-health-period';
const HEALTH_PERIODS = ['1h', '3h', '24h', '7d', '14d', '30d'] as const;

export type HealthPeriod = (typeof HEALTH_PERIODS)[number];

export const DEFAULT_HEALTH_PERIOD: HealthPeriod = '7d';

export function isHealthPeriod(value: string): value is HealthPeriod {
  return HEALTH_PERIODS.some(period => period === value);
}

export function parseHealthPeriod(value: string | null): HealthPeriod {
  return value && isHealthPeriod(value) ? value : DEFAULT_HEALTH_PERIOD;
}

export function getStoredHealthPeriod(): HealthPeriod {
  return parseHealthPeriod(safeLocalStorage.getItem(HEALTH_PERIOD_STORAGE_KEY));
}

export function setStoredHealthPeriod(period: HealthPeriod): void {
  safeLocalStorage.setItem(HEALTH_PERIOD_STORAGE_KEY, period);
}
