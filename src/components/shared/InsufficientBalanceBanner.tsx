'use client';

import { AlertTriangle, Info, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/Button';
import { cn } from '@/lib/utils';
import { setReturnUrlAndRedirect } from './InsufficientBalanceBanner.actions';
import { usePathname } from 'next/navigation';

/** Minimum balance required to use features that require credits (in dollars) */
export const MIN_BALANCE_DOLLARS_DEFAULT = 1;

type ColorScheme = 'warning' | 'info';

type ColorSchemeConfig = {
  border: string;
  bg: string;
  text: string;
  iconColor: string;
  Icon: LucideIcon;
  buttonVariant: 'warning' | 'secondary';
  buttonClassName?: string;
};

const colorSchemes: Record<ColorScheme, ColorSchemeConfig> = {
  warning: {
    border: 'border-yellow-500/50',
    bg: 'bg-yellow-500/10',
    text: 'text-yellow-100',
    iconColor: 'text-yellow-400',
    Icon: AlertTriangle,
    buttonVariant: 'warning',
  },
  info: {
    border: 'border-blue-500/50',
    bg: 'bg-blue-500/10',
    text: 'text-blue-100',
    iconColor: 'text-blue-400',
    Icon: Info,
    buttonVariant: 'secondary',
    buttonClassName: 'border-blue-500/50 bg-blue-500/20 hover:bg-blue-500/30',
  },
};

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
    // Set the return URL cookie before redirecting
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
  const scheme = colorSchemes[colorScheme];
  const { Icon } = scheme;

  // Derive display values based on content type
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
      <div
        className={cn(
          'flex w-full flex-col gap-3 rounded-lg border p-3',
          scheme.border,
          scheme.bg,
          scheme.text
        )}
      >
        {/* Header row */}
        <div className="flex items-center gap-2">
          <Icon className={cn('h-4 w-4 shrink-0', scheme.iconColor)} />
          <span className="text-sm font-bold">{displayTitle}</span>
          <span className="text-xs opacity-70">({formattedBalance})</span>
        </div>

        {/* Action row */}
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs opacity-80">{displayCompactActionText}</p>
          <Button
            variant={scheme.buttonVariant}
            size="sm"
            className={cn('shrink-0', scheme.buttonClassName)}
            onClick={handleAddCreditsClick}
          >
            Add Credits
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex w-full items-center gap-4 rounded-lg border p-4',
        scheme.border,
        scheme.bg,
        scheme.text
      )}
    >
      {/* Icon */}
      <div className={cn('flex shrink-0 items-center', scheme.iconColor)}>
        <Icon className="h-6 w-6" />
      </div>

      {/* Content */}
      <div className="flex-1">
        <div className="mb-1 flex items-center gap-2 text-sm">
          <span className="font-bold">{displayTitle}</span>
          <span className="flex gap-1 opacity-70">
            <span>•</span>
            <span>
              {balanceLabel}: {formattedBalance}
            </span>
          </span>
        </div>
        {displayDescription && <p className="text-sm">{displayDescription}</p>}
      </div>

      {/* Add Credits button */}
      <Button
        variant={scheme.buttonVariant}
        className={cn('shrink-0', scheme.buttonClassName)}
        onClick={handleAddCreditsClick}
      >
        Add Credits
      </Button>
    </div>
  );
}
