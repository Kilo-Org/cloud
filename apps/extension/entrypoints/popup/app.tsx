import { browser } from '#imports';
import React, { useEffect, useState } from 'react';
import {
  createGetSidebarStateMessage,
  createToggleSidebarMessage,
  isSidebarStateMessage,
} from '@/src/shared/messages';
import type { GetSidebarStateMessage, ToggleSidebarMessage } from '@/src/shared/messages';

type PopupRequestMessage = GetSidebarStateMessage | ToggleSidebarMessage;

const unavailableStatus = 'Sidebar is unavailable on this page.';

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

      const response: unknown = await browser.tabs.sendMessage(activeTab.id, message);

      if (!isSidebarStateMessage(response)) {
        throw new TypeError('The tab returned an unexpected sidebar response.');
      }

      setIsSidebarOpen(response.isOpen);
      setStatus(getSidebarStatus(response.isOpen));
    } catch (error) {
      setIsSidebarOpen(undefined);
      setStatus(error instanceof Error ? error.message : unavailableStatus);
    }
  };

  useEffect(() => {
    void sendSidebarMessage(createGetSidebarStateMessage());
  }, []);

  return (
    <main className="flex w-80 flex-col gap-5 bg-zinc-950 p-5 text-zinc-50">
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-300">Kilo</p>
        <h1 className="text-xl font-semibold">Hello world</h1>
        <p className="text-sm leading-6 text-zinc-300">
          Toggle the floating sidebar on the current page.
        </p>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
        <p className="text-sm font-medium text-zinc-100">Sidebar</p>
        <p className="mt-1 text-sm text-zinc-400">{status}</p>
      </div>

      <button
        className="rounded-md bg-emerald-400 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-200"
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
