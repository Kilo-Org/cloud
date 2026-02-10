'use client';

import { useCallback, useMemo, useState } from 'react';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search } from 'lucide-react';
import {
  useAlertingBaseline,
  useAlertingConfigs,
  useDeleteAlertingConfig,
  useUpdateAlertingConfig,
} from '@/app/admin/api/alerting/hooks';
import { toast } from 'sonner';
import { AddModelDialog } from '@/app/admin/alerting/AddModelDialog';
import { AlertingTable } from '@/app/admin/alerting/AlertingTable';
import { useAlertingModelDrafts } from '@/app/admin/alerting/use-alerting-model-drafts';
import { useBaselineState } from '@/app/admin/alerting/use-baseline-state';
import { useAddModelSearch } from '@/app/admin/alerting/use-add-model-search';
import {
  DEFAULT_ERROR_RATE_PERCENT,
  DEFAULT_MIN_REQUESTS,
  toErrorRateSlo,
} from '@/app/admin/alerting/utils';
import { normalizeModelId } from '@/lib/model-utils';

export default function AdminAlertingPage() {
  const [savingAll, setSavingAll] = useState(false);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [addSearchTerm, setAddSearchTerm] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  const { data: configsData } = useAlertingConfigs();
  const updateConfig = useUpdateAlertingConfig();
  const baselineMutation = useAlertingBaseline();
  const deleteConfig = useDeleteAlertingConfig();
  const { drafts, updateDraft, addDraft, removeDraft } = useAlertingModelDrafts({
    configs: configsData?.configs,
  });
  const { baselineByModel, baselineStatus, setLoading, setBaseline, setError } = useBaselineState();
  const {
    models: addSearchResults,
    isLoading: addSearchLoading,
    error: addSearchError,
  } = useAddModelSearch(addSearchTerm);

  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value);
  }, []);

  const saveAllConfigs = async () => {
    const configs = filteredConfigs;
    if (configs.length === 0) return;

    setSavingAll(true);
    try {
      for (const config of configs) {
        const modelId = config.model;
        const draft = drafts[modelId];
        if (!draft) continue;

        const errorRatePercent = Number(draft.errorRatePercent);
        const minRequests = Number(draft.minRequestsPerWindow);

        if (Number.isNaN(errorRatePercent) || errorRatePercent < 0 || errorRatePercent >= 100) {
          throw new Error(`Invalid error rate for ${modelId}`);
        }

        if (!Number.isInteger(minRequests) || minRequests <= 0) {
          throw new Error(`Invalid min requests for ${modelId}`);
        }

        const errorRateSlo = toErrorRateSlo(errorRatePercent);

        await updateConfig.mutateAsync({
          model: modelId,
          enabled: draft.enabled,
          errorRateSlo,
          minRequestsPerWindow: minRequests,
        });
      }
      toast.success('Alerting configs saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save alerting configs');
    } finally {
      setSavingAll(false);
    }
  };

  const loadBaseline = async (modelId: string) => {
    setLoading(modelId);

    try {
      const result = await baselineMutation.mutateAsync({ model: modelId });
      setBaseline(modelId, result.baseline);
      return result.baseline;
    } catch (error) {
      setError(modelId, error instanceof Error ? error.message : 'Failed to load baseline');
      return null;
    }
  };

  const applySuggestedDefaults = async (modelId: string) => {
    const baseline = baselineByModel[modelId] ?? (await loadBaseline(modelId));
    if (!baseline) {
      toast.error('Baseline not available for suggestions');
      return;
    }

    const baselineErrorRate = baseline.errorRate3d || baseline.errorRate1d || 0;
    const baselineErrorRatePercent = baselineErrorRate * 100;
    const bufferPercent = Math.min(baselineErrorRatePercent * 0.2, 0.5);
    const suggestedErrorRate = Math.max(0.5, baselineErrorRatePercent + bufferPercent);
    const clampedErrorRate = Math.min(suggestedErrorRate, 20);

    const avgRequestsPerMinute = Math.floor((baseline.requests3d || 0) / (3 * 24 * 60));
    const suggestedMinRequests = Math.max(
      10,
      Math.min(500, Math.round(avgRequestsPerMinute * 1.2))
    );

    updateDraft(modelId, {
      errorRatePercent: clampedErrorRate.toFixed(2),
      minRequestsPerWindow: String(suggestedMinRequests),
    });
    toast.success('Suggested defaults applied');
  };

  const handleAddModel = async (modelId: string) => {
    const normalizedModelId = normalizeModelId(modelId);
    addDraft(normalizedModelId);

    try {
      await updateConfig.mutateAsync({
        model: normalizedModelId,
        enabled: false,
        errorRateSlo: toErrorRateSlo(Number(DEFAULT_ERROR_RATE_PERCENT)),
        minRequestsPerWindow: Number(DEFAULT_MIN_REQUESTS),
      });
      toast.success('Alerting model added');
      setIsAddDialogOpen(false);
      setAddSearchTerm('');
    } catch (error) {
      removeDraft(normalizedModelId);
      toast.error(error instanceof Error ? error.message : 'Failed to add model');
    }
  };

  const handleDeleteModel = async (modelId: string) => {
    setDeletingModelId(modelId);
    try {
      await deleteConfig.mutateAsync({ model: modelId });
      removeDraft(modelId);
      toast.success('Alerting rule deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete alerting rule');
    } finally {
      setDeletingModelId(null);
    }
  };

  const filteredConfigs = useMemo(() => {
    const configs = configsData?.configs ?? [];
    if (!searchTerm.trim()) return configs;
    const query = searchTerm.toLowerCase();
    return configs.filter(config => config.model.toLowerCase().includes(query));
  }, [configsData, searchTerm]);

  const breadcrumbs = (
    <BreadcrumbItem>
      <BreadcrumbPage>Alerting</BreadcrumbPage>
    </BreadcrumbItem>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Alerting</h2>
        </div>

        <p className="text-muted-foreground">
          Configure per-model error rate alerting. Baselines load per model and show last 1d, 3d,
          and 7d error rates alongside request counts.
        </p>
        <p className="text-muted-foreground">
          Alerts fire when both the short and long windows exceed the configured error-rate SLO.
          Only enabled models are evaluated, and alerts are based on status code &gt;= 400. See{' '}
          <a
            href="https://kilo.ai/docs/contributing/architecture/agent-observability"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            documentation
          </a>{' '}
          for details.
        </p>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-2.5 left-2 h-4 w-4" />
            <Input
              placeholder="Search by name or OpenRouter ID..."
              value={searchTerm}
              onChange={e => handleSearchChange(e.target.value)}
              className="pl-8"
            />
          </div>
          <AddModelDialog
            isOpen={isAddDialogOpen}
            onOpenChange={setIsAddDialogOpen}
            searchTerm={addSearchTerm}
            onSearchChange={setAddSearchTerm}
            isLoading={addSearchLoading}
            error={addSearchError}
            models={addSearchResults}
            onAddModel={handleAddModel}
          />
        </div>
        {!configsData ? (
          <div className="text-center">Loading...</div>
        ) : (
          <AlertingTable
            configs={filteredConfigs}
            drafts={drafts}
            baselineByModel={baselineByModel}
            baselineStatus={baselineStatus}
            savingAll={savingAll}
            deletingModelId={deletingModelId}
            onToggleEnabled={(modelId, enabled) => updateDraft(modelId, { enabled })}
            onErrorRateChange={(modelId, value) =>
              updateDraft(modelId, { errorRatePercent: value })
            }
            onMinRequestsChange={(modelId, value) =>
              updateDraft(modelId, { minRequestsPerWindow: value })
            }
            onLoadBaseline={loadBaseline}
            onSuggestDefaults={applySuggestedDefaults}
            onDelete={handleDeleteModel}
          />
        )}
        {configsData && filteredConfigs.length > 0 && (
          <div className="flex justify-end">
            <Button onClick={saveAllConfigs} disabled={savingAll}>
              {savingAll ? 'Saving...' : 'Save all'}
            </Button>
          </div>
        )}
      </div>
    </AdminPage>
  );
}
