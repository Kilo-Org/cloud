'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowRight, Bot, MessagesSquare } from 'lucide-react';
import type { KiloSessionId } from '@kilocode/cloud-agent-sdk';
import type { AgentBoardState } from '@kilocode/cloud-agent-sdk/agent-board';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { toSafeHttpUrl } from '@/lib/safe-http-url';
import { cn } from '@/lib/utils';
import { useManager } from './CloudAgentProvider';
import type { OpenChildSession } from './ChildSessionSection';
import { projectAgentBoard, type AgentBoardParticipant, type AgentBoardRow } from './agent-board';

const AVATAR_COLOR_CLASSES = [
  'text-blue-400',
  'text-orange-400',
  'text-green-400',
  'text-purple-400',
  'text-yellow-400',
  'text-teal-400',
  'text-red-400',
  'text-pink-400',
];
const AVATAR_GRID = Array.from({ length: 25 }, (_, index) => index).filter(
  index => ![0, 4, 20, 24].includes(index)
);

function markdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
/** Agent-authored images must not make the viewer's browser fetch a remote URL. */
function markdownImage({ alt }: { alt?: string }) {
  return <>{alt || 'Image'}</>;
}
const markdownComponents = { a: markdownLink, img: markdownImage };

function ParticipantAvatar({ participant }: { participant: AgentBoardParticipant }) {
  if (participant.kind === 'main')
    return <Bot className="text-muted-foreground size-[18px] shrink-0" aria-hidden="true" />;
  const lit = new Set(participant.cells);
  return (
    <svg
      viewBox="0 0 19 19"
      aria-hidden="true"
      className={cn('size-[18px] shrink-0 fill-current', AVATAR_COLOR_CLASSES[participant.color])}
    >
      {AVATAR_GRID.map(cell => (
        <circle
          key={cell}
          cx={(cell % 5) * 4 + 1.5}
          cy={Math.floor(cell / 5) * 4 + 1.5}
          r={1.5}
          opacity={lit.has(cell) ? 1 : 0.1}
        />
      ))}
    </svg>
  );
}

function ParticipantName({
  participant,
  label,
  onOpen,
}: {
  participant?: AgentBoardParticipant;
  label: string;
  onOpen: OpenChildSession;
}) {
  if (participant?.kind !== 'agent') return <span className="min-w-0 truncate">{label}</span>;
  return (
    <button
      type="button"
      className="hover:text-foreground focus-visible:ring-ring min-w-0 cursor-pointer truncate rounded-sm hover:underline focus-visible:ring-2 focus-visible:outline-none"
      title={`Open ${label} transcript`}
      onClick={() =>
        onOpen({ sessionId: participant.sessionId as KiloSessionId, description: label })
      }
    >
      {label}
    </button>
  );
}

function BoardMessage({ row, onOpen }: { row: AgentBoardRow; onOpen: OpenChildSession }) {
  const recipient = row.to.participants.length === 1 ? row.to.participants[0] : undefined;
  return (
    <article className="flex flex-col gap-1.5 py-3.5">
      <div
        role="group"
        aria-label={`From ${row.from.label} to ${row.to.label}`}
        className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs"
      >
        <ParticipantAvatar participant={row.from} />
        <ParticipantName participant={row.from} label={row.from.label} onOpen={onOpen} />
        <ArrowRight className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        <span className="flex shrink-0 items-center gap-[3px]">
          {row.to.participants.map(participant => (
            <ParticipantAvatar
              key={participant.kind === 'main' ? 'main' : participant.sessionId}
              participant={participant}
            />
          ))}
        </span>
        <ParticipantName participant={recipient} label={row.to.label} onOpen={onOpen} />
      </div>
      <div className="prose prose-sm prose-invert line-clamp-4 max-w-none break-words [&_ol]:my-1 [&_p]:my-0 [&_p+p]:mt-1 [&_pre]:my-1 [&_ul]:my-1">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={markdownComponents}
          urlTransform={toSafeHttpUrl}
        >
          {row.body}
        </ReactMarkdown>
      </div>
    </article>
  );
}

export function AgentBoardDrawer({
  state,
  onOpenChildSession,
  portalContainer,
}: {
  state: AgentBoardState;
  onOpenChildSession: OpenChildSession;
  portalContainer?: HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);
  const [seenRevision, setSeenRevision] = useState<number | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const openingTranscript = useRef(false);
  const board = state.status === 'current' ? state.board : null;
  const rows = useMemo(() => (board ? projectAgentBoard(board) : []), [board]);
  const scrollToLatest = useCallback((element: HTMLDivElement | null) => {
    if (element) element.scrollTop = element.scrollHeight;
  }, []);
  if (!board || rows.length === 0) return null;
  const unread = !open && (seenRevision === null || seenRevision < board.revision);
  const markSeen = () => setSeenRevision(board.revision);
  const label = unread ? 'Board, new messages' : 'Board';
  return (
    <Sheet
      modal={false}
      open={open}
      onOpenChange={value => {
        if (value) openingTranscript.current = false;
        markSeen();
        setOpen(value);
      }}
    >
      <SheetTrigger asChild>
        <button
          ref={trigger}
          type="button"
          className="text-muted-foreground hover:text-foreground hover:bg-muted/40 focus-visible:ring-ring relative flex size-8 shrink-0 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none pointer-coarse:size-11"
          aria-label={label}
          title="Board"
        >
          <MessagesSquare className="size-4" aria-hidden="true" />
          {unread && (
            <span className="ring-background absolute top-1.5 right-1.5 size-2 rounded-full bg-blue-400 ring-2" />
          )}
        </button>
      </SheetTrigger>
      <SheetContent
        side="right"
        portalContainer={portalContainer}
        overlayClassName="absolute"
        dismissibleOverlay
        className="absolute inset-y-0 right-0 h-full w-full gap-0 border-l p-0 sm:max-w-xl"
        onInteractOutside={event => event.preventDefault()}
        onCloseAutoFocus={event => {
          if (openingTranscript.current) event.preventDefault();
        }}
      >
        <SheetHeader className="shrink-0 border-b pr-14">
          <SheetTitle className="text-base">Board</SheetTitle>
          <SheetDescription>
            Messages between the primary agent and its background agents
          </SheetDescription>
        </SheetHeader>
        <div ref={scrollToLatest} className="min-h-0 flex-1 overflow-y-auto px-4 py-2 sm:px-6">
          {board.hasMore && (
            <p className="text-muted-foreground py-2 text-center text-xs">
              Showing the latest {rows.length} messages
            </p>
          )}
          <div className="divide-y">
            {rows.map(row => (
              <BoardMessage
                key={row.id}
                row={row}
                onOpen={entry => {
                  openingTranscript.current = true;
                  markSeen();
                  trigger.current?.focus();
                  setOpen(false);
                  onOpenChildSession(entry);
                }}
              />
            ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function SessionAgentBoard({
  onOpenChildSession,
  portalContainer,
}: {
  onOpenChildSession: OpenChildSession;
  portalContainer?: HTMLElement | null;
}) {
  const manager = useManager();
  const state = useAtomValue(manager.atoms.agentBoard);
  return (
    <AgentBoardDrawer
      key={state.status === 'current' ? state.board.ownerSessionID : 'inactive'}
      state={state}
      onOpenChildSession={onOpenChildSession}
      portalContainer={portalContainer}
    />
  );
}
