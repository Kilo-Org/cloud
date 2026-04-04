'use client';

import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Banner } from '@/components/shared/Banner';
import { setReturnUrlAndRedirect } from './InsufficientBalanceBanner.actions';
import { usePathname } from 'next/navigation';

/** Minimum balance required to use features that require credits (in dollars) */
export const MIN_BALANCE_DOLLARS_DEFAULT = 1;

type ColorScheme = 'warning' | 'info';

type ProductNameContent = {
  type: 'productName';
  /** Product name to display in the message (e.g., "App Builder", "Cloud Agent") */
  productName: string;
  minBalance?: number;
};

type CustomContent = {
  type: 'custom';
  /** Custom title text */
  title: string;
  /** Custom description text */
  description: string;
  /** Custom compact action text */
  compactActionText: string;
};

type ContentConfig = ProductNameContent | CustomContent;

type InsufficientBalanceBannerProps = {
  balance: number;
  /** Use 'compact' variant for pages where space is limited */
  variant?: 'default' | 'compact';
  /** Organization ID - when provided, redirects to org credits page instead of personal */
  organizationId?: string;
  /** Color scheme for the banner */
  colorScheme?: ColorScheme;
  /** Content configuration - either product name based (auto-formatted) or custom text */
  content: ContentConfig;
};

const bannerColors: Record<ColorScheme, 'amber' | 'blue'> = {
  warning: 'amber',
  info: 'blue',
};

/**
 * Banner for balance-related messages. Can be used for insufficient balance warnings
 * or informational messages about limited access.
 */
export function InsufficientBalanceBanner({
  balance,
  variant = 'default',
  organizationId,
  colorScheme = 'warning',
  content,
}: InsufficientBalanceBannerProps) {
  const pathname = usePathname();
  const creditsUrl = organizationId ? `/organizations/${organizationId}` : '/credits';

  const handleAddCreditsClick = async () => {
    const redirectUrl = await setReturnUrlAndRedirect(pathname, creditsUrl);
    window.location.href = redirectUrl;
  };

  const formattedBalance = balance.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const isCompact = variant === 'compact';
  const color = bannerColors[colorScheme];
  const IconComponent = colorScheme === 'warning' ? AlertTriangle : Info;

  const displayTitle = (() => {
    if (content.type === 'custom') {
      return content.title;
    }
    return 'Insufficient Balance';
  })();

  const displayDescription = (() => {
    if (content.type === 'custom') {
      return content.description;
    }
    const minBalance = content.minBalance ?? MIN_BALANCE_DOLLARS_DEFAULT;
    const formattedMinBalance = minBalance.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    const actionText = isCompact ? 'continue' : 'start';
    return `${content.productName} requires a minimum balance of ${formattedMinBalance} to ${actionText}.`;
  })();

  const displayCompactActionText = (() => {
    if (content.type === 'custom') {
      return content.compactActionText;
    }
    const actionText = isCompact ? 'continue' : 'start';
    return `Add credits to ${actionText}`;
  })();

  const balanceLabel = colorScheme === 'warning' ? 'Current' : 'Balance';

  if (isCompact) {
    return (
      <Banner color={color} className={cn('flex-col gap-3 rounded-lg p-3 sm:items-start')}>
        <div className="flex items-center gap-2">
          <IconComponent className="h-4 w-4 shrink-0" />
          <span className="text-sm font-bold">{displayTitle}</span>
          <span className="text-xs opacity-70">({formattedBalance})</span>
        </div>
        <div className="flex w-full items-center justify-between gap-2">
          <p className="text-xs opacity-80">{displayCompactActionText}</p>
          <Banner.Button onClick={handleAddCreditsClick} className="shrink-0 text-xs">
            Add Credits
          </Banner.Button>
        </div>
      </Banner>
    );
  }

  return (
    <Banner color={color} className="rounded-lg">
      <Banner.Icon>
        <IconComponent />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>
          {displayTitle}
          <span className="ml-2 opacity-70">
            &bull; {balanceLabel}: {formattedBalance}
          </span>
        </Banner.Title>
        <Banner.Description>{displayDescription}</Banner.Description>
      </Banner.Content>
      <Banner.Action>
        <Banner.Button onClick={handleAddCreditsClick}>Add Credits</Banner.Button>
      </Banner.Action>
    </Banner>
  );
}
