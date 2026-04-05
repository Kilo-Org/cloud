import { describe, expect, it } from 'vitest';
import {
  compareWebhookSecret,
  hashWebhookSecret,
  normalizeAuthHeader,
  sanitizeWebhookAuth,
  type StoredWebhookAuth,
} from './webhook-auth';

describe('webhook-auth helpers', () => {
  it('normalizes header names to lowercase without surrounding whitespace', () => {
    expect(normalizeAuthHeader(' X-Webhook-Secret ')).toBe('x-webhook-secret');
    expect(normalizeAuthHeader('x-webhook-secret')).toBe('x-webhook-secret');
  });

  it('produces deterministic secret hashes', async () => {
    const first = await hashWebhookSecret('super-secret');
    const second = await hashWebhookSecret('super-secret');
    const different = await hashWebhookSecret('another-secret');

    expect(first).toHaveLength(64);
    expect(first).toBe(second);
    expect(first).not.toBe(different);
  });

  it('compares secrets in constant time', async () => {
    const hash = await hashWebhookSecret('shared-secret');
    await expect(compareWebhookSecret(hash, 'shared-secret')).resolves.toBe(true);
    await expect(compareWebhookSecret(hash, 'wrong-secret')).resolves.toBe(false);
  });

  it('sanitizes stored auth metadata for responses', () => {
    const stored: StoredWebhookAuth = {
      header: 'x-webhook-secret',
      secretHash: 'abc123',
    };

    expect(sanitizeWebhookAuth(stored)).toEqual({
      webhookAuthHeader: 'x-webhook-secret',
      webhookAuthConfigured: true,
    });
    expect(sanitizeWebhookAuth(null)).toEqual({
      webhookAuthHeader: undefined,
      webhookAuthConfigured: false,
    });
  });
});
