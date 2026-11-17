import type { Dayjs } from 'dayjs';

import { dayjs } from '@kilocode/web-shared/lib/kilo-pass/dayjs';

export function computeIssueMonth(date: Dayjs): string {
  return date.utc().format('YYYY-MM-01');
}

/**
 * Adds one month to an issue month string (YYYY-MM-01 format).
 */
export function addOneMonthToIssueMonth(issueMonth: string): string {
  const parsed = dayjs(`${issueMonth}T00:00:00.000Z`).utc();
  if (!parsed.isValid()) {
    throw new Error(`Invalid issueMonth: ${issueMonth}`);
  }

  return computeIssueMonth(parsed.add(1, 'month'));
}

/**
 * Gets the previous issue month from an issue month string (YYYY-MM-01 format).
 */
export function getPreviousIssueMonth(issueMonth: string): string {
  const parsed = dayjs(`${issueMonth}T00:00:00.000Z`).utc();
  if (!parsed.isValid()) {
    throw new Error(`Invalid issueMonth: ${issueMonth}`);
  }

  return computeIssueMonth(parsed.subtract(1, 'month'));
}
