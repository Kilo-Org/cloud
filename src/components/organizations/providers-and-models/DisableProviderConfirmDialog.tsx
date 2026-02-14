import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

type Props = {
  open: boolean;
  providerDisplayName: string;
  modelsToRemove: Array<{ modelId: string; modelName: string }>;
  onConfirm: () => void;
  onCancel: () => void;
};

export function DisableProviderConfirmDialog({
  open,
  providerDisplayName,
  modelsToRemove,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={isOpen => !isOpen && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disable {providerDisplayName}?</DialogTitle>
          <DialogDescription>
            Disabling this provider will also deselect {modelsToRemove.length}{' '}
            {modelsToRemove.length === 1 ? 'model' : 'models'} that would have no remaining enabled
            providers.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-60 overflow-y-auto rounded-lg border">
          <div className="bg-muted/50 border-b px-4 py-2 text-sm font-medium">
            Models to be deselected
          </div>
          <div className="divide-y">
            {modelsToRemove.map(model => (
              <div key={model.modelId} className="px-4 py-2">
                <div className="text-sm font-medium">{model.modelName}</div>
                <div className="text-muted-foreground text-xs">{model.modelId}</div>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm}>
            Disable Provider
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
