'use client';

import {
  AutoRouterSchema,
  AutoRoutingModeSchema,
  CUSTOM_ROUTER_SLUG_PATTERN,
  MAX_CUSTOM_ROUTER_ENTRIES,
  RESERVED_USER_CUSTOM_ROUTER_SLUG,
  customRouterEntryKey,
  customRouterModelId,
  isVirtualAutoModelId,
  type AutoRouter,
  type AutoRoutingMode,
  type CustomRouterEntry,
  type CustomRouterScope,
  type CustomRouterSummary,
} from '@kilocode/auto-routing-contracts';
import { useMutation } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import React, { useId, useMemo, useState } from 'react';
import { CUSTOM_LLM_PREFIX } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import {
  BASE_ROUTER_OPTIONS,
  MODE_OPTIONS,
  customRouterItemEndpoint,
  customRoutersEndpoint,
  entryLabel,
  readCustomRouterResponse,
} from './custom-router-display';

type Draft = {
  name: string;
  slug: string;
  baseRouter: AutoRouter;
  mode: AutoRoutingMode;
  entries: CustomRouterEntry[];
  defaultEntryKey: string | null;
};

function initialDraft(router: CustomRouterSummary | undefined): Draft {
  if (!router) {
    return {
      name: '',
      slug: '',
      baseRouter: 'efficient',
      mode: 'cost_per_accuracy',
      entries: [],
      defaultEntryKey: null,
    };
  }
  return {
    name: router.name,
    slug: router.slug,
    baseRouter: router.baseRouter,
    mode: router.mode,
    entries: router.entries.map(item => item.entry),
    defaultEntryKey: router.defaultEntryKey,
  };
}

export function slugError(scope: CustomRouterScope, slug: string): string | null {
  if (!CUSTOM_ROUTER_SLUG_PATTERN.test(slug)) {
    return 'Use 1–40 lowercase letters, digits, or hyphens. Start and end with a letter or digit.';
  }
  if (scope === 'user' && slug === RESERVED_USER_CUSTOM_ROUTER_SLUG) {
    return `The slug ${RESERVED_USER_CUSTOM_ROUTER_SLUG} is reserved for organization routers.`;
  }
  return null;
}

type Props = {
  scope: CustomRouterScope;
  organizationId: string | undefined;
  router: CustomRouterSummary | undefined;
  onClose: () => void;
  onSaved: (router: CustomRouterSummary) => void;
};

