'use client';

import * as React from 'react';
import * as SheetPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';

import {
  sheetCloseClassName,
  sheetContentClassName,
  sheetDescriptionClassName,
  sheetDismissibleOverlayClassName,
  sheetFooterClassName,
  sheetHeaderClassName,
  sheetOverlayClassName,
  sheetTitleClassName,
} from '@/components/ui/primitive-classnames';
import { cn } from '@/lib/utils';

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(sheetOverlayClassName, className)}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = 'right',
  portalContainer,
  showOverlay = true,
  overlayClassName,
  dismissibleOverlay = false,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: 'top' | 'right' | 'bottom' | 'left';
  portalContainer?: React.ComponentProps<typeof SheetPrimitive.Portal>['container'];
  showOverlay?: boolean;
  overlayClassName?: string;
  dismissibleOverlay?: boolean;
}) {
  return (
    <SheetPortal container={portalContainer}>
      {showOverlay &&
        (dismissibleOverlay ? (
          <SheetPrimitive.Close asChild>
            <button
              type="button"
              aria-label="Close sheet"
              data-slot="sheet-overlay"
              className={cn(sheetDismissibleOverlayClassName, overlayClassName)}
            />
          </SheetPrimitive.Close>
        ) : (
          <SheetOverlay className={overlayClassName} />
        ))}
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          sheetContentClassName,
          side === 'right' &&
            'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm',
          side === 'left' &&
            'data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm',
          side === 'top' &&
            'data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top inset-x-0 top-0 h-auto border-b',
          side === 'bottom' &&
            'data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom inset-x-0 bottom-0 h-auto border-t',
          className
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className={sheetCloseClassName}>
          <XIcon className="size-4" aria-hidden="true" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="sheet-header" className={cn(sheetHeaderClassName, className)} {...props} />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="sheet-footer" className={cn(sheetFooterClassName, className)} {...props} />
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(sheetTitleClassName, className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn(sheetDescriptionClassName, className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
