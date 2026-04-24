export function extractBriefingArgsFromText(input: string): string | null {
  const text = input.trim();
  if (!text) {
    return null;
  }

  const match = text.match(/\/briefing(?:\s+([^\n\r]*))?/i);
  if (!match) {
    return null;
  }

  const args = typeof match[1] === 'string' ? match[1].trim() : '';
  return args;
}
