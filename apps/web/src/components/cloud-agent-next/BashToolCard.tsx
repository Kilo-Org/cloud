import { Terminal } from 'lucide-react';
import type { ToolPart } from './types';
import { ToolCardShell } from './ToolCardShell';
import { ToolCodeBlock } from './ToolOutput';
import { normalizeTerminalOutput } from './normalize-terminal-output';

type BashToolCardProps = {
  toolPart: ToolPart;
};

const WORKSPACE_PATH_PATTERN = /\/workspace\/(?:[^/\s]+\/)?[^/\s]+\/sessions\/[^/\s]+/g;

function getCommandPreview(command: string): string {
  const normalized = command.replace(WORKSPACE_PATH_PATTERN, '.');
  const firstLine = normalized.split('\n')[0] || normalized;
  return firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function BashToolCard({ toolPart }: BashToolCardProps) {
  const state = toolPart.state;
  const input = state.input;
  const metadata = state.status === 'pending' ? undefined : state.metadata;
  const command = text(input.command) ?? text(metadata?.command) ?? '';
  const description = text(input.description) ?? text(metadata?.description);
  const cwd = text(input.workdir);
  const rawOutput =
    state.status === 'completed'
      ? state.output
      : state.status === 'running' && typeof metadata?.output === 'string'
        ? metadata.output
        : '';
  const output = normalizeTerminalOutput(rawOutput);

  return (
    <ToolCardShell
      icon={Terminal}
      title="Shell"
      subtitle={description ?? getCommandPreview(command)}
      status={state.status}
    >
      {command && (
        <ToolCodeBlock
          content={command}
          label="Command"
          compact
          icon={<Terminal className="size-3.5" />}
        />
      )}
      {cwd && (
        <div className="text-muted-foreground font-mono text-xs [overflow-wrap:anywhere]">
          cwd: {cwd}
        </div>
      )}
      {output.trim() ? (
        <ToolCodeBlock
          content={output}
          label="Output"
          compact
          isStreaming={state.status === 'running'}
        />
      ) : null}
      {state.status === 'completed' && !output.trim() && (
        <div className="text-muted-foreground text-xs">Command completed with no output.</div>
      )}
      {state.status === 'error' && (
        <ToolCodeBlock
          content={normalizeTerminalOutput(state.error)}
          label="Error"
          className="[&_pre]:text-destructive"
        />
      )}
      {state.status === 'running' && !output.trim() && (
        <div className="text-muted-foreground text-xs">Waiting for output...</div>
      )}
      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs">Waiting to execute...</div>
      )}
    </ToolCardShell>
  );
}
