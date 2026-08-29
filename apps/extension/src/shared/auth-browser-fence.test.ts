/* eslint-disable import/no-nodejs-modules, jest/no-hooks, jest/no-conditional-in-test, jest/no-conditional-expect, require-await, typescript/require-await, unicorn/no-await-expression-member -- The transition matrix checks the distinct outcomes of each real auth path with native leases. */
import { locks as nativeLocks } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_EXECUTION_SAFETY_KEY,
  createBrowserExecutionCoordinator,
} from '../../entrypoints/sidepanel/browser-execution-lock';
import type {
  BrowserAdmission,
  BrowserExecutionLease,
} from '../../entrypoints/sidepanel/browser-execution-lock';
import {
  AUTH_STORAGE_KEY,
  BROWSER_PROVIDER_IDENTITY_KEY,
  clearStoredSession,
  saveStoredAuth,
  validateAuthToken,
} from './auth';
import {
  BROWSER_PROVIDER_SETTINGS_KEY,
  loadBrowserProvider,
  saveBrowserProviderSettings,
} from './browser-provider-settings';

const leases = new Set<BrowserExecutionLease>();
const lease = (admission: BrowserAdmission): BrowserExecutionLease => {
  if (!admission.admitted) {
    throw new Error(admission.reason);
  }
  leases.add(admission.lease);
  return admission.lease;
};
const profile = () => {
  const auth = { token: 'token-a', userEmail: 'a@example.test' };
  const values = new Map<string, unknown>([[AUTH_STORAGE_KEY, auth]]);
  const storageArea = {
    clear: () => {
      throw new Error('A storage clear would erase the safety fence.');
    },
    getItem: (key: `local:${string}`) => structuredClone(values.get(key)),
    removeItem: (key: `local:${string}`) => {
      values.delete(key);
    },
    removeItems: (keys: `local:${string}`[]) => {
      for (const key of keys) {
        values.delete(key);
      }
    },
    setItem: (key: `local:${string}`, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    snapshot: (_base: 'local') =>
      Object.fromEntries([...values].map(([key, value]) => [key.slice(6), value])),
    watch: () => () => {},
  };
  const panel = () =>
    createBrowserExecutionCoordinator({ locks: nativeLocks as LockManager, storageArea });
  return { auth, panel, storageArea, values };
};
const transitions = ['sign-out', 'invalid-401', 'invalid-403', 'account-change', 'reload'] as const;

describe('auth cleanup preserves uncertain browser execution', () => {
  afterEach(async () => {
    await Promise.all([...leases].map(held => held.release()));
    leases.clear();
  });

  it.each(
    transitions.flatMap(transition => [false, true].map(allTabs => ({ allTabs, transition })))
  )(
    'keeps local and delegated work fenced through $transition (allTabs=$allTabs)',
    async ({ allTabs, transition }) => {
      const state = profile();
      const panel = state.panel();
      const owner = lease(await panel.acquireProviderOwner());
      const context = { auth: state.auth, owner, storageArea: state.storageArea };
      const initial = await loadBrowserProvider(context);
      await saveBrowserProviderSettings(context, {
        ...initial.settings,
        enabled: true,
        model: 'selected',
      });
      state.values.set('local:kiloBrowserTasks', { privateHistory: 'account-a-history' });
      state.values.set('local:futureAccountKey', 'private account data');
      const local = lease(await panel.acquireLocal());
      const action = Promise.withResolvers<void>();
      const work = local.run(async guard => {
        guard();
        await action.promise;
      });
      await local.quarantine(7);
      const safety = { ...(allTabs ? { allTabs: true } : {}), tabIds: [7], version: 1 };
      state.values.set(BROWSER_EXECUTION_SAFETY_KEY, safety);
      let { auth } = state;
      try {
        if (transition === 'sign-out') {
          await clearStoredSession(state.storageArea);
        } else if (transition === 'invalid-401' || transition === 'invalid-403') {
          const result = await validateAuthToken({
            apiBaseUrl: 'https://example.test',
            fetch: () => new Response(null, { status: transition === 'invalid-401' ? 401 : 403 }),
            token: auth.token,
          });
          expect(result.status).toBe('invalid');
          if (result.status === 'invalid') {
            await clearStoredSession(state.storageArea);
          }
        } else if (transition === 'account-change') {
          auth = { token: 'token-b', userEmail: 'b@example.test' };
          await saveStoredAuth(state.storageArea, auth);
        }
        expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toBe(safety);
        expect(state.values.get(BROWSER_PROVIDER_IDENTITY_KEY)).toStrictEqual(initial.identity);
        if (transition !== 'reload') {
          expect(state.values.has('local:kiloBrowserTasks')).toBe(false);
          expect(state.values.has('local:futureAccountKey')).toBe(false);
          expect(state.values.has(BROWSER_PROVIDER_SETTINGS_KEY)).toBe(false);
          await saveStoredAuth(state.storageArea, auth);
          expect((await loadBrowserProvider({ ...context, auth })).settings.enabled).toBe(false);
        }
        const reloaded = state.panel();
        expect((await reloaded.acquireLocal()).admitted).toBe(false);
        expect(
          (await panel.acquireDelegated(owner, 'ses_parent', new AbortController().signal)).admitted
        ).toBe(false);
        await expect(reloaded.recover(async () => [])).resolves.toMatchObject({ recovered: false });
      } finally {
        action.resolve();
        await work;
        await local.release();
      }
      const reloaded = state.panel();
      await expect(reloaded.recover(async () => [7])).resolves.toMatchObject({ recovered: false });
      if (allTabs) {
        await expect(reloaded.recover(async () => [42])).resolves.toMatchObject({
          recovered: false,
        });
      }
      await expect(reloaded.recover(async () => [])).resolves.toMatchObject({ recovered: true });
      const resumedLocal = lease(await reloaded.acquireLocal());
      await expect(resumedLocal.run(async () => 'explicit local work')).resolves.toBe(
        'explicit local work'
      );
      await resumedLocal.release();
      const resumedDelegated = lease(
        await panel.acquireDelegated(owner, 'ses_new_invocation', new AbortController().signal)
      );
      await expect(resumedDelegated.run(async () => 'explicit delegated work')).resolves.toBe(
        'explicit delegated work'
      );
      expect(state.values.get(BROWSER_PROVIDER_IDENTITY_KEY)).toStrictEqual(initial.identity);
    }
  );

  it('preserves a newer complete safety record when quarantine changes during key enumeration', async () => {
    const state = profile();
    const newer = { allTabs: true, futureSafetyField: { keep: true }, tabIds: [7, 8], version: 1 };
    state.values.set(BROWSER_EXECUTION_SAFETY_KEY, { tabIds: [7], version: 1 });
    const { snapshot } = state.storageArea;
    state.storageArea.snapshot = base => {
      const captured = snapshot(base);
      state.values.set(BROWSER_EXECUTION_SAFETY_KEY, newer);
      return captured;
    };
    await clearStoredSession(state.storageArea);
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toBe(newer);
    expect(state.values.has(AUTH_STORAGE_KEY)).toBe(false);
  });

  it('fails account switching without cleanup support instead of adopting account data', async () => {
    const state = profile();
    await expect(
      saveStoredAuth(
        {
          getItem: state.storageArea.getItem,
          removeItem: state.storageArea.removeItem,
          setItem: state.storageArea.setItem,
        },
        { token: 'token-b', userEmail: 'b@example.test' }
      )
    ).rejects.toThrow('Account cleanup is unavailable');
    expect(state.values.get(AUTH_STORAGE_KEY)).toStrictEqual(state.auth);
  });
});
