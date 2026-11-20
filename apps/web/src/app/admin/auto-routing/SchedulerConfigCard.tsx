'use client';

import { adminFetch } from '@/lib/admin/admin-fetch';

import {
  BENCHMARK_CONTAINER_BUDGET,
  BENCHMARK_SCHEDULER_SETTING_KEYS,
  BENCHMARK_SPEND_CAP_KEYS,
  BenchmarkSchedulerConfigResponseSchema,
  BenchmarkSchedulerConfigUpdateSchema,
  type BenchmarkSchedulerConfigResponse,
  type BenchmarkSchedulerConfigUpdate,
  type BenchmarkSchedulerSetting,
  type BenchmarkSchedulerSettingKey,
  type BenchmarkSpendCapKey,
  type BenchmarkSpendCapSetting,
} from '@kilocode/auto-routing-contracts';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { parseAdminResponse } from './admin-fetch';

const SCHEDULER_CONFIG_URL = '/admin/api/auto-routing/benchmark-scheduler-config';
const SCHEDULER_CONFIG_QUERY_KEY = ['auto-routing', 'benchmark-scheduler-config'];

const SETTING_LABELS: Record<BenchmarkSchedulerSettingKey, string> = {
  slots: 'Container slots',
  modelConcurrency: 'Per-model concurrency',
};

const SPEND_CAP_LABELS: Record<BenchmarkSpendCapKey, string> = {
  perRunUsd: 'Max per run (USD)',
  perDayUsd: 'Max per UTC day (USD)',
  perOwnerDayUsd: 'Max per owner per day (USD)',
};

type SchedulerOverrideForm = Record<BenchmarkSchedulerSettingKey, string>;
type SpendCapForm = Record<BenchmarkSpendCapKey, string>;

async function fetchSchedulerConfig() {
  const response = await adminFetch(SCHEDULER_CONFIG_URL);
  return parseAdminResponse(response, BenchmarkSchedulerConfigResponseSchema);
}

async function saveSchedulerConfig(overrides: BenchmarkSchedulerUpdate) {
  const response = await adminFetch(SCHEDULER_CONFIG_URL, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(overrides),
  });
  return parseAdminResponse(response, BenchmarkSchedulerConfigResponseSchema);
}

function settingStatus(setting: BenchmarkSchedulerSetting): string {
  if (setting.source === 'admin') {
    return `Using the override ${setting.effective}. Clear it to use ${setting.fallback}.`;
  }
  return setting.source === 'env'
    ? `Using ${setting.effective} from the worker env.`
    : `Using the default ${setting.effective}.`;
}

function spendCapStatus(setting: BenchmarkSpendCapSetting): string {
  const amount = `$${setting.effective.toFixed(2)}`;
  if (setting.source === 'admin') {
    return `Override ${amount}. Clear it to use $${setting.fallback.toFixed(2)}.`;
  }
  return setting.source === 'env'
    ? `From the worker env: ${amount}.`
    : `Default ${amount}.`;
}

