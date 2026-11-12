'use client';

import { useId, useMemo, useState } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import {
  watchPrDefaultTrustedBotLogins,
  type WatchPrMaintenancePolicy,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import type { RootRouter } from '@/routers/root-router';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  buildMaintenanceEnablePolicy,
  maintenanceInheritedSettingsChanged,
  noMaintenanceConsent,
} from './pr-maintenance-enablement';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type WatchOptions = inferRouterOutputs<RootRouter>['cliSessionsV2']['getPrWatchOptions'];
const DEFAULT_MODEL_VARIANT = '__model_default__';

export function PrMaintenanceEnableForm({
  options,
  optionsError,
  pending,
  onEnable,
}: {
  options: WatchOptions;
  optionsError?: string;
  pending: boolean;
  onEnable: (input: { integrationId: string; policy: WatchPrMaintenancePolicy }) => void;
}) {
  const id = useId();
  const models = useModelSelectorList(options.organizationId ?? undefined);
  const [model, setModel] = useState(options.defaults.model ?? '');
  const [variant, setVariant] = useState(options.defaults.variant ?? null);
  const [integrationId, setIntegrationId] = useState(options.defaultIntegrationId ?? '');
  const [botLogins, setBotLogins] = useState(watchPrDefaultTrustedBotLogins.join(', '));
  const [categories, setCategories] = useState({
    reviews: true,
    failedChecks: true,
    conflicts: true,
  });
  const [consent, setConsent] = useState(noMaintenanceConsent);
  const [reviewedSettings, setReviewedSettings] = useState({
    profileId: options.defaults.profileId,
    environmentId: options.defaults.environmentId,
    profile: options.executionSettings.profile,
    environment: options.executionSettings.environment,
  });
  const [validationError, setValidationError] = useState<string | null>(null);
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      (models.data?.data ?? []).map(value => ({
        id: value.id,
        name: value.name,
        isFree: value.isFree,
        mayTrainOnYourPrompts: value.mayTrainOnYourPrompts,
        hasUserByokAvailable: value.hasUserByokAvailable,
        variants: value.opencode?.variants ? Object.keys(value.opencode.variants) : [],
      })),
    [models.data]
  );
  const selectedModel = modelOptions.find(value => value.id === model);
  const variants = selectedModel?.variants ?? [];
  const settingsChanged = maintenanceInheritedSettingsChanged(reviewedSettings, options.defaults);
  const connectionAvailable = options.integrationOptions.some(
    option => option.integrationId === integrationId
  );
  const canSubmit =
    options.canEnable &&
    !optionsError &&
    connectionAvailable &&
    Boolean(selectedModel) &&
    !settingsChanged &&
    consent.automaticWritesConsent &&
    consent.historyRewriteConsent &&
    consent.noHardSpendCapConsent &&
    Object.values(categories).some(Boolean) &&
    (!variant || variants.includes(variant));

  return (
    <form
      className="min-w-0 space-y-4"
      onSubmit={event => {
        event.preventDefault();
        if (!canSubmit || pending) return;
        const policy = buildMaintenanceEnablePolicy(
          {
            ...consent,
            model,
            variant,
            trustedBotLogins: [
              ...new Set(
                botLogins
                  .split(',')
                  .map(login => login.trim().toLowerCase())
                  .filter(Boolean)
              ),
            ],
            categories,
          },
          reviewedSettings,
          options.defaults
        );
        if (!policy.success) {
          setValidationError(policy.message);
          return;
        }
        setValidationError(null);
        onEnable({ integrationId, policy: policy.policy });
      }}
    >
      <p className="text-muted-foreground text-sm">
        Maintenance assesses existing feedback, failed checks, and conflicts. It continues until you
        stop it or the PR closes.
      </p>
      <div className="space-y-2">
        <Label htmlFor={`${id}-connection`}>GitHub connection</Label>
        <Select value={integrationId} onValueChange={setIntegrationId} disabled={pending}>
          <SelectTrigger id={`${id}-connection`} className="w-full min-w-0">
            <SelectValue className="min-w-0 truncate" placeholder="Select a connection" />
          </SelectTrigger>
          <SelectContent>
            {options.integrationOptions.map(integration => (
              <SelectItem key={integration.integrationId} value={integration.integrationId}>
                {integration.accountLogin ?? 'GitHub'} · {integration.appType}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {integrationId && !connectionAvailable && (
          <p role="alert" className="text-destructive text-xs">
            The selected GitHub connection is no longer available. Select another connection.
          </p>
        )}
      </div>
      <ModelCombobox
        id={`${id}-model`}
        label="Maintenance model"
        models={modelOptions}
        value={model}
        onValueChange={value => {
          setModel(value);
          setVariant(null);
        }}
        isLoading={models.isLoading}
        error={models.error?.message}
        required
        modal
        disabled={pending}
      />
      {variants.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor={`${id}-variant`}>Model variant</Label>
          <Select
            value={variant ?? DEFAULT_MODEL_VARIANT}
            onValueChange={value => setVariant(value === DEFAULT_MODEL_VARIANT ? null : value)}
            disabled={pending}
          >
            <SelectTrigger id={`${id}-variant`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODEL_VARIANT}>Model default</SelectItem>
              {variants.map(value => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {selectedModel && variant && !variants.includes(variant) && (
        <div className="space-y-2 text-xs">
          <p role="alert" className="text-destructive">
            The recorded variant is unavailable for this model. Select a listed variant or use the
            model default.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setVariant(null)}
          >
            Use model default
          </Button>
        </div>
      )}
      <dl className="bg-muted/40 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-md p-3 text-xs">
        <dt className="text-muted-foreground">Environment</dt>
        <dd className="wrap-anywhere">
          {reviewedSettings.environment?.name ?? 'No saved environment'}
        </dd>
        <dt className="text-muted-foreground">Profile</dt>
        <dd className="wrap-anywhere">{reviewedSettings.profile?.name ?? 'No saved profile'}</dd>
      </dl>
      <p className="text-muted-foreground text-xs">
        Maintenance inherits the workspace settings you reviewed. Secrets are not shown.
      </p>
      {settingsChanged && (
        <div role="alert" className="border-border space-y-2 rounded-md border p-3 text-xs">
          <p>Workspace settings changed. Review the current settings and give consent again.</p>
          <p>
            Current environment:{' '}
            {options.executionSettings.environment?.name ?? 'No saved environment'}
          </p>
          <p>Current profile: {options.executionSettings.profile?.name ?? 'No saved profile'}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setReviewedSettings({
                profileId: options.defaults.profileId,
                environmentId: options.defaults.environmentId,
                profile: options.executionSettings.profile,
                environment: options.executionSettings.environment,
              });
              setConsent(noMaintenanceConsent);
              setValidationError(null);
            }}
          >
            Use current workspace settings
          </Button>
        </div>
      )}
      <fieldset className="space-y-2" disabled={pending}>
        <legend className="mb-1 text-sm font-medium">Repair categories</legend>
        {(
          [
            ['reviews', 'Actionable review feedback'],
            ['failedChecks', 'Failed checks on the current commit'],
            ['conflicts', 'Merge conflicts with the target branch'],
          ] as const
        ).map(([category, label]) => (
          <label key={category} className="flex min-h-9 items-center gap-2 text-sm">
            <Checkbox
              checked={categories[category]}
              onCheckedChange={checked =>
                setCategories(current => ({ ...current, [category]: checked }))
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      <div className="space-y-2">
        <Label htmlFor={`${id}-bots`}>Trusted review bot logins</Label>
        <Input
          id={`${id}-bots`}
          value={botLogins}
          onChange={event => setBotLogins(event.target.value)}
          disabled={pending}
          aria-describedby={`${id}-bots-help`}
        />
        <p id={`${id}-bots-help`} className="text-muted-foreground text-xs">
          Separate logins with commas. Kilo review bots are included by default. This list accepts
          GitHub bot accounts. Machine-user accounts need collaborator, member, or owner access.
        </p>
      </div>
      <fieldset disabled={pending} className="border-border space-y-3 border-t pt-3">
        <legend className="sr-only">Automatic maintenance consent</legend>
        <label className="flex min-h-9 items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5 shrink-0"
            checked={consent.automaticWritesConsent}
            onCheckedChange={checked =>
              setConsent(current => ({ ...current, automaticWritesConsent: checked }))
            }
          />
          <span>
            I allow maintenance to edit files, commit its changes, and push to this PR branch.
          </span>
        </label>
        <label className="flex min-h-9 items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5 shrink-0"
            checked={consent.historyRewriteConsent}
            onCheckedChange={checked =>
              setConsent(current => ({ ...current, historyRewriteConsent: checked }))
            }
          />
          <span>
            I allow conflict-only rebases and pushes with an exact force-with-lease check. This can
            rewrite branch history.
          </span>
        </label>
        <label className="flex min-h-9 items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5 shrink-0"
            checked={consent.noHardSpendCapConsent}
            onCheckedChange={checked =>
              setConsent(current => ({ ...current, noHardSpendCapConsent: checked }))
            }
          />
          <span>
            I accept normal credit charges without a hard spending cap. Limits allow two attempts
            per problem and ten attempts in total.
          </span>
        </label>
      </fieldset>
      <p className="text-muted-foreground text-xs">
        Maintenance can share the checkout with your chats. Branch restrictions are agent
        instructions, not enforced access limits. Merging remains your action.
      </p>
      {(validationError || options.unavailableReason) && (
        <p role="alert" className="text-destructive text-sm">
          {validationError ?? options.unavailableReason}
        </p>
      )}
      <Button type="submit" className="w-full min-h-11" disabled={pending || !canSubmit}>
        {pending ? 'Enabling maintenance…' : 'Enable automatic maintenance'}
      </Button>
    </form>
  );
}
