'use client';

import { useId, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  pullRequestAutoFixSettingsSchema,
  watchPrDefaultTrustedBotLogins,
  type PullRequestAutoFixSettings,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import { useTRPC } from '@/lib/trpc/utils';

export function PullRequestAutoFixSection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(trpc.cloudAgentSettings.getPullRequestAutoFix.queryOptions());
  const save = useMutation({
    ...trpc.cloudAgentSettings.setPullRequestAutoFix.mutationOptions(),
    onSuccess: async value => {
      queryClient.setQueryData(trpc.cloudAgentSettings.getPullRequestAutoFix.queryKey(), value);
      await queryClient.invalidateQueries(
        trpc.cloudAgentSettings.getPullRequestAutoFix.pathFilter()
      );
    },
  });

  if (settings.isPending)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Loading auto-fix settings…
      </p>
    );
  if (settings.isError)
    return (
      <div role="alert" className="space-y-3 text-sm">
        <p>Could not load auto-fix settings.</p>
        <Button variant="outline" size="sm" onClick={() => void settings.refetch()}>
          Retry
        </Button>
      </div>
    );

  return (
    <AutoFixSettingsForm
      initial={settings.data}
      pending={save.isPending}
      error={save.error?.message}
      saved={save.isSuccess}
      onSave={value => save.mutate(value)}
    />
  );
}

