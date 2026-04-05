'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import type { ToolExecution } from './types';

type ToolExecutionCardProps = {
  execution: ToolExecution;
};

function getStatusIcon(execution: ToolExecution) {
  if (execution.error) {
    return <XCircle className="h-4 w-4 text-red-500 md:h-5 md:w-5" />;
  }
  if (execution.output !== undefined) {
    return <CheckCircle2 className="h-4 w-4 text-green-500 md:h-5 md:w-5" />;
  }
  return <Loader2 className="h-4 w-4 animate-spin text-blue-500 md:h-5 md:w-5" />;
}

function getStatusText(execution: ToolExecution): string {
  if (execution.error) return 'Error';
  if (execution.output !== undefined) return 'Complete';
  return 'Running';
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

export function ToolExecutionCard({ execution }: ToolExecutionCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const inputStr = JSON.stringify(execution.input, null, 2);
  const outputStr = execution.output || '';
  const errorStr = execution.error || '';

  const { text: displayOutput, isTruncated: isOutputTruncated } = truncateText(outputStr, 300);
  const { text: displayError, isTruncated: isErrorTruncated } = truncateText(errorStr, 300);

  const shouldShowExpand = isOutputTruncated || isErrorTruncated || inputStr.length > 300;

  return (
    <Card className="border-muted bg-muted/30">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            {getStatusIcon(execution)}
            <CardTitle className="text-sm font-medium">{execution.toolName}</CardTitle>
          </div>
          <Badge variant="outline" className="text-xs">
            {getStatusText(execution)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {/* Input */}
        <div>
          <div className="text-muted-foreground mb-1 text-xs font-medium">Input:</div>
          <pre className="bg-background overflow-wrap-anywhere overflow-hidden rounded-md p-2 text-xs break-words whitespace-pre-wrap">
            <code>{isExpanded ? inputStr : truncateText(inputStr, 300).text}</code>
          </pre>
        </div>

        {/* Output */}
        {execution.output !== undefined && (
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

        {/* Error */}
        {execution.error && (
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
