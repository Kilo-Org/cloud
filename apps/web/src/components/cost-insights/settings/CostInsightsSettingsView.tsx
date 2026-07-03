'use client';

import { AlertCircle, Loader2, Lock, Save } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { CostInsightsSettingsData, CostInsightsSettingsPatch } from '../types';

export function CostInsightsSettingsView({
  data,
  onChange,
  onSave,
}: {
  data: CostInsightsSettingsData;
  onChange?: (patch: CostInsightsSettingsPatch) => void;
  onSave?: () => void;
}) {
  const thresholdValidation = data.validations?.thresholdUsd;
  const threshold7DayValidation = data.validations?.threshold7DayUsd;
  const threshold30DayValidation = data.validations?.threshold30DayUsd;
  const hasValidationError = Boolean(
    thresholdValidation || threshold7DayValidation || threshold30DayValidation
  );
  const saveLabel = data.saveState === 'saving' ? 'Saving changes...' : 'Save changes';
  const disabled = data.readOnly || data.saveState === 'saving';
  return (
    <div className="space-y-6">
      {data.readOnly && (
        <Alert>
          <Lock className="size-4" aria-hidden="true" />
          <AlertTitle>Read-only admin view</AlertTitle>
          <AlertDescription>
            Only an organization owner or billing manager can change these settings.
          </AlertDescription>
        </Alert>
      )}
      {data.saveState === 'error' && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" aria-hidden="true" />
          <AlertTitle>Settings could not save</AlertTitle>
          <AlertDescription>Check your connection and try again.</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="divide-border divide-y p-0">
          <section
            className="flex flex-col gap-4 p-6 sm:flex-row sm:items-start sm:justify-between"
            aria-labelledby="suggestions-setting-title"
          >
            <div className="max-w-2xl">
              <h3 id="suggestions-setting-title" className="type-heading">
                Cost Suggestions
              </h3>
              <p className="type-body text-muted-foreground mt-1">
                Get email and in-app recommendations when a Coding Plan or Kilo Pass may make your
                usage more cost-efficient.
              </p>
            </div>
            <div className="flex min-h-control-touch items-center gap-3">
              <span className="type-label text-muted-foreground" aria-hidden="true">
                {data.suggestionsEnabled ? 'On' : 'Off'}
              </span>
              <Label htmlFor="cost-suggestions-enabled" className="sr-only">
                Cost Suggestions
              </Label>
              <Switch
                id="cost-suggestions-enabled"
                className="relative before:absolute before:inset-x-0 before:-inset-y-2.5"
                checked={data.suggestionsEnabled}
                disabled={disabled}
                onCheckedChange={suggestionsEnabled => onChange?.({ suggestionsEnabled })}
              />
            </div>
          </section>

          <div>
            <section
              className="flex flex-col gap-4 p-6 sm:flex-row sm:items-start sm:justify-between"
              aria-labelledby="alerts-setting-title"
            >
              <div className="max-w-2xl">
                <h3 id="alerts-setting-title" className="type-heading">
                  Spend Alerts
                </h3>
                <p className="type-body text-muted-foreground mt-1">
                  Get email and in-app alerts for unusual hourly spend and rolling spend thresholds.
                </p>
              </div>
              <div className="flex min-h-control-touch items-center gap-3">
                <span className="type-label text-muted-foreground" aria-hidden="true">
                  {data.enabled ? 'On' : 'Off'}
                </span>
                <Label htmlFor="spend-alerts-enabled" className="sr-only">
                  Spend Alerts
                </Label>
                <Switch
                  id="spend-alerts-enabled"
                  className="relative before:absolute before:inset-x-0 before:-inset-y-2.5"
                  checked={data.enabled}
                  disabled={disabled}
                  onCheckedChange={enabled => onChange?.({ enabled })}
                />
              </div>
            </section>

            <div className="border-border ml-6 divide-y border-l sm:ml-10">
              {!data.enabled && (
                <p className="type-label text-muted-foreground px-6 py-4" role="status">
                  Spend Alerts are off. Saved anomaly and threshold settings apply when you turn
                  Spend Alerts on again.
                </p>
              )}
              <section
                className="grid gap-5 px-6 py-5 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]"
                aria-labelledby="anomaly-setting-title"
              >
                <div>
                  <h3 id="anomaly-setting-title" className="type-body font-semibold">
                    Spend anomalies
                  </h3>
                  <p className="type-label text-muted-foreground mt-1">
                    Compare current-hour usage-based spend with your recent hourly pattern.
                  </p>
                </div>
                <div className="flex min-h-control-touch items-center gap-3 md:justify-end">
                  <span className="type-label text-muted-foreground" aria-hidden="true">
                    {data.anomalyAlertsEnabled ? 'On' : 'Off'}
                  </span>
                  <Label htmlFor="spend-anomalies-enabled" className="sr-only">
                    Spend anomalies
                  </Label>
                  <Switch
                    id="spend-anomalies-enabled"
                    className="relative before:absolute before:inset-x-0 before:-inset-y-2.5"
                    checked={data.anomalyAlertsEnabled}
                    disabled={disabled}
                    onCheckedChange={anomalyAlertsEnabled => onChange?.({ anomalyAlertsEnabled })}
                  />
                </div>
              </section>

              <ThresholdOption
                id="spend-threshold-24h"
                title="24-hour spend threshold"
                description="Optional. Includes all Credit spend in a rolling 24-hour period."
                value={data.thresholdUsd}
                validation={thresholdValidation}
                disabled={disabled}
                readOnly={data.readOnly}
                onChange={thresholdUsd => onChange?.({ thresholdUsd })}
              />

              <ThresholdOption
                id="spend-threshold-7d"
                title="7-day spend threshold"
                description="Optional. Includes all Credit spend in a rolling 7-day period."
                value={data.threshold7DayUsd ?? ''}
                validation={threshold7DayValidation}
                disabled={disabled}
                readOnly={data.readOnly}
                onChange={threshold7DayUsd => onChange?.({ threshold7DayUsd })}
              />

              <ThresholdOption
                id="spend-threshold-30d"
                title="30-day spend threshold"
                description="Optional. Includes all Credit spend in a rolling 30-day period."
                value={data.threshold30DayUsd}
                validation={threshold30DayValidation}
                disabled={disabled}
                readOnly={data.readOnly}
                onChange={threshold30DayUsd => onChange?.({ threshold30DayUsd })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {!data.readOnly && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          <span
            className={cn(
              'type-label sm:mr-auto',
              data.saveState === 'error' ? 'text-status-destructive' : 'text-muted-foreground'
            )}
            aria-live="polite"
          >
            {data.saveState === 'saved'
              ? 'All changes saved'
              : data.saveState === 'dirty'
                ? 'Unsaved changes'
                : data.saveState === 'error'
                  ? 'Save failed'
                  : 'Saving changes...'}
          </span>
          <Button
            type="button"
            className="min-h-control-touch sm:min-h-0"
            disabled={
              data.saveState === 'saved' || data.saveState === 'saving' || hasValidationError
            }
            aria-busy={data.saveState === 'saving'}
            onClick={onSave}
          >
            {data.saveState === 'saving' ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Save className="size-4" aria-hidden="true" />
            )}
            {saveLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

function ThresholdOption({
  id,
  title,
  description,
  value,
  validation,
  disabled,
  readOnly,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  value: string;
  validation?: string;
  disabled: boolean;
  readOnly?: boolean;
  onChange: (value: string) => void;
}) {
  const inputId = `${id}-input`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  return (
    <section id={id} className="scroll-mt-6 px-6 py-5" aria-labelledby={`${id}-title`}>
      <div className="grid gap-5 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div>
          <h3 id={`${id}-title`} className="type-body font-semibold">
            {title}
          </h3>
          <p className="type-label text-muted-foreground mt-1">{description}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={inputId}>{title} amount (USD)</Label>
          <div className="relative">
            <span
              className="type-body text-muted-foreground absolute inset-y-0 left-3 flex items-center"
              aria-hidden="true"
            >
              $
            </span>
            <Input
              id={inputId}
              className="h-control-touch pl-7 font-mono tabular-nums md:h-control-default"
              type="text"
              inputMode="decimal"
              value={value}
              readOnly={readOnly}
              disabled={disabled}
              onChange={event => onChange(event.target.value)}
              aria-invalid={Boolean(validation)}
              aria-describedby={validation ? `${helpId} ${errorId}` : helpId}
            />
          </div>
          <p id={helpId} className="type-label text-muted-foreground">
            Leave blank to turn off this threshold.
          </p>
          {validation && (
            <p id={errorId} className="type-label text-status-destructive">
              {validation}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