function AutoFixSettingsForm({
  initial,
  pending,
  error,
  saved,
  onSave,
}: {
  initial: PullRequestAutoFixSettings | null;
  pending: boolean;
  error?: string;
  saved: boolean;
  onSave: (settings: PullRequestAutoFixSettings) => void;
}) {
  const id = useId();
  const models = useModelSelectorList(undefined);
  const [autoEnable, setAutoEnable] = useState(initial?.autoEnable ?? false);
  const [model, setModel] = useState(initial?.model ?? '');
  const [variant, setVariant] = useState(initial?.variant ?? null);
  const [botLogins, setBotLogins] = useState(
    (initial?.trustedBotLogins ?? watchPrDefaultTrustedBotLogins).join(', ')
  );
  const [categories, setCategories] = useState(
    initial?.categories ?? { reviews: true, failedChecks: true, conflicts: true }
  );
  const [consent, setConsent] = useState({
    automaticWritesConsent: initial?.automaticWritesConsent ?? false,
    historyRewriteConsent: initial?.historyRewriteConsent ?? false,
    noHardSpendCapConsent: initial?.noHardSpendCapConsent ?? false,
  });
  const [validationError, setValidationError] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
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
  const canSubmit =
    !pending &&
    Object.values(categories).some(Boolean) &&
    Object.values(consent).every(Boolean) &&
    ((Boolean(selectedModel) && (!variant || variants.includes(variant))) ||
      (!autoEnable && initial?.model === model && initial?.variant === variant));

  return (
    <form
      className="max-w-2xl space-y-6"
      onChange={() => setEdited(true)}
      onSubmit={event => {
        event.preventDefault();
        if (!canSubmit) return;
        const parsed = pullRequestAutoFixSettingsSchema.safeParse({
          autoEnable,
          model,
          variant,
          categories,
          ...consent,
          trustedBotLogins: [
            ...new Set(
              botLogins
                .split(',')
                .map(login => login.trim().toLowerCase())
                .filter(Boolean)
            ),
          ],
        });
        if (!parsed.success) {
          setValidationError(parsed.error.issues[0]?.message ?? 'Check the auto-fix settings.');
          return;
        }
        setValidationError(null);
        setEdited(false);
        onSave(parsed.data);
      }}
    >
      <div className="space-y-2">
        <h3 className="text-base font-medium">Pull request auto-fix</h3>
        <p className="text-muted-foreground text-sm">
          Fix review feedback, failed checks, and merge conflicts in your GitHub PR workspaces. You
          control merging.
        </p>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor={`${id}-auto-enable`}>Automatically enable for all PR workspaces</Label>
          <Switch
            id={`${id}-auto-enable`}
            checked={autoEnable}
            onCheckedChange={value => {
              setAutoEnable(value);
              setEdited(true);
            }}
            disabled={pending}
            aria-describedby={`${id}-scope`}
          />
        </div>
        <p id={`${id}-scope`} className="text-muted-foreground text-xs">
          Applies to your current and future eligible workspaces, including organization workspaces.
          Uses each workspace’s environment and profile.
        </p>
        <p className="text-muted-foreground text-xs">
          Turning this off does not stop PRs already enabled. Paused or stopped PRs stay paused or
          stopped.
        </p>
      </div>
      <ModelCombobox
        id={`${id}-model`}
        label="Auto-fix model"
        models={modelOptions}
        value={model}
        onValueChange={value => {
          setModel(value);
          setVariant(null);
          setEdited(true);
        }}
        isLoading={models.isLoading}
        error={models.error?.message}
        required
        modal
        disabled={pending}
      />
      {(variants.length > 0 || variant) && (
        <div className="space-y-2">
          <Label htmlFor={`${id}-variant`}>Model variant</Label>
          <Select
            value={variant ?? '__default__'}
            onValueChange={value => {
              setVariant(value === '__default__' ? null : value);
              setEdited(true);
            }}
            disabled={pending}
          >
            <SelectTrigger id={`${id}-variant`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">Model default</SelectItem>
              {variants.map(value => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <fieldset disabled={pending} className="space-y-2">
        <legend className="mb-1 text-sm font-medium">What to fix</legend>
        {(
          [
            ['reviews', 'Review feedback'],
            ['failedChecks', 'Failed checks'],
            ['conflicts', 'Merge conflicts'],
          ] as const
        ).map(([category, label]) => (
          <label key={category} className="flex min-h-9 items-center gap-2 text-sm">
            <Checkbox
              checked={categories[category]}
              onCheckedChange={checked => {
                setCategories(current => ({ ...current, [category]: checked }));
                setEdited(true);
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <div className="space-y-2">
        <Label htmlFor={`${id}-bots`}>Trusted review bots</Label>
        <Input
          id={`${id}-bots`}
          value={botLogins}
          onChange={event => setBotLogins(event.target.value)}
          disabled={pending}
          aria-describedby={`${id}-bots-help`}
        />
        <p id={`${id}-bots-help`} className="text-muted-foreground text-xs">
          Separate GitHub bot logins with commas. Kilo review bots are included by default.
        </p>
      </div>
      <fieldset disabled={pending} className="space-y-3 border-t pt-4">
        <legend className="sr-only">Auto-fix permissions</legend>
        {(
          [
            [
              'automaticWritesConsent',
              'Allow auto-fix to edit files, commit, and push to my PR branches.',
            ],
            [
              'historyRewriteConsent',
              'Allow conflict-only rebases and force-with-lease pushes. This can rewrite branch history.',
            ],
            [
              'noHardSpendCapConsent',
              'Accept normal credit charges without a hard spending cap. Each PR allows two attempts per problem and ten in total.',
            ],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex min-h-9 items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5 shrink-0"
              checked={consent[key]}
              onCheckedChange={checked => {
                setConsent(current => ({ ...current, [key]: checked }));
                setEdited(true);
              }}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <p className="text-muted-foreground text-xs">
        Auto-fix shares the workspace checkout with your chats. Branch restrictions are agent
        instructions, not access limits. Changes apply when auto-fix next enables.
      </p>
      {(validationError || error) && (
        <p role="alert" className="text-destructive text-sm">
          {validationError ?? error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!canSubmit}>
          {pending ? 'Saving…' : 'Save settings'}
        </Button>
        {saved && !edited && (
          <p role="status" className="text-muted-foreground text-sm">
            Settings saved
          </p>
        )}
      </div>
    </form>
  );
}
