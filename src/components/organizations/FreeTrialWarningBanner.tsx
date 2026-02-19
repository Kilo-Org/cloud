'use client';

import { Button } from '@/components/Button';
import type { ButtonVariant } from '@/components/Button';
import { AlertCircle, AlertTriangle, Clock } from 'lucide-react';
import { getOrgTrialStatusFromDays } from '@/lib/organizations/trial-utils';
import type {
  OrgTrialStatus,
  OrganizationRole,
  OrganizationWithMembers,
} from '@/lib/organizations/organization-types';
import { cn, titleCase } from '@/lib/utils';

type FreeTrialWarningBannerProps = {
  organization: OrganizationWithMembers;
  daysRemaining: number;
  userRole: OrganizationRole;
  onUpgradeClick: () => void;
};

function getStylesForState(state: OrgTrialStatus, planName: string) {
  switch (state) {
    case 'trial_active':
      return {
        bg: 'bg-blue-500/10',
        border: 'border-blue-500/50',
        text: 'text-blue-100',
        icon: 'text-blue-400',
        title: `Free Kilo ${planName} Trial Active`,
      };
    case 'trial_ending_soon':
      return {
        bg: 'bg-orange-500/10',
        border: 'border-orange-500/50',
        text: 'text-orange-100',
        icon: 'text-orange-400',
        title: `Free Kilo ${planName} Trial Ending Soon`,
      };
    case 'trial_ending_very_soon':
      return {
        bg: 'bg-red-500/10',
        border: 'border-red-500/50',
        text: 'text-red-100',
        icon: 'text-red-400',
        title: `Free Kilo ${planName} Trial Ending Very Soon`,
      };
    case 'trial_expires_today':
      return {
        bg: 'bg-red-600/20',
        border: 'border-red-600',
        text: 'text-red-100',
        icon: 'text-red-400',
        title: `Free Kilo ${planName} Trial Ends Today`,
      };
    case 'trial_expired_soft':
    case 'trial_expired_hard':
      return {
        bg: 'bg-red-600/20',
        border: 'border-red-600',
        text: 'text-red-100',
        icon: 'text-red-400',
        title: `Free Kilo ${planName} Trial Has Ended`,
      };
    case 'subscribed':
      return {
        bg: 'bg-gray-500/10',
        border: 'border-gray-500/50',
        text: 'text-gray-100',
        icon: 'text-gray-400',
        title: 'Trial Status',
      };
  }
}

function getIconForState(state: OrgTrialStatus, className?: string) {
  const Icon =
    state === 'trial_active' ? Clock : state === 'trial_ending_soon' ? AlertCircle : AlertTriangle;
  return <Icon className={className} />;
}

function getButtonVariantForState(state: OrgTrialStatus): ButtonVariant {
  switch (state) {
    case 'trial_active':
      return 'blue';
    case 'trial_ending_soon':
      return 'warning';
    case 'trial_ending_very_soon':
    case 'trial_expires_today':
    case 'trial_expired_soft':
    case 'trial_expired_hard':
      return 'danger';
    case 'subscribed':
      return 'primary';
  }
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
  const styles = getStylesForState(state, planName);
  const isOwner = userRole === 'owner';
  const buttonVariant = getButtonVariantForState(state);
  const message = getTrialMessage(daysRemaining, isOwner);

  return (
    <div
      className={cn(
        'flex w-full items-center gap-4 border-b p-4',
        styles.bg,
        styles.border,
        styles.text
      )}
    >
      {/* Icon */}
      <div className={cn('flex shrink-0 items-center', styles.icon)}>
        {getIconForState(state, 'h-6 w-6')}
      </div>

      {/* Content */}
      <div className="flex-1">
        <div className="mb-1 flex items-center gap-2 text-sm">
          <span className="font-bold">{styles.title}</span>
          {daysRemaining > 0 && (
            <span className="flex gap-1 opacity-70">
              <span>•</span>
              <span>
                {daysRemaining} {daysRemaining === 1 ? 'day' : 'days'} left
              </span>
            </span>
          )}
        </div>
        <p className="text-sm">{message}</p>
      </div>

      {/* Upgrade button for owners */}
      {isOwner && (
        <Button onClick={onUpgradeClick} variant={buttonVariant} className="shrink-0">
          Upgrade Now
        </Button>
      )}
    </div>
  );
}
