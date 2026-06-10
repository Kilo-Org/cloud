'use client';

import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { calculateContextUsagePercentage } from '@/lib/cloud-agent-sdk/context-usage';

type ContextUsageIndicatorProps = {
  contextTokens?: number;
  contextWindow?: number;
};

function formatTokenCount(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

function formatCompactTokenCount(tokens: number): string {
  if (tokens < 1_000) return formatTokenCount(tokens);
  return `${(tokens / 1_000).toFixed(1)}K`;
}

export function formatContextUsageTooltip(contextTokens: number, contextWindow: number): string {
  return `${formatTokenCount(contextTokens)} / ${formatTokenCount(contextWindow)} tokens used`;
}

export function ContextUsageIndicator({
  contextTokens,
  contextWindow,
}: ContextUsageIndicatorProps) {
  if (contextTokens === undefined || contextWindow === undefined) return null;

  const percentage = calculateContextUsagePercentage(contextTokens, contextWindow);
  if (percentage === undefined) return null;

  const formattedContextTokens = formatTokenCount(contextTokens);
  const formattedContextWindow = formatTokenCount(contextWindow);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${percentage}% of context used. ${formattedContextTokens} of ${formattedContextWindow} tokens used.`}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-sm px-1 font-mono text-xs whitespace-nowrap tabular-nums transition-colors before:absolute before:-inset-1.5 before:content-[''] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          {formatCompactTokenCount(contextTokens)} ({percentage}%)
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {formatContextUsageTooltip(contextTokens, contextWindow)}
      </TooltipContent>
    </Tooltip>
  );
}
