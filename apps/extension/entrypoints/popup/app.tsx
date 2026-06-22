import { browser } from '#imports';
import React, { useEffect, useState } from 'react';
import {
  createGetSidebarStateMessage,
  createToggleSidebarMessage,
  isSidebarStateMessage,
} from '@/src/shared/messages';
import type { GetSidebarStateMessage, ToggleSidebarMessage } from '@/src/shared/messages';
import { isMissingContentScriptConnectionError } from '@/src/shared/runtime-errors';
import { KiloMark } from '@/src/shared/kilo-mark';
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

  const isConnected = isSidebarOpen !== undefined;

  return (
    <main className="flex w-80 flex-col bg-zinc-950 text-zinc-50">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-[#EDFF00] text-zinc-950">
            <KiloMark className="size-5" />
          </span>
          <div>
            <p className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-zinc-400">
              Kilo
            </p>
            <h1 className="text-base font-semibold text-zinc-50">Sidebar</h1>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-5">
        <div className="rounded-md border border-zinc-800 bg-zinc-900/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-zinc-100">Current tab</p>
            <span
              className={`size-2 rounded-full ${isConnected ? 'bg-[#EDFF00]' : 'bg-zinc-600'}`}
            />
          </div>
          <p aria-live="polite" className="mt-1 text-sm leading-5 text-zinc-400">
            {status}
          </p>
        </div>

        <button
          className="h-10 rounded-md bg-[#EDFF00] px-4 text-sm font-semibold text-zinc-950 transition hover:bg-[#d9ea00] focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          onClick={() => {
            void sendSidebarMessage(createToggleSidebarMessage());
          }}
          type="button"
        >
          {getToggleLabel(isSidebarOpen)}
        </button>
      </div>
    </main>
  );
};
