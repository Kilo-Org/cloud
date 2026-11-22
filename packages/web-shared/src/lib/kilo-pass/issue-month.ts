import type { Dayjs } from 'dayjs';

import { dayjs } from '@kilocode/web-shared/lib/kilo-pass/dayjs';

export function computeIssueMonth(date: Dayjs): string {
  return date.utc().format('YYYY-MM-01');
}

/** Parses an issue month string (YYYY-MM-01 format) as UTC midnight, or throws. */
export function parseIssueMonth(issueMonth: string): Dayjs {
  const parsed = dayjs(`${issueMonth}T00:00:00.000Z`).utc();
  if (!parsed.isValid()) {
    throw new Error(`Invalid issueMonth: ${issueMonth}`);
  }
  return parsed;
}

/** Shifts a month start by whole months; the one month-arithmetic step. */
export function shiftIssueMonth(monthStart: Dayjs, months: number): Dayjs {
  return monthStart.add(months, 'month');
}

/**
 * Adds one month to an issue month string (YYYY-MM-01 format).
 */
export function addOneMonthToIssueMonth(issueMonth: string): string {
  return computeIssueMonth(shiftIssueMonth(parseIssueMonth(issueMonth), 1));
}

/**
 * Gets the previous issue month from an issue month string (YYYY-MM-01 format).
 */
export function getPreviousIssueMonth(issueMonth: string): string {
  return computeIssueMonth(shiftIssueMonth(parseIssueMonth(issueMonth), -1));
}
