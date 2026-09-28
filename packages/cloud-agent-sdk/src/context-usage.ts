export type ContextUsage = {
  contextTokens: number;
  providerID: string;
  modelID: string;
};

type AssistantContextUsageResult =
  | { status: 'ineligible' }
  | { status: 'malformed' }
  /** A finished compaction summary: the boundary past which no older message
   *  may supply the reading. */
  | { status: 'compaction-boundary' }
  | { status: 'usage'; contextUsage: ContextUsage };

/**
 * True when the message carries an error. An absent optional can arrive as an
 * explicit `null` (for example after a JSON round trip), which is not an error.
 */
function hasError(info: Record<string, unknown>): boolean {
  return info['error'] !== undefined && info['error'] !== null;
}

/**
 * The compaction summary an assistant message carries (`summary === true`),
 * once it has finished without error. A summary still streaming (`finish`
 * unset) or one that failed is *not* a boundary: until the compaction
 * completes, the pre-compaction context is still the session's context.
 */
function isCompletedCompactionSummary(info: Record<string, unknown>): boolean {
  if (info['summary'] !== true) return false;
  return Boolean(info['finish']) && !hasError(info);
}

/**
 * A compaction summary that finished with an error. The compaction left the
 * session's context unchanged, so its request's compaction part must not end
 * the walk: the pre-compaction reading is still the session's context.
 */
function isFailedCompactionSummary(info: unknown): boolean {
  return (
    isRecord(info) && info['role'] === 'assistant' && info['summary'] === true && hasError(info)
  );
}

/**
 * The compaction marker part the CLI writes onto the `/compact` request's user
 * message when the compaction starts. The transcript renders `Context
 * compacted` from exactly this part, so its arrival is user-visible proof the
 * pre-compaction transcript was superseded — even if the summary message's own
 * events (streamed separately) never land.
 */
function isCompactionPart(part: unknown): boolean {
  return isRecord(part) && part['type'] === 'compaction';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function getAssistantContextUsage(info: unknown): AssistantContextUsageResult {
  if (!isRecord(info) || info['role'] !== 'assistant') return { status: 'ineligible' };
  // A finished compaction summary is a boundary even when its own tokens are
  // unusable (the chunked compaction path leaves them at zero).
  if (isCompletedCompactionSummary(info)) return { status: 'compaction-boundary' };
  // A compaction that is still running (no `finish`) or that failed is not a
  // reading and not a boundary: the pre-compaction context is still in force.
  if (info['summary'] === true) return { status: 'ineligible' };
  if (!isRecord(info['tokens'])) return { status: 'malformed' };

  const { input, output, reasoning, cache } = info['tokens'];
  if (!isFiniteNonNegativeNumber(output)) return { status: 'malformed' };
  if (output === 0) return { status: 'ineligible' };
  if (typeof info['providerID'] !== 'string' || typeof info['modelID'] !== 'string') {
    return { status: 'malformed' };
  }
  if (!isFiniteNonNegativeNumber(input)) return { status: 'malformed' };
  if (!isFiniteNonNegativeNumber(reasoning)) return { status: 'malformed' };
  if (!isRecord(cache)) return { status: 'malformed' };
  if (!isFiniteNonNegativeNumber(cache['read']) || !isFiniteNonNegativeNumber(cache['write'])) {
    return { status: 'malformed' };
  }

  const contextTokens = input + output + reasoning + cache['read'] + cache['write'];
  if (!Number.isFinite(contextTokens)) return { status: 'malformed' };

  return {
    status: 'usage',
    contextUsage: {
      contextTokens,
      providerID: info['providerID'],
      modelID: info['modelID'],
    },
  };
}

/**
 * The newest context-usage report that belongs to the session's current
 * context, walking messages newest-first.
 *
 * A compaction is a boundary: after `/compact` the session's context is the
 * compacted conversation, so no assistant message older than the newest
 * compaction can describe it. The walk stops at either marker of a compaction
 * — the request's compaction part (which the transcript renders as "Context
 * compacted", and which can arrive while the summary message's own events are
 * still missing) or the completed summary message — and reports "unknown"
 * until a newer message reports the compacted context. That is what keeps the
 * indicator from falling back to the pre-compaction figure: the summary
 * message itself is never treated as a reading (its token buckets belong to
 * the compaction request, and the chunked path leaves them at zero), and
 * everything before the boundary is out of the session's current context.
 *
 * A failed compaction is not a boundary: the context it tried to compact is
 * still in force, so the reading before it stays valid.
 */
export function findLatestContextUsage(
  messages: readonly { info: unknown; parts?: readonly unknown[] }[]
): ContextUsage | undefined {
  // Set while walking backwards when a newer compaction summary reports a
  // failure: that request's part must not become a boundary.
  let failedCompaction = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;

    if (message.parts?.some(isCompactionPart)) {
      // The `/compact` request's own marker. It supersedes everything older
      // only while that compaction is still in flight.
      if (failedCompaction) {
        failedCompaction = false;
        continue;
      }
      return undefined;
    }

    if (isFailedCompactionSummary(message.info)) {
      failedCompaction = true;
      continue;
    }

    const result = getAssistantContextUsage(message.info);
    if (result.status === 'malformed') return undefined;
    if (result.status === 'compaction-boundary') return undefined;
    if (result.status === 'usage') return result.contextUsage;
  }

  return undefined;
}

export function calculateContextUsagePercentage(
  contextTokens: number,
  contextWindow: number | undefined
): number | undefined {
  if (!isFiniteNonNegativeNumber(contextTokens)) return undefined;
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }

  const percentage = Math.round((contextTokens / contextWindow) * 100);
  return Number.isFinite(percentage) ? percentage : undefined;
}
