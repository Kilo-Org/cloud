'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronDown } from 'lucide-react';
import { canManageOrganization } from '@kilocode/app-shared/organizations';
import {
  blockingEnkryptDetectorIds,
  buildEnkryptDetectRequestDetectors,
  enabledEnkryptDetectorIds,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useRoleTesting } from '@/contexts/RoleTestingContext';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import { OrganizationPageHeader } from '../OrganizationPageHeader';
import { AddonsSection } from './addons/AddonsSection';
import { useDebouncedValue } from './addons/use-debounced-value';
import { EnkryptDetectorList, type UpdateEnkryptDetector } from './EnkryptDetectorList';
import {
  applyKiloDefaultPreset,
  configKey,
  draftsEqual,
  fromDraft,
  fromDraftDetectors,
  getEnkryptGuardrailsIssues,
  toDraft,
  type EnkryptGuardrailsConfig,
  type EnkryptGuardrailsDraft,
} from './enkrypt-guardrails-draft';
import { RadioCardGroup } from './RadioCardGroup';

const SCAN_SCOPE_OPTIONS = [
  {
    value: 'new_user_input',
    label: 'New user input only',
    description:
      "Checks each new message a member sends, including attached files. Agent steps that only return tool results aren't checked. Fastest.",
  },
  {
    value: 'every_input',
    label: 'Every input',
    description:
      'Also checks new tool results, such as file reads and command output, on every agent step. Strictest, but slower.',
  },
] as const;

const AUTOSAVE_DELAY_MS = 800;

const isDevelopment = process.env.NODE_ENV === 'development';

