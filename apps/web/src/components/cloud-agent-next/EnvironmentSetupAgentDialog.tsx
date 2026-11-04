'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ChevronDown, Loader2 } from 'lucide-react';
import { ENVIRONMENT_LIMITS, ENVIRONMENT_SETUP_LIMITS } from '@kilocode/cloud-agent-profile';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { VariantCombobox } from '@/components/shared/VariantCombobox';
import { useOrganizationDefaults } from '@/app/api/organizations/hooks';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { CLOUD_AGENT_METADATA_STALE_TIME } from '@/lib/cloud-agent/constants';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';
import type { EnvironmentRepository } from '@/hooks/useCloudAgentEnvironments';
import { useEnvironmentSetupRunMutations } from '@/hooks/useEnvironmentSetupRuns';
import { buildCloudChatSessionPath } from './cloud-session-fork';
import { EnvironmentRepositoriesField } from './EnvironmentRepositoriesField';
import { EnvironmentVariablesEditor } from './EnvironmentVariablesEditor';
import { parseEnvironmentVariables } from './environment-variables';
import {
  getLastUsedModel,
  getLastUsedVariant,
  getPreferredInitialModel,
  getPreferredInitialVariant,
} from './model-preferences';

export function setupRepositoriesError(
  repositories: readonly EnvironmentRepository[]
): string | null {
  if (repositories.length === 0) return 'Select a repository.';
  return repositories[0].platform === 'github' ? null : 'The first repository must be on GitHub.';
}

export function parseSetupSecrets(text: string): {
  secrets: Record<string, string>;
  error: string | null;
} {
  if (text.trim() === '') return { secrets: {}, error: null };
  try {
    const variables = parseEnvironmentVariables(text);
    const missing = variables.find(variable => variable.unchanged || variable.value === '');
    if (missing) return { secrets: {}, error: `Enter a value for ${missing.key}.` };
    return {
      secrets: Object.fromEntries(variables.map(variable => [variable.key, variable.value])),
      error: null,
    };
  } catch (caught) {
    return {
      secrets: {},
      error: caught instanceof Error ? caught.message : 'Check the secrets.',
    };
  }
}

type EnvironmentSetupAgentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId?: string;
  initialRepositories?: EnvironmentRepository[];
  targetEnvironmentId?: string;
  targetName?: string;
};

export function EnvironmentSetupAgentDialog({
  open,
  onOpenChange,
  organizationId,
  initialRepositories,
  targetEnvironmentId,
  targetName,
}: EnvironmentSetupAgentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <StartSetupForm
          organizationId={organizationId}
          initialRepositories={initialRepositories}
          targetEnvironmentId={targetEnvironmentId}
          targetName={targetName}
        />
      </DialogContent>
    </Dialog>
  );
}

