'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LockableContainer } from '../LockableContainer';
import {
  useDisableOrganizationAuto,
  useEnableOrganizationAuto,
  useSetOrganizationAutoFallback,
  useUpdateDefaultModel,
} from '@/app/api/organizations/hooks';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { OrganizationSettings } from '@/lib/organizations/organization-types';
import { toast } from 'sonner';
import { Settings2 } from 'lucide-react';
import { ORG_AUTO_MODEL } from '@/lib/ai-gateway/auto-model';
import { isOrganizationAutoTargetModel } from '@/lib/organizations/organization-auto-model';
import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';
import { useFeatureFlagEnabled } from 'posthog-js/react';

type DefaultModelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  organizationSettings?: OrganizationSettings;
  currentDefaultModel?: string;
  organizationPlan?: 'teams' | 'enterprise';
};

export function DefaultModelDialog({
  open,
  onOpenChange,
  organizationId,
  organizationSettings,
  currentDefaultModel,
  organizationPlan,
}: DefaultModelDialogProps) {
  const queryClient = useQueryClient();
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [selectedFallbackModel, setSelectedFallbackModel] = useState<string>('');

  const { data: openRouterModels, isLoading: modelsLoading } = useModelSelectorList(organizationId);
  const updateDefaultModelMutation = useUpdateDefaultModel();
  const enableOrganizationAutoMutation = useEnableOrganizationAuto();
  const disableOrganizationAutoMutation = useDisableOrganizationAuto();
  const setOrganizationAutoFallbackMutation = useSetOrganizationAutoFallback();

  const organizationDefaultModel = organizationSettings?.default_model;
  const organizationAutoFallbackModel = organizationSettings?.org_auto_model?.fallback_model;
  const organizationAutoEnabled = organizationDefaultModel === ORG_AUTO_MODEL.id;
  const organizationAutoFeatureEnabled = useFeatureFlagEnabled('organization-auto-model-routing');
  const isDevelopment = process.env.NODE_ENV === 'development';
  const canConfigureOrganizationAuto =
    organizationPlan === 'enterprise' && (isDevelopment || organizationAutoFeatureEnabled === true);
  const showOrganizationAutoSection = organizationAutoEnabled || canConfigureOrganizationAuto;
  const availableModels = (openRouterModels?.data ?? []).filter(
    model => model.id !== ORG_AUTO_MODEL.id
  );
  const organizationAutoTargetModels = availableModels.filter(model => {
    if (model.id.startsWith(CUSTOM_LLM_PREFIX)) {
      return false;
    }
    if (model.id.startsWith('kilo-auto/')) {
      return isOrganizationAutoTargetModel(model.id);
    }
    return true;
  });

  const handleUpdateDefaultModel = async () => {
    if (!selectedModel) return;

    try {
      await updateDefaultModelMutation.mutateAsync({
        organizationId,
        default_model: selectedModel,
      });

      // Invalidate the defaults query to refresh the display
      await queryClient.invalidateQueries({
        queryKey: ['organization-defaults', organizationId],
      });

      setSelectedModel('');
      onOpenChange(false);
      toast.success('Default model updated successfully');
    } catch (error) {
      console.error('Failed to update default model:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update default model');
    }
  };

  const handleClearDefaultModel = async () => {
    try {
      // Clear only the default model; provider/model access policy stays unchanged.
      await updateDefaultModelMutation.mutateAsync({
        organizationId,
        default_model: null,
      });

      await queryClient.invalidateQueries({
        queryKey: ['organization-defaults', organizationId],
      });

      setSelectedModel('');
      onOpenChange(false);
      toast.success('Default model cleared - will use global default');
    } catch (error) {
      console.error('Failed to clear default model:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to clear default model');
    }
  };

  const handleEnableOrganizationAuto = async () => {
    try {
      await enableOrganizationAutoMutation.mutateAsync({ organizationId });
      await queryClient.invalidateQueries({ queryKey: ['organization-defaults', organizationId] });
      setSelectedModel('');
      onOpenChange(false);
      toast.success('Organization Auto enabled');
    } catch (error) {
      console.error('Failed to enable Organization Auto:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to enable Organization Auto');
    }
  };

  const handleDisableOrganizationAuto = async () => {
    if (!selectedModel) return;

    try {
      await disableOrganizationAutoMutation.mutateAsync({
        organizationId,
        replacement_model: selectedModel,
      });
      await queryClient.invalidateQueries({ queryKey: ['organization-defaults', organizationId] });
      setSelectedModel('');
      onOpenChange(false);
      toast.success('Organization Auto disabled');
    } catch (error) {
      console.error('Failed to disable Organization Auto:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to disable Organization Auto');
    }
  };

  const handleSetOrganizationAutoFallback = async () => {
    const fallbackModel = selectedFallbackModel || organizationAutoFallbackModel;
    if (!fallbackModel) return;

    try {
      await setOrganizationAutoFallbackMutation.mutateAsync({
        organizationId,
        model_id: fallbackModel,
      });
      setSelectedFallbackModel('');
      toast.success('Organization Auto fallback updated');
    } catch (error) {
      console.error('Failed to update Organization Auto fallback:', error);
      toast.error(
        error instanceof Error ? error.message : 'Failed to update Organization Auto fallback'
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <LockableContainer>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center space-x-2">
              <Settings2 className="h-5 w-5" />
              <span>Set Organization Default Model</span>
            </DialogTitle>
            <DialogDescription>
              Choose a default model for this organization. Members will use this model by default
              unless they specify otherwise.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="text-muted-foreground text-sm font-medium">
                Current Default Model
              </label>
              <div className="mt-1">
                <code className="bg-background rounded px-2 py-1 font-mono text-sm">
                  {currentDefaultModel}
                </code>
                {organizationDefaultModel ? (
                  <div className="text-muted-foreground mt-1 text-xs">
                    Organization-specific default is set
                  </div>
                ) : (
                  <div className="text-muted-foreground mt-1 text-xs">
                    Using global default (no organization-specific default set)
                  </div>
                )}
              </div>
            </div>

            {showOrganizationAutoSection && (
              <div className="border-border space-y-3 rounded-lg border p-4">
                <div className="space-y-1">
                  <label className="text-sm font-medium">Organization Auto</label>
                  <p className="text-muted-foreground text-xs">
                    Route the organization default by mode. Local model selections still override
                    it.
                  </p>
                  {canConfigureOrganizationAuto && (
                    <a
                      className="text-xs text-primary underline underline-offset-4"
                      href={`/organizations/${organizationId}/custom-modes`}
                    >
                      Configure mode routes
                    </a>
                  )}
                </div>
                {organizationAutoEnabled ? (
                  <p className="text-muted-foreground text-xs">
                    Enabled. Choose a replacement model below to disable it.
                  </p>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleEnableOrganizationAuto}
                    disabled={enableOrganizationAutoMutation.isPending}
                  >
                    {enableOrganizationAutoMutation.isPending
                      ? 'Enabling...'
                      : 'Enable Organization Auto'}
                  </Button>
                )}
                {canConfigureOrganizationAuto && organizationSettings?.org_auto_model && (
                  <div className="space-y-2">
                    <label className="text-muted-foreground text-xs font-medium">
                      Organization Auto fallback
                    </label>
                    <div className="flex gap-2">
                      <Select
                        value={selectedFallbackModel || organizationAutoFallbackModel || ''}
                        onValueChange={setSelectedFallbackModel}
                        disabled={setOrganizationAutoFallbackMutation.isPending || modelsLoading}
                      >
                        <SelectTrigger className="flex-1">
                          <SelectValue placeholder="Choose fallback model..." />
                        </SelectTrigger>
                        <SelectContent>
                          {organizationAutoTargetModels.map(model => (
                            <SelectItem key={model.id} value={model.id}>
                              <div className="flex flex-col">
                                <span className="font-mono text-sm">{model.id}</span>
                                {model.name !== model.id && (
                                  <span className="text-muted-foreground text-xs">
                                    {model.name}
                                  </span>
                                )}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleSetOrganizationAutoFallback}
                        disabled={
                          !selectedFallbackModel ||
                          selectedFallbackModel === organizationAutoFallbackModel ||
                          setOrganizationAutoFallbackMutation.isPending
                        }
                      >
                        {setOrganizationAutoFallbackMutation.isPending ? 'Saving...' : 'Save'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="text-muted-foreground text-sm font-medium">New Default Model</label>
              <Select
                value={selectedModel}
                onValueChange={setSelectedModel}
                disabled={updateDefaultModelMutation.isPending || modelsLoading}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Choose a model..." />
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

              {availableModels.length === 0 && (
                <div className="mt-2 rounded bg-amber-950 p-2 text-sm text-amber-400">
                  No models available. Configure model access first.
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="flex space-x-2">
            {organizationDefaultModel && !organizationAutoEnabled && (
              <Button
                variant="outline"
                onClick={handleClearDefaultModel}
                disabled={updateDefaultModelMutation.isPending}
              >
                Clear Default
              </Button>
            )}
            {organizationAutoEnabled && (
              <Button
                variant="outline"
                onClick={handleDisableOrganizationAuto}
                disabled={!selectedModel || disableOrganizationAutoMutation.isPending}
              >
                {disableOrganizationAutoMutation.isPending
                  ? 'Disabling...'
                  : 'Disable Organization Auto'}
              </Button>
            )}
            <Button
              onClick={handleUpdateDefaultModel}
              disabled={
                organizationAutoEnabled || !selectedModel || updateDefaultModelMutation.isPending
              }
            >
              {updateDefaultModelMutation.isPending ? 'Updating...' : 'Set Default'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </LockableContainer>
    </Dialog>
  );
}
