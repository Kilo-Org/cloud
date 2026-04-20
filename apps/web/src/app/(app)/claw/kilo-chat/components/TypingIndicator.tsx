'use client';

type TypingIndicatorProps = {
  typingMembers: Map<string, number>;
};

export function TypingIndicator({ typingMembers }: TypingIndicatorProps) {
  const names = Array.from(typingMembers.keys()).map(id =>
    id.startsWith('bot:') ? 'KiloClaw' : id
  );

  const text =
    names.length === 1 ? `${names[0]} is typing...` : `${names.join(', ')} are typing...`;

  return (
    <div className="h-6 shrink-0 px-4 flex items-center">
      {typingMembers.size > 0 && (
        <p className="text-muted-foreground animate-pulse text-xs">{text}</p>
      )}
    </div>
  );
}
