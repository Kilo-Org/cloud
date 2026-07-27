/* eslint-disable import/no-nodejs-modules, promise/avoid-new */
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export const getSelectedTargetTabLabel = (sidePanel: Page): Promise<string> =>
  sidePanel.locator('select[aria-label="Target tab"]').evaluate(element => {
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error('Target tab select was not found.');
    }

    return element.selectedOptions[0]?.textContent?.trim() ?? '';
  });

export const getTargetTabOptionLabels = (sidePanel: Page): Promise<string[]> =>
  sidePanel.locator('select[aria-label="Target tab"]').evaluate(element => {
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error('Target tab select was not found.');
    }

    return [...element.options]
      .map(option => option.textContent?.trim() ?? '')
      .filter(label => label !== '' && label !== 'No tab selected');
  });

export const getTargetTabOptionCount = async (sidePanel: Page): Promise<number> => {
  const labels = await getTargetTabOptionLabels(sidePanel);

  return labels.length;
};

export const getSelectedTargetTabId = (sidePanel: Page): Promise<number | undefined> =>
  sidePanel.locator('select[aria-label="Target tab"]').evaluate(element => {
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error('Target tab select was not found.');
    }

    if (element.value === '') {
      return;
    }

    const value = Number(element.value);

    return Number.isInteger(value) ? value : undefined;
  });

export const getExtensionStorage = (page: Page, keys: string[]): Promise<Record<string, unknown>> =>
  page.evaluate(storageKeys => {
    const storage = (
      globalThis as typeof globalThis & {
        chrome?: {
          storage?: {
            local?: {
              get: (keys: string[]) => Promise<Record<string, unknown>>;
            };
          };
        };
      }
    ).chrome?.storage?.local;

    if (storage === undefined) {
      throw new Error('Extension runtime storage is unavailable.');
    }

    return storage.get(storageKeys);
  }, keys);

// eslint-disable-next-line typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type
type StoredConversationShape = {
  readonly id?: string;
  readonly selectedTabId?: number;
};

// eslint-disable-next-line typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type
type StoredConversationsShape = {
  readonly activeConversationId?: string;
  readonly conversations?: StoredConversationShape[];
};

const isStoredConversationsShape = (value: unknown): value is StoredConversationsShape => {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  return 'conversations' in value || 'activeConversationId' in value;
};

export const getActiveConversationSelectedTabId = async (
  page: Page
): Promise<number | undefined> => {
  const storage = await getExtensionStorage(page, ['kiloAgentConversations']);
  const storeValue = storage['kiloAgentConversations'];

  if (!isStoredConversationsShape(storeValue) || storeValue.conversations === undefined) {
    return;
  }

  const activeId = storeValue.activeConversationId;
  const conversation = storeValue.conversations.find(item => item.id === activeId);

  return conversation?.selectedTabId;
};

export const waitForActiveConversationSelectedTabId = async (
  page: Page,
  expectedTabId: number
): Promise<void> => {
  await expect
    .poll(() => getActiveConversationSelectedTabId(page), { timeout: 10_000 })
    .toBe(expectedTabId);
};

/**
 * Probe (A9) established that Playwright locator.click() on "New conversation"
 * does not re-activate the panel tab, so the create-time active-tab sample sees
 * the content tab that was bringToFront()'d. UI click is the production recipe.
 */
export const createNewConversation = async (sidePanel: Page): Promise<void> => {
  await sidePanel.getByLabel('New conversation').click();
};

export const delayConversationStoreHydration = (sidePanel: Page): Promise<void> =>
  sidePanel.addInitScript(() => {
    const pageGlobal = globalThis as typeof globalThis & {
      __resolveKiloConversationStoreHydration?: () => void;
      browser?: {
        storage?: {
          local?: {
            get: (keys: unknown) => Promise<unknown>;
          };
        };
      };
    };
    const storageLocal = pageGlobal.browser?.storage?.local;

    if (storageLocal === undefined) {
      return;
    }

    const originalGet = storageLocal.get.bind(storageLocal);
    let isDelayed = false;

    storageLocal.get = async keys => {
      if (!isDelayed && JSON.stringify(keys).includes('kiloAgentConversations')) {
        isDelayed = true;
        const { promise, resolve } = Promise.withResolvers<void>();

        pageGlobal.__resolveKiloConversationStoreHydration = resolve;
        await promise;
      }

      return originalGet(keys);
    };
  });

export const releaseConversationStoreHydration = (sidePanel: Page): Promise<void> =>
  sidePanel.evaluate(() => {
    (
      globalThis as typeof globalThis & {
        __resolveKiloConversationStoreHydration?: () => void;
      }
    ).__resolveKiloConversationStoreHydration?.();
  });

/** Release hydration hold; re-try until the panel is interactive (init script re-arms each load). */
export const releaseConversationStoreHydrationUntilReady = async (
  sidePanel: Page
): Promise<void> => {
  await expect
    .poll(
      async () => {
        await releaseConversationStoreHydration(sidePanel);

        return sidePanel.getByLabel('New conversation').isEnabled();
      },
      { timeout: 15_000 }
    )
    .toBe(true);
};

export const requireTwoOptionLabels = async (
  sidePanel: Page
): Promise<{ firstListed: string; otherLabel: string; optionLabels: string[] }> => {
  await expect.poll(() => getTargetTabOptionCount(sidePanel), { timeout: 10_000 }).toBe(2);

  const optionLabels = await getTargetTabOptionLabels(sidePanel);
  const [firstListed, ...rest] = optionLabels;
  const otherLabel = rest.find(label => label !== firstListed);

  if (firstListed === undefined || otherLabel === undefined) {
    throw new Error('Expected two distinct inspectable tab options.');
  }

  return { firstListed, optionLabels, otherLabel };
};

export const requireSelectedTargetTabId = async (sidePanel: Page): Promise<number> => {
  const tabId = await getSelectedTargetTabId(sidePanel);

  if (tabId === undefined) {
    throw new Error('Selected target tab id was missing from the select value.');
  }

  return tabId;
};
