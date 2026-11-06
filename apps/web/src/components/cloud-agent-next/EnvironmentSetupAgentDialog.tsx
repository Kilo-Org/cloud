'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import {
  ENVIRONMENT_LIMITS,
  validateEnvironmentName,
  validateEnvironmentVarCount,
} from '@kilocode/cloud-agent-profile';
import { useOrganizationDefaults } from '@/app/api/organizations/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useCloudAgentEnvironment,
  type EnvironmentRepository,
} from '@/hooks/useCloudAgentEnvironments';
import type { EgressMode } from '@kilocode/worker-utils/egress-allowlist';
import {
  useEnvironmentSetupEnabled,
  useEnvironmentSetupRunMutations,
} from '@/hooks/useEnvironmentSetupRuns';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { thinkingEffortLabel } from '@/lib/code-reviews/core/model-variants';
import { EnvironmentRepositoriesField } from './EnvironmentRepositoriesField';
import { EnvironmentVariablesEditor } from './EnvironmentVariablesEditor';
import { parseEnvironmentVariables } from './environment-variables';
import {
  getLastUsedModel,
  getLastUsedVariant,
  getPreferredInitialModel,
  getPreferredInitialVariant,
  setLastUsedModel,
  setLastUsedVariant,
} from './model-preferences';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted?: () => void;
  organizationId?: string;
  initialRepositories?: EnvironmentRepository[];
  targetEnvironmentId?: string;
  targetName?: string;
};

