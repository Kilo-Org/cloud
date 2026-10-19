import { z } from 'zod';

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
// Short delay after session_close to let late-arriving data drain before emitting metrics.
const POST_CLOSE_DRAIN_MS = 5 * 1000;

export { INACTIVITY_TIMEOUT_MS, POST_CLOSE_DRAIN_MS };

export type TerminationReason = 'completed' | 'error' | 'interrupted' | 'abandoned' | 'unknown';

export type SessionMetrics = {
  sessionDurationMs: number;
  timeToFirstResponseMs: number | undefined;
  totalTurns: number;
  totalSteps: number;
  toolCallsByType: Record<string, number>;
  toolErrorsByType: Record<string, number>;
  totalErrors: number;
  errorsByType: Record<string, number>;
  stuckToolCallCount: number;
  totalTokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  totalCost: number;
  compactionCount: number;
  autoCompactionCount: number;
  terminationReason: TerminationReason;
  platform: string;
  organizationId: string | undefined;
};

// -- Zod schemas for the subset of CLI types we need for metrics --

const KiloMetaSchema = z.object({
  platform: z.string(),
  orgId: z.string().optional(),
});

const SessionSchema = z.object({
  time: z.object({
    created: z.number(),
    updated: z.number(),
  }),
});

const UserMessageSchema = z.object({
  role: z.literal('user'),
  time: z.object({
    created: z.number(),
  }),
});

const AssistantErrorSchema = z.object({
  name: z.string().min(1),
});

const AssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  time: z.object({
    created: z.number(),
    completed: z.number().optional(),
  }),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({
      read: z.number(),
      write: z.number(),
    }),
  }),
  cost: z.number(),
  error: AssistantErrorSchema.optional(),
});

const ToolStateWithStatusSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'error']),
  input: z.record(z.string(), z.unknown()),
});

const ToolPartSchema = z.object({
  type: z.literal('tool'),
  tool: z.string(),
  state: ToolStateWithStatusSchema,
});

const CompactionPartSchema = z.object({
  type: z.literal('compaction'),
  auto: z.boolean(),
});

const PartTypeSchema = z.object({
  type: z.string(),
});

// -- Core aggregation --

type Accumulator = {
  sessionCreatedAt: number | undefined;
  sessionUpdatedAt: number | undefined;
  firstUserMessageCreatedAt: number | undefined;
  firstAssistantMessageCreatedAt: number | undefined;
  totalTurns: number;
  totalSteps: number;
  toolCallsByType: Record<string, number>;
  toolErrorsByType: Record<string, number>;
  totalErrors: number;
  errorsByType: Record<string, number>;
  toolCallSignatures: Map<string, number>;
  totalTokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  totalCost: number;
  compactionCount: number;
  autoCompactionCount: number;
  platform: string;
  organizationId: string | undefined;
};

function freshAccumulator(): Accumulator {
  return {
    sessionCreatedAt: undefined,
    sessionUpdatedAt: undefined,
    firstUserMessageCreatedAt: undefined,
    firstAssistantMessageCreatedAt: undefined,
    totalTurns: 0,
    totalSteps: 0,
    toolCallsByType: {},
    toolErrorsByType: {},
    totalErrors: 0,
    errorsByType: {},
    toolCallSignatures: new Map(),
    totalTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    totalCost: 0,
    compactionCount: 0,
    autoCompactionCount: 0,
    platform: 'unknown',
    organizationId: undefined,
  };
}

function nonNegative(value: number): number {
  return Math.max(0, value);
}

/**
 * A single assistant message cannot report more than this cost (USD). Far above
 * any real assistant message cost; bounds the running total and the microdollar
 * conversion inside the Postgres bigint range.
 */
export const MAX_ASSISTANT_COST_USD = 1000;

/**
 * Clamp one assistant message's cost contribution to [0, MAX_ASSISTANT_COST_USD].
 * Non-finite or negative costs contribute 0, never an offset against genuine costs.
 * Shared by aggregate metrics, the live running total, and the DO upsert correction
 * so every cost consumer applies the same bound.
 */
export function clampAssistantCostUsd(cost: number): number {
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  return Math.min(cost, MAX_ASSISTANT_COST_USD);
}

/**
 * Convert a clamped USD cost to microdollars. Each message's cost is clamped to
 * MAX_ASSISTANT_COST_USD first, so the conversion stays finite and inside the
 * Postgres bigint range; the returned value is always a non-negative integer.
 */
export function assistantCostUsdToMicrodollars(costUsd: number): number {
  if (!Number.isFinite(costUsd)) return 0;
  return Math.max(0, Math.round(clampAssistantCostUsd(costUsd) * 1_000_000));
}

