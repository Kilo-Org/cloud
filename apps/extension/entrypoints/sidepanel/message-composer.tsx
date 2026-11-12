import type { ChangeEvent, JSX, KeyboardEvent } from 'react';
import { useAtom } from 'jotai';
import { TriangleAlert, X } from 'lucide-react';
import type { AgentMode } from '@/src/shared/agent-conversation';
import { draftAtomFamily, queuedMessageAtomFamily } from './agent-chat-atoms';
import { persistDraft } from './agent-draft-storage';

const getComposerPlaceholder = (isRunning: boolean, mode: AgentMode): string => {
  if (isRunning) {
    return 'Queue a message for the next turn...';
  }

  return mode === 'dangerous'
    ? 'Ask Kilo to act on this page...'
    : 'Ask Kilo to inspect this tab...';
};

export const MessageComposer = ({
  activeConversationId,
  blockedReason,
  canSend,
  isRunning,
  mode,
  onStop,
  onSubmit,
}: {
  activeConversationId: string;
  blockedReason?: string | undefined;
  canSend: boolean;
  isRunning: boolean;
  mode: AgentMode;
  onStop: () => void;
  onSubmit: () => void;
}): JSX.Element => {
  const [draft, setDraft] = useAtom(draftAtomFamily(activeConversationId));
  const [queuedMessage, setQueuedMessage] = useAtom(queuedMessageAtomFamily(activeConversationId));
  const isSendDisabled = !canSend || draft.trim() === '';
  const placeholder = getComposerPlaceholder(isRunning, mode);

  return (
    <form
      className="border-t border-border bg-surface-background px-4 py-3"
      onSubmit={event => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {mode === 'dangerous' ? (
        <p
          className="mb-2 flex items-start gap-2 rounded-md border border-status-yellow-500/40 bg-status-yellow-500/10 px-3 py-2 type-label text-status-yellow-300"
          role="status"
        >
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-status-yellow-400"
          />
          <span className="min-w-0">
            <span className="font-medium text-status-yellow-200">Dangerous mode</span> is on: Kilo
            can click, type, and run scripts on the selected tab.
          </span>
        </p>
      ) : null}
      {queuedMessage === undefined ? null : (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2">
          <span className="type-label min-w-0 flex-1 truncate text-foreground-muted">
            Queued: {queuedMessage}
          </span>
          <button
            aria-label="Cancel queued message"
            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-foreground-muted outline-none transition hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
            onClick={() => {
              setQueuedMessage(undefined);
            }}
            type="button"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      )}
      <label className="sr-only" htmlFor="agent-message">
        Message agent
      </label>
      <textarea
        className="type-body min-h-20 w-full resize-none rounded-md border border-border-strong bg-input-bg px-3 py-2 text-foreground outline-none transition placeholder:text-foreground-subtle focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
        id="agent-message"
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
          setDraft(event.currentTarget.value);
          persistDraft(activeConversationId, event.currentTarget.value);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
        placeholder={placeholder}
        value={draft}
      />
      <div className="mt-2 grid gap-2">
        {blockedReason === undefined ? null : (
          <p className="type-label text-foreground-muted">{blockedReason}</p>
        )}
        <button
          className={
            isRunning
              ? 'type-label h-9 w-full rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background'
              : 'type-label h-9 w-full rounded-md border border-transparent bg-brand-primary px-3 text-brand-primary-foreground transition hover:bg-brand-primary-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:bg-surface-selected disabled:text-foreground-subtle'
          }
          disabled={isRunning ? false : isSendDisabled}
          onClick={isRunning ? onStop : undefined}
          type={isRunning ? 'button' : 'submit'}
        >
          {isRunning ? 'Stop' : 'Send message'}
        </button>
      </div>
    </form>
  );
};
