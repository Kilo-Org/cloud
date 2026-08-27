import type { OrganizationAlertStatus } from '@kilocode/db/schema';
import type { inferRouterOutputs } from '@trpc/server';
import {
  CALENDAR_MONTH_UTC_PERIOD_TYPE,
  formatAlertUsd,
  LOW_BALANCE_ALERT_TYPE,
  MONTHLY_SPENDING_ALERT_TYPE,
  type OrganizationAlertPeriodDefinition,
} from '@/lib/organizations/alerts/organization-alerts';
import type { RootRouter } from '@/routers/root-router';
import type { BadgeVariantProps } from '@/components/ui/badge-variants';

/** One alert row as the authorized Alerts surface receives it. */
export type OrganizationAlertRow =
  inferRouterOutputs<RootRouter>['organizations']['alerts']['list']['alerts'][number];

export const ORGANIZATION_ALERT_STATUS_PRESENTATION: Record<
  OrganizationAlertStatus,
  { label: string; variant: BadgeVariantProps['variant'] }
> = {
  enabled: { label: 'Enabled', variant: 'new' },
  disabled: { label: 'Disabled', variant: 'secondary' },
  archived: { label: 'Archived', variant: 'outline' },
};

/**
 * The window a threshold is measured over, named from the alert's own versioned
 * period definition rather than assumed, so a new period type or version cannot
 * ship a row that describes the wrong window.
 */
const ALERT_PERIOD_LABELS: Record<OrganizationAlertPeriodDefinition['type'], string> = {
  [CALENDAR_MONTH_UTC_PERIOD_TYPE]: 'a UTC calendar month',
};

function recipientCountSummary(recipients: number): string {
  if (recipients === 0) return 'No recipients';
  return `${recipients} recipient${recipients === 1 ? '' : 's'}`;
}

/**
 * One line describing what an alert watches and how many people it notifies.
 * Recipient addresses are deliberately summarized as a count: the surface shows
 * what is configured without repeating the disclosure list outside the editor.
 */
/** Describes what a monthly spending alert's `scope` measures. */
function scopeSummary(
  alert: OrganizationAlertRow & { type: typeof MONTHLY_SPENDING_ALERT_TYPE }
): string {
  if (alert.configuration.scope.type === 'organization') return 'the whole organization';
  // A deleted group's name cannot be resolved; the alert is invalid until its
  // scope is changed, which the editor's own state surfaces separately.
  return alert.groupName ? `the "${alert.groupName}" group` : 'a deleted group';
}

export function organizationAlertSummary(alert: OrganizationAlertRow): string {
  switch (alert.type) {
    case MONTHLY_SPENDING_ALERT_TYPE: {
      const { thresholdMicrodollars, period, recipients } = alert.configuration;
      return `Reaches ${formatAlertUsd(thresholdMicrodollars)} of AI usage spend in ${ALERT_PERIOD_LABELS[period.type]} for ${scopeSummary(alert)} · ${recipientCountSummary(recipients.length)}`;
    }
    case LOW_BALANCE_ALERT_TYPE: {
      const { thresholdMicrodollars, recipients } = alert.configuration;
      return `Drops below ${formatAlertUsd(thresholdMicrodollars)} of AI usage balance · ${recipientCountSummary(recipients.length)}`;
    }
  }
}
