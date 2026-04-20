'use client';

import { useState, useCallback } from 'react';
import type { ReactionSummary } from '@kilocode/kilo-chat';
import { EmojiPicker } from './EmojiPicker';

type ReactionPillsProps = {
  reactions: ReactionSummary[];
  currentUserId: string;
  isOwn: boolean;
  onAdd: (emoji: string) => void;
  onRemove: (emoji: string) => void;
};

export function ReactionPills({
  reactions,
  currentUserId,
  isOwn,
  onAdd,
  onRemove,
}: ReactionPillsProps) {
  const [showPicker, setShowPicker] = useState(false);

  const handlePickerSelect = useCallback(
    (emoji: string) => {
      setShowPicker(false);
      const existing = reactions.find(r => r.emoji === emoji);
      if (existing?.memberIds.includes(currentUserId)) {
        onRemove(emoji);
      } else {
        onAdd(emoji);
      }
    },
    [reactions, currentUserId, onAdd, onRemove]
  );

  if (reactions.length === 0 && !showPicker) return null;

  return (
    <div className={`flex flex-wrap gap-1 mt-1 ${isOwn ? 'justify-end' : 'justify-start'}`}>
      {reactions.map(r => {
        const isMine = r.memberIds.includes(currentUserId);
        return (
          <button
            key={r.emoji}
            onClick={() => (isMine ? onRemove(r.emoji) : onAdd(r.emoji))}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs cursor-pointer transition-colors border ${
              isMine
                ? 'bg-primary/10 border-primary/30 hover:bg-primary/20'
                : 'bg-muted border-border hover:bg-accent'
            }`}
            title={isMine ? `Remove ${r.emoji}` : `React with ${r.emoji}`}
          >
            <span className="text-sm">{r.emoji}</span>
            <span className={isMine ? 'text-primary font-medium' : 'text-muted-foreground'}>
              {r.count}
            </span>
          </button>
        );
      })}
      <div className="relative">
        <button
          onClick={() => setShowPicker(prev => !prev)}
          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs cursor-pointer transition-colors border bg-muted border-border hover:bg-accent text-muted-foreground"
          title="Add reaction"
        >
          +
        </button>
        {showPicker && (
          <div className={`absolute bottom-full mb-2 z-50 ${isOwn ? 'right-0' : 'left-0'}`}>
            <EmojiPicker onSelect={handlePickerSelect} onClose={() => setShowPicker(false)} />
          </div>
        )}
      </div>
    </div>
  );
}
