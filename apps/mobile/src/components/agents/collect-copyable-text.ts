type TextPartLike = { type: string; text: string };
type CopyablePart = TextPartLike | { type: string };

type CopyableMessage = {
  parts: readonly CopyablePart[];
};

function isTextPartLike(part: CopyablePart): part is TextPartLike {
  return part.type === 'text' && typeof (part as TextPartLike).text === 'string';
}

export function collectCopyableText(message: CopyableMessage): string {
  return message.parts
    .filter(isTextPartLike)
    .map(part => part.text)
    .join('\n\n');
}
