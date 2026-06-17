'use client';

import { useEffect, useMemo, useState } from 'react';
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
import { ORG_AUTO_MODEL } from '@/lib/ai-gateway/auto-model';
import {
  isOrganizationAutoTargetModel,
  ORGANIZATION_AUTO_MODEL_FLAG,
} from '@/lib/organizations/organization-auto-model-shared';
import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';

type DefaultModelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  organizationSettings?: OrganizationSettings;
  currentDefaultModel?: string;
  organizationPlan?: 'teams' | 'enterprise';
};

type DefaultBehavior = 'auto' | 'specific';

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
  const [behavior, setBehavior] = useState<DefaultBehavior>(
    organizationAutoEnabled ? 'auto' : 'specific'
  );
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedFallbackModel, setSelectedFallbackModel] = useState('');

  const availableModels = (openRouterModels?.data ?? []).filter(
    model => model.id !== ORG_AUTO_MODEL.id
  );
  const autoTargetModels = useMemo(
    () =>
      availableModels.filter(model => {
        if (model.id.startsWith(CUSTOM_LLM_PREFIX)) return false;
        if (model.id.startsWith('kilo-auto/')) return isOrganizationAutoTargetModel(model.id);
        return true;
      }),
    [availableModels]
  );
  const fallbackUnavailable =
    !!organizationAutoFallbackModel &&
    !autoTargetModels.some(model => model.id === organizationAutoFallbackModel);
  const effectiveFallback =
    selectedFallbackModel || organizationAutoFallbackModel || 'kilo-auto/balanced';
  const fallbackNeedsReplacement =
    fallbackUnavailable &&
    !modelsLoading &&
    !autoTargetModels.some(model => model.id === effectiveFallback);
  const effectiveSpecificModel = selectedModel || organizationDefaultModel || '';
  const isDirty =
    behavior !== (organizationAutoEnabled ? 'auto' : 'specific') ||
    (behavior === 'auto' &&
      effectiveFallback !== (organizationAutoFallbackModel || 'kilo-auto/balanced')) ||
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
              <div
                className="grid grid-cols-2 gap-2"
                role="group"
                aria-label="Default model behavior"
              >
                <Button
                  type="button"
                  variant={behavior === 'auto' ? 'secondary' : 'outline'}
                  aria-pressed={behavior === 'auto'}
                  onClick={() => setBehavior('auto')}
                  className="h-auto min-h-20 flex-col items-start gap-1 p-3 text-left"
                >
                  <span>Organization Auto</span>
                  <span className="text-muted-foreground text-xs font-normal">
                    Route by mode and fallback.
                  </span>
                </Button>
                <Button
                  type="button"
                  variant={behavior === 'specific' ? 'secondary' : 'outline'}
                  aria-pressed={behavior === 'specific'}
                  onClick={() => setBehavior('specific')}
                  className="h-auto min-h-20 flex-col items-start gap-1 p-3 text-left"
                >
                  <span>Specific model</span>
                  <span className="text-muted-foreground text-xs font-normal">
                    Pin one organization default.
                  </span>
                </Button>
              </div>
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
