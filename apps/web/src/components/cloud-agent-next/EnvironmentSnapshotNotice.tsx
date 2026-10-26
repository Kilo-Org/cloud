import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SNAPSHOT_REUSE_NOTICE } from './environment-build-display';

/**
 * The non-blocking notice shown wherever environment or profile setup inputs
 * are edited or combined. It never blocks a save or a launch and names no value.
 */
export function EnvironmentSnapshotNotice({ className }: { className?: string }) {
  return (
    <p role="note" className={cn('text-muted-foreground flex gap-1.5 text-xs', className)}>
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{SNAPSHOT_REUSE_NOTICE}</span>
    </p>
  );
}
