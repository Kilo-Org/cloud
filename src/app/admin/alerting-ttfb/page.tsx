'use client';

import { useCallback, useMemo, useState } from 'react';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search } from 'lucide-react';
import {
  useTtfbAlertingBaseline,
  useTtfbAlertingConfigs,
  useDeleteTtfbAlertingConfig,
  useUpdateTtfbAlertingConfig,
} from '@/app/admin/api/alerting/hooks';
import { toast } from 'sonner';
import { AddModelDialog } from '@/app/admin/alerting/AddModelDialog';
import { TtfbAlertingTable } from '@/app/admin/alerting-ttfb/TtfbAlertingTable';
import { useTtfbAlertingModelDrafts } from '@/app/admin/alerting-ttfb/use-ttfb-alerting-model-drafts';
import { useTtfbBaselineState } from '@/app/admin/alerting-ttfb/use-ttfb-baseline-state';
import { useAddModelSearch } from '@/app/admin/alerting/use-add-model-search';
import {
  DEFAULT_TTFB_THRESHOLD_MS,
  DEFAULT_MIN_REQUESTS,
  DEFAULT_TTFB_SLO,
} from '@/app/admin/alerting-ttfb/utils';
export default function AdminAlertingTtfbPage() {
  const [savingAll, setSavingAll] = useState(false);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [addSearchTerm, setAddSearchTerm] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  const { data: configsData } = useTtfbAlertingConfigs();
  const updateConfig = useUpdateTtfbAlertingConfig();
  const baselineMutation = useTtfbAlertingBaseline();
  const deleteConfig = useDeleteTtfbAlertingConfig();
  const { drafts, updateDraft, addDraft, removeDraft } = useTtfbAlertingModelDrafts({
    configs: configsData?.configs,
  });
  const { baselineByModel, baselineStatus, setLoading, setBaseline, setError } =
    useTtfbBaselineState();
  const {
    models: addSearchResults,
    isLoading: addSearchLoading,
    error: addSearchError,
  } = useAddModelSearch(addSearchTerm);

  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value);
  }, []);

  const saveAllConfigs = async () => {
    const configs = configsData?.configs ?? [];
    if (configs.length === 0) return;

    setSavingAll(true);
    try {
      for (const config of configs) {
        const modelId = config.model;
        const draft = drafts[modelId];
        if (!draft) continue;

        const thresholdMs = Number(draft.ttfbThresholdMs);
        const minRequests = Number(draft.minRequestsPerWindow);

        if (!Number.isInteger(thresholdMs) || thresholdMs <= 0) {
          throw new Error(`Invalid TTFB threshold for ${modelId}`);
        }

        if (!Number.isInteger(minRequests) || minRequests <= 0) {
          throw new Error(`Invalid min requests for ${modelId}`);
        }

        const ttfbSlo = Number(draft.ttfbSlo);
        if (!Number.isFinite(ttfbSlo) || ttfbSlo <= 0 || ttfbSlo >= 1) {
          throw new Error(`Invalid SLO for ${modelId}`);
        }

        await updateConfig.mutateAsync({
          model: modelId,
          enabled: draft.enabled,
          ttfbThresholdMs: thresholdMs,
          ttfbSlo,
          minRequestsPerWindow: minRequests,
        });
      }
      toast.success('TTFB alerting configs saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save TTFB alerting configs');
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
    const cached = baselineByModel[modelId];
    const baseline = cached !== undefined ? cached : await loadBaseline(modelId);
    if (!baseline) {
      toast.error('Baseline not available for suggestions');
      return;
    }

    // Take 3d p95, add 20% buffer, round to nearest 100ms, clamp to min 500ms
    const p95 = baseline.p95Ttfb3d;
    const withBuffer = p95 * 1.2;
    const rounded = Math.round(withBuffer / 100) * 100;
    const suggestedThreshold = Math.max(500, rounded);

    const avgRequestsPerMinute = Math.floor((baseline.requests3d || 0) / (3 * 24 * 60));
    const suggestedMinRequests = Math.max(
      10,
      Math.min(500, Math.round(avgRequestsPerMinute * 1.2))
    );

    updateDraft(modelId, {
      ttfbThresholdMs: String(suggestedThreshold),
      ttfbSlo: '0.95',
      minRequestsPerWindow: String(suggestedMinRequests),
    });
    toast.success('Suggested defaults applied');
  };

  const handleAddModel = async (modelId: string) => {
    addDraft(modelId);

    try {
      await updateConfig.mutateAsync({
        model: modelId,
        enabled: false,
        ttfbThresholdMs: Number(DEFAULT_TTFB_THRESHOLD_MS),
        ttfbSlo: Number(DEFAULT_TTFB_SLO),
        minRequestsPerWindow: Number(DEFAULT_MIN_REQUESTS),
      });
      toast.success('TTFB alerting model added');
      setIsAddDialogOpen(false);
      setAddSearchTerm('');
    } catch (error) {
      removeDraft(modelId);
      toast.error(error instanceof Error ? error.message : 'Failed to add model');
    }
  };

  const handleDeleteModel = async (modelId: string) => {
    setDeletingModelId(modelId);
    try {
      await deleteConfig.mutateAsync({ model: modelId });
      removeDraft(modelId);
      toast.success('TTFB alerting rule deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete TTFB alerting rule');
    } finally {
      setDeletingModelId(null);
    }
  };

  const filteredConfigs = useMemo(() => {
    const configs = configsData?.configs ?? [];
    const sorted = [...configs].sort((a, b) => a.model.localeCompare(b.model));
    if (!searchTerm.trim()) return sorted;
    const query = searchTerm.toLowerCase();
    return sorted.filter(config => config.model.toLowerCase().includes(query));
  }, [configsData, searchTerm]);

  const existingModels = useMemo(() => {
    const configs = configsData?.configs ?? [];
    return new Set(configs.map(c => c.model));
  }, [configsData]);

  const breadcrumbs = (
    <BreadcrumbItem>
      <BreadcrumbPage>Alerting (TTFB)</BreadcrumbPage>
    </BreadcrumbItem>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Alerting (TTFB)</h2>
        </div>

        <p className="text-muted-foreground">
          Configure per-model TTFB latency alerting. Baselines show 3d p50/p95/p99 TTFB values and
          request counts. The SLO p-value controls what fraction of requests must stay under the
          threshold.
        </p>
        <p className="text-muted-foreground">
          Alerts fire when the configured percentile of successful requests exceeds the TTFB
          threshold across both the short and long burn-rate windows. Only enabled models are
          evaluated.
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
            existingModels={existingModels}
            onAddModel={handleAddModel}
          />
        </div>
        {!configsData ? (
          <div className="text-center">Loading...</div>
        ) : (
          <TtfbAlertingTable
            configs={filteredConfigs}
            drafts={drafts}
            baselineByModel={baselineByModel}
            baselineStatus={baselineStatus}
            savingAll={savingAll}
            deletingModelId={deletingModelId}
            onToggleEnabled={(modelId, enabled) => updateDraft(modelId, { enabled })}
            onThresholdChange={(modelId, value) => updateDraft(modelId, { ttfbThresholdMs: value })}
            onSloChange={(modelId, value) => updateDraft(modelId, { ttfbSlo: value })}
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
