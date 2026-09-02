'use client';

import { useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Loader2, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

type ToolCardShellProps = {
  icon: LucideIcon;
  title: string;
  subtitle?: ReactNode;
  badge?: ReactNode;
  status: 'pending' | 'running' | 'completed' | 'error';
  defaultExpanded?: boolean;
  children?: ReactNode;
};

export function ToolCardShell({
  icon: Icon,
  title,
  subtitle,
  badge,
  status,
  defaultExpanded,
  children,
}: ToolCardShellProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded ?? false);
  const pointerDown = useRef<{ x: number; y: number } | null>(null);

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded} data-tool-card>
      <CollapsibleTrigger
        onPointerDown={event => {
          pointerDown.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerCancel={() => {
          pointerDown.current = null;
        }}
        onClick={event => {
          const start = pointerDown.current;
          pointerDown.current = null;
          if (event.detail === 0 || !start) return;
          const selection = event.currentTarget.ownerDocument.getSelection();
          if (!selection || selection.isCollapsed) return;
          const dragged =
            Math.abs(event.clientX - start.x) > 2 || Math.abs(event.clientY - start.y) > 2;
          if (!dragged && event.detail === 1 && !event.shiftKey) return;
          for (let index = 0; index < selection.rangeCount; index++) {
            if (selection.getRangeAt(index).intersectsNode(event.currentTarget)) {
              event.preventDefault();
              return;
            }
          }
        }}
        className={cn(
          'text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:ring-ring flex min-h-6 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs select-text focus-visible:ring-2 focus-visible:outline-none pointer-coarse:min-h-11',
          status === 'error' && 'text-destructive'
        )}
      >
        {status === 'pending' || status === 'running' ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : status === 'error' ? (
          <XCircle className="size-3.5 shrink-0" />
        ) : (
          <Icon className="size-3.5 shrink-0" />
        )}
        <span className={cn('min-w-0 truncate', subtitle && 'max-w-[45%] shrink-0')} title={title}>
          {title}
        </span>
        {subtitle && (
          <>
            <span aria-hidden="true" className="text-muted-foreground/60">
              ·
            </span>
            <code className="min-w-0 cursor-text truncate text-xs">{subtitle}</code>
          </>
        )}
        <span className="flex-1" />
        {status === 'error' && <span className="text-destructive">Failed</span>}
        {badge}
        <ChevronRight className={cn('size-3.5 shrink-0', isExpanded && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-border/60 mt-1 ml-3 space-y-2 border-l px-3 py-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
