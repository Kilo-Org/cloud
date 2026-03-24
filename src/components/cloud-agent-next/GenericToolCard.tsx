import { Plug, Paperclip } from 'lucide-react';
import { ToolCardShell } from './ToolCardShell';
import { formatDuration } from './toolCardUtils';
import type { ToolPart } from './types';

type GenericToolCardProps = {
  toolPart: ToolPart;
};

// Friendly display names for known tools.
// Checked against both "server_name/tool_name" (MCP input fields)
// and the flat tool name (e.g. "app-builder-images_transfer_image").
const knownTools: Record<string, string> = {
  'app-builder-images/transfer_image': 'Publish Image',
  'app-builder-images/get_image': 'Analyze Image',
  'app-builder-images_transfer_image': 'Publish Image',
  'app-builder-images_get_image': 'Analyze Image',
};

function resolveDisplayName(toolPart: ToolPart): string {
  // Try flat tool name first (covers both MCP-flattened and non-MCP tools)
  const byTool = knownTools[toolPart.tool];
  if (byTool) return byTool;

  // Try "server_name/tool_name" from MCP input
  const input = toolPart.state.input;
  if (
    toolPart.tool === 'mcp' &&
    typeof input.server_name === 'string' &&
    typeof input.tool_name === 'string'
  ) {
    const key = `${input.server_name}/${input.tool_name}`;
    return knownTools[key] ?? key;
  }

  return toolPart.tool;
}

function getMcpArguments(toolPart: ToolPart): Record<string, unknown> | undefined {
  if (toolPart.tool !== 'mcp') return toolPart.state.input;
  const args = toolPart.state.input.arguments;
  if (args && typeof args === 'object' && Object.keys(args).length > 0) {
    return args as Record<string, unknown>;
  }
  return undefined;
}

function getDuration(state: ToolPart['state']): number | undefined {
  if (state.status === 'completed' || state.status === 'error') {
    const { start, end } = state.time;
    return end && start ? end - start : undefined;
  }
  return undefined;
}

export function GenericToolCard({ toolPart }: GenericToolCardProps) {
  const state = toolPart.state;
  const displayName = resolveDisplayName(toolPart);
  const args = getMcpArguments(toolPart);
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;
  const duration = getDuration(state);
  const attachments = state.status === 'completed' ? state.attachments : undefined;

  return (
    <ToolCardShell
      icon={Plug}
      title={displayName}
      status={state.status}
      badge={
        duration !== undefined ? (
          <span className="text-muted-foreground shrink-0 text-xs">{formatDuration(duration)}</span>
        ) : undefined
      }
    >
      {/* Arguments / Input */}
      {args && Object.keys(args).length > 0 && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Arguments:</div>
          <pre className="bg-background max-h-40 overflow-auto rounded-md p-2 text-xs">
            <code>{JSON.stringify(args, null, 2)}</code>
          </pre>
        </div>
      )}

      {/* Output */}
      {output != null && output !== '' && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Result:</div>
          <pre className="bg-background max-h-60 overflow-auto rounded-md p-2 text-xs">
            <code>{output}</code>
          </pre>
        </div>
      )}

      {/* Attachments */}
      {attachments && attachments.length > 0 && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Attachments:</div>
          <div className="flex flex-wrap gap-2">
            {attachments.map((file, index) =>
              file.url ? (
                <a
                  key={file.id || index}
                  href={file.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bg-background hover:bg-muted flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors"
                >
                  <Paperclip className="h-3 w-3" />
                  <span>{file.filename || `File ${index + 1}`}</span>
                </a>
              ) : (
                <div
                  key={file.id || index}
                  className="bg-background text-muted-foreground flex items-center gap-1 rounded-md px-2 py-1 text-xs"
                >
                  <Paperclip className="h-3 w-3" />
                  <span>{file.filename || `File ${index + 1}`}</span>
                </div>
              )
            )}
          </div>
        </div>
      )}

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
        <div className="text-muted-foreground text-xs italic">Running...</div>
      )}

      {/* Pending state */}
      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting...</div>
      )}
    </ToolCardShell>
  );
}
