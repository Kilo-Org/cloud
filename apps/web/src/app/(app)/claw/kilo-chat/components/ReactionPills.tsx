'use client';

import { useState, useCallback, useRef } from 'react';
import type { ReactionSummary } from '@kilocode/kilo-chat';
import { EmojiPicker } from './EmojiPicker';

type ReactionPillsProps = {
  reactions: ReactionSummary[];
  currentUserId: string | null;
  isOwn: boolean;
  userActionsEnabled: boolean;
  onAdd: (emoji: string) => void;
  onRemove: (emoji: string) => void;
};

export function ReactionPills({
  reactions,
  currentUserId,
  isOwn,
  userActionsEnabled,
  onAdd,
  onRemove,
}: ReactionPillsProps) {
  const [showPicker, setShowPicker] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const handlePickerSelect = useCallback(
    (emoji: string) => {
      if (!userActionsEnabled || currentUserId === null) return;
      setShowPicker(false);
      const existing = reactions.find(r => r.emoji === emoji);
      if (existing?.memberIds.includes(currentUserId)) {
        onRemove(emoji);
      } else {
        onAdd(emoji);
      }
    },
    [reactions, currentUserId, userActionsEnabled, onAdd, onRemove]
  );

  if (reactions.length === 0) return null;

  return (
    <div className={`flex flex-wrap gap-1 mt-1 ${isOwn ? 'justify-end' : 'justify-start'}`}>
      {reactions.map(r => {
        const isMine = currentUserId !== null && r.memberIds.includes(currentUserId);
        return (
          <button
            key={r.emoji}
            onClick={() => (isMine ? onRemove(r.emoji) : onAdd(r.emoji))}
            disabled={!userActionsEnabled}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs cursor-pointer transition-colors border ${
              isMine
                ? 'bg-primary/20 border-primary/50 hover:bg-primary/30'
                : 'bg-muted border-border hover:bg-accent'
            } disabled:cursor-not-allowed disabled:opacity-50`}
            title={isMine ? `Remove ${r.emoji}` : `React with ${r.emoji}`}
          >
            <span className="text-sm">{r.emoji}</span>
            <span className={isMine ? 'text-primary font-bold' : 'text-muted-foreground'}>
              {r.count}
            </span>
          </button>
        );
      })}
      <button
        ref={addButtonRef}
        onClick={() => setShowPicker(prev => !prev)}
        disabled={!userActionsEnabled}
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-sm cursor-pointer transition-colors border bg-muted border-border hover:bg-accent text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
        title="Add reaction"
      >
        +
      </button>
      {showPicker && (
        <EmojiPicker
          onSelect={handlePickerSelect}
          onClose={() => setShowPicker(false)}
          anchorRef={addButtonRef}
        />
      )}
    </div>
  );
}
