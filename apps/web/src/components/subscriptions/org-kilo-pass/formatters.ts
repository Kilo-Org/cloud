import { formatDateLabel } from '../helpers';

export const formatOrgPassDate = formatDateLabel;

export function formatOrgPassMoney(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}
