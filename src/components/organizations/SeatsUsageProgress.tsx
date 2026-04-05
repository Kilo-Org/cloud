'use client';

import { Progress } from '@/components/ui/progress';

type Props = {
  usedSeats: number;
  totalSeats: number;
  className?: string;
  showTitle?: boolean;
  showWarnings?: boolean;
  size?: 'sm' | 'md' | 'lg';
  isTrial: boolean;
};

export function SeatsUsageProgress({
  usedSeats,
  totalSeats,
  className = '',
  showTitle = true,
  showWarnings = true,
  size = 'md',
  isTrial,
}: Props) {
  // Handle special case where totalSeats is 0 but usedSeats > 0
  const usagePercentage =
    totalSeats > 0 ? Math.min((usedSeats / totalSeats) * 100, 100) : usedSeats > 0 ? 100 : 0;
  const isNearLimit = usagePercentage > 80 && usedSeats < totalSeats;
  const isAtLimit = usedSeats >= totalSeats && totalSeats > 0;
  const isOverLimit = usedSeats > totalSeats || (totalSeats === 0 && usedSeats > 0);
  const availableSeats = Math.max(totalSeats - usedSeats, 0);

  const sizeClasses = {
    sm: 'h-1.5',
    md: 'h-2',
    lg: 'h-3',
  };

  const textSizeClasses = {
    sm: 'text-xs',
    md: 'text-xs',
    lg: 'text-sm',
  };

  return (
    <div className={`space-y-2 ${className}`}>
      {!isTrial && showTitle && (
        <div className={`text-muted-foreground ${textSizeClasses[size]}`}>
          {usedSeats} of {totalSeats} seats used
        </div>
      )}
      <Progress
        value={isTrial ? 0 : usagePercentage}
        className={`${sizeClasses[size]} ${
          isTrial
            ? 'bg-muted *:bg-transparent'
            : isOverLimit
              ? '*:bg-red-600'
              : isNearLimit
                ? '*:bg-amber-600'
                : ''
        }`}
      />
      {!isTrial && (
        <div className={`text-muted-foreground flex justify-between ${textSizeClasses[size]}`}>
          <span>{usedSeats} used</span>
          <span>{availableSeats} available</span>
        </div>
      )}
      {!isTrial && showWarnings && isOverLimit && (
        <p className={`font-medium text-red-400 ${textSizeClasses[size]}`}>
          You&apos;ve exceeded your seat limit by {usedSeats - totalSeats} seat
          {usedSeats - totalSeats !== 1 ? 's' : ''}. Upgrade your plan immediately.
        </p>
      )}
      {!isTrial && showWarnings && isAtLimit && !isOverLimit && (
        <p className={`font-medium text-yellow-200 ${textSizeClasses[size]}`}>
          You&apos;ve reached your seat limit. Upgrade your plan to add more members.
        </p>
      )}
      {!isTrial && showWarnings && isNearLimit && !isAtLimit && !isOverLimit && (
        <p className={`font-medium text-yellow-200 ${textSizeClasses[size]}`}>
          You&apos;re approaching your seat limit.
        </p>
      )}
    </div>
  );
}
