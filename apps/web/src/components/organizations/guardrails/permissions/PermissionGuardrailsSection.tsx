'use client';

import { useId, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Info, Plus } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  MAX_PATTERN_LENGTH,
  MAX_PERMISSION_LENGTH,
  isToolLevelPermission,
  type PermissionAction,
  type PermissionEnforcement,
} from '@/lib/organizations/permissions/types';
import { useTRPC } from '@/lib/trpc/utils';
import { RadioCardGroup } from '../RadioCardGroup';
import { useDebouncedValue } from '../mcp-and-skills/use-debounced-value';
import {
  DEFAULT_EFFECT_OPTIONS,
  ENFORCEMENT_OPTIONS,
  GIT_READ_ONLY_PRESET,
  KNOWN_PERMISSIONS,
  actionLabel,
  compareRulesForDisplay,
  planPreset,
  presetResultMessage,
  tierLabel,
} from './permission-display';
import { PermissionRuleDialog } from './PermissionRuleDialog';
import { PermissionRulesTable } from './PermissionRulesTable';
import { PermissionUsageLog } from './PermissionUsageLog';
import type { PermissionRuleRow } from './permission-types';

const PREVIEW_DEBOUNCE_MS = 300;

export function PermissionGuardrailsSection({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const listQuery = useQuery(
    trpc.organizations.permissionRules.list.queryOptions({ organizationId })
  );

  if (listQuery.isPending) {
    return (
      <div className="flex max-w-5xl flex-col gap-6" aria-busy="true">
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }
  if (listQuery.isError) {
    return (
      <Alert variant="destructive" className="max-w-5xl">
        <AlertCircle />
        <AlertTitle>Tool and command permissions couldn’t load</AlertTitle>
        <AlertDescription className="grid gap-3">
          <span>{listQuery.error.message}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => void listQuery.refetch()}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <PermissionGuardrailsCard
      organizationId={organizationId}
      enforcement={listQuery.data.enforcement}
      defaultEffect={listQuery.data.defaultEffect}
      rules={listQuery.data.rules}
    />
  );
}

function PermissionGuardrailsCard({
  organizationId,
  enforcement,
  defaultEffect,
  rules,
}: {
  organizationId: string;
  enforcement: PermissionEnforcement;
  defaultEffect: PermissionAction;
  rules: PermissionRuleRow[];
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mutation = useMutation(
    trpc.organizations.permissionRules.setEnforcement.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.permissionRules.pathKey(),
        });
        toast.success('Permissions saved.');
      },
      onError: error => {
        toast.error(error.message || 'Permissions couldn’t be saved. Try again.');
      },
    })
  );

  const currentEnforcement =
    mutation.isPending && mutation.variables.enforcement
      ? mutation.variables.enforcement
      : enforcement;
  const currentDefault =
    mutation.isPending && mutation.variables.defaultEffect
      ? mutation.variables.defaultEffect
      : defaultEffect;

  return (
    <Card className="max-w-5xl">
      <CardHeader>
        <div className="grid gap-1.5">
          <CardTitle>Tool and command permissions</CardTitle>
          <CardDescription>
            Control which tools and commands Kilo can run for your members. Rules apply in every
            Kilo client that signs in to your organization.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6">
        <Alert>
          <Info />
          <AlertDescription>
            Your organization can restrict what Kilo does, but cannot remove prompts. If Kilo or a
            member’s own settings ask before a tool runs, the member is still asked.
          </AlertDescription>
        </Alert>

        <RadioCardGroup
          legend="Enforcement"
          options={ENFORCEMENT_OPTIONS}
          value={currentEnforcement}
          disabled={mutation.isPending}
          columnsClassName="sm:grid-cols-3"
          onChange={next => mutation.mutate({ organizationId, enforcement: next })}
        />

        <RadioCardGroup
          legend="When no rule matches"
          options={DEFAULT_EFFECT_OPTIONS}
          value={currentDefault}
          disabled={mutation.isPending}
          columnsClassName="sm:grid-cols-3"
          onChange={next => mutation.mutate({ organizationId, defaultEffect: next })}
        />

        <PermissionRules organizationId={organizationId} rules={rules} />
        <PermissionPreview organizationId={organizationId} />
        <PermissionUsageLog organizationId={organizationId} />
      </CardContent>
    </Card>
  );
}

function PermissionRules({
  organizationId,
  rules,
}: {
  organizationId: string;
  rules: PermissionRuleRow[];
}) {
  const titleId = useId();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const sortedRules = useMemo(() => [...rules].sort(compareRulesForDisplay), [rules]);
  const editing = rules.find(rule => rule.id === editingId) ?? null;

  return (
    <section aria-labelledby={titleId} className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <h3 id={titleId} className="text-sm font-semibold">
            Rules
          </h3>
          <p className="text-muted-foreground text-sm">
            The highest matching rule type decides: final deny, then exception, then deny, then
            broad allow. When no rule matches, the default applies.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <GitReadOnlyPresetButton organizationId={organizationId} rules={rules} />
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus />
            Add rule
          </Button>
        </div>
      </div>

      {sortedRules.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-md border border-dashed px-6 py-10 text-center">
          <p className="text-sm font-medium">No rules yet</p>
          <p className="text-muted-foreground max-w-md text-sm">
            Every tool and command use follows the default. Add a rule, or start with the Git
            read-only preset.
          </p>
        </div>
      ) : (
        <PermissionRulesTable
          organizationId={organizationId}
          rules={sortedRules}
          onEdit={rule => setEditingId(rule.id)}
        />
      )}

      {editing && (
        <PermissionRuleDialog
          key={editing.id}
          organizationId={organizationId}
          rule={editing}
          onClose={() => setEditingId(null)}
        />
      )}
      {adding && (
        <PermissionRuleDialog organizationId={organizationId} onClose={() => setAdding(false)} />
      )}
    </section>
  );
}

