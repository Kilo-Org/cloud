'use client';

import { Drawer } from 'vaul';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
    <Drawer.Root open={open} onOpenChange={onOpenChange} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40" />
        <Drawer.Content
          className="fixed top-2 right-2 bottom-2 z-50 flex w-full max-w-2xl outline-none"
          style={{ '--initial-transform': 'calc(100% + 8px)' } as React.CSSProperties}
        >
          <div className="flex h-full w-full grow flex-col rounded-[16px] border-l-2 border-l-[#cccccc1f] bg-[#111]">
            {/* Header */}
            <div className="border-border flex flex-shrink-0 items-start justify-between border-b px-6 py-4">
              <div className="flex-1">
                <Drawer.Title className="text-xl font-semibold">{title}</Drawer.Title>
                {description && (
                  <Drawer.Description className="text-muted-foreground mt-1 text-sm">
                    {description}
                  </Drawer.Description>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
                className="ml-4 flex-shrink-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 pt-4 pb-10">{children}</div>

            {/* Footer */}
            {footer && (
              <div className="border-border flex-shrink-0 border-t px-6 py-4">{footer}</div>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
