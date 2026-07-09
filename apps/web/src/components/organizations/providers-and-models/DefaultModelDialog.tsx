'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useFeatureFlagEnabled } from 'posthog-js/react';
import { Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { useConfigureOrganizationDefaultBehavior } from '@/app/api/organizations/hooks';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import { LockableContainer } from '../LockableContainer';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { OrganizationSettings } from '@/lib/organizations/organization-types';
import { KILO_AUTO_BALANCED_MODEL, ORG_AUTO_MODEL } from '@/lib/ai-gateway/auto-model';
import {
  hasActiveOrganizationModelPolicy,
  isOrganizationAutoTargetModel,
  ORGANIZATION_AUTO_MODEL_FLAG,
} from '@/lib/organizations/organization-auto-model-shared';
import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';
import { cn } from '@/lib/utils';

type DefaultModelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  organizationSettings?: OrganizationSettings;
  currentDefaultModel?: string;
  organizationPlan?: 'teams' | 'enterprise';
};

type DefaultBehavior = 'auto' | 'specific';

const BEHAVIOR_OPTIONS: {
  value: DefaultBehavior;
  title: string;
  description: string;
  recommended?: boolean;
}[] = [
  {
    value: 'auto',
    title: 'Organization Auto',
    description: 'Route each mode to the right model, with one fallback.',
    recommended: true,
  },
  {
    value: 'specific',
    title: 'Specific model',
    description: 'Pin a single model as the organization default.',
  },
];

const BEHAVIOR_ORDER = BEHAVIOR_OPTIONS.map(option => option.value);

