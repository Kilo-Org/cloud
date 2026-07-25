import type { ChangeEvent, JSX, KeyboardEvent } from 'react';
import { useAtom } from 'jotai';
import { draftAtomFamily } from './agent-chat-atoms';

export const MessageComposer = ({
  activeConversationId,
  canSend,
  isRunning,
  onStop,
  onSubmit,
}: {
  activeConversationId: string;
  canSend: boolean;
  isRunning: boolean;
  onStop: () => void;
  onSubmit: () => void;
}): JSX.Element => {
  const [draft, setDraft] = useAtom(draftAtomFamily(activeConversationId));
  const isSendDisabled = !canSend || draft.trim() === '';

  return (
    <form
      className="border-t border-border bg-surface-background px-4 py-3"
      onSubmit={event => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="sr-only" htmlFor="agent-message">
        Message agent
      </label>
      <textarea
        className="type-body min-h-20 w-full resize-none rounded-md border border-border-strong bg-input-bg px-3 py-2 text-foreground outline-none transition placeholder:text-foreground-subtle focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
        id="agent-message"
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
        placeholder="Ask Kilo to inspect this tab..."
        value={draft}
      />
      <div className="mt-2 grid gap-2">
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
