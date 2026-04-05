'use client';

import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp, CheckCircle2, XCircle, Loader2, Paperclip } from 'lucide-react';
import type { ToolExecution, ToolPart, FilePart } from './types';

type ToolExecutionCardProps = {
  execution?: ToolExecution; // V1 format (deprecated)
  toolPart?: ToolPart; // V2 format
};

/**
 * Normalized internal representation for tool display.
 * Allows the component to work with both V1 and V2 formats.
 */
type NormalizedToolData = {
  toolName: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  input: Record<string, unknown>;
  rawInput?: string; // V2 pending state raw input
  output?: string;
  error?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  attachments?: FilePart[];
  duration?: number; // in milliseconds
};

/**
 * Convert V1 ToolExecution to normalized format
 */
function normalizeV1Execution(execution: ToolExecution): NormalizedToolData {
  let status: NormalizedToolData['status'] = 'running';
  if (execution.error) {
    status = 'error';
  } else if (execution.output !== undefined) {
    status = 'completed';
  }

  return {
    toolName: execution.toolName,
    status,
    input: execution.input,
    output: execution.output,
    error: execution.error,
  };
}

/**
 * Convert V2 ToolPart to normalized format
 */
function normalizeV2ToolPart(toolPart: ToolPart): NormalizedToolData {
  const state = toolPart.state;
  const base: NormalizedToolData = {
    toolName: toolPart.tool,
    status: state.status,
    input: state.input,
  };

  switch (state.status) {
    case 'pending':
      return {
        ...base,
        rawInput: state.raw,
      };
    case 'running':
      return {
        ...base,
        title: state.title,
        metadata: state.metadata,
      };
    case 'completed': {
      const duration =
        state.time.end && state.time.start ? state.time.end - state.time.start : undefined;
      return {
        ...base,
        output: state.output,
        title: state.title,
        metadata: state.metadata,
        attachments: state.attachments,
        duration,
      };
    }
    case 'error': {
      const duration =
        state.time.end && state.time.start ? state.time.end - state.time.start : undefined;
      return {
        ...base,
        error: state.error,
        metadata: state.metadata,
        duration,
      };
    }
    default:
      return base;
  }
}

function getStatusIcon(status: NormalizedToolData['status']) {
  switch (status) {
    case 'error':
      return <XCircle className="h-4 w-4 text-red-500 md:h-5 md:w-5" />;
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-green-500 md:h-5 md:w-5" />;
    case 'pending':
    case 'running':
    default:
      return <Loader2 className="h-4 w-4 animate-spin text-blue-500 md:h-5 md:w-5" />;
  }
}

function getStatusText(status: NormalizedToolData['status']): string {
  switch (status) {
    case 'error':
      return 'Error';
    case 'completed':
      return 'Complete';
    case 'pending':
      return 'Pending';
    case 'running':
    default:
      return 'Running';
  }
}

