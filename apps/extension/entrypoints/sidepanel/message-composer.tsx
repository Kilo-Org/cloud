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
      className="border-t border-zinc-900 px-4 py-3"
      onSubmit={event => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="sr-only" htmlFor="agent-message">
        Message agent
      </label>
      <textarea
        className="min-h-20 w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm leading-5 text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#EDFF00] focus:ring-2 focus:ring-[#EDFF00]/30"
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
          className="h-9 w-full rounded-md bg-[#EDFF00] px-3 text-sm font-semibold text-zinc-950 transition hover:bg-[#d9ea00] focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
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
