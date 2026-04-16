'use client';

type TypingIndicatorProps = {
  typingMembers: Map<string, number>;
};

export function TypingIndicator({ typingMembers }: TypingIndicatorProps) {
  if (typingMembers.size === 0) return null;

  const names = Array.from(typingMembers.keys()).map(id =>
    id.startsWith('bot:') ? 'KiloClaw' : id
  );

  const text =
    names.length === 1 ? `${names[0]} is typing...` : `${names.join(', ')} are typing...`;

  return (
    <div className="px-4 py-1">
      <p className="text-muted-foreground animate-pulse text-xs">{text}</p>
    </div>
  );
}
