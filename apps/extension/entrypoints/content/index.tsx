import './style.css';
import { browser, createShadowRootUi, defineContentScript, storage } from '#imports';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import {
  createSidebarStateMessage,
  isGetSidebarStateMessage,
  isToggleSidebarMessage,
} from '@/src/shared/messages';
import { KiloMark } from '@/src/shared/kilo-mark';
import {
  DEFAULT_SIDEBAR_PREFERENCES,
  SIDEBAR_PREFERENCES_STORAGE_KEY,
  normalizeSidebarPreferences,
} from '@/src/shared/storage';

type SidebarSubscriber = (isOpen: boolean) => void;
type RuntimeMessageListener = Parameters<typeof browser.runtime.onMessage.addListener>[0];
type SendResponse = Parameters<RuntimeMessageListener>[2];
interface KiloContentScriptState {
  isStarted?: boolean;
}

const subscribers = new Set<SidebarSubscriber>();
let isSidebarOpen = DEFAULT_SIDEBAR_PREFERENCES.isOpen;
const KILO_CONTENT_SCRIPT_STATE_KEY = '__kiloContentScriptState__';

const getContentScriptState = (): KiloContentScriptState => {
  const scope = globalThis as typeof globalThis & {
    [KILO_CONTENT_SCRIPT_STATE_KEY]?: KiloContentScriptState;
  };

  scope[KILO_CONTENT_SCRIPT_STATE_KEY] ??= {};
  return scope[KILO_CONTENT_SCRIPT_STATE_KEY];
};

const notifySubscribers = (): void => {
  for (const subscriber of subscribers) {
    subscriber(isSidebarOpen);
  }
};

const setSidebarOpen = async (nextIsOpen: boolean): Promise<void> => {
  isSidebarOpen = nextIsOpen;
  notifySubscribers();
  await storage.setItem(SIDEBAR_PREFERENCES_STORAGE_KEY, { isOpen: nextIsOpen });
};

const toggleSidebar = async (): Promise<boolean> => {
  await setSidebarOpen(!isSidebarOpen);
  return isSidebarOpen;
};

const subscribeToSidebarState = (subscriber: SidebarSubscriber): (() => void) => {
  subscribers.add(subscriber);
  subscriber(isSidebarOpen);

  return (): void => {
    subscribers.delete(subscriber);
  };
};

const KiloSidebar = (): React.JSX.Element | null => {
  const [isOpen, setIsOpen] = useState(isSidebarOpen);

  useEffect(() => subscribeToSidebarState(setIsOpen), []);

  if (!isOpen) {
    return null;
  }

  return (
    <aside className="fixed right-0 top-0 z-[2147483647] flex h-dvh w-[min(400px,100vw)] flex-col border-l border-zinc-800 bg-zinc-950 font-sans text-zinc-50 shadow-2xl">
      <div className="flex items-center justify-between gap-4 border-b border-zinc-800 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[#EDFF00] text-zinc-950">
            <KiloMark className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-zinc-50">Kilo</p>
            <p className="truncate text-xs text-zinc-400">Extension sidebar</p>
          </div>
        </div>
        <button
          aria-label="Close Kilo sidebar"
          className="h-8 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
          onClick={() => {
            void setSidebarOpen(false);
          }}
          type="button"
        >
          Close
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="border-b border-zinc-800 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-zinc-100">Current tab</p>
            <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-300">
              Connected
            </span>
          </div>
        </div>

        <div className="flex flex-1 flex-col px-4 py-5">
          <div className="rounded-md border border-dashed border-zinc-800 bg-zinc-900/40 p-4">
            <p className="text-sm font-medium text-zinc-100">No actions yet</p>
            <p className="mt-1 text-sm leading-5 text-zinc-400">
              Tools for this tab will appear here.
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
};

const handleSidebarMessage = (message: unknown, sendResponse: SendResponse): boolean => {
  if (isToggleSidebarMessage(message)) {
    void (async (): Promise<void> => {
      const nextIsOpen = await toggleSidebar();
      sendResponse(createSidebarStateMessage(nextIsOpen));
    })();
    return true;
  }

  if (isGetSidebarStateMessage(message)) {
    sendResponse(createSidebarStateMessage(isSidebarOpen));
  }

  return false;
};

export default defineContentScript({
  cssInjectionMode: 'ui',
  async main(ctx): Promise<void> {
    const contentScriptState = getContentScriptState();

    if (contentScriptState.isStarted === true) {
      return;
    }

    contentScriptState.isStarted = true;

    const storedPreferences = normalizeSidebarPreferences(
      await storage.getItem(SIDEBAR_PREFERENCES_STORAGE_KEY)
    );
    isSidebarOpen = storedPreferences.isOpen;

    browser.runtime.onMessage.addListener((message, _sender, sendResponse) =>
      handleSidebarMessage(message, sendResponse)
    );

    const ui = await createShadowRootUi<Root>(ctx, {
      anchor: 'body',
      isolateEvents: true,
      name: 'kilo-sidebar',
      onMount: container => {
        const root = createRoot(container);
        root.render(
          <React.StrictMode>
            <KiloSidebar />
          </React.StrictMode>
        );
        return root;
      },
      onRemove: root => {
        root?.unmount();
      },
      position: 'overlay',
      zIndex: 2_147_483_647,
    });

    ui.mount();
  },
  matches: ['<all_urls>'],
});
