'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDown, Loader2, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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

  function renderStatusIcon() {
    switch (status) {
      case 'pending':
      case 'running':
        return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />;
      case 'completed':
        return <Icon className="text-muted-foreground h-4 w-4 shrink-0" />;
      case 'error':
        return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
    }
  }

  return (
    <div className="border-muted bg-muted/30 rounded-md border">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {renderStatusIcon()}
        {subtitle ? (
          <code className="min-w-0 flex-1 truncate text-sm">{subtitle}</code>
        ) : (
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">{title}</span>
        )}
        {badge}
        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {isExpanded && <div className="border-muted space-y-2 border-t px-3 py-2">{children}</div>}
    </div>
  );
}
