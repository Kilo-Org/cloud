import { parseParam, parsePositiveIntParam } from '@/lib/route-params';

type RawComposerParams = {
  owner?: string | string[] | undefined;
  repo?: string | string[] | undefined;
  number?: string | string[] | undefined;
  path?: string | string[] | undefined;
  side?: string | string[] | undefined;
  line?: string | string[] | undefined;
  startLine?: string | string[] | undefined;
  /** Optional pending-queue item id when the composer opens in edit mode. */
  pendingId?: string | string[] | undefined;
};

type ParsedComposerParams = {
  owner: string;
  repo: string;
  number: number;
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  startLine?: number;
  /** Present only when the route was opened to edit a queued comment. */
  pendingId?: string;
};

/**
 * Runtime-validates the comment-composer route params before the screen
 * queries or renders the composer. Returns `null` for any invalid
 * combination (missing owner/repo/number, empty path, invalid side,
 * non-positive or partially numeric line or startLine, or startLine greater
 * than line). The numeric params go through `parsePositiveIntParam` so a
 * segment like `1.5` or `12abc` is rejected rather than silently truncated to
 * a line the user never selected.
 */
export function parseComposerParams(raw: RawComposerParams): ParsedComposerParams | null {
  const owner = parseParam(raw.owner);
  const repo = parseParam(raw.repo);
  const number = parsePositiveIntParam(raw.number);
  const path = parseParam(raw.path);
  const side = parseParam(raw.side, ['LEFT', 'RIGHT'] as const);
  const line = parsePositiveIntParam(raw.line);
  const startLine = parsePositiveIntParam(raw.startLine);
  const hasStartLine = parseParam(raw.startLine) !== null;
  // Optional edit-mode id: absent → undefined; present non-empty string
  // passes through. Empty/array values are treated as absent (not a hard
  // reject) so create-mode deep links stay tolerant.
  const pendingId = parseParam(raw.pendingId);

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
    ...(pendingId !== null ? { pendingId } : {}),
  };
}
