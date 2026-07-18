import { parseParam } from '@/lib/route-params';

type RawComposerParams = {
  owner?: string | string[] | undefined;
  repo?: string | string[] | undefined;
  number?: string | string[] | undefined;
  path?: string | string[] | undefined;
  side?: string | string[] | undefined;
  line?: string | string[] | undefined;
  startLine?: string | string[] | undefined;
};

type ParsedComposerParams = {
  owner: string;
  repo: string;
  number: number;
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  startLine?: number;
};

function parsePositiveInt(value: string | string[] | undefined): number | null {
  const text = parseParam(value);
  if (!text) {
    return null;
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

/**
 * Runtime-validates the comment-composer route params before the screen
 * queries or renders the composer. Returns `null` for any invalid
 * combination (missing owner/repo/number, empty path, invalid side,
 * non-positive line, or startLine greater than line).
 */
export function parseComposerParams(raw: RawComposerParams): ParsedComposerParams | null {
  const owner = parseParam(raw.owner);
  const repo = parseParam(raw.repo);
  const number = parsePositiveInt(raw.number);
  const path = parseParam(raw.path);
  const side = parseParam(raw.side, ['LEFT', 'RIGHT'] as const);
  const line = parsePositiveInt(raw.line);
  const startLine = parsePositiveInt(raw.startLine);
  const hasStartLine = parseParam(raw.startLine) !== null;

  if (!owner || !repo || !number || !path || !side || !line) {
    return null;
  }

  if (hasStartLine && startLine === null) {
    return null;
  }

  if (startLine !== null && startLine > line) {
    return null;
  }

  return {
    owner,
    repo,
    number,
    path,
    side,
    line,
    ...(startLine !== null ? { startLine } : {}),
  };
}
