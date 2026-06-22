import { browser } from '#imports';
import React, { useEffect, useState } from 'react';
import {
  createGetSidebarStateMessage,
  createToggleSidebarMessage,
  isSidebarStateMessage,
} from '@/src/shared/messages';
import type { GetSidebarStateMessage, ToggleSidebarMessage } from '@/src/shared/messages';
import { isMissingContentScriptConnectionError } from '@/src/shared/runtime-errors';

type PopupRequestMessage = GetSidebarStateMessage | ToggleSidebarMessage;

const unavailableStatus = 'Sidebar is unavailable on this page.';
const sidebarContentScriptPath = '/content-scripts/content.js';

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
  await browser.scripting.executeScript({
    files: [sidebarContentScriptPath],
    target: { tabId },
  });
};

export const App = (): React.JSX.Element => {
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean | undefined>();
  const [status, setStatus] = useState('Ready');

  const sendSidebarMessage = async (message: PopupRequestMessage): Promise<void> => {
    try {
      setStatus('Connecting to this tab...');
      const [activeTab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (typeof activeTab?.id !== 'number') {
        throw new TypeError('No active tab is available.');
      }

      const tabId = activeTab.id;
      const response: unknown = await (async (): Promise<unknown> => {
        try {
          return await browser.tabs.sendMessage(tabId, message);
        } catch (error) {
          if (!isMissingContentScriptConnectionError(error)) {
            throw error;
          }

          try {
            await injectSidebarContentScript(tabId);
          } catch {
            throw new Error(unavailableStatus);
          }

          return browser.tabs.sendMessage(tabId, message);
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
