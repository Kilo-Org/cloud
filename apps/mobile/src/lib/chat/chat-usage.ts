import { type ModelUsage, zeroUsage } from '@kilocode/harness-sdk';
import { z } from 'zod';

import { chatTargetKind } from './backend-target';

/**
 * What a chat has used, per model it was answered by.
 *
 * The SDK counts what one session used, in memory, from zero each time the
 * session opens — and a chat is a different session after every model switch.
 * So the app keeps the chat's own count beside the chat, and adds to it what
 * each session reports. It is kept per model because a price is per model.
 */
export type ChatUsage = Readonly<Record<string, ModelUsage>>;

const count = z.number().nonnegative();

/** A column this app owns, but one an older build or a crash can leave holding anything. */
const storedSchema = z.record(
  z.string(),
  z.object({
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
    cost: count.optional(),
  })
);

export function parseChatUsage(stored: string | null): ChatUsage {
  if (stored === null) {
    return {};
  }
  try {
    const parsed = storedSchema.safeParse(JSON.parse(stored));
    if (!parsed.success) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed.data).map(([model, { cost, ...tokens }]) => [
        model,
        cost === undefined ? tokens : { ...tokens, cost },
      ])
    );
  } catch {
    return {};
  }
}

const costOf = (held: number | undefined, part: number | undefined) =>
  held === undefined && part === undefined ? {} : { cost: (held ?? 0) + (part ?? 0) };

function sumUsage(held: ModelUsage, part: ModelUsage): ModelUsage {
  return {
    inputTokens: held.inputTokens + part.inputTokens,
    outputTokens: held.outputTokens + part.outputTokens,
    cacheReadTokens: held.cacheReadTokens + part.cacheReadTokens,
    cacheWriteTokens: held.cacheWriteTokens + part.cacheWriteTokens,
    ...costOf(held.cost, part.cost),
  };
}

/**
 * What a session used since it was last read: its total now, less the total
 * already counted. The SDK's total includes the summary calls a full window
 * makes, which no answer stream reports, so a count read this way misses none.
 */
export function usageSince(now: ModelUsage, counted: ModelUsage): ModelUsage {
  return {
    inputTokens: now.inputTokens - counted.inputTokens,
    outputTokens: now.outputTokens - counted.outputTokens,
    cacheReadTokens: now.cacheReadTokens - counted.cacheReadTokens,
    cacheWriteTokens: now.cacheWriteTokens - counted.cacheWriteTokens,
    ...(now.cost === undefined ? {} : { cost: now.cost - (counted.cost ?? 0) }),
  };
}

export function countUsage(usage: ChatUsage, model: string, part: ModelUsage) {
  return { ...usage, [model]: sumUsage(usage[model] ?? zeroUsage, part) } satisfies ChatUsage;
}

export function countSessionUsage({
  usage,
  requested,
  totals,
  counted,
}: {
  usage: ChatUsage;
  requested: string;
  totals: ReadonlyMap<string, ModelUsage>;
  counted: ReadonlyMap<string, ModelUsage>;
}): ChatUsage {
  let next = usage;
  for (const [served, total] of totals) {
    const spent = usageSince(total, counted.get(served) ?? zeroUsage);
    if (
      !counted.has(served) ||
      spent.inputTokens !== 0 ||
      spent.outputTokens !== 0 ||
      spent.cacheReadTokens !== 0 ||
      spent.cacheWriteTokens !== 0 ||
      (spent.cost ?? 0) !== 0
    ) {
      const kind = chatTargetKind(requested);
      let model = requested;
      if (kind === 'kilo') {
        model = served;
      } else if (kind === 'custom' && served !== requested) {
        model = requested.slice(0, requested.lastIndexOf(':') + 1) + encodeURIComponent(served);
      }
      next = countUsage(next, model, spent);
    }
  }
  return next;
}

export function totalUsage(usage: ChatUsage): ModelUsage {
  let total = zeroUsage;
  for (const used of Object.values(usage)) {
    total = sumUsage(total, used);
  }
  return total;
}
