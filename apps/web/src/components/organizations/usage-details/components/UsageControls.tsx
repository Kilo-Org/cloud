'use client';
import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Download, ChevronDown, Calendar } from 'lucide-react';
import { format, subDays, subMonths, subYears, startOfMonth } from 'date-fns';

export type DateRangePreset =
  | 'last_7_days'
  | 'last_30_days'
  | 'this_month'
  | 'last_month'
  | 'last_year'
  | 'all'
  | 'custom';

type DateRangeSelection = {
  preset: DateRangePreset;
  startDate: string;
  endDate: string;
  label: string;
};

function computePresetRange(preset: Exclude<DateRangePreset, 'custom'>): {
  startDate: string;
  endDate: string;
} {
  const now = new Date();
  switch (preset) {
    case 'last_7_days':
      return { startDate: subDays(now, 7).toISOString(), endDate: now.toISOString() };
    case 'last_30_days':
      return { startDate: subDays(now, 30).toISOString(), endDate: now.toISOString() };
    case 'this_month':
      return { startDate: startOfMonth(now).toISOString(), endDate: now.toISOString() };
    case 'last_month': {
      const lastMonthStart = startOfMonth(subMonths(now, 1));
      const lastMonthEnd = subDays(startOfMonth(now), 1);
      lastMonthEnd.setHours(23, 59, 59, 999);
      return { startDate: lastMonthStart.toISOString(), endDate: lastMonthEnd.toISOString() };
    }
    case 'last_year':
      return { startDate: subYears(now, 1).toISOString(), endDate: now.toISOString() };
    case 'all':
      return { startDate: new Date('2020-01-01').toISOString(), endDate: now.toISOString() };
  }
}

const PRESET_LABELS: Record<Exclude<DateRangePreset, 'custom'>, string> = {
  last_7_days: 'Last 7 days',
  last_30_days: 'Last 30 days',
  this_month: 'This month',
  last_month: 'Last month',
  last_year: 'Last year',
  all: 'All time',
};

const PRESET_ORDER: Exclude<DateRangePreset, 'custom'>[] = [
  'last_7_days',
  'last_30_days',
  'this_month',
  'last_month',
  'last_year',
  'all',
];

function formatRangeLabel(selection: DateRangeSelection): string {
  if (selection.preset !== 'custom') {
    return selection.label;
  }
  const start = format(new Date(selection.startDate), 'MMM d, yyyy');
  const end = format(new Date(selection.endDate), 'MMM d, yyyy');
  return `${start} - ${end}`;
}

type UsageControlsProps = {
  showMyUsageOnly: boolean;
  onShowMyUsageOnlyChange: (value: boolean) => void;
  dateRange: DateRangeSelection;
  onDateRangeChange: (range: DateRangeSelection) => void;
  onExport: () => void;
  canExport: boolean;
  isLoading?: boolean;
};

/**
 * Top control bar for usage details page.
 *
 * Provides controls for:
 * - Toggling "only my usage" filter
 * - Selecting date range (presets or custom)
 * - Exporting data to CSV
 */
export function UsageControls({
  showMyUsageOnly,
  onShowMyUsageOnlyChange,
  dateRange,
  onDateRangeChange,
  onExport,
  canExport,
  isLoading = false,
}: UsageControlsProps) {
  const [open, setOpen] = useState(false);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  function handlePresetSelect(preset: Exclude<DateRangePreset, 'custom'>) {
    const range = computePresetRange(preset);
    onDateRangeChange({
      preset,
      ...range,
      label: PRESET_LABELS[preset],
    });
    setOpen(false);
  }

  function handleCustomApply() {
    if (!customStart || !customEnd) return;
    const startDate = new Date(customStart);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(customEnd);
    endDate.setHours(23, 59, 59, 999);
    if (startDate > endDate) return;

    onDateRangeChange({
      preset: 'custom',
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      label: 'Custom range',
    });
    setOpen(false);
  }

  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-3 whitespace-nowrap">
        <span className="text-sm font-medium">Only my usage</span>
        <Switch checked={showMyUsageOnly} onCheckedChange={onShowMyUsageOnlyChange} />
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            <span className="max-w-48 truncate">{formatRangeLabel(dateRange)}</span>
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-0">
          <div className="flex flex-col">
            {PRESET_ORDER.map(preset => (
              <button
                key={preset}
                type="button"
                onClick={() => handlePresetSelect(preset)}
                className={`hover:bg-accent hover:text-accent-foreground px-4 py-2 text-left text-sm transition-colors ${
                  dateRange.preset === preset ? 'bg-accent text-accent-foreground font-medium' : ''
                }`}
              >
                {PRESET_LABELS[preset]}
              </button>
            ))}
            <div className="border-t px-4 py-3">
              <p className="text-muted-foreground mb-2 text-xs font-medium">Custom range</p>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Input
                    type="date"
                    value={customStart}
                    onChange={e => setCustomStart(e.target.value)}
                    className="h-8 text-xs"
                    max={customEnd || undefined}
                  />
                  <span className="text-muted-foreground text-xs">to</span>
                  <Input
                    type="date"
                    value={customEnd}
                    onChange={e => setCustomEnd(e.target.value)}
                    className="h-8 text-xs"
                    min={customStart || undefined}
                    max={format(new Date(), 'yyyy-MM-dd')}
                  />
                </div>
                <Button
                  size="sm"
                  onClick={handleCustomApply}
                  disabled={!customStart || !customEnd}
                  className="h-7 text-xs"
                >
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
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

export type { DateRangeSelection };
export { computePresetRange };
