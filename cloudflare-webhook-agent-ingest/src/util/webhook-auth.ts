import { timingSafeEqual } from '@kilocode/encryption';

export type WebhookAuthInput = {
  header: string;
  secret: string;
};

export type StoredWebhookAuth = {
  header: string;
  secretHash: string;
};

const HEX_TABLE = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, '0'));

export function normalizeAuthHeader(header: string): string {
  return header.trim().toLowerCase();
}

export async function hashWebhookSecret(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let index = 0; index < view.length; index += 1) {
    hex += HEX_TABLE[view[index]];
  }
  return hex;
}

export async function compareWebhookSecret(hash: string, secret: string): Promise<boolean> {
  const candidateHash = await hashWebhookSecret(secret);
  return timingSafeEqual(hash, candidateHash);
}

export function sanitizeWebhookAuth(auth: StoredWebhookAuth | null): {
  webhookAuthHeader: string | undefined;
  webhookAuthConfigured: boolean;
} {
  if (!auth) {
    return { webhookAuthHeader: undefined, webhookAuthConfigured: false };
  }
  return {
    webhookAuthHeader: auth.header,
    webhookAuthConfigured: true,
  };
}
