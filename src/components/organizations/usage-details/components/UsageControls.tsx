'use client';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Download } from 'lucide-react';
import type { TimePeriod } from '@/lib/organizations/organization-types';

type UsageControlsProps = {
  showMyUsageOnly: boolean;
  onShowMyUsageOnlyChange: (value: boolean) => void;
  timePeriod: TimePeriod;
  onTimePeriodChange: (value: TimePeriod) => void;
  onExport: () => void;
  canExport: boolean;
  isLoading?: boolean;
};

/**
 * Top control bar for usage details page.
 *
 * Provides controls for:
 * - Toggling "only my usage" filter
 * - Selecting time period (week/month/year/all)
 * - Exporting data to CSV
 */
export function UsageControls({
  showMyUsageOnly,
  onShowMyUsageOnlyChange,
  timePeriod,
  onTimePeriodChange,
  onExport,
  canExport,
  isLoading = false,
}: UsageControlsProps) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-3 whitespace-nowrap">
        <span className="text-sm font-medium">Only my usage</span>
        <Switch checked={showMyUsageOnly} onCheckedChange={onShowMyUsageOnlyChange} />
      </div>
      <Tabs value={timePeriod} onValueChange={value => onTimePeriodChange(value as TimePeriod)}>
        <TabsList>
          <TabsTrigger value="week">Past Week</TabsTrigger>
          <TabsTrigger value="month">Past Month</TabsTrigger>
          <TabsTrigger value="year">Past Year</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={onExport}
              disabled={!canExport || isLoading}
              className="flex items-center"
            >
              <Download className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Export to CSV</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
