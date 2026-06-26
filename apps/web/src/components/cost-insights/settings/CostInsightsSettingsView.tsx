'use client';

import { AlertCircle, Loader2, Lock, Save, TrendingUp } from 'lucide-react';
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
  const validation = data.validations?.[0];
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
                usage more cost-efficient. Suggestions are on by default and do not change billing
                automatically.
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

          <section
            className="flex flex-col gap-4 p-6 sm:flex-row sm:items-start sm:justify-between"
            aria-labelledby="alerts-setting-title"
          >
            <div className="max-w-2xl">
              <h3 id="alerts-setting-title" className="type-heading">
                Spend Alerts
              </h3>
              <p className="type-body text-muted-foreground mt-1">
                Get email and in-app alerts when hourly spend is unusually high or your 24-hour
                threshold is crossed.
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

          <section className="p-6" aria-labelledby="anomaly-setting-title">
            <div className="flex gap-3">
              <TrendingUp
                className="text-muted-foreground mt-0.5 size-5 shrink-0"
                aria-hidden="true"
              />
              <div>
                <h3 id="anomaly-setting-title" className="type-body font-semibold">
                  Unusual hourly spend
                </h3>
                <p className="type-body text-muted-foreground mt-1 max-w-2xl">
                  Kilo compares usage-based spend in the current hour with your recent hourly
                  pattern. This alert is included whenever Spend Alerts are on.
                </p>
              </div>
            </div>
          </section>

          <section className="p-6" aria-labelledby="threshold-setting-title">
            <div className="grid gap-5 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
              <div>
                <h3 id="threshold-setting-title" className="type-body font-semibold">
                  24-hour spend threshold
                </h3>
                <p className="type-label text-muted-foreground mt-1">
                  Optional. Includes all Credit spend in a rolling 24-hour period.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="spend-threshold">Threshold amount (USD)</Label>
                <div className="relative">
                  <span
                    className="type-body text-muted-foreground absolute inset-y-0 left-3 flex items-center"
                    aria-hidden="true"
                  >
                    $
                  </span>
                  <Input
                    id="spend-threshold"
                    className="h-control-touch pl-7 font-mono tabular-nums md:h-control-default"
                    type="text"
                    inputMode="decimal"
                    value={data.thresholdUsd}
                    readOnly={data.readOnly}
                    disabled={disabled}
                    onChange={event => onChange?.({ thresholdUsd: event.target.value })}
                    aria-invalid={Boolean(validation)}
                    aria-describedby="threshold-help threshold-error"
                  />
                </div>
                <p id="threshold-help" className="type-label text-muted-foreground">
                  Leave blank to turn off threshold alerts. You can save this amount while Spend
                  Alerts are off.
                </p>
                {validation && (
                  <p id="threshold-error" className="type-label text-status-destructive">
                    {validation}
                  </p>
                )}
              </div>
            </div>
          </section>
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
              data.saveState === 'saved' || data.saveState === 'saving' || Boolean(validation)
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
