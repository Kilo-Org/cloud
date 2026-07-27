type TextPartLike = { type: string; text: string; synthetic?: boolean };
type CopyablePart = TextPartLike | { type: string };

type CopyableMessage = {
  parts: readonly CopyablePart[];
};

function isTextPartLike(part: CopyablePart): part is TextPartLike {
  return part.type === 'text' && typeof (part as TextPartLike).text === 'string';
}

function isSnapshotProgressText(part: TextPartLike): boolean {
  return part.synthetic === true && part.text.includes('Initializing snapshot');
}

export function collectCopyableText(message: CopyableMessage): string {
  return message.parts
    .filter(isTextPartLike)
    .filter(part => !isSnapshotProgressText(part))
    .map(part => part.text)
    .join('\n\n');
}
