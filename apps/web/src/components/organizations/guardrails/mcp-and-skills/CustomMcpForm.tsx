'use client';

import { useId, useState } from 'react';
import { MAX_ORGANIZATION_GUARDRAIL_NAME_LENGTH } from '@kilocode/db/schema-types';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  MAX_SEMVER_LENGTH,
  VERSION_SPEC_EXAMPLE,
} from '@/lib/organizations/guardrails/version-spec-constants';
import { useTRPC } from '@/lib/trpc/utils';
import { configIdentity } from './guardrail-display';
import type { OrganizationGuardrailRow } from './guardrail-types';

type CustomKind = 'remote' | 'npm' | 'pypi';

const KIND_OPTIONS = [
  { value: 'remote', label: 'Remote server (URL)' },
  { value: 'npm', label: 'npm package' },
  { value: 'pypi', label: 'PyPI package' },
] satisfies { value: CustomKind; label: string }[];

const VALUE_COPY = {
  remote: {
    label: 'Server URL',
    placeholder: 'https://mcp.example.com/mcp',
  },
  npm: {
    label: 'Package name',
    placeholder: '@scope/package-name',
    help: 'Kilo runs the package itself. Commands like npx or node can’t be allowed directly.',
  },
  pypi: {
    label: 'Package name',
    placeholder: 'package-name',
    help: 'Kilo runs the package itself. Commands like uvx or python can’t be allowed directly.',
  },
} satisfies Record<CustomKind, { label: string; placeholder: string; help?: string }>;

function initialKind(guardrail: OrganizationGuardrailRow | undefined): CustomKind {
  if (!guardrail || guardrail.config.kind === 'remote') return 'remote';
  return guardrail.config.ecosystem;
}

export function CustomMcpForm({
  organizationId,
  guardrail,
  onSaved,
  onCancel,
}: {
  organizationId: string;
  guardrail?: OrganizationGuardrailRow;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const trpc = useTRPC();
  const kindId = useId();
  const valueId = useId();
  const valueHelpId = useId();
  const nameId = useId();
  const versionSpecId = useId();
  const versionSpecHelpId = useId();
  const versionSpecErrorId = useId();
  const versionSpecWarningId = useId();
  const errorId = useId();
  const [kind, setKind] = useState<CustomKind>(() => initialKind(guardrail));
  const [value, setValue] = useState(() => (guardrail ? configIdentity(guardrail.config) : ''));
  const [name, setName] = useState(guardrail?.name ?? '');
  const [versionSpec, setVersionSpec] = useState(
    guardrail?.config.kind === 'package' ? (guardrail.config.version_spec ?? '') : ''
  );
  const [versionSpecError, setVersionSpecError] = useState<string | undefined>();
  const [versionSpecDirty, setVersionSpecDirty] = useState(false);
  const versionSpecInvalid =
    guardrail?.config.kind === 'package' && guardrail.config.version_spec_invalid === true;
  const preserveInvalidVersionSpec =
    guardrail !== undefined && versionSpecInvalid && !versionSpecDirty;
  const copy: { label: string; placeholder: string; help?: string } = VALUE_COPY[kind];
  const hasHelp = copy.help !== undefined;
  const canSubmit = value.trim().length > 0;

  const addMutation = useMutation(
    trpc.organizations.mcpGuardrails.add.mutationOptions({ onSuccess: onSaved })
  );
  const updateMutation = useMutation(
    trpc.organizations.mcpGuardrails.update.mutationOptions({ onSuccess: onSaved })
  );
  const mutation = guardrail ? updateMutation : addMutation;

  const submit = async () => {
    if (kind !== 'remote' && !preserveInvalidVersionSpec) {
      const { normalizeVersionSpec } = await import('@/lib/organizations/guardrails/version-spec');
      const normalized = normalizeVersionSpec(versionSpec);
      if (!normalized.ok) {
        setVersionSpecError(normalized.reason);
        return;
      }
    }
    setVersionSpecError(undefined);
    const trimmedName = name.trim();
    const target =
      kind === 'remote'
        ? ({ kind: 'remote', url: value.trim() } as const)
        : ({ kind: 'package', ecosystem: kind, identifier: value.trim() } as const);
    const common = {
      organizationId,
      ...(trimmedName ? { name: trimmedName } : {}),
      target,
      ...(kind === 'remote' || preserveInvalidVersionSpec ? {} : { versionSpec }),
    };
    if (guardrail) {
      updateMutation.mutate({ ...common, guardrailId: guardrail.id });
    } else {
      addMutation.mutate({ ...common, type: 'mcp', source: 'custom' });
    }
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={event => {
        event.preventDefault();
        if (canSubmit) void submit();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor={kindId}>Type</Label>
        <Select
          value={kind}
          onValueChange={next => {
            setKind(next as CustomKind);
            setVersionSpecDirty(true);
            setVersionSpecError(undefined);
            mutation.reset();
          }}
        >
          <SelectTrigger id={kindId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_OPTIONS.map(option => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={valueId}>{copy.label}</Label>
        <Input
          id={valueId}
          value={value}
          placeholder={copy.placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={mutation.isError}
          aria-describedby={
            [hasHelp ? valueHelpId : null, mutation.isError ? errorId : null]
              .filter(Boolean)
              .join(' ') || undefined
          }
          onChange={event => setValue(event.target.value)}
        />
        {hasHelp && (
          <p id={valueHelpId} className="text-muted-foreground text-sm">
            {copy.help}
          </p>
        )}
        {mutation.isError && (
          <p id={errorId} role="alert" className="text-destructive text-sm">
            {mutation.error.message}
          </p>
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor={nameId}>Name (optional)</Label>
        <Input
          id={nameId}
          value={name}
          maxLength={MAX_ORGANIZATION_GUARDRAIL_NAME_LENGTH}
          placeholder="Shown in your allowed list"
          onChange={event => setName(event.target.value)}
        />
      </div>

      {kind !== 'remote' && (
        <div className="grid gap-2">
          <Label htmlFor={versionSpecId}>Allowed versions (optional)</Label>
          <Input
            id={versionSpecId}
            value={versionSpec}
            placeholder={VERSION_SPEC_EXAMPLE}
            maxLength={MAX_SEMVER_LENGTH}
            aria-invalid={
              versionSpecError || (versionSpecInvalid && !versionSpecDirty) ? true : undefined
            }
            aria-describedby={
              [
                versionSpecHelpId,
                versionSpecError ? versionSpecErrorId : null,
                versionSpecInvalid && !versionSpecDirty ? versionSpecWarningId : null,
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
            onChange={event => {
              setVersionSpecDirty(true);
              setVersionSpec(event.target.value);
              setVersionSpecError(undefined);
            }}
          />
          <p id={versionSpecHelpId} className="text-muted-foreground text-sm">
            A semver range checked against the version the client resolves. Leave blank to allow any
            version.
          </p>
          {versionSpecInvalid && !versionSpecDirty && (
            <p id={versionSpecWarningId} className="text-destructive text-sm">
              This guardrail’s stored version rule can’t be converted to an allowed-versions range.
              Enter a range to replace it, or leave it unchanged to keep the current restriction.
            </p>
          )}
          {versionSpecError && (
            <p id={versionSpecErrorId} role="alert" className="text-destructive text-sm">
              {versionSpecError}
            </p>
          )}
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || mutation.isPending}>
          {guardrail
            ? mutation.isPending
              ? 'Saving…'
              : 'Save server'
            : mutation.isPending
              ? 'Adding…'
              : 'Add MCP server'}
        </Button>
      </DialogFooter>
    </form>
  );
}
