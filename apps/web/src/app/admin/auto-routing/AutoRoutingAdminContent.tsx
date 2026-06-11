'use client';

import {
  AutoRoutingClassifierAnalyticsResponseSchema,
  AutoRoutingClassifierModelResponseSchema,
  type AutoRoutingAnalyticsPeriod,
  type AutoRoutingClassifierAnalyticsResponse,
  type AutoRoutingClassifierModelResponse,
} from '@kilocode/auto-routing-contracts';
import React, { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BarChart3, Clock3, DollarSign, HelpCircle, RefreshCw, Route, Save } from 'lucide-react';
import * as z from 'zod';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  OpenRouterModelsResponseSchema,
  type OpenRouterModelsResponse,
} from '@/lib/organizations/organization-types';
import { cn } from '@/lib/utils';
import { formatBodySizeKilobytes } from './auto-routing-format';

const periods: Array<{ value: AutoRoutingAnalyticsPeriod; label: string }> = [
  { value: '1h', label: '1h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

const AdminApiErrorSchema = z.object({ error: z.string().optional() });

async function parseAdminResponse<T extends object>(
  response: Response,
  schema: z.ZodType<T>
): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsedError = AdminApiErrorSchema.safeParse(body);
    throw new Error(
      parsedError.success && parsedError.data.error
        ? parsedError.data.error
        : `Request failed: ${response.status}`
    );
  }
  return schema.parse(body);
}

async function fetchClassifierModel() {
  const response = await fetch('/admin/api/auto-routing/classifier-model');
  return parseAdminResponse<AutoRoutingClassifierModelResponse>(
    response,
    AutoRoutingClassifierModelResponseSchema
  );
}

async function saveClassifierModel(model: string) {
  const response = await fetch('/admin/api/auto-routing/classifier-model', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  return parseAdminResponse<AutoRoutingClassifierModelResponse>(
    response,
    AutoRoutingClassifierModelResponseSchema
  );
}

async function fetchClassifierAnalytics(period: AutoRoutingAnalyticsPeriod) {
  const searchParams = new URLSearchParams({ period });
  const response = await fetch(`/admin/api/auto-routing/classifier-analytics?${searchParams}`);
  return parseAdminResponse<AutoRoutingClassifierAnalyticsResponse>(
    response,
    AutoRoutingClassifierAnalyticsResponseSchema
  );
}

async function fetchOpenRouterModels() {
  const response = await fetch('/admin/api/auto-routing/openrouter-models');
  return parseAdminResponse<OpenRouterModelsResponse>(response, OpenRouterModelsResponseSchema);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function formatDecimal(value: number, maximumFractionDigits = 1) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(value);
}

function formatPercent(value: number) {
  return `${formatDecimal(value * 100, 1)}%`;
}

function formatCredits(value: number) {
  if (value > 0 && value < 0.0001) {
    return new Intl.NumberFormat('en-US', {
      maximumSignificantDigits: 3,
      notation: 'compact',
    }).format(value);
  }

  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: value > 0 && value < 1 ? 4 : 2,
    maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
  }).format(value);
}

