'use client';

import type React from 'react';
import { useState } from 'react';
import { AlertCircle, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import type { SecretCatalogEntry } from '@kilocode/kiloclaw-secret-catalog';
import { validateFieldValue } from '@kilocode/kiloclaw-secret-catalog';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { ChannelTokenInput } from './ChannelTokenInput';
import { getIcon } from './secret-ui-adapter';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function SecretEntrySection({
  entry,
  configured,
  mutations,
  onSecretsChanged,
  isDirty,
  actionRowExtra,
}: {
  entry: SecretCatalogEntry;
  configured: boolean;
  mutations: ClawMutations;
  onSecretsChanged?: (entryId: string) => void;
  isDirty: boolean;
  actionRowExtra?: React.ReactNode;
}) {
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [formatError, setFormatError] = useState<string | null>(null);
  const isSaving = mutations.patchSecrets.isPending;
  const Icon = getIcon(entry.icon);

  function setToken(key: string, value: string) {
    setTokens(prev => ({ ...prev, [key]: value }));
    setFormatError(null);
  }

  function hasAllTokensFilled() {
    return entry.fields.every(f => tokens[f.key]?.trim());
  }

  function handleSave() {
    if (!hasAllTokensFilled()) {
      if (entry.fields.length > 1) {
        toast.error(`All token fields are required for ${entry.label}.`);
      } else {
        toast.error('Enter a token or use Remove to clear it.');
      }
      return;
    }

    for (const field of entry.fields) {
      const value = (tokens[field.key] ?? '').trim();
      if (!validateFieldValue(value, field.validationPattern)) {
        const msg = field.validationMessage ?? 'Invalid token format.';
        setFormatError(msg);
        toast.error(msg);
        return;
      }
    }

    const secrets: Record<string, string> = {};
    for (const field of entry.fields) {
      secrets[field.key] = (tokens[field.key] ?? '').trim();
    }

    mutations.patchSecrets.mutate(
      { secrets },
      {
        onSuccess: () => {
          toast.success(
            `${entry.label} token${entry.fields.length > 1 ? 's' : ''} saved. Hit Redeploy to apply.`
          );
          setTokens({});
          onSecretsChanged?.(entry.id);
        },
        onError: err => toast.error(`Failed to save: ${err.message}`),
      }
    );
  }

  function handleRemove() {
    const secrets: Record<string, string | null> = {};
    for (const field of entry.fields) {
      secrets[field.key] = null;
    }

    mutations.patchSecrets.mutate(
      { secrets },
      {
        onSuccess: () => {
          toast.success(
            `${entry.label} token${entry.fields.length > 1 ? 's' : ''} removed. Hit Redeploy to apply.`
          );
          setTokens({});
          onSecretsChanged?.(entry.id);
        },
        onError: err => toast.error(`Failed to remove: ${err.message}`),
      }
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        <Label className="shrink-0">{entry.label}</Label>
        <span className="text-muted-foreground text-xs">
          {configured ? 'Configured' : 'Not configured'}
        </span>
        {(formatError || isDirty) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertCircle
                className={`h-4 w-4 ${formatError ? 'text-red-500' : 'text-amber-500'}`}
              />
            </TooltipTrigger>
            <TooltipContent>
              <p>{formatError ? 'Improper token format' : 'Redeploy to apply changes'}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {entry.fields.map(field => (
        <div key={field.key} className="flex items-center gap-2">
          {entry.fields.length > 1 && (
            <Label htmlFor={`settings-${field.key}`} className="w-20 shrink-0 text-xs">
              {field.label}
            </Label>
          )}
          <ChannelTokenInput
            id={`settings-${field.key}`}
            placeholder={configured ? field.placeholderConfigured : field.placeholder}
            value={tokens[field.key] ?? ''}
            onChange={v => setToken(field.key, v)}
            disabled={isSaving}
            className="flex-1"
            maxLength={field.maxLength}
          />
        </div>
      ))}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={isSaving || !hasAllTokensFilled()}>
          <Save className="h-4 w-4" />
          {isSaving ? 'Saving...' : 'Save'}
        </Button>
        {configured && (
          <Button variant="outline" size="sm" onClick={handleRemove} disabled={isSaving}>
            <X className="h-4 w-4" />
            Remove
          </Button>
        )}
        {actionRowExtra}
      </div>

      <p className="text-muted-foreground text-xs">
        {entry.helpUrl ? (
          <>
            {/* Strip trailing period so we can append the link before re-adding it.
                Catalog helpText entries should end with a period for this to render cleanly. */}
            {entry.helpText?.replace(/\.$/, '')}{' '}
            <a href={entry.helpUrl} target="_blank" rel="noopener noreferrer" className="underline">
              {new URL(entry.helpUrl).hostname.replace('www.', '')}
            </a>
            .
          </>
        ) : (
          entry.helpText
        )}
      </p>
    </div>
  );
}