function BehaviorChooser({
  value,
  onChange,
}: {
  value: DefaultBehavior;
  onChange: (value: DefaultBehavior) => void;
}) {
  const itemRefs = useRef<Partial<Record<DefaultBehavior, HTMLButtonElement | null>>>({});

  const moveTo = (next: DefaultBehavior) => {
    onChange(next);
    itemRefs.current[next]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent, current: DefaultBehavior) => {
    const index = BEHAVIOR_ORDER.indexOf(current);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveTo(BEHAVIOR_ORDER[(index + 1) % BEHAVIOR_ORDER.length]);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveTo(BEHAVIOR_ORDER[(index - 1 + BEHAVIOR_ORDER.length) % BEHAVIOR_ORDER.length]);
    } else if (event.key === 'Home') {
      event.preventDefault();
      moveTo(BEHAVIOR_ORDER[0]);
    } else if (event.key === 'End') {
      event.preventDefault();
      moveTo(BEHAVIOR_ORDER[BEHAVIOR_ORDER.length - 1]);
    }
  };

  return (
    <div role="radiogroup" aria-label="Default model behavior" className="grid gap-2">
      {BEHAVIOR_OPTIONS.map(option => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            ref={node => {
              itemRefs.current[option.value] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={event => handleKeyDown(event, option.value)}
            className={cn(
              'flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              selected
                ? 'border-primary bg-secondary'
                : 'border-input hover:border-muted-foreground hover:bg-accent/40'
            )}
          >
            <span className="flex w-full items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-full border',
                  selected ? 'border-primary' : 'border-muted-foreground'
                )}
              >
                {selected && <span className="bg-primary size-2 rounded-full" />}
              </span>
              <span className="text-sm font-medium">{option.title}</span>
              {option.recommended && (
                <Badge variant="default" className="ml-auto shrink-0">
                  Recommended
                </Badge>
              )}
            </span>
            <span className="text-muted-foreground pl-6 text-xs font-normal">
              {option.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function DefaultModelDialog({
  open,
  onOpenChange,
  organizationId,
  organizationSettings,
  currentDefaultModel,
  organizationPlan,
}: DefaultModelDialogProps) {
  const { data: openRouterModels, isLoading: modelsLoading } = useModelSelectorList(organizationId);
  const configureMutation = useConfigureOrganizationDefaultBehavior();
  const organizationAutoFeatureEnabled = useFeatureFlagEnabled(ORGANIZATION_AUTO_MODEL_FLAG);
  const isDevelopment = process.env.NODE_ENV === 'development';
  const canConfigureOrganizationAuto =
    organizationPlan === 'enterprise' && (isDevelopment || organizationAutoFeatureEnabled === true);
  const organizationDefaultModel = organizationSettings?.default_model;
  const organizationAutoEnabled = organizationDefaultModel === ORG_AUTO_MODEL.id;
  const showOrganizationAutoBehavior = canConfigureOrganizationAuto || organizationAutoEnabled;
  const organizationAutoFallbackModel = organizationSettings?.org_auto_model?.fallback_model;
  const hasActiveModelPolicy = hasActiveOrganizationModelPolicy(organizationSettings);
  const [behavior, setBehavior] = useState<DefaultBehavior>(
    organizationAutoEnabled ? 'auto' : 'specific'
  );
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedFallbackModel, setSelectedFallbackModel] = useState('');

  const availableModels = useMemo(
    () => (openRouterModels?.data ?? []).filter(model => model.id !== ORG_AUTO_MODEL.id),
    [openRouterModels?.data]
  );
  const autoTargetModels = useMemo(
    () =>
      availableModels.filter(model => {
        if (model.id.startsWith(CUSTOM_LLM_PREFIX)) return false;
        if (model.id.startsWith('kilo-auto/')) {
          return !hasActiveModelPolicy && isOrganizationAutoTargetModel(model.id);
        }
        return true;
      }),
    [availableModels, hasActiveModelPolicy]
  );
  const defaultAutoFallback = hasActiveModelPolicy ? '' : KILO_AUTO_BALANCED_MODEL.id;
  const fallbackUnavailable =
    !!organizationAutoFallbackModel &&
    !autoTargetModels.some(model => model.id === organizationAutoFallbackModel);
  const effectiveFallback =
    selectedFallbackModel || organizationAutoFallbackModel || defaultAutoFallback;
  const fallbackNeedsReplacement =
    fallbackUnavailable &&
    !modelsLoading &&
    !autoTargetModels.some(model => model.id === effectiveFallback);
  const effectiveSpecificModel = selectedModel || organizationDefaultModel || '';
  const isDirty =
    behavior !== (organizationAutoEnabled ? 'auto' : 'specific') ||
    (behavior === 'auto' &&
      effectiveFallback !== (organizationAutoFallbackModel || defaultAutoFallback)) ||
    (behavior === 'specific' && effectiveSpecificModel !== (organizationDefaultModel || ''));

  useEffect(() => {
    if (!open) {
      setSelectedModel('');
      setSelectedFallbackModel('');
      setBehavior(organizationAutoEnabled ? 'auto' : 'specific');
    }
  }, [open, organizationAutoEnabled]);

  const handleSave = async () => {
    try {
      if (behavior === 'auto') {
        if (!effectiveFallback) {
          toast.error('Choose an Organization Auto fallback model.');
          return;
        }
        await configureMutation.mutateAsync({
          organizationId,
          behavior: 'auto',
          fallback_model: effectiveFallback,
        });
        toast.success('Organization Auto default updated');
      } else {
        if (!selectedModel) {
          toast.error('Choose a specific default model.');
          return;
        }
        await configureMutation.mutateAsync({
          organizationId,
          behavior: 'specific',
          specific_model: selectedModel,
        });
        toast.success('Default model updated');
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update default behavior');
    }
  };

  const handleReset = async () => {
    try {
      await configureMutation.mutateAsync({ organizationId, behavior: 'global' });
      toast.success('Reset to global default');
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reset default model');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <LockableContainer>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings2 className="size-5" />
              <span>Default model behavior</span>
            </DialogTitle>
            <DialogDescription>
              Members use this model by default unless they select another model locally.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Current default</span>
              <Badge variant="secondary" className="font-mono">
                {currentDefaultModel || 'global default'}
              </Badge>
            </div>

            {showOrganizationAutoBehavior && (
              <BehaviorChooser value={behavior} onChange={setBehavior} />
            )}

            {behavior === 'auto' ? (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="organization-auto-fallback">Organization Auto fallback</Label>
                  <p className="text-muted-foreground text-xs">
                    Used when a mode has no explicit route or the request uses an unknown mode.
                    {canConfigureOrganizationAuto && organizationAutoEnabled && (
                      <>
                        {' '}
                        <Link
                          className="text-primary underline underline-offset-4"
                          href={`/organizations/${organizationId}/custom-modes`}
                          onClick={() => onOpenChange(false)}
                        >
                          Configure mode routes
                        </Link>
                      </>
                    )}
                  </p>
                </div>
                <Select
                  value={effectiveFallback}
                  onValueChange={setSelectedFallbackModel}
                  disabled={
                    !canConfigureOrganizationAuto || modelsLoading || configureMutation.isPending
                  }
                >
                  <SelectTrigger id="organization-auto-fallback">
                    <SelectValue placeholder="Choose fallback model..." />
                  </SelectTrigger>
                  <SelectContent>
                    {fallbackUnavailable && organizationAutoFallbackModel && (
                      <SelectItem value={organizationAutoFallbackModel}>
                        <div className="flex flex-col">
                          <span className="font-mono text-sm">{organizationAutoFallbackModel}</span>
                          <span className="text-destructive text-xs">
                            Unavailable current fallback
                          </span>
                        </div>
                      </SelectItem>
                    )}
                    {autoTargetModels.map(model => (
                      <SelectItem key={model.id} value={model.id}>
                        <div className="flex flex-col">
                          <span className="font-mono text-sm">{model.id}</span>
                          {model.name !== model.id && (
                            <span className="text-muted-foreground text-xs">{model.name}</span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fallbackNeedsReplacement && (
                  <p className="text-destructive text-xs">
                    This fallback is no longer available. Modes without explicit routes will fail
                    until you replace it.
                  </p>
                )}
                {!modelsLoading && autoTargetModels.length === 0 && (
                  <p className="text-destructive text-xs">
                    No concrete models are available for Organization Auto under the current model
                    policy.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="specific-default-model">Specific default model</Label>
                  <p className="text-muted-foreground text-xs">
                    Every mode uses this model unless a local selection overrides it.
                  </p>
                </div>
                <Select
                  value={selectedModel}
                  onValueChange={setSelectedModel}
                  disabled={modelsLoading || configureMutation.isPending}
                >
                  <SelectTrigger id="specific-default-model">
                    <SelectValue
                      placeholder={
                        organizationAutoEnabled
                          ? 'Choose replacement model...'
                          : 'Choose a model...'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {availableModels.map(model => (
                      <SelectItem key={model.id} value={model.id}>
                        <div className="flex flex-col">
                          <span className="font-mono text-sm">{model.id}</span>
                          {model.name !== model.id && (
                            <span className="text-muted-foreground text-xs">{model.name}</span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!modelsLoading && availableModels.length === 0 && (
                  <p className="rounded-md bg-amber-950 p-2 text-sm text-amber-400">
                    No models available. Configure model access first.
                  </p>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
            {organizationDefaultModel && (
              <Button
                type="button"
                variant="link"
                onClick={handleReset}
                disabled={configureMutation.isPending}
              >
                Reset to global default
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleSave}
                disabled={
                  !isDirty ||
                  configureMutation.isPending ||
                  (behavior === 'auto' && !effectiveFallback) ||
                  (behavior === 'auto' && fallbackNeedsReplacement) ||
                  (behavior === 'specific' && !selectedModel)
                }
              >
                {configureMutation.isPending ? 'Saving...' : 'Save changes'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </LockableContainer>
    </Dialog>
  );
}
