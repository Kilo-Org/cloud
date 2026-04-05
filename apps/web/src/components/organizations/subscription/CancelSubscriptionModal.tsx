import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AlertTriangle } from 'lucide-react';

export function CancelSubscriptionModal({
  isOpen,
  onClose,
  onConfirm,
  isLoading,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isLoading: boolean;
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Cancel Subscription
          </DialogTitle>
          <DialogDescription className="space-y-3 text-left">
            <p>
              Are you sure you want to cancel your subscription? Your subscription will remain
              active until the end of the current billing period.
            </p>
            <p className="font-medium">
              If you have remaining credits, please contact support at{' '}
              <a href="mailto:teams@kilocode.ai" className="text-blue-600 hover:underline">
                teams@kilocode.ai
              </a>{' '}
              to request a credit refund.
            </p>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            Keep Subscription
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isLoading}>
            {isLoading ? 'Canceling...' : 'Yes, Cancel Subscription'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