function GitReadOnlyPresetButton({
  organizationId,
  rules,
}: {
  organizationId: string;
  rules: PermissionRuleRow[];
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const addMutation = useMutation(trpc.organizations.permissionRules.add.mutationOptions());
  const [applying, setApplying] = useState(false);

  const apply = async () => {
    const { toAdd, skipped } = planPreset(GIT_READ_ONLY_PRESET, rules);
    if (toAdd.length === 0) {
      toast.info('Every Git read-only rule already exists.');
      return;
    }
    const confirmed = await confirm({
      title: 'Add Git read-only rules?',
      description: `Adds ${toAdd.length} rules: broad allows for read-only git commands such as git status and git diff, and final denies for commands that can run other commands or write files, such as bash -c, eval, and output redirects.`,
      confirmLabel: 'Add rules',
    });
    if (!confirmed) return;

    setApplying(true);
    let added = 0;
    let alreadyExisted = skipped.length;
    let failed = 0;
    for (const rule of toAdd) {
      try {
        await addMutation.mutateAsync({ organizationId, ...rule, source: 'preset' });
        added++;
      } catch (error) {
        if (error instanceof TRPCClientError && error.data?.code === 'CONFLICT') {
          alreadyExisted++;
        } else {
          failed++;
        }
      }
    }
    await queryClient.invalidateQueries({
      queryKey: trpc.organizations.permissionRules.pathKey(),
    });
    setApplying(false);
    const message = presetResultMessage({ added, skipped: alreadyExisted, failed });
    if (failed > 0) toast.error(message);
    else toast.success(message);
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={applying}
      onClick={() => void apply()}
    >
      {applying ? 'Adding…' : 'Add Git read-only preset'}
    </Button>
  );
}

function PermissionPreview({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const titleId = useId();
  const permissionId = useId();
  const permissionListId = useId();
  const patternId = useId();
  const [permission, setPermission] = useState('bash');
  const [patternDraft, setPatternDraft] = useState('git push origin main');
  const toolLevel = isToolLevelPermission(permission.trim());
  const pattern = toolLevel ? '*' : patternDraft;
  const request = useDebouncedValue(
    { permission: permission.trim(), pattern },
    PREVIEW_DEBOUNCE_MS
  );
  const ready = request.permission.length > 0 && request.pattern.length > 0;
  const previewQuery = useQuery(
    trpc.organizations.permissionRules.preview.queryOptions(
      { organizationId, ...request },
      { enabled: ready }
    )
  );

  return (
    <section aria-labelledby={titleId} className="grid gap-4 rounded-md border p-4">
      <div className="grid gap-1">
        <h3 id={titleId} className="text-sm font-semibold">
          Preview
        </h3>
        <p className="text-muted-foreground text-sm">
          Check what your organization decides for a tool or command, before Kilo and each user’s
          settings apply.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <div className="grid gap-2">
          <Label htmlFor={permissionId}>Permission</Label>
          <Input
            id={permissionId}
            list={permissionListId}
            value={permission}
            maxLength={MAX_PERMISSION_LENGTH}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            onChange={event => setPermission(event.target.value)}
          />
          <datalist id={permissionListId}>
            {KNOWN_PERMISSIONS.map(known => (
              <option key={known} value={known} />
            ))}
          </datalist>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={patternId}>Command</Label>
          <Input
            id={patternId}
            value={pattern}
            readOnly={toolLevel}
            maxLength={MAX_PATTERN_LENGTH}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            onChange={event => setPatternDraft(event.target.value)}
          />
        </div>
      </div>
      <div aria-live="polite" className="text-sm">
        {!ready ? (
          <p className="text-muted-foreground">Enter a permission and command.</p>
        ) : previewQuery.isPending ? (
          <Skeleton className="h-5 w-64" aria-busy="true" />
        ) : previewQuery.isError ? (
          <p role="alert" className="text-destructive">
            {previewQuery.error.message}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={previewQuery.data.decision === 'deny' ? 'destructive' : 'outline'}>
              {actionLabel(previewQuery.data.decision)}
            </Badge>
            <span className="text-muted-foreground">
              {previewQuery.data.rule ? (
                <>
                  Decided by the {tierLabel(previewQuery.data.rule.tier).toLowerCase()} rule{' '}
                  <code className="text-foreground font-mono text-xs">
                    {previewQuery.data.rule.permission} {previewQuery.data.rule.pattern}
                  </code>
                </>
              ) : (
                'No rule matches, so the default applies.'
              )}
              {previewQuery.data.enforcement === 'off' &&
                ' Enforcement is off, so clients don’t apply it yet.'}
              {previewQuery.data.enforcement === 'shadow' &&
                ' Audit mode is on, so clients only record it.'}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
