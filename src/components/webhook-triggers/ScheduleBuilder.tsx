'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CronPreview } from './CronPreview';
import { CronExpressionInput } from './CronExpressionInput';
import { cn } from '@/lib/utils';
import { Code } from 'lucide-react';

type ScheduleBuilderProps = {
  cronExpression: string;
  onCronExpressionChange: (value: string) => void;
  timezone: string;
  disabled?: boolean;
};

// ============================================================================
// Simple schedule types
// ============================================================================

type Frequency = 'every-n-minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

type SimpleSchedule = {
  frequency: Frequency;
  minute: number; // 0-59
  hour: number; // 0-23
  intervalMinutes: number; // for every-n-minutes
  days: boolean[]; // [Sun, Mon, Tue, Wed, Thu, Fri, Sat]
  monthDay: number; // 1-31
};

const DEFAULT_SCHEDULE: SimpleSchedule = {
  frequency: 'daily',
  minute: 0,
  hour: 9,
  intervalMinutes: 10,
  days: [false, true, true, true, true, true, false], // weekdays
  monthDay: 1,
};

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const FREQUENCY_OPTIONS: { value: Frequency; label: string }[] = [
  { value: 'every-n-minutes', label: 'Every N minutes' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays (Mon-Fri)' },
  { value: 'weekly', label: 'Weekly on specific days' },
  { value: 'monthly', label: 'Monthly' },
];

// ============================================================================
// Cron <-> Simple conversion
// ============================================================================

function scheduleToCron(s: SimpleSchedule): string {
  switch (s.frequency) {
    case 'every-n-minutes':
      return `*/${s.intervalMinutes} * * * *`;
    case 'hourly':
      return `${s.minute} * * * *`;
    case 'daily':
      return `${s.minute} ${s.hour} * * *`;
    case 'weekdays':
      return `${s.minute} ${s.hour} * * 1-5`;
    case 'weekly': {
      const dayNums = s.days.map((on, i) => (on ? i : -1)).filter(i => i >= 0);
      if (dayNums.length === 0) return `${s.minute} ${s.hour} * * *`; // fallback to daily
      return `${s.minute} ${s.hour} * * ${dayNums.join(',')}`;
    }
    case 'monthly':
      return `${s.minute} ${s.hour} ${s.monthDay} * *`;
  }
}

/**
 * Try to parse a cron expression into a simple schedule.
 * Returns null if the expression can't be represented in simple mode.
 */
function cronToSchedule(cron: string): SimpleSchedule | null {
  if (!cron.trim()) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minPart, hourPart, dayPart, monthPart, dowPart] = parts;

  // every N minutes: */N * * * *
  if (
    minPart.startsWith('*/') &&
    hourPart === '*' &&
    dayPart === '*' &&
    monthPart === '*' &&
    dowPart === '*'
  ) {
    const n = parseInt(minPart.slice(2), 10);
    if (!isNaN(n) && n >= 1 && n <= 59) {
      return { ...DEFAULT_SCHEDULE, frequency: 'every-n-minutes', intervalMinutes: n };
    }
  }

  // hourly: N * * * *
  if (
    /^\d+$/.test(minPart) &&
    hourPart === '*' &&
    dayPart === '*' &&
    monthPart === '*' &&
    dowPart === '*'
  ) {
    const min = parseInt(minPart, 10);
    if (min >= 0 && min <= 59) {
      return { ...DEFAULT_SCHEDULE, frequency: 'hourly', minute: min };
    }
  }

  // Need a fixed minute and hour for the remaining patterns
  if (!/^\d+$/.test(minPart) || !/^\d+$/.test(hourPart)) return null;
  const minute = parseInt(minPart, 10);
  const hour = parseInt(hourPart, 10);
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;

  // monthly: M H D * *
  if (/^\d+$/.test(dayPart) && monthPart === '*' && dowPart === '*') {
    const day = parseInt(dayPart, 10);
    if (day >= 1 && day <= 31) {
      return { ...DEFAULT_SCHEDULE, frequency: 'monthly', minute, hour, monthDay: day };
    }
  }

  if (dayPart !== '*' || monthPart !== '*') return null;

  // daily: M H * * *
  if (dowPart === '*') {
    return { ...DEFAULT_SCHEDULE, frequency: 'daily', minute, hour };
  }

  // weekdays: M H * * 1-5
  if (dowPart === '1-5') {
    return { ...DEFAULT_SCHEDULE, frequency: 'weekdays', minute, hour };
  }

  // weekly: M H * * 0,1,3 etc
  if (/^[0-6](,[0-6])*$/.test(dowPart)) {
    const dayNums = dowPart.split(',').map(Number);
    const days = [false, false, false, false, false, false, false];
    for (const d of dayNums) days[d] = true;
    return { ...DEFAULT_SCHEDULE, frequency: 'weekly', minute, hour, days };
  }

  return null;
}

function formatTime12h(hour: number, minute: number): string {
  const period = hour >= 12 ? 'PM' : 'AM';
  const h = hour % 12 || 12;
  const m = minute.toString().padStart(2, '0');
  return `${h}:${m} ${period}`;
}

// ============================================================================
// Main Component
// ============================================================================

