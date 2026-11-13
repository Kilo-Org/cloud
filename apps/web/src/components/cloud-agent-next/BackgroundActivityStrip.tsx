'use client';

import { useEffect, useState, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { Activity, ChevronDown } from 'lucide-react';
import {
  backgroundActivityLabel,
  selectBackgroundActivity,
  type BackgroundActivityState,
  type BackgroundActivityItem,
} from '@kilocode/cloud-agent-sdk/background-activity';
import type { KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useManager } from './CloudAgentProvider';
import type { OpenChildSession } from './ChildSessionSection';

function ElapsedTime({ started }: { started: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  return (
    <span className="tabular-nums">
      {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`}
    </span>
  );
}

function ActivityEntry({
  item,
  onOpenChildSession,
}: {
  item: BackgroundActivityItem;
  onOpenChildSession: OpenChildSession;
}) {
  const label = item.kind === 'shell' ? item.title || item.command : item.description || item.agent;
  return (
    <li className="space-y-1 py-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words" title={label}>
          {label}
        </span>
        <span className="text-muted-foreground shrink-0">
          <ElapsedTime started={item.time.started} />
        </span>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2">
        <span>{item.waiting ? 'Needs input' : 'Running'}</span>
        {item.descendant && <span>From {item.parentLabel}</span>}
        {item.kind === 'subagent' && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto min-h-11 text-xs"
            onClick={() =>
              onOpenChildSession({
                sessionId: item.childSessionID as KiloSessionId,
                description: item.description,
                agent: item.agent,
              })
            }
          >
            Open transcript
          </Button>
        )}
      </div>
      {item.kind === 'shell' && item.title && (
        <pre className="max-h-24 overflow-auto font-mono text-xs whitespace-pre-wrap break-all">
          {item.command}
        </pre>
      )}
    </li>
  );
}

export function BackgroundActivityStrip({
  state,
  onRetry,
  onOpenChildSession,
}: {
  state: BackgroundActivityState;
  onRetry: () => void;
  onOpenChildSession: OpenChildSession;
}) {
  const items = state.status === 'current' ? selectBackgroundActivity(state.inventory) : [];
  const needed = state.status !== 'inactive' && (state.status !== 'current' || items.length > 0);
  const [appeared, setAppeared] = useState(false);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const openingTranscript = useRef(false);
  useEffect(() => {
    if (!needed) {
      setAppeared(false);
      setOpen(false);
      return;
    }
    const timer = setTimeout(() => setAppeared(true), 150);
    return () => clearTimeout(timer);
  }, [needed]);
  const visible = needed && (appeared || state.status === 'unavailable');
  const label = backgroundActivityLabel(state);
  const announcement =
    state.status === 'current'
      ? items.length
        ? label
        : 'No background activity'
      : state.status === 'unavailable'
        ? label
        : '';
  return (
    <>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      {visible && (
        <Popover
          open={open}
          onOpenChange={value => {
            if (value) openingTranscript.current = false;
            setOpen(value);
          }}
        >
          <PopoverTrigger asChild>
            <button
              ref={trigger}
              type="button"
              className="text-muted-foreground hover:text-foreground hover:bg-muted/40 focus-visible:ring-ring flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs focus-visible:ring-2 focus-visible:outline-none"
              aria-label={label}
            >
              <Activity className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate" title={label}>
                {label}
              </span>
              <ChevronDown className="ml-auto size-3.5 shrink-0" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            onCloseAutoFocus={event => {
              if (openingTranscript.current) event.preventDefault();
            }}
            side="top"
            align="start"
            aria-label="Background activity"
            className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-[min(32rem,var(--radix-popover-trigger-width))] overflow-auto p-3"
          >
            {state.status === 'unavailable' ? (
              <div className="space-y-2 text-xs">
                <p>Status unavailable. Retry to check current background activity.</p>
                <Button type="button" variant="outline" className="min-h-11" onClick={onRetry}>
                  Retry
                </Button>
              </div>
            ) : state.status !== 'current' ? (
              <p className="text-muted-foreground text-xs">Checking background activity…</p>
            ) : (
              (['subagent', 'shell'] as const).map(kind => {
                const group = items.filter(item => item.kind === kind);
                return group.length ? (
                  <section
                    key={kind}
                    aria-label={kind === 'subagent' ? 'Agents' : 'Shells'}
                    className="mb-2 last:mb-0"
                  >
                    <h3 className="text-xs font-medium">
                      {kind === 'subagent' ? 'Agents' : 'Shells'}
                    </h3>
                    <ul>
                      {group.map(item => (
                        <ActivityEntry
                          key={item.id}
                          item={item}
                          onOpenChildSession={entry => {
                            openingTranscript.current = true;
                            trigger.current?.focus();
                            setOpen(false);
                            onOpenChildSession(entry);
                          }}
                        />
                      ))}
                    </ul>
                  </section>
                ) : null;
              })
            )}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

export function SessionBackgroundActivityStrip({
  onOpenChildSession,
}: {
  onOpenChildSession: OpenChildSession;
}) {
  const manager = useManager();
  const state = useAtomValue(manager.atoms.backgroundActivity);
  return (
    <BackgroundActivityStrip
      state={state}
      onRetry={manager.retryBackgroundActivity}
      onOpenChildSession={onOpenChildSession}
    />
  );
}
