import { useCallback, useState, type ChangeEvent, type JSX, type KeyboardEvent } from 'react';

export const AgentsComposer = ({
  canSend,
  canInterrupt,
  isStreaming,
  isReadOnly,
  isLoading,
  onSend,
  onStop,
}: {
  canSend: boolean;
  canInterrupt: boolean;
  isStreaming: boolean;
  isReadOnly: boolean;
  isLoading: boolean;
  onSend: (text: string) => void | Promise<void>;
  onStop: () => void;
}): JSX.Element => {
  const [draft, setDraft] = useState('');
  const isSendDisabled = !canSend || draft.trim() === '';

  const submit = useCallback((): void => {
    const trimmed = draft.trim();
    if (trimmed === '' || !canSend) return;
    setDraft('');
    const result = onSend(trimmed);
    if (result instanceof Promise) {
      result.catch(() => {
        // Rejection handled by SDK atoms — suppress unhandled rejection
      });
    }
  }, [draft, canSend, onSend]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!isStreaming) {
          submit();
        }
      }
    },
    [isStreaming, submit]
  );

  if (isReadOnly) {
    return (
      <div className="border-t border-border bg-surface-raised px-4 py-3">
        <p className="type-label rounded-md bg-surface-selected px-3 py-2 text-center text-foreground-muted">
          This session is read-only
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
        className="type-body min-h-20 w-full resize-none rounded-md border border-border-strong bg-input-bg px-3 py-2 text-foreground outline-none transition placeholder:text-foreground-subtle focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
        id="agents-message"
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Send a message…"
        value={draft}
      />
      <div className="mt-2 grid gap-2">
        <button
          className={
            isStreaming
              ? 'type-label h-9 w-full rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background'
              : 'type-label h-9 w-full rounded-md border border-transparent bg-brand-primary px-3 text-brand-primary-foreground transition hover:bg-brand-primary-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:bg-surface-selected disabled:text-foreground-subtle'
          }
          disabled={isStreaming ? !canInterrupt : isSendDisabled}
          onClick={isStreaming && canInterrupt ? onStop : undefined}
          type={isStreaming && canInterrupt ? 'button' : 'submit'}
        >
          {isStreaming ? 'Stop' : 'Send message'}
        </button>
      </div>
    </form>
  );
};
