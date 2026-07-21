import { ClassifierOutputSchema, type ClassifierOutput } from '@kilocode/auto-routing-contracts';
import { DurableObject } from 'cloudflare:workers';
import * as z from 'zod';

// Mirrored agent sessions classify the same prompt prefixes on every API
// call, so identical classifier inputs repeat heavily within a short
// window. Reusing the previous result skips the model call entirely.
//
// The cache lives in a Durable Object named by the conversation (session id
// when the client sent one, content fingerprint otherwise — see
// conversation-identity.ts), which gives read-after-write consistency for
// the bursts of identical requests a single session produces.
const ENTRY_TTL_MS = 30 * 60 * 1000;
// Cloudflare caps storage.delete() at 128 keys per call.
const DELETE_BATCH_SIZE = 128;

// The DO treats stored values as opaque — callers validate on read, since
// entries may have been written by an older worker version. A concrete union
// rather than unknown because the workers RPC stub maps non-serializable
// method types to never.
type StoredValue = ClassifierOutput | StickyDecision;

type StoredEntry = {
  value: StoredValue;
  storedAt: number;
};

export class AutoRoutingDecisionCacheDO extends DurableObject<Env> {
  async getEntry(key: string): Promise<StoredValue | null> {
    const entry = await this.ctx.storage.get<StoredEntry>(key);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > ENTRY_TTL_MS) {
      await this.ctx.storage.delete(key);
      return null;
    }
    return entry.value;
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
      if (now - entry.storedAt > ENTRY_TTL_MS) {
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

// Single per-conversation slot remembering the last model the decision
// engine served, so the session can stay on it (keeping the provider's
// prompt cache warm) instead of ping-ponging when its route oscillates.
// Cannot collide with classification keys, which always contain a ':'.
const STICKY_DECISION_KEY = 'sticky';

const StickyDecisionSchema = z.object({
  model: z.string().min(1),
  // Taxonomy route the model was decided on, for route-change telemetry.
  // Nullable/defaulted so entries written before the field existed parse.
  routeKey: z.string().min(1).nullish().default(null),
});
export type StickyDecision = z.infer<typeof StickyDecisionSchema>;

export async function getCachedClassification(
  env: DecisionCacheEnv,
  conversationKey: string,
  contentHash: string,
  classifierModel: string
): Promise<ClassifierOutput | null> {
  try {
    const value = await cacheStub(env, conversationKey).getEntry(
      entryKey(contentHash, classifierModel)
    );
    if (!value) return null;
    // Entries may have been written by an older worker version; validate
    // before serving.
    const parsed = ClassifierOutputSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function getStickyDecision(
  env: DecisionCacheEnv,
  conversationKey: string
): Promise<StickyDecision | null> {
  try {
    const value = await cacheStub(env, conversationKey).getEntry(STICKY_DECISION_KEY);
    if (!value) return null;
    // Entries may have been written by an older worker version; validate
    // before serving.
    const parsed = StickyDecisionSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function putStickyDecision(
  env: DecisionCacheEnv,
  conversationKey: string,
  model: string,
  routeKey: string
): Promise<void> {
  try {
    await cacheStub(env, conversationKey).putEntry(STICKY_DECISION_KEY, {
      model,
      routeKey,
    } satisfies StickyDecision);
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
    await cacheStub(env, conversationKey).putEntry(
      entryKey(contentHash, classifierModel),
      classification
    );
  } catch {
    // Cache writes are best effort and must not fail the decision.
  }
}