function StartSetupForm({
  organizationId,
  initialRepositories,
  targetEnvironmentId,
  targetName,
}: {
  organizationId?: string;
  initialRepositories?: EnvironmentRepository[];
  targetEnvironmentId?: string;
  targetName?: string;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const { start } = useEnvironmentSetupRunMutations();
  const requirementsId = useId();
  const nameId = useId();
  const modelId = useId();

  const [repositories, setRepositories] = useState<EnvironmentRepository[]>(
    () => initialRepositories ?? []
  );
  const [repositoriesTouched, setRepositoriesTouched] = useState(false);
  const [requirements, setRequirements] = useState('');
  const [model, setModel] = useState('');
  const [variant, setVariant] = useState<string | undefined>(undefined);
  const [isModelUserSelected, setIsModelUserSelected] = useState(false);
  const [name, setName] = useState('');
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [secretsText, setSecretsText] = useState('');
  const [requirementsTouched, setRequirementsTouched] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const personalEligibilityQuery = useQuery({
    ...trpc.cloudAgentNext.checkEligibility.queryOptions(),
    enabled: !organizationId,
  });
  const orgEligibilityQuery = useQuery({
    ...trpc.organizations.cloudAgentNext.checkEligibility.queryOptions({
      organizationId: organizationId || '',
    }),
    enabled: !!organizationId,
  });
  const eligibilityData = organizationId ? orgEligibilityQuery.data : personalEligibilityQuery.data;
  const isEligibilityLoading = organizationId
    ? orgEligibilityQuery.isPending
    : personalEligibilityQuery.isPending;
  const hasLimitedAccess = !isEligibilityLoading && eligibilityData?.accessLevel === 'limited';

  const { data: modelsData } = useModelSelectorList(organizationId, true, 'member', {
    staleTime: CLOUD_AGENT_METADATA_STALE_TIME,
    gcTime: CLOUD_AGENT_METADATA_STALE_TIME,
  });
  const { lastSelected: serverLastSelected } = useModelPreferences(organizationId);
  const { data: defaultsData } = useOrganizationDefaults(organizationId);

  const allModels = modelsData?.data || [];

  const modelOptions = useMemo<ModelOption[]>(() => {
    const options = allModels.map(option => ({
      id: option.id,
      name: option.name,
      isFree: option.isFree,
      mayTrainOnYourPrompts: option.mayTrainOnYourPrompts,
      hasUserByokAvailable: option.hasUserByokAvailable,
      variants: option.opencode?.variants ? Object.keys(option.opencode.variants) : undefined,
    }));
    if (!hasLimitedAccess) return options;
    return options.filter(option => option.isFree || option.hasUserByokAvailable);
  }, [allModels, hasLimitedAccess]);

  useEffect(() => {
    if (modelOptions.length === 0) {
      if (model) {
        setModel('');
        setIsModelUserSelected(false);
      }
      return;
    }

    const isCurrentModelAvailable = modelOptions.some(option => option.id === model);
    if (!isCurrentModelAvailable || !model || !isModelUserSelected) {
      const serverLastModelId = serverLastSelected?.model;
      const newModel = getPreferredInitialModel({
        modelOptions,
        lastUsedModel: serverLastModelId ?? getLastUsedModel(organizationId),
        defaultModel: defaultsData?.defaultModel,
      });

      if (newModel && newModel !== model) {
        setModel(newModel);
        setIsModelUserSelected(false);
        const serverVariant =
          newModel === serverLastSelected?.model ? serverLastSelected.variant : undefined;
        const newVariants = modelOptions.find(option => option.id === newModel)?.variants ?? [];
        setVariant(
          getPreferredInitialVariant({
            availableVariants: newVariants,
            lastUsedVariant: serverVariant ?? getLastUsedVariant(newModel, organizationId),
          })
        );
      }
    }
  }, [
    defaultsData?.defaultModel,
    modelOptions,
    model,
    isModelUserSelected,
    organizationId,
    serverLastSelected,
  ]);

  const availableVariants = modelOptions.find(option => option.id === model)?.variants ?? [];

  const handleModelChange = useCallback(
    (newModel: string) => {
      setModel(newModel);
      setIsModelUserSelected(true);
      const newVariants = modelOptions.find(option => option.id === newModel)?.variants ?? [];
      setVariant(
        getPreferredInitialVariant({
          availableVariants: newVariants,
          lastUsedVariant: getLastUsedVariant(newModel, organizationId),
          currentVariant: variant,
        })
      );
    },
    [modelOptions, organizationId, variant]
  );

  const repositoriesError = setupRepositoriesError(repositories);
  const requirementsError =
    requirements.trim() === ''
      ? 'Describe how sessions should be set up.'
      : requirements.trim().length > ENVIRONMENT_SETUP_LIMITS.MAX_REQUIREMENTS_LENGTH
        ? `Keep it under ${ENVIRONMENT_SETUP_LIMITS.MAX_REQUIREMENTS_LENGTH} characters.`
        : null;
  const { secrets, error: secretsError } = parseSetupSecrets(secretsText);
  const modelError = model ? null : 'Select a model.';
  const canStart = !repositoriesError && !requirementsError && !secretsError && !modelError;

  const handleStart = async () => {
    setSubmitError(null);
    setRepositoriesTouched(true);
    if (!canStart) return;
    try {
      const result = await start.mutateAsync({
        organizationId,
        repositories,
        requirements: requirements.trim(),
        model,
        ...(variant ? { variant } : {}),
        ...(targetEnvironmentId ? { targetEnvironmentId } : {}),
        ...(!targetEnvironmentId && name.trim() ? { name: name.trim() } : {}),
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
      });
      router.push(buildCloudChatSessionPath(organizationId, result.kiloSessionId));
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : 'Could not start the setup.');
    }
  };

  return (
    <>
      <DialogHeader className="shrink-0 px-6 pt-6 pb-4 text-left">
        <DialogTitle>Set up with agent</DialogTitle>
        <DialogDescription>
          An agent works out the setup, tests it in a fresh sandbox, and saves it when it passes.
          You can revert it afterwards.
        </DialogDescription>
        {targetName && <p className="text-muted-foreground text-xs">Environment: {targetName}</p>}
      </DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto px-6 pb-6">
        <fieldset disabled={start.isPending} className="min-w-0 space-y-5">
          <EnvironmentRepositoriesField
            organizationId={organizationId}
            repositories={repositories}
            onChange={next => {
              setRepositories(next);
              setRepositoriesTouched(true);
            }}
          />
          {repositoriesTouched && repositoriesError && (
            <p role="alert" className="text-destructive text-xs">
              {repositoriesError}
            </p>
          )}

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={requirementsId} className="text-xs">
                Requirements
              </Label>
              <span className="text-muted-foreground text-xs tabular-nums">
                {requirements.length}/{ENVIRONMENT_SETUP_LIMITS.MAX_REQUIREMENTS_LENGTH}
              </span>
            </div>
            <Textarea
              id={requirementsId}
              value={requirements}
              onChange={event => setRequirements(event.target.value)}
              onBlur={() => setRequirementsTouched(true)}
              placeholder="Describe how sessions should be set up. Example: Set it up so the Cloud Agent can run the local dev stack and the web tests."
              maxLength={ENVIRONMENT_SETUP_LIMITS.MAX_REQUIREMENTS_LENGTH}
              rows={5}
              aria-invalid={requirementsTouched && !!requirementsError}
            />
            {requirementsTouched && requirementsError && (
              <p role="alert" className="text-destructive text-xs">
                {requirementsError}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor={modelId} className="text-xs">
              Model
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <ModelCombobox
                models={modelOptions}
                value={model}
                onValueChange={handleModelChange}
                isLoading={!modelsData}
                variant="compact"
                modal
                className="min-w-0 flex-1"
                triggerAriaLabel="Setup model"
                id={modelId}
              />
              {availableVariants.length > 0 && (
                <VariantCombobox
                  variants={availableVariants}
                  value={variant}
                  onValueChange={setVariant}
                  triggerAriaLabel="Setup model variant"
                />
              )}
            </div>
            {modelOptions.length > 0 && modelError && (
              <p role="alert" className="text-destructive text-xs">
                {modelError}
              </p>
            )}
          </div>

          {!targetEnvironmentId && (
            <div className="grid gap-2">
              <Label htmlFor={nameId} className="text-xs">
                Name (optional)
              </Label>
              <Input
                id={nameId}
                value={name}
                onChange={event => setName(event.target.value)}
                maxLength={ENVIRONMENT_LIMITS.MAX_NAME_LENGTH}
                placeholder="Environment name"
              />
            </div>
          )}

          <Collapsible open={secretsOpen} onOpenChange={setSecretsOpen}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground -ml-2 pointer-coarse:min-h-11"
              >
                Secrets (optional)
                <ChevronDown
                  className={cn('size-4 transition-transform', secretsOpen && 'rotate-180')}
                  aria-hidden
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              <p className="text-muted-foreground text-xs leading-5">
                Stored encrypted in this environment. Every session that uses it can read them.
              </p>
              <EnvironmentVariablesEditor
                text={secretsText}
                onChange={setSecretsText}
                removedKeys={[]}
                error={secretsError}
              />
            </CollapsibleContent>
          </Collapsible>

          {submitError && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" aria-hidden="true" />
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}
        </fieldset>
      </div>
      <DialogFooter className="shrink-0 border-t px-6 py-4">
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="sm"
              className="pointer-coarse:min-h-11"
              disabled={start.isPending}
            >
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            className="pointer-coarse:min-h-11"
            onClick={handleStart}
            disabled={start.isPending || !canStart}
          >
            {start.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Start setup
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
