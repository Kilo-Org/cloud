import { BookOpen, Loader2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolPart } from './types';

type SkillToolCardProps = {
  toolPart: ToolPart;
};

export function SkillToolCard({ toolPart }: SkillToolCardProps) {
  const state = toolPart.state;
  const name = state.input.name || ('metadata' in state && state.metadata?.name);
  const skillName = typeof name === 'string' && name ? name : 'skill';
  const isLoading = state.status === 'pending' || state.status === 'running';

  return (
    <div
      data-tool-card
      aria-busy={isLoading || undefined}
      className={cn(
        'text-muted-foreground flex min-h-6 min-w-0 items-center gap-2 px-2 py-1 text-xs',
        state.status === 'error' && 'text-destructive'
      )}
    >
      {isLoading ? (
        <Loader2
          className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : state.status === 'error' ? (
        <XCircle className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <BookOpen className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="shrink-0">Skill</span>
      <span aria-hidden="true" className="text-muted-foreground/60">
        ·
      </span>
      <span className="min-w-0 truncate font-mono" title={skillName}>
        {skillName}
      </span>
      {state.status === 'error' && (
        <span className="min-w-0 truncate" title={state.error}>
          {state.error ?? 'Failed to load skill'}
        </span>
      )}
    </div>
  );
}
