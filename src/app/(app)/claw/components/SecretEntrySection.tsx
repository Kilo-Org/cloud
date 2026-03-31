'use client';

import type React from 'react';
import { useState } from 'react';
import { AlertCircle, ChevronDown, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import type { SecretCatalogEntry } from '@kilocode/kiloclaw-secret-catalog';
import { validateFieldValue } from '@kilocode/kiloclaw-secret-catalog';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { ChannelTokenInput } from './ChannelTokenInput';
import { getDescription, getIcon } from './secret-ui-adapter';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function SecretEntrySection({
  entry,
  configured,
  mutations,
  onSecretsChanged,
  isDirty,
  actionRowExtra,
  defaultOpen,
  onRedeploy,
  redeployLabel = 'Redeploy',
}: {
  entry: SecretCatalogEntry;
  configured: boolean;
  mutations: ClawMutations;
  onSecretsChanged?: (entryId: string) => void;
  isDirty: boolean;
  actionRowExtra?: React.ReactNode;
  defaultOpen?: boolean;
  onRedeploy?: () => void;
  /** Label for the toast action button. Defaults to "Redeploy". */
  redeployLabel?: string;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [formatError, setFormatError] = useState<string | null>(null);
  const isSaving = mutations.patchSecrets.isPending;
  const Icon = getIcon(entry.icon);
  const description = getDescription(entry.id);

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
            `${entry.label} token${entry.fields.length > 1 ? 's' : ''} saved. ${redeployLabel} to apply.`,
            {
              duration: 8000,
              ...(onRedeploy && {
                action: { label: redeployLabel, onClick: onRedeploy },
              }),
            }
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
            `${entry.label} token${entry.fields.length > 1 ? 's' : ''} removed. ${redeployLabel} to apply.`,
            {
              duration: 8000,
              ...(onRedeploy && {
                action: { label: redeployLabel, onClick: onRedeploy },
              }),
            }
          );
          setTokens({});
          onSecretsChanged?.(entry.id);
        },
        onError: err => toast.error(`Failed to remove: ${err.message}`),
      }
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="hover:bg-muted/50 flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-3 transition-colors"
          >
            <Icon className="h-5 w-5 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col items-start">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{entry.label}</span>
                <Badge
                  variant={configured ? 'default' : 'secondary'}
                  className="px-1.5 py-0 text-[10px] leading-4"
                >
                  {configured ? 'Configured' : 'Not configured'}
                </Badge>
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
              {description && <span className="text-muted-foreground text-xs">{description}</span>}
            </div>
            <ChevronDown
              className={`text-muted-foreground h-4 w-4 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <Separator />
          <div className="space-y-3 px-4 py-3">
            {entry.fields.map(field => (
              <div key={field.key}>
                {entry.fields.length > 1 && (
                  <Label htmlFor={`settings-${field.key}`} className="mb-1 block text-xs">
                    {field.label}
                  </Label>
                )}
                <ChannelTokenInput
                  id={`settings-${field.key}`}
                  placeholder={configured ? field.placeholderConfigured : field.placeholder}
                  value={tokens[field.key] ?? ''}
                  onChange={v => setToken(field.key, v)}
                  disabled={isSaving}
                  maxLength={field.maxLength}
                />
              </div>
            ))}

            <p className="text-muted-foreground text-xs">
              {entry.helpUrl ? (
                <>
                  {entry.helpText?.replace(/\.$/, '')}{' '}
                  <a
                    href={entry.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    {new URL(entry.helpUrl).hostname.replace('www.', '')}
                  </a>
                  .
                </>
              ) : (
                entry.helpText
              )}
            </p>

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
            </div>
            {actionRowExtra && <div>{actionRowExtra}</div>}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
