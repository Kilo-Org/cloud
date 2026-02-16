'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Save, Square } from 'lucide-react';
import { toast } from 'sonner';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useKiloClawConfig } from '@/hooks/useKiloClaw';
import { useOpenRouterModels } from '@/app/api/openrouter/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useDefaultModelSelection } from '../hooks/useDefaultModelSelection';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function SettingsTab({
  status,
  mutations,
}: {
  status: KiloClawDashboardStatus;
  mutations: ClawMutations;
}) {
  const { data: config } = useKiloClawConfig();
  const { data: modelsData, isLoading: isLoadingModels } = useOpenRouterModels();
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  const modelOptions = useMemo<ModelOption[]>(
    () => (modelsData?.data || []).map(model => ({ id: model.id, name: model.name })),
    [modelsData]
  );

  const { selectedModel, setSelectedModel } = useDefaultModelSelection(
    config?.kilocodeDefaultModel,
    modelOptions
  );

  const isSaving = mutations.patchConfig.isPending;
  const isDestroying = status.status === 'destroying';
  const isRunning = status.status === 'running';

  function handleSave() {
    if (isLoadingModels) {
      toast.error('Models are still loading; try again in a moment.');
      return;
    }

    const modelsPayload = modelOptions.map(({ id, name }) => ({ id, name }));
    mutations.patchConfig.mutate(
      {
        kilocodeDefaultModel: selectedModel ? `kilocode/${selectedModel}` : null,
        kilocodeModels: modelsPayload.length > 0 ? modelsPayload : null,
      },
      {
        onSuccess: () => toast.success('Configuration saved'),
        onError: err => toast.error(`Failed to save: ${err.message}`),
      }
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-foreground mb-1 text-sm font-medium">KiloCode Configuration</h3>
        <p className="text-muted-foreground mb-4 text-xs">
          API key is platform-managed and refreshed during save.
        </p>

        <div className="space-y-4">
          <ModelCombobox
            label=""
            models={modelOptions}
            value={selectedModel}
            onValueChange={setSelectedModel}
            isLoading={isLoadingModels}
            disabled={isSaving || isLoadingModels}
          />

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleSave} disabled={isSaving}>
              <Save className="h-4 w-4" />
              {isSaving ? 'Saving...' : 'Save & Provision'}
            </Button>
          </div>

          {config && (
            <p className="text-muted-foreground text-xs">
              Current default model: {config.kilocodeDefaultModel || 'not set'}
            </p>
          )}
        </div>
      </div>

      <Separator />

      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-500/10">
            <AlertTriangle className="h-4 w-4 text-red-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-red-400">Danger Zone</h3>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
              Stop or destroy this instance. Destroy permanently removes associated data.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!isRunning || mutations.stop.isPending || isDestroying}
                onClick={() =>
                  mutations.stop.mutate(undefined, {
                    onSuccess: () => toast.success('Instance stopped'),
                    onError: err => toast.error(err.message),
                  })
                }
              >
                <Square className="h-4 w-4" />
                Stop Instance
              </Button>

              {!confirmDestroy ? (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={isDestroying || mutations.destroy.isPending}
                  onClick={() => setConfirmDestroy(true)}
                >
                  {isDestroying ? 'Destroying...' : 'Destroy Instance'}
                </Button>
              ) : (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={isDestroying || mutations.destroy.isPending}
                    onClick={() =>
                      mutations.destroy.mutate(undefined, {
                        onSuccess: () => {
                          toast.success('Instance destroyed');
                          setConfirmDestroy(false);
                        },
                        onError: err => toast.error(err.message),
                      })
                    }
                  >
                    {isDestroying ? 'Destroying...' : 'Yes, destroy'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmDestroy(false)}>
                    Cancel
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
