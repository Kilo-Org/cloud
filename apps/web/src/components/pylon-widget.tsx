'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { useUser } from '@/hooks/useUser';

type PylonCommand = [command: string, ...args: unknown[]];
type PylonQueue = ((command: string, ...args: unknown[]) => void) & {
  q?: PylonCommand[];
};

declare global {
  interface Window {
    Pylon?: PylonQueue;
    pylon?: {
      chat_settings?: Record<string, unknown>;
    } & Record<string, unknown>;
  }
}

const pylonIdentitySchema = z.object({
  email: z.string(),
  name: z.string(),
  emailHash: z.string(),
});

type PylonIdentity = z.infer<typeof pylonIdentitySchema>;
type PylonChatState = {
  unreadCount: number;
  isOpen: boolean;
};
type PylonWidgetProps = {
  children?: React.ReactNode;
};
type PylonWidgetConfig = {
  appId: string;
  identity: PylonIdentity;
};

const INITIAL_PYLON_CHAT_STATE: PylonChatState = { unreadCount: 0, isOpen: false };
const PYLON_WIDGET_SCRIPT_ID = 'kilo-pylon-widget-script';
const PYLON_BUBBLE_HIDDEN_CSS = `
#pylon-chat-bubble,
.PylonChat-bubbleFrameContainer {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
`;

let pylonChatState = INITIAL_PYLON_CHAT_STATE;
const listeners = new Set<() => void>();

async function fetchPylonIdentity(): Promise<PylonIdentity | null> {
  const res = await fetch('/api/pylon/identity');
  if (res.status === 401 || res.status === 403 || res.status === 503) {
    return null;
  }
  if (!res.ok) {
    throw new Error('Failed to fetch Pylon identity');
  }
  return pylonIdentitySchema.parse(await res.json());
}

function usePylonWidgetConfig(): PylonWidgetConfig | null {
  const appId = process.env.NEXT_PUBLIC_PYLON_APP_ID;
  const { data: user } = useUser();

  const { data: identity } = useQuery({
    queryKey: ['pylon-identity', user?.id],
    queryFn: fetchPylonIdentity,
    enabled: Boolean(appId && user?.id),
    staleTime: 5 * 60 * 1000,
  });

  return appId && identity ? { appId, identity } : null;
}

function setPylonChatState(next: Partial<PylonChatState>) {
  const updated = { ...pylonChatState, ...next };
  if (
    updated.unreadCount !== pylonChatState.unreadCount ||
    updated.isOpen !== pylonChatState.isOpen
  ) {
    pylonChatState = updated;
    for (const listener of listeners) {
      listener();
    }
  }
}

function getPylonChatSnapshot() {
  return pylonChatState;
}

function subscribeToPylonChat(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function configurePylonChatSettings(appId: string, identity: PylonIdentity) {
  const currentPylon = window.pylon;
  const currentChatSettings = currentPylon?.chat_settings;

  window.pylon = {
    ...currentPylon,
    chat_settings: {
      ...currentChatSettings,
      app_id: appId,
      email: identity.email,
      name: identity.name,
      email_hash: identity.emailHash,
    },
  };
}

function ensurePylonQueue() {
  if (window.Pylon) {
    return;
  }

  const queuedCommands: PylonCommand[] = [];
  const queue: PylonQueue = (command, ...args) => {
    queuedCommands.push([command, ...args]);
  };
  queue.q = queuedCommands;
  window.Pylon = queue;
}

function ensurePylonScript(appId: string) {
  const widgetSrc = `https://widget.usepylon.com/widget/${encodeURIComponent(appId)}`;
  if (
    document.getElementById(PYLON_WIDGET_SCRIPT_ID) ||
    document.querySelector(`script[src="${widgetSrc}"]`)
  ) {
    return;
  }

  const script = document.createElement('script');
  script.id = PYLON_WIDGET_SCRIPT_ID;
  script.type = 'text/javascript';
  script.async = true;
  script.src = widgetSrc;
  (document.head ?? document.body ?? document.documentElement).appendChild(script);
}

function bootstrapPylon(appId: string, identity: PylonIdentity) {
  configurePylonChatSettings(appId, identity);
  ensurePylonQueue();
  ensurePylonScript(appId);
}

export function PylonWidget({ children }: PylonWidgetProps) {
  const config = usePylonWidgetConfig();
  const [isBootstrapped, setIsBootstrapped] = useState(false);

  useEffect(() => {
    if (!config) {
      setIsBootstrapped(false);
      setPylonChatState(INITIAL_PYLON_CHAT_STATE);
      return;
    }

    bootstrapPylon(config.appId, config.identity);

    const handleShow = () => setPylonChatState({ isOpen: true });
    const handleHide = () => setPylonChatState({ isOpen: false });
    const handleUnreadCountChange = (count: unknown) =>
      setPylonChatState({ unreadCount: typeof count === 'number' ? count : 0 });

    window.Pylon?.('onShow', handleShow);
    window.Pylon?.('onHide', handleHide);
    window.Pylon?.('onChangeUnreadMessagesCount', handleUnreadCountChange);
    setIsBootstrapped(true);

    return () => {
      window.Pylon?.('onShow', null);
      window.Pylon?.('onHide', null);
      window.Pylon?.('onChangeUnreadMessagesCount', null);
      setPylonChatState(INITIAL_PYLON_CHAT_STATE);
      setIsBootstrapped(false);
    };
  }, [config?.appId, config?.identity.email, config?.identity.emailHash, config?.identity.name]);

  if (!config) {
    return null;
  }

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: PYLON_BUBBLE_HIDDEN_CSS }} />
      {isBootstrapped ? children : null}
    </>
  );
}

export function usePylonChat() {
  const state = useSyncExternalStore(
    subscribeToPylonChat,
    getPylonChatSnapshot,
    () => INITIAL_PYLON_CHAT_STATE
  );

  const toggle = useCallback(() => {
    window.Pylon?.(state.isOpen ? 'hide' : 'show');
  }, [state.isOpen]);

  return { toggle, unreadCount: state.unreadCount, isOpen: state.isOpen };
}
