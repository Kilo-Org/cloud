'use client';

import { atom, useAtom } from 'jotai';
import { useContext } from 'react';
import { Bot, CircleSlash, Info, Terminal } from 'lucide-react';
import {
  backgroundResultLabel,
  type BackgroundResult,
} from '@kilocode/cloud-agent-sdk/background-result';
import type { KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { Button } from '@/components/ui/button';
import { CopyMessageButton } from '@/components/shared/CopyMessageButton';
import { ToolCardShell } from './ToolCardShell';
import { ToolCodeBlock, ToolMarkdown } from './ToolOutput';
import { CloudPresentationContext } from './assistant-ui/cloud-presentation-context';
import type { ToolPart } from './types';

const expandedResultsAtom = atom<ReadonlyMap<string, boolean>>(new Map());

export function BackgroundResultCard({
  part,
  result,
}: {
  part: ToolPart;
  result: BackgroundResult;
}) {
  const actions = useContext(CloudPresentationContext);
  const [expanded, setExpanded] = useAtom(expandedResultsAtom);
  const key = `${part.sessionID}/${part.id}`;
  const cancelled = result.outcome === 'cancelled' || result.outcome === 'terminated';
  const icon = cancelled
    ? CircleSlash
    : result.kind === 'shell'
      ? Terminal
      : result.kind === 'notice'
        ? Info
        : Bot;
  return (
    <ToolCardShell
      icon={icon}
      title={backgroundResultLabel(result)}
      subtitle={result.description || (result.kind === 'shell' ? result.command : undefined)}
      badge={
        result.kind === 'shell' ? (
          <span className="shrink-0 tabular-nums">
            {result.exit === undefined ? 'Exit unknown' : `Exit ${result.exit}`}
          </span>
        ) : undefined
      }
      status={result.outcome === 'failed' ? 'error' : 'completed'}
      triggerClassName="min-h-11"
      expansion={{
        open: expanded.get(key) ?? false,
        onOpenChange: open =>
          setExpanded(current => {
            const next = new Map(current);
            next.delete(key);
            if (open) next.set(key, true);
            if (next.size > 512) {
              const oldest = next.keys().next().value;
              if (oldest) next.delete(oldest);
            }
            return next;
          }),
      }}
    >
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <span>
          {result.kind === 'subagent'
            ? `${result.agent} · ${result.state}`
            : `State: ${result.state}`}
        </span>
        <CopyMessageButton
          getText={() => result.output}
          label="Copy result"
          className="min-h-11 min-w-11"
        />
        {result.kind === 'subagent' && actions?.onOpenChildSession && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11"
            onClick={() =>
              actions.onOpenChildSession?.({
                sessionId: result.childID as KiloSessionId,
                description: result.description,
                agent: result.agent,
              })
            }
          >
            Open transcript
          </Button>
        )}
      </div>
      {result.description && (
        <p className="text-muted-foreground text-xs break-words">{result.description}</p>
      )}
      {result.kind === 'shell' ? (
        <>
          <ToolCodeBlock
            content={result.command}
            label="Command"
            className="[&_button]:min-h-11 [&_button]:min-w-11"
          />
          <ToolCodeBlock
            content={result.output || '(No output)'}
            label="Output"
            className="[&_button]:min-h-11 [&_button]:min-w-11"
          />
          {result.truncated && (
            <p className="text-muted-foreground text-xs">The shell truncated this output.</p>
          )}
        </>
      ) : result.kind === 'notice' ? (
        <ToolCodeBlock
          content={result.output}
          label="Agent notice"
          className="[&_button]:min-h-11 [&_button]:min-w-11"
        />
      ) : (
        <ToolMarkdown
          content={result.output || 'No result was returned.'}
          className="[&_button]:min-h-11 [&_button]:min-w-11"
        />
      )}
    </ToolCardShell>
  );
}
