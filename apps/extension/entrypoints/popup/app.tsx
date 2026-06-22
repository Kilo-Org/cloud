import { browser } from '#imports';
import React, { useEffect, useState } from 'react';
import {
  createGetSidebarStateMessage,
  createToggleSidebarMessage,
  isSidebarStateMessage,
} from '@/src/shared/messages';
import type { GetSidebarStateMessage, ToggleSidebarMessage } from '@/src/shared/messages';
import { isMissingContentScriptConnectionError } from '@/src/shared/runtime-errors';
import { selectPopupTargetTabId } from '@/src/shared/tabs';

type PopupRequestMessage = GetSidebarStateMessage | ToggleSidebarMessage;
interface ChromeScriptingApi {
  executeScript(injection: {
    files: string[];
    target: {
      tabId: number;
    };
  }): Promise<unknown>;
}

const unavailableStatus = 'Sidebar is unavailable on this page.';
const sidebarContentScriptPath = 'content-scripts/content.js';
const sidebarMessageRetryDelayMs = 50;
const sidebarMessageRetryLimit = 20;

const getSidebarStatus = (isOpen: boolean): string => {
  if (isOpen) {
    return 'Sidebar visible';
  }

  return 'Sidebar hidden';
};

const getToggleLabel = (isOpen: boolean | undefined): string => {
  if (isOpen === true) {
    return 'Hide sidebar';
  }

  return 'Show sidebar';
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return unavailableStatus;
};

const injectSidebarContentScript = async (tabId: number): Promise<void> => {
  const chromeScripting = (
    globalThis as typeof globalThis & { chrome?: { scripting?: ChromeScriptingApi } }
  ).chrome?.scripting;

  if (!chromeScripting) {
    throw new Error('Chrome scripting API is unavailable.');
  }

  await chromeScripting.executeScript({
    files: [sidebarContentScriptPath],
    target: { tabId },
  });
};

const delay = (delayMs: number): Promise<void> =>
  // eslint-disable-next-line promise/avoid-new -- Browser timers are callback based.
  new Promise(resolve => {
    setTimeout(resolve, delayMs);
  });

const sendSidebarMessageToTab = async (
  tabId: number,
  message: PopupRequestMessage,
  retryLimit: number
): Promise<unknown> => {
  let lastMissingConnectionError = new Error('Sidebar content script is unavailable.');

  for (let attempt = 0; attempt < retryLimit; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Each retry depends on the previous missing-receiver result.
      const response: unknown = await browser.tabs.sendMessage(tabId, message);
      return response;
    } catch (error) {
      if (!isMissingContentScriptConnectionError(error)) {
        throw error;
      }

      lastMissingConnectionError = error;
      // eslint-disable-next-line no-await-in-loop -- Backoff is intentional between receiver checks.
      await delay(sidebarMessageRetryDelayMs);
    }
  }

  throw lastMissingConnectionError;
};

const getTargetTabId = async (): Promise<number> => {
  const [activeTab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  const tabs = await browser.tabs.query({ currentWindow: true });
  const extensionOrigin = new URL(browser.runtime.getURL('/')).origin;
  const tabId = selectPopupTargetTabId(activeTab, tabs, extensionOrigin);

  if (typeof tabId !== 'number') {
    throw new TypeError('No active tab is available.');
  }

  return tabId;
};

export const App = (): React.JSX.Element => {
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean | undefined>();
  const [status, setStatus] = useState('Ready');

  const sendSidebarMessage = async (message: PopupRequestMessage): Promise<void> => {
    try {
      setStatus('Connecting to this tab...');
      const tabId = await getTargetTabId();
      const response: unknown = await (async (): Promise<unknown> => {
        try {
          return await sendSidebarMessageToTab(tabId, message, 1);
        } catch (error) {
          if (!isMissingContentScriptConnectionError(error)) {
            throw error;
          }

          try {
            await injectSidebarContentScript(tabId);
          } catch {
            throw new Error(unavailableStatus);
          }

          return sendSidebarMessageToTab(tabId, message, sidebarMessageRetryLimit);
        }
      })();

      if (!isSidebarStateMessage(response)) {
        throw new TypeError('The tab returned an unexpected sidebar response.');
      }

      setIsSidebarOpen(response.isOpen);
      setStatus(getSidebarStatus(response.isOpen));
    } catch (error) {
      setIsSidebarOpen(undefined);
      setStatus(
        isMissingContentScriptConnectionError(error) ? unavailableStatus : getErrorMessage(error)
      );
    }
  };

  useEffect(() => {
    void sendSidebarMessage(createGetSidebarStateMessage());
  }, []);

  return (
    <main className="flex w-80 flex-col gap-5 bg-zinc-950 p-5 text-zinc-50">
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#EDFF00]">Kilo</p>
        <h1 className="text-xl font-semibold">Hello world</h1>
        <p className="text-sm leading-6 text-zinc-300">Toggle the sidebar on the current page.</p>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
        <p className="text-sm font-medium text-zinc-100">Sidebar</p>
        <p className="mt-1 text-sm text-zinc-400">{status}</p>
      </div>

      <button
        className="rounded-md bg-[#EDFF00] px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-[#d9ea00] focus:outline-none focus:ring-2 focus:ring-[#EDFF00]"
        onClick={() => {
          void sendSidebarMessage(createToggleSidebarMessage());
        }}
        type="button"
      >
        {getToggleLabel(isSidebarOpen)}
      </button>
    </main>
  );
};
