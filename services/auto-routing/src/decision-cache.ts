import {
  ClassifierOutputSchema,
  RouterDecisionSchema,
  type ClassifierOutput,
  type RouterDecision,
} from '@kilocode/auto-routing-contracts';
import { DurableObject } from 'cloudflare:workers';

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

// Classifications and router decisions share one object per conversation;
// entries may have been written by an older worker version, so read sites
// validate values with the matching schema before serving them.
type CacheableValue = ClassifierOutput | RouterDecision;

type StoredEntry = {
  value: CacheableValue;
  storedAt: number;
};

export class AutoRoutingDecisionCacheDO extends DurableObject<Env> {
  async getEntry(key: string): Promise<CacheableValue | null> {
    const entry = await this.ctx.storage.get<StoredEntry>(key);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > ENTRY_TTL_MS) {
      await this.ctx.storage.delete(key);
      return null;
    }
    return entry.value;
  }

  async putEntry(key: string, value: CacheableValue): Promise<void> {
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

function routerEntryKey(contentHash: string, configFingerprint: string): string {
  // The candidate-set/policy fingerprint is part of the key so tier or
  // policy changes never serve a model the new config would not pick.
  return `morph:${configFingerprint}:${contentHash}`;
}

export async function getCachedRouterDecision(
  env: DecisionCacheEnv,
  conversationKey: string,
  contentHash: string,
  configFingerprint: string
): Promise<RouterDecision | null> {
  try {
    const value = await cacheStub(env, conversationKey).getEntry(
      routerEntryKey(contentHash, configFingerprint)
    );
    if (!value) return null;
    const parsed = RouterDecisionSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function putCachedRouterDecision(
  env: DecisionCacheEnv,
  conversationKey: string,
  contentHash: string,
  configFingerprint: string,
  decision: RouterDecision
): Promise<void> {
  try {
    await cacheStub(env, conversationKey).putEntry(
      routerEntryKey(contentHash, configFingerprint),
      decision
    );
  } catch {
    // Cache writes are best effort and must not fail the decision.
  }
}
