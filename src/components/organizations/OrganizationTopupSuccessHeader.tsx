'use client';

import { Banner } from '@/components/shared/Banner';
import { CircleCheck } from 'lucide-react';

type OrganizationTopupSuccessHeaderProps = {
  organizationName: string;
  amountUsd: string;
  onDismiss: () => void;
};

export function OrganizationTopupSuccessHeader({
  organizationName,
  amountUsd,
  onDismiss,
}: OrganizationTopupSuccessHeaderProps) {
  const formattedAmount = parseFloat(amountUsd).toFixed(2);
  return (
    <Banner color="green" size="lg">
      <Banner.Icon>
        <CircleCheck className="h-6 w-6" />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>
          You purchased ${formattedAmount} more credits for {organizationName}. Happy Coding!
        </Banner.Title>
      </Banner.Content>
      <Banner.Dismiss onDismiss={onDismiss} />
    </Banner>
  );
}
