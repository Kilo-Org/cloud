'use client';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

type EmojiQuickPickProps = {
  currentUserReactions: Set<string>;
  onSelect: (emoji: string) => void;
  onOpenFullPicker: () => void;
};

export function EmojiQuickPick({
  currentUserReactions,
  onSelect,
  onOpenFullPicker,
}: EmojiQuickPickProps) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-background border border-border p-1 shadow-md">
      {QUICK_EMOJIS.map(emoji => (
        <button
          key={emoji}
          onClick={() => onSelect(emoji)}
          className={`rounded p-1 text-base cursor-pointer transition-colors hover:bg-muted ${
            currentUserReactions.has(emoji) ? 'bg-primary/10' : ''
          }`}
          title={currentUserReactions.has(emoji) ? `Remove ${emoji}` : `React with ${emoji}`}
        >
          {emoji}
        </button>
      ))}
      <button
        onClick={onOpenFullPicker}
        className="rounded p-1 text-sm cursor-pointer transition-colors hover:bg-muted text-muted-foreground"
        title="More emoji"
      >
        +
      </button>
    </div>
  );
}
