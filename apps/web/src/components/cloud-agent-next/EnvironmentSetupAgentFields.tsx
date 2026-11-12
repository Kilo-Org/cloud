'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { validateEnvironmentName } from '@kilocode/cloud-agent-profile';
import { useOrganizationDefaults } from '@/app/api/organizations/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useEnvironmentSetupRunMutations } from '@/hooks/useEnvironmentSetupRuns';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { VariantCombobox } from '@/components/shared/VariantCombobox';
import {
  getLastUsedModel,
  getLastUsedVariant,
  getPreferredInitialModel,
  getPreferredInitialVariant,
  setLastUsedModel,
  setLastUsedVariant,
} from './model-preferences';

import type { EnvironmentRepository } from '@/hooks/useCloudAgentEnvironments';
type Props = {
  formId: string;
  onValidChange: (valid: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  organizationId?: string;
  repositories: EnvironmentRepository[];
  name: string;
  targetEnvironmentId?: string;
  onStarted: () => void;
  onPendingChange: (pending: boolean) => void;
};

export function EnvironmentSetupAgentFields({
  formId,
  onValidChange,
  onDirtyChange,
  organizationId,
  repositories,
  name,
  targetEnvironmentId,
  onStarted,
  onPendingChange,
}: Props) {
  const router = useRouter();
  const { start } = useEnvironmentSetupRunMutations();
  const [requirements, setRequirements] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<string | undefined>();
  const { data: modelsData, isLoading: modelsLoading } = useModelSelectorList(
    organizationId,
    true,
    'member'
  );
  const { data: defaults } = useOrganizationDefaults(organizationId);
  const { lastSelected, setLastSelected } = useModelPreferences(organizationId);
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      (modelsData?.data ?? []).map(model => ({
        id: model.id,
        name: model.name,
        isFree: model.isFree,
        mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
        hasUserByokAvailable: model.hasUserByokAvailable,
        variants: model.opencode?.variants ? Object.keys(model.opencode.variants) : undefined,
      })),
    [modelsData]
  );
  const model =
    selectedModel ??
    getPreferredInitialModel({
      modelOptions,
      lastUsedModel: lastSelected?.model ?? getLastUsedModel(organizationId),
      defaultModel: defaults?.defaultModel,
    });
  const variants = modelOptions.find(option => option.id === model)?.variants ?? [];
  const variant = getPreferredInitialVariant({
    availableVariants: variants,
    currentVariant: selectedVariant,
    lastUsedVariant:
      (model === lastSelected?.model ? lastSelected.variant : undefined) ??
      getLastUsedVariant(model, organizationId),
  });
  const repositoryError =
    repositories[0] && repositories[0].platform !== 'github'
      ? 'The first repository must be on GitHub.'
      : null;
  const valid =
    repositories.length > 0 &&
    !repositoryError &&
    requirements.length <= 8000 &&
    modelOptions.some(option => option.id === model);
  useEffect(() => {
    onValidChange(valid);
  }, [valid, onValidChange]);
  useEffect(() => {
    onDirtyChange(requirements.trim().length > 0);
  }, [requirements, onDirtyChange]);
  const handleStart = async () => {
    if (!valid || start.isPending) return;
    setError(null);
    onPendingChange(true);
    try {
      if (name.trim()) validateEnvironmentName(name.trim());
      const result = await start.mutateAsync({
        organizationId,
        repositories,
        requirements: requirements.trim(),
        model,
        ...(variant ? { variant } : {}),
        ...(name.trim() && !targetEnvironmentId ? { name: name.trim() } : {}),
        targetEnvironmentId,
      });
      onStarted();
      const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
      router.push(`${basePath}/chat?sessionId=${result.kiloSessionId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start environment setup.');
    } finally {
      onPendingChange(false);
    }
  };
  return (
    <form
      id={formId}
      onSubmit={event => {
        event.preventDefault();
        void handleStart();
      }}
      className="space-y-4"
    >
      <p className="text-muted-foreground text-xs">
        The agent inspects your repositories, prepares a setup script, and tests it in a fresh
        session before saving. You can revert its changes afterwards.
      </p>
      <fieldset disabled={start.isPending} className="min-w-0 space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="setup-requirements">Guidance (optional)</Label>
          <Textarea
            id="setup-requirements"
            value={requirements}
            onChange={event => setRequirements(event.target.value)}
            maxLength={8000}
            rows={4}
            aria-describedby="setup-guidance-help"
            placeholder="For example: prepare the local dev stack and web tests."
          />
          <p id="setup-guidance-help" className="text-muted-foreground text-xs">
            Leave blank to let the agent choose the setup from your repositories.
          </p>
        </div>
        <div className="space-y-2">
          <Label>Model and thinking effort</Label>
          <div className="flex flex-wrap gap-2">
            <ModelCombobox
              modal
              variant="compact"
              className="min-w-0 max-w-full"
              models={modelOptions}
              value={model}
              isLoading={modelsLoading}
              onValueChange={value => {
                setSelectedModel(value);
                setSelectedVariant(undefined);
                setLastUsedModel(value, organizationId);
                setLastSelected({ model: value });
              }}
            />
            <VariantCombobox
              variants={variants}
              value={variant}
              className="min-w-0"
              onValueChange={value => {
                setSelectedVariant(value);
                setLastUsedVariant(model, value, organizationId);
                setLastSelected({ model, variant: value });
              }}
            />
          </div>
        </div>
      </fieldset>
      {repositoryError && (
        <p role="alert" className="text-destructive text-sm">
          {repositoryError}
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