export function OrganizationGuardrailsPage({
  organizationId,
  role,
}: {
  organizationId: string;
  role: OrganizationRole;
}) {
  const { assumedRole } = useRoleTesting();
  const currentRole = assumedRole === 'KILO ADMIN' ? 'owner' : assumedRole || role;

  return (
    <div className="flex w-full flex-col gap-y-4">
      <OrganizationPageHeader organizationId={organizationId} title="AI Guardrails" />
      {canManageOrganization(currentRole) ? (
        <div className="flex flex-col gap-6">
          <GuardrailsLoader organizationId={organizationId} />
          <AddonsSection organizationId={organizationId} />
        </div>
      ) : (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Access denied</AlertTitle>
          <AlertDescription>
            Only organization owners and admins can manage AI Guardrails.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function GuardrailsLoader({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const configQuery = useQuery(trpc.organizations.guardrails.get.queryOptions({ organizationId }));

  if (configQuery.isPending) {
    return (
      <div className="flex max-w-5xl flex-col gap-6" aria-busy="true">
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (configQuery.isError) {
    return (
      <Alert variant="destructive" className="max-w-5xl">
        <AlertCircle />
        <AlertTitle>AI Guardrails couldn&apos;t load</AlertTitle>
        <AlertDescription className="grid gap-3">
          <span>{configQuery.error.message}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => void configQuery.refetch()}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  const { invalid_saved_detectors, ...saved } = configQuery.data;
  return (
    <GuardrailsForm
      organizationId={organizationId}
      saved={saved}
      invalidSavedDetectors={invalid_saved_detectors}
    />
  );
}

function GuardrailsForm({
  organizationId,
  saved,
  invalidSavedDetectors,
}: {
  organizationId: string;
  saved: EnkryptGuardrailsConfig;
  invalidSavedDetectors: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [savedDraft, setSavedDraft] = useState(() => toDraft(saved));
  const [draft, setDraft] = useState(savedDraft);
  const [syncedKey, setSyncedKey] = useState(() => configKey(saved));
  const debouncedDraft = useDebouncedValue(draft, AUTOSAVE_DELAY_MS);
  const attemptedKey = useRef<string | null>(null);
  const failedKey = useRef<string | null>(null);
  const issues = getEnkryptGuardrailsIssues(draft);
  const isDirty = !draftsEqual(draft, savedDraft);
  const configurationError = issues.get('detectors') ?? issues.get('');
  const firstIssue = issues.values().next().value;

  const saveMutation = useMutation(
    trpc.organizations.guardrails.update.mutationOptions({
      onMutate: () =>
        queryClient.cancelQueries({
          queryKey: trpc.organizations.guardrails.get.queryKey({
            organizationId,
          }),
        }),
      onSuccess: result => {
        const { invalid_saved_detectors: _invalid, ...savedConfig } = result;
        failedKey.current = null;
        setSyncedKey(configKey(savedConfig));
        setSavedDraft(toDraft(savedConfig));
        queryClient.setQueryData(
          trpc.organizations.guardrails.get.queryKey({ organizationId }),
          result
        );
      },
      onError: () => {
        failedKey.current = attemptedKey.current;
      },
    })
  );

  // A refetch that brings a configuration saved elsewhere moves the baseline. Edits that have not
  // been saved yet win, because the next autosave replaces the newer settings.
  const savedKey = configKey(saved);
  if (savedKey !== syncedKey) {
    const next = toDraft(saved);
    setSyncedKey(savedKey);
    setSavedDraft(next);
    if (!isDirty && !saveMutation.isPending) setDraft(next);
  }

  const save = (toSave: EnkryptGuardrailsDraft) => {
    attemptedKey.current = configKey(fromDraft(toSave));
    failedKey.current = null;
    saveMutation.mutate({ organizationId, ...fromDraft(toSave) });
  };

  // Saves run one at a time. Invalid drafts wait for a fix, and a failed draft is not retried
  // until it changes or the user asks.
  const { isPending, mutate } = saveMutation;
  useEffect(() => {
    if (isPending) return;
    if (draftsEqual(debouncedDraft, savedDraft)) return;
    if (getEnkryptGuardrailsIssues(debouncedDraft).size > 0) return;
    const key = configKey(fromDraft(debouncedDraft));
    if (key === failedKey.current) return;
    attemptedKey.current = key;
    mutate({ organizationId, ...fromDraft(debouncedDraft) });
  }, [debouncedDraft, savedDraft, isPending, mutate, organizationId]);

  const updateDetector: UpdateEnkryptDetector = (id, patch) =>
    setDraft(current => ({
      ...current,
      detectors: {
        ...current.detectors,
        [id]: { ...current.detectors[id], ...patch },
      },
    }));

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      {invalidSavedDetectors && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Saved detector settings can&apos;t be read</AlertTitle>
          <AlertDescription className="grid gap-3">
            <span>
              {saved.enabled ? 'Requests are blocked until the detectors are saved again. ' : ''}
              Review the detectors below, which start from Kilo Default. Your changes save
              automatically.
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              disabled={issues.size > 0 || isPending}
              onClick={() => save(draft)}
            >
              Save detector settings
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <GuardrailsSettingsCard draft={draft} onChange={setDraft} />

      {draft.enabled && (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="grid gap-1.5">
                  <CardTitle>Input detectors</CardTitle>
                  <CardDescription>
                    Enkrypt runs the detectors you turn on against each checked input. Kilo Default
                    blocks prompt injection and logs secrets.
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setDraft(current => ({
                      ...current,
                      detectors: applyKiloDefaultPreset(current.detectors),
                    }))
                  }
                >
                  Apply Kilo Default
                </Button>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4">
              {configurationError && (
                <p className="text-destructive text-sm" role="status">
                  {configurationError}
                </p>
              )}
              <EnkryptDetectorList
                detectors={draft.detectors}
                issues={issues}
                onUpdate={updateDetector}
              />
            </CardContent>
          </Card>

          {isDevelopment && <RequestPreviewCard draft={draft} />}
        </>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm" role="status">
        {isDirty && firstIssue ? (
          <p className="text-destructive">Not saved yet. {firstIssue}</p>
        ) : saveMutation.isError ? (
          <>
            <p className="text-destructive">
              {saveMutation.error.message || 'AI Guardrails couldn’t be saved.'}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => save(draft)}>
              Try again
            </Button>
          </>
        ) : isPending || isDirty ? (
          <p className="text-muted-foreground">Saving…</p>
        ) : saveMutation.isSuccess ? (
          <p className="text-muted-foreground">All changes saved.</p>
        ) : (
          <p className="text-muted-foreground">Changes save automatically.</p>
        )}
      </div>
    </div>
  );
}

function GuardrailsSettingsCard({
  draft,
  onChange,
}: {
  draft: EnkryptGuardrailsDraft;
  onChange: (update: (current: EnkryptGuardrailsDraft) => EnkryptGuardrailsDraft) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <CardTitle id={titleId}>Enkrypt AI guardrails</CardTitle>
            <CardDescription id={descriptionId}>
              Check your members&apos; inputs with Enkrypt AI before they reach a model. Flagged
              inputs are blocked, and requests are blocked while Enkrypt is unavailable.
            </CardDescription>
          </div>
          <Switch
            checked={draft.enabled}
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onCheckedChange={enabled => onChange(current => ({ ...current, enabled }))}
          />
        </div>
      </CardHeader>
      {draft.enabled && (
        <CardContent className="grid gap-6">
          <RadioCardGroup
            legend="Inputs to check"
            options={SCAN_SCOPE_OPTIONS}
            value={draft.scan_tool_results ? 'every_input' : 'new_user_input'}
            onChange={scope =>
              onChange(current => ({
                ...current,
                scan_tool_results: scope === 'every_input',
              }))
            }
          />
          <ul className="text-muted-foreground grid list-disc gap-1 pl-5 text-sm">
            <li>
              Kilo sends the text of each checked input to Enkrypt AI with your organization ID.
              Member names and email addresses aren&apos;t sent.
            </li>
            <li>Response scanning isn&apos;t available. Only inputs are checked.</li>
            <li>
              Detection history isn&apos;t available yet. A per-organization history in Kilo Cloud
              is planned.
            </li>
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

function RequestPreviewCard({ draft }: { draft: EnkryptGuardrailsDraft }) {
  const [open, setOpen] = useState(false);
  const detectors = fromDraftDetectors(draft.detectors);
  const requestBody = JSON.stringify(
    {
      text: '<checked input>',
      detectors: buildEnkryptDetectRequestDetectors(detectors),
      user_metadata: { organization_id: '<organization ID>' },
    },
    null,
    2
  );
  const blocking = blockingEnkryptDetectorIds(detectors);
  const gatewayDecision = JSON.stringify(
    {
      blocks_when_detected: blocking,
      logs_when_detected: enabledEnkryptDetectorIds(detectors).filter(id => !blocking.includes(id)),
    },
    null,
    2
  );

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1.5">
              <CardTitle>Request preview</CardTitle>
              <CardDescription>
                The request the gateway sends to Enkrypt for each checked input with these settings,
                and what the gateway does with each detection. Block or log is decided by the
                gateway from Enkrypt&apos;s verdict, so it never appears in the Enkrypt request.
                Shown only in development.
              </CardDescription>
            </div>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm">
                {open ? 'Hide' : 'Show'}
                <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
              </Button>
            </CollapsibleTrigger>
          </div>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="grid gap-2">
            <code className="text-muted-foreground font-mono text-xs">
              POST https://api.enkryptai.com/guardrails/detect
            </code>
            <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">
              {requestBody}
            </pre>
            <code className="text-muted-foreground mt-2 font-mono text-xs">Gateway decision</code>
            <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">
              {gatewayDecision}
            </pre>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