/**
 * Upper bound for the running cost total in microdollars. MAX_SAFE_INTEGER
 * microdollars is far inside the Postgres bigint range, so a bounded total can
 * never fail the write with an out-of-range value.
 */
export const MAX_RUNNING_COST_MICRODOLLARS = Number.MAX_SAFE_INTEGER;

/**
 * Cap the running cost total so repeated clamped contributions cannot overflow.
 */
export function capRunningCostMicrodollars(totalMicrodollars: number): number {
  return Math.min(Math.max(0, totalMicrodollars), MAX_RUNNING_COST_MICRODOLLARS);
}

/**
 * A stored assistant message's clamped cost contribution in microdollars, read
 * from its item_data. Returns 0 for malformed, non-assistant, or R2-offloaded
 * rows ('{}'), matching computeSessionMetrics' per-message handling.
 */
export function assistantMessageCostMicrodollars(itemData: string): number {
  let raw: unknown;
  try {
    raw = JSON.parse(itemData);
  } catch {
    return 0;
  }
  const parsed = AssistantMessageSchema.safeParse(raw);
  if (!parsed.success) return 0;
  return assistantCostUsdToMicrodollars(parsed.data.cost);
}

function processKiloMeta(acc: Accumulator, raw: unknown) {
  const parsed = KiloMetaSchema.safeParse(raw);
  if (!parsed.success) return;
  if (parsed.data.platform) acc.platform = parsed.data.platform;
  if (parsed.data.orgId) acc.organizationId = parsed.data.orgId;
}

function processSession(acc: Accumulator, raw: unknown) {
  const parsed = SessionSchema.safeParse(raw);
  if (!parsed.success) return;
  acc.sessionCreatedAt = parsed.data.time.created;
  acc.sessionUpdatedAt = parsed.data.time.updated;
}

function processMessage(acc: Accumulator, raw: unknown) {
  {
    const parsed = UserMessageSchema.safeParse(raw);
    if (parsed.success) {
      acc.totalTurns++;
      const t = parsed.data.time.created;
      if (acc.firstUserMessageCreatedAt === undefined || t < acc.firstUserMessageCreatedAt) {
        acc.firstUserMessageCreatedAt = t;
      }
      return;
    }
  }
  {
    const parsed = AssistantMessageSchema.safeParse(raw);
    if (parsed.success) {
      const msg = parsed.data;
      const t = msg.time.created;
      if (
        acc.firstAssistantMessageCreatedAt === undefined ||
        t < acc.firstAssistantMessageCreatedAt
      ) {
        acc.firstAssistantMessageCreatedAt = t;
      }

      acc.totalTokens.input += nonNegative(msg.tokens.input);
      acc.totalTokens.output += nonNegative(msg.tokens.output);
      acc.totalTokens.reasoning += nonNegative(msg.tokens.reasoning);
      acc.totalTokens.cacheRead += nonNegative(msg.tokens.cache.read);
      acc.totalTokens.cacheWrite += nonNegative(msg.tokens.cache.write);
      acc.totalCost += clampAssistantCostUsd(msg.cost);

      if (msg.error) {
        acc.totalErrors++;
        acc.errorsByType[msg.error.name] = (acc.errorsByType[msg.error.name] ?? 0) + 1;
      }
    }
  }
}

function processPart(acc: Accumulator, raw: unknown) {
  // Determine part type first
  const typeResult = PartTypeSchema.safeParse(raw);
  if (!typeResult.success) return;

  switch (typeResult.data.type) {
    case 'step-finish': {
      acc.totalSteps++;
      break;
    }
    case 'tool': {
      const parsed = ToolPartSchema.safeParse(raw);
      if (!parsed.success) break;
      const { tool, state } = parsed.data;

      acc.toolCallsByType[tool] = (acc.toolCallsByType[tool] ?? 0) + 1;

      if (state.status === 'error') {
        acc.toolErrorsByType[tool] = (acc.toolErrorsByType[tool] ?? 0) + 1;
        acc.totalErrors++;
      }

      if (state.status === 'completed' || state.status === 'error') {
        const sig = `${tool}:${JSON.stringify(state.input)}`;
        acc.toolCallSignatures.set(sig, (acc.toolCallSignatures.get(sig) ?? 0) + 1);
      }
      break;
    }
    case 'compaction': {
      const parsed = CompactionPartSchema.safeParse(raw);
      if (!parsed.success) break;
      acc.compactionCount++;
      if (parsed.data.auto) acc.autoCompactionCount++;
      break;
    }
  }
}

/**
 * Compute aggregate session metrics from all ingested items.
 * Each row's item_data is parsed with Zod — malformed rows are silently skipped.
 */
