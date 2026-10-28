'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { canManageOrganization } from '@kilocode/app-shared/organizations';
import { buildEnkryptDetectRequestDetectors } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
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
        <GuardrailsLoader organizationId={organizationId} />
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
      <div className="flex max-w-4xl flex-col gap-6" aria-busy="true">
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (configQuery.isError) {
    return (
      <Alert variant="destructive" className="max-w-4xl">
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
  // Remounting on new saved content resets the form after a save or a change by another admin,
  // but not when a background refetch returns the same configuration.
  return (
    <GuardrailsForm
      key={configKey(configQuery.data)}
      organizationId={organizationId}
      saved={configQuery.data}
    />
  );
}

function GuardrailsForm({
  organizationId,
  saved,
}: {
  organizationId: string;
  saved: EnkryptGuardrailsConfig;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [savedDraft] = useState(() => toDraft(saved));
  const [draft, setDraft] = useState(savedDraft);
  const issues = getEnkryptGuardrailsIssues(draft);
  const isDirty = !draftsEqual(draft, savedDraft);
  const configurationError = issues.get('detectors') ?? issues.get('');
  const firstIssue = issues.values().next().value;

  const saveMutation = useMutation(
    trpc.organizations.guardrails.update.mutationOptions({
      onSuccess: result => {
        queryClient.setQueryData(
          trpc.organizations.guardrails.get.queryKey({ organizationId }),
          result
        );
        toast.success('AI Guardrails saved.');
      },
      onError: error => {
        toast.error(error.message || 'AI Guardrails couldn’t be saved. Try again.');
      },
    })
  );

  const updateDetector: UpdateEnkryptDetector = (id, patch) =>
    setDraft(current => ({
      ...current,
      detectors: { ...current.detectors, [id]: { ...current.detectors[id], ...patch } },
    }));

  return (
    <form
      className="flex max-w-4xl flex-col gap-6"
      onSubmit={event => {
        event.preventDefault();
        if (!isDirty || issues.size > 0) return;
        saveMutation.mutate({ organizationId, ...fromDraft(draft) });
      }}
    >
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

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!isDirty || issues.size > 0 || saveMutation.isPending}>
          {saveMutation.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!isDirty || saveMutation.isPending}
          onClick={() => setDraft(savedDraft)}
        >
          Discard changes
        </Button>
        {isDirty && firstIssue && (
          <p className="text-destructive text-sm" role="status">
            {firstIssue}
          </p>
        )}
      </div>
    </form>
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
              onChange(current => ({ ...current, scan_tool_results: scope === 'every_input' }))
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
  const requestBody = JSON.stringify(
    {
      text: '<checked input>',
      detectors: buildEnkryptDetectRequestDetectors(fromDraftDetectors(draft.detectors)),
      user_metadata: { organization_id: '<organization ID>' },
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
                The request the gateway sends to Enkrypt for each checked input with these settings.
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
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