/**
 * Format duration in milliseconds to a human-readable string
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

function truncateText(
  text: string,
  maxLength: number = 200
): { text: string; isTruncated: boolean } {
  if (text.length <= maxLength) {
    return { text, isTruncated: false };
  }
  return { text: text.slice(0, maxLength) + '...', isTruncated: true };
}

export function ToolExecutionCard({ execution, toolPart }: ToolExecutionCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Normalize the data from either V1 or V2 format
  const data = useMemo((): NormalizedToolData | null => {
    if (toolPart) {
      return normalizeV2ToolPart(toolPart);
    }
    if (execution) {
      return normalizeV1Execution(execution);
    }
    return null;
  }, [toolPart, execution]);

  // Return null if no data provided
  if (!data) {
    return null;
  }

  const inputStr = JSON.stringify(data.input, null, 2);
  const outputStr = data.output || '';
  const errorStr = data.error || '';
  const rawInputStr = data.rawInput || '';

  const { text: displayOutput, isTruncated: isOutputTruncated } = truncateText(outputStr, 300);
  const { text: displayError, isTruncated: isErrorTruncated } = truncateText(errorStr, 300);
  const { text: displayRawInput, isTruncated: isRawInputTruncated } = truncateText(
    rawInputStr,
    300
  );

  const shouldShowExpand =
    isOutputTruncated || isErrorTruncated || isRawInputTruncated || inputStr.length > 300;

  // Display title: prefer V2 title, fallback to tool name
  const displayTitle = data.title || data.toolName;

  return (
    <Card className="border-muted bg-muted/30">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            {getStatusIcon(data.status)}
            <CardTitle className="text-sm font-medium">{displayTitle}</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {data.duration !== undefined && (
              <span className="text-muted-foreground text-xs">{formatDuration(data.duration)}</span>
            )}
            <Badge variant="outline" className="text-xs">
              {getStatusText(data.status)}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {/* Pending state: show raw input preview */}
        {data.status === 'pending' && rawInputStr && (
          <div>
            <div className="text-muted-foreground mb-1 text-xs font-medium">Input (streaming):</div>
            <pre className="bg-background overflow-wrap-anywhere overflow-hidden rounded-md p-2 text-xs break-words whitespace-pre-wrap">
              <code>{isExpanded ? rawInputStr : displayRawInput}</code>
            </pre>
          </div>
        )}

        {/* Input (show for non-pending states, or if no raw input) */}
        {(data.status !== 'pending' || !rawInputStr) && (
          <div>
            <div className="text-muted-foreground mb-1 text-xs font-medium">Input:</div>
            <pre className="bg-background overflow-wrap-anywhere overflow-hidden rounded-md p-2 text-xs break-words whitespace-pre-wrap">
              <code>{isExpanded ? inputStr : truncateText(inputStr, 300).text}</code>
            </pre>
          </div>
        )}

        {/* Metadata (V2 running/completed states) */}
        {data.metadata && Object.keys(data.metadata).length > 0 && (
          <div>
            <div className="text-muted-foreground mb-1 text-xs font-medium">Metadata:</div>
            <pre className="bg-background overflow-wrap-anywhere overflow-hidden rounded-md p-2 text-xs break-words whitespace-pre-wrap">
              <code>{JSON.stringify(data.metadata, null, 2)}</code>
            </pre>
          </div>
        )}

        {/* Output */}
        {data.output !== undefined && (
          <div>
            <div className="text-muted-foreground mb-1 text-xs font-medium">Output:</div>
            {outputStr.length === 0 ? (
              <div className="text-muted-foreground text-xs italic">
                Tool completed successfully
              </div>
            ) : (
              <pre className="bg-background overflow-wrap-anywhere overflow-hidden rounded-md p-2 text-xs break-words whitespace-pre-wrap">
                <code>{isExpanded ? outputStr : displayOutput}</code>
              </pre>
            )}
          </div>
        )}

        {/* Attachments (V2 completed state) */}
        {data.attachments && data.attachments.length > 0 && (
          <div>
            <div className="text-muted-foreground mb-1 text-xs font-medium">Attachments:</div>
            <div className="flex flex-wrap gap-2">
              {data.attachments.map((file, index) =>
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
        {data.error && (
          <div>
            <div className="text-muted-foreground mb-1 text-xs font-medium">Error:</div>
            <pre className="bg-background overflow-wrap-anywhere overflow-hidden rounded-md p-2 text-xs break-words whitespace-pre-wrap text-red-500">
              <code>{isExpanded ? errorStr : displayError}</code>
            </pre>
          </div>
        )}

        {/* Expand/Collapse Button */}
        {shouldShowExpand && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
            className="w-full"
          >
            {isExpanded ? (
              <>
                <ChevronUp className="mr-1 h-4 w-4 md:h-5 md:w-5" />
                Show Less
              </>
            ) : (
              <>
                <ChevronDown className="mr-1 h-4 w-4 md:h-5 md:w-5" />
                Show More
              </>
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
