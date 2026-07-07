import { AlertTriangle, ArrowRight } from 'lucide-react';
import { Banner } from '@/components/shared/Banner';
import type { CostInsightsOwner } from '../types';

export function CostInsightsAlertBar({
  owner,
  alertCount,
  reviewHref,
}: {
  owner: CostInsightsOwner;
  alertCount: number;
  reviewHref: string;
}) {
  const alertLabel =
    alertCount === 1 ? 'Spend Alert needs review' : `${alertCount} Spend Alerts need review`;

  return (
    <Banner color="amber" role="alert" className="rounded-none border-x-0 border-t-0">
      <Banner.Icon>
        <AlertTriangle aria-hidden="true" />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>{alertLabel}</Banner.Title>
        <Banner.Description>Review unexpected spend for {owner.name}.</Banner.Description>
      </Banner.Content>
      <Banner.Action>
        <Banner.Button
          href={reviewHref}
          className="min-h-control-touch bg-primary hover:bg-primary-hover sm:min-h-0"
        >
          Review spend
          <ArrowRight aria-hidden="true" />
        </Banner.Button>
      </Banner.Action>
    </Banner>
  );
}
