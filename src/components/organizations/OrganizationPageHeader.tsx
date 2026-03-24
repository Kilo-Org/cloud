'use client';

import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { BackButton } from '@/components/BackButton';
import { useSetTopBarTitle } from '@/components/TopBar';
import type { ReactNode } from 'react';

type OrganizationPageHeaderProps = {
  organizationId: string;
  title: ReactNode;
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
  const finalTitle =
    typeof title === 'string' ? title.replace('<org name>', organizationName) : title;

  // Push resolved string titles into the topbar
  useSetTopBarTitle(typeof finalTitle === 'string' ? finalTitle : null);

  return (
    <div className="flex w-full flex-col gap-y-4">
      {showBackButton && (
        <div>
          <BackButton href={finalBackHref}>{backButtonText}</BackButton>
        </div>
      )}
      <div className="flex items-center gap-3">
        <h1 className="text-3xl font-bold md:hidden">{finalTitle}</h1>
        {badge}
      </div>
    </div>
  );
}