export const ScheduleBuilder = memo(function ScheduleBuilder({
  cronExpression,
  onCronExpressionChange,
  timezone,
  disabled,
}: ScheduleBuilderProps) {
  // Determine if the current cron can be shown in simple mode
  const parsedSchedule = useMemo(() => cronToSchedule(cronExpression), [cronExpression]);
  const canShowSimple = parsedSchedule !== null || !cronExpression.trim();

  const [isAdvanced, setIsAdvanced] = useState(!canShowSimple);
  const [schedule, setSchedule] = useState<SimpleSchedule>(parsedSchedule ?? DEFAULT_SCHEDULE);

  // Sync simple schedule -> cron expression
  const updateSchedule = useCallback(
    (updates: Partial<SimpleSchedule>) => {
      const newSchedule = { ...schedule, ...updates };
      setSchedule(newSchedule);
      onCronExpressionChange(scheduleToCron(newSchedule));
    },
    [schedule, onCronExpressionChange]
  );

  // When switching from advanced to simple, try to parse the current cron
  const switchToSimple = useCallback(() => {
    const parsed = cronToSchedule(cronExpression);
    if (parsed) {
      setSchedule(parsed);
      setIsAdvanced(false);
    }
  }, [cronExpression]);

  // When switching to advanced, keep the current cron expression
  const switchToAdvanced = useCallback(() => {
    setIsAdvanced(true);
  }, []);

  // When editing in simple mode, seed the cron on mount if empty
  useEffect(() => {
    if (!isAdvanced && !cronExpression.trim()) {
      onCronExpressionChange(scheduleToCron(schedule));
    }
    // Intentional: only seed cron on initial mount, not on every render.
    // Closes over onCronExpressionChange and schedule which are stable at mount time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isAdvanced) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Cron Expression</Label>
          {canShowSimple && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={switchToSimple}
              className="text-muted-foreground h-auto p-0 text-xs hover:underline"
            >
              Simple mode
            </Button>
          )}
        </div>
        <CronExpressionInput
          value={cronExpression}
          onChange={onCronExpressionChange}
          disabled={disabled}
          required
        />
        {cronExpression.trim() && <CronPreview expression={cronExpression} timezone={timezone} />}
      </div>
    );
  }

  const showTimeFields = schedule.frequency !== 'every-n-minutes';

  return (
    <div className="space-y-4">
      {/* Frequency */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Repeat</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={switchToAdvanced}
            className="text-muted-foreground h-auto gap-1 p-0 text-xs hover:underline"
          >
            <Code className="h-3 w-3" />
            Advanced
          </Button>
        </div>
        <Select
          value={schedule.frequency}
          onValueChange={(v: Frequency) => updateSchedule({ frequency: v })}
          disabled={disabled}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FREQUENCY_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Interval for every-n-minutes */}
      {schedule.frequency === 'every-n-minutes' && (
        <div className="space-y-2">
          <Label className="text-xs">Every</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={10}
              max={59}
              value={schedule.intervalMinutes}
              onChange={e =>
                updateSchedule({
                  intervalMinutes: Math.max(10, Math.min(59, parseInt(e.target.value, 10) || 10)),
                })
              }
              className="w-20"
              disabled={disabled}
            />
            <span className="text-muted-foreground text-sm">minutes</span>
          </div>
        </div>
      )}

      {/* Time picker */}
      {showTimeFields && (
        <div className="space-y-2">
          <Label className="text-xs">At</Label>
          <div className="flex items-center gap-2">
            <Select
              value={String(schedule.hour)}
              onValueChange={v => updateSchedule({ hour: parseInt(v, 10) })}
              disabled={disabled}
            >
              <SelectTrigger className="w-[100px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-[200px]">
                {Array.from({ length: 24 }, (_, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {formatTime12h(i, 0).split(':')[0]} {i >= 12 ? 'PM' : 'AM'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">:</span>
            <Select
              value={String(schedule.minute)}
              onValueChange={v => updateSchedule({ minute: parseInt(v, 10) })}
              disabled={disabled}
            >
              <SelectTrigger className="w-[80px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-[200px]">
                {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                  <SelectItem key={m} value={String(m)}>
                    {String(m).padStart(2, '0')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* Day of week toggles */}
      {schedule.frequency === 'weekly' && (
        <div className="space-y-2">
          <Label className="text-xs">Repeat on</Label>
          <div className="flex gap-1">
            {DAY_LABELS.map((label, i) => (
              <button
                key={i}
                type="button"
                disabled={disabled}
                onClick={() => {
                  const newDays = [...schedule.days];
                  // Prevent deselecting the last day — at least one must remain
                  if (newDays[i] && newDays.filter(Boolean).length <= 1) return;
                  newDays[i] = !newDays[i];
                  updateSchedule({ days: newDays });
                }}
                title={DAY_NAMES[i]}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-colors',
                  schedule.days[i]
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Day of month */}
      {schedule.frequency === 'monthly' && (
        <div className="space-y-2">
          <Label className="text-xs">Day of month</Label>
          <Select
            value={String(schedule.monthDay)}
            onValueChange={v => updateSchedule({ monthDay: parseInt(v, 10) })}
            disabled={disabled}
          >
            <SelectTrigger className="w-[80px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-[200px]">
              {Array.from({ length: 31 }, (_, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>
                  {i + 1}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Summary + Preview */}
      {cronExpression.trim() && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            Cron: <code className="bg-muted rounded px-1">{cronExpression}</code>
          </p>
          <CronPreview expression={cronExpression} timezone={timezone} />
        </div>
      )}
    </div>
  );
});
