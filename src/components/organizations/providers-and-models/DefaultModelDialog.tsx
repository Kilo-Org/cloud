'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LockableContainer } from '../LockableContainer';
import {
  useUpdateDefaultModel,
  useUpdateOrganizationSettings,
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

type DefaultModelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  organizationSettings?: OrganizationSettings;
  currentDefaultModel?: string;
};

export function DefaultModelDialog({
  open,
  onOpenChange,
  organizationId,
  organizationSettings,
  currentDefaultModel,
}: DefaultModelDialogProps) {
  const queryClient = useQueryClient();
  const [selectedModel, setSelectedModel] = useState<string>('');

  const { data: openRouterModels, isLoading: modelsLoading } = useModelSelectorList(organizationId);
  const updateDefaultModelMutation = useUpdateDefaultModel();
  const updateSettingsMutation = useUpdateOrganizationSettings();

  const organizationDefaultModel = organizationSettings?.default_model;
  const availableModels = openRouterModels?.data ?? [];

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
      // Clear by updating allow lists without the default model
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

            <div>
              <label className="text-muted-foreground text-sm font-medium">New Default Model</label>
              <Select
                value={selectedModel}
                onValueChange={setSelectedModel}
                disabled={
                  updateDefaultModelMutation.isPending ||
                  updateSettingsMutation.isPending ||
                  modelsLoading
                }
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

              {availableModels.length === 0 && organizationSettings?.model_allow_list && (
                <div className="mt-2 rounded bg-amber-950 p-2 text-sm text-amber-400">
                  No models available. Configure model access first.
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="flex space-x-2">
            {organizationDefaultModel && (
              <Button
                variant="outline"
                onClick={handleClearDefaultModel}
                disabled={updateSettingsMutation.isPending}
              >
                Clear Default
              </Button>
            )}
            <Button
              onClick={handleUpdateDefaultModel}
              disabled={!selectedModel || updateDefaultModelMutation.isPending}
            >
              {updateDefaultModelMutation.isPending ? 'Updating...' : 'Set Default'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </LockableContainer>
    </Dialog>
  );
}
