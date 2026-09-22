import { TrendingDown } from 'lucide-react';
import type { OrganizationAlertClientDefinition } from '@/components/organizations/alerts/types';
import { LOW_BALANCE_ALERT_TYPE } from '@/lib/organizations/alerts/organization-alerts';
import { LowBalanceAlertEditor } from './LowBalanceAlertEditor';

export const lowBalanceAlertClientDefinition = {
  type: LOW_BALANCE_ALERT_TYPE,
  label: 'Low balance',
  description:
    'Email chosen people as soon as this organization\u2019s AI usage balance drops below an amount.',
  Icon: TrendingDown,
  createInitialDefinition({ suggestedRecipient }) {
    return {
      type: LOW_BALANCE_ALERT_TYPE,
      configuration: {
        // No amount is suggested, so the editor opens with an empty field rather
        // than a threshold nobody chose.
        thresholdMicrodollars: 0,
        recipients: suggestedRecipient ? [suggestedRecipient] : [],
      },
    };
  },
  Editor: LowBalanceAlertEditor,
} satisfies OrganizationAlertClientDefinition<typeof LOW_BALANCE_ALERT_TYPE>;
