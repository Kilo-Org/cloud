import { ClassifierOutputSchema, type ClassifierOutput } from '@kilocode/auto-routing-contracts';
import { DurableObject } from 'cloudflare:workers';
import * as z from 'zod';

const CLASSIFICATION_HOT_CACHE_LIMIT = 5000;
const ENTRY_TTL_MS = 30 * 60 * 1000;
const PENDING_COST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Cloudflare caps storage.delete() at 128 keys per call.
const DELETE_BATCH_SIZE = 128;

// Workers RPC maps non-serializable method types to never, so use a concrete
// union rather than unknown. Persisted values are still validated on read.
type StoredValue = ClassifierOutput | StickyDecision | number;

type StoredEntry = {
  value: StoredValue;
  storedAt: number;
  stickyGeneration?: number;
};

type StoredConversationState = {
  classification: StoredEntry | null;
  sticky: StoredValue | null;
  pendingCostUsd: StoredValue | null;
};

const STICKY_DECISION_KEY = 'sticky';
const PENDING_COST_KEY = 'pending-cost';
const PendingCostSchema = z.number().finite().nonnegative();

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
  async readConversationState(
    classificationKey: string,
    consumePendingCost: boolean
  ): Promise<StoredConversationState> {
    const entries = await this.ctx.storage.get<StoredEntry>([
      classificationKey,
      STICKY_DECISION_KEY,
      PENDING_COST_KEY,
    ]);
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (
        now - entry.storedAt >
        (key === PENDING_COST_KEY ? PENDING_COST_RETENTION_MS : ENTRY_TTL_MS)
      ) {
        entries.delete(key);
      }
    }
    const pendingCost = entries.get(PENDING_COST_KEY);
    if (consumePendingCost && pendingCost) await this.ctx.storage.delete(PENDING_COST_KEY);
    return {
      classification: entries.get(classificationKey) ?? null,
      sticky: entries.get(STICKY_DECISION_KEY)?.value ?? null,
      pendingCostUsd: pendingCost?.value ?? null,
    };
  }

  async addPendingClassifierCost(usd: number): Promise<void> {
    const entry = await this.ctx.storage.get<StoredEntry>(PENDING_COST_KEY);
    const now = Date.now();
    const pending = PendingCostSchema.safeParse(
      entry && now - entry.storedAt <= PENDING_COST_RETENTION_MS ? entry.value : 0
    );
    await this.putEntry(PENDING_COST_KEY, (pending.success ? pending.data : 0) + usd);
  }

  async putStickyDecision(value: StickyDecision, generation: number): Promise<void> {
    const current = await this.ctx.storage.get<StoredEntry>(STICKY_DECISION_KEY);
    if (generation < (current?.stickyGeneration ?? 0)) return;
    await this.ctx.storage.put(STICKY_DECISION_KEY, {
      value,
      storedAt: Date.now(),
      stickyGeneration: generation,
    } satisfies StoredEntry);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ENTRY_TTL_MS);
    }
  }

  async putEntry(key: string, value: StoredValue): Promise<void> {
    await this.ctx.storage.put(key, { value, storedAt: Date.now() } satisfies StoredEntry);
    // A fixed-period sweep (rather than an idle alarm pushed out on every
    // write) so storage stays bounded even when distinct conversations
    // share this object and keep it permanently busy.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ENTRY_TTL_MS);
    }
  }

  async alarm(): Promise<void> {
    const entries = await this.ctx.storage.list<StoredEntry>();
    const now = Date.now();
    const expiredKeys: string[] = [];
    let liveEntries = 0;
    for (const [key, entry] of entries) {
      if (
        now - entry.storedAt >
        (key === PENDING_COST_KEY ? PENDING_COST_RETENTION_MS : ENTRY_TTL_MS)
      ) {
        expiredKeys.push(key);
      } else {
        liveEntries++;
      }
    }
    for (let start = 0; start < expiredKeys.length; start += DELETE_BATCH_SIZE) {
      await this.ctx.storage.delete(expiredKeys.slice(start, start + DELETE_BATCH_SIZE));
    }
    if (liveEntries > 0) {
      await this.ctx.storage.setAlarm(now + ENTRY_TTL_MS);
    }
  }
}

type DecisionCacheEnv = Pick<Env, 'AUTO_ROUTING_DECISION_CACHE'>;

function cacheStub(env: DecisionCacheEnv, conversationKey: string) {
  const namespace = env.AUTO_ROUTING_DECISION_CACHE;
  return namespace.get(namespace.idFromName(conversationKey));
}

function entryKey(contentHash: string, classifierModel: string): string {
  // The classifier model is part of the key so a model switch never serves
  // results produced by the previous model.
  return `${classifierModel}:${contentHash}`;
}

export function getHotCachedClassification(
  exactHash: string,
  classifierModel: string
): ClassifierOutput | null {
  const key = entryKey(exactHash, classifierModel);
  const entry = classificationHotCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > ENTRY_TTL_MS) {
    classificationHotCache.delete(key);
    return null;
  }
  return entry.value;
}

const StickyDecisionSchema = z.object({
  model: z.string().min(1),
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
  pendingCostUsd: number;
};

export async function readConversationState(
  env: DecisionCacheEnv,
  conversationKey: string,
  exactHash: string,
  classifierModel: string,
  options: { consumePendingCost: boolean }
): Promise<ConversationState> {
  try {
    const key = entryKey(exactHash, classifierModel);
    const state = await cacheStub(env, conversationKey).readConversationState(
      key,
      options.consumePendingCost
    );
    let classification = getHotCachedClassification(exactHash, classifierModel);
    if (!classification) {
      const parsed = ClassifierOutputSchema.safeParse(state.classification?.value);
      if (parsed.success && state.classification) {
        classification = parsed.data;
        cacheClassification(key, classification, state.classification.storedAt);
      }
    }
    const sticky = StickyDecisionSchema.safeParse(state.sticky);
    const pendingCost = PendingCostSchema.safeParse(state.pendingCostUsd);
    return {
      classification,
      sticky: sticky.success ? sticky.data : null,
      pendingCostUsd: pendingCost.success ? pendingCost.data : 0,
    };
  } catch {
    return { classification: null, sticky: null, pendingCostUsd: 0 };
  }
}

export async function addPendingClassifierCost(
  env: DecisionCacheEnv,
  conversationKey: string,
  usd: number
): Promise<void> {
  try {
    await cacheStub(env, conversationKey).addPendingClassifierCost(usd);
  } catch {
    // Cost writes must not fail the decision.
  }
}

export async function putStickyDecision(
  env: DecisionCacheEnv,
  conversationKey: string,
  model: string,
  variant: string | null,
  routeKey: string,
  generation: number
): Promise<void> {
  try {
    await cacheStub(env, conversationKey).putStickyDecision(
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
  classification: ClassifierOutput
): Promise<void> {
  try {
    const key = entryKey(contentHash, classifierModel);
    const storedAt = Date.now();
    await cacheStub(env, conversationKey).putEntry(key, classification);
    cacheClassification(key, classification, storedAt);
  } catch {
    // Cache writes are best effort and must not fail the decision.
  }
}
