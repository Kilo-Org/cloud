import type { ReactNode } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

export type RequestSheetContent = { title: ReactNode; description: ReactNode; body: ReactNode };

/** The sheet is open while `content` is set. */
export function RequestSheetFrame({
  content,
  onOpenChange,
}: {
  content: RequestSheetContent | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={content !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        {content && (
          <>
            <SheetHeader className="border-b p-6 pr-12">
              <SheetTitle className="font-mono text-base break-all">{content.title}</SheetTitle>
              <SheetDescription>{content.description}</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-8 p-6">{content.body}</div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
