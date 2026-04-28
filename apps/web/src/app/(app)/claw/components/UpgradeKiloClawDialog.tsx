'use client';

import { ArrowUpCircle, RotateCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AnimatedDots } from './AnimatedDots';

const upgradeButtonClassName =
  'border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300';

export function UpgradeKiloClawDialog({
  open,
  onOpenChange,
  isPending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={isPending ? undefined : onOpenChange}>
      <DialogContent className="max-w-md gap-5">
        <DialogHeader className="gap-3 space-y-0 pr-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300">
            <ArrowUpCircle className="h-5 w-5" />
          </div>
          <div className="space-y-2">
            <DialogTitle>Upgrade KiloClaw</DialogTitle>
            <DialogDescription className="leading-6">
              Upgrade this instance to the latest supported KiloClaw version. This also redeploys
              the runtime, so it may be briefly offline.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button className={upgradeButtonClassName} onClick={onConfirm} disabled={isPending}>
            {isPending ? (
              <>
                Upgrading
                <AnimatedDots />
              </>
            ) : (
              <>
                <RotateCw className="h-4 w-4" />
                Upgrade & Redeploy
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
