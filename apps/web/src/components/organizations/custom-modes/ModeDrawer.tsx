'use client';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { ReactNode } from 'react';

type ModeDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
};

export function ModeDrawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: ModeDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-border flex-shrink-0 border-b px-6 py-4">
          <SheetTitle className="text-xl font-semibold">{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pt-4 pb-10">{children}</div>

        {footer && <div className="border-border flex-shrink-0 border-t px-6 py-4">{footer}</div>}
      </SheetContent>
    </Sheet>
  );
}
