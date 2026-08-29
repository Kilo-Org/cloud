/* eslint-disable import/no-nodejs-modules, jest/no-hooks, require-await, typescript/require-await, unicorn/no-await-expression-member, typescript/no-unsafe-assignment -- Storage fixtures implement browser APIs; matcher objects inspect persisted outcomes. */
import { locks as nativeLocks } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowserExecutionCoordinator } from '../../entrypoints/sidepanel/browser-execution-lock';
import type { BrowserExecutionLease } from '../../entrypoints/sidepanel/browser-execution-lock';
import {
  AUTH_STORAGE_KEY,
  BROWSER_PROVIDER_IDENTITY_KEY,
  clearStoredSession,
  saveStoredAuth,
} from './auth';
import {
  BROWSER_PROVIDER_SETTINGS_KEY,
  browserAccountKey,
  loadBrowserProvider,
  saveBrowserProviderLabel,
  saveBrowserProviderSettings,
} from './browser-provider-settings';
import type { BrowserProfileStorage } from './browser-provider-settings';

const leases: BrowserExecutionLease[] = [];
const auth = { token: 'account-a-token', userEmail: 'a@example.test' };
const profile = async () => {
  const values = new Map<string, unknown>([[AUTH_STORAGE_KEY, auth]]);
  const storageArea: BrowserProfileStorage & Parameters<typeof clearStoredSession>[0] = {
    getItem: key => structuredClone(values.get(key)),
    removeItems: keys => {
      for (const key of keys) {
        values.delete(key);
      }
    },
    setItem: (key, value) => {
      values.set(key, structuredClone(value));
    },
    snapshot: () => Object.fromEntries([...values].map(([key, value]) => [key.slice(6), value])),
  };
  const panel = createBrowserExecutionCoordinator({
    locks: nativeLocks as LockManager,
    storageArea: { ...storageArea, watch: () => () => {} },
  });
  const admitted = await panel.acquireProviderOwner();
  if (!admitted.admitted) {
    throw new Error(admitted.reason);
  }
  leases.push(admitted.lease);
  return { context: { auth, owner: admitted.lease, storageArea }, panel, values };
};

