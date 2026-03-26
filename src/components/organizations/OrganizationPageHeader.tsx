'use client';

import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { BackButton } from '@/components/BackButton';
import { SetPageTitle } from '@/components/SetPageTitle';
import type { ReactNode } from 'react';

type OrganizationPageHeaderProps = {
  organizationId: string;
  title: string;
  showBackButton?: boolean;
  backButtonText?: string;
  backButtonHref?: string;
  badge?: ReactNode;
};

export function OrganizationPageHeader({
  organizationId,
  title,
  showBackButton = false,
  backButtonText = 'Back to Organization',
  backButtonHref,
  badge,
}: OrganizationPageHeaderProps) {
  const { data: organization } = useOrganizationWithMembers(organizationId);

  const finalBackHref = backButtonHref || `/organizations/${organizationId}`;
  const organizationName = organization?.name || 'Organization';
  const finalTitle = title.replace('<org name>', organizationName);

  return (
    <div className="flex w-full flex-col gap-y-4">
      <SetPageTitle title={finalTitle}>{badge}</SetPageTitle>
      {showBackButton && (
        <div>
          <BackButton href={finalBackHref}>{backButtonText}</BackButton>
        </div>
      )}
    </div>
  );
}
