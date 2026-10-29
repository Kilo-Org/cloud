'use client';

import { useId, useState } from 'react';
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
import { useTRPC } from '@/lib/trpc/utils';
import { configIdentity } from './addon-display';
import type { OrganizationAddonRow } from './addon-types';

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

function initialKind(addon: OrganizationAddonRow | undefined): CustomKind {
  if (!addon || addon.config.kind === 'remote') return 'remote';
  return addon.config.ecosystem;
}

export function CustomMcpForm({
  organizationId,
  addon,
  onSaved,
  onCancel,
}: {
  organizationId: string;
  addon?: OrganizationAddonRow;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const trpc = useTRPC();
  const kindId = useId();
  const valueId = useId();
  const valueHelpId = useId();
  const nameId = useId();
  const minVersionId = useId();
  const errorId = useId();
  const [kind, setKind] = useState<CustomKind>(() => initialKind(addon));
  const [value, setValue] = useState(() => (addon ? configIdentity(addon.config) : ''));
  const [name, setName] = useState(addon?.name ?? '');
  const [minVersion, setMinVersion] = useState(
    addon?.config.kind === 'package' ? (addon.config.min_version ?? '') : ''
  );
  const copy: { label: string; placeholder: string; help?: string } = VALUE_COPY[kind];
  const hasHelp = copy.help !== undefined;
  const canSubmit = value.trim().length > 0;

  const addMutation = useMutation(
    trpc.organizations.addons.add.mutationOptions({ onSuccess: onSaved })
  );
  const updateMutation = useMutation(
    trpc.organizations.addons.update.mutationOptions({ onSuccess: onSaved })
  );
  const mutation = addon ? updateMutation : addMutation;

  const submit = () => {
    const trimmedName = name.trim();
    const target =
      kind === 'remote'
        ? ({ kind: 'remote', url: value.trim() } as const)
        : ({ kind: 'package', ecosystem: kind, identifier: value.trim() } as const);
    const common = {
      organizationId,
      ...(trimmedName ? { name: trimmedName } : {}),
      target,
      ...(kind === 'remote' ? {} : { minVersion }),
    };
    if (addon) {
      updateMutation.mutate({ ...common, addonId: addon.id });
    } else {
      addMutation.mutate({ ...common, type: 'mcp', source: 'custom' });
    }
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={event => {
        event.preventDefault();
        if (canSubmit) submit();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor={kindId}>Type</Label>
        <Select
          value={kind}
          onValueChange={next => {
            setKind(next as CustomKind);
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
          maxLength={120}
          placeholder="Shown in your allowed list"
          onChange={event => setName(event.target.value)}
        />
      </div>

      {kind !== 'remote' && (
        <div className="grid gap-2">
          <Label htmlFor={minVersionId}>Minimum version (optional)</Label>
          <Input
            id={minVersionId}
            value={minVersion}
            placeholder="Any version"
            onChange={event => setMinVersion(event.target.value)}
          />
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || mutation.isPending}>
          {addon
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
