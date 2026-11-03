export function isClaudeModel(requestedModel: string) {
  return requestedModel.includes('claude');
}

/**
 * Matches `claude-opus-5.5`, `claude-opus-5-5@20261005`, and `claude-haiku-4-5-20251001-v1:0`.
 * A minor version has at most two digits, so a date suffix is not read as one.
 */
const CLAUDE_VERSION = /claude-[a-z]+-(\d+)(?:[.-](\d{1,2})(?!\d))?/;

export function getClaudeVersion(model: string): { major: number; minor: number } | null {
  const match = CLAUDE_VERSION.exec(model);
  if (!match) return null;
  const [, major, minor = '0'] = match;
  return { major: Number(major), minor: Number(minor) };
}
