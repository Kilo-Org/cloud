'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronDown, Clock } from 'lucide-react';
import { canManageOrganization } from '@kilocode/app-shared/organizations';
import { ENKRYPT_OUTPUT_DETECTOR_IDS } from '@kilocode/db/schema-types';
import {
  blockingEnkryptDetectorIds,
  buildEnkryptDetectRequestDetectors,
  enabledEnkryptDetectorIds,
  enforcedEnkryptInputDetectors,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useRoleTesting } from '@/contexts/RoleTestingContext';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import { OrganizationPageHeader } from '../OrganizationPageHeader';
import { McpSkillGuardrailsSection } from './mcp-and-skills/McpSkillGuardrailsSection';
import { useDebouncedValue } from './mcp-and-skills/use-debounced-value';
import {
  EnkryptDetectorList,
  EnkryptOutputDetectorList,
  type UpdateEnkryptDetector,
  type UpdateEnkryptOutputDetector,
} from './EnkryptDetectorList';
import {
  applyKiloDefaultPreset,
  configKey,
  draftsEqual,
  fromDraft,
  fromDraftDetectors,
  getEnkryptGuardrailsIssues,
  getEnkryptOutputGuardrailIssues,
  toDraft,
  type EnkryptGuardrailsConfig,
  type EnkryptGuardrailsDraft,
  type EnkryptGuardrailsIssues,
} from './enkrypt-guardrails-draft';

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
          <McpSkillGuardrailsSection organizationId={organizationId} />
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
  const { invalid_saved_detectors, invalid_saved_output_detectors, output_available, ...saved } =
    configQuery.data;
  return (
    <GuardrailsForm
      organizationId={organizationId}
      saved={saved}
      invalidSavedDetectors={invalid_saved_detectors}
      invalidSavedOutputDetectors={invalid_saved_output_detectors}
      outputAvailable={output_available}
    />
  );
}

