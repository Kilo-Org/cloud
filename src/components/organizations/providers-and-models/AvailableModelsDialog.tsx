'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useOrganizationAvailableModels } from '@/app/api/organizations/hooks';
import { List } from 'lucide-react';
import { LoadingCard } from '@/components/LoadingCard';
import { ErrorCard } from '@/components/ErrorCard';

type AvailableModelsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
};

export function AvailableModelsDialog({
  open,
  onOpenChange,
  organizationId,
}: AvailableModelsDialogProps) {
  const { data: modelsData, isLoading, error } = useOrganizationAvailableModels(organizationId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <List className="h-5 w-5" />
            <span>Available Models</span>
          </DialogTitle>
          <DialogDescription>All models available to this organization</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto">
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <LoadingCard title="" description="Loading models..." rowCount={3} />
            </div>
          )}

          {error && (
            <ErrorCard
              title="Error loading models"
              description="Failed to load available models"
              error={error instanceof Error ? error : new Error('Unknown error')}
              onRetry={() => {}}
            />
          )}

          {modelsData && (
            <div className="space-y-2">
              {modelsData.data.map(model => {
                const promptPricePer1M = (parseFloat(model.pricing.prompt) * 1000).toFixed(2);
                const completionPricePer1M = (parseFloat(model.pricing.completion) * 1000).toFixed(
                  2
                );

                return (
                  <div
                    key={model.id}
                    className="bg-card hover:bg-accent/50 rounded-lg border border-yellow-200/20 p-3 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <code className="font-mono text-sm font-medium">{model.id}</code>
                      <span className="text-muted-foreground text-xs whitespace-nowrap">
                        ${promptPricePer1M}/1M prompt, ${completionPricePer1M}/1M completion
                      </span>
                    </div>
                  </div>
                );
              })}
              {modelsData.data.length === 0 && (
                <div className="text-muted-foreground py-8 text-center">No models available</div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
