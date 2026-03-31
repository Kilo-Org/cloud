'use client';

// AlertDialog built on top of the existing Dialog primitive.
// Mirrors the shadcn/ui AlertDialog API surface so callers can use the standard
// AlertDialog, AlertDialogContent, AlertDialogHeader, etc. naming.

import * as React from 'react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const AlertDialog = Dialog;

// AlertDialogContent hides the default close button so users must use Cancel/Action
const AlertDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogContent>,
  React.ComponentPropsWithoutRef<typeof DialogContent>
>(({ className, ...props }, ref) => (
  <DialogContent
    ref={ref}
    showCloseButton={false}
    className={cn('sm:max-w-md', className)}
    {...props}
  />
));
AlertDialogContent.displayName = 'AlertDialogContent';

const AlertDialogHeader = DialogHeader;
const AlertDialogFooter = DialogFooter;
const AlertDialogTitle = DialogTitle;
const AlertDialogDescription = DialogDescription;
const AlertDialogTrigger = DialogTrigger;

type AlertDialogCancelProps = React.ComponentPropsWithoutRef<typeof Button>;

const AlertDialogCancel = React.forwardRef<HTMLButtonElement, AlertDialogCancelProps>(
  ({ className, ...props }, ref) => (
    <DialogClose asChild>
      <Button ref={ref} variant="outline" className={cn('mt-2 sm:mt-0', className)} {...props} />
    </DialogClose>
  )
);
AlertDialogCancel.displayName = 'AlertDialogCancel';

type AlertDialogActionProps = React.ComponentPropsWithoutRef<typeof Button>;

const AlertDialogAction = React.forwardRef<HTMLButtonElement, AlertDialogActionProps>(
  ({ className, ...props }, ref) => <Button ref={ref} className={className} {...props} />
);
AlertDialogAction.displayName = 'AlertDialogAction';

export {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogTrigger,
  AlertDialogCancel,
  AlertDialogAction,
};
