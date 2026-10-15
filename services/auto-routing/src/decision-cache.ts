import {
  BenchmarkPairSchema,
  ClassifierOutputSchema,
  DEFAULT_AUTO_ROUTER,
  type AutoRouter,
  type ClassifierOutput,
} from '@kilocode/auto-routing-contracts';
import { UsageRecordRequestSchema, type UsageRecordRequest } from '@kilocode/usage-contracts';
import { USAGE_WRITER_TIMEOUT_MS } from '@kilocode/worker-utils/usage-writer-client';
import { DurableObject } from 'cloudflare:workers';
import * as z from 'zod';
import { writeClassifierUsage } from './classifier-usage';

const CLASSIFICATION_HOT_CACHE_LIMIT = 5000;
const ENTRY_TTL_MS = 30 * 60 * 1000;
const USAGE_RETRY_BASE_MS = 1000;
const USAGE_RETRY_MAX_MS = 15 * 60 * 1000;
const USAGE_RETRY_RETENTION_MS = 24 * 60 * 60 * 1000;
const USAGE_PREFIX = 'usage:';

const UsageRetryEntrySchema = z.object({
  usage: UsageRecordRequestSchema,
  attempts: z.number().int().nonnegative(),
  firstAttemptAt: z.number().finite(),
  nextAttemptAt: z.number().finite(),
});
type UsageRetryEntry = z.infer<typeof UsageRetryEntrySchema>;
// Cloudflare caps storage.delete() at 128 keys per call.
const DELETE_BATCH_SIZE = 128;

// Workers RPC maps non-serializable method types to never, so use a concrete
// union rather than unknown. Persisted values are still validated on read.
type StoredValue = ClassifierOutput | StickyDecision;

type StoredEntry = {
  value: StoredValue;
  storedAt: number;
  stickyGeneration?: number;
};

type StoredConversationState = {
  classification: StoredEntry | null;
  sticky: StoredValue | null;
};

const STICKY_DECISION_KEY = 'sticky';

const classificationHotCache = new Map<string, { value: ClassifierOutput; storedAt: number }>();

function cacheClassification(key: string, value: ClassifierOutput, storedAt: number): void {
  classificationHotCache.delete(key);
  classificationHotCache.set(key, { value, storedAt });
  if (classificationHotCache.size > CLASSIFICATION_HOT_CACHE_LIMIT) {
    const oldestKey = classificationHotCache.keys().next().value;
    if (oldestKey !== undefined) classificationHotCache.delete(oldestKey);
  }
}

export function clearClassificationHotCache(): void {
  classificationHotCache.clear();
}

export class AutoRoutingDecisionCacheDO extends DurableObject<Env> {
  async readConversationState(classificationKey: string): Promise<StoredConversationState> {
    const entries = await this.ctx.storage.get<StoredEntry>([
      classificationKey,
      STICKY_DECISION_KEY,
    ]);
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (now - entry.storedAt >= ENTRY_TTL_MS) entries.delete(key);
    }
    return {
      classification: entries.get(classificationKey) ?? null,
      sticky: entries.get(STICKY_DECISION_KEY)?.value ?? null,
    };
  }

  async recordClassifierUsage(input: UsageRecordRequest): Promise<void> {
    const usage = UsageRecordRequestSchema.parse(input);
    const key = `${USAGE_PREFIX}${usage.core.id}`;
    if (await this.ctx.storage.get(key)) return;
    const now = Date.now();
    const entry: UsageRetryEntry = {
      usage,
      attempts: 0,
      firstAttemptAt: now,
      nextAttemptAt: now + USAGE_WRITER_TIMEOUT_MS,
    };
    await this.ctx.storage.put(key, entry);
    await this.scheduleAlarm(entry.nextAttemptAt);
    await this.attemptUsage(key, entry);
  }

  private async attemptUsage(key: string, entry: UsageRetryEntry): Promise<void> {
    const outcome = await writeClassifierUsage(this.env, entry.usage);
    if (outcome.kind !== 'unavailable') {
      await this.ctx.storage.delete(key);
      return;
    }
    const now = Date.now();
    const attempts = entry.attempts + 1;
    if (now - entry.firstAttemptAt >= USAGE_RETRY_RETENTION_MS) {
      console.error(
        JSON.stringify({
          event: 'auto_routing_classifier_usage_dropped',
          usageId: entry.usage.core.id,
          attempts,
          reason: outcome.reason,
        })
      );
      await this.ctx.storage.delete(key);
      return;
    }
    const nextAttemptAt = Math.min(
      now + Math.min(USAGE_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 20), USAGE_RETRY_MAX_MS),
      entry.firstAttemptAt + USAGE_RETRY_RETENTION_MS
    );
    await this.ctx.storage.put(key, {
      ...entry,
      attempts,
      nextAttemptAt,
    } satisfies UsageRetryEntry);
    await this.scheduleAlarm(nextAttemptAt);
  }

  private async scheduleAlarm(time: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm <= Date.now() || time < alarm) {
      await this.ctx.storage.setAlarm(time);
    }
  }

  async putStickyDecision(value: StickyDecision, generation: number): Promise<void> {
    const current = await this.ctx.storage.get<StoredEntry>(STICKY_DECISION_KEY);
    if (generation < (current?.stickyGeneration ?? 0)) return;
    await this.ctx.storage.put(STICKY_DECISION_KEY, {
      value,
      storedAt: Date.now(),
      stickyGeneration: generation,
    } satisfies StoredEntry);
    await this.scheduleAlarm(Date.now() + ENTRY_TTL_MS);
  }

  async putEntry(key: string, value: StoredValue): Promise<void> {
    await this.ctx.storage.put(key, { value, storedAt: Date.now() } satisfies StoredEntry);
    await this.scheduleAlarm(Date.now() + ENTRY_TTL_MS);
  }

  async alarm(): Promise<void> {
    const entries = await this.ctx.storage.list<StoredEntry | UsageRetryEntry>();
    const now = Date.now();
    const expiredKeys: string[] = [];
    for (const [key, entry] of entries) {
      if (
        !key.startsWith(USAGE_PREFIX) &&
        'storedAt' in entry &&
        now - entry.storedAt >= ENTRY_TTL_MS
      ) {
        expiredKeys.push(key);
      }
    }
    for (let start = 0; start < expiredKeys.length; start += DELETE_BATCH_SIZE) {
      await this.ctx.storage.delete(expiredKeys.slice(start, start + DELETE_BATCH_SIZE));
    }
    for (const [key, entry] of entries) {
      if (!key.startsWith(USAGE_PREFIX)) continue;
      const retry = UsageRetryEntrySchema.parse(entry);
      if (retry.nextAttemptAt <= now) {
        await this.ctx.storage.put(key, {
          ...retry,
          nextAttemptAt: now + USAGE_WRITER_TIMEOUT_MS,
        } satisfies UsageRetryEntry);
        await this.attemptUsage(key, retry);
      }
    }
    const remaining = await this.ctx.storage.list<StoredEntry | UsageRetryEntry>();
    let nextAlarm = Infinity;
    for (const [key, entry] of remaining) {
      if (key.startsWith(USAGE_PREFIX)) {
        nextAlarm = Math.min(nextAlarm, UsageRetryEntrySchema.parse(entry).nextAttemptAt);
      } else if ('storedAt' in entry) {
        nextAlarm = Math.min(nextAlarm, entry.storedAt + ENTRY_TTL_MS);
      }
    }
    if (Number.isFinite(nextAlarm)) await this.ctx.storage.setAlarm(nextAlarm);
  }
}

