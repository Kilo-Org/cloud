const leakedBlocks = [
  { start: '<function_calls>', end: '</function_calls>' },
  { start: '<function_result>', end: '</function_result>' },
  { start: '<function_return>', end: '</function_return>' },
  { start: '<function_returns>', end: '</function_returns>' },
] as const;

const orphanClosingTags = [
  '</function_calls>',
  '</function_result>',
  '</function_return>',
  '</function_returns>',
  '</parameter>',
  '</invoke>',
] as const;

function nextLeakedBlock(
  text: string,
  cursor: number
): { startIndex: number; endTag: string } | null {
  let next: { startIndex: number; endTag: string } | null = null;
  for (const block of leakedBlocks) {
    const startIndex = text.indexOf(block.start, cursor);
    if (startIndex === -1) continue;
    if (!next || startIndex < next.startIndex) next = { startIndex, endTag: block.end };
  }
  return next;
}

function stripOrphanClosingTags(text: string): string {
  return orphanClosingTags.reduce((current, tag) => current.replaceAll(tag, ''), text);
}

export function stripLeakedToolMarkup(text: string): string {
  let output = '';
  let cursor = 0;

  while (cursor < text.length) {
    const block = nextLeakedBlock(text, cursor);
    if (!block) {
      output += text.slice(cursor);
      break;
    }

    output += text.slice(cursor, block.startIndex);
    const endIndex = text.indexOf(block.endTag, block.startIndex);
    if (endIndex === -1) break;
    cursor = endIndex + block.endTag.length;
  }

  return stripOrphanClosingTags(output)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
