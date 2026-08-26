import { TrendingUp } from 'lucide-react';
import type { OrganizationAlertClientDefinition } from '@/components/organizations/alerts/types';
import {
  CALENDAR_MONTH_UTC_V1,
  MONTHLY_SPENDING_ALERT_TYPE,
} from '@/lib/organizations/alerts/organization-alerts';
import { MonthlySpendingAlertEditor } from './MonthlySpendingAlertEditor';

export const monthlySpendingAlertClientDefinition = {
  type: MONTHLY_SPENDING_ALERT_TYPE,
  label: 'Monthly spending',
  description: 'Email chosen people when AI usage spend reaches an amount in a UTC calendar month.',
  Icon: TrendingUp,
  createInitialDefinition({ suggestedRecipient }) {
    return {
      type: MONTHLY_SPENDING_ALERT_TYPE,
      configuration: {
        // No amount is suggested, so the editor opens with an empty field rather
        // than a threshold nobody chose.
        thresholdMicrodollars: 0,
        period: CALENDAR_MONTH_UTC_V1,
        recipients: suggestedRecipient ? [suggestedRecipient] : [],
      },
    };
  },
  Editor: MonthlySpendingAlertEditor,
} satisfies OrganizationAlertClientDefinition<typeof MONTHLY_SPENDING_ALERT_TYPE>;