type DecisionCacheEnv = Pick<Env, 'AUTO_ROUTING_DECISION_CACHE'>;

function cacheStub(env: DecisionCacheEnv, conversationKey: string, router: AutoRouter) {
  const namespace = env.AUTO_ROUTING_DECISION_CACHE;
  return namespace.get(namespace.idFromName(`${router}:${conversationKey}`));
}

function entryKey(contentHash: string, classifierModel: string, router: AutoRouter): string {
  return `${router}:${classifierModel}:${contentHash}`;
}

export function getHotCachedClassification(
  exactHash: string,
  classifierModel: string,
  router: AutoRouter = DEFAULT_AUTO_ROUTER
): ClassifierOutput | null {
  const key = entryKey(exactHash, classifierModel, router);
  const entry = classificationHotCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > ENTRY_TTL_MS) {
    classificationHotCache.delete(key);
    return null;
  }
  return entry.value;
}

const StickyDecisionSchema = BenchmarkPairSchema.extend({
  // Taxonomy route the model was decided on, for route-change telemetry.
  // Nullable/defaulted so entries written before the field existed parse.
  routeKey: z.string().min(1).nullish().default(null),
  // Exact catalog variant the model was decided with. Null for legacy
  // model-only sticky records and for candidates without a variant.
  variant: z.string().min(1).nullish().default(null),
});
export type StickyDecision = z.infer<typeof StickyDecisionSchema>;

export type ConversationState = {
  classification: ClassifierOutput | null;
  sticky: StickyDecision | null;
};

export async function readConversationState(
  env: DecisionCacheEnv,
  conversationKey: string,
  exactHash: string,
  classifierModel: string,
  router: AutoRouter = DEFAULT_AUTO_ROUTER
): Promise<ConversationState> {
  try {
    const key = entryKey(exactHash, classifierModel, router);
    const state = await cacheStub(env, conversationKey, router).readConversationState(key);
    let classification = getHotCachedClassification(exactHash, classifierModel, router);
    if (!classification) {
      const parsed = ClassifierOutputSchema.safeParse(state.classification?.value);
      if (parsed.success && state.classification) {
        classification = parsed.data;
        cacheClassification(key, classification, state.classification.storedAt);
      }
    }
    const sticky = StickyDecisionSchema.safeParse(state.sticky);
    return {
      classification,
      sticky: sticky.success ? sticky.data : null,
    };
  } catch {
    return { classification: null, sticky: null };
  }
}

export async function putStickyDecision(
  env: DecisionCacheEnv,
  conversationKey: string,
  model: string,
  variant: string | null,
  routeKey: string,
  generation: number,
  router: AutoRouter = DEFAULT_AUTO_ROUTER
): Promise<void> {
  try {
    await cacheStub(env, conversationKey, router).putStickyDecision(
      { model, variant, routeKey } satisfies StickyDecision,
      generation
    );
  } catch {
    // Sticky writes are best effort and must not fail the decision.
  }
}

export async function putCachedClassification(
  env: DecisionCacheEnv,
  conversationKey: string,
  contentHash: string,
  classifierModel: string,
  classification: ClassifierOutput,
  router: AutoRouter = DEFAULT_AUTO_ROUTER
): Promise<void> {
  try {
    const key = entryKey(contentHash, classifierModel, router);
    const storedAt = Date.now();
    await cacheStub(env, conversationKey, router).putEntry(key, classification);
    cacheClassification(key, classification, storedAt);
  } catch {
    // Cache writes are best effort and must not fail the decision.
  }
}
