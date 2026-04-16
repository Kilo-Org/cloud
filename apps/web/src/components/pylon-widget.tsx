'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import Script from 'next/script';
import { z } from 'zod';
import { useUser } from '@/hooks/useUser';

declare global {
  interface Window {
    Pylon?: (command: string, ...args: unknown[]) => void;
    pylon?: { chat_settings: Record<string, unknown> };
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

const serverSnapshot: PylonChatState = { unreadCount: 0, isOpen: false };
const PYLON_BUBBLE_STYLE_ID = 'kilo-pylon-hide-bubble-style';
const PYLON_BUBBLE_HIDDEN_CSS = `
#pylon-chat-bubble,
.PylonChat-bubbleFrameContainer {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
`;

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

function toInlineScriptValue(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function buildPylonLoaderScript(appId: string, identity: PylonIdentity) {
  const widgetSrc = `https://widget.usepylon.com/widget/${encodeURIComponent(appId)}`;

  return `
window.pylon = {
  chat_settings: {
    app_id: ${toInlineScriptValue(appId)},
    email: ${toInlineScriptValue(identity.email)},
    name: ${toInlineScriptValue(identity.name)},
    email_hash: ${toInlineScriptValue(identity.emailHash)}
  }
};

(function() {
  var styleId = ${toInlineScriptValue(PYLON_BUBBLE_STYLE_ID)};
  if (document.getElementById(styleId)) return;

  var style = document.createElement("style");
  style.id = styleId;
  style.textContent = ${toInlineScriptValue(PYLON_BUBBLE_HIDDEN_CSS)};
  document.head.appendChild(style);
})();

(function() {
  var w = window;
  var d = document;
  var queue = function() { queue.e(arguments); };
  queue.q = [];
  queue.e = function(args) { queue.q.push(args); };
  w.Pylon = queue;

  var load = function() {
    var script = d.createElement("script");
    script.type = "text/javascript";
    script.async = true;
    script.src = ${toInlineScriptValue(widgetSrc)};

    var firstScript = d.getElementsByTagName("script")[0];
    if (firstScript && firstScript.parentNode) firstScript.parentNode.insertBefore(script, firstScript);
    else (d.head || d.body || d.documentElement).appendChild(script);
  };

  if (d.readyState === "complete") load();
  else if (w.addEventListener) w.addEventListener("load", load, false);
})();
  `.trim();
}

// ── Shared state (singleton, lives outside React) ────────────────────────────
let pylonState = serverSnapshot;
const listeners = new Set<() => void>();

function notify() {
  for (const cb of listeners) cb();
}

function setPylonState(next: Partial<PylonChatState>) {
  const updated = { ...pylonState, ...next };
  if (updated.unreadCount !== pylonState.unreadCount || updated.isOpen !== pylonState.isOpen) {
    pylonState = updated;
    notify();
  }
}

function getSnapshot() {
  return pylonState;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// ── PylonWidget: loads the script, hides default bubble ──────────────────────
export function PylonWidget() {
  const appId = process.env.NEXT_PUBLIC_PYLON_APP_ID;
  const { data: user } = useUser();

  // Keyed by user.id so logout/login in the same tab gets a fresh identity.
  const { data: identity } = useQuery({
    queryKey: ['pylon-identity', user?.id],
    queryFn: fetchPylonIdentity,
    enabled: Boolean(appId && user?.id),
    staleTime: 5 * 60 * 1000,
  });

  // Register Pylon callbacks once the widget is ready.
  useEffect(() => {
    if (!identity) return;

    const handleShow = () => setPylonState({ isOpen: true });
    const handleHide = () => setPylonState({ isOpen: false });
    const handleUnreadCountChange = (count: unknown) =>
      setPylonState({ unreadCount: typeof count === 'number' ? count : 0 });

    window.Pylon?.('onShow', handleShow);
    window.Pylon?.('onHide', handleHide);
    window.Pylon?.('onChangeUnreadMessagesCount', handleUnreadCountChange);

    return () => {
      window.Pylon?.('onShow', null);
      window.Pylon?.('onHide', null);
      window.Pylon?.('onChangeUnreadMessagesCount', null);
      setPylonState(serverSnapshot);
    };
  }, [identity]);

  if (!appId || !identity) {
    return null;
  }

  return (
    <Script id="pylon-chat" strategy="afterInteractive">
      {buildPylonLoaderScript(appId, identity)}
    </Script>
  );
}

// ── usePylonChat: hook for custom trigger buttons ────────────────────────────
export function usePylonChat() {
  const state = useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);

  const toggle = useCallback(() => {
    window.Pylon?.(state.isOpen ? 'hide' : 'show');
  }, [state.isOpen]);

  return { toggle, unreadCount: state.unreadCount, isOpen: state.isOpen };
}
