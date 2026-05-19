import { BookOpen } from 'lucide-react';
import { ToolCardShell } from './ToolCardShell';
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
  const error = state.status === 'error' ? state.error : undefined;

  return (
    <ToolCardShell
      icon={BookOpen}
      title="Loading skill"
      subtitle={skillName}
      status={state.status}
    >
      {/* Error */}
      {error && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Error:</div>
          <pre className="bg-background overflow-auto rounded-md p-2 text-xs text-red-500">
            <code>{error}</code>
          </pre>
        </div>
      )}

      {/* Running state */}
      {state.status === 'running' && (
        <div className="text-muted-foreground text-xs italic">Loading {skillName}...</div>
      )}

      {/* Pending state */}
      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting to load {skillName}...</div>
      )}
    </ToolCardShell>
  );
}
