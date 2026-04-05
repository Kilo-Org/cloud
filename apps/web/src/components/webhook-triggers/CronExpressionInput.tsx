'use client';

import { memo, useMemo } from 'react';
import { Cron } from 'croner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';

type CronExpressionInputProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  /** Compact mode hides the label and presets (used in inline forms) */
  compact?: boolean;
};

const PRESETS = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Daily 9 AM', value: '0 9 * * *' },
  { label: 'Weekdays 9 AM', value: '0 9 * * 1-5' },
  { label: 'Every 10 min', value: '*/10 * * * *' },
];

/**
 * Validate a cron expression client-side and return a human-friendly error.
 * Mirrors validateCronExpression + enforcesMinimumInterval in src/lib/cron-validation.ts
 * (which is server-only). Keep the two in sync if validation rules change.
 */
function validateCron(expression: string): string | null {
  if (!expression.trim()) return null; // empty is handled by required check
  try {
    const job = new Cron(expression);
    // Check minimum interval (10 minutes)
    const first = job.nextRun();
    if (first) {
      const second = job.nextRun(first);
      if (second && second.getTime() - first.getTime() < 600_000) {
        return 'Schedule must run at most once every 10 minutes';
      }
    }
    return null; // valid
  } catch {
    return 'This doesn\'t look like a valid schedule. Use 5 space-separated fields: minute hour day month weekday (e.g. "0 9 * * *" for daily at 9 AM)';
  }
}

export const CronExpressionInput = memo(function CronExpressionInput({
  value,
  onChange,
  disabled,
  required,
  compact,
}: CronExpressionInputProps) {
  const error = useMemo(() => validateCron(value), [value]);

  return (
    <div className="space-y-2">
      {!compact && (
        <Label htmlFor="cronExpression">
          Cron Expression {required && <span className="text-red-400">*</span>}
        </Label>
      )}

      <Input
        id="cronExpression"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="0 9 * * *"
        disabled={disabled}
        className={`font-mono text-${compact ? 'xs' : 'sm'} ${error ? 'border-destructive' : ''}`}
        maxLength={100}
        aria-invalid={!!error}
      />

      {error ? (
        <p className="flex items-start gap-1 text-xs text-red-400">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          {error}
        </p>
      ) : (
        !compact && (
          <p className="text-muted-foreground text-xs">
            5 fields: minute (0-59), hour (0-23), day (1-31), month (1-12), weekday (0-6, Sun=0)
          </p>
        )
      )}

      {/* Quick presets */}
      {!compact && (
        <div className="flex flex-wrap gap-1">
          {PRESETS.map(preset => (
            <Button
              key={preset.value}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => onChange(preset.value)}
              disabled={disabled}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
});
