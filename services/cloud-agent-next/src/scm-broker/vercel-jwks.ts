import { createPublicKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';

const KEY_TTL_MS = 5 * 60_000;
const REFRESH_COOLDOWN_MS = 60_000;
const MAX_ISSUERS = 32;
const MAX_JWKS_BYTES = 64 * 1024;
const rsaKeySchema = z
  .object({
    kty: z.literal('RSA'),
    kid: z.string().min(1).max(256),
    n: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/),
    e: z
      .string()
      .min(1)
      .max(16)
      .regex(/^[A-Za-z0-9_-]+$/),
    alg: z.literal('RS256').optional(),
    use: z.literal('sig').optional(),
    key_ops: z.array(z.literal('verify')).max(1).optional(),
  })
  .refine(key => key.key_ops === undefined || key.key_ops.length === 1);

export class OidcKeysUnavailable extends Error {
  readonly code = 'oidc_keys_unavailable';
  readonly status = 503;
  constructor(readonly retryAfter = 60) {
    super('oidc_keys_unavailable');
  }
}

export function vercelJwksUrl(issuer: string): string | null {
  try {
    const url = new URL(issuer);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'oidc.vercel.com' ||
      url.host !== 'oidc.vercel.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^https:\/\/oidc\.vercel\.com(?:\/[A-Za-z0-9_-]+)*$/.test(issuer)
    )
      return null;
    return `${issuer}/.well-known/jwks`;
  } catch {
    return null;
  }
}

type IssuerEntry = {
  keys: Map<string, KeyObject>;
  expiresAt: number;
  refreshAfter: number;
  lastRefresh: 'available' | 'unavailable';
  inFlight?: Promise<void>;
};

async function readKeys(response: Response): Promise<Map<string, KeyObject>> {
  if (Number(response.headers.get('content-length')) > MAX_JWKS_BYTES || !response.body) {
    await response.body?.cancel();
    throw new OidcKeysUnavailable();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) throw new OidcKeysUnavailable();
      size += value.byteLength;
      if (size > MAX_JWKS_BYTES) throw new OidcKeysUnavailable();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const document = z
    .object({ keys: z.array(z.unknown()) })
    .parse(JSON.parse(new TextDecoder().decode(bytes)));
  const keys = new Map<string, KeyObject>();
  for (const candidate of document.keys) {
    const parsed = rsaKeySchema.safeParse(candidate);
    if (!parsed.success) continue;
    const jwk = parsed.data;
    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
    if (keys.has(jwk.kid) || keys.size === 8) throw new OidcKeysUnavailable();
    keys.set(jwk.kid, key);
  }
  if (keys.size === 0) throw new OidcKeysUnavailable();
  return keys;
}

export function createVercelJwksCache(
  deps: {
    fetch?: typeof fetch;
    now?: () => number;
  } = {}
) {
  const entries = new Map<string, IssuerEntry>();
  const now = deps.now ?? Date.now;
  const get = deps.fetch ?? fetch;

  async function refresh(url: string, entry: IssuerEntry): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new OidcKeysUnavailable());
      }, 2000);
    });
    const operation = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        let response: Response;
        try {
          response = await get(url, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch {
          if (controller.signal.aborted || attempt === 1) throw new OidcKeysUnavailable();
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status >= 500 && attempt === 0 && !controller.signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 50));
            continue;
          }
          throw new OidcKeysUnavailable();
        }
        const keys = await readKeys(response);
        if (controller.signal.aborted) throw new OidcKeysUnavailable();
        entry.keys = keys;
        entry.expiresAt = now() + KEY_TTL_MS;
        entry.lastRefresh = 'available';
        return;
      }
    };
    try {
      await Promise.race([operation(), deadline]);
    } catch {
      entry.lastRefresh = 'unavailable';
      throw new OidcKeysUnavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async key(issuer: string, kid: string): Promise<KeyObject | null> {
      const url = vercelJwksUrl(issuer);
      if (!url || !kid || kid.length > 256) throw new OidcKeysUnavailable();
      let entry = entries.get(issuer);
      if (!entry) {
        if (entries.size === MAX_ISSUERS) {
          const evictable = [...entries].find(
            ([, value]) => !value.inFlight && value.refreshAfter <= now()
          );
          if (!evictable) throw new OidcKeysUnavailable();
          entries.delete(evictable[0]);
        }
        entry = { keys: new Map(), expiresAt: 0, refreshAfter: 0, lastRefresh: 'unavailable' };
        entries.set(issuer, entry);
      }
      const known = entry.keys.get(kid);
      if (known && now() < entry.expiresAt) return known;
      if (!entry.inFlight && now() >= entry.refreshAfter) {
        entry.refreshAfter = now() + REFRESH_COOLDOWN_MS;
        const current = entry;
        entry.inFlight = refresh(url, entry).finally(() => {
          current.inFlight = undefined;
        });
      }
      if (entry.inFlight) await entry.inFlight;
      const key = entry.keys.get(kid);
      if (!key && entry.lastRefresh === 'available' && now() < entry.expiresAt) return null;
      if (!key || now() >= entry.expiresAt) {
        throw new OidcKeysUnavailable(Math.max(1, Math.ceil((entry.refreshAfter - now()) / 1000)));
      }
      return key;
    },
  };
}

export const vercelJwksCache = createVercelJwksCache();
