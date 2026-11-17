import { useCallback, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent, ReactNode } from 'react';

export const AgentsComposer = ({
  canSend,
  canInterrupt,
  isStreaming,
  isReadOnly,
  isLoading,
  disabledReason,
  modelPicker,
  onSend,
  onStop,
}: {
  canSend: boolean;
  canInterrupt: boolean;
  isStreaming: boolean;
  isReadOnly: boolean;
  isLoading: boolean;
  /** Why the composer cannot send: shown in place of the input, never silently. */
  disabledReason?: string | undefined;
  /** Model control row; omitted when the session has no pickable catalog. */
  modelPicker?: ReactNode;
  onSend: (text: string) => void | Promise<void>;
  onStop: () => void;
}): JSX.Element => {
  const [draft, setDraft] = useState('');
  const isSendDisabled = !canSend || draft.trim() === '';

  const submit = useCallback((): void => {
    const trimmed = draft.trim();
    if (trimmed === '' || !canSend) {
      return;
    }
    setDraft('');
    const result = onSend(trimmed);
    if (result instanceof Promise) {
      void (async () => {
        try {
          await result;
        } catch {
          // Rejection handled by SDK atoms
        }
      })();
    }
  }, [draft, canSend, onSend]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.nativeEvent.isComposing) {
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        // Sending stays available while the agent runs — the message queues.
        submit();
      }
    },
    [submit]
  );

  if (isReadOnly) {
    return (
      <div className="border-t border-border bg-surface-raised px-4 py-3">
        <p className="type-label rounded-md bg-surface-selected px-3 py-2 text-center text-foreground-muted">
          {disabledReason ?? 'This session is read-only'}
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="border-t border-border bg-surface-background px-4 py-3">
        <div className="space-y-2">
          <div className="h-20 w-full animate-pulse rounded-md bg-surface-selected" />
          <div className="h-9 w-full animate-pulse rounded-md bg-surface-selected" />
        </div>
      </div>
    );
  }

  return (
    <form
      className="border-t border-border bg-surface-background px-4 py-3"
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="sr-only" htmlFor="agents-message">
        Message agent
      </label>
      <textarea
        className="type-body min-h-20 w-full resize-none rounded-md border border-border-strong bg-input-bg px-3 py-2 text-foreground outline-none transition placeholder:text-foreground-subtle focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:opacity-60"
        disabled={!canSend}
        id="agents-message"
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Send a message…"
        value={draft}
      />
      {canSend ? null : (
        <p className="mt-2 type-label text-foreground-muted">
          {disabledReason ?? 'Messages cannot be sent right now.'}
        </p>
      )}
      {modelPicker === undefined ? null : <div className="mt-2 flex gap-2">{modelPicker}</div>}
      <div className="mt-2 flex gap-2">
        <button
          className={`type-label h-9 ${isStreaming ? 'flex-1' : 'w-full'} rounded-md border border-transparent bg-brand-primary px-3 text-brand-primary-foreground transition hover:bg-brand-primary-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:bg-surface-selected disabled:text-foreground-subtle`}
          disabled={isSendDisabled}
          type="submit"
        >
          Send message
        </button>
        {isStreaming ? (
          <button
            className="type-label h-9 w-20 shrink-0 rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canInterrupt}
            onClick={onStop}
            type="button"
          >
            Stop
          </button>
        ) : null}
      </div>
    </form>
  );
};
