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
    <aside className="fixed right-0 top-0 z-[2147483647] flex h-dvh w-[min(380px,100vw)] flex-col border-l border-zinc-800 bg-zinc-950 font-sans text-zinc-50 shadow-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-zinc-800 p-4">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#EDFF00]">Kilo</p>
          <h1 className="text-lg font-semibold">Hello world</h1>
        </div>
        <button
          aria-label="Close Kilo sidebar"
          className="rounded-md border border-zinc-700 px-2 py-1 text-sm font-medium text-zinc-200 transition hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-[#EDFF00]"
          onClick={() => {
            void setSidebarOpen(false);
          }}
          type="button"
        >
          Close
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <p className="text-sm leading-6 text-zinc-300">
          This full-height sidebar is rendered by the Kilo extension.
        </p>
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