export function computeSessionMetrics(
  items: Array<{ item_type: string; item_data: string }>,
  closeReason: TerminationReason
): SessionMetrics {
  const acc = freshAccumulator();

  for (const row of items) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.item_data);
    } catch {
      continue;
    }

    switch (row.item_type) {
      case 'kilo_meta':
        processKiloMeta(acc, raw);
        break;
      case 'session':
        processSession(acc, raw);
        break;
      case 'message':
        processMessage(acc, raw);
        break;
      case 'part':
        processPart(acc, raw);
        break;
    }
  }

  let stuckToolCallCount = 0;
  for (const count of acc.toolCallSignatures.values()) {
    if (count >= 3) stuckToolCallCount += count;
  }

  let sessionDurationMs = 0;
  if (acc.sessionCreatedAt !== undefined && acc.sessionUpdatedAt !== undefined) {
    sessionDurationMs = Math.max(0, acc.sessionUpdatedAt - acc.sessionCreatedAt);
  }

  let timeToFirstResponseMs: number | undefined;
  if (
    acc.firstUserMessageCreatedAt !== undefined &&
    acc.firstAssistantMessageCreatedAt !== undefined
  ) {
    timeToFirstResponseMs = Math.max(
      0,
      acc.firstAssistantMessageCreatedAt - acc.firstUserMessageCreatedAt
    );
  }

  return {
    sessionDurationMs,
    timeToFirstResponseMs,
    totalTurns: acc.totalTurns,
    totalSteps: acc.totalSteps,
    toolCallsByType: acc.toolCallsByType,
    toolErrorsByType: acc.toolErrorsByType,
    totalErrors: acc.totalErrors,
    errorsByType: acc.errorsByType,
    stuckToolCallCount,
    totalTokens: {
      input: nonNegative(acc.totalTokens.input),
      output: nonNegative(acc.totalTokens.output),
      reasoning: nonNegative(acc.totalTokens.reasoning),
      cacheRead: nonNegative(acc.totalTokens.cacheRead),
      cacheWrite: nonNegative(acc.totalTokens.cacheWrite),
    },
    totalCost: nonNegative(acc.totalCost),
    compactionCount: acc.compactionCount,
    autoCompactionCount: acc.autoCompactionCount,
    terminationReason: closeReason,
    platform: acc.platform,
    organizationId: acc.organizationId,
  };
}

const ACTIVITY_PERSIST_THROTTLE_MS = 15_000;
export const COST_PERSIST_THROTTLE_MS = 30_000;

export type DecideLivePersistArgs = {
  nowMs: number;
  wroteActivityItem: boolean;
  wroteAssistantMessageItem: boolean;
  idleTransition: boolean;
  /** Candidate activity value (request ingestedAt ?? Date.now()). */
  lastActivityValueMs: number;
  lastActivityPersistedAtMs: number | null;
  lastActivityPersistedValueMs: number | null;
  /** null = not computed this batch (no message upsert, no idle). */
  currentCostMicrodollars: number | null;
  lastCostPersistedAtMs: number | null;
  lastCostPersistedMicrodollars: number | null;
};

/**
 * Pure throttle / monotonic guards for live activity + cost Postgres persists.
 * idleTransition forces a cost persist regardless of the 30s window and message flag.
 */
export function decideLivePersist(args: DecideLivePersistArgs): {
  persistActivity: boolean;
  persistCost: boolean;
} {
  const activityNewer =
    args.lastActivityPersistedValueMs === null ||
    args.lastActivityValueMs > args.lastActivityPersistedValueMs;
  const activityThrottleOk =
    args.lastActivityPersistedAtMs === null ||
    args.nowMs - args.lastActivityPersistedAtMs >= ACTIVITY_PERSIST_THROTTLE_MS;
  const persistActivity = args.wroteActivityItem && activityNewer && activityThrottleOk;

  // Monotonic: only open the gate when cost strictly increased (matches SQL CASE).
  // null last → treat as -1 so any cost ≥ 0 (including 0) can persist once.
  let persistCost = false;
  if (
    args.currentCostMicrodollars !== null &&
    args.currentCostMicrodollars > (args.lastCostPersistedMicrodollars ?? -1)
  ) {
    if (args.idleTransition) {
      persistCost = true;
    } else if (args.wroteAssistantMessageItem) {
      const costThrottleOk =
        args.lastCostPersistedAtMs === null ||
        args.nowMs - args.lastCostPersistedAtMs >= COST_PERSIST_THROTTLE_MS;
      persistCost = costThrottleOk;
    }
  }

  return { persistActivity, persistCost };
}
