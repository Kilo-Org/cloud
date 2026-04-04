'use client';

import { AlertCircle, AlertTriangle, Clock } from 'lucide-react';
import { Banner } from '@/components/shared/Banner';
import { getOrgTrialStatusFromDays } from '@/lib/organizations/trial-utils';
import type {
  OrgTrialStatus,
  OrganizationRole,
  OrganizationWithMembers,
} from '@/lib/organizations/organization-types';
import { capitalize } from '@/lib/utils';

type FreeTrialWarningBannerProps = {
  organization: OrganizationWithMembers;
  daysRemaining: number;
  userRole: OrganizationRole;
  onUpgradeClick: () => void;
};

type BannerColorValue = 'blue' | 'amber' | 'red';

function getBannerColor(state: OrgTrialStatus): BannerColorValue {
  switch (state) {
    case 'trial_active':
      return 'blue';
    case 'trial_ending_soon':
      return 'amber';
    case 'trial_ending_very_soon':
    case 'trial_expires_today':
    case 'trial_expired_soft':
    case 'trial_expired_hard':
      return 'red';
    case 'subscribed':
      return 'blue';
  }
}

function getTitleForState(state: OrgTrialStatus, planName: string) {
  switch (state) {
    case 'trial_active':
      return `Free Kilo ${planName} Trial Active`;
    case 'trial_ending_soon':
      return `Free Kilo ${planName} Trial Ending Soon`;
    case 'trial_ending_very_soon':
      return `Free Kilo ${planName} Trial Ending Very Soon`;
    case 'trial_expires_today':
      return `Free Kilo ${planName} Trial Ends Today`;
    case 'trial_expired_soft':
    case 'trial_expired_hard':
      return `Free Kilo ${planName} Trial Has Ended`;
    case 'subscribed':
      return 'Trial Status';
  }
}

function getIconForState(state: OrgTrialStatus) {
  if (state === 'trial_active') return Clock;
  if (state === 'trial_ending_soon') return AlertCircle;
  return AlertTriangle;
}

function getTrialMessage(daysRemaining: number, isOwner: boolean): string {
  const ownerPrefix = isOwner ? 'Your' : "Your organization's";
  const contactOwner = isOwner ? '' : ' Contact an owner to create a subscription.';

  if (daysRemaining === 0) {
    return `${ownerPrefix} trial ends today.${contactOwner}`;
  }

  if (daysRemaining < 0) {
    const daysAgo = Math.abs(daysRemaining);
    const daysText = daysAgo === 1 ? 'day' : 'days';
    return `${ownerPrefix} trial ended ${daysAgo} ${daysText} ago.${contactOwner}`;
  }

  const expiryDate = new Date(Date.now() + daysRemaining * 24 * 60 * 60 * 1000).toLocaleDateString(
    'en-US',
    { month: 'long', day: 'numeric', year: 'numeric' }
  );
  return `${ownerPrefix} trial expires on ${expiryDate}.${contactOwner}`;
}

export function FreeTrialWarningBanner({
  organization,
  daysRemaining,
  userRole,
  onUpgradeClick,
}: FreeTrialWarningBannerProps) {
  const state = getOrgTrialStatusFromDays(daysRemaining);
  const planName = capitalize(organization.plan);
  const title = getTitleForState(state, planName);
  const isOwner = userRole === 'owner';
  const message = getTrialMessage(daysRemaining, isOwner);
  const Icon = getIconForState(state);
  const color = getBannerColor(state);

  return (
    <Banner color={color}>
      <Banner.Icon>
        <Icon />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>
          {title}
          {daysRemaining > 0 && (
            <span className="ml-2 opacity-70">
              &bull; {daysRemaining} {daysRemaining === 1 ? 'day' : 'days'} left
            </span>
          )}
        </Banner.Title>
        <Banner.Description>{message}</Banner.Description>
      </Banner.Content>
      {isOwner && (
        <Banner.Action>
          <Banner.Button onClick={onUpgradeClick}>Upgrade Now</Banner.Button>
        </Banner.Action>
      )}
    </Banner>
  );
}
