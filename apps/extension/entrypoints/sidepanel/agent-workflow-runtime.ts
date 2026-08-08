import { browser } from '#imports';
import {
  WORKFLOW_NAVIGATION_TIMEOUT_MS,
  WORKFLOW_PAGE_EVAL_TIMEOUT_MS,
} from '@/src/shared/agent-workflows';
import { EVAL_TAB_MESSAGE, isTabDebuggerResponse } from '@/src/shared/tab-debugger';
import type { EvalTabResult } from '@/src/shared/tab-debugger';

/**
 * Compare two URLs by origin, pathname, and search, ignoring hash.
 * Returns false for unparseable inputs.
 */
const urlMatches = (left: string, right: string): boolean => {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);

    return (
      leftUrl.origin === rightUrl.origin &&
      leftUrl.pathname === rightUrl.pathname &&
      leftUrl.search === rightUrl.search
    );
  } catch {
    return false;
  }
};

/**
 * Evaluate workflow page code in a tab through the background transport.
 * Always sends WORKFLOW_PAGE_EVAL_TIMEOUT_MS (30 s); the default 5 s
 * timeout is too short for multi-action page scripts.
 */
export const evalInTab = async (tabId: number, code: string): Promise<EvalTabResult> => {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      code,
      tabId,
      timeoutMs: WORKFLOW_PAGE_EVAL_TIMEOUT_MS,
      type: EVAL_TAB_MESSAGE,
    });

    if (!isTabDebuggerResponse(response)) {
      return { error: 'Extension background returned an invalid response.', ok: false };
    }

    if (!response.ok) {
      return { error: response.error, ok: false };
    }

    if (response.type !== EVAL_TAB_MESSAGE) {
      return { error: 'Extension background returned the wrong response.', ok: false };
    }

    return response.result;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Failed to run eval.',
      ok: false,
    };
  }
};

/**
 * Navigate a tab to a URL and wait for the resulting page to finish loading.
 *
 * URL comparison: parse with new URL, compare origin + pathname + search,
 * ignore hash. No other normalization.
 *
 * Same-URL fast path: if the tab is already at the target URL and its
 * status is "complete", resolve immediately.
 *
 * Otherwise register an onUpdated listener (before tabs.update to avoid
 * missing fast complete events), call tabs.update, then do a post-update
 * re-read of the returned tab state. If the tab already completed at the
 * matching URL, resolve immediately.
 *
 * A completed load counts when the tab lands on the requested URL OR on any
 * URL different from the pre-navigation one — servers legitimately redirect
 * (a search endpoint to its results page, a canonicalizer, a login flow).
 * The workflow runner re-checks the landed URL against the workflow scope
 * before any script runs, so a redirect never widens what a script can do.
 *
 * If no such load arrives within WORKFLOW_NAVIGATION_TIMEOUT_MS
 * (30 s), reject with a timeout error.
 *
 * The listener and timer are always removed in a finally block.
 */
export const navigateTab = async (tabId: number, url: string): Promise<void> => {
  // Same-URL fast path.
  const tab = await browser.tabs.get(tabId);
  if (tab.status === 'complete' && tab.url !== undefined && urlMatches(tab.url, url)) {
    return;
  }
  const preNavigationUrl = tab.url;

  type TabListener = (updatedTabId: number, changeInfo: object, tabInfo: object) => void;
  let listener: TabListener | undefined = undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined = undefined;

  const cleanup = (): void => {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    if (listener !== undefined) {
      try {
        browser.tabs.onUpdated.removeListener(listener);
      } catch {
        // Listener removal can fail if the tab context is torn down.
      }
      listener = undefined;
    }
  };

  try {
    // eslint-disable-next-line promise/avoid-new
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const onDone = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        fn();
      };

      // The landed URL satisfies the navigation when it is the requested URL or, once our tabs.update has been applied, any URL other than the page we navigated away from (a server-side redirect). Before the update lands, a completing earlier navigation must not resolve this one.
      let updateApplied = false;
      const isAcceptableLandingUrl = (landedUrl: string): boolean =>
        urlMatches(landedUrl, url) ||
        (updateApplied &&
          preNavigationUrl !== undefined &&
          !urlMatches(landedUrl, preNavigationUrl));

      const checkIsCompleteAndMatching = (
        tabInfo:
          | {
              status?: string | undefined;
              url?: string | undefined;
            }
          | undefined
      ): boolean =>
        tabInfo?.status === 'complete' && tabInfo.url !== undefined && urlMatches(tabInfo.url, url);

      timeoutHandle = setTimeout(() => {
        onDone(() => {
          reject(new Error(`Navigation to ${url} timed out: the page never finished loading.`));
        });
      }, WORKFLOW_NAVIGATION_TIMEOUT_MS);

      listener = (updatedTabId: number, changeInfo: object, _tabInfo: object): void => {
        if (updatedTabId !== tabId) {
          return;
        }

        const info = changeInfo as { status?: string };
        if (info.status !== 'complete') {
          return;
        }

        void (async (): Promise<void> => {
          try {
            const currentTab = await browser.tabs.get(tabId);
            if (currentTab.url !== undefined && isAcceptableLandingUrl(currentTab.url)) {
              onDone(() => {
                resolve();
              });
            }
          } catch (error) {
            onDone(() => {
              reject(error instanceof Error ? error : new Error('Failed to read tab URL.'));
            });
          }
        })();
      };

      // Register the listener BEFORE tabs.update so that a fast page load
      // That completes before the update resolves is not missed.
      browser.tabs.onUpdated.addListener(listener);

      // Initiate navigation. After the update resolves, do a fresh tabs.get
      // Re-read so that a tab already complete at the matching URL resolves
      // Without waiting for a later onUpdated event.
      void browser.tabs.update(tabId, { url }).then(
        async () => {
          updateApplied = true;
          try {
            const freshTab = await browser.tabs.get(tabId);
            if (checkIsCompleteAndMatching(freshTab)) {
              onDone(() => {
                resolve();
              });
            }
          } catch (error) {
            onDone(() => {
              reject(error instanceof Error ? error : new Error('Failed to read tab URL.'));
            });
          }
          return null;
        },
        (error: unknown) => {
          onDone(() => {
            reject(error instanceof Error ? error : new Error('Navigation failed.'));
          });
        }
      );
    });
  } finally {
    cleanup();
  }
};

/**
 * Read the URL of a tab. Throws when the URL is unavailable.
 */
export const getTabUrl = async (tabId: number): Promise<string> => {
  const tab = await browser.tabs.get(tabId);
  if (tab.url === undefined) {
    throw new Error('Tab URL is unavailable.');
  }
  return tab.url;
};
