import { z } from 'zod';
import { WEBHOOK_KEY_RELOAD_MS, WEBHOOK_MAX_SKEW_MS } from '../constants';

/**
 * Infisical signs a webhook as `x-infisical-signature: t=<ms>;<hex HMAC-SHA256 of the body>`, keyed
 * by the webhook's secret string, and the body's `timestamp` equals `t`.
 * https://infisical.com/docs/documentation/platform/webhooks
 */
const SIGNATURE = /^t=(\d{1,16});([0-9a-f]{64})$/;

const PayloadSchema = z.object({
  event: z.string(),
  project: z.object({
    workspaceId: z.string().optional(),
    projectId: z.string().optional(),
    environment: z.string(),
  }),
  timestamp: z.number().int(),
});

export type WebhookOutcome =
  | { status: 'refresh' }
  | { status: 'ignored'; reason: 'other_event' | 'other_scope' }
  | { status: 'rejected'; reason: 'bad_signature' | 'stale' | 'malformed' };

/** Imports the webhook secret the way Infisical uses it: the UTF-8 bytes of the string. */
export async function importWebhookKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Verifies one `secrets.modified` webhook for this environment. The signature check runs before
 * the body is parsed, and a timestamp more than five minutes from now is refused (design 4.2).
 */
export async function verifyWebhook(input: {
  body: string;
  signature: string | null;
  key: CryptoKey;
  now: number;
  projectId: string;
  environmentSlug: string;
}): Promise<WebhookOutcome> {
  const match = SIGNATURE.exec(input.signature ?? '');
  if (match === null) return { status: 'rejected', reason: 'malformed' };
  const signedAt = Number(match[1]);
  const valid = await crypto.subtle.verify(
    'HMAC',
    input.key,
    hexBytes(match[2]),
    new TextEncoder().encode(input.body)
  );
  if (!valid) return { status: 'rejected', reason: 'bad_signature' };
  if (Math.abs(input.now - signedAt) > WEBHOOK_MAX_SKEW_MS) {
    return { status: 'rejected', reason: 'stale' };
  }

  let document: unknown;
  try {
    document = JSON.parse(input.body);
  } catch {
    return { status: 'rejected', reason: 'malformed' };
  }
  const payload = PayloadSchema.safeParse(document);
  if (!payload.success || payload.data.timestamp !== signedAt) {
    return { status: 'rejected', reason: 'malformed' };
  }
  if (payload.data.event !== 'secrets.modified')
    return { status: 'ignored', reason: 'other_event' };
  const projectId = payload.data.project.workspaceId ?? payload.data.project.projectId;
  if (projectId !== input.projectId || payload.data.project.environment !== input.environmentSlug) {
    return { status: 'ignored', reason: 'other_scope' };
  }
  return { status: 'refresh' };
}

type LoadedKey = { key: Promise<CryptoKey>; at: number; failed: boolean };

/**
 * Verifies webhooks in the Worker, so only a verified `secrets.modified` costs a refresher hop.
 * The secret is loaded once per isolate (concurrent first requests share the load). A signature
 * that fails is checked again against a freshly loaded secret, and a failed load is retried, at
 * most once per `WEBHOOK_KEY_RELOAD_MS`.
 */
export class WebhookGate {
  private loaded: LoadedKey | null = null;

  constructor(
    private readonly options: {
      loadSecret: () => Promise<string>;
      projectId: string;
      environmentSlug: string;
      now: () => number;
    }
  ) {}

  /** Throws when the secret cannot be loaded; the caller answers 503. */
  async verify(body: string, signature: string | null): Promise<WebhookOutcome> {
    const now = this.options.now();
    const loaded = this.loaded;
    const key =
      loaded === null || (loaded.failed && this.mayReload(now)) ? this.load(now) : loaded.key;
    const outcome = await this.check(body, signature, await key, now);
    if (outcome.status !== 'rejected' || outcome.reason !== 'bad_signature') return outcome;
    if (!this.mayReload(now)) return outcome;
    const retried = await this.check(body, signature, await this.load(now), now);
    if (retried.status === 'rejected') {
      console.warn('sts: manager webhook signature does not match the current secret', {
        environment: this.options.environmentSlug,
      });
    }
    return retried;
  }

  private mayReload(now: number): boolean {
    return this.loaded === null || now - this.loaded.at >= WEBHOOK_KEY_RELOAD_MS;
  }

  private load(now: number): Promise<CryptoKey> {
    const entry: LoadedKey = {
      key: this.options.loadSecret().then(importWebhookKey),
      at: now,
      failed: false,
    };
    entry.key.catch(() => {
      entry.failed = true;
    });
    this.loaded = entry;
    return entry.key;
  }

  private check(
    body: string,
    signature: string | null,
    key: CryptoKey,
    now: number
  ): Promise<WebhookOutcome> {
    return verifyWebhook({
      body,
      signature,
      key,
      now,
      projectId: this.options.projectId,
      environmentSlug: this.options.environmentSlug,
    });
  }
}
