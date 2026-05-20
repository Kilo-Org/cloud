import type { ToolPart } from './types';

type SkillToolCardProps = {
  toolPart: ToolPart;
};

type SkillInput = {
  name: string;
};

export function SkillToolCard({ toolPart }: SkillToolCardProps) {
  const state = toolPart.state;
  const input = state.input as SkillInput;
  const skillName = input.name ?? 'skill';
  const skillLabel = `Skill "${skillName}"`;
  const isLoading = state.status === 'pending' || state.status === 'running';

  if (state.status === 'error') {
    return (
      <div className="text-destructive flex min-w-0 items-baseline gap-2 px-1 py-0.5 font-mono text-sm">
        <span className="shrink-0">→</span>
        <span className="shrink-0">{skillLabel}</span>
        <span className="truncate">{state.error ?? 'Failed to load skill'}</span>
      </div>
    );
  }

  return (
    <div className="text-muted-foreground flex min-w-0 items-center gap-2 px-1 py-0.5 font-mono text-sm">
      <span className="shrink-0">→</span>
      <span className="truncate">{skillLabel}</span>
      {isLoading && <span className="animate-pulse">...</span>}
    </div>
  );
}
