'use client';

import { useCallback, useMemo, useState } from 'react';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Input } from '@/components/ui/input';
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

export default function AdminAlertingPage() {
  const [updatingModelId, setUpdatingModelId] = useState<string | null>(null);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [addSearchTerm, setAddSearchTerm] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  const { data: configsData } = useAlertingConfigs();
  const updateConfig = useUpdateAlertingConfig();
  const baselineMutation = useAlertingBaseline();
  const deleteConfig = useDeleteAlertingConfig();
  const { drafts, updateDraft, addDraft } = useAlertingModelDrafts({
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

  const saveConfig = async (modelId: string) => {
    const draft = drafts[modelId];
    if (!draft) return;

    const errorRatePercent = Number(draft.errorRatePercent);
    const minRequests = Number(draft.minRequestsPerWindow);

    if (Number.isNaN(errorRatePercent) || errorRatePercent < 0 || errorRatePercent >= 100) {
      toast.error('Error rate must be a number between 0 and 100');
      return;
    }

    if (!Number.isInteger(minRequests) || minRequests <= 0) {
      toast.error('Min requests must be a positive integer');
      return;
    }

    const errorRateSlo = toErrorRateSlo(errorRatePercent);

    setUpdatingModelId(modelId);
    try {
      await updateConfig.mutateAsync({
        model: modelId,
        enabled: draft.enabled,
        errorRateSlo,
        minRequestsPerWindow: minRequests,
      });
      toast.success('Alerting config updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update alerting config');
    } finally {
      setUpdatingModelId(null);
    }
  };

  const loadBaseline = async (modelId: string) => {
    setLoading(modelId);

    try {
      const result = await baselineMutation.mutateAsync({ model: modelId });
      setBaseline(modelId, result.baseline);
    } catch (error) {
      setError(modelId, error instanceof Error ? error.message : 'Failed to load baseline');
    }
  };

  const handleAddModel = async (modelId: string) => {
    addDraft(modelId);

    try {
      await updateConfig.mutateAsync({
        model: modelId,
        enabled: false,
        errorRateSlo: toErrorRateSlo(Number(DEFAULT_ERROR_RATE_PERCENT)),
        minRequestsPerWindow: Number(DEFAULT_MIN_REQUESTS),
      });
      toast.success('Alerting model added');
      setIsAddDialogOpen(false);
      setAddSearchTerm('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add model');
    }
  };

  const handleDeleteModel = async (modelId: string) => {
    setDeletingModelId(modelId);
    try {
      await deleteConfig.mutateAsync({ model: modelId });
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
            updatingModelId={updatingModelId}
            deletingModelId={deletingModelId}
            onToggleEnabled={(modelId, enabled) => updateDraft(modelId, { enabled })}
            onErrorRateChange={(modelId, value) =>
              updateDraft(modelId, { errorRatePercent: value })
            }
            onMinRequestsChange={(modelId, value) =>
              updateDraft(modelId, { minRequestsPerWindow: value })
            }
            onLoadBaseline={loadBaseline}
            onSave={saveConfig}
            onDelete={handleDeleteModel}
          />
        )}
      </div>
    </AdminPage>
  );
}