function GuardrailsForm({
  organizationId,
  saved,
  invalidSavedDetectors,
  invalidSavedOutputDetectors,
  outputAvailable,
}: {
  organizationId: string;
  saved: EnkryptGuardrailsConfig;
  invalidSavedDetectors: boolean;
  invalidSavedOutputDetectors: boolean;
  outputAvailable: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [savedDraft, setSavedDraft] = useState(() => toDraft(saved));
  const [draft, setDraft] = useState(savedDraft);
  const [syncedKey, setSyncedKey] = useState(() => configKey(saved));
  const debouncedDraft = useDebouncedValue(draft, AUTOSAVE_DELAY_MS);
  const attemptedKey = useRef<string | null>(null);
  const failedKey = useRef<string | null>(null);
  const issues = getEnkryptGuardrailsIssues(draft, outputAvailable);
  const outputIssues = getEnkryptOutputGuardrailIssues(draft.output);
  const isDirty = !draftsEqual(draft, savedDraft, outputAvailable);
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
        const {
          invalid_saved_detectors: _invalid,
          invalid_saved_output_detectors: _invalidOutput,
          output_available: _outputAvailable,
          ...savedConfig
        } = result;
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
    const { output, ...config } = fromDraft(toSave);
    attemptedKey.current = configKey({ ...config, output }, outputAvailable);
    failedKey.current = null;
    saveMutation.mutate({ organizationId, ...config, ...(outputAvailable ? { output } : {}) });
  };

  // Saves run one at a time. Only a settled draft is saved: while `debouncedDraft` lags `draft`,
  // it can hold edits the user has since undone or a configuration a refetch just replaced, and
  // saving it would overwrite newer settings. Invalid drafts wait for a fix, and a failed draft
  // is not retried until it changes or the user asks.
  const { isPending, mutate } = saveMutation;
  useEffect(() => {
    if (isPending) return;
    if (!draftsEqual(debouncedDraft, draft, outputAvailable)) return;
    if (draftsEqual(debouncedDraft, savedDraft, outputAvailable)) return;
    if (getEnkryptGuardrailsIssues(debouncedDraft, outputAvailable).size > 0) return;
    const { output, ...config } = fromDraft(debouncedDraft);
    const key = configKey({ ...config, output }, outputAvailable);
    if (key === failedKey.current) return;
    attemptedKey.current = key;
    mutate({ organizationId, ...config, ...(outputAvailable ? { output } : {}) });
  }, [debouncedDraft, draft, savedDraft, isPending, mutate, organizationId, outputAvailable]);

  const updateDetector: UpdateEnkryptDetector = (id, patch) =>
    setDraft(current => ({
      ...current,
      detectors: {
        ...current.detectors,
        [id]: { ...current.detectors[id], ...patch },
      },
    }));

  const updateOutputDetector: UpdateEnkryptOutputDetector = (id, patch) =>
    setDraft(current => ({
      ...current,
      output: {
        ...current.output,
        detectors: {
          ...current.output.detectors,
          [id]: { ...current.output.detectors[id], ...patch },
        },
      },
    }));

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      {invalidSavedDetectors && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Saved input detector settings can&apos;t be read</AlertTitle>
          <AlertDescription className="grid gap-3">
            <span>
              {saved.enabled
                ? 'Requests are blocked until the input detectors are saved again. '
                : ''}
              Review the input detectors below, which start from Kilo Default. Your changes save
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

      {invalidSavedOutputDetectors && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Saved output detector settings can&apos;t be read</AlertTitle>
          <AlertDescription className="grid gap-3">
            <span>
              {saved.output.enabled
                ? 'Responses are withheld until the output detectors are saved again. '
                : ''}
              {outputAvailable
                ? 'Choose output detectors below. Your changes save automatically.'
                : 'Contact Kilo support to restore access to output detector settings.'}
            </span>
            {outputAvailable && (
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
            )}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Enkrypt AI guardrails</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6">
          <InputGuardrailSection
            draft={draft}
            issues={issues}
            onChange={setDraft}
            onUpdateDetector={updateDetector}
          />
          {outputAvailable && (
            <>
              <Separator />
              <OutputGuardrailSection
                draft={draft}
                issues={outputIssues}
                onChange={setDraft}
                onUpdateDetector={updateOutputDetector}
              />
            </>
          )}
        </CardContent>
      </Card>

      {isDevelopment && draft.enabled && <RequestPreviewCard draft={draft} />}

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

type UpdateDraft = (update: (current: EnkryptGuardrailsDraft) => EnkryptGuardrailsDraft) => void;

function GuardrailSection({
  title,
  description,
  enabled,
  onEnabledChange,
  children,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <section aria-labelledby={titleId} className="grid gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <h3 id={titleId} className="text-base font-semibold">
            {title}
          </h3>
          <p id={descriptionId} className="text-muted-foreground text-sm">
            {description}
          </p>
        </div>
        <Switch
          checked={enabled}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onCheckedChange={onEnabledChange}
        />
      </div>
      {enabled && children}
    </section>
  );
}

function InputGuardrailSection({
  draft,
  issues,
  onChange,
  onUpdateDetector,
}: {
  draft: EnkryptGuardrailsDraft;
  issues: EnkryptGuardrailsIssues;
  onChange: UpdateDraft;
  onUpdateDetector: UpdateEnkryptDetector;
}) {
  const configurationError = issues.get('detectors') ?? issues.get('');

  return (
    <GuardrailSection
      title="Input guardrails"
      description="Check every input with Enkrypt AI before it reaches a model, including tool results such as file reads and command output. Requests are blocked while Enkrypt is unavailable."
      enabled={draft.enabled}
      onEnabledChange={enabled => onChange(current => ({ ...current, enabled }))}
    >
      {configurationError && (
        <p className="text-destructive text-sm" role="status">
          {configurationError}
        </p>
      )}
      <EnkryptDetectorList
        detectors={draft.detectors}
        issues={issues}
        onUpdate={onUpdateDetector}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange(current => ({
                ...current,
                detectors: applyKiloDefaultPreset(current.detectors),
              }))
            }
          >
            Apply Kilo Default
          </Button>
        }
      />
    </GuardrailSection>
  );
}

function OutputGuardrailSection({
  draft,
  issues,
  onChange,
  onUpdateDetector,
}: {
  draft: EnkryptGuardrailsDraft;
  issues: EnkryptGuardrailsIssues;
  onChange: UpdateDraft;
  onUpdateDetector: UpdateEnkryptOutputDetector;
}) {
  const { output } = draft;
  const configurationError = issues.get('detectors') ?? issues.get('');
  const holdsResponses = ENKRYPT_OUTPUT_DETECTOR_IDS.some(
    id => output.detectors[id].enabled && output.detectors[id].action === 'block'
  );

  return (
    <GuardrailSection
      title="Output guardrails"
      description="Check model responses with Enkrypt AI before your members receive them. Off unless you turn it on, separately from input guardrails."
      enabled={output.enabled}
      onEnabledChange={enabled =>
        onChange(current => ({ ...current, output: { ...current.output, enabled } }))
      }
    >
      <ul className="text-muted-foreground grid list-disc gap-1 pl-5 text-sm">
        <li>
          A detector set to Block holds back each response until Enkrypt has checked all of it, so
          responses no longer stream.
        </li>
        <li>
          Blocked responses are replaced with an error, and responses are withheld while Enkrypt is
          unavailable. The model&apos;s usage is still charged.
        </li>
        <li>
          Log only detectors check a copy of the response after it&apos;s sent and never delay it.
        </li>
        <li>
          Kilo sends the text of each response, including tool calls and reasoning that isn&apos;t
          encrypted, to Enkrypt AI with your organization ID.
        </li>
      </ul>
      {holdsResponses && (
        <Alert>
          <Clock />
          <AlertTitle>Responses no longer stream</AlertTitle>
          <AlertDescription>
            With a blocking output detector, members see nothing until the model has finished the
            whole response and Enkrypt has checked it, then it arrives all at once. Long responses
            can take minutes. Use Log only to monitor without the delay.
          </AlertDescription>
        </Alert>
      )}
      {configurationError && (
        <p className="text-destructive text-sm" role="status">
          {configurationError}
        </p>
      )}
      <EnkryptOutputDetectorList
        detectors={output.detectors}
        issues={issues}
        onUpdate={onUpdateDetector}
      />
    </GuardrailSection>
  );
}

function RequestPreviewCard({ draft }: { draft: EnkryptGuardrailsDraft }) {
  const [open, setOpen] = useState(false);
  const detectors = enforcedEnkryptInputDetectors(fromDraftDetectors(draft.detectors));
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
