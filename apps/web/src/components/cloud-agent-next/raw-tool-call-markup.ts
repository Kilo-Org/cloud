const RAW_FUNCTION_CALL_START = '<function_calls>';
const RAW_FUNCTION_CALL_END = '</function_calls>';

export function stripRawToolCallMarkup(text: string): string {
  let output = '';
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf(RAW_FUNCTION_CALL_START, cursor);
    if (start === -1) {
      output += text.slice(cursor);
      break;
    }

    const lineStart = text.lastIndexOf('\n', start) + 1;
    output += text.slice(cursor, lineStart);

    const end = text.indexOf(RAW_FUNCTION_CALL_END, start + RAW_FUNCTION_CALL_START.length);
    if (end === -1) break;

    const afterEnd = end + RAW_FUNCTION_CALL_END.length;
    const nextLine = text.indexOf('\n', afterEnd);
    cursor = nextLine === -1 ? text.length : nextLine + 1;
  }

  return output
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
