'use client';

import {
  BENCHMARK_CONTAINER_BUDGET,
  BENCHMARK_SCHEDULER_SETTING_KEYS,
  BenchmarkSchedulerConfigResponseSchema,
  BenchmarkSchedulerOverridesSchema,
  type BenchmarkSchedulerConfigResponse,
  type BenchmarkSchedulerOverrides,
  type BenchmarkSchedulerSetting,
  type BenchmarkSchedulerSettingKey,
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
  providerConcurrency: 'Per-provider concurrency',
  unknownProviderConcurrency: 'Unknown-provider concurrency',
};

type SchedulerOverrideForm = Record<BenchmarkSchedulerSettingKey, string>;

async function fetchSchedulerConfig() {
  const response = await fetch(SCHEDULER_CONFIG_URL);
  return parseAdminResponse(response, BenchmarkSchedulerConfigResponseSchema);
}

async function saveSchedulerConfig(overrides: BenchmarkSchedulerOverrides) {
  const response = await fetch(SCHEDULER_CONFIG_URL, {
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

function SchedulerConfigEditor({ data }: { data: BenchmarkSchedulerConfigResponse }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SchedulerOverrideForm>(() => ({
    slots: String(data.settings.slots.override ?? ''),
    modelConcurrency: String(data.settings.modelConcurrency.override ?? ''),
    providerConcurrency: String(data.settings.providerConcurrency.override ?? ''),
    unknownProviderConcurrency: String(data.settings.unknownProviderConcurrency.override ?? ''),
  }));
  const parsed = BenchmarkSchedulerOverridesSchema.safeParse(
    Object.fromEntries(
      BENCHMARK_SCHEDULER_SETTING_KEYS.map(key => {
        const text = form[key].trim();
        return [key, text === '' ? null : Number(text)];
      })
    )
  );

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
        {parsed.success ? null : (
          <p className="text-destructive text-xs">
            Each limit must be a whole number from 1 to {BENCHMARK_CONTAINER_BUDGET}.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => {
              if (parsed.success) saveMutation.mutate(parsed.data);
            }}
            disabled={!parsed.success || saveMutation.isPending}
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