function SchedulerConfigEditor({ data }: { data: BenchmarkSchedulerConfigResponse }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SchedulerOverrideForm>(() => ({
    slots: String(data.settings.slots.override ?? ''),
    modelConcurrency: String(data.settings.modelConcurrency.override ?? ''),
  }));
  const [capForm, setCapForm] = useState<SpendCapForm>(() => ({
    perRunUsd: String(data.spendCaps?.perRunUsd.override ?? ''),
    perDayUsd: String(data.spendCaps?.perDayUsd.override ?? ''),
    perOwnerDayUsd: String(data.spendCaps?.perOwnerDayUsd.override ?? ''),
  }));
  const parsedCaps = BenchmarkSchedulerConfigUpdateSchema.safeParse({
    ...Object.fromEntries(
      BENCHMARK_SCHEDULER_SETTING_KEYS.map(key => {
        const text = form[key].trim();
        return [key, text === '' ? null : Number(text)];
      })
    ),
    ...Object.fromEntries(
      BENCHMARK_SPEND_CAP_KEYS.map(key => {
        const text = capForm[key].trim();
        return [key, text === '' ? null : Number(text)];
      })
    ),
  });

  const saveMutation = useMutation({
    mutationFn: saveSchedulerConfig,
    onSuccess: saved => {
      toast.success('Scheduler limits saved');
      queryClient.setQueryData(SCHEDULER_CONFIG_QUERY_KEY, saved);
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to save scheduler limits');
    },
  });

  const daySpend = data.spendToday;

  return (
    <Card className="rounded-lg">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">Scheduler</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-0">
        <p className="text-muted-foreground text-xs">
          Decider chunk limits shared by both routers. Leave a limit blank to use the worker env
          value or the default. Saved limits apply on the next dispatch, without a deploy.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {BENCHMARK_SCHEDULER_SETTING_KEYS.map(key => (
            <div key={key} className="flex flex-col gap-1.5">
              <Label htmlFor={`benchmark-scheduler-${key}`} className="text-sm font-medium">
                {SETTING_LABELS[key]}
              </Label>
              <Input
                id={`benchmark-scheduler-${key}`}
                type="text"
                inputMode="numeric"
                value={form[key]}
                onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
                className="h-8 w-28 tabular-nums"
                placeholder={String(data.settings[key].fallback)}
              />
              <p className="text-muted-foreground text-xs">{settingStatus(data.settings[key])}</p>
            </div>
          ))}
        </div>

        <div className="border-t pt-3">
          <h3 className="text-sm font-medium">Spend caps</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            A run is refused before it starts when its estimate exceeds a cap, and a running run
            stops claiming work when it reaches one. Nothing is dropped: held pairs stay pending and
            are admitted once there is room. A cap can be raised, never removed.
          </p>
          {daySpend ? (
            <p className="mt-2 text-xs">
              Today ({daySpend.day}):{' '}
              <span className="font-medium tabular-nums">${daySpend.spentUsd.toFixed(2)}</span> of $
              {daySpend.perDayUsd.toFixed(2)}
              {daySpend.spentUsd >= daySpend.perDayUsd ? (
                <span className="text-destructive font-medium"> — day cap reached</span>
              ) : null}
            </p>
          ) : null}
          {data.spendCaps ? null : (
            <p className="text-muted-foreground mt-2 text-xs">
              This worker does not report spend caps yet; the defaults apply there.
            </p>
          )}
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            {BENCHMARK_SPEND_CAP_KEYS.map(key => (
              <div key={key} className="flex flex-col gap-1.5">
                <Label htmlFor={`benchmark-cap-${key}`} className="text-sm font-medium">
                  {SPEND_CAP_LABELS[key]}
                </Label>
                <Input
                  id={`benchmark-cap-${key}`}
                  type="text"
                  inputMode="decimal"
                  value={capForm[key]}
                  onChange={e => setCapForm(prev => ({ ...prev, [key]: e.target.value }))}
                  className="h-8 w-28 tabular-nums"
                  placeholder={data.spendCaps?.[key].fallback.toFixed(2) ?? ''}
                />
                <p className="text-muted-foreground text-xs">
                  {data.spendCaps
                    ? spendCapStatus(data.spendCaps[key])
                    : 'Not reported by this worker.'}
                </p>
              </div>
            ))}
          </div>
        </div>

        {parsedCaps.success ? null : (
          <p className="text-destructive text-xs">
            Each limit must be a whole number from 1 to {BENCHMARK_CONTAINER_BUDGET}, and each cap a
            positive amount in USD.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => {
              if (parsedCaps.success) saveMutation.mutate(parsedCaps.data);
            }}
            disabled={!parsedCaps.success || saveMutation.isPending}
          >
            <Save className="size-4" />
            Save scheduler limits
          </Button>
          {data.updatedAt ? (
            <span className="text-muted-foreground text-xs">
              Last updated {data.updatedAt}
              {data.updatedBy ? ` by ${data.updatedBy}` : ''}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function SchedulerConfigCard() {
  const query = useQuery({
    queryKey: SCHEDULER_CONFIG_QUERY_KEY,
    queryFn: fetchSchedulerConfig,
  });
  if (query.isLoading) {
    return (
      <Card className="rounded-lg">
        <CardContent className="p-4">
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (query.error) {
    return (
      <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
        {query.error instanceof Error ? query.error.message : 'Failed to load scheduler limits'}
      </div>
    );
  }
  if (!query.data) return null;
  return <SchedulerConfigEditor key={query.data.updatedAt ?? 'unsaved'} data={query.data} />;
}
