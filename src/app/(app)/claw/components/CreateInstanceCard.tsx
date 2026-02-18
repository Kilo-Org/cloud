'use client';

import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useOpenRouterModels } from '@/app/api/openrouter/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function CreateInstanceCard({ mutations }: { mutations: ClawMutations }) {
  const posthog = usePostHog();
  const { data: modelsData, isLoading: isLoadingModels } = useOpenRouterModels();
  const [selectedModel, setSelectedModel] = useState('');

  const modelOptions = useMemo<ModelOption[]>(
    () => (modelsData?.data || []).map(model => ({ id: model.id, name: model.name })),
    [modelsData]
  );

  function handleCreate() {
    posthog?.capture('claw_create_instance_clicked', {
      selected_model: selectedModel || null,
    });

    if (isLoadingModels) {
      toast.error('Models are still loading; try again in a moment.');
      return;
    }

    const modelsPayload = modelOptions.map(({ id, name }) => ({ id, name }));
    mutations.provision.mutate(
      {
        kilocodeDefaultModel: selectedModel ? `kilocode/${selectedModel}` : null,
        kilocodeModels: modelsPayload.length > 0 ? modelsPayload : null,
      },
      {
        onSuccess: () => toast.success('Instance created'),
        onError: err => toast.error(`Failed to create: ${err.message}`),
      }
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create Instance</CardTitle>
        <CardDescription>
          Choose a default model to provision your first KiloClaw instance.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ModelCombobox
          label=""
          models={modelOptions}
          value={selectedModel}
          onValueChange={setSelectedModel}
          isLoading={isLoadingModels}
          disabled={mutations.provision.isPending || isLoadingModels}
        />
        <div className="flex justify-end">
          <Button onClick={handleCreate} disabled={mutations.provision.isPending}>
            <Plus className="mr-2 h-4 w-4" />
            {mutations.provision.isPending ? 'Creating...' : 'Create & Provision'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
