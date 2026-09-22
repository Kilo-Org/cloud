import * as z from 'zod';

/**
 * Period definitions are typed and versioned so that changing timezone, anchor,
 * or reset semantics produces a new version instead of silently reinterpreting
 * existing occurrence identities. Monthly behavior is never inferred from a
 * missing field or a 30-day duration.
 */
export const CALENDAR_MONTH_UTC_PERIOD_TYPE = 'calendar_month_utc';

export const OrganizationAlertPeriodDefinitionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(CALENDAR_MONTH_UTC_PERIOD_TYPE), version: z.literal(1) }).strict(),
]);

export type OrganizationAlertPeriodDefinition = z.infer<
  typeof OrganizationAlertPeriodDefinitionSchema
>;

export const CALENDAR_MONTH_UTC_V1 = {
  type: CALENDAR_MONTH_UTC_PERIOD_TYPE,
  version: 1,
} satisfies OrganizationAlertPeriodDefinition;

/**
 * One resolved occurrence of a period definition: a stable identity plus the
 * half-open UTC interval `[startInclusive, endExclusive)`. Spend aggregation,
 * crossing detection, and delivery consume this instead of doing their own
 * month arithmetic.
 */
export type OrganizationAlertPeriodOccurrence = {
  definition: OrganizationAlertPeriodDefinition;
  occurrenceId: string;
  startInclusive: Date;
  endExclusive: Date;
};

const CALENDAR_MONTH_UTC_V1_OCCURRENCE_PREFIX = `${CALENDAR_MONTH_UTC_PERIOD_TYPE}:v${CALENDAR_MONTH_UTC_V1.version}`;

/**
 * `Date.UTC` maps years 0-99 to 1900-1999, so the year is set explicitly. The
 * month index may be 12, which rolls over to January of the next year.
 */
function utcMonthStart(year: number, monthIndex: number): Date {
  const start = new Date(0);
  start.setUTCFullYear(year, monthIndex, 1);
  return start;
}

function calendarMonthUtcV1Occurrence(
  year: number,
  monthIndex: number
): OrganizationAlertPeriodOccurrence {
  const month = String(monthIndex + 1).padStart(2, '0');
  const paddedYear = String(year).padStart(4, '0');
  return {
    definition: CALENDAR_MONTH_UTC_V1,
    occurrenceId: `${CALENDAR_MONTH_UTC_V1_OCCURRENCE_PREFIX}:${paddedYear}-${month}`,
    startInclusive: utcMonthStart(year, monthIndex),
    endExclusive: utcMonthStart(year, monthIndex + 1),
  };
}

/**
 * Names one occurrence for customer-facing copy. The timezone is always stated
 * because the window is UTC rather than the reader's local month.
 */
export function formatOrganizationAlertPeriodOccurrence(
  occurrence: OrganizationAlertPeriodOccurrence
): string {
  switch (occurrence.definition.type) {
    case CALENDAR_MONTH_UTC_PERIOD_TYPE:
      return `${occurrence.startInclusive.toLocaleString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })} (UTC)`;
  }
}

/** Resolves the single occurrence that contains `at`. */
export function resolveOrganizationAlertPeriodOccurrence(
  definition: OrganizationAlertPeriodDefinition,
  at: Date
): OrganizationAlertPeriodOccurrence {
  if (Number.isNaN(at.getTime())) {
    throw new Error('Cannot resolve an alert period occurrence at an invalid date');
  }
  switch (definition.type) {
    case CALENDAR_MONTH_UTC_PERIOD_TYPE:
      return calendarMonthUtcV1Occurrence(at.getUTCFullYear(), at.getUTCMonth());
  }
}