export function EnvironmentSetupAgentDialog({ open, onOpenChange, ...props }: Props) {
  const [saving, setSaving] = useState(false);
  const toggle = useEnvironmentSetupEnabled({
    organizationId: props.organizationId,
    enabled: open,
  });
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl [&_button]:pointer-coarse:min-h-11 [&_input]:pointer-coarse:min-h-11">
        <DialogHeader>
          <DialogTitle className="pr-10">
            Set up with agent{props.targetName ? ` · ${props.targetName}` : ''}
          </DialogTitle>
          <DialogDescription>
            The agent runs setup with full network access and records the hosts it contacts. Choose
            Full or Restricted access for the environment. It verifies your choice before saving.
            You can revert it afterwards.
          </DialogDescription>
        </DialogHeader>
        {open && toggle.data?.canStart === true ? (
          <SetupForm {...props} onClose={() => onOpenChange(false)} onSavingChange={setSaving} />
        ) : (
          <p role="status" className="text-muted-foreground text-sm">
            {toggle.isPending
              ? 'Checking access…'
              : 'Environment setup is not available for this account.'}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SetupForm({
  organizationId,
  initialRepositories = [],
  targetEnvironmentId,
  onClose,
  onStarted,
  onSavingChange,
}: Omit<Props, 'open' | 'onOpenChange'> & {
  onClose: () => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const router = useRouter();
  const { start } = useEnvironmentSetupRunMutations();
  const [repositories, setRepositories] = useState(initialRepositories);
  const [requirements, setRequirements] = useState('');
  const [name, setName] = useState('');
  const [secretsText, setSecretsText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<string | undefined>();
  const [selectedNetworkMode, setSelectedNetworkMode] = useState<EgressMode | null>(null);
  const target = useCloudAgentEnvironment(targetEnvironmentId ?? null, { organizationId });
  const networkMode = selectedNetworkMode ?? target.data?.egressMode ?? 'unrestricted';
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
  let secrets: Record<string, string> = {};
  let secretsError: string | null = null;
  try {
    secrets = Object.fromEntries(
      parseEnvironmentVariables(secretsText).map(variable => {
        if (variable.unchanged || variable.value.length === 0)
          throw new Error(`Enter a value for ${variable.key}.`);
        return [variable.key, variable.value];
      })
    );
    validateEnvironmentVarCount(Object.keys(secrets).length);
  } catch (caught) {
    secretsError = caught instanceof Error ? caught.message : 'Check the secrets.';
  }
  let nameError: string | null = null;
  if (name.trim()) {
    try {
      validateEnvironmentName(name.trim());
    } catch (caught) {
      nameError = caught instanceof Error ? caught.message : 'Check the name.';
    }
  }
  const valid =
    (!targetEnvironmentId || !!target.data) &&
    repositories.length > 0 &&
    !repositoryError &&
    requirements.trim().length > 0 &&
    requirements.length <= 8000 &&
    modelOptions.some(option => option.id === model) &&
    !secretsError &&
    !nameError;
  const handleStart = async () => {
    if (!valid || start.isPending) return;
    setError(null);
    onSavingChange(true);
    try {
      const result = await start.mutateAsync({
        organizationId,
        repositories,
        requirements: requirements.trim(),
        model,
        ...(variant ? { variant } : {}),
        ...(name.trim() && !targetEnvironmentId ? { name: name.trim() } : {}),
        targetEnvironmentId,
        ...(selectedNetworkMode !== null || !targetEnvironmentId
          ? { egressMode: networkMode }
          : {}),
        ...(Object.keys(secrets).length ? { secrets } : {}),
      });
      onClose();
      onStarted?.();
      const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
      router.push(`${basePath}/chat?sessionId=${result.kiloSessionId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start environment setup.');
    } finally {
      onSavingChange(false);
    }
  };
  return (
    <>
      <fieldset disabled={start.isPending} className="min-w-0 space-y-5">
        <EnvironmentRepositoriesField
          organizationId={organizationId}
          repositories={repositories}
          onChange={setRepositories}
        />
        {repositoryError && (
          <p role="alert" className="text-destructive text-sm">
            {repositoryError}
          </p>
        )}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Environment network access</legend>
          <p className="text-muted-foreground text-xs">
            Restricted access is recommended. Review the discovered hosts before restricted
            verification.
          </p>
          <div className="flex flex-wrap gap-4 text-sm">
            {(['unrestricted', 'allowlist'] as const).map(mode => (
              <label
                key={mode}
                className="flex cursor-pointer items-center gap-2 py-1 pointer-coarse:min-h-11"
              >
                <input
                  type="radio"
                  name="setup-network-access"
                  value={mode}
                  checked={networkMode === mode}
                  onChange={() => setSelectedNetworkMode(mode)}
                  disabled={!!targetEnvironmentId && !target.data}
                  className="accent-primary size-4"
                />
                {mode === 'unrestricted' ? 'Full' : 'Restricted (recommended)'}
              </label>
            ))}
          </div>
          {targetEnvironmentId && !target.data && (
            <p role={target.isError ? 'alert' : 'status'} className="text-muted-foreground text-xs">
              {target.isError
                ? 'Could not load the current network policy. Close and reopen setup to retry.'
                : 'Reading the current network policy…'}
            </p>
          )}
        </fieldset>
        <div className="grid gap-2">
          <Label htmlFor="setup-requirements">Requirements</Label>
          <Textarea
            id="setup-requirements"
            value={requirements}
            onChange={event => setRequirements(event.target.value)}
            required
            maxLength={8000}
            rows={4}
            aria-describedby="setup-requirements-count"
            placeholder="Describe how sessions should be set up. Example: Set it up so the Cloud Agent can run the local dev stack and the web tests."
          />
          <p
            id="setup-requirements-count"
            className="text-muted-foreground text-right text-xs tabular-nums"
          >
            {requirements.length}/8000
          </p>
        </div>
        <ModelCombobox
          modal
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
        {variants.length > 0 && (
          <div className="grid gap-2">
            <Label htmlFor="setup-variant">Thinking effort</Label>
            <Select
              value={variant}
              onValueChange={value => {
                setSelectedVariant(value);
                setLastUsedVariant(model, value, organizationId);
                setLastSelected({ model, variant: value });
              }}
            >
              <SelectTrigger id="setup-variant" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {variants.map(value => (
                  <SelectItem key={value} value={value}>
                    {thinkingEffortLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {!targetEnvironmentId && (
          <div className="grid gap-2">
            <Label htmlFor="setup-name">Name (optional)</Label>
            <Input
              id="setup-name"
              value={name}
              onChange={event => setName(event.target.value)}
              maxLength={ENVIRONMENT_LIMITS.MAX_NAME_LENGTH}
              aria-invalid={!!nameError}
            />
            {nameError && (
              <p role="alert" className="text-destructive text-sm">
                {nameError}
              </p>
            )}
          </div>
        )}
        <details className="space-y-3">
          <summary className="focus-visible:ring-ring cursor-pointer rounded-sm py-2 text-sm font-medium outline-none focus-visible:ring-2 pointer-coarse:min-h-11">
            Secrets (optional)
          </summary>
          <p className="text-muted-foreground text-xs">
            Stored encrypted in this environment. Every session that uses it can read them.
          </p>
          <EnvironmentVariablesEditor
            text={secretsText}
            onChange={setSecretsText}
            removedKeys={[]}
            error={secretsError}
          />
        </details>
      </fieldset>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={start.isPending}>
          Cancel
        </Button>
        <Button onClick={() => void handleStart()} disabled={!valid || start.isPending}>
          {start.isPending && <Loader2 className="size-4 animate-spin" />}Start setup
        </Button>
      </DialogFooter>
    </>
  );
}
