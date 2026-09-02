import { Plug, Paperclip } from 'lucide-react';
import * as z from 'zod';
import { toSafeHttpUrl } from '@/lib/safe-http-url';
import { ToolCardShell } from './ToolCardShell';
import { ToolCodeBlock, ToolMarkdown } from './ToolOutput';
import { formatDuration } from './toolCardUtils';
import type { ToolPart } from './types';

type GenericToolCardProps = {
  toolPart: ToolPart;
};

const knownTools = new Map([
  ['app-builder-images/transfer_image', 'Publish Image'],
  ['app-builder-images/get_image', 'Analyze Image'],
  ['app-builder-images_transfer_image', 'Publish Image'],
  ['app-builder-images_get_image', 'Analyze Image'],
]);
const labelKeys = ['description', 'query', 'url', 'filePath', 'path', 'pattern', 'name'];
const argumentsSchema = z.record(z.string(), z.unknown());

function resolveDisplayName(toolPart: ToolPart): string {
  const byTool = knownTools.get(toolPart.tool);
  if (byTool) return byTool;

  const input = toolPart.state.input;
  if (
    toolPart.tool === 'mcp' &&
    typeof input.server_name === 'string' &&
    typeof input.tool_name === 'string'
  ) {
    const key = `${input.server_name}/${input.tool_name}`;
    return knownTools.get(key) ?? key;
  }

  return toolPart.tool;
}

function getMcpArguments(toolPart: ToolPart): Record<string, unknown> | undefined {
  if (toolPart.tool !== 'mcp') return toolPart.state.input;
  const result = argumentsSchema.safeParse(toolPart.state.input.arguments);
  return result.success ? result.data : undefined;
}

function getArgumentSummary(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const label = labelKeys
    .map(key => args[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const scalar = Object.entries(args).find(
    ([key, value]) =>
      !labelKeys.includes(key) &&
      ((typeof value === 'string' && value.trim().length > 0) ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        typeof value === 'boolean')
  );
  return (
    [label, scalar ? `${scalar[0]}=${String(scalar[1])}` : undefined].filter(Boolean).join(' · ') ||
    undefined
  );
}

function formatJson(output: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(output);
    for (const token of output.matchAll(/"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
      const numberLiteral = token[1];
      if (numberLiteral !== undefined && JSON.stringify(Number(numberLiteral)) !== numberLiteral) {
        return output;
      }
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return undefined;
  }
}

function getDuration(state: ToolPart['state']): number | undefined {
  if (state.status === 'completed' || state.status === 'error') {
    const { start, end } = state.time;
    return end - start;
  }
  return undefined;
}

export function GenericToolCard({ toolPart }: GenericToolCardProps) {
  const state = toolPart.state;
  const args = getMcpArguments(toolPart);
  const output = state.status === 'completed' ? state.output : '';
  const formattedOutput = output.trim() ? formatJson(output) : undefined;
  const duration = getDuration(state);
  const attachments = state.status === 'completed' ? state.attachments : undefined;

  return (
    <ToolCardShell
      icon={Plug}
      title={resolveDisplayName(toolPart)}
      subtitle={getArgumentSummary(args)}
      status={state.status}
      badge={
        duration !== undefined ? (
          <span className="text-muted-foreground shrink-0 text-xs">{formatDuration(duration)}</span>
        ) : undefined
      }
    >
      {args && Object.keys(args).length > 0 && (
        <ToolCodeBlock content={JSON.stringify(args, null, 2)} label="Arguments" />
      )}
      {formattedOutput !== undefined ? (
        <ToolCodeBlock content={formattedOutput} label="Output" />
      ) : output.trim() ? (
        <div className="min-w-0 space-y-1">
          <div className="text-muted-foreground text-xs">Output</div>
          <ToolMarkdown content={output} />
        </div>
      ) : null}
      {attachments && attachments.length > 0 && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Attachments:</div>
          <div className="flex flex-wrap gap-2">
            {attachments.map((file, index) => {
              const safeHref = toSafeHttpUrl(file.url);
              return safeHref ? (
                <a
                  key={file.id || index}
                  href={safeHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bg-background hover:bg-muted focus-visible:ring-ring flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none"
                >
                  <Paperclip className="h-3 w-3 shrink-0" />
                  <span className="[overflow-wrap:anywhere]">
                    {file.filename || `File ${index + 1}`}
                  </span>
                </a>
              ) : (
                <div
                  key={file.id || index}
                  className="bg-background text-muted-foreground flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs"
                >
                  <Paperclip className="h-3 w-3 shrink-0" />
                  <span className="[overflow-wrap:anywhere]">
                    {file.filename || `File ${index + 1}`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {state.status === 'completed' && !output.trim() && !attachments?.length && (
        <div className="text-muted-foreground text-xs">No output.</div>
      )}
      {state.status === 'error' && (
        <ToolCodeBlock content={state.error} label="Error" className="[&_pre]:text-destructive" />
      )}
      {state.status === 'running' && (
        <div className="text-muted-foreground text-xs">Running...</div>
      )}
      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs">Waiting...</div>
      )}
    </ToolCardShell>
  );
}
