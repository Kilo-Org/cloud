'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ModelOption } from '@/app/admin/alerting/types';

type AddModelDialogProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  isLoading: boolean;
  error?: unknown;
  models: ModelOption[];
  onAddModel: (modelId: string) => void;
};

export function AddModelDialog({
  isOpen,
  onOpenChange,
  searchTerm,
  onSearchChange,
  isLoading,
  error,
  models,
  onAddModel,
}: AddModelDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">Add Model</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add model to alerting</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            placeholder="Search models..."
            value={searchTerm}
            onChange={e => onSearchChange(e.target.value)}
          />
          <div className="max-h-64 overflow-y-auto rounded-md border">
            {isLoading ? (
              <div className="text-muted-foreground p-3 text-sm">Loading…</div>
            ) : error ? (
              <div className="text-destructive p-3 text-sm">
                {error instanceof Error ? error.message : 'Failed to load models'}
              </div>
            ) : models.length > 0 ? (
              models.map(model => (
                <button
                  key={model.openrouterId}
                  type="button"
                  className="hover:bg-muted flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0"
                  onClick={() => onAddModel(model.openrouterId)}
                >
                  <div>
                    <div className="font-medium">{model.name}</div>
                    <div className="text-muted-foreground font-mono text-xs">
                      {model.openrouterId}
                    </div>
                  </div>
                  <div className="text-muted-foreground text-xs">Add</div>
                </button>
              ))
            ) : (
              <div className="text-muted-foreground p-3 text-sm">No models match that search.</div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
