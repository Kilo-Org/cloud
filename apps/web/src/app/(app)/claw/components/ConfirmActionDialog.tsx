'use client';

import type { ComponentProps, ReactNode } from 'react';
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

export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmIcon,
  confirmVariant,
  cancelLabel = 'Cancel',
  isPending,
  pendingLabel,
  onConfirm,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  confirmIcon?: ReactNode;
  // Prefer the semantic Button variant (e.g. "destructive") over a className
  // override so destructive styling comes from the design system, not ad-hoc.
  confirmVariant?: ComponentProps<typeof Button>['variant'];
  // Name the keep-action ("Keep agent") instead of a generic "Cancel" for
  // destructive confirms (ux-writing). Defaults to "Cancel" for other callers.
  cancelLabel?: string;
  isPending: boolean;
  pendingLabel: string;
  onConfirm: () => void;
  className?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={isPending ? undefined : onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            className={className}
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? (
              <>
                {pendingLabel}
                <AnimatedDots />
              </>
            ) : (
              <>
                {confirmIcon}
                {confirmLabel}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
