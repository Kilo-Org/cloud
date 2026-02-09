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

      acc.totalTokens.input += msg.tokens.input;
      acc.totalTokens.output += msg.tokens.output;
      acc.totalTokens.reasoning += msg.tokens.reasoning;
      acc.totalTokens.cacheRead += msg.tokens.cache.read;
      acc.totalTokens.cacheWrite += msg.tokens.cache.write;
      acc.totalCost += msg.cost;

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
    totalTokens: acc.totalTokens,
    totalCost: acc.totalCost,
    compactionCount: acc.compactionCount,
    autoCompactionCount: acc.autoCompactionCount,
    terminationReason: closeReason,
    platform: acc.platform,
    organizationId: acc.organizationId,
  };
}
