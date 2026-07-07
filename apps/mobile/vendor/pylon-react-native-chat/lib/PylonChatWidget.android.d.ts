import React from "react";
import type { PylonChatViewRef } from "./PylonChatView";
import type { PylonChatWidgetProps } from "./PylonChatWidget";
/**
 * Android implementation using proxy-based touch pass-through.
 *
 * State Management:
 * - isChatOpen is ONLY set by native events (onChatOpened/onChatClosed)
 * - Imperative methods (openChat/closeChat) call native, which then fires events
 * - This ensures state is always synced with native layer
 *
 * Touch Pass-Through Strategy:
 * 1. Native reports interactive element positions via onInteractiveBoundsChanged
 * 2. React renders clickable Pressable views at those positions
 * 3. When chat is closed: WebView has pointerEvents="none" (passes touches through)
 * 4. Touches hit background OR proxy
 * 5. Proxy clicked → calls openChat() → fires onChatOpened → state updates → WebView enabled
 */
export declare const PylonChatWidget: React.ForwardRefExoticComponent<PylonChatWidgetProps & React.RefAttributes<PylonChatViewRef>>;