describe('browser provider settings', () => {
  afterEach(async () => {
    await Promise.all(leases.splice(0).map(lease => lease.release()));
  });

  it('creates one stable private identity under the provider owner and defaults to disabled Safe mode', async () => {
    const { context, panel, values } = await profile();
    const [first, second] = await Promise.all([
      loadBrowserProvider(context),
      loadBrowserProvider(context),
    ]);
    expect(second).toStrictEqual(first);
    expect(first.settings).toStrictEqual({
      enabled: false,
      mode: 'safe',
      model: '',
      thinkingEffort: '',
    });
    expect(values.get(BROWSER_PROVIDER_IDENTITY_KEY)).toStrictEqual(first.identity);
    expect((await panel.acquireProviderOwner()).admitted).toBe(false);
    await saveBrowserProviderLabel(context, 'Work browser');
    expect((await loadBrowserProvider(context)).identity).toStrictEqual({
      ...first.identity,
      label: 'Work browser',
    });
  });

  it('requires explicit model selection before enablement and persists independent defaults', async () => {
    const { context, values } = await profile();
    const local = {
      activeConversationId: 'local',
      conversations: [
        {
          events: [
            {
              id: 'local-event',
              role: 'user',
              text: 'Private local conversation',
              type: 'message',
            },
          ],
          id: 'local',
          mode: 'dangerous',
          model: 'local-model',
          title: 'Local conversation',
          updatedAt: '2026-08-29T00:00:00.000Z',
        },
      ],
      openConversationIds: ['local'],
    };
    values.set('local:kiloAgentConversations', local);
    const { settings } = await loadBrowserProvider(context);
    await expect(
      saveBrowserProviderSettings(context, { ...settings, enabled: true })
    ).rejects.toMatchObject({ code: 'model_required', retryable: false });
    expect((await loadBrowserProvider(context)).settings.enabled).toBe(false);
    const selected = {
      enabled: true,
      mode: 'safe' as const,
      model: 'selected-model',
      thinkingEffort: 'high',
    };
    await saveBrowserProviderSettings(context, selected);
    expect((await loadBrowserProvider(context)).settings).toStrictEqual(selected);
    expect(values.get('local:kiloAgentConversations')).toStrictEqual(local);
  });

  it('clears enablement and defaults on account change while retaining identity', async () => {
    const { context } = await profile();
    const first = await loadBrowserProvider(context);
    await saveBrowserProviderSettings(context, {
      ...first.settings,
      enabled: true,
      model: 'chosen',
    });
    const nextAuth = { token: 'account-b-token', userEmail: 'b@example.test' };
    await saveStoredAuth({ ...context.storageArea, removeItem: () => {} }, nextAuth);
    await expect(loadBrowserProvider(context)).rejects.toMatchObject({ code: 'owner_mismatch' });
    const next = await loadBrowserProvider({ ...context, auth: nextAuth });
    expect(next).toStrictEqual({ identity: first.identity, settings: first.settings });
  });

  it('does not restore enablement through stale writes after sign-out', async () => {
    const { context, values } = await profile();
    const first = await loadBrowserProvider(context);
    const { storageArea } = context;
    await clearStoredSession(storageArea);
    await expect(
      saveBrowserProviderSettings(context, { ...first.settings, enabled: true, model: 'chosen' })
    ).rejects.toMatchObject({ code: 'owner_mismatch' });
    expect(values.has(BROWSER_PROVIDER_SETTINGS_KEY)).toBe(false);
    expect(values.get(BROWSER_PROVIDER_IDENTITY_KEY)).toStrictEqual(first.identity);
  });

  it('rejects lost ownership before creating credentials or writing settings', async () => {
    const { context, values } = await profile();
    await context.owner.release();
    await expect(loadBrowserProvider(context)).rejects.toMatchObject({
      code: 'owner_mismatch',
      retryable: false,
    });
    expect(values.has(BROWSER_PROVIDER_IDENTITY_KEY)).toBe(false);
    expect(values.has(BROWSER_PROVIDER_SETTINGS_KEY)).toBe(false);
  });

  it('fails closed on corrupt identity without replacing its private proof', async () => {
    const { context, values } = await profile();
    const corrupt = { providerProof: 'do-not-disclose-this-proof', version: 9 };
    values.set(BROWSER_PROVIDER_IDENTITY_KEY, corrupt);
    await expect(loadBrowserProvider(context)).rejects.toMatchObject({
      code: 'storage_failure',
      message: expect.not.stringContaining(corrupt.providerProof),
    });
    expect(values.get(BROWSER_PROVIDER_IDENTITY_KEY)).toBe(corrupt);
  });

  it('reports storage failure without claiming enablement', async () => {
    const { context, values } = await profile();
    const first = await loadBrowserProvider(context);
    const previous = values.get(BROWSER_PROVIDER_SETTINGS_KEY);
    context.storageArea.setItem = () => {
      throw new Error('private storage detail');
    };
    await expect(
      saveBrowserProviderSettings(context, { ...first.settings, enabled: true, model: 'chosen' })
    ).rejects.toMatchObject({
      code: 'storage_failure',
      message: expect.not.stringContaining('private storage detail'),
      retryable: true,
    });
    expect(values.get(BROWSER_PROVIDER_SETTINGS_KEY)).toStrictEqual(previous);
  });

  it('rejects lost ownership during an awaited read without creating credentials', async () => {
    const { context, values } = await profile();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const { getItem } = context.storageArea;
    context.storageArea.getItem = async key => {
      entered.resolve();
      await gate.promise;
      return getItem(key);
    };
    const loading = loadBrowserProvider(context);
    await entered.promise;
    await context.owner.release();
    gate.resolve();
    await expect(loading).rejects.toMatchObject({ code: 'owner_mismatch' });
    expect(values.has(BROWSER_PROVIDER_IDENTITY_KEY)).toBe(false);
  });

  it('keeps legacy email-free accounts isolated without persisting their tokens', async () => {
    const { context, values } = await profile();
    const legacy = { token: 'legacy-private-token', userEmail: undefined };
    values.set(AUTH_STORAGE_KEY, legacy);
    await loadBrowserProvider({ ...context, auth: legacy });
    const first = values.get(BROWSER_PROVIDER_SETTINGS_KEY);
    values.set(AUTH_STORAGE_KEY, { ...legacy, token: 'different-token' });
    await loadBrowserProvider({ ...context, auth: { ...legacy, token: 'different-token' } });
    expect(values.get(BROWSER_PROVIDER_SETTINGS_KEY)).not.toStrictEqual(first);
    expect(JSON.stringify(first)).not.toContain(legacy.token);
    await expect(browserAccountKey(auth)).resolves.toBe(
      await browserAccountKey({ ...auth, token: 'refreshed-token' })
    );
  });
});
