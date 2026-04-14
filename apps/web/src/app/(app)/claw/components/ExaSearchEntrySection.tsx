'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, Save } from 'lucide-react';
import { toast } from 'sonner';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { ExaSearchIcon } from './icons/ExaSearchIcon';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;
type ExaSelection = 'enabled' | 'disabled';
type KiloExaSearchMode = 'kilo-proxy' | 'disabled' | null;

function selectionFromMode(mode: KiloExaSearchMode): ExaSelection {
  return mode === 'kilo-proxy' ? 'enabled' : 'disabled';
}

function modeFromSelection(selection: ExaSelection): Exclude<KiloExaSearchMode, null> {
  return selection === 'enabled' ? 'kilo-proxy' : 'disabled';
}

export function ExaSearchEntrySection({
  mode,
  configured,
  braveConfigured,
  mutations,
  onSecretsChanged,
  isDirty,
}: {
  mode: KiloExaSearchMode;
  configured: boolean;
  braveConfigured: boolean;
  mutations: ClawMutations;
  onSecretsChanged?: (entryId: string) => void;
  isDirty: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pendingConfirmSelection, setPendingConfirmSelection] = useState<ExaSelection | null>(null);
  const [selection, setSelection] = useState<ExaSelection>(() => selectionFromMode(mode));
  const [isSaving, setIsSaving] = useState(false);

  const Icon = ExaSearchIcon;

  const persistedSelection = selectionFromMode(mode);
  const hasUnsavedSelection = selection !== persistedSelection;

  useEffect(() => {
    setSelection(selectionFromMode(mode));
  }, [mode]);

  function commitSelection(nextSelection: ExaSelection) {
    setIsSaving(true);
    mutations.patchWebSearchConfig.mutate(
      {
        exaMode: modeFromSelection(nextSelection),
      },
      {
        onSuccess: () => {
          toast.success('Exa Search setting saved. Redeploy to apply.', { duration: 8000 });
          setPendingConfirmSelection(null);
          onSecretsChanged?.('kilo-exa-search');
        },
        onError: err => {
          setPendingConfirmSelection(null);
          toast.error(`Failed to save: ${err.message}`);
        },
        onSettled: () => setIsSaving(false),
      }
    );
  }

  function handleSave() {
    if (braveConfigured) {
      setPendingConfirmSelection(selection);
      return;
    }
    commitSelection(selection);
  }

  return (
    <>
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
                  <span className="text-sm font-medium">Exa Search</span>
                  <Badge
                    variant={configured ? 'default' : 'secondary'}
                    className="px-1.5 py-0 text-[10px] leading-4"
                  >
                    {configured ? 'Configured' : 'Not configured'}
                  </Badge>
                  {isDirty && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <AlertCircle className="h-4 w-4 text-amber-500" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Redeploy to apply changes</p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <span className="text-muted-foreground text-xs">
                  Use Kilo's integrated Exa web search provider
                </span>
              </div>
              <ChevronDown
                className={`text-muted-foreground h-4 w-4 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
              />
            </button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <Separator />
            <div className="space-y-3 px-4 py-3">
              <div className="space-y-2">
                <Label className="text-xs">Status</Label>
                <RadioGroup
                  value={selection}
                  onValueChange={value =>
                    setSelection(value === 'enabled' ? 'enabled' : 'disabled')
                  }
                  className="gap-2"
                >
                  <label
                    htmlFor="settings-kilo-exa-enabled"
                    className="flex cursor-pointer items-start gap-2"
                  >
                    <RadioGroupItem
                      id="settings-kilo-exa-enabled"
                      value="enabled"
                      className="mt-0.5"
                      disabled={isSaving}
                    />
                    <span className="text-sm">Enabled</span>
                  </label>
                  <label
                    htmlFor="settings-kilo-exa-disabled"
                    className="flex cursor-pointer items-start gap-2"
                  >
                    <RadioGroupItem
                      id="settings-kilo-exa-disabled"
                      value="disabled"
                      className="mt-0.5"
                      disabled={isSaving}
                    />
                    <span className="text-sm">Disabled</span>
                  </label>
                </RadioGroup>
              </div>

              <p className="text-muted-foreground text-xs">
                Enable or disable the Kilo-integrated Exa web search provider.
              </p>

              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleSave} disabled={isSaving || !hasUnsavedSelection}>
                  <Save className="h-4 w-4" />
                  {isSaving ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      <AlertDialog
        open={pendingConfirmSelection !== null}
        onOpenChange={
          isSaving
            ? undefined
            : nextOpen => {
                if (!nextOpen) {
                  setPendingConfirmSelection(null);
                }
              }
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingConfirmSelection === 'enabled' ? 'Enable Exa Search?' : 'Disable Exa Search?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingConfirmSelection === 'enabled'
                ? 'Brave Search is currently configured. Enabling Exa will disable Brave on the next redeploy.'
                : 'Brave Search is currently configured. Disabling Exa will re-enable Brave on the next redeploy.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                commitSelection(pendingConfirmSelection === 'enabled' ? 'enabled' : 'disabled')
              }
              disabled={isSaving}
            >
              {isSaving
                ? 'Saving...'
                : pendingConfirmSelection === 'enabled'
                  ? 'Enable Exa and disable Brave'
                  : 'Disable Exa and re-enable Brave'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
