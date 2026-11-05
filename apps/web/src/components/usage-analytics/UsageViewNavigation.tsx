'use client';

import type { OrganizationUsageView } from './types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const VIEW_LABELS: Array<{ value: OrganizationUsageView; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'feature-adoption', label: 'Feature adoption' },
  { value: 'ai-usage', label: 'AI usage' },
];

export function getVisibleUsageViews({
  isSalesDemo = false,
  featureAdoptionComplete = false,
}: {
  isSalesDemo?: boolean;
  featureAdoptionComplete?: boolean;
}): OrganizationUsageView[] {
  if (isSalesDemo || featureAdoptionComplete) return ['ai-usage'];
  return VIEW_LABELS.map(view => view.value);
}

export function UsageViewNavigation({
  value,
  onValueChange,
  views: visibleViews,
}: {
  value: OrganizationUsageView;
  onValueChange: (value: OrganizationUsageView) => void;
  views: readonly OrganizationUsageView[];
}) {
  const views = VIEW_LABELS.filter(view => visibleViews.includes(view.value));
  if (views.length < 2) return null;

  return (
    <nav
      className="bg-muted flex w-full gap-1 overflow-x-auto rounded-lg p-1 sm:w-fit"
      aria-label="Usage reports"
    >
      {views.map(view => (
        <Button
          key={view.value}
          type="button"
          variant="ghost"
          size="sm"
          aria-current={value === view.value ? 'page' : undefined}
          className={cn(value === view.value && 'bg-background text-foreground shadow-sm')}
          onClick={() => onValueChange(view.value)}
        >
          {view.label}
        </Button>
      ))}
    </nav>
  );
}