export function CustomRouterDialog({ scope, organizationId, router, onClose, onSaved }: Props) {
  const idPrefix = useId();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(router));
  const [addModelId, setAddModelId] = useState<string | undefined>();
  const [submitted, setSubmitted] = useState(false);
  const modelsQuery = useModelSelectorList(organizationId);

  const entryKeys = useMemo(() => new Set(draft.entries.map(customRouterEntryKey)), [draft]);
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      (modelsQuery.data?.data ?? [])
        .filter(
          model =>
            !isVirtualAutoModelId(model.id) &&
            !model.id.startsWith(CUSTOM_LLM_PREFIX) &&
            !entryKeys.has(customRouterEntryKey({ kind: 'gateway', model: model.id }))
        )
        .map(model => ({
          id: model.id,
          name: model.name,
          isFree: model.isFree,
          mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
          hasUserByokAvailable: model.hasUserByokAvailable,
        })),
    [modelsQuery.data, entryKeys]
  );

  const saveMutation = useMutation({
    mutationFn: async (): Promise<CustomRouterSummary> => {
      const fields = {
        name: draft.name.trim(),
        baseRouter: draft.baseRouter,
        mode: draft.mode,
        entries: draft.entries,
        defaultEntryKey: draft.defaultEntryKey,
      };
      const response = router
        ? await fetch(customRouterItemEndpoint(router.scope, router.slug, organizationId), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(fields),
          })
        : await fetch(customRoutersEndpoint(organizationId), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...fields, scope, slug: draft.slug }),
          });
      return readCustomRouterResponse(response);
    },
    onSuccess: onSaved,
  });

  const nameError = draft.name.trim() ? null : 'Enter a name.';
  const currentSlugError = router ? null : slugError(scope, draft.slug);
  const entriesError = draft.entries.length === 0 ? 'Add at least one model.' : null;
  const canSave = !nameError && !currentSlugError && !entriesError && draft.defaultEntryKey;
  const atEntryLimit = draft.entries.length >= MAX_CUSTOM_ROUTER_ENTRIES;
  const pending = saveMutation.isPending;

  const addModel = () => {
    if (!addModelId || atEntryLimit) return;
    const entry: CustomRouterEntry = { kind: 'gateway', model: addModelId };
    setDraft(current => ({
      ...current,
      entries: [...current.entries, entry],
      defaultEntryKey: current.defaultEntryKey ?? customRouterEntryKey(entry),
    }));
    setAddModelId(undefined);
  };

  const removeEntry = (key: string) => {
    setDraft(current => {
      const entries = current.entries.filter(entry => customRouterEntryKey(entry) !== key);
      const first = entries[0];
      return {
        ...current,
        entries,
        defaultEntryKey:
          current.defaultEntryKey === key
            ? first
              ? customRouterEntryKey(first)
              : null
            : current.defaultEntryKey,
      };
    });
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (canSave) saveMutation.mutate();
  };

  const fieldId = (name: string) => `${idPrefix}-${name}`;
  const modelIdPreview = draft.slug ? customRouterModelId(scope, draft.slug) : null;

  return (
    <Dialog open onOpenChange={open => (!open && !pending ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-6" noValidate>
          <DialogHeader>
            <DialogTitle>{router ? `Edit ${router.name}` : 'Create custom router'}</DialogTitle>
            <DialogDescription>
              A custom router picks a model from its pool for each request. Use its model ID like
              any other model.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={fieldId('name')}>Name</Label>
              <Input
                id={fieldId('name')}
                value={draft.name}
                maxLength={100}
                disabled={pending}
                aria-invalid={submitted && nameError ? true : undefined}
                onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
              />
              {submitted && nameError ? (
                <p className="text-destructive text-sm">{nameError}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor={fieldId('slug')}>Slug</Label>
              <Input
                id={fieldId('slug')}
                value={draft.slug}
                disabled={pending || router !== undefined}
                className="font-mono"
                aria-describedby={fieldId('slug-help')}
                aria-invalid={submitted && currentSlugError ? true : undefined}
                onChange={event =>
                  setDraft(current => ({ ...current, slug: event.target.value.toLowerCase() }))
                }
              />
              <p id={fieldId('slug-help')} className="text-muted-foreground text-xs">
                {router
                  ? 'The slug is part of the model ID and cannot change.'
                  : modelIdPreview
                    ? `Model ID: ${modelIdPreview}`
                    : 'The slug becomes part of the model ID.'}
              </p>
              {submitted && currentSlugError ? (
                <p className="text-destructive text-sm">{currentSlugError}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor={fieldId('base')}>Base router</Label>
              <Select
                value={draft.baseRouter}
                disabled={pending}
                onValueChange={value =>
                  setDraft(current => ({ ...current, baseRouter: AutoRouterSchema.parse(value) }))
                }
              >
                <SelectTrigger id={fieldId('base')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BASE_ROUTER_OPTIONS.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                Sets the benchmark dataset and routing thresholds.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={fieldId('mode')}>Routing mode</Label>
              <Select
                value={draft.mode}
                disabled={pending}
                onValueChange={value =>
                  setDraft(current => ({ ...current, mode: AutoRoutingModeSchema.parse(value) }))
                }
              >
                <SelectTrigger id={fieldId('mode')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODE_OPTIONS.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">Model pool</h3>
              <p className="text-muted-foreground text-sm">
                Up to {MAX_CUSTOM_ROUTER_ENTRIES} models. Add local and other client models with{' '}
                <code className="font-mono">kilo auto router add</code> in the CLI.
              </p>
            </div>
            {draft.entries.length > 0 ? (
              <ul className="space-y-2">
                {draft.entries.map(entry => {
                  const key = customRouterEntryKey(entry);
                  return (
                    <li
                      key={key}
                      className="bg-card flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-sm">{entryLabel(entry)}</span>
                        {entry.kind === 'client' ? <Badge variant="secondary">Client</Badge> : null}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        disabled={pending}
                        aria-label={`Remove ${entryLabel(entry)} from pool`}
                        onClick={() => removeEntry(key)}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p
                className="bg-muted/30 text-muted-foreground rounded-md border border-dashed p-4 text-sm"
                role="status"
              >
                No models yet. Add the first model to the pool.
              </p>
            )}
            {submitted && entriesError ? (
              <p className="text-destructive text-sm">{entriesError}</p>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <ModelCombobox
                  id={fieldId('add-model')}
                  label="Add model"
                  models={modelOptions}
                  value={addModelId}
                  onValueChange={setAddModelId}
                  isLoading={modelsQuery.isLoading}
                  disabled={pending || atEntryLimit}
                  modal
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="sm:mb-0.5"
                disabled={pending || !addModelId || atEntryLimit}
                onClick={addModel}
              >
                Add model
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor={fieldId('default')}>Default model</Label>
            <Select
              value={draft.defaultEntryKey ?? undefined}
              disabled={pending || draft.entries.length === 0}
              onValueChange={value => setDraft(current => ({ ...current, defaultEntryKey: value }))}
            >
              <SelectTrigger id={fieldId('default')} aria-describedby={fieldId('default-help')}>
                <SelectValue placeholder="Choose a pool model" />
              </SelectTrigger>
              <SelectContent>
                {draft.entries.map(entry => (
                  <SelectItem key={customRouterEntryKey(entry)} value={customRouterEntryKey(entry)}>
                    {entryLabel(entry)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id={fieldId('default-help')} className="text-muted-foreground text-xs">
              Used when the router cannot decide.
            </p>
          </div>

          {saveMutation.error ? (
            <Alert variant="destructive">
              <AlertTitle>Could not save the router</AlertTitle>
              <AlertDescription>{saveMutation.error.message}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving router…' : router ? 'Save router' : 'Create router'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
