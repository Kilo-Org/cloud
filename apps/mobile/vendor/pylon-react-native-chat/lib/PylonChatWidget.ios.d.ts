import React from "react";
import type { PylonChatViewRef } from "./PylonChatView";
import type { PylonChatWidgetProps } from "./PylonChatWidget";
/**
 * iOS implementation - simple passthrough.
 *
 * iOS uses native hitTest for touch pass-through, so no proxy logic needed.
 *
 * State Management:
 * - State lives entirely in native layer (no React state needed for iOS)
 * - Imperative methods call native, which handles everything
 * - Events are simply forwarded to user's listener
 */
export declare const PylonChatWidget: React.ForwardRefExoticComponent<PylonChatWidgetProps & React.RefAttributes<PylonChatViewRef>>;