function MetricHelp({ label, description }: { label: string; description: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Explain ${label}`}
          className="text-muted-foreground hover:text-foreground h-6 w-6"
        >
          <HelpCircle className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="max-w-80">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
  loading,
  help,
}: {
  title: string;
  value: string;
  detail?: string;
  icon: typeof BarChart3;
  loading?: boolean;
  help: string;
}) {
  return (
    <Card className="rounded-lg">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{title}</CardTitle>
        <div className="flex items-center gap-1">
          <Icon className="text-muted-foreground size-4" />
          <MetricHelp label={title} description={help} />
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
        )}
        {detail ? <p className="text-muted-foreground mt-1 text-xs">{detail}</p> : null}
      </CardContent>
    </Card>
  );
}

function BreakdownCard({
  title,
  help,
  loading,
  children,
}: {
  title: string;
  help: string;
  loading: boolean;
  children: ReactNode;
}) {
  return (
    <Card className="rounded-lg">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <MetricHelp label={title} description={help} />
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {loading ? <Skeleton className="h-40 w-full" /> : children}
      </CardContent>
    </Card>
  );
}

function EmptyTableRow({ colSpan }: { colSpan: number }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="text-muted-foreground h-16 text-center">
        No data
      </TableCell>
    </TableRow>
  );
}

export function AutoRoutingBreakdownTables({
  analytics,
  loading,
}: {
  analytics?: AutoRoutingClassifierAnalyticsResponse;
  loading: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <BreakdownCard
          title="Status"
          help="Breakdown by raw classifier status, including classifier_error:<subtype> rows for classifier failures."
          loading={loading}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Requests</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analytics?.statusBreakdown.length ? (
                analytics.statusBreakdown.map(row => (
                  <TableRow key={row.status}>
                    <TableCell>
                      <Badge variant="outline" className="max-w-56 truncate">
                        {row.status || 'unknown'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(row.requests)}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <EmptyTableRow colSpan={2} />
              )}
            </TableBody>
          </Table>
        </BreakdownCard>

        <BreakdownCard
          title="Classifier Models"
          help="Classifier model used for each request, or unknown when no classifier call happened."
          loading={loading}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Requests</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analytics?.classifierModelBreakdown.length ? (
                analytics.classifierModelBreakdown.map(row => (
                  <TableRow key={row.classifierModel}>
                    <TableCell className="max-w-64 truncate font-mono text-xs">
                      {row.classifierModel || 'unknown'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(row.requests)}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <EmptyTableRow colSpan={2} />
              )}
            </TableBody>
          </Table>
        </BreakdownCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <BreakdownCard
          title="Task Types"
          help="Successful classifier task categories and their average classifier confidence."
          loading={loading}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Confidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analytics?.taskTypeBreakdown.length ? (
                analytics.taskTypeBreakdown.map(row => (
                  <TableRow key={row.taskType}>
                    <TableCell className="capitalize">
                      {row.taskType.replaceAll('_', ' ')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(row.requests)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPercent(row.avgConfidence)}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <EmptyTableRow colSpan={3} />
              )}
            </TableBody>
          </Table>
        </BreakdownCard>

        <BreakdownCard
          title="Task Subtypes"
          help="Successful classifier task and subtask pairs with their average classifier confidence."
          loading={loading}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Subtype</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Confidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analytics?.taskSubtypeBreakdown.length ? (
                analytics.taskSubtypeBreakdown.map(row => (
                  <TableRow key={`${row.taskType}:${row.subtaskType}`}>
                    <TableCell className="max-w-32 truncate capitalize">
                      {row.taskType.replaceAll('_', ' ')}
                    </TableCell>
                    <TableCell className="max-w-40 truncate capitalize">
                      {row.subtaskType.replaceAll('_', ' ')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(row.requests)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPercent(row.avgConfidence)}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <EmptyTableRow colSpan={4} />
              )}
            </TableBody>
          </Table>
        </BreakdownCard>
      </div>
    </div>
  );
}

export function AutoRoutingAdminContent() {
  const [selectedModel, setSelectedModel] = useState('');
  const [period, setPeriod] = useState<AutoRoutingAnalyticsPeriod>('24h');
  const queryClient = useQueryClient();

  const classifierModelQuery = useQuery({
    queryKey: ['auto-routing', 'classifier-model'],
    queryFn: fetchClassifierModel,
  });
  const analyticsQuery = useQuery({
    queryKey: ['auto-routing', 'classifier-analytics', period],
    queryFn: () => fetchClassifierAnalytics(period),
  });
  const openRouterModelsQuery = useQuery({
    queryKey: ['auto-routing', 'openrouter-models'],
    queryFn: fetchOpenRouterModels,
  });

  useEffect(() => {
    if (classifierModelQuery.data?.model) {
      setSelectedModel(classifierModelQuery.data.model);
    }
  }, [classifierModelQuery.data?.model]);

  const modelOptions = useMemo<ModelOption[]>(() => {
    return (
      openRouterModelsQuery.data?.data.map(model => ({
        id: model.id,
        name: model.name,
        supportsVision: model.architecture.input_modalities.includes('image'),
      })) ?? []
    );
  }, [openRouterModelsQuery.data?.data]);

  const saveMutation = useMutation({
    mutationFn: saveClassifierModel,
    onSuccess: data => {
      queryClient.setQueryData(['auto-routing', 'classifier-model'], data);
      setSelectedModel(data.model);
      toast.success('Classifier model updated');
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : 'Failed to update classifier model');
    },
  });

  const isRefreshing =
    classifierModelQuery.isFetching ||
    analyticsQuery.isFetching ||
    openRouterModelsQuery.isFetching;
  const classifierModelError =
    classifierModelQuery.error instanceof Error ? classifierModelQuery.error.message : undefined;
  const openRouterModelsError =
    openRouterModelsQuery.error instanceof Error ? openRouterModelsQuery.error.message : undefined;
  const currentModel = classifierModelQuery.data?.model ?? '';
  const hasClassifierModelLoaded = classifierModelQuery.isSuccess && currentModel.length > 0;
  const hasModelChange =
    hasClassifierModelLoaded && selectedModel.trim().length > 0 && selectedModel !== currentModel;
  const summary = analyticsQuery.data?.summary;
  const totalRequests = summary?.totalRequests ?? 0;
  const classifiedRate = totalRequests > 0 ? (summary?.classifiedRequests ?? 0) / totalRequests : 0;
  const sessionRate = totalRequests > 0 ? (summary?.withSessionId ?? 0) / totalRequests : 0;
  const classifiedRequests = summary?.classifiedRequests ?? 0;
  const cacheHitRate =
    classifiedRequests > 0 ? (summary?.cachedRequests ?? 0) / classifiedRequests : 0;
  const analyticsErrorMessage =
    analyticsQuery.error instanceof Error
      ? analyticsQuery.error.message
      : 'Failed to load classifier analytics';
  const hasInitialAnalyticsError = analyticsQuery.isError && !analyticsQuery.data;

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Auto Routing</h1>
          <p className="text-muted-foreground text-sm">
            Classifier configuration and routing telemetry.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void classifierModelQuery.refetch();
            void analyticsQuery.refetch();
            void openRouterModelsQuery.refetch();
          }}
          disabled={isRefreshing}
          className="w-fit"
        >
          <RefreshCw className={cn('size-4', isRefreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      <Card className="rounded-lg">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
          <CardTitle className="text-base">Classifier Model</CardTitle>
          <MetricHelp
            label="Classifier Model"
            description="The OpenRouter model used by the auto-routing classifier. Saving changes updates KV config, so the classifier can change without a redeploy."
          />
        </CardHeader>
        <CardContent className="grid gap-4 p-4 pt-0 lg:grid-cols-[1fr_auto] lg:items-end">
          <ModelCombobox
            label="Model"
            models={modelOptions}
            value={selectedModel}
            onValueChange={setSelectedModel}
            isLoading={openRouterModelsQuery.isLoading || classifierModelQuery.isLoading}
            error={classifierModelError ?? openRouterModelsError}
            placeholder={classifierModelQuery.data?.defaultModel ?? 'Select classifier model'}
            className="w-full"
          />
          <Button
            type="button"
            onClick={() => saveMutation.mutate(selectedModel)}
            disabled={!hasModelChange || saveMutation.isPending}
            className="w-full lg:w-auto"
          >
            <Save className="size-4" />
            Save model
          </Button>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Classifier Analytics</h2>
          <p className="text-muted-foreground text-sm">
            OpenRouter credits are reported as credits.
          </p>
        </div>
        <div
          className="flex w-fit rounded-md border p-1"
          role="group"
          aria-label="Analytics period"
        >
          {periods.map(option => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={period === option.value ? 'secondary' : 'ghost'}
              aria-pressed={period === option.value}
              onClick={() => setPeriod(option.value)}
              className="h-8 px-3"
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {analyticsQuery.error ? (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
          {analyticsErrorMessage}
        </div>
      ) : null}

      {hasInitialAnalyticsError ? (
        <Card className="rounded-lg">
          <CardContent className="text-muted-foreground p-4 text-sm">
            Classifier analytics could not be loaded. Refresh the page to try again.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              title="Requests"
              value={formatNumber(totalRequests)}
              detail={`${formatPercent(classifiedRate)} classified`}
              icon={Route}
              loading={analyticsQuery.isLoading}
              help="Total auto-routing analytics rows in the selected period. Includes classified requests, classifier errors, and invalid input statuses."
            />
            <MetricCard
              title="Classifier Latency"
              value={`${formatDecimal(summary?.avgDurationMs ?? 0)} ms`}
              detail={`p95 ${formatDecimal(summary?.p95DurationMs ?? 0)} ms`}
              icon={Clock3}
              loading={analyticsQuery.isLoading}
              help="Average classifier model call runtime for requests that reached classifier execution. Decisions served from the cache are excluded. The detail shows p95 latency."
            />
            <MetricCard
              title="Classifier Cost"
              value={formatCredits(summary?.totalCostCredits ?? 0)}
              detail="OpenRouter credits"
              icon={DollarSign}
              loading={analyticsQuery.isLoading}
              help="Summed OpenRouter classifier cost in OpenRouter credits, not USD."
            />
            <MetricCard
              title="Session Coverage"
              value={formatPercent(sessionRate)}
              detail={`${formatNumber(summary?.uniqueSessions ?? 0)} unique sessions`}
              icon={BarChart3}
              loading={analyticsQuery.isLoading}
              help="Percent of analytics rows with a session id. The detail shows distinct non-empty sessions."
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              title="Cache Hit Rate"
              value={formatPercent(cacheHitRate)}
              detail={`${formatNumber(summary?.cachedRequests ?? 0)} served from cache`}
              icon={Clock3}
              loading={analyticsQuery.isLoading}
              help="Percent of classified requests served from the per-conversation decision cache instead of a classifier model call. Cached decisions cost no credits."
            />
            <MetricCard
              title="Classifier Errors"
              value={formatNumber(summary?.classifierErrors ?? 0)}
              detail={`${formatNumber(summary?.invalidRequests ?? 0)} invalid inputs`}
              icon={BarChart3}
              loading={analyticsQuery.isLoading}
              help="Requests where the mirrored input was parseable, but classifier execution or classifier output failed. The detail counts malformed JSON, envelope, or body inputs."
            />
            <MetricCard
              title="Requires Tools"
              value={formatNumber(summary?.requiresTools ?? 0)}
              detail={`${formatNumber(summary?.mirroredHasTools ?? 0)} mirrored with tools`}
              icon={Route}
              loading={analyticsQuery.isLoading}
              help="Classified requests where the classifier output says the task requires tools. The detail counts original mirrored requests that included tools."
            />
            <MetricCard
              title="Body Size"
              value={formatBodySizeKilobytes(summary?.avgBodyBytes ?? 0)}
              detail={`${formatPercent(summary?.avgConfidence ?? 0)} avg confidence`}
              icon={BarChart3}
              loading={analyticsQuery.isLoading}
              help="Average mirrored body size in KB. The detail shows average classifier confidence for successful classifications."
            />
          </div>

          <AutoRoutingBreakdownTables
            analytics={analyticsQuery.data}
            loading={analyticsQuery.isLoading}
          />
        </>
      )}
    </div>
  );
}
