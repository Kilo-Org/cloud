import { ClassifierOutputSchema } from '@kilocode/auto-routing-contracts';
import { DurableObject } from 'cloudflare:workers';
import * as z from 'zod';
import type { ClassifierOutput } from './classifier-output';

// Mirrored agent sessions classify the same prompt prefixes on every API
// call, so identical classifier inputs repeat heavily within a short
// window. Reusing the previous result skips the model call entirely.
//
// The cache lives in a Durable Object named by the conversation (session id
// when the client sent one, content fingerprint otherwise), which gives
// read-after-write consistency for the bursts of identical requests a
// single session produces.
const ENTRY_TTL_MS = 30 * 60 * 1000;
const IDLE_CLEANUP_MS = 2 * 60 * 60 * 1000;

type StoredEntry = {
  value: string;
  storedAt: number;
};

export class AutoRoutingDecisionCacheDO extends DurableObject<Env> {
  async getEntry(key: string): Promise<string | null> {
    const entry = await this.ctx.storage.get<StoredEntry>(key);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > ENTRY_TTL_MS) {
      await this.ctx.storage.delete(key);
      return null;
    }
    return entry.value;
  }

  async putEntry(key: string, value: string): Promise<void> {
    await this.ctx.storage.put(key, { value, storedAt: Date.now() } satisfies StoredEntry);
    // One alarm per conversation, pushed out on every write: the whole
    // object is wiped once the conversation goes idle.
    await this.ctx.storage.setAlarm(Date.now() + IDLE_CLEANUP_MS);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

const CachedClassificationSchema = z.object({
  classification: ClassifierOutputSchema,
  cachedAt: z.string(),
});

export type CachedClassification = z.infer<typeof CachedClassificationSchema>;

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

export async function getCachedClassification(
  env: DecisionCacheEnv,
  conversationKey: string,
  contentHash: string,
  classifierModel: string
): Promise<CachedClassification | null> {
  try {
    const raw = await cacheStub(env, conversationKey).getEntry(
      entryKey(contentHash, classifierModel)
    );
    if (!raw) return null;
    const parsed = CachedClassificationSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function putCachedClassification(
  env: DecisionCacheEnv,
  conversationKey: string,
  contentHash: string,
  classifierModel: string,
  classification: ClassifierOutput
): Promise<void> {
  const value: CachedClassification = {
    classification,
    cachedAt: new Date().toISOString(),
  };
  try {
    await cacheStub(env, conversationKey).putEntry(
      entryKey(contentHash, classifierModel),
      JSON.stringify(value)
    );
  } catch {
    // Cache writes are best effort and must not fail the decision.
  }
}
